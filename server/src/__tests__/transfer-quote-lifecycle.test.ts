/**
 * Transfers-launch plan, Task T21 — the full lifecycle a staff-quoted
 * custom transfer walks, proven end to end: inquiry → convert → booking
 * (held) → guest pays the deposit online → dispatch assigns a driver and
 * van → the driver collects the cash balance on the day → finance verifies
 * it. Every step after conversion reuses machinery that already has its own
 * dedicated test file (dispatch, `recordPayment`, the driver cash claim, its
 * admin verification) — this file's only job is to prove a STAFF-QUOTED,
 * ROUTELESS booking fits through all of it unmodified, the same way
 * `admin-transfer-quotes.test.ts`'s own header says this file would.
 *
 * **The role boundary is not re-proven here.** `admin-transfer-quotes
 * .test.ts:331` already denies a dispatcher against the real
 * `admin.transferQuotes.convert`, and `role-isolation.test.ts`'s generated
 * matrix covers it a second way in the abstract. Re-asserting it a third
 * time here would be noise, not proof.
 *
 * **Why `convertTransferQuote()` is called directly, not through the
 * router, for the FIRST step only.** `admin.transferQuotes.convert`'s
 * resolver always passes `new Date()` for `now`; this file needs an
 * explicit one so the lifecycle's two time-sensitive rules can both be
 * satisfied DETERMINISTICALLY, regardless of what wall-clock hour the test
 * happens to run at:
 *
 *  - `createTransferBooking()`'s 6-hour minimum-notice check, which compares
 *    the pickup INSTANT against `now`.
 *  - `driver.recordCash`'s "only on the day of the trip" check
 *    (`routers/public/driver.ts`'s `recordDriverCash`), which compares
 *    `manilaCivilDate(booking.tourDate)` against `manilaCivilDate(new
 *    Date())` read fresh at that call — a REAL wall-clock read this file
 *    cannot inject into.
 *
 * So the pickup date is fixed to TODAY's real Manila civil date (so the
 * driver's later, real-clock cash claim always lands on the right day), and
 * the explicit `now` passed to `convertTransferQuote()` is pinned to
 * exactly 24 hours before this moment. Pickup time is a fixed 10:00. The
 * gap between pickup and that `now` is then always in `(10, 34]` hours
 * — comfortably clear of the 6-hour rule at any hour of any day — worked
 * out as: `now = today(H:00) − 24h`, so `gap = pickup(10:00) − now =
 * (24 − H) + 10` hours, which for `H` in `[0, 24)` stays in `(10, 34]`
 * (the 10 end is approached, at 23:59, but never reached).
 *
 * `TODAY` and `NOW_MINUS_24H` are computed fresh in `beforeEach`, not once
 * at module load: `fileParallelism: false` runs this suite sequentially
 * with every other file, so the gap between module load and this test
 * actually running can be minutes, not milliseconds — long enough to cross
 * a real Manila midnight and turn `TODAY` stale. `driver-cash.test.ts`,
 * `driver-trips.test.ts` and `driver-trip-detail.test.ts` all compute their
 * own `TODAY` the same way, for the same reason.
 *
 * This is NOT a workaround for the role gate (already proven elsewhere —
 * see above) or for the driver-ownership gate below, both of which this
 * file still exercises through the real routers.
 *
 * **The same `now` also sets `holdExpiresAt`.** `createTransferBooking()`
 * computes `holdExpiresAt = now + staffQuoteHoldHours` (T19), so this
 * fixture's hold lands at `(real-now − 24h) + staffQuoteHoldHours`. With the
 * seeded 48h setting that is comfortably `real-now + 24h` — but the setting
 * only has a `.min(1)` floor, and at anything ≤ 24h this fixture would be
 * born with an ALREADY-EXPIRED hold, silently proving a state production
 * never reaches (a guest paying, and dispatch assigning, a hold
 * `expire-holds` has already reclaimed). The test below pins both the
 * seeded value and the resulting hold's liveness, so a future settings
 * change fails loudly here instead of hollowing this file out silently.
 *
 * **The downstream half goes through the REAL routers and a REAL driver
 * session, deliberately.** Calling `recordPendingCash()` or
 * `verifyCashPayment()` as bare services would prove the money arithmetic
 * and nothing about the LIFECYCLE — specifically, it would not prove that a
 * staff-converted, routeless booking's various LEFT JOINs (`loadDriverTrip`
 * onto `tours`, the assignment email's onto `tours`, T18's onto
 * `booking_transfer_details`) don't quietly 404 a real driver out of their
 * own trip the way an INNER JOIN would have. Going through
 * `driverCaller(driverId).recordCash(...)` is what actually tests that.
 *
 * The ONE step simulated directly rather than through a route is the
 * guest's online deposit: `recordPayment()`, called the same way
 * `routers/webhooks/index.ts`'s real `applyEvent()` does (`provider:
 * 'paymongo'`, `actor: { type: 'provider', id: null }`). The webhook ROUTE
 * itself — signature verification, raw-body parsing — has its own dedicated
 * file (`webhook-signed-end-to-end.test.ts`) and re-deriving a second real
 * HMAC signature here would test that seam twice while testing this one
 * not at all.
 */
import { afterEach, beforeEach, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { depositCentavos, manilaCivilDate } from '@rg/shared';
import { appRouter } from '../routers/_app';
import { getDb, getPool } from '../db/client';
import {
  auditLog,
  bookingTransferDetails,
  bookings,
  drivers,
  inquiries,
  payments,
  users,
  vans,
  vehicleTypes,
} from '../db/schema';
import { readTransferOperationsSettings } from '../content/settings';
import { recordPayment } from '../services/payments/record-payment';
import {
  convertTransferQuote,
  type ConvertTransferQuoteInput,
} from '../services/transfers/convert-quote';
import { driverCaller, staffContext, testContext } from './helpers/ctx';
import { describeWithDb } from './helpers/db';

/**
 * The seeded default (`db/seed-data.ts`, `content/settings-schema.ts`) —
 * pinned in `beforeEach` below, the same discipline
 * `transfer-create-booking.test.ts:524` uses, because this fixture's hold
 * arithmetic depends on it staying above 24h. See the file header.
 */
const STAFF_QUOTE_HOLD_HOURS = 48;

/** Today's real Manila civil date and the lifecycle's fixed `now` — see the file header for why these are computed per-test, not at module load. */
let TODAY = '';
let NOW_MINUS_24H = new Date(0);

const created = {
  userIds: [] as number[],
  inquiryIds: [] as number[],
  bookingIds: [] as number[],
  vanIds: [] as number[],
  driverIds: [] as number[],
};

let seq = 0;
const unique = () => {
  seq += 1;
  return `${seq}-${Math.floor(Math.random() * 1e9)}-${Date.now()}`;
};

let ownerId = 0;
let financeId = 0;
let VAN_TYPE_ID = 0;

const ownerApi = () => appRouter.createCaller(staffContext(ownerId, 'owner') as never);
const financeApi = () => appRouter.createCaller(staffContext(financeId, 'finance') as never);

async function makeStaff(role: 'owner' | 'finance') {
  const suffix = unique();
  const [row] = await getDb()
    .insert(users)
    .values({
      name: `Transfer lifecycle ${role} ${suffix}`,
      email: `xferlife_${role}_${suffix}@example.test`,
      passwordHash: '__xferlife_fixture_not_a_hash__',
      role,
      isActive: true,
    });
  created.userIds.push(row.insertId);
  return row.insertId;
}

async function vehicleTypeIdBySlug(slug: string): Promise<number> {
  const [row] = await getDb()
    .select({ id: vehicleTypes.id })
    .from(vehicleTypes)
    .where(eq(vehicleTypes.slug, slug))
    .limit(1);
  if (!row) throw new Error(`No vehicle_types row for slug "${slug}"`);
  return row.id;
}

async function makeVan() {
  const suffix = unique();
  const [row] = await getDb()
    .insert(vans)
    .values({
      plate: `XL${suffix}`.slice(0, 20),
      model: 'Transfer Lifecycle Fixture',
      capacity: 12,
      vehicleTypeId: VAN_TYPE_ID,
      status: 'available',
      isActive: true,
    });
  created.vanIds.push(row.insertId);
  return row.insertId;
}

async function makeDriver() {
  const suffix = unique();
  const [row] = await getDb()
    .insert(drivers)
    .values({
      name: `Transfer Lifecycle Fixture ${suffix}`,
      code: `XL${suffix}`.slice(0, 20),
      phone: '09170000000',
      pinHash: '__xferlife_not_a_pin_hash__',
      maxTransferJobsPerDay: 4,
      isActive: true,
    });
  created.driverIds.push(row.insertId);
  return row.insertId;
}

/** Through `inquiries.create`, never a raw INSERT — same discipline as `admin-transfer-quotes.test.ts`. */
async function createInquiry() {
  const suffix = unique();
  const email = `xferlife_guest_${suffix}@example.test`;
  const anon = appRouter.createCaller(testContext(null) as never);
  await anon.inquiries.create({
    type: 'transfer_custom',
    name: 'Lifecycle Guest',
    email,
    message: `Full lifecycle notes ${suffix}`,
    requestedDate: TODAY,
    pax: 3,
    routeDescription: 'Mactan airport to a private resort in Argao',
    consent: true,
  });
  const [row] = await getDb()
    .select({ id: inquiries.id })
    .from(inquiries)
    .where(eq(inquiries.email, email));
  const id = row?.id ?? 0;
  created.inquiryIds.push(id);
  return id;
}

function serviceInput(inquiryId: number): ConvertTransferQuoteInput {
  return {
    inquiryId,
    vehicleTypeId: VAN_TYPE_ID,
    productType: 'transfer_one_way',
    date: TODAY,
    pickupTime: '10:00',
    dayUseEndTime: null,
    customRouteDurationMinutes: 60,
    pax: 3,
    luggageCount: 2,
    pickup: 'Mactan-Cebu International Airport, Terminal 2',
    pickupMapUrl: null,
    dropoffAddress: 'A private resort in Argao',
    dropoffMapUrl: null,
    flightNumber: null,
    airline: null,
    ferryVesselName: null,
    ferryArrivalTime: null,
    leadPhone: '09171234567',
    priceCentavos: 500_000,
  };
}

async function bookingRow(id: number) {
  const [row] = await getDb().select().from(bookings).where(eq(bookings.id, id));
  if (!row) throw new Error(`booking ${id} not found`);
  return row;
}

async function cleanup() {
  const pool = getPool();
  const db = getDb();
  // Inquiries first: `converted_booking_id` is a RESTRICT FK onto bookings,
  // the same ordering `admin-transfer-quotes.test.ts` learned the hard way.
  for (const id of created.inquiryIds) {
    await pool.query('DELETE FROM inquiries WHERE id = ?', [id]);
  }
  for (const id of created.bookingIds) {
    await pool.query('DELETE FROM payments WHERE booking_id = ?', [id]);
    await pool.query('DELETE FROM audit_log WHERE entity = ? AND entity_id = ?', ['bookings', id]);
    await db.delete(bookingTransferDetails).where(eq(bookingTransferDetails.bookingId, id));
    await pool.query('DELETE FROM bookings WHERE id = ?', [id]);
  }
  for (const id of created.driverIds) await db.delete(drivers).where(eq(drivers.id, id));
  for (const id of created.vanIds) await db.delete(vans).where(eq(vans.id, id));
  await pool.query('DELETE FROM fleet_date_slots WHERE date = ?', [TODAY]);
  created.bookingIds = [];
  created.inquiryIds = [];
  created.driverIds = [];
  created.vanIds = [];
}

describeWithDb('a staff-quoted custom transfer, hold through full payment', () => {
  beforeEach(async () => {
    TODAY = manilaCivilDate(new Date());
    NOW_MINUS_24H = new Date(Date.now() - 24 * 3_600_000);

    ownerId = await makeStaff('owner');
    financeId = await makeStaff('finance');
    VAN_TYPE_ID = await vehicleTypeIdBySlug('van');

    // This fixture's hold arithmetic depends on this staying above 24h —
    // see the file header. Fails HERE, by name, rather than as a confusing
    // downstream refusal.
    const operations = await readTransferOperationsSettings();
    expect(operations.staffQuoteHoldHours, 'the seeded staff-quote hold changed').toBe(
      STAFF_QUOTE_HOLD_HOURS,
    );
  });

  afterEach(async () => {
    await cleanup();
    for (const id of created.userIds) await getDb().delete(users).where(eq(users.id, id));
    created.userIds = [];
  });

  it('inquiry → convert → deposit online → dispatch → cash on the day → verified, fully paid', async () => {
    const inquiryId = await createInquiry();
    // A transfer hold reserves fleet capacity at CREATION time, unlike a
    // tour — so the van this lifecycle later dispatches must already
    // exist before `convertTransferQuote()` can place the hold at all.
    const vanId = await makeVan();
    const driverId = await makeDriver();

    // 1. Convert. Explicit `now` — see the file header for why.
    const held = await convertTransferQuote(serviceInput(inquiryId), ownerId, NOW_MINUS_24H);
    created.bookingIds.push(held.bookingId);

    let row = await bookingRow(held.bookingId);
    expect(row.status).toBe('pending_payment');
    expect(row.totalCentavos).toBe(500_000);
    expect(row.amountPaidCentavos).toBe(0);
    expect(manilaCivilDate(row.tourDate)).toBe(TODAY);

    // The injected `now` sets this hold's deadline too (see the file
    // header) — pinned exactly, and independently asserted to still be
    // alive relative to the REAL clock, which is the invariant that
    // actually matters: a fixture born with an already-expired hold would
    // let every step below pass while proving a state production can't
    // reach.
    expect(held.holdExpiresAt.getTime()).toBe(
      NOW_MINUS_24H.getTime() + STAFF_QUOTE_HOLD_HOURS * 3_600_000,
    );
    expect(
      held.holdExpiresAt.getTime(),
      'this fixture was born with an already-expired hold',
    ).toBeGreaterThan(Date.now());

    // 2. The guest pays the deposit online — the deposit frozen on the
    // booking's own `price_snapshot` at creation time, not a bare re-read
    // of the live setting.
    const depositAmount = depositCentavos(500_000, row.priceSnapshot.depositPercent);
    await recordPayment({
      bookingId: held.bookingId,
      type: 'payment',
      provider: 'paymongo',
      method: 'gcash',
      amountCentavos: depositAmount,
      providerRef: 'pi_lifecycle_test',
      providerStatus: 'paid',
      actor: { type: 'provider', id: null },
    });

    row = await bookingRow(held.bookingId);
    expect(row.status).toBe('confirmed');
    expect(row.amountPaidCentavos).toBe(depositAmount);

    // 3. Dispatch assigns that same van and driver, through the real router.
    await ownerApi().admin.dispatch.assign({
      bookingId: held.bookingId,
      vanId,
      driverId,
      reason: 'Lifecycle test assignment',
    });

    row = await bookingRow(held.bookingId);
    expect(row.status).toBe('assigned');
    expect(row.vanId).toBe(vanId);
    expect(row.driverId).toBe(driverId);

    // 4. The driver — a REAL driver session, scoped by `ctx.driver
    // .driverId` — claims the cash balance on the day of the trip.
    const claim = await driverCaller(driverId).driver.recordCash({ bookingId: held.bookingId });
    expect(claim.amountCentavos).toBe(500_000 - depositAmount);

    // 5. Finance verifies the claim, crediting it for real.
    const [pendingCash] = await getDb()
      .select({ id: payments.id })
      .from(payments)
      .where(and(eq(payments.bookingId, held.bookingId), eq(payments.status, 'pending')));
    expect(pendingCash, 'the cash claim left no pending payments row to verify').toBeDefined();

    const verified = await financeApi().admin.bookings.approveCash({ paymentId: pendingCash!.id });
    expect(verified.paymentReviewRequired).toBe(false);

    row = await bookingRow(held.bookingId);
    expect(row.amountPaidCentavos).toBe(500_000);
    // `statusAfterManualVerified` (`services/payments/record-payment.ts`)
    // only promotes `pending_payment`/`pending_verification` to `confirmed`
    // — an already-`assigned` booking stays `assigned`. Worth pinning here,
    // not just in that function's own unit test: this is the one path where
    // a booking is both dispatched AND cash-verified, and a regression that
    // dropped it back to `confirmed` would silently undo step 3's dispatch.
    expect(row.status).toBe('assigned');

    // The dedicated audit row T19 wrote is still there, untouched by
    // everything downstream.
    const [audit] = await getDb()
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.entity, 'bookings'),
          eq(auditLog.entityId, held.bookingId),
          eq(auditLog.action, 'transfer.custom_quote_converted'),
        ),
      );
    expect(audit).toBeDefined();
  });
});
