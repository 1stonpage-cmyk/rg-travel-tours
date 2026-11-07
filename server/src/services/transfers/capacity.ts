/**
 * Transfer capacity — "may one more transfer be sold on this date?", and the
 * five pool primitives the TOUR gate next door now shares with it
 * (transfers-launch plan, Architecture §2 and §2a; Task T7).
 *
 * ## Two resources, two different shapes of question
 *
 * **Vehicles are typed and windowed.** A transfer blocks its vehicle TYPE
 * (an admin-managed `vehicle_types` row, identified by id — owner decision
 * 2026-11-08, superseding the old hard-coded `van`/`suv` enum; see
 * `docs/superpowers/plans/2026-11-08-flexible-routes.md`) for
 * `[pickup, estimated end + buffer)`, not for the whole day, so one vehicle
 * serves several jobs. Nothing pins a specific `van_id` at hold time (dispatch
 * still does that later), so the only answerable question is a pool question,
 * and the interval-scheduling result answers it exactly: the minimum number of
 * same-type vehicles needed to serve a set of windows IS the maximum number
 * simultaneously active — the peak. See `peakOverlap` in `./overlap.ts`. The
 * SET of vehicle types is no longer fixed at two, so every count/window keyed
 * by type below is a `Map<number, …>` keyed by `vehicle_type_id`, not a fixed
 * `{van, suv}` record — see `assessTransferCapacity`'s own note on the key-set
 * derivation this generalization hinges on.
 *
 * **Drivers are one undifferentiated pool with per-driver daily caps, and at
 * hold time the check is a job COUNT, not a time-of-day check** (the owner's
 * own wording: "driver capacity left that day"). Time-of-day matters only once
 * a specific driver is assigned, which is Task T8. A driver on a TOUR that day
 * has none of their transfer budget left — a tour consumes a driver for the
 * whole day, exactly as it consumes a vehicle.
 *
 * ## THE PRECONDITION, inherited verbatim from `services/capacity.ts`
 *
 * **The caller must already hold `fleet_date_slots(date) FOR UPDATE`** —
 * `takeFleetDateLock(tx, date)` — and must have taken it as the transaction's
 * FIRST statements, before any plain `SELECT`. Nothing in this module takes or
 * re-takes it. Two distinct requirements hide in that sentence:
 *
 *  1. Without the lock, every count below is a read a concurrent transaction
 *     can invalidate before the booking is written, and two guests take the
 *     same last van.
 *  2. Without the lock being FIRST, InnoDB has already pinned this
 *     transaction's REPEATABLE READ snapshot at its first non-locking read, and
 *     every count below is answered from a moment before the race's winner
 *     committed — **the lock is granted and changes nothing.**
 *
 * There is deliberately no second lock table. Conditions (1)–(5) read across
 * both vehicle types and both product types for one date, so a per-type lock
 * would let a van hold and an suv hold each decide against the other's
 * soon-to-be-stale numbers. `fleet_date_slots(date)` is the single
 * serialization point, and the lock ORDER
 * (`fleet_date_slots` → `tour_date_slots` → the booking row) is unchanged: a
 * transfer simply has no `tour_date_slots` row to take.
 *
 * ## Everything reads through `tx` — with ONE documented exception
 *
 * Every query here takes the caller's `Transaction` handle, never `getDb()` — a
 * read on a pooled connection is a read outside the locks, and a second
 * connection checked out while this one holds a row lock is the pool-starvation
 * hazard `create-hold.ts` documents. **`sellableVehiclesByType` is the one
 * function allowed to default to the pool instead** (owner decision
 * 2026-11-08, design note §4) — see its own doc comment for why: it is
 * read-only, it is the public route list's unlocked fleet-sellability check,
 * and it never participates in a capacity DECISION that needs the lock.
 * Every locked caller (`assessTransferCapacity`, `services/capacity.ts`'s
 * Gate 2b) still passes its own `tx` explicitly.
 *
 * ## An EXISTING malformed row is not the same situation as a NEW candidate
 *
 * `computeTransferWindow` throws on a malformed argument, which is right for a
 * candidate being quoted right now (a programmer error, loud, unreachable from
 * any guest input). It is the wrong behaviour for a row already in the
 * database: a single bad row would then 500 every quote for that date. So
 * `windowForBookedTransfer` below NEVER throws and fails CLOSED instead —
 * an unreadable existing booking is treated as occupying the WHOLE DAY, which
 * over-claims the fleet rather than under-claiming it, and warns with the
 * booking id (never guest data).
 *
 * **One narrow exception to "never under-claim": a row with a NULL
 * `vehicle_type_id`.** That column is `NOT NULL` for a non-tour booking by the
 * `bookings_product_type_shape` CHECK, so this is unreachable for anything the
 * one real writer (`createTransferBooking()`) produces — but if it ever did
 * happen, `transferWindowsByType` drops the row rather than over-claiming by
 * charging it to every type (there is no longer a fixed pair to charge it to
 * both of). See that function's own doc comment for why dropping, not
 * guessing a type, is the chosen failure mode for this one unreachable case.
 */
import { and, eq, ne, notExists, sql } from 'drizzle-orm';
import type { ProductType } from '@rg/shared';
import { readTransferOperationsSettingsTx } from '../../content/settings';
import { getDb, type Database, type Transaction } from '../../db/client';
import {
  bookingTransferDetails,
  bookings,
  driverLeaves,
  drivers,
  vans,
  VAN_STATUS_SELLABLE,
} from '../../db/schema';
import { assertCivilDate, holdsCapacity, on, onlyCount, TOTAL } from '../capacity-sql';
import {
  clockTimeToMinutes,
  computeTransferWindow,
  MINUTES_PER_DAY,
  peakOverlap,
  type TimeWindow,
} from './overlap';

/**
 * Why a transfer was refused. Each is a different sentence to a guest — "we
 * have no van free around that time" is not "that pickup is too late in the
 * day" — so they stay separate values, the same way
 * `CAPACITY_REFUSAL_REASONS` does for tours.
 */
export const TRANSFER_CAPACITY_REFUSAL_REASONS = [
  /** No vehicle of the requested type is free for this window (conditions 1–3). */
  'no_vehicle_available',
  /** No driver has transfer capacity left that day (conditions 4–5). */
  'no_driver_available',
  /**
   * The window would run past midnight. A guest-safe refusal — "choose an
   * earlier pickup time" — not an error: the capacity date key is one civil
   * date and a two-date window is not modelled at launch (plan §2).
   */
  'pickup_crosses_midnight',
] as const;
export type TransferCapacityRefusalReason = (typeof TRANSFER_CAPACITY_REFUSAL_REASONS)[number];

/** The verdict. Never a thrown REFUSAL — same contract as `assessCapacity`. */
export type TransferCapacityVerdict =
  { ok: true } | { ok: false; reason: TransferCapacityRefusalReason };

/** The product types this module's windows are computed for. */
export type TransferProductType = Exclude<ProductType, 'tour'>;

/**
 * Sellable vehicles by type — the raw type counts of Architecture §2, keyed
 * by `vehicle_type_id`. A type with zero sellable vehicles may be ABSENT from
 * this map (it is filled in with an explicit `0` by
 * {@link assessTransferCapacity}'s key-set derivation before it is read
 * there) — callers that need every type represented must not assume a
 * missing key means anything other than "ask `sellableVehiclesByType` again
 * with the key you care about", and should prefer `.get(id) ?? 0`.
 */
export type SellableVehicleCounts = Map<number, number>;

/**
 * Booked transfer windows for one date, grouped by the `vehicle_type_id` they
 * claim. A type with no booked windows is simply absent from this map.
 */
export type TransferWindowsByType = Map<number, TimeWindow[]>;

/** The whole civil day. What an unreadable existing booking is assumed to hold. */
const WHOLE_DAY: TimeWindow = { startMinutes: 0, endMinutes: MINUTES_PER_DAY };

/**
 * Sellable vehicles of each type: active, `status = VAN_STATUS_SELLABLE`.
 *
 * `VAN_STATUS_SELLABLE` is an ALLOW-list of one (owner decision 2026-10-14,
 * Q1), so a status added later is unsellable until somebody decides otherwise,
 * and a van left `on_trip` is refused on every future date at once — that
 * consequence is documented beside the constant and is unchanged here.
 *
 * **Deliberately NOT filtered by seat capacity.** Architecture §2's raw
 * per-type counts exist because a transfer's vehicle is the guest's own
 * choice of type rather than something sized against a party, and the type
 * is what the window claims. The tour gate's pax-filtered count is a
 * different question and still asked separately — see `assessCapacity`'s
 * Gate 2.
 *
 * **`db` takes either handle, defaulting to the pool — and this is the ONE
 * function in this module allowed that widening** (owner decision
 * 2026-11-08, design note §4, mirroring `vehiclePriceForRouteAndType`'s own
 * pattern in `./pricing.ts`). Every other function here takes `Transaction`
 * only, because every other caller is inside a capacity DECISION that needs
 * the `fleet_date_slots` lock. This function is different on both counts: it
 * is read-only (a `COUNT … GROUP BY`, nothing written), and its one caller
 * with no open transaction — the PUBLIC route list (`transferRoutes.list`,
 * deciding which vehicle types to show a guest as "offered") — never holds a
 * lock and never decides a hold. `assessTransferCapacity` and
 * `services/capacity.ts`'s Gate 2b both still pass their own `tx` explicitly,
 * exactly as before; the default is for the unlocked public reader alone.
 */
export async function sellableVehiclesByType(
  db: Database | Transaction = getDb(),
): Promise<SellableVehicleCounts> {
  const rows = await db
    .select({ vehicleTypeId: vans.vehicleTypeId, n: sql<number>`COUNT(*)` })
    .from(vans)
    .where(and(eq(vans.isActive, true), eq(vans.status, VAN_STATUS_SELLABLE)))
    .groupBy(vans.vehicleTypeId);

  const counts: SellableVehicleCounts = new Map();
  for (const row of rows) {
    counts.set(row.vehicleTypeId, Number(row.n));
  }
  return counts;
}

/**
 * What one booked transfer row needs for its window to be recomputed.
 *
 * Exported for Task T8's DISPATCH-time counterpart
 * (`services/dispatch/availability.ts`), which asks the same question of the
 * same columns for a SPECIFIC van/driver rather than for the type pool. The
 * shape is the contract between the two; widening visibility, not behaviour.
 */
export interface BookedTransferRow {
  bookingId: number;
  productType: ProductType;
  vehicleTypeId: number | null;
  pickupTime: string | null;
  dayUseEndTime: string | null;
  bufferMinutesUsed: number | null;
  /**
   * `booking_transfer_details.route_duration_minutes_used` — frozen AT HOLD
   * TIME, never a live read of `transfer_routes.estimated_duration_minutes`.
   * See that column's own doc comment in `db/schema.ts` for why: a live read
   * let an admin SHORTEN a route's duration after a booking was taken and
   * silently shrink that booking's already-reserved window, freeing its
   * vehicle sooner than it will really be free — an oversell, not a bug the
   * lengthening direction ever had.
   */
  routeDurationMinutes: number | null;
}

/**
 * One booked transfer's window — fail-closed, never throwing. See the module
 * note's last section for why this differs from the candidate path.
 *
 * Three things can make a stored row uncomputable, and all three resolve to the
 * WHOLE DAY plus a warning: a missing `booking_transfer_details` row (nothing
 * enforces that a transfer has one — T5's own open concern), an unparsable or
 * missing clock label, and a missing duration (a custom staff-quoted route,
 * which cannot exist until T19). Over-claiming the fleet refuses a booking;
 * under-claiming it sends two parties to one van.
 *
 * A window that now runs past midnight is CLAMPED to the end of the day rather
 * than treated as broken, and that is exact rather than merely conservative:
 * within this civil date, `[start, 1440)` is precisely the part of the window
 * that falls on it. **This branch should be unreachable for a row written by
 * the one real writer** (`createTransferBooking()`, Task T10): both the
 * buffer and the duration are frozen at hold time from the exact values the
 * hold-time check itself used, so a booking that was accepted can never later
 * recompute into a window that crosses midnight. It stays as a defensive
 * fail-closed clamp for a row this invariant did not hold for — not a path
 * any admin action can trigger once T10 ships.
 */
export function windowForBookedTransfer(row: BookedTransferRow): TimeWindow {
  const unreadable = (why: string): TimeWindow => {
    console.warn(
      `[transfer-capacity] booking ${row.bookingId}: ${why}; ` +
        'counting it as occupying the whole day',
    );
    return WHOLE_DAY;
  };

  if (row.pickupTime === null || row.bufferMinutesUsed === null) {
    return unreadable('no booking_transfer_details row');
  }
  const pickupTimeMinutes = clockTimeToMinutes(row.pickupTime);
  if (pickupTimeMinutes === null) return unreadable('unreadable pickup_time');

  if (row.productType === 'tour') {
    // Unreachable: the caller filters `product_type <> 'tour'`. Fail closed
    // rather than compute a transfer window for a tour.
    return unreadable('is a tour, not a transfer');
  }

  let dayUseEndTimeMinutes: number | null = null;
  if (row.productType === 'transfer_day_use') {
    if (row.dayUseEndTime === null) return unreadable('day-use booking with no day_use_end_time');
    dayUseEndTimeMinutes = clockTimeToMinutes(row.dayUseEndTime);
    if (dayUseEndTimeMinutes === null) return unreadable('unreadable day_use_end_time');
  }

  let result;
  try {
    result = computeTransferWindow({
      productType: row.productType,
      pickupTimeMinutes,
      dayUseEndTimeMinutes,
      routeDurationMinutes: row.routeDurationMinutes,
      bufferMinutes: row.bufferMinutesUsed,
    });
  } catch {
    // A custom route with no duration, a day-use ending before it starts, a
    // negative buffer — every malformed-argument throw lands here.
    return unreadable('its window cannot be computed from what is stored');
  }

  if (!result.ok) {
    // crosses_midnight: exact for THIS date once clamped. See the doc comment.
    return { startMinutes: pickupTimeMinutes, endMinutes: MINUTES_PER_DAY };
  }
  return result.window;
}

/**
 * Every capacity-holding transfer booking's window on `date`, grouped by the
 * vehicle type it claims.
 *
 * **The join is a LEFT join, deliberately** (the discipline T6 established):
 * an inner join on `booking_transfer_details` would silently DROP a transfer
 * whose details row is missing. Dropping a row here UNDER-counts the peak,
 * which oversells the fleet — the one direction §5 forbids. A row that
 * cannot be read is counted as the whole day instead, by
 * `windowForBookedTransfer`.
 *
 * **No join to `transfer_routes` at all** — `routeDurationMinutes` below reads
 * `booking_transfer_details.route_duration_minutes_used`, the value FROZEN at
 * hold time, never the catalog row's current (possibly since-edited) value.
 * See that column's doc comment in `db/schema.ts`.
 *
 * `vehicle_type_id` is `NOT NULL` for a non-tour booking by the
 * `bookings_product_type_shape` CHECK, so the null branch below is
 * unreachable — but there is no longer a fixed pair of types to count such a
 * row against both of, so it is warned about and DROPPED from every type's
 * peak instead. That under-counts the one row rather than inventing a type to
 * over-count it against, and it is unreachable in practice for the same
 * reason the CHECK makes it unreachable for the old two-type code.
 */
export async function transferWindowsByType(
  tx: Transaction,
  date: string,
): Promise<TransferWindowsByType> {
  assertCivilDate(date);

  const rows = await tx
    .select({
      bookingId: bookings.id,
      productType: bookings.productType,
      vehicleTypeId: bookings.vehicleTypeId,
      pickupTime: bookingTransferDetails.pickupTime,
      dayUseEndTime: bookingTransferDetails.dayUseEndTime,
      bufferMinutesUsed: bookingTransferDetails.bufferMinutesUsed,
      routeDurationMinutes: bookingTransferDetails.routeDurationMinutesUsed,
    })
    .from(bookings)
    .leftJoin(bookingTransferDetails, eq(bookingTransferDetails.bookingId, bookings.id))
    .where(and(on(bookings.tourDate, date), ne(bookings.productType, 'tour'), holdsCapacity));

  const byType: TransferWindowsByType = new Map();
  for (const row of rows) {
    const window = windowForBookedTransfer(row);
    if (row.vehicleTypeId === null) {
      console.warn(
        `[transfer-capacity] booking ${row.bookingId}: no vehicle_type_id; ` +
          'cannot attribute its window to any vehicle type, dropping it from every peak',
      );
      continue;
    }
    const existing = byType.get(row.vehicleTypeId);
    if (existing) {
      existing.push(window);
    } else {
      byType.set(row.vehicleTypeId, [window]);
    }
  }
  return byType;
}

/**
 * `toursToday(D)` — capacity-holding TOUR bookings on `date`, across every
 * tour.
 *
 * This is what replaced `assessCapacity`'s old `heldAcrossTheFleet`, which
 * counted every booking on the date with no `product_type` filter. That was
 * correct while every booking was a tour and became a silent blend the moment a
 * transfer could exist — and both the van gate and the driver gate subtracted
 * it as though one held booking were one van plus one driver, which a windowed
 * transfer is not.
 */
export async function countToursOn(tx: Transaction, date: string): Promise<number> {
  assertCivilDate(date);
  return onlyCount(
    await tx
      .select(TOTAL)
      .from(bookings)
      .where(and(on(bookings.tourDate, date), eq(bookings.productType, 'tour'), holdsCapacity)),
  );
}

/**
 * `transfersToday(D)` — capacity-holding TRANSFER bookings on `date`, as a job
 * COUNT. The driver side of Architecture §2a asks how many jobs exist, not when
 * they are; the vehicle side asks when (see `transferWindowsByType`).
 */
export async function countTransfersOn(tx: Transaction, date: string): Promise<number> {
  assertCivilDate(date);
  return onlyCount(
    await tx
      .select(TOTAL)
      .from(bookings)
      .where(and(on(bookings.tourDate, date), ne(bookings.productType, 'tour'), holdsCapacity)),
  );
}

/**
 * Every on-duty driver's effective transfer-job cap on `date`, **sorted
 * ascending** — the `c_1 <= c_2 <= … <= c_N` array Architecture §2a's formulas
 * operate on. Its LENGTH is `N`, condition (4)'s whole right-hand side.
 *
 * "On duty" is the gate `assessCapacity`'s Gate 3 used before this task, moved
 * here unchanged and now shared by both gates rather than written twice:
 * `is_active`, and `NOT EXISTS` a `driver_leaves` row covering the day.
 * `driver_leaves` is INCLUSIVE at both ends, so a one-day leave is
 * `start_date = end_date` and `<=`/`>=` are both correct. `NOT EXISTS` rather
 * than counting leaves and subtracting: two overlapping leaves for one driver
 * would otherwise remove that driver twice and hide a free van behind a phantom
 * shortage.
 *
 * `?? defaultCap`, never `||`: `drivers.max_transfer_jobs_per_day` of **0**
 * means "this driver takes no transfer jobs" (a driver kept for tours), and
 * `0 || 2` would hand them two. A negative override is clamped to 0 and warned
 * about — it cannot be entered through the admin input, and treating it as a
 * negative would let one driver reduce the fleet-wide pool.
 */
export async function driverTransferCapsOn(
  tx: Transaction,
  date: string,
  defaultCap: number,
): Promise<number[]> {
  assertCivilDate(date);

  const rows = await tx
    .select({ id: drivers.id, cap: drivers.maxTransferJobsPerDay })
    .from(drivers)
    .where(
      and(
        eq(drivers.isActive, true),
        notExists(
          tx
            .select({ one: sql`1` })
            .from(driverLeaves)
            .where(
              and(
                eq(driverLeaves.driverId, drivers.id),
                sql`${driverLeaves.startDate} <= ${date}`,
                sql`${driverLeaves.endDate} >= ${date}`,
              ),
            ),
        ),
      ),
    );

  return rows
    .map((row) => {
      const cap = row.cap ?? defaultCap;
      if (cap < 0) {
        console.warn(
          `[transfer-capacity] driver ${row.id}: negative transfer-job cap (${cap}); treating it as 0`,
        );
        return 0;
      }
      return cap;
    })
    .sort((a, b) => a - b);
}

/**
 * Condition (5)'s right-hand side: the transfer-job capacity left over once
 * `toursConsuming` whole-day tours have each taken a driver.
 *
 * **Tours take the SMALLEST-capacity drivers**, which is optimal rather than
 * merely safe, by the exchange argument in Architecture §2a: moving a tour from
 * a larger-cap driver to a smaller-cap one never reduces what is left for
 * transfers, so if any feasible assignment exists, the smallest-first one does
 * too. `caps` therefore has to arrive sorted ascending — `driverTransferCapsOn`
 * returns it that way, and this function asserts it rather than re-sorting,
 * because silently re-sorting a mis-ordered argument would hide the caller's
 * bug while still producing a right-looking number.
 *
 * More tours than drivers (possible from existing state — a driver deactivated
 * after their tour was booked) leaves ZERO, not a negative: every driver is
 * already spoken for, so no transfer fits, and the caller refuses.
 */
export function leftoverTransferCapacity(caps: readonly number[], toursConsuming: number): number {
  if (!Number.isInteger(toursConsuming) || toursConsuming < 0) {
    throw new RangeError(`Expected a whole, non-negative tour count, got ${toursConsuming}`);
  }
  for (let i = 1; i < caps.length; i += 1) {
    if (caps[i]! < caps[i - 1]!) {
      throw new RangeError('leftoverTransferCapacity needs caps sorted ascending');
    }
  }
  if (toursConsuming >= caps.length) return 0;
  return caps.slice(toursConsuming).reduce((total, cap) => total + cap, 0);
}

/**
 * The CURRENT peak claimed by booked transfers of each type on `date`, keyed
 * by `vehicle_type_id` — what conditions (1)–(3) subtract. A candidate TOUR
 * changes neither, which is why the tour gate reads this and the transfer
 * gate instead recomputes its own type's peak with the candidate's window
 * added. A type with no booked windows is absent from the returned map —
 * callers that need every sellable type represented use
 * {@link sumLeftoverVehicles}, which handles the union itself.
 */
export async function transferPeaksByType(
  tx: Transaction,
  date: string,
): Promise<Map<number, number>> {
  const windows = await transferWindowsByType(tx, date);
  const peaks = new Map<number, number>();
  for (const [vehicleTypeId, typeWindows] of windows) {
    peaks.set(vehicleTypeId, peakOverlap(typeWindows));
  }
  return peaks;
}

/**
 * Sums `sellable[id] - peaks[id]` over the UNION of both maps' keys — never
 * over one map's keys alone.
 *
 * **Why the union, not either map's own keys.** A type can be present in
 * only one of the two maps: zero sellable vehicles of a type that still has
 * a standing booked transfer (an admin deactivated the last van of that type
 * after the booking was taken), or sellable vehicles of a type nobody has
 * ever booked. Summing over `sellable`'s keys alone would silently DROP the
 * first case's negative term — the exact gap this project's corrected
 * key-set derivation exists to close (see {@link assessTransferCapacity}'s
 * own note) — and summing over `peaks`' keys alone would drop a type's
 * positive contribution when it has sellable vehicles but no bookings yet.
 * The union, with an explicit `0` standing in for whichever side has no
 * entry, is the only reading that cannot lose a term.
 *
 * A term whose peak exceeds its sellable count goes NEGATIVE here,
 * deliberately left unclamped: a vehicle type with no vehicle left to serve
 * it is a real claim on the day, and refusing the next whole-day tour is the
 * conservative answer to it. This is the same "left unclamped on purpose"
 * comment `assessTransferCapacity` carries, restated here because this is
 * the OTHER caller of the same arithmetic — `services/capacity.ts`'s Gate 2b.
 */
export function sumLeftoverVehicles(
  sellable: SellableVehicleCounts,
  peaks: Map<number, number>,
): number {
  const ids = new Set<number>([...sellable.keys(), ...peaks.keys()]);
  let total = 0;
  for (const id of ids) {
    total += (sellable.get(id) ?? 0) - (peaks.get(id) ?? 0);
  }
  return total;
}

/**
 * The default per-driver transfer-job cap, read through the caller's
 * transaction (and therefore after its locks). One place, so the tour gate and
 * the transfer gate can never read different defaults for one date.
 */
export async function readDefaultDriverTransferCap(tx: Transaction): Promise<number> {
  const operations = await readTransferOperationsSettingsTx(tx);
  return operations.maxTransferJobsPerDriverPerDay;
}

export interface TransferCapacityParams {
  /** The civil `tour_date` in Asia/Manila. */
  date: string;
  /** The candidate's requested vehicle type's id (`vehicle_types.id`). */
  vehicleTypeId: number;
  productType: TransferProductType;
  pickupTimeMinutes: number;
  dayUseEndTimeMinutes: number | null;
  routeDurationMinutes: number | null;
  /**
   * The buffer the CALLER will freeze onto this booking as
   * `booking_transfer_details.buffer_minutes_used` — i.e. the current
   * `transfer_operations.bufferMinutes`, read by the caller. It is a parameter
   * rather than a read in here so that the value this check was made under and
   * the value stored on the booking are provably the same one.
   */
  bufferMinutes: number;
}

/**
 * The verdict for one more transfer on `date`. All five of Architecture
 * §2/§2a's conditions, in the order whose first failure is the most useful
 * sentence to a guest.
 *
 * **Call `takeFleetDateLock(tx, date)` first, as the transaction's first
 * statements** — see THE PRECONDITION in the module note. Nothing here locks.
 *
 *  1. The candidate's own window. A window past midnight is refused
 *     `pickup_crosses_midnight` with **no database read at all** — there is
 *     nothing to ask the fleet about a trip that cannot be scheduled on one
 *     day.
 *  2. Conditions (1)/(2): each type's peak, **recomputed with the candidate's
 *     own window included**, must fit that type's sellable count. Comparing
 *     against the pre-candidate peak would let the last van be sold twice.
 *  3. Condition (3): tours must still fit in what is left over after each
 *     type's transfer peak has reserved its share.
 *  4. Conditions (4)/(5): the driver pool, as a job count. `toursToday >= N`
 *     needs no separate test — it makes the leftover zero, so (5) refuses.
 *
 * **The key-set derivation below is exact, not a simplification, and the
 * order of these three lines is the whole point** (owner decision
 * 2026-11-08, Opus review finding — design note §2): `windows` is computed
 * FIRST, the candidate's own window is pushed into `windows` SECOND, and only
 * THEN is the key set taken as `keys(windows) ∪ keys(sellable)` — with
 * `sellable` given an explicit `0` for any id that is in `windows` but absent
 * from it. Because the push happens before the key set is read, the
 * candidate's own type is in the set BY CONSTRUCTION, even when it has zero
 * sellable vehicles and zero existing bookings. A derivation that instead
 * unions "active types with ≥1 sellable vehicle" with "types claimed by
 * EXISTING bookings" — computed independently of the candidate — can leave
 * the key set EMPTY for exactly that type, which makes conditions (1)/(2)
 * below pass vacuously (an empty loop refuses nothing) and accepts a hold
 * against a vehicle type the fleet does not have a single vehicle of. This
 * is deliberately NOT the simpler-looking "active-sellable ∪ booked" union;
 * do not refactor it into one.
 *
 * Never throws a REFUSAL (it returns one), but it DOES throw on a malformed
 * argument, which includes a custom one-way transfer with no stored duration.
 * See `computeTransferWindow`.
 */
export async function assessTransferCapacity(
  tx: Transaction,
  params: TransferCapacityParams,
): Promise<TransferCapacityVerdict> {
  assertCivilDate(params.date);

  // 1. The candidate's window, before anything is read.
  const candidate = computeTransferWindow({
    productType: params.productType,
    pickupTimeMinutes: params.pickupTimeMinutes,
    dayUseEndTimeMinutes: params.dayUseEndTimeMinutes,
    routeDurationMinutes: params.routeDurationMinutes,
    bufferMinutes: params.bufferMinutes,
  });
  if (!candidate.ok) return { ok: false, reason: 'pickup_crosses_midnight' };

  const sellable = await sellableVehiclesByType(tx);
  const windows = await transferWindowsByType(tx, params.date);
  const toursToday = await countToursOn(tx, params.date);

  // 2. Conditions (1) and (2), with the candidate pushed into ITS OWN type's
  //    bucket BEFORE the key set is computed — see the function doc above.
  const candidateBucket = windows.get(params.vehicleTypeId);
  if (candidateBucket) {
    candidateBucket.push(candidate.window);
  } else {
    windows.set(params.vehicleTypeId, [candidate.window]);
  }

  // The corrected key set: every type `windows` now claims, union every type
  // `sellable` counts — with an explicit 0 standing in for whichever map has
  // no entry for a given id, never a missing key read as "nothing to check".
  const vehicleTypeIds = new Set<number>([...windows.keys(), ...sellable.keys()]);
  const peaks = new Map<number, number>();
  for (const id of vehicleTypeIds) {
    peaks.set(id, peakOverlap(windows.get(id) ?? []));
    if (!sellable.has(id)) sellable.set(id, 0);
  }

  for (const id of vehicleTypeIds) {
    if (peaks.get(id)! > sellable.get(id)!) {
      return { ok: false, reason: 'no_vehicle_available' };
    }
  }

  /*
   * 3. Condition (3) — the leftover pool a whole-day tour has to fit in. Not
   * affected by adding a transfer except through the peak, which step 2 has
   * already recomputed. A type whose peak somehow exceeds its sellable count
   * contributes a NEGATIVE term; that is left unclamped on purpose, because the
   * transfer that has no vehicle is a real claim on the day and refusing one
   * more tour is the conservative answer to it — now summed over every id in
   * the corrected key set rather than two named branches, via
   * {@link sumLeftoverVehicles} (the SAME helper `services/capacity.ts`'s Gate
   * 2b uses, so the two capacity gates can never read this arithmetic
   * differently).
   */
  const leftoverVehicles = sumLeftoverVehicles(sellable, peaks);
  if (toursToday > leftoverVehicles) {
    return { ok: false, reason: 'no_vehicle_available' };
  }

  // 4. Conditions (4) and (5) — the driver pool, as a job count.
  const driverCaps = await driverTransferCapsOn(
    tx,
    params.date,
    await readDefaultDriverTransferCap(tx),
  );
  const transfersToday = await countTransfersOn(tx, params.date);
  if (transfersToday + 1 > leftoverTransferCapacity(driverCaps, toursToday)) {
    return { ok: false, reason: 'no_driver_available' };
  }

  return { ok: true };
}
