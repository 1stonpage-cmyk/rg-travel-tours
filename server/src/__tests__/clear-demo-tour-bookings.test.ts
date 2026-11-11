/**
 * Task 4 (owner's own label: 1D), Demo Polish Round 2: `clear-demo-tour-
 * bookings.ts` is the sibling to `clear-demo-transfer-bookings.ts` for the
 * seed's two demo TOUR bookings (`RG-SEED23`, `RG-SEED24`, from
 * `SEED_UNASSIGNED_TRIPS` in `server/src/db/seed-data.ts`). Same three
 * fail-closed guards, same order, same "refuses the whole run, not just the
 * tainted row" property — this file mirrors
 * `clear-demo-transfer-bookings.test.ts`'s own pattern exactly, adapted for
 * the simpler case: matched by `bookings.ref` (not `leadEmail`), no
 * `booking_transfer_details` row, no slot-table cleanup.
 *
 * Fixture cleanup deliberately uses raw `pool.query('DELETE FROM ...')`,
 * never `getDb().delete(bookings)` / `.delete(payments)` — `schema-
 * conventions.test.ts`'s hard-delete guard scans ALL server files, tests
 * included, for the Drizzle form, and only narrows to application source
 * for the raw-SQL form. Using `.delete()` here would make this very test
 * file an "offender" of the guard it is meant to help prove safe.
 */
import { afterEach, beforeEach, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { PriceSnapshot } from '@rg/shared';
import { getDb, getPool } from '../db/client';
import { auditLog, bookings, destinations, payments, tours } from '../db/schema';
import { clearDemoTourBookings } from '../db/clear-demo-tour-bookings';
import { env } from '../env';
import { describeWithDb } from './helpers/db';

const unique = () => `${Math.floor(Math.random() * 1e9)}_${Date.now()}`;

const TOTAL = 600_000;
const TOUR_DATE = '2099-08-15';

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

/** The two fixed refs this script matches on — see the seed's own `SEED_UNASSIGNED_TRIPS`. */
const REF_ONE = 'RG-SEED23';
const REF_TWO = 'RG-SEED24';

const created = {
  bookingIds: [] as number[],
  tourIds: [] as number[],
  destIds: [] as number[],
};

async function makeTour(): Promise<number> {
  const slug = `__cleardemotour__${unique()}`;
  const [destination] = await getDb().insert(destinations).values({ name: slug, slug });
  created.destIds.push(destination.insertId);
  const [tour] = await getDb()
    .insert(tours)
    .values({
      slug,
      title: `Clear Demo Tour Fixture ${slug}`,
      destinationId: destination.insertId,
      isActive: true,
    });
  created.tourIds.push(tour.insertId);
  return tour.insertId;
}

async function makeBooking(tourId: number, ref: string): Promise<number> {
  const [booking] = await getDb()
    .insert(bookings)
    .values({
      ref,
      tourId,
      tourDate: new Date(`${TOUR_DATE}T00:00:00Z`),
      pax: 2,
      leadName: 'Clear Demo Tour Fixture',
      leadEmail: `clear-demo-tour-fixture-${unique()}@example.test`,
      leadPhone: '09170000098',
      status: 'confirmed',
      payMode: 'full',
      priceSnapshot: SNAPSHOT,
      subtotalCentavos: TOTAL,
      totalCentavos: TOTAL,
      amountPaidCentavos: 0,
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
    amountCentavos: TOTAL,
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
  // Neither fixed ref is ever left behind by another suite — confirmed, not
  // assumed, because `rg_travel_test` never runs `upsertFleet` (app-context
  // only), and a prior crashed run here would otherwise die on the
  // UNIQUE(ref) constraint instead of a clean assertion.
  for (const ref of [REF_ONE, REF_TWO]) {
    const [existing] = await getDb()
      .select({ id: bookings.id })
      .from(bookings)
      .where(eq(bookings.ref, ref));
    expect(existing, `a leftover demo tour booking (${ref}) from another test run`).toBeUndefined();
  }
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
  created.bookingIds = [];
  created.tourIds = [];
  created.destIds = [];
});

describeWithDb(
  'clearDemoTourBookings — fail-closed guards (mirrors clearDemoTransferBookings)',
  () => {
    it('refuses when ALLOW_DEMO_SEED is not exactly "1", before any query', async () => {
      const tourId = await makeTour();
      const bookingId = await makeBooking(tourId, REF_ONE);

      const original = env.ALLOW_DEMO_SEED;
      (env as { ALLOW_DEMO_SEED?: string }).ALLOW_DEMO_SEED = undefined;
      try {
        const error = await clearDemoTourBookings('test').catch((e: unknown) => e);
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
      const bookingId = await makeBooking(tourId, REF_ONE);

      expect(env.ALLOW_DEMO_SEED, 'the test environment must already set ALLOW_DEMO_SEED=1').toBe(
        '1',
      );
      const original = env.NODE_ENV;
      (env as { NODE_ENV?: string }).NODE_ENV = 'production';
      try {
        const error = await clearDemoTourBookings('test').catch((e: unknown) => e);
        expect(error, 'resolved instead of refusing with NODE_ENV=production').toBeInstanceOf(
          Error,
        );
        expect((error as Error).message).toMatch(/NODE_ENV/);
        expect((error as Error).message).toMatch(/production/);
      } finally {
        (env as { NODE_ENV?: string }).NODE_ENV = original;
      }

      expect(await bookingExists(bookingId), 'the guard ran a query before refusing').toBe(true);
    }, 30_000);
  },
);

describeWithDb('clearDemoTourBookings — matches only the two fixed demo refs', () => {
  it('leaves a booking with a different ref alone, even with the same status and date', async () => {
    const tourId = await makeTour();
    const bookingId = await makeBooking(tourId, `RG-${unique().slice(0, 6).toUpperCase()}`);

    await clearDemoTourBookings('test');

    expect(
      await bookingExists(bookingId),
      'a non-demo-ref booking was deleted — matching must never fall back to date/status',
    ).toBe(true);
  }, 30_000);
});

describeWithDb(
  'clearDemoTourBookings — refuses if a matched booking has a non-demo payment',
  () => {
    it('deletes a demo booking whose payment audit trail is the seed’s own ("system")', async () => {
      const tourId = await makeTour();
      const bookingId = await makeBooking(tourId, REF_ONE);
      const paymentId = await makePayment(bookingId, 'system');

      await clearDemoTourBookings('test');

      expect(await bookingExists(bookingId)).toBe(false);
      expect(await paymentExists(paymentId)).toBe(false);
    }, 30_000);

    it('refuses the whole run, deleting nothing, when the SECOND matched booking has a non-demo payment', async () => {
      const tourId = await makeTour();
      // REF_ONE is read-and-verified FIRST (array order); tainting REF_TWO
      // (the second) proves the whole run refuses regardless of which
      // matched booking is tainted — not only the one checked first.
      const cleanBookingId = await makeBooking(tourId, REF_ONE);
      const taintedBookingId = await makeBooking(tourId, REF_TWO);
      const taintedPaymentId = await makePayment(taintedBookingId, 'user');

      const error = await clearDemoTourBookings('test').catch((e: unknown) => e);
      expect(
        error,
        'resolved instead of refusing a booking with a non-demo-seed payment',
      ).toBeInstanceOf(Error);
      expect((error as Error).message).toMatch(new RegExp(REF_TWO));

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
        await bookingExists(cleanBookingId),
        'a clean demo booking in the SAME run was deleted despite the refusal',
      ).toBe(true);
    }, 30_000);

    it('refuses when a matched booking has a payment with no audit row at all', async () => {
      const tourId = await makeTour();
      const bookingId = await makeBooking(tourId, REF_ONE);
      // A payment with no matching `audit_log` row — deliberately not using
      // `makePayment()`, which always writes one.
      const [payment] = await getDb().insert(payments).values({
        bookingId,
        type: 'payment',
        provider: 'manual',
        method: 'gcash',
        amountCentavos: TOTAL,
        status: 'paid',
      });

      const error = await clearDemoTourBookings('test').catch((e: unknown) => e);
      expect(error, 'resolved instead of refusing a payment with no audit trail').toBeInstanceOf(
        Error,
      );

      expect(await bookingExists(bookingId)).toBe(true);
      expect(await paymentExists(payment.insertId)).toBe(true);
    }, 30_000);
  },
);

describeWithDb('clearDemoTourBookings — happy path', () => {
  it('deletes both demo tour bookings when both exist, guards pass, and nothing is tainted', async () => {
    const tourId = await makeTour();
    const bookingOneId = await makeBooking(tourId, REF_ONE);
    const bookingTwoId = await makeBooking(tourId, REF_TWO);

    await clearDemoTourBookings('test');

    expect(await bookingExists(bookingOneId)).toBe(false);
    expect(await bookingExists(bookingTwoId)).toBe(false);
  }, 30_000);

  it('reports what it did and does not throw when neither ref exists', async () => {
    await expect(clearDemoTourBookings('test')).resolves.toBeUndefined();
  }, 30_000);
});
