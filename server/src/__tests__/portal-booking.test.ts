/**
 * Week 4 plan, Task 9 — `portal.booking`, the data behind the portal page
 * (BUILD_SPEC §7).
 *
 * The tracker's own table is proved exhaustively in `shared/src/portal.
 * test.ts` over all eight statuses; this file proves the WIRING: that the
 * procedure reads the session's booking and no other, that every number is
 * the server's, that a rejection carries its reason, and that the driver's
 * mobile number is withheld rather than merely unrendered.
 */
import { afterAll, expect, it } from 'vitest';
import { inArray } from 'drizzle-orm';
import { RECEIPT_UPLOAD_MAX_PER_BOOKING, depositCentavos } from '@rg/shared';
import { getDb, getPool } from '../db/client';
import { bookings, destinations, drivers, payments, tours, users, vans } from '../db/schema';
import { appRouter } from '../routers/_app';
import { generateBookingRef } from '../services/booking-ref';
import { hashPassword } from '../services/password';
import { customerContext, staffContext, testContext } from './helpers/ctx';
import { describeWithDb } from './helpers/db';

const TOTAL = 1_000_000;
const DEPOSIT_PERCENT = 30;
const DEPOSIT = depositCentavos(TOTAL, DEPOSIT_PERCENT);
/** Far enough out that the driver card is always inside its window. */
const TOUR_DATE = new Date('2099-12-25T00:00:00Z');

const created = {
  bookingIds: [] as number[],
  tourIds: [] as number[],
  destIds: [] as number[],
  driverIds: [] as number[],
  vanIds: [] as number[],
  userIds: [] as number[],
};

let seq = 0;

async function makeBooking(
  opts: {
    status?: 'pending_payment' | 'pending_verification' | 'confirmed' | 'assigned' | 'completed';
    amountPaidCentavos?: number;
    tourDate?: Date;
    receipts?: Array<'pending' | 'rejected' | 'paid' | 'superseded'>;
    rejectReason?: string;
    withDriver?: boolean;
    withVan?: boolean;
  } = {},
) {
  const db = getDb();
  seq += 1;
  const slug = `__portal__${seq}_${Math.floor(Math.random() * 1e9)}_${Date.now()}`;
  const [dest] = await db.insert(destinations).values({ name: slug, slug });
  created.destIds.push(dest.insertId);
  const [tour] = await db
    .insert(tours)
    .values({ slug, title: `Tour ${slug}`, destinationId: dest.insertId });
  created.tourIds.push(tour.insertId);

  let driverId: number | null = null;
  if (opts.withDriver) {
    const [driver] = await db.insert(drivers).values({
      name: 'Mang Pedro',
      code: `D${seq}${Math.floor(Math.random() * 1e6)}`,
      phone: '09170001234',
      pinHash: await hashPassword(`${seq}-pin-not-a-real-pin`),
    });
    driverId = driver.insertId;
    created.driverIds.push(driver.insertId);
  }

  let vanId: number | null = null;
  if (opts.withVan) {
    const [van] = await db.insert(vans).values({
      plate: `ABC${seq}${Math.floor(Math.random() * 1e4)}`,
      model: 'Toyota Hiace Commuter',
      capacity: 12,
    });
    vanId = van.insertId;
    created.vanIds.push(van.insertId);
  }

  const ref = generateBookingRef();
  const [booking] = await db.insert(bookings).values({
    ref,
    tourId: tour.insertId,
    tourDate: opts.tourDate ?? TOUR_DATE,
    pax: 4,
    leadName: 'Maria Santos',
    leadEmail: `portal_${slug}@example.test`,
    leadPhone: '09170000000',
    status: opts.status ?? 'pending_payment',
    payMode: 'deposit',
    priceSnapshot: {
      tier: { tierId: 1, minPax: 1, maxPax: 12, pricePerPersonCentavos: TOTAL / 4 },
      addons: [],
      coupon: null,
      depositPercent: DEPOSIT_PERCENT,
      freeCancelHours: 48,
      subtotalCentavos: TOTAL,
      discountCentavos: 0,
      totalCentavos: TOTAL,
    },
    subtotalCentavos: TOTAL,
    totalCentavos: TOTAL,
    amountPaidCentavos: opts.amountPaidCentavos ?? 0,
    holdExpiresAt: new Date('2099-12-24T00:00:00Z'),
    driverId,
    vanId,
  });
  created.bookingIds.push(booking.insertId);

  for (const [index, status] of (opts.receipts ?? []).entries()) {
    await db.insert(payments).values({
      bookingId: booking.insertId,
      type: 'payment',
      provider: 'manual',
      method: 'gcash',
      amountCentavos: DEPOSIT,
      status,
      txnRef: `GC${seq}${index}`,
      receiptPath: `${(seq * 10 + index).toString(16).padStart(32, 'b')}.jpg`,
      rejectReason: status === 'rejected' ? (opts.rejectReason ?? 'Blurry screenshot.') : null,
    });
  }

  return { bookingId: booking.insertId, ref, tourTitle: `Tour ${slug}` };
}

async function makeStaff() {
  const unique = `${Math.floor(Math.random() * 1e9)}_${Date.now()}`;
  const [row] = await getDb()
    .insert(users)
    .values({
      name: `Portal Staff ${unique}`,
      email: `portal_staff_${unique}@example.test`,
      passwordHash: '__portal_fixture_not_a_hash__',
      role: 'owner',
      isActive: true,
    });
  created.userIds.push(row.insertId);
  return row.insertId;
}

const callerFor = (bookingId: number) =>
  appRouter.createCaller(customerContext(bookingId) as never);

afterAll(async () => {
  const pool = getPool();
  for (const id of created.bookingIds) {
    // Raw SQL for bookings and payments, per `schema-conventions.test.ts`.
    await pool.query('DELETE FROM payments WHERE booking_id = ?', [id]);
    await pool.query('DELETE FROM sessions WHERE subject_type = ? AND subject_id = ?', [
      'customer',
      id,
    ]);
    await pool.query('DELETE FROM bookings WHERE id = ?', [id]);
  }
  if (created.tourIds.length > 0) {
    await getDb().delete(tours).where(inArray(tours.id, created.tourIds));
  }
  if (created.destIds.length > 0) {
    await getDb().delete(destinations).where(inArray(destinations.id, created.destIds));
  }
  if (created.driverIds.length > 0) {
    await getDb().delete(drivers).where(inArray(drivers.id, created.driverIds));
  }
  if (created.vanIds.length > 0) {
    await getDb().delete(vans).where(inArray(vans.id, created.vanIds));
  }
  for (const id of created.userIds) {
    await pool.query('DELETE FROM users WHERE id = ?', [id]);
  }
});

describeWithDb('portal.booking — who may read it', () => {
  it('REFUSES a caller with no session', async () => {
    const api = appRouter.createCaller(testContext() as never);
    await expect(api.portal.booking()).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  });

  it('REFUSES a staff session', async () => {
    const api = appRouter.createCaller(staffContext(await makeStaff(), 'owner') as never);
    await expect(api.portal.booking()).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  });

  it('answers ONLY the booking the session names', async () => {
    const mine = await makeBooking();
    const theirs = await makeBooking();

    const result = await callerFor(mine.bookingId).portal.booking();

    expect(result.ref).toBe(mine.ref);
    expect(result.ref).not.toBe(theirs.ref);
    expect(result.tourTitle).toBe(mine.tourTitle);
  });

  /** No input exists, so an argument naming another booking goes nowhere. */
  it('IGNORES an argument naming another booking', async () => {
    const mine = await makeBooking();
    const theirs = await makeBooking();
    const api = callerFor(mine.bookingId);

    const result = await (
      api.portal.booking as unknown as (input: unknown) => Promise<{ ref: string }>
    )({ ref: theirs.ref, bookingId: theirs.bookingId });

    expect(result.ref, 'an argument reached another booking').toBe(mine.ref);
  });
});

describeWithDb('portal.booking — the money', () => {
  /**
   * §7's "balance due on tour day", and the amount due now. Both from the
   * server; the page formats and never calculates.
   */
  it('publishes the balance and the amount due, computed on the server', async () => {
    const fresh = await makeBooking();
    const unpaid = await callerFor(fresh.bookingId).portal.booking();
    expect(unpaid.totalCentavos).toBe(TOTAL);
    expect(unpaid.paidCentavos).toBe(0);
    expect(unpaid.balanceCentavos).toBe(TOTAL);
    expect(unpaid.amountDueCentavos).toBe(DEPOSIT);

    const partPaid = await makeBooking({ status: 'confirmed', amountPaidCentavos: DEPOSIT });
    const paid = await callerFor(partPaid.bookingId).portal.booking();
    expect(paid.balanceCentavos, 'the balance ignored the deposit already paid').toBe(
      TOTAL - DEPOSIT,
    );
    expect(paid.amountDueCentavos, 'a paid deposit is still being asked for').toBe(0);
  });

  it('never publishes a negative balance', async () => {
    const overpaid = await makeBooking({ status: 'completed', amountPaidCentavos: TOTAL + 50_000 });
    const result = await callerFor(overpaid.bookingId).portal.booking();
    expect(result.balanceCentavos).toBe(0);
    expect(result.amountDueCentavos).toBe(0);
  });
});

describeWithDb('portal.booking — the tracker', () => {
  /** The shared table, reached through the real procedure. */
  it('lights only "Booked" on a fresh unpaid booking', async () => {
    const fresh = await makeBooking();
    const result = await callerFor(fresh.bookingId).portal.booking();

    expect(result.tracker.map((s) => s.step)).toEqual([
      'Booked',
      'Payment sent',
      'Verified by admin',
      'Driver assigned',
      'Tour day',
    ]);
    expect(result.tracker.map((s) => s.done)).toEqual([true, false, false, false, false]);
  });

  it('lights "Payment sent" from an uploaded receipt, before any money', async () => {
    const sent = await makeBooking({ status: 'pending_verification', receipts: ['pending'] });
    const result = await callerFor(sent.bookingId).portal.booking();
    expect(result.tracker.map((s) => s.done)).toEqual([true, true, false, false, false]);
  });

  it('lights "Verified" once money is on the booking', async () => {
    const paid = await makeBooking({
      status: 'confirmed',
      amountPaidCentavos: DEPOSIT,
      receipts: ['paid'],
    });
    const result = await callerFor(paid.bookingId).portal.booking();
    expect(result.tracker.map((s) => s.done)).toEqual([true, true, true, false, false]);
  });

  it('lights every step on a completed tour', async () => {
    const done = await makeBooking({
      status: 'completed',
      amountPaidCentavos: TOTAL,
      receipts: ['paid'],
    });
    const result = await callerFor(done.bookingId).portal.booking();
    expect(result.tracker.map((s) => s.done)).toEqual([true, true, true, true, true]);
  });
});

describeWithDb('portal.booking — a rejected receipt', () => {
  /**
   * §7: "Upload / re-upload receipt (when rejected), with the rejection
   * reason shown." The reason is the admin's own words, and the guest
   * cannot act without it.
   */
  it('publishes the rejection reason from the newest receipt', async () => {
    const rejected = await makeBooking({
      status: 'pending_payment',
      receipts: ['rejected'],
      rejectReason: 'The amount is short by 500 pesos.',
    });

    const result = await callerFor(rejected.bookingId).portal.booking();

    expect(result.receipt?.status).toBe('rejected');
    expect(result.receipt?.rejectReason).toBe('The amount is short by 500 pesos.');
    expect(result.uploadsRemaining).toBe(RECEIPT_UPLOAD_MAX_PER_BOOKING - 1);
  });

  /**
   * The NEWEST receipt is the one the guest is waiting on. After a
   * re-upload the rejected one is history and the page must not keep
   * showing its reason, which would read as a fresh rejection.
   */
  it('reports the newest receipt, not the rejected one behind it', async () => {
    const reuploaded = await makeBooking({
      status: 'pending_verification',
      receipts: ['rejected', 'pending'],
    });

    const result = await callerFor(reuploaded.bookingId).portal.booking();

    expect(result.receipt?.status).toBe('pending');
    expect(result.receipt?.rejectReason, 'a stale rejection reason was still shown').toBeNull();
    expect(result.uploadsRemaining).toBe(RECEIPT_UPLOAD_MAX_PER_BOOKING - 2);
  });

  it('publishes no receipt at all when none has been uploaded', async () => {
    const fresh = await makeBooking();
    const result = await callerFor(fresh.bookingId).portal.booking();
    expect(result.receipt).toBeNull();
    expect(result.uploadsRemaining).toBe(RECEIPT_UPLOAD_MAX_PER_BOOKING);
  });
});

describeWithDb('portal.booking — the driver card', () => {
  it('publishes no driver before the booking is assigned', async () => {
    const confirmed = await makeBooking({
      status: 'confirmed',
      amountPaidCentavos: DEPOSIT,
      withDriver: true,
      withVan: true,
    });
    const result = await callerFor(confirmed.bookingId).portal.booking();
    expect(result.driver, 'a driver was published before assignment').toBeNull();
  });

  it('publishes the driver, phone, van model and plate once assigned', async () => {
    const assigned = await makeBooking({
      status: 'assigned',
      amountPaidCentavos: DEPOSIT,
      withDriver: true,
      withVan: true,
    });

    const result = await callerFor(assigned.bookingId).portal.booking();

    expect(result.driver).toEqual({
      name: 'Mang Pedro',
      phone: '09170001234',
      vanModel: 'Toyota Hiace Commuter',
      vanPlate: expect.stringMatching(/^ABC/),
    });
  });

  it('publishes the driver with no van yet, rather than nothing', async () => {
    const assigned = await makeBooking({
      status: 'assigned',
      amountPaidCentavos: DEPOSIT,
      withDriver: true,
    });
    const result = await callerFor(assigned.bookingId).portal.booking();
    expect(result.driver).toMatchObject({ name: 'Mang Pedro', vanModel: null, vanPlate: null });
  });

  /**
   * **The driver's mobile number is WITHHELD, not hidden.** §7 says the
   * card is visible "until tour day ends" (owner question Q9 — the
   * developer's proposal is the end of the Manila tour day). A page that
   * sent the number and declined to render it would still be serving a
   * driver's personal data to anyone reading the network tab, years later.
   */
  it('stops publishing the driver after the tour day', async () => {
    const past = await makeBooking({
      status: 'completed',
      amountPaidCentavos: TOTAL,
      withDriver: true,
      withVan: true,
      tourDate: new Date('2020-01-15T00:00:00Z'),
    });

    const result = await callerFor(past.bookingId).portal.booking();

    expect(result.driver, 'a driver phone number was still being served').toBeNull();
    expect(JSON.stringify(result)).not.toContain('09170001234');
  });
});

describeWithDb('portal.booking — the rest of the page', () => {
  it('publishes the tour date as a civil date and the guests as a count', async () => {
    const mine = await makeBooking();
    const result = await callerFor(mine.bookingId).portal.booking();
    expect(result.tourDate).toBe('2099-12-25');
    expect(result.pax).toBe(4);
    expect(result.leadName).toBe('Maria Santos');
  });

  /** §7: the review form appears after `completed`, and only then. */
  it('allows a review only once the tour is completed', async () => {
    const mid = await makeBooking({ status: 'assigned', amountPaidCentavos: DEPOSIT });
    expect((await callerFor(mid.bookingId).portal.booking()).canReview).toBe(false);

    const done = await makeBooking({ status: 'completed', amountPaidCentavos: TOTAL });
    expect((await callerFor(done.bookingId).portal.booking()).canReview).toBe(true);
  });

  /** The page needs the status itself to say "cancelled" in words. */
  it('publishes the booking status', async () => {
    const mine = await makeBooking({ status: 'pending_verification', receipts: ['pending'] });
    expect((await callerFor(mine.bookingId).portal.booking()).status).toBe('pending_verification');
  });

  /**
   * Nothing a guest may not see. Checked as a key list rather than one
   * field at a time, so a column added to the main read has to be thought
   * about rather than published by accident.
   */
  it('publishes no internal columns', async () => {
    const mine = await makeBooking({ withDriver: true, withVan: true, status: 'assigned' });
    const result = await callerFor(mine.bookingId).portal.booking();
    const serialised = JSON.stringify(result);

    expect(Object.keys(result).sort()).toEqual([
      'amountDueCentavos',
      'balanceCentavos',
      'canReview',
      'driver',
      'holdExpiresAt',
      'leadName',
      'paidCentavos',
      'pax',
      'receipt',
      'ref',
      'status',
      'totalCentavos',
      'tourDate',
      'tourTitle',
      'tracker',
      'uploadsRemaining',
    ]);
    // The things a booking row carries that are nobody's business here.
    expect(serialised).not.toContain('priceSnapshot');
    expect(serialised).not.toContain('paymentReviewRequired');
    expect(serialised).not.toContain('receiptPath');
    expect(serialised).not.toContain('leadEmail');
  });
});
