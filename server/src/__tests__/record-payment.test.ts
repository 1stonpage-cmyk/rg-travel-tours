/**
 * Task 14 of the core-schema plan: `recordPayment()`, the only thing that
 * can mark a booking paid.
 *
 * **Why every fixture here is COMMITTED, unlike `schema-payments.test.ts`.**
 * That suite builds its rows inside a transaction it always rolls back, so
 * no `DELETE FROM payments` appears anywhere in it. This suite cannot: the
 * function under test opens its OWN transaction on its own pooled
 * connection, so a booking left uncommitted is a booking it cannot see, and
 * every test would get `BookingNotFoundError`. Worse, the concurrency test
 * needs two genuinely concurrent transactions, which is only meaningful
 * against committed state.
 *
 * So fixtures are committed and torn down in `afterAll`, by id, against
 * `rg_travel_test` only (`per-file-setup.ts` proves the connection with a
 * real `SELECT DATABASE()` before this file's first test). That teardown is
 * the ONLY place in the codebase that deletes a payment row, and it deletes
 * exactly the ids this file created. Application code never does: the
 * "never hard-delete a payment" rule is about `recordPayment()` and its
 * callers, and `recordPayment()` only ever INSERTs.
 *
 * And the bookings are built here rather than read out of the seed. The seed
 * has no bookings at all, so a test that looks for "any booking" finds none
 * and returns early — green against broken code. Task 12 had to be rewritten
 * for exactly that reason.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import type { BookingStatus, PayMode } from '@rg/shared';
import { getDb, getPool } from '../db/client';
import { bookings, destinations, drivers, tours, users } from '../db/schema';
import { generateBookingRef } from '../services/booking-ref';

/**
 * A controllable failure injected into `writeAudit` — the LAST write
 * `recordPayment()` makes, after the payment insert and after the booking
 * update. It is the only way to prove the thing the whole function rests on:
 * that a failure at the end unwinds the two writes before it.
 *
 * `vi.hoisted` because `vi.mock`'s factory is hoisted above the imports, so
 * a plain `const` declared here would not exist yet when it runs.
 *
 * The mock delegates to the real `writeAudit` whenever the flag is off, so
 * every other test in this file exercises the genuine audit path. If the
 * mock ever stopped intercepting, the injected failure would not happen, the
 * booking WOULD be updated, and the test goes red — it fails closed.
 */
const auditControl = vi.hoisted(() => ({ failNext: false }));

vi.mock('../services/audit', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/audit')>();
  return {
    ...actual,
    writeAudit: async (...args: Parameters<typeof actual.writeAudit>) => {
      if (auditControl.failNext) throw new Error('__audit_write_failed__');
      return actual.writeAudit(...args);
    },
  };
});

const { recordPayment, recordPendingCash, verifyCashPayment } =
  await import('../services/payments/record-payment');
const {
  BookingNotFoundError,
  CashPaymentNotFoundError,
  CashPaymentNotPendingError,
  PaymentAmountMismatchError,
  PaymentOverpaysBookingError,
  PaymentVerificationNotPermittedError,
  RefundExceedsPaidError,
  RefundNotAdminInitiatedError,
} = await import('../services/payments/errors');

/** The webhook actor: `provider`, never `system` (Q10). `system` is a cron job. */
const WEBHOOK_ACTOR = { type: 'provider' as const, id: null };
/** The admin actor. `audit_log.actor_id` is polymorphic and has no FK, so 7 need not exist. */
const ADMIN_ACTOR = { type: 'user' as const, id: 7 };

/** Every id this file committed, so `afterAll` removes exactly those rows. */
const created = {
  bookingIds: [] as number[],
  tourIds: [] as number[],
  destinationIds: [] as number[],
  /** A5b: `payments.collected_by_driver_id` and `verified_by` are real FKs. */
  driverIds: [] as number[],
  userIds: [] as number[],
};

/**
 * True once Task 12's migration has created `payments` in `rg_travel_test`,
 * and false when MySQL is unreachable — the same runtime probe the sibling
 * schema suites use, so a missing migration reports as SKIPPED rather than
 * silently passing.
 */
async function tableExists(name: string): Promise<boolean> {
  try {
    const [rows] = (await getPool().query(
      'SELECT 1 FROM information_schema.tables WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?',
      [name],
    )) as [unknown[], unknown];
    return rows.length > 0;
  } catch {
    return false;
  }
}

const ready = (await tableExists('payments')) && (await tableExists('bookings'));
const dbIt = ready ? it : it.skip;

interface BookingFixture {
  bookingId: number;
  ref: string;
}

/**
 * A committed booking, plus the tour and destination its foreign keys need.
 *
 * `amountPaidCentavos` is set directly for the refund fixtures: those tests
 * are about the refund cap, and driving `amount_paid` up through
 * `recordPayment()` first would make them depend on the payment path they
 * are not testing.
 */
async function makeBooking(opts: {
  totalCentavos: number;
  payMode?: PayMode;
  depositPercent?: number;
  amountPaidCentavos?: number;
  status?: BookingStatus;
  /**
   * Task 16b-3. Defaults to a hold far in the future — a LIVE booking, which
   * is what every test written before 16b-3 assumes. Pass a past date for
   * the lapsed-hold case, or `null` for a booking that has nothing left to
   * expire (which is what `cancelled` and `expired` rows really look like).
   */
  holdExpiresAt?: Date | null;
}): Promise<BookingFixture> {
  const db = getDb();
  const unique = `__rec__${Date.now()}_${Math.floor(Math.random() * 1e9)}`;
  const [destination] = await db.insert(destinations).values({ name: unique, slug: unique });
  created.destinationIds.push(destination.insertId);
  const [tour] = await db
    .insert(tours)
    .values({ slug: unique, title: unique, destinationId: destination.insertId });
  created.tourIds.push(tour.insertId);

  const ref = generateBookingRef();
  const depositPercent = opts.depositPercent ?? 30;
  const [booking] = await db.insert(bookings).values({
    ref,
    tourId: tour.insertId,
    tourDate: new Date('2099-12-25T00:00:00Z'),
    pax: 2,
    leadName: 'Record Payment Fixture',
    leadEmail: 'fixture@example.test',
    leadPhone: '09170000000',
    status: opts.status ?? 'pending_payment',
    payMode: opts.payMode ?? 'full',
    priceSnapshot: {
      tier: {
        tierId: 1,
        minPax: 1,
        maxPax: 6,
        pricePerPersonCentavos: Math.floor(opts.totalCentavos / 2),
      },
      addons: [],
      coupon: null,
      depositPercent,
      freeCancelHours: 48,
      subtotalCentavos: opts.totalCentavos,
      discountCentavos: 0,
      totalCentavos: opts.totalCentavos,
    },
    subtotalCentavos: opts.totalCentavos,
    totalCentavos: opts.totalCentavos,
    amountPaidCentavos: opts.amountPaidCentavos ?? 0,
    // Set so the test can prove `recordPayment` clears it once money lands.
    holdExpiresAt:
      opts.holdExpiresAt === undefined ? new Date('2099-12-24T00:00:00Z') : opts.holdExpiresAt,
  });
  created.bookingIds.push(booking.insertId);
  return { bookingId: booking.insertId, ref };
}

/** A booking awaiting its first payment. */
const seedPendingBooking = (totalCentavos: number) => makeBooking({ totalCentavos });

/** A booking that has already been paid, ready to be refunded against. */
const seedPaidBooking = (amountPaidCentavos: number) =>
  makeBooking({
    totalCentavos: amountPaidCentavos,
    amountPaidCentavos,
    status: 'confirmed',
  });

/**
 * A5b fixtures. `payments.collected_by_driver_id` -> `drivers.id` and
 * `payments.verified_by` -> `users.id` are both real foreign keys, so the
 * cash tests cannot use the invented id 7 the audit assertions get away
 * with (`audit_log.actor_id` is polymorphic and has no FK).
 *
 * Neither is read out of the seed. `rg_travel_test` carries migrations, not
 * seed data, so "find any driver" would find none and the tests would pass
 * vacuously — the same trap this file's header describes for bookings.
 */
const uniqueSuffix = () => `${Date.now()}_${Math.floor(Math.random() * 1e9)}`;

async function makeDriver(): Promise<number> {
  const unique = uniqueSuffix();
  const [driver] = await getDb()
    .insert(drivers)
    .values({
      name: `A5b Driver ${unique}`,
      // 20 characters max, and unique.
      code: `A5B${unique}`.slice(0, 20),
      phone: '09170000001',
      // Not a real hash and not a real PIN: nothing here logs in.
      pinHash: '__a5b_not_a_pin_hash__',
    });
  created.driverIds.push(driver.insertId);
  return driver.insertId;
}

/** A staff user in the given role, for `verified_by` and the role guard. */
async function makeStaff(role: 'owner' | 'dispatcher' | 'finance'): Promise<number> {
  const unique = uniqueSuffix();
  const [user] = await getDb()
    .insert(users)
    .values({
      name: `A5b ${role} ${unique}`,
      email: `a5b_${role}_${unique}@example.test`,
      passwordHash: '__a5b_not_a_password_hash__',
      role,
    });
  created.userIds.push(user.insertId);
  return user.insertId;
}

/** An admin-initiated refund, the only kind §6 allows. */
const refundOf = (
  bookingId: number,
  amountCentavos: number,
  actor: { type: 'user' | 'provider' | 'system'; id: number | null } = ADMIN_ACTOR,
) =>
  recordPayment({
    bookingId,
    type: 'refund',
    provider: 'paymongo',
    method: 'gcash',
    amountCentavos,
    providerRef: `re_${Math.random().toString(36).slice(2, 10)}`,
    providerStatus: 'refunded',
    actor,
  });

type Statement = Parameters<ReturnType<typeof getDb>['execute']>[0];

async function rows<T>(statement: Statement): Promise<T[]> {
  const [result] = (await getDb().execute(statement)) as unknown as [T[], unknown];
  return result;
}

/**
 * The single row a query is expected to return, or a thrown error. A missing
 * row is a real failure here — an assertion against `undefined` reads as a
 * mysterious type error instead of "the row this test is about is not there".
 */
async function one<T>(statement: Statement): Promise<T> {
  const [row] = await rows<T>(statement);
  if (!row) throw new Error('expected one row, got none');
  return row;
}

const bookingRow = (bookingId: number) =>
  one<{
    status: string;
    amount_paid_centavos: number;
    hold_expires_at: Date | null;
    payment_review_required: number;
  }>(
    sql`SELECT status, amount_paid_centavos, hold_expires_at, payment_review_required
        FROM bookings WHERE id = ${bookingId}`,
  );

const refundSum = async (bookingId: number) =>
  Number(
    (
      await one<{ s: number }>(
        sql`SELECT COALESCE(SUM(amount_centavos), 0) s FROM payments
            WHERE booking_id = ${bookingId} AND type = 'refund'`,
      )
    ).s,
  );

describe('recordPayment', () => {
  beforeAll(() => {
    auditControl.failNext = false;
  });

  afterAll(async () => {
    if (!ready) return;
    auditControl.failNext = false;
    const pool = getPool();
    for (const bookingId of created.bookingIds) {
      // Audit rows first: `entity_id` points at payments, so read the ids
      // before the payments go.
      await pool.query(
        "DELETE FROM audit_log WHERE entity = 'payments' AND entity_id IN " +
          '(SELECT id FROM payments WHERE booking_id = ?)',
        [bookingId],
      );
      await pool.query('DELETE FROM payments WHERE booking_id = ?', [bookingId]);
      await pool.query('DELETE FROM bookings WHERE id = ?', [bookingId]);
    }
    for (const tourId of created.tourIds) {
      await pool.query('DELETE FROM tours WHERE id = ?', [tourId]);
    }
    for (const destinationId of created.destinationIds) {
      await pool.query('DELETE FROM destinations WHERE id = ?', [destinationId]);
    }
    /*
     * A5b. After the payments, which carry the two foreign keys that point
     * here — `collected_by_driver_id` and `verified_by`. Exactly the ids
     * this file created, same as every loop above.
     */
    for (const driverId of created.driverIds) {
      await pool.query('DELETE FROM drivers WHERE id = ?', [driverId]);
    }
    for (const userId of created.userIds) {
      await pool.query('DELETE FROM users WHERE id = ?', [userId]);
    }
  });

  /**
   * The happy path, and the four writes that have to land together: the
   * payment row, `amount_paid_centavos`, the booking status, the audit row.
   */
  dbIt('marks the booking confirmed and writes an audit row, in one transaction', async () => {
    const { bookingId, ref } = await seedPendingBooking(189000);

    const result = await recordPayment({
      bookingId,
      type: 'payment',
      provider: 'paymongo',
      method: 'gcash',
      amountCentavos: 189000,
      providerRef: 'pi_test_ok',
      providerStatus: 'paid',
      actor: WEBHOOK_ACTOR,
    });

    expect(result.bookingStatus).toBe('confirmed');

    const booking = await bookingRow(bookingId);
    expect(booking.status).toBe('confirmed');
    expect(Number(booking.amount_paid_centavos)).toBe(189000);
    // Nothing left to expire once the money has landed.
    expect(booking.hold_expires_at).toBeNull();
    /*
     * Task 16b-3: the happy path must NOT be flagged. This is the half of
     * that change that proves the dead-booking branch did not swallow the
     * live one — a `lateMoneyReason()` that returned a reason for every
     * booking would leave every other assertion in this test intact.
     */
    expect(result.paymentReviewRequired).toBe(false);
    expect(Number(booking.payment_review_required), 'a live booking was flagged for review').toBe(
      0,
    );

    const payment = await one<{
      type: string;
      status: string;
      amount_centavos: number;
      provider: string;
    }>(
      sql`SELECT type, status, amount_centavos, provider FROM payments WHERE id = ${result.paymentId}`,
    );
    expect(payment).toMatchObject({ type: 'payment', status: 'paid', provider: 'paymongo' });
    expect(Number(payment.amount_centavos)).toBe(189000);

    const auditRows = await rows<{
      action: string;
      actor_type: string;
      actor_id: number | null;
      data: unknown;
    }>(
      sql`SELECT action, actor_type, actor_id, data FROM audit_log
          WHERE entity = 'payments' AND entity_id = ${result.paymentId}`,
    );
    // Exactly one. Two would mean the audit trail double-counted a payment.
    expect(auditRows).toHaveLength(1);
    const audit = auditRows[0]!;
    expect(audit.action).toBe('payment.recorded');
    // Q10: a webhook is `provider`, with no actor_id and the gateway in data.
    expect(audit.actor_type).toBe('provider');
    expect(audit.actor_id).toBeNull();

    const data = typeof audit.data === 'string' ? JSON.parse(audit.data) : audit.data;
    expect(data).toMatchObject({ bookingRef: ref, amountCentavos: 189000, provider: 'paymongo' });
  });

  /**
   * §6: "Check the amount matches the booking's expected amount." And when
   * it does not, NOTHING is written — the assertion that matters is the
   * absence of the row, not the throw. A function that threw after inserting
   * is a booking that took money and does not know it.
   */
  dbIt('REFUSES an amount that does not match what the booking expects', async () => {
    const { bookingId } = await seedPendingBooking(189000);

    await expect(
      recordPayment({
        bookingId,
        type: 'payment',
        provider: 'paymongo',
        method: 'gcash',
        amountCentavos: 100,
        providerRef: 'pi_short',
        providerStatus: 'paid',
        actor: WEBHOOK_ACTOR,
      }),
    ).rejects.toThrow(/amount/i);

    // Nothing was written. It must fail closed, not half-apply.
    expect(await rows(sql`SELECT id FROM payments WHERE provider_ref = 'pi_short'`)).toHaveLength(
      0,
    );
    const booking = await bookingRow(bookingId);
    expect(booking.status).toBe('pending_payment');
    expect(Number(booking.amount_paid_centavos)).toBe(0);
  });

  /**
   * The deposit branch. Q4 fixes the rounding: UP to the next whole peso,
   * clamped to the total. 30% of ₱1,890.33 is ₱567.099, which rounds UP to
   * ₱568.00 — so 56800 centavos is the expected amount and the unrounded
   * 56709 is refused. The amount check is what makes the rounding rule
   * load-bearing rather than cosmetic.
   */
  dbIt('expects the deposit, rounded up to the peso, when pay_mode is deposit', async () => {
    const { bookingId } = await makeBooking({
      totalCentavos: 189033,
      payMode: 'deposit',
      depositPercent: 30,
    });

    // 189033 * 30% = 56709.9 centavos -> up to the next whole peso = 56800.
    await expect(
      recordPayment({
        bookingId,
        type: 'payment',
        provider: 'paymongo',
        method: 'gcash',
        amountCentavos: 56709,
        providerRef: 'pi_deposit_unrounded',
        providerStatus: 'paid',
        actor: WEBHOOK_ACTOR,
      }),
    ).rejects.toBeInstanceOf(PaymentAmountMismatchError);

    const result = await recordPayment({
      bookingId,
      type: 'payment',
      provider: 'paymongo',
      method: 'gcash',
      amountCentavos: 56800,
      providerRef: 'pi_deposit_ok',
      providerStatus: 'paid',
      actor: WEBHOOK_ACTOR,
    });
    // A deposit confirms the booking too; the balance is a tour-day matter.
    expect(result.bookingStatus).toBe('confirmed');
    expect(Number((await bookingRow(bookingId)).amount_paid_centavos)).toBe(56800);
  });

  /**
   * A duplicate webhook delivery carries exactly the expected amount, so the
   * amount check alone cannot stop it. This is the check the row lock exists
   * to make meaningful: the second caller reads the first caller's
   * `amount_paid` and is refused.
   */
  dbIt('REFUSES a second full payment that would overpay the booking', async () => {
    const { bookingId } = await seedPendingBooking(189000);
    const pay = (providerRef: string) =>
      recordPayment({
        bookingId,
        type: 'payment',
        provider: 'paymongo',
        method: 'gcash',
        amountCentavos: 189000,
        providerRef,
        providerStatus: 'paid',
        actor: WEBHOOK_ACTOR,
      });

    await expect(pay('pi_first')).resolves.toBeDefined();
    await expect(pay('pi_duplicate')).rejects.toBeInstanceOf(PaymentOverpaysBookingError);

    expect(Number((await bookingRow(bookingId)).amount_paid_centavos)).toBe(189000);
    expect(
      await rows(sql`SELECT id FROM payments WHERE provider_ref = 'pi_duplicate'`),
    ).toHaveLength(0);
  });

  dbIt('REFUSES a payment for a booking that does not exist', async () => {
    await expect(
      recordPayment({
        bookingId: 987654321,
        type: 'payment',
        provider: 'paymongo',
        method: 'gcash',
        amountCentavos: 1000,
        providerRef: 'pi_no_booking',
        providerStatus: 'paid',
        actor: WEBHOOK_ACTOR,
      }),
    ).rejects.toBeInstanceOf(BookingNotFoundError);
    expect(
      await rows(sql`SELECT id FROM payments WHERE provider_ref = 'pi_no_booking'`),
    ).toHaveLength(0);
  });

  // --- Refunds (Q11): positive amounts, partial allowed, capped at paid ---

  dbIt('allows several partial refunds that together equal what was paid', async () => {
    const { bookingId } = await seedPaidBooking(100000);
    await expect(refundOf(bookingId, 40000)).resolves.toBeDefined();
    await expect(refundOf(bookingId, 60000)).resolves.toBeDefined();
    const count = await one<{ n: number }>(
      sql`SELECT COUNT(*) n FROM payments WHERE booking_id = ${bookingId} AND type = 'refund'`,
    );
    expect(Number(count.n)).toBe(2);
    expect(await refundSum(bookingId)).toBe(100000);
  });

  dbIt('REFUSES a refund that would take the total over what was paid', async () => {
    const { bookingId } = await seedPaidBooking(100000);
    await refundOf(bookingId, 60000);
    await expect(refundOf(bookingId, 60000)).rejects.toThrow(/exceed/i);
    // And the over-refund left nothing behind.
    expect(await refundSum(bookingId)).toBe(60000);
  });

  /**
   * `amount_paid_centavos` is money IN and a refund never decrements it. If
   * it did, the cap would re-open after every partial refund and the whole
   * amount could leave twice, one refund at a time.
   */
  dbIt('does not decrement amount_paid_centavos, so the cap cannot re-open', async () => {
    const { bookingId } = await seedPaidBooking(100000);
    await refundOf(bookingId, 100000);
    expect(Number((await bookingRow(bookingId)).amount_paid_centavos)).toBe(100000);
    // Status is not a refund's business either (§6).
    expect((await bookingRow(bookingId)).status).toBe('confirmed');
    await expect(refundOf(bookingId, 1)).rejects.toBeInstanceOf(RefundExceedsPaidError);
  });

  dbIt('stores a refund as a POSITIVE amount with type=refund, never a negative', async () => {
    const { bookingId } = await seedPaidBooking(100000);
    const r = await refundOf(bookingId, 25000);
    const row = await one<{ a: number; type: string; status: string }>(
      sql`SELECT amount_centavos a, type, status FROM payments WHERE id = ${r.paymentId}`,
    );
    expect(Number(row.a)).toBe(25000);
    expect(row.type).toBe('refund');
    expect(row.status).toBe('refunded');
  });

  /**
   * §6: "Refunds are admin-only ... A gateway webhook may _confirm_ a refund
   * the admin initiated; it may never initiate one." So a `provider` actor
   * and a `system` actor are both refused, and nothing is written.
   */
  dbIt('REFUSES a refund initiated by a webhook or a cron job', async () => {
    const { bookingId } = await seedPaidBooking(100000);
    await expect(refundOf(bookingId, 10000, WEBHOOK_ACTOR)).rejects.toBeInstanceOf(
      RefundNotAdminInitiatedError,
    );
    await expect(refundOf(bookingId, 10000, { type: 'system', id: null })).rejects.toBeInstanceOf(
      RefundNotAdminInitiatedError,
    );
    // An admin with no id is not an admin either.
    await expect(refundOf(bookingId, 10000, { type: 'user', id: null })).rejects.toBeInstanceOf(
      RefundNotAdminInitiatedError,
    );
    expect(await refundSum(bookingId)).toBe(0);
  });

  /**
   * **The most important test in this task.** The race the row lock exists
   * for: two admins refunding at once must not both see "nothing refunded
   * yet" and both succeed.
   *
   * Proven able to fail by dropping the `.for('update')` on the booking
   * read: both refunds then commit, two are fulfilled instead of one, and
   * ₱1,600 leaves on a ₱1,000 payment.
   *
   * Worth knowing, and measured rather than assumed: moving the refund SUM
   * onto the pool instead of `tx` does NOT make this go red. With the row
   * lock still held, the two callers are serialised, so the second one's
   * pooled read already sees the first one's committed refund. The LOCK is
   * the load-bearing part; reading the sum through `tx` is correct-by-
   * construction rather than independently pinned here. See the Task 14
   * report.
   */
  dbIt('serialises two concurrent refunds so only one fits', async () => {
    const { bookingId } = await seedPaidBooking(100000);

    const results = await Promise.allSettled([
      refundOf(bookingId, 80000),
      refundOf(bookingId, 80000),
    ]);

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
    expect(await refundSum(bookingId)).toBe(80000);
  });

  dbIt('writes an audit row naming the admin who refunded (admin-only, Q11)', async () => {
    const { bookingId } = await seedPaidBooking(100000);
    const r = await refundOf(bookingId, 25000, ADMIN_ACTOR);
    const auditRows = await rows<{ actor_type: string; actor_id: number; action: string }>(
      sql`SELECT actor_type, actor_id, action FROM audit_log
          WHERE entity = 'payments' AND entity_id = ${r.paymentId}`,
    );
    expect(auditRows).toHaveLength(1);
    const audit = auditRows[0]!;
    expect(audit.actor_type).toBe('user');
    expect(Number(audit.actor_id)).toBe(7);
    expect(audit.action).toBe('payment.refunded');
  });

  /**
   * One transaction, proven at the far end. The audit write is the LAST of
   * the three writes; failing it must unwind the payment row AND the booking
   * update made before it.
   */
  dbIt('leaves the booking untouched when the audit write fails', async () => {
    const { bookingId } = await seedPendingBooking(189000);
    auditControl.failNext = true;
    try {
      await expect(
        recordPayment({
          bookingId,
          type: 'payment',
          provider: 'paymongo',
          method: 'gcash',
          amountCentavos: 189000,
          providerRef: 'pi_audit_boom',
          providerStatus: 'paid',
          actor: WEBHOOK_ACTOR,
        }),
      ).rejects.toThrow(/__audit_write_failed__/);
    } finally {
      auditControl.failNext = false;
    }

    const booking = await bookingRow(bookingId);
    expect(booking.status).toBe('pending_payment');
    expect(Number(booking.amount_paid_centavos)).toBe(0);
    expect(
      await rows(sql`SELECT id FROM payments WHERE provider_ref = 'pi_audit_boom'`),
    ).toHaveLength(0);
  });

  // --- Task 16b-3: a late payment must not resurrect a dead booking ---

  /**
   * The owner's decision, 2026-10-11: money arriving for a booking whose hold
   * has expired or that was cancelled is still RECORDED — it is real money —
   * but changes NO booking status. A flag goes up and an audit row explains
   * why; an admin later re-confirms (if capacity allows) or refunds.
   *
   * Four things are asserted every time, because three of the four would
   * each individually be a silent disaster: the status is unchanged (no
   * resurrection, no overbooking), the flag is set (an admin will see it),
   * the payment row EXISTS (the money is not lost), and the audit row
   * carries the reason and the prior status (it is explainable months
   * later).
   */
  const assertRecordedButNotResurrected = async (
    bookingId: number,
    ref: string,
    expected: { status: BookingStatus; reason: string; amountCentavos: number },
    providerRef: string,
  ) => {
    const result = await recordPayment({
      bookingId,
      type: 'payment',
      provider: 'paymongo',
      method: 'gcash',
      amountCentavos: expected.amountCentavos,
      providerRef,
      providerStatus: 'paid',
      actor: WEBHOOK_ACTOR,
    });

    // 1. The status did NOT move. Nothing auto-confirms (owner DO-NOT).
    expect(result.bookingStatus).toBe(expected.status);
    const booking = await bookingRow(bookingId);
    expect(booking.status, 'a late payment resurrected a dead booking').toBe(expected.status);

    // 2. The flag is up, for the admin decision a later week builds.
    expect(result.paymentReviewRequired).toBe(true);
    expect(Number(booking.payment_review_required), 'nobody will ever look at this money').toBe(1);

    // 3. The money is recorded, not lost — and `amount_paid_centavos` moves
    //    with it, because that is what a refund is measured against.
    const payment = await one<{ amount_centavos: number; status: string; type: string }>(
      sql`SELECT amount_centavos, status, type FROM payments WHERE id = ${result.paymentId}`,
    );
    expect(Number(payment.amount_centavos)).toBe(expected.amountCentavos);
    expect(payment).toMatchObject({ type: 'payment', status: 'paid' });
    expect(Number(booking.amount_paid_centavos)).toBe(expected.amountCentavos);

    // 4. The audit row says WHY, and what the booking was before.
    const auditRows = await rows<{ actor_type: string; action: string; data: unknown }>(
      sql`SELECT actor_type, action, data FROM audit_log
          WHERE entity = 'payments' AND entity_id = ${result.paymentId}`,
    );
    expect(auditRows).toHaveLength(1);
    const audit = auditRows[0]!;
    // A webhook is `provider`, never `system` — `system` means a cron job (Q10).
    expect(audit.actor_type).toBe('provider');
    expect(audit.action).toBe('payment.recorded');
    const data = typeof audit.data === 'string' ? JSON.parse(audit.data) : audit.data;
    expect(data).toMatchObject({
      bookingRef: ref,
      paymentReviewRequired: true,
      reviewReason: expected.reason,
      priorBookingStatus: expected.status,
      // Equal to priorBookingStatus — and that equality IS the record that
      // nothing was resurrected.
      bookingStatus: expected.status,
    });
  };

  /**
   * (a) The hold lapsed while the guest was in the GCash app, and the
   * hold-expiry cron has not run yet — so the row still says
   * `pending_payment` with a `hold_expires_at` in the past. The decision
   * must not depend on which of the two got there first.
   */
  dbIt('records a payment on a booking whose hold lapsed, and changes no status', async () => {
    const { bookingId, ref } = await makeBooking({
      totalCentavos: 189000,
      status: 'pending_payment',
      holdExpiresAt: new Date('2020-01-01T00:00:00Z'),
    });
    await assertRecordedButNotResurrected(
      bookingId,
      ref,
      { status: 'pending_payment', reason: 'hold_expired', amountCentavos: 189000 },
      'pi_late_hold',
    );
  });

  /** (a, second flavour) The cron got there first and the row says `expired`. */
  dbIt('records a payment on an already-expired booking, and changes no status', async () => {
    const { bookingId, ref } = await makeBooking({
      totalCentavos: 189000,
      status: 'expired',
      holdExpiresAt: null,
    });
    await assertRecordedButNotResurrected(
      bookingId,
      ref,
      { status: 'expired', reason: 'booking_expired', amountCentavos: 189000 },
      'pi_late_expired',
    );
  });

  /** (b) A cancelled booking. Same rule, different reason in the audit row. */
  dbIt('records a payment on a cancelled booking, and changes no status', async () => {
    const { bookingId, ref } = await makeBooking({
      totalCentavos: 189000,
      status: 'cancelled',
      holdExpiresAt: null,
    });
    await assertRecordedButNotResurrected(
      bookingId,
      ref,
      { status: 'cancelled', reason: 'booking_cancelled', amountCentavos: 189000 },
      'pi_late_cancelled',
    );
  });

  /**
   * The flag is not cleared by a later call, and `recordPayment()` is not
   * the thing that resolves it — only the admin decision is. A second late
   * payment on an already-flagged booking must not look resolved.
   *
   * It also pins that the amount check still applies to a dead booking: the
   * second delivery here would overpay, and is refused, which is why the
   * flag can only have come from the first call.
   */
  dbIt('leaves the flag up when a second late payment is refused', async () => {
    const { bookingId, ref } = await makeBooking({
      totalCentavos: 189000,
      status: 'cancelled',
      holdExpiresAt: null,
    });
    await assertRecordedButNotResurrected(
      bookingId,
      ref,
      { status: 'cancelled', reason: 'booking_cancelled', amountCentavos: 189000 },
      'pi_late_twice_first',
    );
    await expect(
      recordPayment({
        bookingId,
        type: 'payment',
        provider: 'paymongo',
        method: 'gcash',
        amountCentavos: 189000,
        providerRef: 'pi_late_twice_second',
        providerStatus: 'paid',
        actor: WEBHOOK_ACTOR,
      }),
    ).rejects.toBeInstanceOf(PaymentOverpaysBookingError);

    const booking = await bookingRow(bookingId);
    expect(Number(booking.payment_review_required), 'the flag was cleared').toBe(1);
    expect(booking.status).toBe('cancelled');
    expect(
      await rows(sql`SELECT id FROM payments WHERE provider_ref = 'pi_late_twice_second'`),
    ).toHaveLength(0);
  });

  /**
   * A refund against a flagged booking still works — that is half of the
   * admin's choice (re-confirm, or refund), and it only works because the
   * dead-booking path moved `amount_paid_centavos` rather than discarding
   * the money. A path that recorded the payment row but left
   * `amount_paid_centavos` at 0 would pass every assertion above and leave
   * the admin unable to give the guest their money back.
   */
  dbIt('lets an admin refund the money a flagged booking took', async () => {
    const { bookingId, ref } = await makeBooking({
      totalCentavos: 189000,
      status: 'cancelled',
      holdExpiresAt: null,
    });
    await assertRecordedButNotResurrected(
      bookingId,
      ref,
      { status: 'cancelled', reason: 'booking_cancelled', amountCentavos: 189000 },
      'pi_late_refundable',
    );
    await expect(refundOf(bookingId, 189000, ADMIN_ACTOR)).resolves.toBeDefined();
    expect(await refundSum(bookingId)).toBe(189000);
  });

  /* ---------------------------------------------------------------------
   * A5b — driver-collected cash: pending on collection, finance converts
   * the SAME row.
   *
   * Nested inside this describe on purpose, so the `afterAll` above tears
   * down these fixtures too. A sibling describe would have its rows
   * deleted before its tests ran.
   * ------------------------------------------------------------------ */
  describe('driver-collected cash', () => {
    const paymentRow = (paymentId: number) =>
      one<{
        status: string;
        type: string;
        provider: string;
        method: string;
        amount_centavos: number;
        collected_by_driver_id: number | null;
        verified_by: number | null;
        verified_at: Date | null;
      }>(
        sql`SELECT status, type, provider, method, amount_centavos,
                   collected_by_driver_id, verified_by, verified_at
            FROM payments WHERE id = ${paymentId}`,
      );

    const paymentCount = async (bookingId: number) =>
      Number(
        (
          await one<{ n: number }>(
            sql`SELECT COUNT(*) n FROM payments WHERE booking_id = ${bookingId}`,
          )
        ).n,
      );

    const auditRowsFor = (paymentId: number) =>
      rows<{ action: string; actor_type: string; actor_id: number | null; data: unknown }>(
        sql`SELECT action, actor_type, actor_id, data FROM audit_log
            WHERE entity = 'payments' AND entity_id = ${paymentId}`,
      );

    /**
     * 1. THE point of the split. The driver's tap writes a `pending` row
     *    and the booking does not move at all.
     *
     * All three booking columns are asserted, not just `amount_paid`: a
     * version that credited nothing but flipped `status` to `confirmed`, or
     * one that raised `payment_review_required`, would be just as wrong and
     * would pass a single-column assertion. The guest's booking must read
     * exactly as it did before a driver touched anything.
     */
    dbIt('records a PENDING row and leaves the booking completely untouched', async () => {
      const driverId = await makeDriver();
      const { bookingId, ref } = await makeBooking({
        totalCentavos: 100000,
        amountPaidCentavos: 40000,
        status: 'in_progress',
        holdExpiresAt: null,
      });
      const before = await bookingRow(bookingId);

      const { paymentId } = await recordPendingCash({
        bookingId,
        amountCentavos: 60000,
        collectedByDriverId: driverId,
      });

      // The booking: not one of the three columns moved.
      const after = await bookingRow(bookingId);
      expect(Number(after.amount_paid_centavos), 'a driver credited the booking').toBe(40000);
      expect(Number(after.amount_paid_centavos)).toBe(Number(before.amount_paid_centavos));
      expect(after.status, 'a driver moved the booking status').toBe('in_progress');
      expect(Number(after.payment_review_required), 'a driver raised the review flag').toBe(0);

      // The row: pending, cash, manual, the driver named, nothing verified.
      const payment = await paymentRow(paymentId);
      expect(payment).toMatchObject({
        status: 'pending',
        type: 'payment',
        provider: 'manual',
        method: 'cash',
      });
      expect(Number(payment.amount_centavos)).toBe(60000);
      expect(Number(payment.collected_by_driver_id)).toBe(driverId);
      expect(payment.verified_by, 'unverified cash carries a verifier').toBeNull();
      expect(payment.verified_at).toBeNull();
      // ONE row, not two.
      expect(await paymentCount(bookingId)).toBe(1);

      // The audit row: `driver`, naming the driver (§10).
      const auditRows = await auditRowsFor(paymentId);
      expect(auditRows).toHaveLength(1);
      const audit = auditRows[0]!;
      expect(audit.actor_type).toBe('driver');
      expect(Number(audit.actor_id)).toBe(driverId);
      expect(audit.action).toBe('payment.cash_collected');
      const data = typeof audit.data === 'string' ? JSON.parse(audit.data) : audit.data;
      expect(data).toMatchObject({
        bookingRef: ref,
        amountCentavos: 60000,
        method: 'cash',
        paymentStatus: 'pending',
      });
    });

    /**
     * 2. Finance verifies, and the money lands — ONCE, on the same row.
     *
     * The `paymentCount` assertion is the one that would catch the obvious
     * wrong implementation: calling `recordPayment()`, which INSERTs. That
     * version would leave `amount_paid_centavos` looking correct while the
     * trail showed two payments for one handful of cash, and the pending
     * row orphaned forever.
     */
    dbIt('converts the SAME row to paid, credits once, and confirms the booking', async () => {
      const driverId = await makeDriver();
      const financeId = await makeStaff('finance');
      const { bookingId, ref } = await seedPendingBooking(100000);

      const { paymentId } = await recordPendingCash({
        bookingId,
        amountCentavos: 100000,
        collectedByDriverId: driverId,
      });

      const result = await verifyCashPayment({
        paymentId,
        verifier: { type: 'user', id: financeId, role: 'finance' },
      });
      expect(result.paymentId).toBe(paymentId);
      expect(result.bookingId).toBe(bookingId);
      expect(result.bookingStatus).toBe('confirmed');
      expect(result.paymentReviewRequired).toBe(false);

      // The booking now holds the money.
      const booking = await bookingRow(bookingId);
      expect(Number(booking.amount_paid_centavos)).toBe(100000);
      expect(booking.status).toBe('confirmed');
      expect(Number(booking.payment_review_required)).toBe(0);

      // THE SAME ROW, converted in place.
      const payment = await paymentRow(paymentId);
      expect(payment.status).toBe('paid');
      expect(Number(payment.verified_by)).toBe(financeId);
      expect(payment.verified_at, 'a verifier with no timestamp').not.toBeNull();
      // The driver is still named on it — the collection is not erased by
      // the verification.
      expect(Number(payment.collected_by_driver_id)).toBe(driverId);

      // **No second row.** One handful of cash is one payments row.
      expect(await paymentCount(bookingId), 'verification inserted a second payment').toBe(1);

      // Two audit rows against this payment, in order: the claim, then the
      // receipt. Each is a real event and neither replaces the other.
      const auditRows = await auditRowsFor(paymentId);
      expect(auditRows).toHaveLength(2);
      const verified = auditRows.find((r) => r.action === 'payment.verified');
      expect(verified, 'no audit row for the verification').toBeDefined();
      expect(verified!.actor_type).toBe('user');
      expect(Number(verified!.actor_id)).toBe(financeId);
      const data = typeof verified!.data === 'string' ? JSON.parse(verified!.data) : verified!.data;
      expect(data).toMatchObject({
        bookingRef: ref,
        amountCentavos: 100000,
        priorPaymentStatus: 'pending',
        paymentStatus: 'paid',
        priorBookingStatus: 'pending_payment',
        bookingStatus: 'confirmed',
      });
    });

    /**
     * 3. **The most important test in A5b.** Two finance users click
     *    "verify" on the same row at the same moment, and both read
     *    `pending` before either commits.
     *
     * Driven CONCURRENTLY, not sequentially. A sequential double-verify
     * passes against broken code: the first call has already committed by
     * the time the second one reads, so even a status check taken before
     * the lock sees `paid`. The race is the only thing that distinguishes
     * them.
     *
     * The cash here is 20,000 of a 100,000 booking, so a double credit
     * would be 40,000 — comfortably UNDER the total. That is deliberate:
     * with the full balance, `PaymentOverpaysBookingError` would refuse the
     * second credit as a side effect and the test would stay green with the
     * real guard removed. The overpay cap must not be allowed to stand in
     * for the pending check.
     */
    dbIt('serialises two concurrent verifications so the cash is credited once', async () => {
      const driverId = await makeDriver();
      const ownerId = await makeStaff('owner');
      const financeId = await makeStaff('finance');
      const { bookingId } = await seedPendingBooking(100000);

      const { paymentId } = await recordPendingCash({
        bookingId,
        amountCentavos: 20000,
        collectedByDriverId: driverId,
      });

      const results = await Promise.allSettled([
        verifyCashPayment({
          paymentId,
          verifier: { type: 'user', id: ownerId, role: 'owner' },
        }),
        verifyCashPayment({
          paymentId,
          verifier: { type: 'user', id: financeId, role: 'finance' },
        }),
      ]);

      const fulfilled = results.filter((r) => r.status === 'fulfilled');
      const rejected = results.filter((r) => r.status === 'rejected');
      expect(fulfilled, 'both verifications succeeded').toHaveLength(1);
      expect(rejected).toHaveLength(1);
      /*
       * And refused for the RIGHT reason. Without this, a version whose
       * only net was the overpay cap would still show one-and-one on a
       * fixture where the double credit happened not to fit.
       */
      expect(
        (rejected[0] as PromiseRejectedResult).reason,
        'the loser was refused by something other than the pending check',
      ).toBeInstanceOf(CashPaymentNotPendingError);

      // Credited exactly once.
      expect(Number((await bookingRow(bookingId)).amount_paid_centavos)).toBe(20000);
      // Still one row, and it is `paid` once.
      expect(await paymentCount(bookingId)).toBe(1);
      expect((await paymentRow(paymentId)).status).toBe('paid');
      // One claim + one receipt. A third would mean the trail double-counted.
      expect(await auditRowsFor(paymentId)).toHaveLength(2);
    });

    /**
     * 3b. The sequential case, kept beside the race because it is the one a
     * human actually does: double-click, or re-open the tab and click
     * again. A no-op ERROR, never a second credit.
     */
    dbIt('REFUSES a second verification of an already-paid row, crediting nothing', async () => {
      const driverId = await makeDriver();
      const financeId = await makeStaff('finance');
      const { bookingId } = await seedPendingBooking(100000);

      const { paymentId } = await recordPendingCash({
        bookingId,
        amountCentavos: 30000,
        collectedByDriverId: driverId,
      });
      const verifier = { type: 'user' as const, id: financeId, role: 'finance' };

      await expect(verifyCashPayment({ paymentId, verifier })).resolves.toBeDefined();
      await expect(verifyCashPayment({ paymentId, verifier })).rejects.toBeInstanceOf(
        CashPaymentNotPendingError,
      );

      expect(Number((await bookingRow(bookingId)).amount_paid_centavos)).toBe(30000);
      expect(await paymentCount(bookingId)).toBe(1);
      expect(await auditRowsFor(paymentId)).toHaveLength(2);
    });

    /**
     * 4. §9's "Verify payments, record payments" row: Owner ✅, Dispatcher
     *    ❌, Finance ✅ — `ROLE_MATRIX.verifyPayments`.
     *
     * Both halves are asserted. A gate that refused everyone would pass a
     * test that only checked the refusals, and a gate that admitted
     * everyone would pass one that only checked the admissions.
     */
    dbIt('lets only owner and finance verify; everyone else is refused', async () => {
      const driverId = await makeDriver();
      const ownerId = await makeStaff('owner');
      const financeId = await makeStaff('finance');
      const dispatcherId = await makeStaff('dispatcher');
      const { bookingId } = await seedPendingBooking(100000);

      const cash = () =>
        recordPendingCash({ bookingId, amountCentavos: 10000, collectedByDriverId: driverId });
      const refusedRow = (await cash()).paymentId;

      // Dispatcher: explicitly ❌ in §9's table.
      await expect(
        verifyCashPayment({
          paymentId: refusedRow,
          verifier: { type: 'user', id: dispatcherId, role: 'dispatcher' },
        }),
      ).rejects.toBeInstanceOf(PaymentVerificationNotPermittedError);

      // An unrecognised role string, a missing role, and a user with no id.
      for (const verifier of [
        { type: 'user' as const, id: ownerId, role: 'admin' },
        { type: 'user' as const, id: ownerId, role: '__proto__' },
        { type: 'user' as const, id: ownerId, role: undefined },
        { type: 'user' as const, id: null, role: 'owner' },
        { type: 'provider' as const, id: null, role: 'owner' },
        { type: 'system' as const, id: null, role: 'owner' },
      ]) {
        await expect(verifyCashPayment({ paymentId: refusedRow, verifier })).rejects.toBeInstanceOf(
          PaymentVerificationNotPermittedError,
        );
      }

      // Every refusal failed closed: the row is untouched and so is the booking.
      expect((await paymentRow(refusedRow)).status).toBe('pending');
      expect((await paymentRow(refusedRow)).verified_by).toBeNull();
      expect(Number((await bookingRow(bookingId)).amount_paid_centavos)).toBe(0);
      expect((await bookingRow(bookingId)).status).toBe('pending_payment');

      // And the two roles §9 allows both get through.
      await expect(
        verifyCashPayment({
          paymentId: refusedRow,
          verifier: { type: 'user', id: financeId, role: 'finance' },
        }),
      ).resolves.toMatchObject({ bookingStatus: 'confirmed' });
      await expect(
        verifyCashPayment({
          paymentId: (await cash()).paymentId,
          verifier: { type: 'user', id: ownerId, role: 'owner' },
        }),
      ).resolves.toBeDefined();
      expect(Number((await bookingRow(bookingId)).amount_paid_centavos)).toBe(20000);
    });

    /**
     * 5. A driver cannot verify their own collection — the point of §8's
     *    "for admin to reconcile".
     *
     * The verifier here carries `role: 'owner'`, because the dangerous
     * version of this bug is not a driver with no role: it is a driver
     * session whose payload was trusted, or a context-building bug that
     * copied a role onto one. `subject_type` is what refuses it, exactly as
     * `requireRole` refuses a driver session at the tRPC door.
     *
     * A driver who could verify their own cash could pocket it and leave
     * the booking reading "paid in full".
     */
    dbIt('REFUSES a driver verifying their own collection, even claiming a role', async () => {
      const driverId = await makeDriver();
      const { bookingId } = await seedPendingBooking(100000);
      const { paymentId } = await recordPendingCash({
        bookingId,
        amountCentavos: 100000,
        collectedByDriverId: driverId,
      });

      await expect(
        verifyCashPayment({
          paymentId,
          verifier: { type: 'driver', id: driverId, role: 'owner' },
        }),
      ).rejects.toBeInstanceOf(PaymentVerificationNotPermittedError);
      await expect(
        verifyCashPayment({
          paymentId,
          verifier: { type: 'customer', id: bookingId, role: 'finance' },
        }),
      ).rejects.toBeInstanceOf(PaymentVerificationNotPermittedError);

      // Fail closed: still pending, nothing credited, nothing verified.
      const payment = await paymentRow(paymentId);
      expect(payment.status).toBe('pending');
      expect(payment.verified_by).toBeNull();
      const booking = await bookingRow(bookingId);
      expect(Number(booking.amount_paid_centavos)).toBe(0);
      expect(booking.status).toBe('pending_payment');
      // Only the collection audit row. No verification was audited.
      expect(await auditRowsFor(paymentId)).toHaveLength(1);
    });

    /**
     * The cash path must not be a back door onto a GATEWAY payment row.
     * `verifyCashPayment()` scopes its lookup to
     * `provider='manual' AND method='cash'`, so a PayMongo charge's id is
     * simply not found here — it cannot be marked paid, re-credited, or
     * stamped with a `verified_by` it never had.
     */
    dbIt('REFUSES an id that is not a driver-cash row', async () => {
      const financeId = await makeStaff('finance');
      const { bookingId } = await seedPendingBooking(100000);
      const gateway = await recordPayment({
        bookingId,
        type: 'payment',
        provider: 'paymongo',
        method: 'gcash',
        amountCentavos: 100000,
        providerRef: 'pi_a5b_not_cash',
        providerStatus: 'paid',
        actor: WEBHOOK_ACTOR,
      });
      const verifier = { type: 'user' as const, id: financeId, role: 'finance' };

      await expect(
        verifyCashPayment({ paymentId: gateway.paymentId, verifier }),
      ).rejects.toBeInstanceOf(CashPaymentNotFoundError);
      await expect(verifyCashPayment({ paymentId: 987654321, verifier })).rejects.toBeInstanceOf(
        CashPaymentNotFoundError,
      );

      // The gateway row was not restamped, and the money did not move again.
      const payment = await paymentRow(gateway.paymentId);
      expect(payment.verified_by).toBeNull();
      expect(Number((await bookingRow(bookingId)).amount_paid_centavos)).toBe(100000);
    });

    /**
     * Cash that would take the booking past its total is refused, failing
     * closed — `recordPayment()`'s overpay invariant, which this path
     * credits through and so must keep. A driver mistyping 600,000 for
     * 60,000 is the realistic version, and it must not be creditable.
     *
     * The PENDING row is deliberately still allowed in: the driver's claim
     * is a claim, and finance needs to see the wrong number in order to
     * resolve it. It simply never becomes money.
     */
    dbIt('REFUSES verifying cash that would overpay the booking', async () => {
      const driverId = await makeDriver();
      const financeId = await makeStaff('finance');
      const { bookingId } = await makeBooking({
        totalCentavos: 100000,
        amountPaidCentavos: 40000,
        status: 'confirmed',
        holdExpiresAt: null,
      });
      const { paymentId } = await recordPendingCash({
        bookingId,
        amountCentavos: 600000,
        collectedByDriverId: driverId,
      });

      await expect(
        verifyCashPayment({
          paymentId,
          verifier: { type: 'user', id: financeId, role: 'finance' },
        }),
      ).rejects.toBeInstanceOf(PaymentOverpaysBookingError);

      expect((await paymentRow(paymentId)).status).toBe('pending');
      expect(Number((await bookingRow(bookingId)).amount_paid_centavos)).toBe(40000);
    });

    /**
     * Cash on a booking that was cancelled while the van was out gets
     * `recordPayment()`'s dead-booking treatment, unchanged: the money is
     * credited (it is real, and a refund is measured against it), the
     * review flag goes up, and the status is left exactly as it was.
     * Nothing auto-confirms.
     */
    dbIt('credits cash on a cancelled booking but changes no status', async () => {
      const driverId = await makeDriver();
      const financeId = await makeStaff('finance');
      const { bookingId } = await makeBooking({
        totalCentavos: 100000,
        status: 'cancelled',
        holdExpiresAt: null,
      });
      const { paymentId } = await recordPendingCash({
        bookingId,
        amountCentavos: 100000,
        collectedByDriverId: driverId,
      });

      const result = await verifyCashPayment({
        paymentId,
        verifier: { type: 'user', id: financeId, role: 'finance' },
      });
      expect(result.bookingStatus).toBe('cancelled');
      expect(result.paymentReviewRequired).toBe(true);

      const booking = await bookingRow(bookingId);
      expect(booking.status, 'verified cash resurrected a dead booking').toBe('cancelled');
      expect(Number(booking.amount_paid_centavos)).toBe(100000);
      expect(Number(booking.payment_review_required)).toBe(1);
    });

    /**
     * A tour-day collection arrives when the trip is `in_progress` or
     * `completed`, and verifying it must not walk the booking BACKWARDS to
     * `confirmed` — that would un-finish a tour that ran and hand its
     * capacity back to the §5 availability check.
     */
    dbIt('does not walk a completed booking back to confirmed', async () => {
      const driverId = await makeDriver();
      const financeId = await makeStaff('finance');
      const { bookingId } = await makeBooking({
        totalCentavos: 100000,
        amountPaidCentavos: 30000,
        status: 'completed',
        holdExpiresAt: null,
      });
      const { paymentId } = await recordPendingCash({
        bookingId,
        amountCentavos: 70000,
        collectedByDriverId: driverId,
      });

      const result = await verifyCashPayment({
        paymentId,
        verifier: { type: 'user', id: financeId, role: 'finance' },
      });
      expect(result.bookingStatus).toBe('completed');

      const booking = await bookingRow(bookingId);
      expect(booking.status, 'a finished trip was walked back to confirmed').toBe('completed');
      // The money still lands, and the flag stays down — a completed
      // booking is not a dead one.
      expect(Number(booking.amount_paid_centavos)).toBe(100000);
      expect(Number(booking.payment_review_required)).toBe(0);
    });

    /** Nothing is written for a booking that does not exist. */
    dbIt('REFUSES pending cash for a booking that does not exist', async () => {
      const driverId = await makeDriver();
      await expect(
        recordPendingCash({
          bookingId: 987654321,
          amountCentavos: 10000,
          collectedByDriverId: driverId,
        }),
      ).rejects.toBeInstanceOf(BookingNotFoundError);
      expect(
        await rows(sql`SELECT id FROM payments WHERE collected_by_driver_id = ${driverId}`),
      ).toHaveLength(0);
    });
  });
});
