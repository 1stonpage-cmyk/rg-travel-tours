/**
 * Week 5 "Dispatch", Task 10: `assignVanAndDriver()` — the assignment
 * mutation.
 *
 * **The first code in this project's history to write `bookings.van_id` /
 * `.driver_id`.** Read it with that weight: a wrong van/driver sent to the
 * wrong trip is a family standing on a pier with nobody coming for them.
 *
 * ## Order of operations inside the transaction (and it is the whole
 * implementation)
 *
 *   1. Read the booking `FOR UPDATE` — tourId, tourDate, pax, status,
 *      current van/driver, and (left-joined, same row, same lock) the
 *      product type and the transfer's own frozen window inputs.
 *   2. Refuse unless the status is in the assignable set (the Q2/Q3 table).
 *   3. Refuse `reason_required` if the status is `in_progress` and no
 *      trimmed reason came in.
 *   4. **TOUR:** `takeSlotLocks(tx, booking.tourId, tourDate)` — fleet row
 *      then tour row, the established global order.
 *      **TRANSFER:** `takeFleetDateLock(tx, tourDate)` alone — a transfer has
 *      no `tour_date_slots` row to take, and the fleet row is the single
 *      serialization point for a date (plan Architecture §2).
 *   5. `vansFreeOn` / `driversFreeOn`, re-run inside the lock, excluding
 *      this booking's own current assignment.
 *   6. Refuse unless the chosen van/driver is in those lists.
 *   7. `UPDATE bookings SET van_id, driver_id[, status]` — status only
 *      moves `confirmed -> assigned`; `pending_verification` and
 *      `in_progress` keep their status.
 *   8. `writeAudit`, action named for what happened.
 *
 * Steps 7 and 8 never branch on `product_type`: a transfer's assignment is
 * the same two ids written to the same two columns, and `booking_assigned` is
 * the action an operations review looks for either way.
 *
 * ## Why steps 2-3 (plain reads) come BEFORE step 4 (the locks)
 *
 * This looks backwards next to `services/capacity.ts`'s "locks first, no
 * plain read before them" rule, and it is not a contradiction: step 1's
 * `FOR UPDATE` IS a locking read — it does not pin the REPEATABLE READ
 * snapshot, so nothing about taking it before `takeSlotLocks` is unsafe.
 * Steps 2-3 then only ever read fields captured by that locking read
 * (`booking.status`, already in hand) — they issue no SQL of their own, so
 * there is no plain `SELECT` ahead of `takeSlotLocks` to pin a snapshot.
 * The hazard the brief warns about is `vansFreeOn` / `driversFreeOn` (step
 * 5) running before the locks — a PLAIN, non-locking read — which is why
 * they come after, never before.
 *
 * **Do not "simplify" by moving `takeSlotLocks` earlier or the booking
 * lock later.** The booking row must be locked first so two concurrent
 * assignment attempts on the SAME booking serialise on it (same discipline
 * as `record-payment.ts`'s double-verify fix) and so step 1 can read the
 * tour/date `takeSlotLocks` needs. `takeSlotLocks` itself must still be the
 * first NON-LOCKING-adjacent statement before the plain reads in step 5 —
 * see the mutation proof in the test file that pins this ordering.
 *
 * ## Assigning a TRANSFER (transfers-launch plan, Architecture §2/§2a; T8)
 *
 * `tour_id` is nullable since migration 0017, and a transfer booking has no
 * `tour_date_slots` row — so the transfer branch takes `takeFleetDateLock`
 * alone. That is not a weaker lock: conditions (1)–(5) read across both
 * vehicle types and both product types for one date, so `fleet_date_slots`
 * IS the serialization point and the tour row only ever added a second,
 * narrower one. The ordering discipline above is unchanged — the fleet lock
 * is still taken before step 5's plain reads, and nothing between step 1 and
 * it issues a plain `SELECT` (the transfer's own window inputs ride along on
 * step 1's `FOR UPDATE` read of the same booking row).
 *
 * Three things differ once the lock is held, and nothing else does:
 *
 *  - The booking's window is recomputed from its OWN FROZEN values
 *    (`buffer_minutes_used`, `route_duration_minutes_used`), never from the
 *    catalog route, and handed to `vansFreeOn`/`driversFreeOn` as
 *    `transferWindow` — so another transfer on the same van that day only
 *    excludes it when the two windows actually overlap.
 *  - The van pool is filtered by `vehicle_type_requested` rather than by
 *    seats (`minCapacity: 0`): the guest chose a TYPE, and the type is what
 *    the window claims. A refused van is always `van_unavailable` here —
 *    the `van_too_small` diagnostic is TOUR-only (dedicated review finding):
 *    since seats never gate a transfer's pool, running it anyway could
 *    misreport a van excluded for being the wrong TYPE, or already busy, as
 *    merely "too small".
 *    Because seats never gate the pool, a van of the right type can still be
 *    too small for the party or short on luggage room — which is what step
 *    **6b** (pre-task 0C, owner decision 2026-11-03) checks, SOFTLY: it
 *    refuses `vehicle_too_small` unless the request carried `override` plus
 *    a reason, and records the override on the one audit row.
 *  - A refused driver gets one extra diagnostic, `driver_at_daily_cap`, so
 *    "that driver is done for the day" is not reported as "unavailable" —
 *    which would send a dispatcher hunting for a colleague who did nothing.
 *    (It defers to the generic reason for a driver who is inactive or on
 *    leave — that is the TRUE reason then, not the cap.)
 */
import { and, eq, ne, sql } from 'drizzle-orm';
import {
  civilDateFromDate,
  OVERRIDE_REASON_MIN_LENGTH,
  type AssignRefusal,
  type BookingStatus,
  type ProductType,
} from '@rg/shared';
import type { Transaction } from '../../db/client';
import { bookingTransferDetails, bookings, driverLeaves, drivers, vans } from '../../db/schema';
import { takeFleetDateLock, takeSlotLocks } from '../capacity';
import { holdsCapacity, on } from '../capacity-sql';
import { readDefaultDriverTransferCap } from '../transfers/capacity';
import { clockTimeToMinutes, computeTransferWindow, type TimeWindow } from '../transfers/overlap';
import { writeAudit } from '../audit';
import { driversFreeOn, vansFreeOn } from './availability';

/** Why an assignment attempt was refused. Never thrown as a bare string. */
/*
 * `AssignRefusal` now lives in `@rg/shared` (controller ruling,
 * 2026-10-15) so the admin UI can map every reason to copy exhaustively.
 * Re-exported here because this module is where the reasons are PRODUCED,
 * and a reader following `AssignVerdict` should not have to go hunting.
 */
export type { AssignRefusal };

export type AssignVerdict = { ok: true } | { ok: false; reason: AssignRefusal };

export interface AssignVanAndDriverInput {
  bookingId: number;
  vanId: number;
  driverId: number;
  actorUserId: number;
  /** REQUIRED when the booking is `in_progress` (owner-decided 2026-10-14,
   *  Q3); ignored — and must not be demanded — otherwise. */
  reason?: string;
  /**
   * TRANSFER assignment only (pre-task 0C, owner decision 2026-11-03): the
   * dispatcher has seen that the chosen van may not fit this booking's party
   * or its luggage and is assigning it anyway. Inert on a TOUR, where an
   * undersized van was never in `vansFreeOn`'s answer to begin with.
   *
   * Separate from `reason` on purpose: the two are independent concepts and
   * both can apply to one submission (a mid-trip swap onto a smaller van).
   */
  override?: boolean;
  /**
   * REQUIRED whenever `override` is true, and at least
   * `OVERRIDE_REASON_MIN_LENGTH` characters after trimming. Enforced TWICE,
   * against that one constant: by `assignInputSchema` for anything arriving
   * over tRPC, and again by step 6b below for a caller that never went
   * through Zod. An `override` with no usable reason is simply not an
   * override, from either direction.
   */
  overrideReason?: string;
}

/**
 * Statuses dispatch may assign a van/driver to, and what happens to the
 * status when it does — owner decisions, 2026-10-14 (Q2 and Q3 together).
 * Transcribed once, here, so the table in the brief has exactly one home.
 *
 *  - `confirmed`             -> `assigned` (the only status CHANGE this
 *    mutation makes).
 *  - `assigned`               stays `assigned` (re-assignment before
 *    departure).
 *  - `pending_verification`   stays `pending_verification` (Q2 pre-assign —
 *    writing `assigned` here would be a MONEY LIE: `assigned` reads as paid
 *    everywhere else in the system and the receipt has not been checked).
 *  - `in_progress`            stays `in_progress`, and REQUIRES a reason
 *    (Q3 — a van breaking down mid-trip is real and must be recorded as
 *    such).
 *
 * `pending_payment`, `completed`, `cancelled`, `expired` are not in this
 * map at all and are refused.
 */
const ASSIGNABLE_STATUSES: readonly BookingStatus[] = [
  'confirmed',
  'assigned',
  'pending_verification',
  'in_progress',
];

function refuse(reason: AssignRefusal): AssignVerdict {
  return { ok: false, reason };
}

/** The transfer-shaped columns step 1's locking read carries along. */
interface TransferBookingRow {
  productType: ProductType;
  vehicleTypeId: number | null;
  pickupTime: string | null;
  dayUseEndTime: string | null;
  bufferMinutesUsed: number | null;
  routeDurationMinutesUsed: number | null;
}

/**
 * A transfer booking's window, recomputed from the values FROZEN onto it at
 * hold time — never from the catalog route, which an admin may have edited
 * since (see `booking_transfer_details.route_duration_minutes_used`).
 *
 * **Every failure here THROWS rather than refusing, deliberately.** This
 * booking was already accepted at hold time under these exact frozen values,
 * so an unreadable clock label, a missing details row or a window that now
 * crosses midnight is genuine data corruption on a row that passed the
 * hold-time check — not a state a dispatcher can do anything about and not a
 * state any code path can produce. Inventing a refusal reason for it would
 * put an unreachable branch in front of the dispatcher and hide the
 * corruption; a loud `Error` surfaces it. This is the opposite choice from
 * `windowForBookedTransfer`, which fails CLOSED to the whole day — correctly,
 * because there one bad row would otherwise 500 every quote for the date,
 * while here the bad row IS the booking being assigned.
 */
function frozenTransferWindow(
  bookingId: number,
  booking: TransferBookingRow,
): { window: TimeWindow; vehicleTypeId: number } {
  const corrupt = (why: string) => new Error(`booking ${bookingId} is a transfer but ${why}`);

  // `product_type <> 'tour'` whenever `tour_id IS NULL`, by the
  // `bookings_product_type_shape` CHECK. Narrowing the type, not guarding.
  if (booking.productType === 'tour') throw corrupt('its product_type is tour');
  const { vehicleTypeId, pickupTime, bufferMinutesUsed } = booking;
  if (vehicleTypeId === null) throw corrupt('has no vehicle_type_id');
  if (pickupTime === null || bufferMinutesUsed === null) {
    throw corrupt('has no booking_transfer_details row');
  }

  const pickupTimeMinutes = clockTimeToMinutes(pickupTime);
  if (pickupTimeMinutes === null) {
    throw corrupt(`has an unreadable pickup_time (${pickupTime})`);
  }

  let dayUseEndTimeMinutes: number | null = null;
  if (booking.productType === 'transfer_day_use') {
    if (booking.dayUseEndTime === null) throw corrupt('is day-use with no day_use_end_time');
    dayUseEndTimeMinutes = clockTimeToMinutes(booking.dayUseEndTime);
    if (dayUseEndTimeMinutes === null) throw corrupt('has an unreadable day_use_end_time');
  }

  /*
   * Throws on a malformed frozen value (a missing one-way duration, a day-use
   * ending before it starts) — which is the same corruption case and wants the
   * same loud failure, so it is deliberately NOT caught here.
   */
  const result = computeTransferWindow({
    productType: booking.productType,
    pickupTimeMinutes,
    dayUseEndTimeMinutes,
    routeDurationMinutes: booking.routeDurationMinutesUsed,
    bufferMinutes: bufferMinutesUsed,
  });
  if (!result.ok) throw corrupt(`has a window that crosses midnight (${result.reason})`);

  return { window: result.window, vehicleTypeId };
}

/**
 * Does this driver already hold their day's worth of transfer jobs?
 *
 * The count is of OTHER capacity-holding transfer bookings assigned to them on
 * `date` — this booking excluded, so re-assigning a transfer to the driver who
 * already has it never reports them as full. Compared against their effective
 * cap: the per-driver override if set, otherwise the
 * `transfer_operations.maxTransferJobsPerDriverPerDay` default, read through
 * the same one function the hold-time check uses so the two can never disagree.
 *
 * `?? defaultCap`, never `||` — an override of 0 means "no transfer jobs".
 *
 * **Returns `false` for an inactive or on-leave driver** (dedicated review
 * finding, T8), rather than letting the cap arithmetic answer for them: the
 * caller only reaches this function after `driversFreeOn` has ALREADY
 * excluded such a driver, so the question here is never "are they
 * assignable" (settled) but "which SENTENCE explains it". A driver on leave
 * who also happens to be at their cap is `driver_unavailable`, not
 * `driver_at_daily_cap` — the leave is the true reason, and "done for the
 * day" would send a dispatcher re-checking a cap that was never the issue.
 */
async function driverAtDailyCap(
  tx: Transaction,
  driverId: number,
  date: string,
  bookingId: number,
): Promise<boolean> {
  const [driver] = await tx
    .select({ cap: drivers.maxTransferJobsPerDay, isActive: drivers.isActive })
    .from(drivers)
    .where(eq(drivers.id, driverId))
    .limit(1);
  if (driver === undefined || !driver.isActive) return false;

  const [leave] = await tx
    .select({ one: sql`1` })
    .from(driverLeaves)
    .where(
      and(
        eq(driverLeaves.driverId, driverId),
        sql`${driverLeaves.startDate} <= ${date}`,
        sql`${driverLeaves.endDate} >= ${date}`,
      ),
    )
    .limit(1);
  if (leave !== undefined) return false;

  const [row] = await tx
    .select({ n: sql<number>`COUNT(*)` })
    .from(bookings)
    .where(
      and(
        eq(bookings.driverId, driverId),
        on(bookings.tourDate, date),
        ne(bookings.productType, 'tour'),
        holdsCapacity,
        ne(bookings.id, bookingId),
      ),
    );
  const held = Number(row?.n ?? 0);
  const effectiveCap = driver.cap ?? (await readDefaultDriverTransferCap(tx));

  return held >= effectiveCap;
}

/**
 * Assigns a van and driver to a booking, or refuses — never throws a
 * REFUSAL (same contract as `assessCapacity`); it DOES throw on a
 * programmer error such as a malformed civil date, which cannot reach this
 * function from the validated tRPC input.
 *
 * Must be called inside a transaction the caller owns — every statement
 * here goes through `tx`, never `getDb()`, for the same reason
 * `services/capacity.ts` insists on it: a read on a pooled connection
 * would be a read outside this function's own locks.
 */
export async function assignVanAndDriver(
  tx: Transaction,
  input: AssignVanAndDriverInput,
): Promise<AssignVerdict> {
  const { bookingId, vanId, driverId, actorUserId, reason, override, overrideReason } = input;

  /*
   * 1. Read the booking FOR UPDATE — a locking read, so it does not pin the
   *    REPEATABLE READ snapshot the way a plain SELECT would.
   *
   *    The `booking_transfer_details` LEFT join rides along on the same
   *    locking read, so the transfer branch needs no second, plain `SELECT`
   *    before the locks — which is the hazard the module note is about. LEFT,
   *    not inner: a TOUR has no details row, and an inner join would make
   *    this read find nothing and refuse every tour as `booking_not_found`.
   */
  const [booking] = await tx
    .select({
      tourId: bookings.tourId,
      tourDate: bookings.tourDate,
      pax: bookings.pax,
      status: bookings.status,
      vanId: bookings.vanId,
      driverId: bookings.driverId,
      productType: bookings.productType,
      vehicleTypeId: bookings.vehicleTypeId,
      pickupTime: bookingTransferDetails.pickupTime,
      dayUseEndTime: bookingTransferDetails.dayUseEndTime,
      bufferMinutesUsed: bookingTransferDetails.bufferMinutesUsed,
      routeDurationMinutesUsed: bookingTransferDetails.routeDurationMinutesUsed,
      // Pre-task 0C: the luggage half of step 6b's soft check. One more
      // column on the join that is already here, so no second read.
      luggageCount: bookingTransferDetails.luggageCount,
    })
    .from(bookings)
    .leftJoin(bookingTransferDetails, eq(bookingTransferDetails.bookingId, bookings.id))
    .where(eq(bookings.id, bookingId))
    .for('update')
    .limit(1);
  if (!booking) return refuse('booking_not_found');

  // 2. The Q2/Q3 assignability table.
  if (!ASSIGNABLE_STATUSES.includes(booking.status)) {
    return refuse('booking_not_assignable');
  }
  const wasInProgress = booking.status === 'in_progress';

  // 3. Q3's reason requirement. Zod already bounds the string when it is
  //    present (shared/src/dispatch.ts); this is the half Zod cannot do,
  //    because it cannot see the booking's status.
  const trimmedReason = reason?.trim();
  if (wasInProgress && !trimmedReason) {
    return refuse('reason_required');
  }

  // `bookings.tour_date` is a Drizzle `date()` column -> a `Date`. Both
  // dependencies below demand a civil-date STRING. Convert once, here, with
  // the shared helper — never toISOString().slice(0, 10) (see @rg/shared's
  // civilDateFromDate doc for why that silently breaks the day the pool's
  // `timezone: 'Z'` setting changes).
  const tourDate = civilDateFromDate(booking.tourDate);
  if (tourDate === null) {
    // Can't happen: `tour_date` is NOT NULL at the schema. Loud rather than
    // silently mis-locking a tour.
    throw new Error(`booking ${bookingId} has a null tour_date`);
  }

  /*
   * A transfer booking is the `tour_id IS NULL` case, and it is now real
   * rather than a stopgap throw. See "Assigning a TRANSFER" in the module
   * note for the three differences; everything else below is shared.
   */
  const transferWindow =
    booking.tourId === null ? frozenTransferWindow(bookingId, booking) : undefined;

  /*
   * 4. Lock before you look. Nothing above this line issued a plain,
   *    non-locking read, so the snapshot is still unpinned.
   *
   *    TOUR: fleet row then tour row — the established global order
   *    (services/capacity.ts). TRANSFER: the fleet row alone, because there
   *    is no `tour_date_slots` row for a booking with no tour, and the fleet
   *    row is the single serialization point for a date.
   */
  if (booking.tourId === null) {
    await takeFleetDateLock(tx, tourDate);
  } else {
    await takeSlotLocks(tx, booking.tourId, tourDate);
  }

  // 5. Re-check inside the lock. The dropdown the dispatcher clicked was
  //    rendered seconds ago; this is the enforcement, not the dropdown.
  //    `excludeBookingId` so re-assigning a booking does not exclude the
  //    van/driver it already holds.
  const [freeVans, freeDrivers] = await Promise.all([
    transferWindow === undefined
      ? vansFreeOn(tx, tourDate, booking.pax, { excludeBookingId: bookingId })
      : // `minCapacity: 0` with a `vehicleTypeId`: the TYPE is the fit for a
        // transfer, never the seat count — the same precedent
        // `sellableVehiclesByType` set at hold time.
        vansFreeOn(tx, tourDate, 0, {
          excludeBookingId: bookingId,
          vehicleTypeId: transferWindow.vehicleTypeId,
          transferWindow: transferWindow.window,
        }),
    driversFreeOn(tx, tourDate, {
      excludeBookingId: bookingId,
      ...(transferWindow === undefined ? {} : { transferWindow: transferWindow.window }),
    }),
  ]);

  // 6. Refuse unless the chosen ids are actually free.
  if (!freeVans.some((van) => van.id === vanId)) {
    /*
     * The `van_too_small` diagnostic below is a TOUR-only sentence (dedicated
     * review finding, T8): a transfer's `vansFreeOn` call passes
     * `minCapacity: 0`, so seats never gate it there — the type does. Running
     * this diagnostic on the transfer branch anyway could misreport a van
     * excluded for being the WRONG TYPE (or already busy) as merely "too
     * small", which is a different, actionable-sounding, and wrong sentence.
     * `van_unavailable` is always the transfer branch's answer; the plain
     * capacity read only happens where it is the true gate.
     */
    if (transferWindow !== undefined) {
      return refuse('van_unavailable');
    }
    // A plain read of the chosen van's OWN capacity, so a too-small van
    // gets a more useful refusal than "unavailable" — this is a diagnostic
    // read, not a re-implementation of `vansFreeOn`'s filtering, which
    // remains the only place the exclusion rules live.
    const [vanRow] = await tx
      .select({ capacity: vans.capacity })
      .from(vans)
      .where(eq(vans.id, vanId))
      .limit(1);
    const tooSmall = vanRow !== undefined && vanRow.capacity < booking.pax;
    return refuse(tooSmall ? 'van_too_small' : 'van_unavailable');
  }
  if (!freeDrivers.some((driver) => driver.id === driverId)) {
    /*
     * One diagnostic read, mirroring `van_too_small` immediately above and on
     * the TRANSFER branch only: "this driver already has their day's transfer
     * jobs" is a different sentence to "someone just took them / they are on
     * leave", and §2a's cap is the one reason a driver can be refused while
     * being provably idle at this hour. Not a re-implementation of
     * `driversFreeOn`'s filtering — that stays the only place the rules live.
     *
     * The TOUR branch is untouched and can still only ever say
     * `driver_unavailable`.
     */
    if (
      transferWindow !== undefined &&
      (await driverAtDailyCap(tx, driverId, tourDate, bookingId))
    ) {
      return refuse('driver_at_daily_cap');
    }
    return refuse('driver_unavailable');
  }

  /*
   * 6b. TRANSFER-ONLY soft check (pre-task 0C, owner decision 2026-11-03).
   * `vansFreeOn`'s transfer branch filters by TYPE only (`minCapacity: 0` —
   * "the type is the fit" for a transfer), so a van of the right type can
   * still be too small for this booking's own party, or short on stated
   * luggage room. TOURS can never reach this branch: a tour's own
   * `vansFreeOn` call already requires `capacity >= pax`, so `freeVans`
   * would never have offered an undersized van in the first place.
   *
   * SOFT, not a rule: the dispatcher knows things the seat count does not
   * (two of the six are toddlers; the bags are going in the back row), so a
   * refusal is overridable with a reason — and the reason goes in the audit
   * row, which is the whole point of letting it through at all.
   *
   * Placed AFTER step 6's two availability checks and BEFORE step 7's write,
   * so a van that is unavailable or the wrong type still gets its own, truer
   * sentence, and so nothing is written on a refusal here either.
   */
  let vehicleOverride:
    | {
        pax: number;
        vanCapacity: number;
        luggageCount: number | null;
        vanLuggageCapacity: number | null;
        reason: string;
      }
    | undefined;
  if (transferWindow !== undefined) {
    const [vanRow] = await tx
      .select({ capacity: vans.capacity, luggageCapacity: vans.luggageCapacity })
      .from(vans)
      .where(eq(vans.id, vanId))
      .limit(1);
    const seatsShort = vanRow !== undefined && vanRow.capacity < booking.pax;
    /*
     * A NULL `luggage_capacity` means "not yet recorded for this vehicle" —
     * so the luggage half SKIPS rather than guesses. Guessing either way is
     * worse: a zero would refuse every van nobody has measured, and treating
     * NULL as unlimited would make the check silently vacuous on a fleet
     * that is mostly unmeasured, which is the fleet this ships to.
     */
    const luggageShort =
      vanRow?.luggageCapacity != null &&
      booking.luggageCount != null &&
      vanRow.luggageCapacity < booking.luggageCount;
    if (seatsShort || luggageShort) {
      const trimmedOverrideReason = override ? overrideReason?.trim() : undefined;
      /*
       * Defence in depth for a caller that never went through Zod — a job, a
       * backfill, a future in-process caller — and it fails CLOSED: no
       * usable reason means no override, however `override` was set.
       *
       * **It enforces the SAME threshold as `assignInputSchema`, from the
       * same constant** (`OVERRIDE_REASON_MIN_LENGTH`). A dedicated review
       * on 2026-11-03 found this check had drifted below the schema's: it
       * tested presence only, so a direct caller could bank a one-character
       * "reason" and leave an audit row claiming a reasoned override. Two
       * layers that disagree are one layer plus a false sense of security.
       * The direct-service tests in `dispatch-assign.test.ts` call this
       * function without the router precisely so this branch is exercised on
       * its own — through tRPC, Zod always refuses first, which is why the
       * review's mutation of this line went unnoticed by the whole suite.
       */
      if (
        !override ||
        !trimmedOverrideReason ||
        trimmedOverrideReason.length < OVERRIDE_REASON_MIN_LENGTH
      ) {
        return refuse('vehicle_too_small');
      }
      vehicleOverride = {
        pax: booking.pax,
        vanCapacity: vanRow!.capacity,
        luggageCount: booking.luggageCount,
        vanLuggageCapacity: vanRow!.luggageCapacity ?? null,
        reason: trimmedOverrideReason,
      };
    }
  }

  const previousVanId = booking.vanId;
  const previousDriverId = booking.driverId;

  // 7. The write. `van_id`, `driver_id` and — CONDITIONALLY — `status`.
  //    Nothing else: no money column is ever touched here (CLAUDE.md).
  //    The status write is NOT unconditional: it moves to `assigned` only
  //    from `confirmed`/`assigned` itself. Writing `assigned` over
  //    `pending_verification` would be a money lie (see the module doc);
  //    writing it over `in_progress` would un-start a running trip.
  await tx
    .update(bookings)
    .set({
      vanId,
      driverId,
      ...(booking.status === 'confirmed' || booking.status === 'assigned'
        ? { status: 'assigned' as const }
        : {}),
    })
    .where(eq(bookings.id, bookingId));

  // 8. Audit, with the actor and both previous values, old -> new. Two
  //    action names, not one, because "a van was swapped mid-trip" is the
  //    row an operations review will go looking for.
  await writeAudit(tx, {
    actorType: 'user',
    actorId: actorUserId,
    action: wasInProgress ? 'booking_reassigned_in_progress' : 'booking_assigned',
    /*
     * 'bookings' (plural), NOT the brief's 'booking' — every other
     * booking-entity audit row in this codebase (booking.held,
     * booking.expired, booking.hold_extended, payment verify/reject's
     * booking-adjacent rows) uses the plural, and `admin.bookings.detail`'s
     * trail query filters on literally `auditLog.entity = 'bookings'`.
     * Writing the singular would make this task's audit rows invisible on
     * the one screen that displays them — the tree wins over the brief here.
     */
    entity: 'bookings',
    entityId: bookingId,
    data: {
      vanId,
      driverId,
      previousVanId,
      previousDriverId,
      /*
       * A reason is RECORDED whenever one was given, not only when it was
       * demanded (Task 10 review, F3).
       *
       * `wasInProgress` gates whether a reason is REQUIRED — that is the
       * owner's Q3 rule. Gating the audit on it too meant a dispatcher who
       * typed an explanation for a pre-departure swap had it accepted by Zod
       * and then silently dropped, which is the worst of both: the UI invited
       * the note and the record threw it away.
       */
      ...(trimmedReason ? { reason: trimmedReason } : {}),
      /*
       * Pre-task 0C. ONE audit row, not a second one: the override is a
       * property of this assignment, so it rides on the same
       * `action`/`entity`/`entityId` an operations review already reads. The
       * numbers are recorded as well as the reason, because "they overruled
       * the fit" is only answerable later if the fit at the time is in the
       * row — the van's seats can be edited afterwards.
       */
      ...(vehicleOverride ? { vehicleOverride } : {}),
    },
  });

  return { ok: true };
}
