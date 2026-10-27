/**
 * Week 7, Task 14 (7E): the review-request sweep (owner decision 2026-10-23,
 * Q5 — "automatic, one per booking ever, sent the morning after completion").
 *
 * The invariant with teeth is **"at most once ever"**, and the test that
 * proves it has to be written carefully, because it is the one most likely to
 * pass for the wrong reason. Two things make it honest here:
 *
 *  1. The sweep's window is a LOOKBACK (the last `REVIEW_LOOKBACK_DAYS` of
 *     tour days, ending yesterday), not a single day — so a booking that was
 *     mailed on Monday is still INSIDE the window on Tuesday and Wednesday.
 *     Running the sweep on three consecutive mornings therefore really does
 *     re-offer the booking to it three times, and only the `review.requested`
 *     audit row stops the second and third send. With a one-day window the
 *     same test would pass because the booking had simply fallen out of range,
 *     proving nothing.
 *  2. The third morning then DELETES the audit row and runs again. It sends.
 *     That is the positive control: it shows the booking was still a candidate
 *     all along, so the two silent mornings were the audit row's doing.
 *
 * Also pinned: no email for a `cancelled` booking, and none for a booking
 * carrying a `refund` payment row in ANY payment status — the conservative
 * reading, because asking a guest to review a trip we are refunding is worse
 * than staying quiet.
 *
 * `now` is a parameter; this file never imports `jobs/index.ts`; no test
 * touches a real mail server.
 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { type BookingStatus, type PriceSnapshot } from '@rg/shared';
import { getDb, getPool } from '../db/client';
import { auditLog, bookings, destinations, payments, tours } from '../db/schema';
import { REVIEW_LOOKBACK_DAYS, sendReviewRequests } from '../jobs/review-requests';
import { generateBookingRef } from '../services/booking-ref';
import { resetTransportForTests, setTransportForTests } from '../services/notify';
import { describeWithDb } from './helpers/db';

/** 07:00 Manila on 2099-12-02 — the hour the job is registered to run. */
const NOW = new Date('2099-12-01T23:00:00Z');
const TODAY = '2099-12-02';
const YESTERDAY = '2099-12-01';
/** The oldest day the lookback still covers, and the first it does not. */
const OLDEST_INSIDE = '2099-11-25';
const JUST_OUTSIDE = '2099-11-24';

const unique = () => `${Math.floor(Math.random() * 1e9)}_${Date.now()}`;

const created = {
  bookingIds: [] as number[],
  tourIds: [] as number[],
  destIds: [] as number[],
};

interface SentMail {
  to: string;
  subject: string;
  html: string;
  text: string;
}
const sent: SentMail[] = [];

const SNAPSHOT: PriceSnapshot = {
  tier: { tierId: 1, minPax: 1, maxPax: 12, pricePerPersonCentavos: 100000 },
  addons: [],
  coupon: null,
  depositPercent: 30,
  freeCancelHours: 48,
  subtotalCentavos: 400000,
  discountCentavos: 0,
  totalCentavos: 400000,
};

let tourId = 0;

async function count(statement: Parameters<ReturnType<typeof getDb>['execute']>[0]) {
  const [rows] = (await getDb().execute(statement)) as unknown as [Array<{ n: number }>, unknown];
  return Number(rows[0]?.n ?? -1);
}

async function makeBooking(opts: { status?: BookingStatus; tourDate?: string } = {}) {
  const ref = generateBookingRef();
  const [row] = await getDb()
    .insert(bookings)
    .values({
      ref,
      tourId,
      tourDate: new Date(`${opts.tourDate ?? YESTERDAY}T00:00:00Z`),
      pax: 2,
      leadName: 'Review Request Fixture Guest',
      leadEmail: `review_${unique()}@example.test`,
      leadPhone: '09170000000',
      status: opts.status ?? 'completed',
      payMode: 'full',
      priceSnapshot: SNAPSHOT,
      subtotalCentavos: 400000,
      totalCentavos: 400000,
      amountPaidCentavos: 400000,
      completedAt: new Date(`${opts.tourDate ?? YESTERDAY}T10:00:00Z`),
    });
  created.bookingIds.push(row.insertId);
  return { id: row.insertId, ref };
}

async function addRefundRow(bookingId: number, status: 'pending' | 'paid' | 'rejected') {
  await getDb().insert(payments).values({
    bookingId,
    type: 'refund',
    provider: 'manual',
    method: 'bank_transfer',
    amountCentavos: 100000,
    status,
  });
}

const sentFor = (ref: string) => sent.filter((mail) => mail.subject.includes(ref));

async function requestAuditRows(bookingId: number) {
  return getDb()
    .select({ action: auditLog.action, actorType: auditLog.actorType, actorId: auditLog.actorId })
    .from(auditLog)
    .where(eq(auditLog.entityId, bookingId));
}

/** `now`, moved on by whole days — the "consecutive mornings" clock. */
const morningsLater = (days: number) => new Date(NOW.getTime() + days * 86_400_000);

describeWithDb('the review-request sweep', () => {
  beforeEach(async () => {
    const db = getDb();
    /*
     * The sweep counts every completed booking in its whole lookback window,
     * so a leftover row anywhere near these dates would change this file's
     * exact counts. Guard the range, not just one day.
     */
    expect(
      await count(
        sql`SELECT COUNT(*) n FROM bookings WHERE tour_date BETWEEN '2099-11-20' AND '2099-12-10'`,
      ),
      'leftover bookings in this suite’s date range',
    ).toBe(0);

    const slug = `__reviewreq__${unique()}`;
    const [destination] = await db.insert(destinations).values({ name: slug, slug });
    created.destIds.push(destination.insertId);
    const [tour] = await db
      .insert(tours)
      .values({ slug, title: `Review Request Tour ${slug}`, destinationId: destination.insertId });
    created.tourIds.push(tour.insertId);
    tourId = tour.insertId;

    sent.length = 0;
    setTransportForTests({
      sendMail: async (message) => {
        sent.push(message as unknown as SentMail);
        return { messageId: 'mock' };
      },
    });
  }, 30_000);

  afterEach(async () => {
    resetTransportForTests();
    vi.restoreAllMocks();
    const pool = getPool();
    for (const id of created.bookingIds) {
      await pool.query('DELETE FROM payments WHERE booking_id = ?', [id]);
      await pool.query("DELETE FROM audit_log WHERE entity = 'bookings' AND entity_id = ?", [id]);
      await pool.query('DELETE FROM bookings WHERE id = ?', [id]);
    }
    for (const id of created.tourIds) {
      await pool.query('DELETE FROM tour_date_slots WHERE tour_id = ?', [id]);
      await pool.query('DELETE FROM tours WHERE id = ?', [id]);
    }
    for (const id of created.destIds) {
      await pool.query('DELETE FROM destinations WHERE id = ?', [id]);
    }
    created.bookingIds = [];
    created.tourIds = [];
    created.destIds = [];
  });

  it('asks the guest of yesterday’s completed trip for a review', async () => {
    const booking = await makeBooking();

    expect(await sendReviewRequests(NOW)).toMatchObject({ sent: 1, alreadySent: 0, failed: 0 });

    const mails = sentFor(booking.ref);
    expect(mails).toHaveLength(1);
    // The sign-in screen with the ref prefilled: the guest still proves
    // ref + email (Q5), and the review form lives behind it in My Booking.
    expect(mails[0]!.html).toContain(`/portal/login?ref=${booking.ref}`);
  });

  /**
   * **"At most once ever."** Three consecutive mornings, one email — and the
   * booking is still inside the lookback window on every one of them, which is
   * what makes the second and third mornings a real test of the audit row
   * rather than of the window having moved.
   */
  it('sends at most once ever, across three consecutive mornings', async () => {
    const booking = await makeBooking();

    expect(await sendReviewRequests(morningsLater(0))).toMatchObject({ sent: 1, alreadySent: 0 });
    expect(await sendReviewRequests(morningsLater(1))).toMatchObject({ sent: 0, alreadySent: 1 });
    expect(await sendReviewRequests(morningsLater(2))).toMatchObject({ sent: 0, alreadySent: 1 });

    expect(sentFor(booking.ref)).toHaveLength(1);
    const rows = await requestAuditRows(booking.id);
    expect(rows.filter((r) => r.action === 'review.requested')).toHaveLength(1);

    /*
     * THE POSITIVE CONTROL. `alreadySent: 1` above already proves the sweep
     * still SAW the booking on mornings two and three — but delete the audit
     * row on the third morning and it mails again, which proves the silence
     * was the row's doing and not a window that had quietly moved on.
     */
    await getPool().query(
      "DELETE FROM audit_log WHERE entity = 'bookings' AND entity_id = ? AND action = 'review.requested'",
      [booking.id],
    );
    expect(await sendReviewRequests(morningsLater(2))).toMatchObject({ sent: 1, alreadySent: 0 });
    expect(sentFor(booking.ref)).toHaveLength(2);
  });

  it('records the send as a system audit row with no actor', async () => {
    const booking = await makeBooking();
    await sendReviewRequests(NOW);

    const row = (await requestAuditRows(booking.id)).find((r) => r.action === 'review.requested');
    expect(row).toMatchObject({ actorType: 'system', actorId: null });
  });

  it('sends nothing for a cancelled booking', async () => {
    const booking = await makeBooking({ status: 'cancelled' });
    expect(await sendReviewRequests(NOW)).toMatchObject({ sent: 0 });
    expect(sentFor(booking.ref)).toHaveLength(0);
  });

  /**
   * ANY refund row disqualifies, whatever its `payments.status`. The brief
   * names no status filter, and the conservative reading is the right one: a
   * refund that is merely pending still means a guest we are in the middle of
   * making whole, and "how was your trip?" is the wrong email to send them.
   */
  it('sends nothing for a booking carrying a refund row, in any payment status', async () => {
    for (const status of ['pending', 'paid', 'rejected'] as const) {
      const booking = await makeBooking();
      await addRefundRow(booking.id, status);

      expect(await sendReviewRequests(NOW), `refund status ${status}`).toMatchObject({ sent: 0 });
      expect(sentFor(booking.ref), `refund status ${status} was mailed`).toHaveLength(0);

      await getPool().query('DELETE FROM payments WHERE booking_id = ?', [booking.id]);
      await getPool().query('DELETE FROM bookings WHERE id = ?', [booking.id]);
    }
  });

  /**
   * The guard against the previous test passing vacuously: an ordinary
   * `payment` row must NOT disqualify a booking. Every completed booking has
   * one, so a filter written on `payments` existence rather than on
   * `type = 'refund'` would silence the whole job and the test above would
   * still be green.
   */
  it('still asks a booking whose only payment row is a payment', async () => {
    const booking = await makeBooking();
    await getDb().insert(payments).values({
      bookingId: booking.id,
      type: 'payment',
      provider: 'manual',
      method: 'bank_transfer',
      amountCentavos: 400000,
      status: 'paid',
    });

    expect(await sendReviewRequests(NOW)).toMatchObject({ sent: 1 });
    expect(sentFor(booking.ref)).toHaveLength(1);
  });

  it('sends only for completed bookings', async () => {
    const ignored: BookingStatus[] = [
      'pending_payment',
      'pending_verification',
      'confirmed',
      'assigned',
      'in_progress',
      'cancelled',
      'expired',
    ];
    for (const status of ignored) {
      const booking = await makeBooking({ status });
      await sendReviewRequests(NOW);
      expect(sentFor(booking.ref), `${status} was mailed`).toHaveLength(0);
      await getPool().query('DELETE FROM bookings WHERE id = ?', [booking.id]);
    }
  });

  /**
   * The window's two edges. Today's trip has not finished yet as far as this
   * job is concerned (the sweep runs at 07:00, before the day's departures),
   * and a trip older than the lookback is left alone — otherwise the first run
   * after a long outage would mail a year of guests at once.
   */
  it('ignores today’s trip and a trip older than the lookback', async () => {
    const today = await makeBooking({ tourDate: TODAY });
    const old = await makeBooking({ tourDate: JUST_OUTSIDE });

    expect(await sendReviewRequests(NOW)).toMatchObject({ sent: 0 });
    expect(sentFor(today.ref)).toHaveLength(0);
    expect(sentFor(old.ref)).toHaveLength(0);
  });

  /**
   * And the oldest day the lookback DOES cover still gets mailed — the half of
   * the boundary that fails if the window is off by one, which the test above
   * cannot see.
   */
  it('still asks the oldest trip inside the lookback', async () => {
    expect(REVIEW_LOOKBACK_DAYS).toBeGreaterThan(1);
    const booking = await makeBooking({ tourDate: OLDEST_INSIDE });

    expect(await sendReviewRequests(NOW)).toMatchObject({ sent: 1 });
    expect(sentFor(booking.ref)).toHaveLength(1);
  });

  /**
   * The Manila boundary. 22:59Z on 2099-12-01 is still 2099-12-01 in Manila,
   * so "yesterday" is 2099-11-30 and the booking on 2099-12-01 is TODAY's
   * trip — not yet eligible. One minute later it is 2099-12-02 in Manila and
   * it is.
   */
  it('reads yesterday in Manila, not in UTC', async () => {
    const booking = await makeBooking({ tourDate: YESTERDAY });

    expect(await sendReviewRequests(new Date('2099-12-01T15:59:00Z'))).toMatchObject({ sent: 0 });
    expect(sentFor(booking.ref)).toHaveLength(0);

    expect(await sendReviewRequests(new Date('2099-12-01T16:00:00Z'))).toMatchObject({ sent: 1 });
    expect(sentFor(booking.ref)).toHaveLength(1);
  });

  it('does not throw when the transport fails, and does not retry the booking', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const booking = await makeBooking();
    setTransportForTests({
      sendMail: async () => {
        throw new Error('smtp unreachable');
      },
    });

    await expect(sendReviewRequests(NOW)).resolves.toMatchObject({ sent: 1, failed: 0 });

    const rows = await requestAuditRows(booking.id);
    expect(rows.filter((r) => r.action === 'review.requested')).toHaveLength(1);
  });

  it('reports zero when nothing was completed', async () => {
    expect(await sendReviewRequests(NOW)).toEqual({ sent: 0, alreadySent: 0, failed: 0 });
    expect(sent).toHaveLength(0);
  });
});
