/**
 * Week 7, Task 14 (7E): the day-before reminder sweep.
 *
 * §11's "day-before reminder", sent at 16:00 Manila for every trip departing
 * the next Manila day. Three things are being pinned here, and only the first
 * is about email:
 *
 *  1. **The window is TOMORROW IN MANILA**, not tomorrow in UTC. The two are
 *     different dates for eight hours out of every twenty-four, so the
 *     boundary test below stands on 15:59 and 16:00 UTC and asserts the sweep
 *     picks a different day either side.
 *  2. **It sends at most once per booking**, and the record that it fired is
 *     an `audit_log` row (`trip.reminder_sent`) read back by the sweep — there
 *     is no new table and no new column (brief: "No new table").
 *  3. **Which bookings count as real**: `confirmed` and `assigned` only. A
 *     cancelled, expired or still-unpaid booking gets nothing.
 *
 * `now` is a PARAMETER, exactly as `expireHolds()` and `checkOrphanedVans()`
 * take it, so nothing here fakes a global timer and this file never imports
 * `jobs/index.ts` (which would start a scheduler).
 *
 * **No test here touches a real mail server.** `setTransportForTests` is the
 * only transport, as `notify.test.ts` established.
 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { type BookingStatus, type PriceSnapshot } from '@rg/shared';
import { getDb, getPool } from '../db/client';
import { auditLog, bookings, destinations, tours } from '../db/schema';
import { sendTripReminders } from '../jobs/trip-reminders';
import { generateBookingRef } from '../services/booking-ref';
import { resetTransportForTests, setTransportForTests } from '../services/notify';
import { describeWithDb } from './helpers/db';

/**
 * Far enough out that no seed row and no other suite's fixture owns the day,
 * the same discipline `dispatch-assign.test.ts` uses with its own 2099 date.
 */
const TOMORROW = '2099-11-21';
const TODAY = '2099-11-20';
const DAY_AFTER = '2099-11-22';

/** 16:00 Manila on `TODAY` — the hour the job is registered to run. */
const NOW = new Date('2099-11-20T08:00:00Z');

const unique = () => `${Math.floor(Math.random() * 1e9)}_${Date.now()}`;

const created = { bookingIds: [] as number[], tourIds: [] as number[], destIds: [] as number[] };

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

async function makeBooking(
  opts: { status?: BookingStatus; tourDate?: string; paidCentavos?: number } = {},
) {
  const ref = generateBookingRef();
  const [row] = await getDb()
    .insert(bookings)
    .values({
      ref,
      tourId,
      tourDate: new Date(`${opts.tourDate ?? TOMORROW}T00:00:00Z`),
      pax: 2,
      leadName: 'Reminder Fixture Guest',
      leadEmail: `reminder_${unique()}@example.test`,
      leadPhone: '09170000000',
      status: opts.status ?? 'confirmed',
      payMode: 'deposit',
      priceSnapshot: SNAPSHOT,
      subtotalCentavos: 400000,
      totalCentavos: 400000,
      amountPaidCentavos: opts.paidCentavos ?? 120000,
    });
  created.bookingIds.push(row.insertId);
  return { id: row.insertId, ref };
}

/** How many reminder emails went to one booking, by its ref. */
const sentFor = (ref: string) => sent.filter((mail) => mail.subject.includes(ref));

async function reminderAuditRows(bookingId: number) {
  return getDb()
    .select({ action: auditLog.action, actorType: auditLog.actorType, actorId: auditLog.actorId })
    .from(auditLog)
    .where(eq(auditLog.entityId, bookingId));
}

describeWithDb('the day-before trip reminder', () => {
  beforeEach(async () => {
    const db = getDb();
    /*
     * The sweep counts EVERY booking departing tomorrow, so a row left behind
     * on one of these three days by another suite would change this file's
     * exact counts. Asserting the days are empty is what makes `sent: 1` mean
     * "it sent for my booking" rather than "it sent for somebody's".
     */
    for (const day of [TODAY, TOMORROW, DAY_AFTER]) {
      expect(
        await count(sql`SELECT COUNT(*) n FROM bookings WHERE tour_date = ${day}`),
        `leftover bookings on ${day}`,
      ).toBe(0);
    }

    const slug = `__reminder__${unique()}`;
    const [destination] = await db.insert(destinations).values({ name: slug, slug });
    created.destIds.push(destination.insertId);
    const [tour] = await db
      .insert(tours)
      .values({ slug, title: `Reminder Tour ${slug}`, destinationId: destination.insertId });
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

  it('emails the guest whose tour is tomorrow in Manila', async () => {
    const booking = await makeBooking({ status: 'confirmed' });

    expect(await sendTripReminders(NOW)).toMatchObject({ sent: 1, alreadySent: 0, failed: 0 });

    const mails = sentFor(booking.ref);
    expect(mails).toHaveLength(1);
    expect(mails[0]!.subject).toContain('tomorrow');
    // The sign-in screen with the ref prefilled — never My Booking, which
    // cannot read a ref (see the template's own note).
    expect(mails[0]!.html).toContain(`/portal/login?ref=${booking.ref}`);
  });

  /**
   * **The idempotency test.** Two runs on the same afternoon — a restart, a
   * manual re-run, a `noOverlap` tick that was skipped and retried — must
   * produce ONE email and ONE audit row.
   */
  it('does not send twice when the sweep runs twice', async () => {
    const booking = await makeBooking();

    expect(await sendTripReminders(NOW)).toMatchObject({ sent: 1, alreadySent: 0 });
    expect(await sendTripReminders(NOW)).toMatchObject({ sent: 0, alreadySent: 1 });

    expect(sentFor(booking.ref)).toHaveLength(1);
    const rows = await reminderAuditRows(booking.id);
    expect(rows.filter((r) => r.action === 'trip.reminder_sent')).toHaveLength(1);
  });

  /**
   * And it is the AUDIT ROW doing it, not the clock or the status. Deleting
   * the row and re-running sends again — which is what stops the test above
   * from passing for the wrong reason (a window that had quietly moved, or a
   * sweep that had stopped finding the booking at all).
   */
  it('is the audit row that stops the second send, and nothing else', async () => {
    const booking = await makeBooking();
    await sendTripReminders(NOW);
    expect(await sendTripReminders(NOW)).toMatchObject({ sent: 0, alreadySent: 1 });

    await getPool().query(
      "DELETE FROM audit_log WHERE entity = 'bookings' AND entity_id = ? AND action = 'trip.reminder_sent'",
      [booking.id],
    );

    expect(await sendTripReminders(NOW)).toMatchObject({ sent: 1, alreadySent: 0 });
    expect(sentFor(booking.ref)).toHaveLength(2);
  });

  it('records the send as a system audit row with no actor', async () => {
    const booking = await makeBooking();
    await sendTripReminders(NOW);

    const row = (await reminderAuditRows(booking.id)).find(
      (r) => r.action === 'trip.reminder_sent',
    );
    // A cron is not a person and not a gateway.
    expect(row).toMatchObject({ actorType: 'system', actorId: null });
  });

  it('sends nothing for a cancelled booking', async () => {
    const booking = await makeBooking({ status: 'cancelled' });
    expect(await sendTripReminders(NOW)).toMatchObject({ sent: 0 });
    expect(sentFor(booking.ref)).toHaveLength(0);
  });

  /**
   * The full refusal set, in one table. `pending_payment` and
   * `pending_verification` are deliberate: a reminder is a promise the trip
   * is happening, and neither of those bookings is confirmed yet.
   */
  it('reminds confirmed and assigned bookings, and no other status', async () => {
    const reminded: BookingStatus[] = ['confirmed', 'assigned'];
    const ignored: BookingStatus[] = [
      'pending_payment',
      'pending_verification',
      'in_progress',
      'completed',
      'cancelled',
      'expired',
    ];

    for (const status of ignored) {
      const booking = await makeBooking({ status });
      await sendTripReminders(NOW);
      expect(sentFor(booking.ref), `${status} was reminded`).toHaveLength(0);
      await getPool().query('DELETE FROM bookings WHERE id = ?', [booking.id]);
    }
    for (const status of reminded) {
      const booking = await makeBooking({ status });
      await sendTripReminders(NOW);
      expect(sentFor(booking.ref), `${status} was not reminded`).toHaveLength(1);
      await getPool().query("DELETE FROM audit_log WHERE entity = 'bookings' AND entity_id = ?", [
        booking.id,
      ]);
      await getPool().query('DELETE FROM bookings WHERE id = ?', [booking.id]);
    }
  });

  it('ignores a tour today and a tour the day after tomorrow', async () => {
    const today = await makeBooking({ tourDate: TODAY });
    const later = await makeBooking({ tourDate: DAY_AFTER });

    expect(await sendTripReminders(NOW)).toMatchObject({ sent: 0 });
    expect(sentFor(today.ref)).toHaveLength(0);
    expect(sentFor(later.ref)).toHaveLength(0);
  });

  /**
   * **The Manila boundary.** 15:59Z is 23:59 on the 20th in Manila, so
   * "tomorrow" is the 21st. One minute later it is 00:00 on the 21st, and
   * "tomorrow" is the 22nd. A sweep that read the UTC date would send the same
   * email on both sides of that minute, which is how a guest gets reminded of
   * a trip two days out and nothing the night before.
   */
  it('reads tomorrow in Manila, not in UTC', async () => {
    const booking = await makeBooking({ tourDate: TOMORROW });

    expect(await sendTripReminders(new Date('2099-11-20T16:00:00Z'))).toMatchObject({ sent: 0 });
    expect(sentFor(booking.ref)).toHaveLength(0);

    expect(await sendTripReminders(new Date('2099-11-20T15:59:00Z'))).toMatchObject({ sent: 1 });
    expect(sentFor(booking.ref)).toHaveLength(1);
  });

  /**
   * §11: a mail failure is logged and never blocks anything. And the
   * consequence of claiming BEFORE sending is stated here rather than left to
   * be discovered: the audit row stands, so the guest is not re-mailed
   * tomorrow. At-most-once is the deliberate choice — a duplicate reminder is
   * worse than a missing one.
   */
  it('does not throw when the transport fails, and does not retry the booking', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const booking = await makeBooking();
    setTransportForTests({
      sendMail: async () => {
        throw new Error('smtp unreachable');
      },
    });

    await expect(sendTripReminders(NOW)).resolves.toMatchObject({ sent: 1, failed: 0 });

    const rows = await reminderAuditRows(booking.id);
    expect(rows.filter((r) => r.action === 'trip.reminder_sent')).toHaveLength(1);
  });

  it('reports zero on a quiet day', async () => {
    expect(await sendTripReminders(NOW)).toEqual({ sent: 0, alreadySent: 0, failed: 0 });
    expect(sent).toHaveLength(0);
  });
});
