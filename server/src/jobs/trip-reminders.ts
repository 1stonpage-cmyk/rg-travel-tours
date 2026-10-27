/**
 * The day-before trip reminder (Week 7 Task 14, 7E) — §11's "day-before
 * reminder", the sixth of its seven events.
 *
 * One email per booking departing TOMORROW in Manila, sent the afternoon
 * before. Same discipline as `expire-holds.ts` and `orphaned-vans.ts`: the
 * clock is a PARAMETER, this module exports one plain async function,
 * scheduling lives in `./index.ts`, and importing this starts nothing.
 *
 * ## The window is tomorrow IN MANILA
 *
 * `manilaCivilDate(now)` then `addCivilDays(…, 1)`, never `now` plus 86.4
 * million milliseconds and never a UTC date. For eight hours out of every
 * twenty-four the UTC day and the Manila day differ, so a sweep reading the
 * UTC date would remind the wrong day's guests for a third of the clock. The
 * comparison against `bookings.tour_date` goes through the local raw-`sql`
 * `onDate()` helper, because that column is a `date()` and `eq()` against a
 * civil-date string would force a `Date` and reopen the midnight shift
 * (`CLAUDE.md`: "A civil date is a string; a `date()` column is a `Date`").
 *
 * ## Which bookings are real enough to remind
 *
 * `REMINDED_STATUSES` — `confirmed` and `assigned`, and nothing else. A
 * reminder is a promise that the trip is happening, so:
 *
 *  - `pending_payment` has not paid and its hold is probably already lapsed;
 *  - `pending_verification` has uploaded a receipt nobody has checked, and
 *    "your tour is tomorrow" is a promise we may still have to retract;
 *  - `cancelled` and `expired` are not trips (the brief's one hard rule);
 *  - `in_progress` and `completed` cannot have a tour date of tomorrow, and
 *    are excluded rather than relied upon not to occur.
 *
 * An allow-list, not a deny-list, for the reason `VAN_STATUS_SELLABLE` is
 * one: a status added later should send no mail until somebody decides it
 * should.
 *
 * ## It sends AT MOST ONCE, and the record is an `audit_log` row
 *
 * No new table and no new column (brief). The sweep claims a booking by
 * COMMITTING its `trip.reminder_sent` audit row and only then sends the mail.
 * That order is deliberate and it is the at-most-once choice: if the process
 * dies between the two, the guest misses one reminder. Sending first would
 * mean a death before the commit mails them again tomorrow, and a duplicate
 * email is the worse failure — it is the one a guest reports.
 *
 * The claim is a plain read-then-write rather than a lock or a unique index,
 * which is safe for the reason `hasAuditRow`'s own note gives: node-cron runs
 * it `noOverlap` in a single PM2 fork-mode process.
 *
 * ## One bad row must not stop the sweep
 *
 * Per-booking `try`, counted in `failed`, exactly as `expireHolds()` does —
 * one booking whose claim cannot commit must not cost every later guest their
 * reminder. `notify()` itself cannot throw, so `failed` only ever counts a
 * database failure.
 */
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { addCivilDays, manilaCivilDate, type BookingStatus } from '@rg/shared';
import { getDb } from '../db/client';
import { bookings, tours } from '../db/schema';
import { hasAuditRow, writeAudit } from '../services/audit';
import { notify } from '../services/notify';

/** The audit action that IS the record a reminder went out. */
export const TRIP_REMINDER_ACTION = 'trip.reminder_sent';

/** The only statuses that get a reminder — see the module note. */
export const REMINDED_STATUSES = [
  'confirmed',
  'assigned',
] as const satisfies readonly BookingStatus[];

export interface TripRemindersResult {
  /** Bookings this run mailed (or tried to mail) for the first time. */
  sent: number;
  /** Bookings skipped because the audit row says a reminder already went. */
  alreadySent: number;
  /** Bookings whose claim could not be committed. Not retried today. */
  failed: number;
}

/**
 * `column = :date` for a civil-date column against a civil-date STRING.
 *
 * Raw `sql`, not `eq()` — identical in shape to `onDate()` in
 * `services/dispatch/availability.ts` and `routers/admin/departures.ts`, and
 * kept local for the same reason those are: this module's date comparison is
 * not either of their jobs.
 */
function onDate(column: typeof bookings.tourDate, date: string) {
  return sql`${column} = ${date}`;
}

/**
 * Reminds every guest whose tour is tomorrow in Manila, once.
 *
 * `now` is the only clock. Resolves with what this run did, so two runs on
 * one afternoon report `sent: 1` then `alreadySent: 1` rather than claiming
 * the work twice.
 */
export async function sendTripReminders(now: Date): Promise<TripRemindersResult> {
  const db = getDb();
  const tomorrow = addCivilDays(manilaCivilDate(now), 1);

  /*
   * The candidate read runs on the pool, outside any transaction: it is a
   * pre-filter, and the claim below re-asks under its own transaction.
   * `tours` is inner-joined because a booking always has one.
   */
  const candidates = await db
    .select({
      id: bookings.id,
      ref: bookings.ref,
      leadEmail: bookings.leadEmail,
      tourTitle: tours.title,
      totalCentavos: bookings.totalCentavos,
      paidCentavos: bookings.amountPaidCentavos,
    })
    .from(bookings)
    // `eq` is correct here: both sides are `int` columns. Only the civil-date
    // comparison needs the raw-`sql` helper.
    .innerJoin(tours, eq(tours.id, bookings.tourId))
    .where(and(onDate(bookings.tourDate, tomorrow), inArray(bookings.status, REMINDED_STATUSES)))
    .orderBy(asc(bookings.id));

  const result: TripRemindersResult = { sent: 0, alreadySent: 0, failed: 0 };

  for (const booking of candidates) {
    try {
      /*
       * CLAIM, then send. The `hasAuditRow` check is inside the same
       * transaction as the write, so the pre-filter above is a convenience
       * and this is the decision.
       */
      const claimed = await db.transaction(async (tx) => {
        if (
          await hasAuditRow(tx, {
            entity: 'bookings',
            entityId: booking.id,
            action: TRIP_REMINDER_ACTION,
          })
        ) {
          return false;
        }
        await writeAudit(tx, {
          // A cron is `system`: never `user` (nobody pressed anything) and
          // never `provider` (that means a gateway).
          actorType: 'system',
          actorId: null,
          action: TRIP_REMINDER_ACTION,
          entity: 'bookings',
          entityId: booking.id,
          // Identifiers and the day only — never the guest's email address or
          // name. Audit rows are read by every admin and exported in reports.
          data: { ref: booking.ref, tourDate: tomorrow, sweptAt: now.toISOString() },
        });
        return true;
      });

      if (!claimed) {
        result.alreadySent += 1;
        continue;
      }

      // Outside the transaction on purpose: an SMTP round trip must not hold
      // a database transaction (and its connection) open. `notify()` cannot
      // throw, so the count below is honest about the attempt, not the
      // delivery — §11 treats email as best-effort.
      await notify('trip_reminder', {
        to: booking.leadEmail,
        ref: booking.ref,
        tourTitle: booking.tourTitle,
        tourDate: tomorrow,
        totalCentavos: booking.totalCentavos,
        paidCentavos: booking.paidCentavos,
      });
      result.sent += 1;
    } catch (error) {
      result.failed += 1;
      // The ref and the error's type. Never its message: a mail or database
      // error routinely quotes a credential (see `services/notify/index.ts`).
      const kind = error instanceof Error ? error.name : typeof error;
      console.error(`[jobs] trip-reminders: ${booking.ref} could not be reminded (${kind})`);
    }
  }

  return result;
}
