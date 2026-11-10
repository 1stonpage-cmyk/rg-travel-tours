/**
 * Transfers-launch plan, Task T25 — the end-to-end regression proof for a
 * transfer booking, driven through the REAL Express app (`createApp()`):
 * the real routes, the real middleware stack (origin check, rate limiters,
 * cookie parsers), the real tRPC router, the real services and the real
 * database. Nothing is stubbed except the mail transport, exactly as
 * `phase1-walkthrough.test.ts` (Week 4 Task 12) already established for a
 * tour.
 *
 * **What this file adds, and what it deliberately does NOT re-derive.**
 * Every piece of math this walkthrough exercises already has its own
 * dedicated proof:
 *
 *  - The van/driver overlap math and the daily-cap refusal (T7/T8) are
 *    proven at the router-caller level by `dispatch-assign.test.ts`
 *    (":1172" onward) — this file does not re-derive that arithmetic, it
 *    proves the SAME verdicts survive the real HTTP/session/rate-limiter
 *    stack, and that TWO of a day's jobs can share one van and one driver
 *    through `admin.dispatch.assign` called twice in sequence (the plan's
 *    own words: "two same-day non-overlapping jobs on one van AND one
 *    driver").
 *  - The zero-itinerary-stop check-in path (a transfer has no stops to
 *    tap between Start and Complete) is proven, including its own
 *    mutation proof, by `driver-transfer-trip.test.ts` (Task T22). What is
 *    new here is only that the same `unknown_stop` refusal survives a real
 *    driver login and the real Express stack, not a second proof of the
 *    semantics.
 *  - The staff-quoted, routeless lifecycle (inquiry → convert → booking →
 *    deposit → cash on the day) is proven end to end by
 *    `transfer-quote-lifecycle.test.ts` (Task T21). This file does not
 *    re-walk it.
 *
 * **The payment leg is the manual QR/receipt path, not the online
 * gateway** — for the same reason `phase1-walkthrough.test.ts` uses it:
 * there is no PayMongo sandbox account yet (owner decision 2026-10-13), so
 * the online path cannot be driven end to end against a real gateway. The
 * manual path is a real payment leg in production (§6), just not the only
 * one, and it is what both files can actually prove.
 *
 * **"Review-eligible" is read off the My Booking tracker, not an actual
 * review submission.** `portalTracker()`'s fifth step ("Trip day") going
 * `done: true` the moment the booking is `completed` IS what
 * review-eligibility means (see `shared/src/portal.ts`,
 * `phase1-walkthrough.test.ts`'s own "shows the tracker at each status"
 * test) — actually submitting one would additionally commit this file to
 * cleaning up a `reviews` row for no further proof, since
 * `portal.submitReview`'s own behaviour is `phase1-walkthrough.test.ts`'s
 * job, not this file's.
 *
 * Each `it()` below gets a fresh `app` (`beforeEach`), the same reason
 * `phase1-walkthrough.test.ts` does: the rate limiters are per-instance.
 * `checkout.createHoldTransfer` shares `CHECKOUT_HOLD_MAX` (5 per IP) with
 * `checkout.createHold` — the busiest `it()` below makes three holds, well
 * under the cap.
 */
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import request from 'supertest';
import { eq } from 'drizzle-orm';
import { createApp } from '../app';
import { readTransferOperationsSettings } from '../content/settings';
import { getDb, getPool } from '../db/client';
import {
  bookingTransferDetails,
  drivers,
  settings,
  transferPlaces,
  transferRouteVehiclePrices,
  transferRoutes,
  tripCheckpoints,
  users,
  vans,
  vehicleTypes,
} from '../db/schema';
import { SESSION_COOKIE_BY_SUBJECT } from '../middleware/session-cookie';
import { hashPassword } from '../services/password';
import { resetEmailThrottleForTests } from '../services/staff-auth';
import { resetTransportForTests, setTransportForTests } from '../services/notify';
import { receiptStorageDir } from '../services/uploads';
import { describeWithDb } from './helpers/db';

const ORIGIN = 'http://localhost:5180';
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('a'.repeat(32))]);
const STAFF_PASSWORD = 'a-strong-t25-walkthrough-password';

/**
 * Far enough in the future that no `minNoticeHours` rule can ever be what
 * refuses, and — unlike a tour — a transfer carries no booking-window
 * upper bound to respect either (`checkout-create-hold-transfer.test.ts`'s
 * own `DAY` makes the same choice, just computed relative to "now" instead
 * of as a literal; both are valid, this file just needs ONE fixed day
 * three bookings can share). Confirmed unique: `grep -rn "2099-12-30"
 * server/src` matches only this file.
 */
const DAY = '2099-12-30';

const unique = () => `${Math.floor(Math.random() * 1e9)}_${Date.now()}`;
let guestSeq = 0;

const mail: Array<{ to: string; subject: string }> = [];

const created = {
  bookingIds: [] as number[],
  routeIds: [] as number[],
  placeIds: [] as number[],
  driverIds: [] as number[],
  vanIds: [] as number[],
  userIds: [] as number[],
  files: [] as string[],
};

let app: ReturnType<typeof createApp>;
let staffId = 0;
let VAN_TYPE_ID = 0;
let storedQr: unknown;

beforeAll(async () => {
  setTransportForTests({
    sendMail: async (message) => {
      mail.push({ to: String(message.to), subject: String(message.subject) });
    },
  });

  const db = getDb();

  const [vanType] = await db
    .select({ id: vehicleTypes.id })
    .from(vehicleTypes)
    .where(eq(vehicleTypes.slug, 'van'));
  if (!vanType) throw new Error('No vehicle_types row for slug "van" — expected from seedBase.');
  VAN_TYPE_ID = vanType.id;

  const hash = await hashPassword(STAFF_PASSWORD);
  const [staff] = await db.insert(users).values({
    name: 'T25 Walkthrough Owner',
    email: `t25_owner_${unique()}@example.test`,
    passwordHash: hash,
    role: 'owner',
    isActive: true,
  });
  staffId = staff.insertId;
  created.userIds.push(staff.insertId);

  // The seed ships this EMPTY — without it the manual path is not offered
  // at all (`phase1-walkthrough.test.ts` makes the identical save/restore).
  const [row] = await db
    .select({ value: settings.value })
    .from(settings)
    .where(eq(settings.key, 'payment_qr'));
  storedQr = row?.value;
  await db
    .update(settings)
    .set({
      value: {
        imagePath: 't25walkthroughqr00000000000.png',
        accountName: 'R&G Travel and Tours (T25 walkthrough)',
        accountNumber: '0917 000 0001',
        instructions: 'Put your booking reference in the note.',
        isConfigured: true,
      },
    })
    .where(eq(settings.key, 'payment_qr'));

  // The defaults this whole file's window arithmetic is over — asserted,
  // not assumed, the same discipline `checkout-create-hold-transfer
  // .test.ts`'s own `beforeAll` uses. A changed default must fail HERE, by
  // name, rather than as an unexplained overlap refusal below.
  const ops = await readTransferOperationsSettings();
  expect(
    ops.bufferMinutes,
    "this file's 08:00/11:00/14:00 spacing assumes the seeded default",
  ).toBe(60);
  expect(
    ops.maxTransferJobsPerDriverPerDay,
    "this file's cap test assumes the seeded default",
  ).toBe(2);
}, 120_000);

beforeEach(() => {
  app = createApp();
});

afterAll(async () => {
  resetTransportForTests();
  const db = getDb();
  const pool = getPool();

  if (storedQr !== undefined) {
    await db.update(settings).set({ value: storedQr }).where(eq(settings.key, 'payment_qr'));
  }

  const { rm } = await import('node:fs/promises');
  const { join } = await import('node:path');
  for (const name of created.files) {
    await rm(join(receiptStorageDir(), name), { force: true });
  }

  for (const id of created.bookingIds) {
    await pool.query('DELETE FROM audit_log WHERE entity = ? AND entity_id = ?', ['bookings', id]);
    // This file's own flows also write `entity = 'payments'` rows
    // (`payment.receipt_submitted`, `payment.verified`) — swept here, by
    // id, before the `payments` rows themselves go.
    const [paymentRows] = await pool.query('SELECT id FROM payments WHERE booking_id = ?', [id]);
    for (const { id: paymentId } of paymentRows as Array<{ id: number }>) {
      await pool.query('DELETE FROM audit_log WHERE entity = ? AND entity_id = ?', [
        'payments',
        paymentId,
      ]);
    }
    await db.delete(tripCheckpoints).where(eq(tripCheckpoints.bookingId, id));
    await db.delete(bookingTransferDetails).where(eq(bookingTransferDetails.bookingId, id));
    await pool.query('DELETE FROM payments WHERE booking_id = ?', [id]);
    await pool.query('DELETE FROM sessions WHERE subject_type = ? AND subject_id = ?', [
      'customer',
      id,
    ]);
    // Raw SQL, not `db.delete(bookings)`: `schema-conventions.test.ts` bans
    // the Drizzle hard-delete form everywhere, including test fixtures; the
    // raw form is the one it carves out for a fixture removing its own rows.
    await pool.query('DELETE FROM bookings WHERE id = ?', [id]);
  }
  for (const id of created.routeIds) {
    await db.delete(transferRouteVehiclePrices).where(eq(transferRouteVehiclePrices.routeId, id));
    await db.delete(transferRoutes).where(eq(transferRoutes.id, id));
  }
  for (const id of created.placeIds) {
    await db.delete(transferPlaces).where(eq(transferPlaces.id, id));
  }
  for (const id of created.driverIds) await db.delete(drivers).where(eq(drivers.id, id));
  for (const id of created.vanIds) await db.delete(vans).where(eq(vans.id, id));
  await pool.query('DELETE FROM fleet_date_slots WHERE date = ?', [DAY]);
  for (const id of created.userIds) {
    // `staffSignIn()` writes `entity = 'users'` (`auth.login`) once per
    // call — swept the same way the booking/payment entities are above.
    await pool.query('DELETE FROM audit_log WHERE entity = ? AND entity_id = ?', ['users', id]);
    await pool.query('DELETE FROM sessions WHERE subject_type = ? AND subject_id = ?', [
      'user',
      id,
    ]);
    await pool.query('DELETE FROM users WHERE id = ?', [id]);
  }
});

/* ------------------------------------------------------------------ *
 * Driving the app the way a browser does — the same shape
 * `phase1-walkthrough.test.ts` uses, duplicated rather than imported
 * (this file owns its own fixtures and helpers, the project convention).
 * ------------------------------------------------------------------ */

function query(procedure: string, input: unknown, cookie?: string) {
  const req = request(app).get(
    `/trpc/${procedure}${input === undefined ? '' : `?input=${encodeURIComponent(JSON.stringify(input))}`}`,
  );
  if (cookie) req.set('Cookie', cookie);
  return req;
}

function mutate(procedure: string, input: unknown, cookie?: string) {
  const req = request(app).post(`/trpc/${procedure}`).set('Origin', ORIGIN);
  if (cookie) req.set('Cookie', cookie);
  return req.send(input as object);
}

function unwrap(res: { status: number; body: unknown }): unknown {
  const body = res.body as { result?: { data?: unknown }; error?: { message?: string } };
  if (body?.error) {
    throw new Error(`tRPC refused (${res.status}): ${body.error.message ?? 'no message'}`);
  }
  return body?.result?.data;
}

function sessionCookie(res: { headers: Record<string, unknown> }): string {
  const raw = res.headers['set-cookie'];
  const list = Array.isArray(raw) ? raw : typeof raw === 'string' ? [raw] : [];
  const names = Object.values(SESSION_COOKIE_BY_SUBJECT);
  const found = list.find((value) => names.some((name) => value.startsWith(`${name}=`)));
  if (!found) throw new Error('no session cookie was set');
  return found.split(';')[0]!;
}

/* ------------------------------------------------------------------ *
 * Fixtures this file owns.
 * ------------------------------------------------------------------ */

async function makePlace() {
  const slug = `__t25place__${unique()}`;
  const [row] = await getDb()
    .insert(transferPlaces)
    .values({ name: slug, nameKey: slug.toLowerCase(), isActive: true });
  created.placeIds.push(row.insertId);
  return row.insertId;
}

/** A catalog route: 120-minute duration, so its window is 3 hours wide at the seeded 60-minute buffer. */
async function makeRoute() {
  const fromPlaceId = await makePlace();
  const toPlaceId = await makePlace();
  const [route] = await getDb()
    .insert(transferRoutes)
    .values({
      fromPlaceId,
      toPlaceId,
      slug: `t25-${unique()}`,
      estimatedDurationMinutes: 120,
      freeCancelHours: 24,
      isActive: true,
      reverseEnabled: true,
    });
  created.routeIds.push(route.insertId);
  await getDb().insert(transferRouteVehiclePrices).values({
    routeId: route.insertId,
    vehicleTypeId: VAN_TYPE_ID,
    oneWayPriceCentavos: 400_000,
    dayUsePriceCentavos: 900_000,
  });
  return route.insertId;
}

async function makeVan() {
  const suffix = unique();
  const [row] = await getDb()
    .insert(vans)
    .values({
      plate: `T25${suffix}`.slice(0, 20),
      model: 'T25 Fixture Van',
      capacity: 12,
      vehicleTypeId: VAN_TYPE_ID,
      status: 'available',
      isActive: true,
    });
  created.vanIds.push(row.insertId);
  return row.insertId;
}

async function makeDriver(maxTransferJobsPerDay: number) {
  const suffix = unique();
  const [row] = await getDb()
    .insert(drivers)
    .values({
      name: `T25 Fixture Driver ${suffix}`,
      code: `T25${suffix}`.slice(0, 20),
      phone: '09170000000',
      pinHash: await hashPassword('135791'),
      maxTransferJobsPerDay,
      isActive: true,
    });
  created.driverIds.push(row.insertId);
  return { id: row.insertId, code: `T25${suffix}`.slice(0, 20), pin: '135791' };
}

/** A structurally valid `createHoldTransferInput`, sent on the wire. */
function holdInput(over: Record<string, unknown> & { routeId: number }) {
  guestSeq += 1;
  return {
    vehicleTypeId: VAN_TYPE_ID,
    direction: 'forward' as const,
    productType: 'transfer_one_way' as const,
    date: DAY,
    pickupTime: '08:00',
    pax: 2,
    luggageCount: 1,
    pickup: 'Mactan-Cebu International Airport, Terminal 2 arrivals',
    dropoffAddress: 'A hotel in Cebu City',
    requests: '',
    payMode: 'deposit' as const,
    lead: {
      name: 'T25 Walkthrough Guest',
      email: `t25_guest_${guestSeq}_${Date.now()}@example.test`,
      phone: `0917${String(2_000_000 + guestSeq).slice(-7)}`,
    },
    consent: true,
    ...over,
  };
}

/** Holds a transfer through the real app, registering the booking for teardown. */
async function holdTransfer(input: ReturnType<typeof holdInput>) {
  const res = await mutate('checkout.createHoldTransfer', input);
  const result = unwrap(res) as { bookingId: number; ref: string };
  created.bookingIds.push(result.bookingId);
  return result;
}

/** Upload a receipt the way the portal screen does (identical to `phase1-walkthrough.test.ts`). */
async function uploadReceipt(cookie: string, txnRef: string) {
  return request(app)
    .post(`/api/receipts/upload?method=gcash&txnRef=${txnRef}&filename=receipt.jpg`)
    .set('Origin', ORIGIN)
    .set('Cookie', cookie)
    .set('Content-Type', 'image/jpeg')
    .send(JPEG);
}

async function staffSignIn(): Promise<string> {
  resetEmailThrottleForTests();
  const [staff] = await getDb()
    .select({ email: users.email })
    .from(users)
    .where(eq(users.id, staffId));
  const res = await mutate('staffAuth.login', { email: staff!.email, password: STAFF_PASSWORD });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return sessionCookie(res);
}

/**
 * Hold → portal sign-in → manual QR deposit → staff approval, through the
 * real app, ending `confirmed` with a balance still owed. The same shape
 * as `phase1-walkthrough.test.ts`'s `holdAndSignIn()` + its step-2 test,
 * specialised to a transfer and collapsed into one helper since every
 * `it()` below needs it at least once.
 */
async function holdPayAndConfirm(
  input: ReturnType<typeof holdInput>,
  staffCookie: string,
): Promise<{ bookingId: number; ref: string; guestCookie: string }> {
  const held = await holdTransfer(input);

  const login = await mutate('portal.login', { ref: held.ref, email: input.lead.email });
  expect(login.status, JSON.stringify(login.body)).toBe(200);
  const guestCookie = sessionCookie(login);

  const payment = (await query('portal.manualPayment', undefined, guestCookie)
    .expect(200)
    .then(unwrap)) as { amountDueCentavos: number };
  expect(payment.amountDueCentavos).toBeGreaterThan(0);

  const upload = await uploadReceipt(guestCookie, `T25GC${held.bookingId}`);
  expect(upload.status, JSON.stringify(upload.body)).toBe(200);

  const detail = (await query('admin.bookings.detail', { ref: held.ref }, staffCookie)
    .expect(200)
    .then(unwrap)) as { payments: Array<{ id: number; receiptPath: string | null }> };
  const pending = detail.payments.find((p) => p.receiptPath !== null)!;
  created.files.push(pending.receiptPath as unknown as string);

  const approved = await mutate(
    'admin.bookings.approveReceipt',
    { paymentId: pending.id },
    staffCookie,
  );
  expect(approved.status, JSON.stringify(approved.body)).toBe(200);

  const confirmed = (await query('portal.booking', undefined, guestCookie)
    .expect(200)
    .then(unwrap)) as { status: string; balanceCentavos: number };
  expect(confirmed.status).toBe('confirmed');
  expect(confirmed.balanceCentavos, 'a deposit must leave a balance').toBeGreaterThan(0);

  return { bookingId: held.bookingId, ref: held.ref, guestCookie };
}

/* ================================================================== *
 * Composition: two same-day jobs share one van and one driver; a third
 * is refused at the driver's daily cap. (T7/T8's own math is proven
 * elsewhere — see the file header.)
 * ================================================================== */

describeWithDb('T25 — transfer dispatch composition, through the real app', () => {
  it('assigns two non-overlapping same-day jobs to one van and one driver, then refuses a third at the cap', async () => {
    const routeId = await makeRoute();
    const vanId = await makeVan();
    /*
     * A DIFFERENT van from job A/B's, matching `dispatch-assign.test.ts`'s
     * own control pattern (its driver-cap test keeps the van unambiguous
     * too) — job C's window [14:00, 17:00) does not actually overlap
     * either earlier job's, so this van is never the thing that would have
     * refused it either way. It stays as a deliberate, if unnecessary,
     * belt-and-suspenders: nothing below depends on it being a confound.
     */
    const otherVanId = await makeVan();
    const driver = await makeDriver(2);
    /*
     * A hold's OWN capacity check (`assessTransferCapacity`, conditions
     * 4–5) is a date-wide JOB COUNT against the sum of every active
     * driver's cap — it has no notion of window overlap and runs before
     * any driver is chosen. Holding three jobs for one date against a
     * single driver of cap 2 would be refused `no_driver_available` at the
     * THIRD HOLD, before dispatch is ever reached — a true refusal, just
     * not the one this test is about. A second driver, unused in every
     * assignment below, gives the pool enough depth that all three holds
     * succeed, so the cap refusal this test proves happens where the plan
     * says it should: at `admin.dispatch.assign`, against one named
     * driver's identity.
     *
     * This is only sufficient because `rg_travel_test` seeds an EMPTY
     * fleet by design (`[seed] fleet: skipped` — this file's own drivers
     * are the only ones that exist for this run). A test database that
     * also seeded `SEED_DRIVERS` would push the pool's cap sum past 3 on
     * its own, and this second driver would be redundant rather than
     * load-bearing.
     */
    await makeDriver(8);
    const staffCookie = await staffSignIn();

    // Job A: [08:00, 11:00) at a 120-minute route + 60-minute buffer.
    const jobA = await holdPayAndConfirm(holdInput({ routeId, pickupTime: '08:00' }), staffCookie);
    // Job B: [11:00, 14:00) — starts exactly when job A's window ends, the
    // same boundary case `dispatch-assign.test.ts:1267` proves at the
    // router-caller level. Non-overlapping.
    const jobB = await holdPayAndConfirm(holdInput({ routeId, pickupTime: '11:00' }), staffCookie);
    // Job C: [14:00, 17:00) — also non-overlapping with A or B. A DIFFERENT
    // van, so only the driver's cap can be what refuses it.
    const jobC = await holdPayAndConfirm(holdInput({ routeId, pickupTime: '14:00' }), staffCookie);

    const assignA = await mutate(
      'admin.dispatch.assign',
      { bookingId: jobA.bookingId, vanId, driverId: driver.id },
      staffCookie,
    );
    expect(unwrap(assignA)).toEqual({ ok: true });

    const assignB = await mutate(
      'admin.dispatch.assign',
      { bookingId: jobB.bookingId, vanId, driverId: driver.id },
      staffCookie,
    );
    expect(
      unwrap(assignB),
      'a second non-overlapping job must share the same van and driver',
    ).toEqual({
      ok: true,
    });

    /*
     * `{ok:true}` alone does not prove the van half of this test's own
     * claim — a regression that cleared job A's `van_id` while assigning
     * job B would still return `{ok:true}` here, and job C below would
     * still be refused at the driver's cap (that refusal counts by
     * `driver_id` alone). Read both bookings back and pin the van AND the
     * driver on each, so the claim this test is named for is the claim it
     * actually cannot pass without.
     */
    const detailA = (await query('admin.bookings.detail', { ref: jobA.ref }, staffCookie)
      .expect(200)
      .then(unwrap)) as { vanId: number | null; driverId: number | null; status: string };
    expect(detailA, 'job A must still carry the shared van and driver').toMatchObject({
      vanId,
      driverId: driver.id,
      status: 'assigned',
    });
    const detailB = (await query('admin.bookings.detail', { ref: jobB.ref }, staffCookie)
      .expect(200)
      .then(unwrap)) as { vanId: number | null; driverId: number | null; status: string };
    expect(detailB, 'job B must carry the SAME van and driver as job A').toMatchObject({
      vanId,
      driverId: driver.id,
      status: 'assigned',
    });

    // The driver now carries two jobs against a cap of two — AT the cap,
    // not under it, so the refusal below is a genuine boundary case.
    const assignC = await mutate(
      'admin.dispatch.assign',
      { bookingId: jobC.bookingId, vanId: otherVanId, driverId: driver.id },
      staffCookie,
    );
    expect(assignC.status, JSON.stringify(assignC.body)).toBe(409);
    expect((assignC.body as { error: { message: string } }).error.message).toBe(
      'driver_at_daily_cap',
    );

    const detailC = (await query('admin.bookings.detail', { ref: jobC.ref }, staffCookie)
      .expect(200)
      .then(unwrap)) as { vanId: number | null; driverId: number | null; status: string };
    expect(detailC, 'the refused job must carry neither a van nor a driver').toMatchObject({
      vanId: null,
      driverId: null,
      status: 'confirmed',
    });
  }, 180_000);
});

/* ================================================================== *
 * Full lifecycle: one transfer booking, hold through check-in, through
 * the real app.
 * ================================================================== */

describeWithDb('T25 — a transfer booking, hold to review-eligible, through the real app', () => {
  it('walks hold → deposit → dispatch → check-in → review-eligible', async () => {
    const routeId = await makeRoute();
    const vanId = await makeVan();
    const driver = await makeDriver(8); // ample cap; this test is not about the cap
    const staffCookie = await staffSignIn();

    const booking = await holdPayAndConfirm(holdInput({ routeId }), staffCookie);

    const assigned = await mutate(
      'admin.dispatch.assign',
      { bookingId: booking.bookingId, vanId, driverId: driver.id },
      staffCookie,
    );
    expect(unwrap(assigned)).toEqual({ ok: true });

    const driverLogin = await mutate('driver.login', { code: driver.code, pin: driver.pin });
    expect(driverLogin.status, JSON.stringify(driverLogin.body)).toBe(200);
    const driverCookie = sessionCookie(driverLogin);

    // Before Start: the trip-start pseudo-stop is this transfer's only
    // stop — `total === 1` — and it has not happened yet (T22's own rule,
    // `driverTripDetail`).
    const before = (await query('driver.trip', { bookingId: booking.bookingId }, driverCookie)
      .expect(200)
      .then(unwrap)) as { progress: { done: number; total: number } };
    expect(before.progress).toMatchObject({ done: 0, total: 1 });

    const started = await mutate(
      'driver.startTrip',
      { bookingId: booking.bookingId },
      driverCookie,
    );
    expect(unwrap(started)).toMatchObject({
      ok: true,
      progress: { done: 1, total: 1, status: 'in_progress' },
    });

    /*
     * The semantics of this refusal (`checkInStop` reads `trip.tourId ===
     * null` before any stop lookup) are proven, including their own
     * mutation proof, by `driver-transfer-trip.test.ts` (T22). What this
     * assertion proves that file does not is that the refusal survives a
     * real driver login and the real HTTP stack.
     */
    const checkIn = await mutate(
      'driver.checkIn',
      { bookingId: booking.bookingId, stopId: 999_999 },
      driverCookie,
    );
    expect(unwrap(checkIn)).toEqual({ ok: false, reason: 'unknown_stop' });

    const completed = await mutate(
      'driver.completeTrip',
      { bookingId: booking.bookingId },
      driverCookie,
    );
    expect(unwrap(completed)).toMatchObject({ progress: { status: 'completed' } });

    // Review-eligible: the tracker's "Trip day" step reads `done: true` the
    // instant the booking is `completed` — the same fact
    // `phase1-walkthrough.test.ts`'s own tracker test proves for a tour.
    const final = (await query('portal.booking', undefined, booking.guestCookie)
      .expect(200)
      .then(unwrap)) as { status: string; tracker: Array<{ step: string; done: boolean }> };
    expect(final.status).toBe('completed');
    expect(final.tracker.map((s) => s.done)).toEqual([true, true, true, true, true]);
  }, 180_000);
});
