/**
 * The review-request sweep (Week 7 Task 14, 7E; owner decision 2026-10-23,
 * Q5) — §11's seventh and last event.
 *
 * "The review-request email is automatic, one per booking ever, sent the
 * morning after completion by a job on the same `0 7 * * *` Asia/Manila
 * schedule as `orphaned-vans` — **a separate job file and a separate
 * `schedule()` registration**, not logic merged into `orphaned-vans.ts`, so
 * neither job's failure touches the other." That is why this file exists
 * beside that one rather than inside it.
 *
 * Same discipline as every other job here: the clock is a PARAMETER, one
 * exported async function, scheduling in `./index.ts`, importing starts
 * nothing.
 *
 * ## Why the window is a LOOKBACK and not "yesterday"
 *
 * The sweep covers tour days from `REVIEW_LOOKBACK_DAYS` ago up to and
 * including YESTERDAY in Manila. Two reasons, and the second is the one that
 * matters:
 *
 *  1. It is self-healing. A night the job did not run (a deploy, a restart, a
 *     database blip) would otherwise mean those guests are never asked, ever —
 *     "once per booking" cuts both ways.
 *  2. **It makes the audit row load-bearing.** With a one-day window,
 *     yesterday's booking falls out of range tomorrow, so the sweep would
 *     appear idempotent without the audit row doing anything at all — and a
 *     test for "at most once ever" would pass vacuously. Here the booking is
 *     still a candidate for a week, and only `review.requested` stops it.
 *     `review-requests.test.ts` proves exactly that by deleting the row on the
 *     third morning and watching the mail go again.
 *
 * The window also bounds the batch, which is why there is no separate limit
 * constant: a day-tour operator completes at most a handful of trips a day, so
 * a week of them is tens of rows. **Deployment note:** the FIRST run after
 * this ships will therefore mail every guest whose trip completed in the
 * previous `REVIEW_LOOKBACK_DAYS` days, not just yesterday's. That is one
 * bounded burst of a genuinely wanted email, and it is stated here so nobody
 * meets it as a surprise.
 *
 * ## Yesterday is `tour_date`, not `completed_at`
 *
 * `completed_at` is NULL on every booking that predates the 2026-10-16 C1
 * change (`CLAUDE.md`: "Rows that predate this change have nulls, so a report
 * over `completed_at` … must tolerate them"), so a window built on it would
 * silently skip them. `tour_date` is `NOT NULL` on every row, is the day the
 * guest actually travelled, and combined with `status = 'completed'` says
 * exactly what this job needs to know.
 *
 * ## Who is excluded
 *
 * `cancelled` (and every other status) by `status = 'completed'`; and any
 * booking carrying a `payments` row of `type = 'refund'` in ANY payment
 * status — pending, paid or rejected alike. The brief names no status filter
 * and the conservative reading is the right one: a refund in flight means a
 * guest we are in the middle of making whole, and "how was your trip?" is the
 * wrong email to send them. A `type = 'payment'` row never disqualifies
 * anything, which is a test of its own (otherwise a filter on "has a payments
 * row" would silence the whole job and look fine).
 *
 * ## At most once, claimed before sending
 *
 * Identical to `trip-reminders.ts`: the `review.requested` audit row is
 * committed BEFORE the mail goes, so a crash between the two costs a guest one
 * email rather than sending them two. See that file's note.
 */
import { and, asc, eq, notExists, sql } from 'drizzle-orm';
import { addCivilDays, manilaCivilDate } from '@rg/shared';
import { getDb } from '../db/client';
import { bookings, payments, tours } from '../db/schema';
import { hasAuditRow, writeAudit } from '../services/audit';
import { notify } from '../services/notify';

/** The audit action that IS the record a review was asked for. */
export const REVIEW_REQUEST_ACTION = 'review.requested';

/**
 * How many days back the sweep still offers to ask, ending yesterday.
 *
 * Exported so the test can assert the boundary against this number instead of
 * a copy of it — the same reason `HOLD_SWEEP_BATCH_LIMIT` is exported.
 */
export const REVIEW_LOOKBACK_DAYS = 7;

export interface ReviewRequestsResult {
  /** Bookings this run mailed (or tried to mail) for the first time. */
  sent: number;
  /** Bookings skipped because the audit row says they were already asked. */
  alreadySent: number;
  /** Bookings whose claim could not be committed. Not retried today. */
  failed: number;
}

/**
 * `column BETWEEN :from AND :to` for a civil-date column against civil-date
 * STRINGS. Raw `sql`, not `between()` — same reason as `betweenDates()` in
 * `routers/admin/calendar.ts`, kept local for the same reason it is.
 */
function betweenDates(column: typeof bookings.tourDate, from: string, to: string) {
  return sql`${column} BETWEEN ${from} AND ${to}`;
}

/**
 * Asks for a review once per completed booking, for trips inside the lookback
 * window ending yesterday in Manila.
 *
 * `now` is the only clock.
 */
export async function sendReviewRequests(now: Date): Promise<ReviewRequestsResult> {
  const db = getDb();
  const today = manilaCivilDate(now);
  const from = addCivilDays(today, -REVIEW_LOOKBACK_DAYS);
  const to = addCivilDays(today, -1);

  const candidates = await db
    .select({
      id: bookings.id,
      ref: bookings.ref,
      leadEmail: bookings.leadEmail,
      tourTitle: tours.title,
      tourDate: bookings.tourDate,
      totalCentavos: bookings.totalCentavos,
      paidCentavos: bookings.amountPaidCentavos,
    })
    .from(bookings)
    .innerJoin(tours, eq(tours.id, bookings.tourId))
    .where(
      and(
        betweenDates(bookings.tourDate, from, to),
        eq(bookings.status, 'completed'),
        /*
         * No refund row of any status. A correlated NOT EXISTS rather than a
         * join, so a booking with two refund rows is excluded once and no row
         * is duplicated into the result.
         */
        notExists(
          db
            .select({ one: sql`1` })
            .from(payments)
            .where(and(eq(payments.bookingId, bookings.id), eq(payments.type, 'refund'))),
        ),
      ),
    )
    .orderBy(asc(bookings.id));

  const result: ReviewRequestsResult = { sent: 0, alreadySent: 0, failed: 0 };

  for (const booking of candidates) {
    try {
      const claimed = await db.transaction(async (tx) => {
        if (
          await hasAuditRow(tx, {
            entity: 'bookings',
            entityId: booking.id,
            action: REVIEW_REQUEST_ACTION,
          })
        ) {
          return false;
        }
        await writeAudit(tx, {
          actorType: 'system',
          actorId: null,
          action: REVIEW_REQUEST_ACTION,
          entity: 'bookings',
          entityId: booking.id,
          // Identifiers and the day only — never the guest's email or name.
          data: {
            ref: booking.ref,
            tourDate: manilaCivilDate(booking.tourDate),
            sweptAt: now.toISOString(),
          },
        });
        return true;
      });

      if (!claimed) {
        result.alreadySent += 1;
        continue;
      }

      await notify('review_request', {
        to: booking.leadEmail,
        ref: booking.ref,
        tourTitle: booking.tourTitle,
        // `manilaCivilDate`, never `toISOString().slice(0, 10)`: the column is
        // a DATE read back as UTC midnight, which a raw slice would name as
        // the day before on a UTC+8 box.
        tourDate: manilaCivilDate(booking.tourDate),
        totalCentavos: booking.totalCentavos,
        paidCentavos: booking.paidCentavos,
      });
      result.sent += 1;
    } catch (error) {
      result.failed += 1;
      const kind = error instanceof Error ? error.name : typeof error;
      console.error(`[jobs] review-requests: ${booking.ref} could not be asked (${kind})`);
    }
  }

  return result;
}
