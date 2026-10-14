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
 *      current van/driver.
 *   2. Refuse unless the status is in the assignable set (the Q2/Q3 table).
 *   3. Refuse `reason_required` if the status is `in_progress` and no
 *      trimmed reason came in.
 *   4. `takeSlotLocks(tx, booking.tourId, tourDate)` — fleet row then tour
 *      row, the established global order.
 *   5. `vansFreeOn` / `driversFreeOn`, re-run inside the lock, excluding
 *      this booking's own current assignment.
 *   6. Refuse unless the chosen van/driver is in those lists.
 *   7. `UPDATE bookings SET van_id, driver_id[, status]` — status only
 *      moves `confirmed -> assigned`; `pending_verification` and
 *      `in_progress` keep their status.
 *   8. `writeAudit`, action named for what happened.
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
 */
import { eq } from 'drizzle-orm';
import { civilDateFromDate, type BookingStatus } from '@rg/shared';
import type { Transaction } from '../../db/client';
import { bookings, vans } from '../../db/schema';
import { takeSlotLocks } from '../capacity';
import { writeAudit } from '../audit';
import { driversFreeOn, vansFreeOn } from './availability';

/** Why an assignment attempt was refused. Never thrown as a bare string. */
export type AssignRefusal =
  | 'booking_not_found'
  | 'booking_not_assignable'
  | 'van_unavailable'
  | 'driver_unavailable'
  | 'van_too_small'
  /** An in_progress re-assignment arrived without a reason (Q3). */
  | 'reason_required';

export type AssignVerdict = { ok: true } | { ok: false; reason: AssignRefusal };

export interface AssignVanAndDriverInput {
  bookingId: number;
  vanId: number;
  driverId: number;
  actorUserId: number;
  /** REQUIRED when the booking is `in_progress` (owner-decided 2026-10-14,
   *  Q3); ignored — and must not be demanded — otherwise. */
  reason?: string;
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
  const { bookingId, vanId, driverId, actorUserId, reason } = input;

  // 1. Read the booking FOR UPDATE — a locking read, so it does not pin the
  //    REPEATABLE READ snapshot the way a plain SELECT would.
  const [booking] = await tx
    .select({
      tourId: bookings.tourId,
      tourDate: bookings.tourDate,
      pax: bookings.pax,
      status: bookings.status,
      vanId: bookings.vanId,
      driverId: bookings.driverId,
    })
    .from(bookings)
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

  // 4. Lock before you look. Fleet row then tour row — the established
  //    global order (services/capacity.ts). Nothing above this line issued
  //    a plain, non-locking read, so the snapshot is still unpinned.
  await takeSlotLocks(tx, booking.tourId, tourDate);

  // 5. Re-check inside the lock. The dropdown the dispatcher clicked was
  //    rendered seconds ago; this is the enforcement, not the dropdown.
  //    `excludeBookingId` so re-assigning a booking does not exclude the
  //    van/driver it already holds.
  const [freeVans, freeDrivers] = await Promise.all([
    vansFreeOn(tx, tourDate, booking.pax, { excludeBookingId: bookingId }),
    driversFreeOn(tx, tourDate, { excludeBookingId: bookingId }),
  ]);

  // 6. Refuse unless the chosen ids are actually free.
  if (!freeVans.some((van) => van.id === vanId)) {
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
    return refuse('driver_unavailable');
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
    },
  });

  return { ok: true };
}
