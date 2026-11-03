/**
 * Week 5 "Dispatch", Task 3: the availability module.
 *
 * The single source of truth for "which van and which driver are free on
 * this date" — §9 "Calendar"'s exclusion rules, written once here and
 * nowhere else. Five later tasks read this module (the calendar's
 * dropdowns, the auto-suggest, the assignment mutation's re-check inside
 * its lock, and two screens); if the rules lived in more than one place
 * they would drift, and the specific thing that drift produces is one van
 * sent to two trips on the same morning.
 *
 * **This module WRITES NOTHING.** `vansFreeOn` and `driversFreeOn` are
 * reads only — the assignment mutation that writes `bookings.van_id` /
 * `driver_id` is a later task, not this one.
 *
 * ## Capacity COUNTS, availability IDENTIFIES
 *
 * `assessCapacity()` (`services/capacity.ts`) answers "may one more group
 * book this tour on this day?" by counting the whole fleet against every
 * capacity-holding booking on that date, across ALL tours. This module
 * answers a different question — "which specific vans/drivers are free?" —
 * by identifying rows, one at a time, each checked against bookings that
 * are actually assigned to IT.
 *
 * The two are allowed to disagree in exactly one direction: `vansFreeOn` /
 * `driversFreeOn` may be MORE generous than `assessCapacity`'s arithmetic,
 * because capacity deducts every capacity-holding booking from the fleet
 * whether or not it has a van yet, while this module only excludes a van
 * that is actually assigned. They must NEVER disagree about whether a
 * van's STATUS makes it usable at all — that is the one-van, one-date,
 * no-other-bookings condition the status-agreement test in
 * `dispatch-availability.test.ts` pins.
 *
 * ## The exclusion rules (§9 "Calendar")
 *
 * Excluded van:
 *  - `is_active = 0` — soft-deleted.
 *  - `status <> VAN_STATUS_SELLABLE` — anything but `available`. Allow-list,
 *    per the owner's Q1 decision (2026-10-14) — imported from `db/schema`,
 *    never restated as a literal and never written as a deny-list.
 *  - `capacity < minCapacity` — too small for this group.
 *  - Assigned to another booking on this date whose status holds capacity.
 *
 * Excluded driver:
 *  - `is_active = 0` — soft-deleted.
 *  - A `driver_leaves` row covers the date — inclusive at both ends.
 *  - Assigned to another booking on this date whose status holds capacity.
 *
 * **Not excluded, deliberately:** `drivers.status = 'off_duty'`. §9 lists
 * driver status as active / on leave (a date range) / inactive — leave is a
 * range, not a flag, and excluding on the flag would hide a driver from
 * every future date the moment someone set it. If the owner wants the flag
 * to block dispatch too, that is Q4 — not decided here.
 *
 * ## NOT EXISTS, never a count, never a LEFT JOIN … IS NULL
 *
 * Two bookings holding the same van/driver would make a count subtract
 * twice — the exact bug `assessCapacity`'s Gate 3 comment warns about for
 * drivers. A correlated `NOT EXISTS` has no such failure mode.
 *
 * ## TRANSFER dispatch (transfers-launch plan, Architecture §2/§2a; Task T8)
 *
 * A TOUR holds a van and a driver for the WHOLE civil day. A TRANSFER holds
 * them only for `[pickup, estimated end + buffer)`, so one van can run
 * several transfers in a day — which means the question "is van #7 free on
 * this date" is no longer answerable without knowing WHEN.
 *
 * Both functions therefore have two shapes, and which one you get is decided
 * by whether `FreeOnOptions.transferWindow` is present:
 *
 *  - **Absent** (every caller before T8 — the calendar dropdowns, the
 *    auto-suggest, a TOUR assignment): the single `NOT EXISTS` query above,
 *    byte for byte unchanged. Any assigned booking on the date excludes the
 *    resource for the whole day, transfer or not, because a tour needs the
 *    whole day and cannot be fitted around someone else's 2pm airport run.
 *  - **Present** (a TRANSFER assignment): a two-phase computation — candidate
 *    rows from SQL, then the date's assigned load reduced in JS. A resource
 *    holding a TOUR that date is still excluded for the whole day; a resource
 *    holding another TRANSFER is excluded only if the two windows actually
 *    OVERLAP (`overlaps`, buffer included, half-open).
 *
 * `driversFreeOn` carries one rule vehicles do not: §2a's per-driver daily
 * JOB CAP. A driver is excluded by **count OR overlap** — either one is
 * enough — because the cap is a limit on how much work one human does in a
 * day, not a schedule.
 *
 * The two-phase shape is not a performance choice, it is a correctness one:
 * `windowForBookedTransfer` is JS (it fails CLOSED to the whole day on an
 * unreadable row, and SQL cannot), so the windows have to be computed outside
 * the database and the ordering done outside it too.
 */
import { and, asc, eq, gte, inArray, isNotNull, ne, notExists, sql } from 'drizzle-orm';
import { CAPACITY_HOLDING_STATUSES, type VehicleType } from '@rg/shared';
import type { Transaction } from '../../db/client';
import {
  bookingTransferDetails,
  bookings,
  driverLeaves,
  drivers,
  vans,
  VAN_STATUS_SELLABLE,
} from '../../db/schema';
import {
  readDefaultDriverTransferCap,
  windowForBookedTransfer,
  type BookedTransferRow,
} from '../transfers/capacity';
import { overlaps, type TimeWindow } from '../transfers/overlap';

export interface FreeVan {
  id: number;
  plate: string;
  model: string;
  capacity: number;
  /**
   * Bags the luggage hold can take; NULL = not recorded for this vehicle
   * (pre-task 0C). Carried so the assign panel can WARN a dispatcher before
   * they submit — it is not a filter here, and no branch of `vansFreeOn`
   * reads it: the transfer soft-check lives in `assignVanAndDriver` alone.
   */
  luggageCapacity: number | null;
}

export interface FreeDriver {
  id: number;
  name: string;
  code: string;
}

export interface FreeOnOptions {
  /** Ignore this booking's own current assignment, so re-assigning a
   *  booking does not exclude the van/driver it already holds. */
  excludeBookingId?: number;
  /**
   * TRANSFER dispatch only. When present, a van/driver already holding
   * another TRANSFER that date is excluded only if that transfer's window
   * OVERLAPS this one (buffer included) — not for the whole day. A van/driver
   * holding a TOUR that date is still excluded for the whole day regardless.
   * Omit this for a TOUR assignment (today's only caller shape) to get the
   * exact unchanged whole-day exclusion.
   */
  transferWindow?: TimeWindow;
}

export interface VansFreeOnOptions extends FreeOnOptions {
  /**
   * TRANSFER dispatch only: restrict to this vehicle type instead of
   * filtering by `minCapacity` (the type IS the fit — see
   * `services/transfers/capacity.ts`'s own doc on why transfers aren't
   * seat-filtered). Pass `minCapacity: 0` alongside this for a transfer call.
   */
  vehicleType?: VehicleType;
}

/**
 * What one date's already-assigned bookings mean for ONE van or ONE driver:
 * does it hold a whole-day tour, and which transfer windows does it hold?
 *
 * A resource with no entry in the map at all is free — the absence IS the
 * answer, so nothing has to pre-seed every candidate id.
 */
interface AssignedLoad {
  hasTour: boolean;
  transferWindows: TimeWindow[];
}

/**
 * Every capacity-holding booking on `date` that is assigned to SOME van (or
 * SOME driver — `resourceColumn` picks which), grouped by the id it is
 * assigned to.
 *
 * **The join on `booking_transfer_details` is a LEFT join**, the same
 * discipline (and for the same reason) as `transferWindowsByType`: an inner
 * join would silently DROP a transfer whose details row is missing, and a
 * dropped row is a van this function then offers for a second trip. A row
 * that cannot be read is counted as the WHOLE DAY instead, by
 * `windowForBookedTransfer` — which is why that function is imported rather
 * than a second window computation written here.
 *
 * `routeDurationMinutesUsed` and `bufferMinutesUsed` are the values FROZEN at
 * hold time, never a live read of the catalog route — see those columns' doc
 * comments in `db/schema.ts`.
 */
async function assignedLoadByResource(
  tx: Transaction,
  date: string,
  resourceColumn: typeof bookings.vanId | typeof bookings.driverId,
  excludeBookingId: number | undefined,
): Promise<Map<number, AssignedLoad>> {
  const where = [onDate(bookings.tourDate, date), holdsCapacity, isNotNull(resourceColumn)];
  if (excludeBookingId !== undefined) {
    where.push(ne(bookings.id, excludeBookingId));
  }

  const rows = await tx
    .select({
      resourceId: resourceColumn,
      bookingId: bookings.id,
      productType: bookings.productType,
      vehicleType: bookings.vehicleTypeRequested,
      pickupTime: bookingTransferDetails.pickupTime,
      dayUseEndTime: bookingTransferDetails.dayUseEndTime,
      bufferMinutesUsed: bookingTransferDetails.bufferMinutesUsed,
      routeDurationMinutes: bookingTransferDetails.routeDurationMinutesUsed,
    })
    .from(bookings)
    .leftJoin(bookingTransferDetails, eq(bookingTransferDetails.bookingId, bookings.id))
    .where(and(...where));

  const byResource = new Map<number, AssignedLoad>();
  for (const row of rows) {
    // `isNotNull(resourceColumn)` above makes this non-null; the type is
    // nullable because the COLUMN is.
    if (row.resourceId === null) continue;
    let load = byResource.get(row.resourceId);
    if (load === undefined) {
      load = { hasTour: false, transferWindows: [] };
      byResource.set(row.resourceId, load);
    }
    if (row.productType === 'tour') {
      load.hasTour = true;
      continue;
    }
    load.transferWindows.push(windowForBookedTransfer(row satisfies BookedTransferRow));
  }
  return byResource;
}

/**
 * Is this resource excluded from taking `candidate` by the load it already
 * holds? A whole-day tour excludes it outright; otherwise only a genuinely
 * overlapping transfer window does.
 */
function blockedByLoad(load: AssignedLoad | undefined, candidate: TimeWindow): boolean {
  if (load === undefined) return false;
  if (load.hasTour) return true;
  return load.transferWindows.some((window) => overlaps(window, candidate));
}

/**
 * Bookings in one of the five statuses that hold capacity — read from the
 * shared `CAPACITY_HOLDING_STATUSES` constant, never restated here.
 * `cancelled`, `expired` and `completed` release the day, which is why a
 * cancelled booking's van/driver comes back free.
 */
const holdsCapacity = inArray(bookings.status, [...CAPACITY_HOLDING_STATUSES]);

/**
 * `column = :date`, comparing a civil date to a civil-date string.
 *
 * Raw `sql`, not `eq()`: `bookings.tourDate` is Drizzle's `date` column
 * type, whose default mode maps to a JS `Date` at the type level, so `eq()`
 * would force a `Date` here and reopen the midnight-shift hazard this whole
 * module avoids by staying on civil-date strings end to end. Identical to
 * the helper of the same shape in `services/capacity.ts` — kept local
 * rather than shared, so this module does not depend on the capacity
 * service for something that isn't the capacity service's job.
 */
function onDate(column: typeof bookings.tourDate, date: string) {
  return sql`${column} = ${date}`;
}

/** The base filters every van candidate passes, whichever branch is taken. */
function vanBaseClauses(minCapacity: number, vehicleType: VehicleType | undefined) {
  const clauses = [
    eq(vans.isActive, true),
    eq(vans.status, VAN_STATUS_SELLABLE),
    gte(vans.capacity, minCapacity),
  ];
  if (vehicleType !== undefined) {
    clauses.push(eq(vans.vehicleType, vehicleType));
  }
  return clauses;
}

const VAN_COLUMNS = {
  id: vans.id,
  plate: vans.plate,
  model: vans.model,
  capacity: vans.capacity,
  luggageCapacity: vans.luggageCapacity,
};

/** `capacity` then `id` — the SQL `ORDER BY` the windowed branch has to do itself. */
const byCapacityThenId = (a: FreeVan, b: FreeVan) => a.capacity - b.capacity || a.id - b.id;

/**
 * Every van free for `minCapacity` guests on `date`.
 *
 * Ordered by `capacity` then `id`, so the dropdowns are stable and the
 * "smallest that fits" auto-suggest is just `[0]`.
 *
 * `opts.transferWindow` switches this between the whole-day exclusion every
 * caller before Task T8 relies on and the window-aware one a TRANSFER
 * assignment needs — see "TRANSFER dispatch" in the module note.
 */
export async function vansFreeOn(
  tx: Transaction,
  date: string,
  minCapacity: number,
  opts?: VansFreeOnOptions,
): Promise<FreeVan[]> {
  const candidate = opts?.transferWindow;

  if (candidate !== undefined) {
    /*
     * TRANSFER dispatch. Two statements, not a correlated `NOT EXISTS`: the
     * window of an EXISTING booking is computed in JS by
     * `windowForBookedTransfer` (which fails closed to the whole day on an
     * unreadable row, a judgement SQL cannot make), so the overlap test
     * cannot be pushed into the database.
     */
    const [rows, load] = await Promise.all([
      tx
        .select(VAN_COLUMNS)
        .from(vans)
        .where(and(...vanBaseClauses(minCapacity, opts?.vehicleType))),
      assignedLoadByResource(tx, date, bookings.vanId, opts?.excludeBookingId),
    ]);
    return rows.filter((van) => !blockedByLoad(load.get(van.id), candidate)).sort(byCapacityThenId);
  }

  // The unchanged whole-day exclusion. Every assigned booking on the date
  // counts, transfer or not: a tour needs the van for the whole day.
  const busyClauses = [
    onDate(bookings.tourDate, date),
    holdsCapacity,
    isNotNull(bookings.vanId),
    eq(bookings.vanId, vans.id),
  ];
  if (opts?.excludeBookingId !== undefined) {
    busyClauses.push(ne(bookings.id, opts.excludeBookingId));
  }

  return await tx
    .select(VAN_COLUMNS)
    .from(vans)
    .where(
      and(
        // `vehicleType` is a TRANSFER-only filter (dedicated review finding,
        // T8). `undefined` here, always, regardless of what `opts` carries:
        // a caller that passed `vehicleType` without `transferWindow` would
        // otherwise silently narrow a TOUR'S van pool by type — a tour can
        // use either type, and nothing about this branch should ever read
        // `opts.vehicleType` at all.
        ...vanBaseClauses(minCapacity, undefined),
        notExists(
          tx
            .select({ one: sql`1` })
            .from(bookings)
            .where(and(...busyClauses)),
        ),
      ),
    )
    .orderBy(asc(vans.capacity), asc(vans.id));
}

/**
 * On leave on `date` — `driver_leaves` is INCLUSIVE at both ends, so `<=` /
 * `>=` (not `<` / `>`): a one-day leave is `start_date = end_date`. Unchanged
 * by Task T8 and applied in BOTH branches.
 */
function notOnLeave(tx: Transaction, date: string) {
  return notExists(
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
  );
}

/** `name` then `id` — the SQL `ORDER BY` the windowed branch has to do itself. */
const byNameThenId = (a: FreeDriver, b: FreeDriver) => a.name.localeCompare(b.name) || a.id - b.id;

/**
 * Every driver free on `date`.
 *
 * Ordered by `name` then `id`, so the dropdowns are stable.
 *
 * `opts.transferWindow` switches this between the whole-day exclusion every
 * caller before Task T8 relies on and the TRANSFER one, which excludes a
 * driver by **count OR overlap** (Architecture §2a): their daily transfer-job
 * cap is a limit on how much one human works, so a driver at their cap is
 * excluded even when none of those jobs clashes with this one.
 */
export async function driversFreeOn(
  tx: Transaction,
  date: string,
  opts?: FreeOnOptions,
): Promise<FreeDriver[]> {
  const candidate = opts?.transferWindow;

  if (candidate !== undefined) {
    /*
     * TRANSFER dispatch. `readDefaultDriverTransferCap` is called ONCE for the
     * whole call, not per driver: it reads one settings row, and asking the
     * same question per candidate inside a lock-holding transaction is how a
     * dropdown becomes N queries.
     *
     * `?? defaultCap`, never `||` — a per-driver override of **0** means "this
     * driver takes no transfer jobs" (one kept for tours), and `0 || 2` would
     * hand them two. The same reasoning, and the same spelling, as
     * `driverTransferCapsOn`.
     */
    const [rows, load, defaultCap] = await Promise.all([
      tx
        .select({
          id: drivers.id,
          name: drivers.name,
          code: drivers.code,
          maxTransferJobsPerDay: drivers.maxTransferJobsPerDay,
        })
        .from(drivers)
        .where(and(eq(drivers.isActive, true), notOnLeave(tx, date))),
      assignedLoadByResource(tx, date, bookings.driverId, opts?.excludeBookingId),
      readDefaultDriverTransferCap(tx),
    ]);

    return rows
      .filter((driver) => {
        const held = load.get(driver.id);
        if (blockedByLoad(held, candidate)) return false;
        const effectiveCap = driver.maxTransferJobsPerDay ?? defaultCap;
        /*
         * The COUNT rule, independent of the overlap one above. `>=` is
         * deliberate at the boundary: a driver with an effective cap of 0 and
         * no jobs at all is excluded (`0 >= 0`), which is the hold-time
         * semantics of a 0-cap driver carried through to dispatch. A negative
         * override — impossible through the admin input — excludes them too,
         * which is the fail-closed direction.
         */
        return (held?.transferWindows.length ?? 0) < effectiveCap;
      })
      .map(({ id, name, code }) => ({ id, name, code }))
      .sort(byNameThenId);
  }

  // The unchanged whole-day exclusion.
  const busyClauses = [
    onDate(bookings.tourDate, date),
    holdsCapacity,
    isNotNull(bookings.driverId),
    eq(bookings.driverId, drivers.id),
  ];
  if (opts?.excludeBookingId !== undefined) {
    busyClauses.push(ne(bookings.id, opts.excludeBookingId));
  }

  return await tx
    .select({ id: drivers.id, name: drivers.name, code: drivers.code })
    .from(drivers)
    .where(
      and(
        eq(drivers.isActive, true),
        notOnLeave(tx, date),
        notExists(
          tx
            .select({ one: sql`1` })
            .from(bookings)
            .where(and(...busyClauses)),
        ),
      ),
    )
    .orderBy(asc(drivers.name), asc(drivers.id));
}
