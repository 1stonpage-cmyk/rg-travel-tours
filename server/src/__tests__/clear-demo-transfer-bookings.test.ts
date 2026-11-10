/**
 * Owner decision 2026-11-10 (transfer-photos task, "fix both unrelated
 * failures now"): `clear-demo-transfer-bookings.ts` gained a fail-closed,
 * narrowly-scoped third guard on top of its existing two
 * (`ALLOW_DEMO_SEED=1`, never `NODE_ENV=production`) — it now refuses the
 * WHOLE run, deleting nothing, if any booking it has matched by one of the
 * five fixed demo identifiers also carries a payment that was not created
 * by the demo seed itself. See that file's own module doc comment for the
 * full reasoning; this file pins each refusal path and proves each one can
 * actually fire.
 *
 * Fixtures are a plain 'tour' booking (never a real transfer) — this
 * script only ever matches by `leadEmail`, so the product type is
 * irrelevant to what it is being tested against here, and a tour fixture
 * avoids pulling in the demo-only transfer-route/vehicle-type catalog that
 * does not exist in `rg_travel_test`. Built and torn down per test, the
 * same discipline `admin-cash-verify.test.ts` uses, since `audit_log` is
 * append-only and nothing here counts rows outside what each test itself
 * created.
 */
import { afterEach, beforeEach, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { PriceSnapshot } from '@rg/shared';
import { getDb, getPool } from '../db/client';
import { auditLog, bookings, destinations, inquiries, payments, tours } from '../db/schema';
import { clearDemoTransferBookings } from '../db/clear-demo-transfer-bookings';
import { env } from '../env';
import { generateBookingRef } from '../services/booking-ref';
import { SEED_DEMO_TRANSFER_BOOKINGS, SEED_DEMO_TRIP_REQUEST } from '../db/seed-data';
import { describeWithDb } from './helpers/db';

const unique = () => `${Math.floor(Math.random() * 1e9)}_${Date.now()}`;

const TOTAL = 400_000;
const DEPOSIT = 120_000;
const TOUR_DATE = '2099-07-04';

/** The minimum snapshot `bookings.price_snapshot` will accept. No test reads it. */
const SNAPSHOT: PriceSnapshot = {
  tier: { tierId: 1, minPax: 1, maxPax: 12, pricePerPersonCentavos: TOTAL / 4 },
  addons: [],
  coupon: null,
  depositPercent: 30,
  freeCancelHours: 48,
  subtotalCentavos: TOTAL,
  discountCentavos: 0,
  totalCentavos: TOTAL,
};

/** One of the five fixed identifiers the script matches on — never dev-only data in `rg_travel_test`. */
const DEMO_EMAIL = SEED_DEMO_TRANSFER_BOOKINGS[0]!.leadEmail;
const OTHER_DEMO_EMAIL = SEED_DEMO_TRANSFER_BOOKINGS[1]!.leadEmail;

const created = {
  bookingIds: [] as number[],
  tourIds: [] as number[],
  destIds: [] as number[],
  inquiryIds: [] as number[],
};

async function makeTour(): Promise<number> {
  const slug = `__cleardemo__${unique()}`;
  const [destination] = await getDb().insert(destinations).values({ name: slug, slug });
  created.destIds.push(destination.insertId);
  const [tour] = await getDb()
    .insert(tours)
    .values({
      slug,
      title: `Clear Demo Fixture Tour ${slug}`,
      destinationId: destination.insertId,
      isActive: true,
    });
  created.tourIds.push(tour.insertId);
  return tour.insertId;
}

async function makeBooking(tourId: number, leadEmail: string): Promise<number> {
  const [booking] = await getDb()
    .insert(bookings)
    .values({
      ref: generateBookingRef(),
      tourId,
      tourDate: new Date(`${TOUR_DATE}T00:00:00Z`),
      pax: 2,
      leadName: 'Clear Demo Fixture',
      leadEmail,
      leadPhone: '09170000099',
      status: 'confirmed',
      payMode: 'deposit',
      priceSnapshot: SNAPSHOT,
      subtotalCentavos: TOTAL,
      totalCentavos: TOTAL,
      amountPaidCentavos: DEPOSIT,
      paymentReviewRequired: false,
      holdExpiresAt: null,
      vanId: null,
      driverId: null,
    });
  created.bookingIds.push(booking.insertId);
  return booking.insertId;
}

/** A `payments` row, with an `audit_log` row recording who the seed/service says created it. */
async function makePayment(
  bookingId: number,
  actorType: 'system' | 'user' | 'provider',
): Promise<number> {
  const [payment] = await getDb().insert(payments).values({
    bookingId,
    type: 'payment',
    provider: 'manual',
    method: 'gcash',
    amountCentavos: DEPOSIT,
    status: 'paid',
  });
  await getDb().insert(auditLog).values({
    actorType,
    actorId: null,
    action: 'payment.recorded',
    entity: 'payments',
    entityId: payment.insertId,
    data: null,
  });
  return payment.insertId;
}

async function bookingExists(bookingId: number): Promise<boolean> {
  const [row] = await getDb()
    .select({ id: bookings.id })
    .from(bookings)
    .where(eq(bookings.id, bookingId));
  return row !== undefined;
}

async function paymentExists(paymentId: number): Promise<boolean> {
  const [row] = await getDb()
    .select({ id: payments.id })
    .from(payments)
    .where(eq(payments.id, paymentId));
  return row !== undefined;
}

beforeEach(async () => {
  // SEED_DEMO_TRIP_REQUEST.email is never left behind by another suite —
  // confirmed, not assumed, because the matching-by-identifier tests below
  // read this count to prove the script touched exactly what it should.
  const [existingInquiry] = await getDb()
    .select({ id: inquiries.id })
    .from(inquiries)
    .where(eq(inquiries.email, SEED_DEMO_TRIP_REQUEST.email));
  expect(
    existingInquiry,
    'a leftover demo trip-request inquiry from another test run',
  ).toBeUndefined();
});

afterEach(async () => {
  const pool = getPool();
  for (const id of created.bookingIds) {
    await pool.query(
      'DELETE FROM audit_log WHERE entity = ? AND entity_id IN (SELECT id FROM payments WHERE booking_id = ?)',
      ['payments', id],
    );
    await pool.query('DELETE FROM payments WHERE booking_id = ?', [id]);
    await pool.query('DELETE FROM audit_log WHERE entity = ? AND entity_id = ?', ['bookings', id]);
    await pool.query('DELETE FROM bookings WHERE id = ?', [id]);
  }
  for (const id of created.tourIds) await pool.query('DELETE FROM tours WHERE id = ?', [id]);
  for (const id of created.destIds) await pool.query('DELETE FROM destinations WHERE id = ?', [id]);
  for (const id of created.inquiryIds) await pool.query('DELETE FROM inquiries WHERE id = ?', [id]);
  created.bookingIds = [];
  created.tourIds = [];
  created.destIds = [];
  created.inquiryIds = [];
});

describeWithDb('clearDemoTransferBookings — fail-closed guards (owner decision 2026-11-10)', () => {
  it('refuses when ALLOW_DEMO_SEED is not exactly "1", before any query', async () => {
    const tourId = await makeTour();
    const bookingId = await makeBooking(tourId, DEMO_EMAIL);

    const original = env.ALLOW_DEMO_SEED;
    (env as { ALLOW_DEMO_SEED?: string }).ALLOW_DEMO_SEED = undefined;
    try {
      const error = await clearDemoTransferBookings('test').catch((e: unknown) => e);
      expect(error, 'resolved instead of refusing with ALLOW_DEMO_SEED unset').toBeInstanceOf(
        Error,
      );
      expect((error as Error).message).toMatch(/ALLOW_DEMO_SEED/);
    } finally {
      (env as { ALLOW_DEMO_SEED?: string }).ALLOW_DEMO_SEED = original;
    }

    expect(await bookingExists(bookingId), 'the guard ran a query before refusing').toBe(true);
  }, 30_000);

  it('refuses when NODE_ENV is "production", even with ALLOW_DEMO_SEED=1', async () => {
    const tourId = await makeTour();
    const bookingId = await makeBooking(tourId, DEMO_EMAIL);

    expect(env.ALLOW_DEMO_SEED, 'the test environment must already set ALLOW_DEMO_SEED=1').toBe(
      '1',
    );
    const original = env.NODE_ENV;
    (env as { NODE_ENV?: string }).NODE_ENV = 'production';
    try {
      const error = await clearDemoTransferBookings('test').catch((e: unknown) => e);
      expect(error, 'resolved instead of refusing with NODE_ENV=production').toBeInstanceOf(Error);
      expect((error as Error).message).toMatch(/NODE_ENV/);
      expect((error as Error).message).toMatch(/production/);
    } finally {
      (env as { NODE_ENV?: string }).NODE_ENV = original;
    }

    expect(await bookingExists(bookingId), 'the guard ran a query before refusing').toBe(true);
  }, 30_000);
});

describeWithDb('clearDemoTransferBookings — matches only the five fixed demo identifiers', () => {
  it('leaves a booking with a different lead email alone, even with the same status and date', async () => {
    const tourId = await makeTour();
    const bookingId = await makeBooking(tourId, `not-demo-${unique()}@example.test`);

    await clearDemoTransferBookings('test');

    expect(
      await bookingExists(bookingId),
      'a non-demo-email booking was deleted — matching must never fall back to date/status',
    ).toBe(true);
  }, 30_000);

  it('deletes a booking matching a fixed demo email with no payments, and the demo trip-request inquiry', async () => {
    const tourId = await makeTour();
    const bookingId = await makeBooking(tourId, DEMO_EMAIL);

    const [inquiry] = await getDb().insert(inquiries).values({
      type: 'transfer_custom',
      name: SEED_DEMO_TRIP_REQUEST.name,
      email: SEED_DEMO_TRIP_REQUEST.email,
      phone: SEED_DEMO_TRIP_REQUEST.phone,
      message: SEED_DEMO_TRIP_REQUEST.message,
      status: 'new',
      requestedDate: TOUR_DATE,
    });
    created.inquiryIds.push(inquiry.insertId);

    await clearDemoTransferBookings('test');

    expect(await bookingExists(bookingId)).toBe(false);
    const [afterInquiry] = await getDb()
      .select({ id: inquiries.id })
      .from(inquiries)
      .where(eq(inquiries.email, SEED_DEMO_TRIP_REQUEST.email));
    expect(afterInquiry).toBeUndefined();
  }, 30_000);
});

describeWithDb(
  'clearDemoTransferBookings — refuses if a matched booking has a non-demo payment',
  () => {
    it('deletes a demo booking whose payment audit trail is the seed’s own ("system")', async () => {
      const tourId = await makeTour();
      const bookingId = await makeBooking(tourId, DEMO_EMAIL);
      await makePayment(bookingId, 'system');

      await clearDemoTransferBookings('test');

      expect(await bookingExists(bookingId)).toBe(false);
    }, 30_000);

    it('refuses the whole run, deleting nothing, when a matched booking has a payment recorded by an admin ("user")', async () => {
      const tourId = await makeTour();
      const demoOnlyBookingId = await makeBooking(tourId, OTHER_DEMO_EMAIL);
      const taintedBookingId = await makeBooking(tourId, DEMO_EMAIL);
      const taintedPaymentId = await makePayment(taintedBookingId, 'user');

      const error = await clearDemoTransferBookings('test').catch((e: unknown) => e);
      expect(
        error,
        'resolved instead of refusing a booking with a non-demo-seed payment',
      ).toBeInstanceOf(Error);
      expect((error as Error).message).toMatch(new RegExp(DEMO_EMAIL.replace('.', '\\.')));

      // Nothing was deleted — not even the OTHER, genuinely clean demo
      // booking the same run also matched. One bad booking refuses the
      // entire transaction, by design.
      expect(await bookingExists(taintedBookingId), 'the tainted booking was deleted anyway').toBe(
        true,
      );
      expect(await paymentExists(taintedPaymentId), 'the non-demo payment was deleted anyway').toBe(
        true,
      );
      expect(
        await bookingExists(demoOnlyBookingId),
        'a clean demo booking in the SAME run was deleted despite the refusal',
      ).toBe(true);
    }, 30_000);

    it('refuses when a matched booking has a payment with no audit row at all', async () => {
      const tourId = await makeTour();
      const bookingId = await makeBooking(tourId, DEMO_EMAIL);
      // A payment with no matching `audit_log` row — deliberately not using
      // `makePayment()`, which always writes one.
      const [payment] = await getDb().insert(payments).values({
        bookingId,
        type: 'payment',
        provider: 'manual',
        method: 'gcash',
        amountCentavos: DEPOSIT,
        status: 'paid',
      });

      const error = await clearDemoTransferBookings('test').catch((e: unknown) => e);
      expect(error, 'resolved instead of refusing a payment with no audit trail').toBeInstanceOf(
        Error,
      );

      expect(await bookingExists(bookingId)).toBe(true);
      expect(await paymentExists(payment.insertId)).toBe(true);
    }, 30_000);
  },
);
