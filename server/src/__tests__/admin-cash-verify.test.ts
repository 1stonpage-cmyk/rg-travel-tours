/**
 * Week 6 plan, Task 11 — the CASH half of the verification queue
 * (BUILD_SPEC §13's 6E, §8 item 5, §9's "Verify payments" row).
 *
 * Week 4 Task 7 built the receipt half of this queue and `verifyCashPayment()`
 * has been tested at the service level since A5b. What did not exist was the
 * surface: `admin.bookings.list`'s `awaitingVerification` filter required a
 * `receipt_path`, so every peso a driver claimed was invisible to the one
 * screen whose job is to reconcile it, `detail` returned the cash row with no
 * hint of WHO claimed it, and no procedure anywhere called
 * `verifyCashPayment`. This file is about that surface.
 *
 * **A driver's tap is a claim; an admin's approval is the reconciliation.**
 * The fraud path the separation closes: a driver who could verify their own
 * collection could pocket the cash and leave the booking reading "paid in
 * full". So the assertions that matter are:
 *
 *  1. **The claim is visible, and names its claimant.** "Who says they took
 *     this money" is the question finance is answering; a `collected_by_
 *     driver_id` nobody resolves to a name is not an answer.
 *  2. **Credited exactly once**, including when two finance users click at
 *     the same moment. The concurrent test below runs two genuinely
 *     OVERLAPPING transactions — `Promise.allSettled` over two in-flight
 *     mutations, not a sequential pair — and was proven by removing
 *     `.for('update')` from the PAYMENT re-read in
 *     `verifyPendingManualPayment`, which turns it red: both approvals then
 *     succeed and the cash is credited twice. (Removing it from the BOOKING
 *     lock does NOT turn it red, because the locking re-read of the payment
 *     row is itself a serialisation point — see the note on that test. The
 *     booking lock is still what fixes the lock ORDER every capacity path
 *     shares.) A sequential pair survives both mutations and would prove
 *     nothing.
 *  3. **No second `payments` row.** One handful of cash is one row for its
 *     whole life, so the row count for the booking this test owns is taken
 *     before and after every approval.
 *  4. **Only owner and finance.** `ROLE_MATRIX.verifyPayments` is
 *     `['owner', 'finance']`: a dispatcher is refused, and a DRIVER session
 *     is not an admin identity at all. Asserted on the error `code`, never
 *     the wording.
 *
 * Nothing in this file MOVES money through anything but the services that own
 * it — the claim comes from `recordPendingCash()` and the credit from the
 * mounted procedure. The fixture sets `amount_paid_centavos` once, at INSERT,
 * to describe a booking that already took its deposit, and
 * `insertReceiptPayment()` writes one `pending` row that credits nothing, to
 * describe a row shape the cash path must refuse (see its own note).
 *
 * `recordPendingCash()` rather than `driver.recordCash` for the claim: that
 * procedure is Manila-today-only (Task 8, owner Q9) and tested there, and a
 * fixture pinned to today's date would make this file's tour dates move under
 * it. The row it writes is identical.
 *
 * Fixtures are rebuilt per test and deleted in `afterEach` — the test
 * database keeps an EMPTY fleet (`capacity.test.ts` counts the whole fleet),
 * so every driver created here goes again, and so does every `users` row.
 * `audit_log` is deliberately not cleaned: it is append-only and nothing here
 * counts it to make a decision.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { and, asc, eq, sql } from 'drizzle-orm';
import type { AdminRole, PriceSnapshot } from '@rg/shared';
import { getDb, getPool } from '../db/client';
import { auditLog, bookings, destinations, drivers, payments, tours, users } from '../db/schema';
import { ROLE_MATRIX } from '../middleware/require-role';
import { generateBookingRef } from '../services/booking-ref';
import {
  CashPaymentNotFoundError,
  CashPaymentNotPendingError,
  CashRejectionNeedsReasonError,
  PaymentVerificationNotPermittedError,
} from '../services/payments/errors';
import { recordPendingCash, rejectCashPayment } from '../services/payments/record-payment';
import { driverTripDetail, recordDriverCash } from '../routers/public/driver';
import { appRouter } from '../routers/_app';
import { driverCaller, staffContext } from './helpers/ctx';
import { describeWithDb } from './helpers/db';

/** Random first, timestamp second — same discipline as capacity.test.ts. */
const unique = () => `${Math.floor(Math.random() * 1e9)}_${Date.now()}`;

/** The trip's price, in centavos. */
const TOTAL = 400_000;
/** A 30% deposit on `TOTAL`. */
const DEPOSIT = 120_000;
/** ₱2,800.00 — the balance a driver collects at the end of the trip. */
const BALANCE = TOTAL - DEPOSIT;

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

/** Far future, so no other suite's date filter can collide with these rows. */
const TOUR_DATE = '2099-07-04';

const created = {
  bookingIds: [] as number[],
  tourIds: [] as number[],
  destIds: [] as number[],
  driverIds: [] as number[],
  userIds: [] as number[],
};

async function scalar(statement: Parameters<ReturnType<typeof getDb>['execute']>[0]) {
  const [rows] = (await getDb().execute(statement)) as unknown as [Array<{ n: number }>, unknown];
  return Number(rows[0]?.n ?? -1);
}

/** Payment rows for ONE booking — the only booking a given test owns. */
async function paymentCount(bookingId: number): Promise<number> {
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

/** The three fields an approval may move, and a refusal may not. */
async function bookingMoney(bookingId: number) {
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

/**
 * The audit rows about one entity, oldest first.
 *
 * `audit_log` is append-only and nothing cleans it (see the file note), so
 * these are scoped to a payment id this test created and nothing wider.
 */
async function auditRowsFor(entity: string, entityId: number) {
  return getDb()
    .select({
      action: auditLog.action,
      actorType: auditLog.actorType,
      actorId: auditLog.actorId,
      data: auditLog.data,
    })
    .from(auditLog)
    .where(and(eq(auditLog.entity, entity), eq(auditLog.entityId, entityId)))
    .orderBy(asc(auditLog.id));
}

/**
 * A guest's RECEIPT row — the shape the cash path must refuse (D2).
 *
 * Inserted directly, which is the one exception to this file's "only the
 * services that own them write `payments`" rule, and deliberately so: there
 * is no money in this row to get wrong (`status='pending'` credits nothing)
 * and `recordManualReceipt()` cannot write it against this fixture anyway,
 * because that service refuses an `in_progress` booking as `already_paid`.
 * What the test needs is a row SHAPE — manual, not cash, no driver — and a
 * second booking in two more statuses to obtain it legitimately would prove
 * less, not more.
 */
async function insertReceiptPayment(bookingId: number): Promise<number> {
  const [row] = await getDb().insert(payments).values({
    bookingId,
    type: 'payment',
    provider: 'manual',
    method: 'bank_transfer',
    amountCentavos: 100,
    status: 'pending',
    receiptPath: 'ffffffffffffffffffffffffffffffff.jpg',
    collectedByDriverId: null,
  });
  return row.insertId;
}

async function makeDriver(name: string): Promise<{ id: number; name: string }> {
  const suffix = unique();
  const fullName = `${name} ${suffix}`;
  const [driver] = await getDb()
    .insert(drivers)
    .values({
      name: fullName,
      code: `CV${suffix}`.slice(0, 20),
      phone: '09170000003',
      pinHash: '__admincash_not_a_pin_hash__',
      isActive: true,
    });
  created.driverIds.push(driver.insertId);
  return { id: driver.insertId, name: fullName };
}

async function makeStaff(role: AdminRole): Promise<number> {
  const suffix = unique();
  const [row] = await getDb()
    .insert(users)
    .values({
      name: `Admin ${role} ${suffix}`,
      email: `admincash_${role}_${suffix}@example.test`,
      passwordHash: '__admincash_fixture_not_a_hash__',
      role,
      isActive: true,
    });
  created.userIds.push(row.insertId);
  return row.insertId;
}

/**
 * A booking mid-trip that has paid its deposit and owes the balance — the
 * only shape a driver ever collects cash against.
 */
async function makeBooking(driverId: number): Promise<{ id: number; ref: string }> {
  const ref = generateBookingRef();
  const [booking] = await getDb()
    .insert(bookings)
    .values({
      ref,
      tourId,
      tourDate: new Date(`${TOUR_DATE}T00:00:00Z`),
      pax: 4,
      leadName: 'Cash Verify Guest',
      leadEmail: 'admin-cash-verify@example.test',
      leadPhone: '09171234567',
      status: 'in_progress',
      payMode: 'deposit',
      priceSnapshot: SNAPSHOT,
      subtotalCentavos: TOTAL,
      totalCentavos: TOTAL,
      /*
       * Set at INSERT because only `record-payment.ts` may MOVE this column
       * in application code (CLAUDE.md), and this fixture is not moving it:
       * it is describing a booking that already took a deposit.
       */
      amountPaidCentavos: DEPOSIT,
      paymentReviewRequired: false,
      holdExpiresAt: null,
      vanId: null,
      driverId,
    });
  created.bookingIds.push(booking.insertId);
  return { id: booking.insertId, ref };
}

const apiFor = (userId: number, role: AdminRole) =>
  appRouter.createCaller(staffContext(userId, role) as never);

let tourId = 0;
let owner = 0;
let dispatcher = 0;
let finance = 0;

/**
 * The gate, read off the procedure as MOUNTED — no database needed.
 *
 * Why this exists beside the dispatcher refusal below: that refusal survives
 * a widened `adminProcedure(area)`, because `verifyCashPayment()` keeps its
 * own role check and refuses a dispatcher on its own behalf. Two independent
 * gates is the right design (the service is callable from a job, where there
 * is no tRPC context) but it means the behavioural test cannot tell which one
 * answered. This one pins the transport gate directly, so swapping the area
 * for a wider one is caught here rather than silently leaning on the
 * service's.
 *
 * The roles are compared against `ROLE_MATRIX`, never against a literal pair
 * — §9's table is transcribed exactly once and this must not become a second
 * copy of it.
 */
it('declares §9’s verifyPayments gate on the mounted procedure', () => {
  const mounted = (
    appRouter as unknown as {
      _def: { procedures: Record<string, { _def?: { meta?: unknown } }> };
    }
  )._def.procedures;
  expect(mounted['admin.bookings.approveCash'], 'approveCash is not mounted').toBeDefined();
  expect(mounted['admin.bookings.approveCash']?._def?.meta).toMatchObject({
    access: 'admin',
    area: 'verifyPayments',
    roles: ROLE_MATRIX.verifyPayments,
  });
  /*
   * And its refusal half (D2). The same gate for the same reason: refusing a
   * claim is `verifyPayments` being exercised just as much as approving one,
   * so a dispatcher is refused at the transport and not only by the
   * service's own check.
   */
  expect(mounted['admin.bookings.rejectCash'], 'rejectCash is not mounted').toBeDefined();
  expect(mounted['admin.bookings.rejectCash']?._def?.meta).toMatchObject({
    access: 'admin',
    area: 'verifyPayments',
    roles: ROLE_MATRIX.verifyPayments,
  });
});

describeWithDb('admin.bookings — the cash a driver says they took', () => {
  beforeEach(async () => {
    const db = getDb();
    expect(
      await scalar(sql`SELECT COUNT(*) n FROM drivers`),
      'leftover drivers in rg_travel_test',
    ).toBe(0);

    const slug = `__admincash__${unique()}`;
    const [destination] = await db.insert(destinations).values({ name: slug, slug });
    created.destIds.push(destination.insertId);
    const [tour] = await db.insert(tours).values({
      slug,
      title: `Cash Verify Tour ${slug}`,
      destinationId: destination.insertId,
      isActive: true,
    });
    created.tourIds.push(tour.insertId);
    tourId = tour.insertId;

    owner = await makeStaff('owner');
    dispatcher = await makeStaff('dispatcher');
    finance = await makeStaff('finance');
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
    for (const id of created.userIds) {
      await pool.query('DELETE FROM sessions WHERE subject_type = ? AND subject_id = ?', [
        'user',
        id,
      ]);
      await pool.query('DELETE FROM users WHERE id = ?', [id]);
    }
    created.bookingIds = [];
    created.tourIds = [];
    created.destIds = [];
    created.driverIds = [];
    created.userIds = [];
  });

  /**
   * 1. The claim reaches the queue, and it names its claimant.
   *
   * Two assertions on one surface: the FILTER finds a cash-only booking (it
   * required a `receipt_path` before this task, so a driver's claim was
   * invisible), and the screen finance then opens says who made it. There is
   * no receipt on this booking at all — if the filter still keyed on a file,
   * this ref would simply be absent.
   */
  it('shows a driver-collected pending claim in the queue, with the driver named', async () => {
    const driver = await makeDriver('Noel Cuizon');
    const booking = await makeBooking(driver.id);
    const { paymentId } = await recordPendingCash({
      bookingId: booking.id,
      amountCentavos: BALANCE,
      collectedByDriverId: driver.id,
    });

    const queue = await apiFor(finance, 'finance').admin.bookings.list({
      awaitingVerification: true,
      limit: 100,
    });
    expect(
      queue.items.map((item) => item.ref),
      'a cash-only claim did not reach the verification queue',
    ).toContain(booking.ref);

    const detail = await apiFor(finance, 'finance').admin.bookings.detail({ ref: booking.ref });
    const cash = detail.payments.find((payment) => payment.id === paymentId);
    expect(cash).toMatchObject({
      provider: 'manual',
      method: 'cash',
      status: 'pending',
      amountCentavos: BALANCE,
      collectedByDriverId: driver.id,
      collectedByDriverName: driver.name,
    });
    // The claim moved nothing on the booking — that is Task 8's guarantee,
    // restated here because everything below depends on it.
    expect(await bookingMoney(booking.id)).toMatchObject({
      amountPaidCentavos: DEPOSIT,
      status: 'in_progress',
      paymentReviewRequired: 0,
    });
  });

  /**
   * 2. Finance approves, the money lands once, and no second row appears.
   *
   * The row count is taken before and after. `verified_by` is read off the
   * row rather than inferred: an approval nobody can attribute is not a
   * reconciliation.
   */
  it('credits the balance exactly once when finance approves, inserting no second row', async () => {
    const driver = await makeDriver('Jun Patalinghug');
    const booking = await makeBooking(driver.id);
    const { paymentId } = await recordPendingCash({
      bookingId: booking.id,
      amountCentavos: BALANCE,
      collectedByDriverId: driver.id,
    });

    const before = await paymentCount(booking.id);
    expect(before, 'the claim should be the only payments row').toBe(1);

    const result = await apiFor(finance, 'finance').admin.bookings.approveCash({ paymentId });
    expect(result).toMatchObject({ bookingStatus: 'in_progress', paymentReviewRequired: false });

    expect(await paymentCount(booking.id), 'approving inserted a second payments row').toBe(before);
    expect(await bookingMoney(booking.id)).toMatchObject({
      amountPaidCentavos: TOTAL,
      // A trip that ran does not walk backwards to `confirmed`.
      status: 'in_progress',
      paymentReviewRequired: 0,
    });

    const row = await paymentRow(paymentId);
    expect(row.status).toBe('paid');
    expect(Number(row.verified_by)).toBe(finance);
    expect(row.verified_at).not.toBeNull();
    // The claimant is still on the row: the trail says who took it AND who
    // counted it.
    expect(Number(row.collected_by_driver_id)).toBe(driver.id);

    // And it leaves the queue, because that is what "handled" means.
    const queue = await apiFor(finance, 'finance').admin.bookings.list({
      awaitingVerification: true,
      limit: 100,
    });
    expect(queue.items.map((item) => item.ref)).not.toContain(booking.ref);
  });

  /**
   * 3. Two finance users click at the same moment.
   *
   * **Genuinely overlapping**, which is the only version of this test worth
   * having: both mutations are in flight before either commits, so both open
   * a transaction and both read the claim as `pending` before the booking
   * lock sequences them. The loser's locking re-read then sees `paid` and is
   * refused with `CONFLICT`.
   *
   * **Proven**, and the mutation that proves it is not the obvious one.
   * Removing `.for('update')` from the BOOKING lock leaves this green —
   * because the locking re-read of the payments row is itself a
   * serialisation point, so the pair is still ordered. The mutation that
   * turns it red is removing `.for('update')` from that re-read: the loser's
   * pre-lock REPEATABLE READ snapshot then still says `pending`, it passes
   * the check, and the cash is credited twice (observed: both approvals
   * fulfilled). The booking lock is still load-bearing — it is what fixes
   * the lock ORDER every capacity path shares, CLAUDE.md's absolute rule —
   * but it is not what makes this particular credit happen once.
   *
   * **The cash here is a PART of the balance, on purpose.** At the full
   * balance a double credit also breaches the overpay cap, so the cap
   * refuses the second writer as a side effect and this test would stay
   * green with the real pending check removed. 100,000 twice fits inside the
   * 280,000 still owed, so nothing but the pending check stands between this
   * booking and being credited twice — and the refusal's `code` is asserted
   * as well, because `CONFLICT` is that check and `BAD_REQUEST` would be the
   * cap standing in for it.
   */
  it('serialises two concurrent approvals: credited once, the second refused', async () => {
    /** Part of the balance: small enough that a double credit would FIT. */
    const PART = 100_000;
    const driver = await makeDriver('Rico Abella');
    const booking = await makeBooking(driver.id);
    const { paymentId } = await recordPendingCash({
      bookingId: booking.id,
      amountCentavos: PART,
      collectedByDriverId: driver.id,
    });

    const results = await Promise.allSettled([
      apiFor(owner, 'owner').admin.bookings.approveCash({ paymentId }),
      apiFor(finance, 'finance').admin.bookings.approveCash({ paymentId }),
    ]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(fulfilled, 'both approvals succeeded — the cash was counted twice').toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(
      (rejected[0] as PromiseRejectedResult).reason,
      'the loser was refused by something other than the pending check',
    ).toMatchObject({ code: 'CONFLICT' });

    expect(await bookingMoney(booking.id), 'the cash was credited more than once').toMatchObject({
      amountPaidCentavos: DEPOSIT + PART,
    });
    expect(await paymentCount(booking.id), 'a second payments row appeared').toBe(1);
    expect((await paymentRow(paymentId)).status).toBe('paid');
  });

  /**
   * 4. The sequential double-click, kept beside the race because it is the
   * one a human actually does.
   */
  it('REFUSES a second approval of a claim already counted', async () => {
    const driver = await makeDriver('Edgar Lumapas');
    const booking = await makeBooking(driver.id);
    const { paymentId } = await recordPendingCash({
      bookingId: booking.id,
      amountCentavos: BALANCE,
      collectedByDriverId: driver.id,
    });

    const api = apiFor(finance, 'finance');
    await expect(api.admin.bookings.approveCash({ paymentId })).resolves.toBeDefined();
    await expect(api.admin.bookings.approveCash({ paymentId })).rejects.toMatchObject({
      code: 'CONFLICT',
    });

    expect(await bookingMoney(booking.id)).toMatchObject({ amountPaidCentavos: TOTAL });
    expect(await paymentCount(booking.id)).toBe(1);
  });

  /**
   * 5. **A driver cannot approve their own claim.** This is the fraud path
   * the whole split exists to close, and it is refused twice over: a driver
   * session is not an admin identity (`UNAUTHORIZED` from the gate), and
   * `verifyCashPayment()` refuses a `driver` actor on its own behalf even
   * when called with no tRPC context at all (asserted at the service level
   * in `record-payment.test.ts`).
   */
  it('REFUSES a driver session, crediting nothing', async () => {
    const driver = await makeDriver('Boy Tabangay');
    const booking = await makeBooking(driver.id);
    const { paymentId } = await recordPendingCash({
      bookingId: booking.id,
      amountCentavos: BALANCE,
      collectedByDriverId: driver.id,
    });

    await expect(
      driverCaller(driver.id).admin.bookings.approveCash({ paymentId }),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });

    expect(await bookingMoney(booking.id)).toMatchObject({ amountPaidCentavos: DEPOSIT });
    expect((await paymentRow(paymentId)).status).toBe('pending');
    expect(await paymentCount(booking.id)).toBe(1);
  });

  /**
   * 6. §9's row, both directions: `ROLE_MATRIX.verifyPayments` is
   * `['owner', 'finance']`. A dispatcher may run the day and assign a van;
   * they may not decide that money arrived.
   */
  it('REFUSES a dispatcher, crediting nothing', async () => {
    const driver = await makeDriver('Mila Sarmiento');
    const booking = await makeBooking(driver.id);
    const { paymentId } = await recordPendingCash({
      bookingId: booking.id,
      amountCentavos: BALANCE,
      collectedByDriverId: driver.id,
    });

    await expect(
      apiFor(dispatcher, 'dispatcher').admin.bookings.approveCash({ paymentId }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });

    expect(await bookingMoney(booking.id)).toMatchObject({ amountPaidCentavos: DEPOSIT });
    expect((await paymentRow(paymentId)).status).toBe('pending');
    // Still approvable afterwards: the refusal fails closed and leaves the
    // claim exactly where finance will find it.
    await expect(
      apiFor(finance, 'finance').admin.bookings.approveCash({ paymentId }),
    ).resolves.toBeDefined();
    expect(await paymentCount(booking.id)).toBe(1);
  });

  it('lets an OWNER approve', async () => {
    const driver = await makeDriver('Tess Villaflor');
    const booking = await makeBooking(driver.id);
    const { paymentId } = await recordPendingCash({
      bookingId: booking.id,
      amountCentavos: BALANCE,
      collectedByDriverId: driver.id,
    });

    await expect(
      apiFor(owner, 'owner').admin.bookings.approveCash({ paymentId }),
    ).resolves.toMatchObject({ bookingStatus: 'in_progress' });

    expect(await bookingMoney(booking.id)).toMatchObject({ amountPaidCentavos: TOTAL });
    expect(Number((await paymentRow(paymentId)).verified_by)).toBe(owner);
    expect(await paymentCount(booking.id)).toBe(1);
  });

  /**
   * 7. An id this procedure has never seen is a refusal, not a 500 — and
   * it credits nothing on the way out.
   *
   * **Renamed to what the body proves** (Task 11 review). It used to be
   * called "REFUSES an id that is not a driver-collected cash row" and to
   * claim in this docblock that a gateway charge cannot be approved through
   * the cash door — but the body only ever passed a nonexistent id, which
   * proves nothing about SCOPING. The real gateway case is proven against a
   * real `recordPayment()` row at `record-payment.test.ts:1233-1253`, and a
   * name promising that proof here is an invitation to skip it there.
   */
  it('refuses a payment id that does not exist', async () => {
    const driver = await makeDriver('Ador Bacus');
    const booking = await makeBooking(driver.id);

    await expect(
      apiFor(finance, 'finance').admin.bookings.approveCash({ paymentId: 987_654_321 }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });

    expect(await bookingMoney(booking.id)).toMatchObject({ amountPaidCentavos: DEPOSIT });
  });

  /* ==================================================================
   * D2 — finance or the owner REFUSES a claim: the money never arrived
   * (owner decision 2026-10-16).
   *
   * The approval half above has existed since A5b. Its counterpart did
   * not, and the gap was not cosmetic: one mistaken tap in a van wrote a
   * `pending` row nothing could close, which sat in this queue as a claim
   * nobody could refuse AND put the driver's payment box into
   * `unverified_do_not_collect` — so `driver.recordCash` answered
   * `CONFLICT` on that booking for good.
   *
   * **A refusal moves no money because no money ever moved.** The three
   * booking columns an approval may touch are read before and after every
   * test here, and the unblock is proved through `driverTripDetail` and
   * `recordDriverCash` rather than by reading `payments.status`: the column
   * only proves the write landed, and the driver's screen is what the owner
   * actually asked for.
   * ================================================================== */
  describe('refusing a claim', () => {
    /** The verifier a finance user is, built per test — `finance` is per-test. */
    const financeVerifier = () => ({ type: 'user' as const, id: finance, role: 'finance' });

    /**
     * Noon in Manila on the fixture's tour date.
     *
     * `recordDriverCash` is Manila-today-only (owner Q9) and this file's
     * `TOUR_DATE` is deliberately far future, so the clock is passed in
     * rather than the fixture being moved onto today — `now` is an explicit
     * argument for exactly this reason, and a fixture that moved with the
     * calendar would make every other date assertion in this file drift.
     * 04:00Z is 12:00 Manila, nowhere near a day boundary in either zone.
     */
    const TOUR_DAY_NOON = new Date(`${TOUR_DATE}T04:00:00Z`);

    it('moves no money and leaves the booking exactly as it was', async () => {
      const driver = await makeDriver('Ramil Oczon');
      const booking = await makeBooking(driver.id);
      const before = await bookingMoney(booking.id);
      const { paymentId } = await recordPendingCash({
        bookingId: booking.id,
        amountCentavos: BALANCE,
        collectedByDriverId: driver.id,
      });

      await rejectCashPayment({
        paymentId,
        reason: 'The driver never handed this in.',
        verifier: financeVerifier(),
      });

      const payment = await paymentRow(paymentId);
      expect(payment.status).toBe('rejected');
      expect(payment.reject_reason).toBe('The driver never handed this in.');
      // The row is KEPT, never deleted — CLAUDE.md: never hard-delete a
      // payment. It is the record of what was claimed and refused.
      expect(await paymentCount(booking.id)).toBe(1);
      expect(Number(payment.amount_centavos)).toBe(BALANCE);
      // `verified_by` stays NULL: nobody verified anything, they refused it.
      // Writing the refuser there would make a refusal indistinguishable
      // from an approval in every query that reads that column.
      expect(payment.verified_by).toBeNull();
      expect(payment.verified_at).toBeNull();
      // And the claimant is still on the row.
      expect(Number(payment.collected_by_driver_id)).toBe(driver.id);

      expect(await bookingMoney(booking.id)).toEqual(before);
    });

    it('writes one audit row carrying the reason and the actor', async () => {
      const driver = await makeDriver('Dodong Enriquez');
      const booking = await makeBooking(driver.id);
      const { paymentId } = await recordPendingCash({
        bookingId: booking.id,
        amountCentavos: 100,
        collectedByDriverId: driver.id,
      });
      await rejectCashPayment({
        paymentId,
        reason: 'Short by 500.',
        verifier: { type: 'user' as const, id: owner, role: 'owner' },
      });

      const rows = await auditRowsFor('payments', paymentId);
      const rejected = rows.filter((row) => row.action === 'payment.cash_rejected');
      expect(rejected).toHaveLength(1);
      expect(rejected[0]!.actorType).toBe('user');
      expect(rejected[0]!.actorId).toBe(owner);
      expect(rejected[0]!.data).toMatchObject({
        reason: 'Short by 500.',
        priorPaymentStatus: 'pending',
        paymentStatus: 'rejected',
        collectedByDriverId: driver.id,
        // Spelled out rather than inferred from the absence of a field.
        amountPaidChanged: false,
      });
      // No guest name, email or phone in an audit payload (RA 10173).
      expect(JSON.stringify(rejected[0]!.data)).not.toMatch(/@|\+63/);
    });

    /**
     * **The test the owner asked for**, and it goes through the driver's
     * own two surfaces rather than reading a column.
     *
     * The chain being proved: `recordPendingCash` writes `status='pending'`
     * -> `loadDriverTrip`'s pending probe flips the box to
     * `unverified_do_not_collect` -> `recordDriverCash` answers `CONFLICT`.
     * Refusing the row makes that probe miss it, so the box returns to
     * `collect_cash` and the driver can claim again — which is the right
     * outcome when the first tap was a mistake, or when the guest paid later.
     *
     * The second claim is a NEW row, asserted by id: re-recording is not
     * reviving the refused claim, which stays exactly where it is.
     */
    it('unblocks the driver: the box returns to collect_cash and a new claim succeeds', async () => {
      const driver = await makeDriver('Jessie Maglasang');
      const booking = await makeBooking(driver.id);
      const { paymentId } = await recordPendingCash({
        bookingId: booking.id,
        amountCentavos: BALANCE,
        collectedByDriverId: driver.id,
      });

      // While it is pending, the driver is refused — the block this closes.
      expect((await driverTripDetail(driver.id, booking.id)).payment).toEqual({
        kind: 'unverified_do_not_collect',
      });
      await expect(recordDriverCash(driver.id, booking.id, TOUR_DAY_NOON)).rejects.toMatchObject({
        code: 'CONFLICT',
      });

      await rejectCashPayment({
        paymentId,
        reason: 'Not received.',
        verifier: financeVerifier(),
      });

      const detail = await driverTripDetail(driver.id, booking.id);
      expect(detail.payment).toEqual({ kind: 'collect_cash', amountCentavos: BALANCE });

      const second = await recordDriverCash(driver.id, booking.id, TOUR_DAY_NOON);
      expect(second.paymentId).not.toBe(paymentId);
      expect(second.amountCentavos).toBe(BALANCE);
      // Two rows now: the refused claim and the new one. The first was not
      // reused and not deleted.
      expect(await paymentCount(booking.id)).toBe(2);
      expect((await paymentRow(paymentId)).status).toBe('rejected');
      // And still no money moved by either of them.
      expect(await bookingMoney(booking.id)).toMatchObject({ amountPaidCentavos: DEPOSIT });
    });

    it('refuses a second rejection, and refuses one on an approved row', async () => {
      const driver = await makeDriver('Lito Baring');
      const booking = await makeBooking(driver.id);
      const { paymentId } = await recordPendingCash({
        bookingId: booking.id,
        amountCentavos: 100,
        collectedByDriverId: driver.id,
      });
      await rejectCashPayment({ paymentId, reason: 'One.', verifier: financeVerifier() });
      await expect(
        rejectCashPayment({ paymentId, reason: 'Two.', verifier: financeVerifier() }),
      ).rejects.toBeInstanceOf(CashPaymentNotPendingError);
      // The first reason stands: a second refusal cannot overwrite it.
      expect((await paymentRow(paymentId)).reject_reason).toBe('One.');

      // And the other direction: a row finance has already counted is not
      // refusable either. `pending` is the only decidable state.
      const second = await recordPendingCash({
        bookingId: booking.id,
        amountCentavos: 100,
        collectedByDriverId: driver.id,
      });
      await apiFor(finance, 'finance').admin.bookings.approveCash({
        paymentId: second.paymentId,
      });
      await expect(
        rejectCashPayment({
          paymentId: second.paymentId,
          reason: 'Changed my mind.',
          verifier: financeVerifier(),
        }),
      ).rejects.toBeInstanceOf(CashPaymentNotPendingError);
      expect((await paymentRow(second.paymentId)).status).toBe('paid');
    });

    /**
     * A refusal is a finding about a person, so it may not be anonymous.
     * Whitespace counts as empty — the service trims before it checks, so a
     * tab is not a reason.
     */
    it('requires a reason, and refuses whitespace', async () => {
      const driver = await makeDriver('Nene Cabahug');
      const booking = await makeBooking(driver.id);
      const { paymentId } = await recordPendingCash({
        bookingId: booking.id,
        amountCentavos: 100,
        collectedByDriverId: driver.id,
      });
      for (const reason of ['', '   ', '\t\n']) {
        await expect(
          rejectCashPayment({ paymentId, reason, verifier: financeVerifier() }),
        ).rejects.toBeInstanceOf(CashRejectionNeedsReasonError);
      }
      // And it wrote nothing while refusing.
      const row = await paymentRow(paymentId);
      expect(row.status).toBe('pending');
      expect(row.reject_reason).toBeNull();
      expect(await bookingMoney(booking.id)).toMatchObject({ amountPaidCentavos: DEPOSIT });
    });

    /**
     * §9's `verifyPayments` row, at the SERVICE level — fail-closed, and an
     * allow-list rather than a deny-list, so an unrecognised role string
     * and a missing one are refused like a dispatcher is.
     *
     * The driver case is the one that matters: a driver who could refuse
     * their own claim could tap, pocket the cash and then erase the claim.
     */
    it('refuses a driver, a dispatcher, an unknown role and a non-user actor', async () => {
      const driver = await makeDriver('Boying Alcoseba');
      const booking = await makeBooking(driver.id);
      const { paymentId } = await recordPendingCash({
        bookingId: booking.id,
        amountCentavos: 100,
        collectedByDriverId: driver.id,
      });
      const refused = [
        { type: 'driver' as const, id: driver.id, role: 'driver' },
        { type: 'user' as const, id: dispatcher, role: 'dispatcher' },
        { type: 'user' as const, id: finance, role: '__proto__' },
        { type: 'user' as const, id: finance, role: undefined },
        { type: 'system' as const, id: null, role: 'owner' },
      ];
      for (const verifier of refused) {
        await expect(
          rejectCashPayment({ paymentId, reason: 'No.', verifier }),
        ).rejects.toBeInstanceOf(PaymentVerificationNotPermittedError);
      }
      expect((await paymentRow(paymentId)).status).toBe('pending');
    });

    /**
     * The row predicate, which is shared with the approval path
     * (`manualPendingRow`) precisely so a refusal can never land on a row
     * an approval would not have accepted. A guest's receipt is a manual
     * `pending` row too, and it is NOT a cash claim.
     */
    it('refuses a payment id that is not a driver-cash row', async () => {
      const driver = await makeDriver('Tonio Yap');
      const booking = await makeBooking(driver.id);
      const receiptId = await insertReceiptPayment(booking.id);
      await expect(
        rejectCashPayment({ paymentId: receiptId, reason: 'No.', verifier: financeVerifier() }),
      ).rejects.toBeInstanceOf(CashPaymentNotFoundError);
      // Untouched: still pending, still without a reason.
      const row = await paymentRow(receiptId);
      expect(row.status).toBe('pending');
      expect(row.reject_reason).toBeNull();
    });

    /**
     * And the same refusals at the TRANSPORT, because hiding a button is
     * not access control and neither is a service-level check nobody
     * reaches. A dispatcher is `FORBIDDEN` by the gate; a driver session is
     * not an admin identity at all, so it is `UNAUTHORIZED`.
     */
    it('refuses a dispatcher and a driver through the procedure, and lets finance through', async () => {
      const driver = await makeDriver('Nards Pacana');
      const booking = await makeBooking(driver.id);
      const { paymentId } = await recordPendingCash({
        bookingId: booking.id,
        amountCentavos: BALANCE,
        collectedByDriverId: driver.id,
      });

      await expect(
        apiFor(dispatcher, 'dispatcher').admin.bookings.rejectCash({
          paymentId,
          reason: 'Not received.',
        }),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
      await expect(
        driverCaller(driver.id).admin.bookings.rejectCash({
          paymentId,
          reason: 'Not received.',
        }),
      ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
      expect((await paymentRow(paymentId)).status).toBe('pending');

      // The input refuses a blank reason before the service is reached.
      await expect(
        apiFor(finance, 'finance').admin.bookings.rejectCash({ paymentId, reason: '   ' }),
      ).rejects.toMatchObject({ code: 'BAD_REQUEST' });

      await expect(
        apiFor(finance, 'finance').admin.bookings.rejectCash({
          paymentId,
          reason: 'The money never arrived.',
        }),
      ).resolves.toEqual({ ref: booking.ref });
      expect((await paymentRow(paymentId)).status).toBe('rejected');
      // And the claim leaves the queue, because that is what "handled" means.
      const queue = await apiFor(finance, 'finance').admin.bookings.list({
        awaitingVerification: true,
        limit: 100,
      });
      expect(queue.items.map((item) => item.ref)).not.toContain(booking.ref);
      expect(await bookingMoney(booking.id)).toMatchObject({ amountPaidCentavos: DEPOSIT });
    });
  });
});
