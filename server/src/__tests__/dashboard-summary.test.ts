/**
 * Task 1B (Direction B, owner decision 2026-11-10): two new read-only
 * dashboard queries, `admin.dashboard.tripRequests` and
 * `admin.dashboard.money`. `admin.dashboard.alerts` is untouched — this
 * file never imports `services/dispatch/alerts.ts`.
 *
 * ## Why every money assertion is a DELTA, not an absolute
 *
 * `dashboardMoneySummary`'s "pending verification" figure is deliberately
 * NOT scoped to a date range (its own doc comment explains why), and the
 * router's `money` procedure always reads the REAL clock (`new Date()`,
 * never a client- or test-supplied `now` — the same reason
 * `admin.dashboard.alerts` does). Neither can be pinned to a synthetic
 * isolated date the way `admin-reports.test.ts`'s year-2098 fixtures are.
 * So every assertion here is BEFORE/AFTER around this file's own fixture: it
 * proves the predicate counts what THIS test added, regardless of whatever
 * else may be sitting in the shared `rg_travel_test` database at the moment
 * the suite runs. This is the same robustness property `dashboard-alerts.test.ts`
 * leans on for `payments_to_verify` (also an unscoped whole-table count) —
 * explicit per-test cleanup plus this file's own tracking, not an assumption
 * that the table is otherwise empty.
 */
import { afterAll, afterEach, beforeAll, expect, it } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import type { PriceSnapshot } from '@rg/shared';
import { appRouter } from '../routers/_app';
import { getDb, getPool } from '../db/client';
import { bookings, destinations, inquiries, payments, tours, users } from '../db/schema';
import { generateBookingRef } from '../services/booking-ref';
import { staffContext, testContext } from './helpers/ctx';
import { describeWithDb } from './helpers/db';

const created = {
  userIds: [] as number[],
  tourIds: [] as number[],
  destIds: [] as number[],
  bookingIds: [] as number[],
  paymentIds: [] as number[],
  inquiryIds: [] as number[],
};

let seq = 0;
const unique = () => {
  seq += 1;
  return `${seq}-${Math.floor(Math.random() * 1e9)}-${Date.now()}`;
};

const SNAPSHOT: PriceSnapshot = {
  tier: { tierId: 1, minPax: 1, maxPax: 12, pricePerPersonCentavos: 100_000 },
  addons: [],
  coupon: null,
  depositPercent: 30,
  freeCancelHours: 48,
  subtotalCentavos: 100_000,
  discountCentavos: 0,
  totalCentavos: 100_000,
};

let ownerId = 0;
let dispatcherId = 0;
let financeId = 0;
let tourId = 0;

const ownerApi = () => appRouter.createCaller(staffContext(ownerId, 'owner') as never);
const dispatcherApi = () =>
  appRouter.createCaller(staffContext(dispatcherId, 'dispatcher') as never);
const financeApi = () => appRouter.createCaller(staffContext(financeId, 'finance') as never);
const publicApi = () => appRouter.createCaller(testContext(null) as never);

async function makeStaff(role: 'owner' | 'dispatcher' | 'finance') {
  const suffix = unique();
  const [row] = await getDb()
    .insert(users)
    .values({
      name: `DashSum ${role} ${suffix}`,
      email: `dashsum_${role}_${suffix}@example.test`,
      passwordHash: '__dashsum_fixture_not_a_hash__',
      role,
      isActive: true,
    });
  created.userIds.push(row.insertId);
  return row.insertId;
}

async function makeBooking(): Promise<number> {
  const [row] = await getDb().insert(bookings).values({
    ref: generateBookingRef(),
    tourId,
    tourDate: new Date(),
    pax: 2,
    leadName: 'Dashboard Summary Fixture Guest',
    leadEmail: 'dashsum@example.test',
    leadPhone: '09171234567',
    status: 'confirmed',
    payMode: 'deposit',
    priceSnapshot: SNAPSHOT,
    subtotalCentavos: SNAPSHOT.totalCentavos,
    totalCentavos: SNAPSHOT.totalCentavos,
    paymentReviewRequired: false,
    holdExpiresAt: null,
  });
  created.bookingIds.push(row.insertId);
  return row.insertId;
}

async function makePayment(spec: {
  bookingId: number;
  type?: 'payment' | 'refund';
  provider?: 'manual' | 'paymongo';
  status: 'pending' | 'paid' | 'rejected' | 'refunded';
  amountCentavos: number;
  /** Defaults to right now — this file's whole reason for the delta pattern. */
  createdAt?: Date;
}): Promise<number> {
  const at = spec.createdAt ?? new Date();
  const [row] = await getDb()
    .insert(payments)
    .values({
      bookingId: spec.bookingId,
      type: spec.type ?? 'payment',
      provider: spec.provider ?? 'manual',
      method: 'cash',
      amountCentavos: spec.amountCentavos,
      status: spec.status,
      createdAt: at,
      updatedAt: at,
    });
  created.paymentIds.push(row.insertId);
  return row.insertId;
}

/** An enquiry written through the PUBLIC mutation that already owns this table — never a direct INSERT. */
async function createTripRequest(opts: {
  pax?: number;
  routeDescription?: string;
  requestedDate?: string;
}): Promise<{ id: number; email: string }> {
  const suffix = unique();
  const email = `dashsum_guest_${suffix}@example.test`;
  await publicApi().inquiries.create({
    type: 'transfer_custom',
    pax: opts.pax ?? 4,
    routeDescription: opts.routeDescription ?? 'Hotel, Cebu City to Moalboal',
    requestedDate: opts.requestedDate ?? '2026-12-01',
    name: 'Dashboard Summary Guest',
    email,
    phone: '09170000000',
    message: `Custom trip please. ${suffix}`,
    consent: true,
  });
  const [row] = await getDb()
    .select({ id: inquiries.id })
    .from(inquiries)
    .where(eq(inquiries.email, email));
  const id = row?.id ?? 0;
  created.inquiryIds.push(id);
  return { id, email };
}

describeWithDb('admin.dashboard.tripRequests and admin.dashboard.money (Task 1B)', () => {
  beforeAll(async () => {
    ownerId = await makeStaff('owner');
    dispatcherId = await makeStaff('dispatcher');
    financeId = await makeStaff('finance');

    const slug = `__dashsum__${unique()}`;
    const [destination] = await getDb().insert(destinations).values({ name: slug, slug });
    created.destIds.push(destination.insertId);
    const [tour] = await getDb()
      .insert(tours)
      .values({
        slug,
        title: 'Dashboard Summary Fixture Tour',
        destinationId: destination.insertId,
        isActive: true,
      });
    tourId = tour.insertId;
    created.tourIds.push(tourId);
  });

  afterEach(async () => {
    const pool = getPool();
    for (const id of created.paymentIds)
      await pool.query('DELETE FROM payments WHERE id = ?', [id]);
    created.paymentIds.length = 0;
    for (const id of created.bookingIds)
      await pool.query('DELETE FROM bookings WHERE id = ?', [id]);
    created.bookingIds.length = 0;
    for (const id of created.inquiryIds)
      await pool.query('DELETE FROM inquiries WHERE id = ?', [id]);
    created.inquiryIds.length = 0;
  });

  afterAll(async () => {
    const pool = getPool();
    for (const id of created.tourIds) await pool.query('DELETE FROM tours WHERE id = ?', [id]);
    for (const id of created.destIds)
      await pool.query('DELETE FROM destinations WHERE id = ?', [id]);
    if (created.userIds.length > 0) {
      await getDb().delete(users).where(inArray(users.id, created.userIds));
    }
  });

  /* ---------------------------------------------------------- tripRequests */

  it('counts a fresh transfer_custom/new inquiry and shows its fields, with no email/phone/message on the wire', async () => {
    const before = await ownerApi().admin.dashboard.tripRequests();
    const { id } = await createTripRequest({ pax: 6, routeDescription: 'Airport to Oslob' });
    const after = await ownerApi().admin.dashboard.tripRequests();

    expect(after.count).toBe(before.count + 1);
    const item = after.items.find((i) => i.id === id);
    expect(item).toMatchObject({ pax: 6, routeDescription: 'Airport to Oslob' });
    expect(item).toBeDefined();
    expect(Object.keys(item as object).sort()).toEqual(
      ['id', 'name', 'pax', 'routeDescription', 'requestedDate'].sort(),
    );
  });

  it('does NOT count a contact or package inquiry, and does not count a transfer_custom inquiry once its status moves off "new"', async () => {
    const before = await ownerApi().admin.dashboard.tripRequests();

    await publicApi().inquiries.create({
      type: 'contact',
      name: 'Not A Trip Request',
      email: `dashsum_contact_${unique()}@example.test`,
      phone: '09170000000',
      message: 'General question.',
      consent: true,
    });

    const { id: movedId } = await createTripRequest({});
    // Move it off `new` through the real writer.
    await ownerApi().admin.inquiries.setStatus({ id: movedId, status: 'read' });

    const after = await ownerApi().admin.dashboard.tripRequests();
    // Net zero: the contact enquiry was never counted, and the transfer_custom
    // one was counted only transiently (never observed at `new` by this test)
    // then moved off `new` before this final read.
    expect(after.count).toBe(before.count);
    expect(after.items.some((i) => i.id === movedId)).toBe(false);
  });

  it('caps items at 5 and orders newest first', async () => {
    const ids: number[] = [];
    for (let i = 0; i < 6; i += 1) {
      const { id } = await createTripRequest({});
      ids.push(id);
    }
    const result = await ownerApi().admin.dashboard.tripRequests();
    expect(result.items).toHaveLength(5);
    // Newest first, dropping the OLDEST of the six (ids[0]) — not merely "a
    // subset": the five returned ids, in order, must be exactly the last
    // five created, highest id first. `created_at` has only second
    // precision, so a test that sorted by date alone could pass with the
    // rows in the wrong order; ordering by id too (as the production query
    // does) is what makes this assertion exact rather than approximate.
    expect(result.items.map((i) => i.id)).toEqual([...ids].slice(1).reverse());
  });

  it('is readable by owner and dispatcher, refused for finance (RA 10173 — guest names)', async () => {
    await expect(ownerApi().admin.dashboard.tripRequests()).resolves.toBeDefined();
    await expect(dispatcherApi().admin.dashboard.tripRequests()).resolves.toBeDefined();
    await expect(financeApi().admin.dashboard.tripRequests()).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });

  /* ------------------------------------------------------------------ money */

  it('"collected today" counts a manual payment made right now, and only a PAID payment of TYPE payment', async () => {
    const bookingId = await makeBooking();
    const before = await ownerApi().admin.dashboard.money();

    await makePayment({ bookingId, status: 'paid', amountCentavos: 50_000 });
    // Not counted: pending (not yet paid), and a refund (wrong type).
    await makePayment({ bookingId, status: 'pending', amountCentavos: 70_000 });
    await makePayment({ bookingId, type: 'refund', status: 'refunded', amountCentavos: 20_000 });

    const after = await ownerApi().admin.dashboard.money();
    expect(after.collectedTodayCentavos).toBe(before.collectedTodayCentavos + 50_000);
  });

  it('"collected today" does NOT count a payment from yesterday', async () => {
    const bookingId = await makeBooking();
    const before = await ownerApi().admin.dashboard.money();

    const yesterday = new Date(Date.now() - 36 * 3_600_000); // safely the prior Manila civil day
    await makePayment({ bookingId, status: 'paid', amountCentavos: 999_000, createdAt: yesterday });

    const after = await ownerApi().admin.dashboard.money();
    expect(after.collectedTodayCentavos).toBe(before.collectedTodayCentavos);
  });

  it('"pending verification" sums a pending MANUAL payment regardless of its date, and excludes paid/rejected/non-manual', async () => {
    const bookingId = await makeBooking();
    const before = await ownerApi().admin.dashboard.money();

    const longAgo = new Date(Date.now() - 10 * 24 * 3_600_000);
    await makePayment({ bookingId, status: 'pending', amountCentavos: 30_000, createdAt: longAgo });
    // Excluded: already paid, already rejected, or a gateway (not manual) payment.
    await makePayment({ bookingId, status: 'paid', amountCentavos: 40_000 });
    await makePayment({ bookingId, status: 'rejected', amountCentavos: 50_000 });
    await makePayment({
      bookingId,
      status: 'pending',
      provider: 'paymongo',
      amountCentavos: 60_000,
    });

    const after = await ownerApi().admin.dashboard.money();
    expect(after.pendingVerificationCentavos).toBe(before.pendingVerificationCentavos + 30_000);
  });

  it('is readable by owner and finance, refused for dispatcher (money)', async () => {
    await expect(ownerApi().admin.dashboard.money()).resolves.toBeDefined();
    await expect(financeApi().admin.dashboard.money()).resolves.toBeDefined();
    await expect(dispatcherApi().admin.dashboard.money()).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });

  it('refuses a caller with no session, for both procedures', async () => {
    const api = appRouter.createCaller({} as never);
    await expect(api.admin.dashboard.tripRequests()).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    });
    await expect(api.admin.dashboard.money()).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  });
});
