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
import { bookings, destinations, tours } from '../db/schema';
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

const { recordPayment } = await import('../services/payments/record-payment');
const {
  BookingNotFoundError,
  PaymentAmountMismatchError,
  PaymentOverpaysBookingError,
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
    holdExpiresAt: new Date('2099-12-24T00:00:00Z'),
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
  one<{ status: string; amount_paid_centavos: number; hold_expires_at: Date | null }>(
    sql`SELECT status, amount_paid_centavos, hold_expires_at FROM bookings WHERE id = ${bookingId}`,
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
});
