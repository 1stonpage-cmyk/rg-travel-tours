/**
 * Week 6 plan, Task 8 — `driver.recordCash`, BUILD_SPEC §8 item 5.
 *
 * **A driver's tap is a CLAIM, not a reconciliation**, and that sentence is
 * the whole subject of this file. The claim writes one `pending` `payments`
 * row and moves nothing on the booking; finance or the owner converts that
 * same row to `paid` and credits the booking (Task 11). The reason for the
 * split is a fraud path: a driver who could verify their own collection
 * could pocket the cash and leave the booking reading "paid in full".
 *
 * So the assertions that matter here are the negative ones:
 *
 *  1. **The booking does not move.** `amount_paid_centavos`, `status` and
 *     `payment_review_required` are snapshotted before and compared after,
 *     every time. This task added no second money path — the single row is
 *     written by `recordPendingCash()`, which owns it — and these three
 *     fields are what would betray one.
 *  2. **Exactly one claim per handful of cash**, counted over the booking
 *     this test owns and no other. A second tap is refused rather than
 *     merged, so the count is a real count and not a tolerance.
 *  3. **Today only, by the MANILA civil date** (owner-accepted 2026-10-15,
 *     Q9), refused on the SERVER and not merely hidden by Task 10's screen.
 *     The fixtures stand at **00:30 Manila**, inside the 00:00-07:59 window
 *     where the UTC calendar day is still yesterday: a UTC-based "today"
 *     accepts the previous day's trip and refuses the real one, and both
 *     assertions flip. A fixture outside that window passes against either
 *     implementation and proves nothing.
 *  4. **A driver cannot verify their own claim.** `verifyCashPayment()`
 *     already refuses a `driver` actor; it is asserted here, in the file
 *     about the driver's half, where someone might otherwise be tempted to
 *     add a shortcut.
 *
 * Errors are asserted on their `code` (or, for the service-level refusal,
 * on the error class), never on their wording.
 *
 * Fixtures are rebuilt per test and deleted in `afterEach` — the test
 * database keeps an EMPTY fleet (`capacity.test.ts` counts the whole
 * fleet), so every driver created here goes again. No van and no itinerary
 * stop: `bookings.van_id` is nullable and nothing on this path reads a
 * stop, so the smallest fixture that exercises it is the one that cannot
 * leak. `audit_log` is deliberately not cleaned — it is append-only and
 * nothing counts it to make a decision (`global-setup.ts`).
 */
import { afterEach, beforeEach, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { manilaCivilDate, type PriceSnapshot } from '@rg/shared';
import { getDb, getPool } from '../db/client';
import { bookings, destinations, drivers, tours } from '../db/schema';
import { generateBookingRef } from '../services/booking-ref';
import { recordDriverCash } from '../routers/public/driver';
import { verifyCashPayment } from '../services/payments/record-payment';
import { PaymentVerificationNotPermittedError } from '../services/payments/errors';
import { driverCaller } from './helpers/ctx';
import { describeWithDb } from './helpers/db';

/** Random first, timestamp second — same discipline as capacity.test.ts. */
const unique = () => `${Math.floor(Math.random() * 1e9)}_${Date.now()}`;

/** The minimum snapshot `bookings.price_snapshot` will accept. No test reads it. */
const SNAPSHOT: PriceSnapshot = {
  tier: { tierId: 1, minPax: 1, maxPax: 12, pricePerPersonCentavos: 100000 },
  addons: [],
  coupon: null,
  depositPercent: 30,
  freeCancelHours: 48,
  subtotalCentavos: 100000,
  discountCentavos: 0,
  totalCentavos: 100000,
};

/** The trip's price, in centavos. */
const TOTAL = 400_000;
/** A 30% deposit on `TOTAL`, so the balance is an exact, non-round figure. */
const DEPOSIT = 120_000;
/** ₱2,800.00 — what the guest owes, and therefore what the claim must say. */
const BALANCE = TOTAL - DEPOSIT;

/**
 * 00:30 Manila on 2026-03-10, expressed as the UTC instant it is.
 *
 * The UTC calendar day at this instant is **the 9th**, which is the trap:
 * `UTC_DAY` below is a real trip on a real date that a UTC-based "today"
 * would accept and Manila must refuse.
 */
const NOW_0030_MANILA = new Date('2026-03-09T16:30:00Z');
const MANILA_TODAY = '2026-03-10';
const UTC_DAY = '2026-03-09';
const MANILA_TOMORROW = '2026-03-11';

const created = {
  bookingIds: [] as number[],
  tourIds: [] as number[],
  destIds: [] as number[],
  driverIds: [] as number[],
};

async function count(statement: Parameters<ReturnType<typeof getDb>['execute']>[0]) {
  const [rows] = (await getDb().execute(statement)) as unknown as [Array<{ n: number }>, unknown];
  return Number(rows[0]?.n ?? -1);
}

/** Claims against ONE booking — the only booking this test owns. */
async function claimCount(bookingId: number): Promise<number> {
  const [rows] = (await getPool().query('SELECT COUNT(*) n FROM payments WHERE booking_id = ?', [
    bookingId,
  ])) as unknown as [Array<{ n: number }>, unknown];
  return Number(rows[0]?.n ?? -1);
}

async function paymentRow(paymentId: number): Promise<Record<string, unknown>> {
  const [rows] = (await getPool().query('SELECT * FROM payments WHERE id = ?', [
    paymentId,
  ])) as unknown as [Array<Record<string, unknown>>, unknown];
  const row = rows[0];
  if (!row) throw new Error(`no payments row ${paymentId}`);
  return row;
}

async function auditRowsFor(paymentId: number): Promise<Array<Record<string, unknown>>> {
  const [rows] = (await getPool().query(
    "SELECT * FROM audit_log WHERE entity = 'payments' AND entity_id = ? ORDER BY id",
    [paymentId],
  )) as unknown as [Array<Record<string, unknown>>, unknown];
  return rows;
}

/** The three fields a driver's claim must leave exactly as it found them. */
interface BookingMoney {
  amountPaidCentavos: number;
  status: string;
  paymentReviewRequired: number;
}

async function bookingMoney(bookingId: number): Promise<BookingMoney> {
  const [rows] = (await getPool().query(
    'SELECT amount_paid_centavos, status, payment_review_required FROM bookings WHERE id = ?',
    [bookingId],
  )) as unknown as [Array<Record<string, unknown>>, unknown];
  const row = rows[0];
  if (!row) throw new Error(`no booking ${bookingId}`);
  return {
    amountPaidCentavos: Number(row.amount_paid_centavos),
    status: String(row.status),
    paymentReviewRequired: Number(row.payment_review_required),
  };
}

async function makeDriver(label: string): Promise<number> {
  const suffix = unique();
  const [driver] = await getDb()
    .insert(drivers)
    .values({
      name: `Cash ${label} ${suffix}`,
      code: `DC${suffix}`.slice(0, 20),
      phone: '09170000002',
      // Not a real hash: nothing here logs in, it arrives with a session
      // already (which is what `driverCaller` is).
      pinHash: '__drivercash_not_a_pin_hash__',
      isActive: true,
    });
  created.driverIds.push(driver.insertId);
  return driver.insertId;
}

async function makeBooking(opts: {
  driverId: number;
  tourDate: string;
  paidCentavos?: number;
  status?: 'assigned' | 'in_progress';
}): Promise<{ id: number; ref: string }> {
  const ref = generateBookingRef();
  const [booking] = await getDb()
    .insert(bookings)
    .values({
      ref,
      tourId,
      tourDate: new Date(`${opts.tourDate}T00:00:00Z`),
      pax: 4,
      leadName: 'Cash Lead Guest',
      leadEmail: 'driver-cash-lead@example.test',
      leadPhone: '09171234567',
      pickup: 'Radisson Blu lobby',
      status: opts.status ?? 'in_progress',
      payMode: 'deposit',
      priceSnapshot: { ...SNAPSHOT, subtotalCentavos: TOTAL, totalCentavos: TOTAL },
      subtotalCentavos: TOTAL,
      totalCentavos: TOTAL,
      // The fixture sets the column directly because only the payments
      // service may move it in application code (CLAUDE.md, A5b) and this
      // file is not that service — it is describing a booking that already
      // took a deposit.
      amountPaidCentavos: opts.paidCentavos ?? DEPOSIT,
      paymentReviewRequired: false,
      vanId: null,
      driverId: opts.driverId,
    });
  created.bookingIds.push(booking.insertId);
  return { id: booking.insertId, ref };
}

let tourId = 0;
let driverA = 0;
let driverB = 0;
/** The real Manila today, for the tests that go through the mounted router. */
let TODAY = '';

describeWithDb('driver.recordCash', () => {
  beforeEach(async () => {
    const db = getDb();
    // Read per test, not at module load: the mounted procedure reads the
    // clock per call, so a run straddling Manila midnight would otherwise
    // compare a fixture built against yesterday with a resolver answering
    // for today (the flake driver-trips.test.ts fixed in review).
    TODAY = manilaCivilDate(new Date());

    expect(
      await count(sql`SELECT COUNT(*) n FROM drivers`),
      'leftover drivers in rg_travel_test',
    ).toBe(0);

    const slug = `__drivercash__${unique()}`;
    const [destination] = await db.insert(destinations).values({ name: slug, slug });
    created.destIds.push(destination.insertId);
    const [tour] = await db.insert(tours).values({
      slug,
      title: `Cash Tour ${slug}`,
      destinationId: destination.insertId,
      isActive: true,
    });
    created.tourIds.push(tour.insertId);
    tourId = tour.insertId;

    driverA = await makeDriver('A');
    driverB = await makeDriver('B');
  }, 30_000);

  afterEach(async () => {
    const pool = getPool();
    for (const id of created.bookingIds) {
      await pool.query('DELETE FROM payments WHERE booking_id = ?', [id]);
      await pool.query('DELETE FROM bookings WHERE id = ?', [id]);
    }
    for (const id of created.tourIds) await pool.query('DELETE FROM tours WHERE id = ?', [id]);
    for (const id of created.destIds) {
      await pool.query('DELETE FROM destinations WHERE id = ?', [id]);
    }
    for (const id of created.driverIds) await pool.query('DELETE FROM drivers WHERE id = ?', [id]);
    created.bookingIds = [];
    created.tourIds = [];
    created.destIds = [];
    created.driverIds = [];
  });

  /* ---------------------------------------------------------------- *
   * The claim itself.
   * ---------------------------------------------------------------- */

  it('writes ONE pending claim for the exact balance, naming the driver who took it', async () => {
    const booking = await makeBooking({ driverId: driverA, tourDate: TODAY });

    const result = await driverCaller(driverA).driver.recordCash({ bookingId: booking.id });

    // The amount is DERIVED: ₱4,000.00 less a ₱1,200.00 deposit. The input
    // carries no figure, so this is the server's arithmetic or nothing.
    expect(result.amountCentavos).toBe(BALANCE);

    const row = await paymentRow(result.paymentId);
    expect(row).toMatchObject({
      status: 'pending',
      type: 'payment',
      provider: 'manual',
      method: 'cash',
    });
    expect(Number(row.amount_centavos)).toBe(BALANCE);
    expect(Number(row.booking_id)).toBe(booking.id);
    expect(Number(row.collected_by_driver_id), 'the claim does not name its driver').toBe(driverA);
    expect(row.verified_by, 'an unverified claim carries a verifier').toBeNull();
    expect(row.verified_at).toBeNull();

    // One row, over the booking this test owns.
    expect(await claimCount(booking.id)).toBe(1);
  });

  it('audits the claim as the DRIVER, once', async () => {
    const booking = await makeBooking({ driverId: driverA, tourDate: TODAY });

    const { paymentId } = await driverCaller(driverA).driver.recordCash({ bookingId: booking.id });

    const rows = await auditRowsFor(paymentId);
    // One row, not two: `recordPendingCash()` writes
    // `payment.cash_collected` itself and the procedure adds nothing on top.
    expect(rows).toHaveLength(1);
    const audit = rows[0]!;
    expect(audit.actor_type, '§10: a driver collection is a `driver` actor').toBe('driver');
    expect(Number(audit.actor_id)).toBe(driverA);
    expect(audit.action).toBe('payment.cash_collected');
    const data = typeof audit.data === 'string' ? JSON.parse(audit.data) : audit.data;
    expect(data).toMatchObject({
      bookingRef: booking.ref,
      amountCentavos: BALANCE,
      method: 'cash',
      paymentStatus: 'pending',
    });
  });

  /**
   * **The test that matters most.** A claim is not a reconciliation, so all
   * three fields must read afterwards exactly as they read before. Crediting
   * `amount_paid_centavos` here would leave the booking saying the money is
   * in while nobody at head office has counted it — which is the state the
   * whole claim/verify split exists to make impossible.
   */
  it('leaves the booking exactly where it found it — paid, status and review flag', async () => {
    const booking = await makeBooking({ driverId: driverA, tourDate: TODAY });
    const before = await bookingMoney(booking.id);
    expect(before).toEqual<BookingMoney>({
      amountPaidCentavos: DEPOSIT,
      status: 'in_progress',
      paymentReviewRequired: 0,
    });

    await driverCaller(driverA).driver.recordCash({ bookingId: booking.id });

    const after = await bookingMoney(booking.id);
    expect(after.amountPaidCentavos, 'a driver credited the booking').toBe(
      before.amountPaidCentavos,
    );
    expect(after.status, 'a driver moved the booking status').toBe(before.status);
    expect(after.paymentReviewRequired, 'a driver raised the review flag').toBe(
      before.paymentReviewRequired,
    );
  });

  /* ---------------------------------------------------------------- *
   * Whose booking it is — the session, and nothing else.
   * ---------------------------------------------------------------- */

  it("refuses another driver's booking, and claims nothing against it", async () => {
    const booking = await makeBooking({ driverId: driverA, tourDate: TODAY });

    await expect(
      driverCaller(driverB).driver.recordCash({ bookingId: booking.id }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });

    expect(await claimCount(booking.id), "driver B claimed driver A's cash").toBe(0);
  });

  /* ---------------------------------------------------------------- *
   * Today only (Q9), by the Manila civil date, at 00:30 Manila.
   * ---------------------------------------------------------------- */

  it("accepts the trip dated today in MANILA at 00:30, when the UTC day is still yesterday's", async () => {
    const booking = await makeBooking({ driverId: driverA, tourDate: MANILA_TODAY });

    const result = await recordDriverCash(driverA, booking.id, NOW_0030_MANILA);

    expect(result.amountCentavos).toBe(BALANCE);
    expect(await claimCount(booking.id)).toBe(1);
  });

  it('refuses a trip dated tomorrow, and claims nothing', async () => {
    const booking = await makeBooking({ driverId: driverA, tourDate: MANILA_TOMORROW });

    await expect(recordDriverCash(driverA, booking.id, NOW_0030_MANILA)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });

    expect(await claimCount(booking.id), "a mis-tap claimed next week's cash").toBe(0);
  });

  /**
   * The case a UTC-based "today" gets wrong. At 00:30 Manila on the 10th the
   * UTC day is the 9th, so a `toISOString().slice(0, 10)` implementation
   * would accept THIS trip — yesterday's, already driven — and refuse the
   * one above it.
   */
  it("refuses yesterday's trip even though it is the current UTC day", async () => {
    const booking = await makeBooking({ driverId: driverA, tourDate: UTC_DAY });

    await expect(recordDriverCash(driverA, booking.id, NOW_0030_MANILA)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });

    expect(await claimCount(booking.id), 'the UTC day was taken for the Manila day').toBe(0);
  });

  /* ---------------------------------------------------------------- *
   * Nothing to collect.
   * ---------------------------------------------------------------- */

  it('refuses a second tap while the first claim is unverified, leaving exactly one claim', async () => {
    const booking = await makeBooking({ driverId: driverA, tourDate: TODAY });
    const caller = driverCaller(driverA);

    await caller.driver.recordCash({ bookingId: booking.id });
    await expect(caller.driver.recordCash({ bookingId: booking.id })).rejects.toMatchObject({
      code: 'CONFLICT',
    });

    expect(await claimCount(booking.id), 'one handful of cash became two claims').toBe(1);
  });

  it('refuses a trip that owes nothing', async () => {
    const booking = await makeBooking({
      driverId: driverA,
      tourDate: TODAY,
      paidCentavos: TOTAL,
    });

    await expect(
      driverCaller(driverA).driver.recordCash({ bookingId: booking.id }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });

    expect(await claimCount(booking.id)).toBe(0);
  });

  /* ---------------------------------------------------------------- *
   * The other half, and why the split exists.
   * ---------------------------------------------------------------- */

  /**
   * A driver who could verify their own collection could pocket the cash and
   * leave the booking reading "paid in full". `verifyCashPayment()` refuses
   * a `driver` actor outright — even one carrying a finance role, because
   * the role is re-parsed and the actor TYPE is what decides — and the row
   * stays `pending` with the booking untouched.
   */
  it('will not let the driver verify their own claim, even claiming a finance role', async () => {
    const booking = await makeBooking({ driverId: driverA, tourDate: TODAY });
    const { paymentId } = await driverCaller(driverA).driver.recordCash({ bookingId: booking.id });
    const before = await bookingMoney(booking.id);

    await expect(
      verifyCashPayment({
        paymentId,
        verifier: { type: 'driver', id: driverA, role: 'finance' },
      }),
    ).rejects.toBeInstanceOf(PaymentVerificationNotPermittedError);

    expect((await paymentRow(paymentId)).status, 'a driver verified their own cash').toBe(
      'pending',
    );
    expect(await bookingMoney(booking.id)).toEqual(before);
  });
});
