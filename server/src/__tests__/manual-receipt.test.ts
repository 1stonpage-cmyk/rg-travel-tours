/**
 * Week 4 plan, Task 6 — `recordManualReceipt()`, §6 steps 3–4.
 *
 * **The property this whole suite exists to protect: a guest's receipt
 * marks NOTHING paid.** It creates a claim an admin has to look at. So
 * every test below checks `amount_paid_centavos` and the booking status as
 * well as whatever else it is about — because the failure mode worth
 * fearing here is not an error, it is a booking that quietly reads
 * "confirmed" because someone uploaded a photo.
 *
 * Fixtures are COMMITTED and torn down by id, for the reason
 * `record-payment.test.ts` sets out at length: the function under test
 * opens its own transaction on its own pooled connection, so an
 * uncommitted booking is a booking it cannot see. The teardown here is the
 * second of the two places in this codebase that delete a payment row, and
 * it deletes exactly the ids this file created.
 */
import { afterAll, expect, it } from 'vitest';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { RECEIPT_UPLOAD_MAX_PER_BOOKING } from '@rg/shared';
import type { BookingStatus } from '@rg/shared';
import { getDb, getPool } from '../db/client';
import { auditLog, bookings, destinations, payments, tours } from '../db/schema';
import { generateBookingRef } from '../services/booking-ref';
import {
  recordManualReceipt,
  type RecordManualReceiptInput,
} from '../services/payments/manual-receipt';
import {
  BookingNotFoundError,
  ReceiptLimitReachedError,
  ReceiptNotAcceptedError,
  type ReceiptRefusalReason,
} from '../services/payments/errors';
import { describeWithDb } from './helpers/db';

const NOW = new Date('2026-10-14T06:00:00Z');
/** ₱10,000.00, of which 30% — ₱3,000.00 — is the deposit every fixture owes. */
const TOTAL = 1_000_000;
const DEPOSIT = 300_000;

const created = {
  bookingIds: [] as number[],
  tourIds: [] as number[],
  destinationIds: [] as number[],
};

async function makeBooking(
  opts: { status?: BookingStatus; holdExpiresAt?: Date | null; amountPaidCentavos?: number } = {},
): Promise<{ bookingId: number; ref: string }> {
  const db = getDb();
  const unique = `__receipt__${Date.now()}_${Math.floor(Math.random() * 1e9)}`;
  const [destination] = await db.insert(destinations).values({ name: unique, slug: unique });
  created.destinationIds.push(destination.insertId);
  const [tour] = await db
    .insert(tours)
    .values({ slug: unique, title: unique, destinationId: destination.insertId });
  created.tourIds.push(tour.insertId);

  const ref = generateBookingRef();
  const [booking] = await db.insert(bookings).values({
    ref,
    tourId: tour.insertId,
    tourDate: new Date('2099-12-25T00:00:00Z'),
    pax: 2,
    leadName: 'Receipt Fixture',
    leadEmail: 'receipt-fixture@example.test',
    leadPhone: '09170000000',
    status: opts.status ?? 'pending_payment',
    payMode: 'deposit',
    priceSnapshot: {
      tier: { tierId: 1, minPax: 1, maxPax: 6, pricePerPersonCentavos: TOTAL / 2 },
      addons: [],
      coupon: null,
      depositPercent: 30,
      freeCancelHours: 48,
      subtotalCentavos: TOTAL,
      discountCentavos: 0,
      totalCentavos: TOTAL,
    },
    subtotalCentavos: TOTAL,
    totalCentavos: TOTAL,
    amountPaidCentavos: opts.amountPaidCentavos ?? 0,
    // A live hold by default, so every test can prove the upload clears it.
    holdExpiresAt:
      opts.holdExpiresAt === undefined ? new Date('2099-12-24T00:00:00Z') : opts.holdExpiresAt,
  });
  created.bookingIds.push(booking.insertId);
  return { bookingId: booking.insertId, ref };
}

let counter = 0;
function submission(bookingId: number, over: Partial<RecordManualReceiptInput> = {}) {
  counter += 1;
  return {
    bookingId,
    method: 'gcash' as const,
    txnRef: `REF${String(counter).padStart(10, '0')}`,
    // The shape storeReceipt() generates: 32 hex characters and an extension.
    receiptPath: `${counter.toString(16).padStart(32, '0')}.jpg`,
    now: NOW,
    ...over,
  };
}

async function readBooking(bookingId: number) {
  const [row] = await getDb()
    .select({
      status: bookings.status,
      paid: bookings.amountPaidCentavos,
      holdExpiresAt: bookings.holdExpiresAt,
      reviewRequired: bookings.paymentReviewRequired,
    })
    .from(bookings)
    .where(eq(bookings.id, bookingId));
  return row!;
}

/** Receipt rows only — a driver's cash row has no `receipt_path`. */
async function readReceipts(bookingId: number) {
  return getDb()
    .select({
      id: payments.id,
      status: payments.status,
      method: payments.method,
      provider: payments.provider,
      type: payments.type,
      amountCentavos: payments.amountCentavos,
      txnRef: payments.txnRef,
      receiptPath: payments.receiptPath,
      verifiedBy: payments.verifiedBy,
    })
    .from(payments)
    .where(and(eq(payments.bookingId, bookingId), sql`${payments.receiptPath} IS NOT NULL`))
    .orderBy(payments.id);
}

/*
 * Teardown uses RAW SQL through the pool for `bookings` and `payments`,
 * never Drizzle's `.delete()`.
 *
 * `schema-conventions.test.ts` forbids `.delete(bookings)` and
 * `.delete(payments)` anywhere in the server tree, tests included, and
 * scans only application source for the raw form — so raw SQL in a fixture
 * teardown is the shape the guard is built to allow. It is cleanup in
 * `rg_travel_test`, not shipped behaviour, and `record-payment.test.ts`
 * does the same for the same reason.
 */
afterAll(async () => {
  const ids = created.bookingIds;
  if (ids.length > 0) {
    const pool = getPool();
    const marks = ids.map(() => '?').join(',');
    await pool.query(`DELETE FROM payments WHERE booking_id IN (${marks})`, ids);
    await getDb()
      .delete(auditLog)
      .where(sql`${auditLog.action} LIKE 'payment.receipt%'`);
    await pool.query(`DELETE FROM bookings WHERE id IN (${marks})`, ids);
  }
  if (created.tourIds.length > 0) {
    await getDb().delete(tours).where(inArray(tours.id, created.tourIds));
  }
  if (created.destinationIds.length > 0) {
    await getDb().delete(destinations).where(inArray(destinations.id, created.destinationIds));
  }
});

/**
 * Asserts a refusal by CLASS and by REASON.
 *
 * Both, because every refusal here is the same class and the reason is what
 * picks the sentence the guest reads — and because a mutation run found two
 * tests that passed against a booking refused for entirely the wrong
 * reason when only the class was checked.
 */
async function expectRefusal(
  promise: Promise<unknown>,
  reason: ReceiptRefusalReason,
  hint?: string,
): Promise<void> {
  const error = await promise.catch((e: unknown) => e);
  expect(error, hint ?? 'the call did not refuse at all').toBeInstanceOf(ReceiptNotAcceptedError);
  expect((error as ReceiptNotAcceptedError).reason, hint).toBe(reason);
}

describeWithDb('recordManualReceipt', () => {
  it('writes ONE pending manual payment row and marks nothing paid', async () => {
    const { bookingId } = await makeBooking();
    const input = submission(bookingId);

    const { paymentId } = await recordManualReceipt(input);

    const rows = await readReceipts(bookingId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: paymentId,
      type: 'payment',
      provider: 'manual',
      method: 'gcash',
      status: 'pending',
      txnRef: input.txnRef,
      receiptPath: input.receiptPath,
      // Nobody has verified anything yet.
      verifiedBy: null,
    });

    const booking = await readBooking(bookingId);
    expect(booking.paid, 'a guest receipt moved money onto the booking').toBe(0);
    expect(booking.status).not.toBe('confirmed');
    expect(booking.reviewRequired).toBe(false);
  });

  /**
   * The amount is the DEPOSIT the booking owes, computed from the booking —
   * never a number the guest typed. CLAUDE.md: the server computes all
   * money. There is no input field for it, and this pins what the server
   * puts in the column.
   */
  it('records the amount the BOOKING says is owed, not a guest-supplied figure', async () => {
    const { bookingId } = await makeBooking();
    await recordManualReceipt(submission(bookingId));
    expect((await readReceipts(bookingId))[0]!.amountCentavos).toBe(DEPOSIT);
  });

  /** §6 step 4, and §5: the upload is what stops the expiry sweep. */
  it('moves the booking to pending_verification and CLEARS hold_expires_at', async () => {
    const { bookingId } = await makeBooking();
    expect((await readBooking(bookingId)).holdExpiresAt).not.toBeNull();

    await recordManualReceipt(submission(bookingId));

    const booking = await readBooking(bookingId);
    expect(booking.status).toBe('pending_verification');
    expect(
      booking.holdExpiresAt,
      'the hold still expires — the sweep will release a booking that has paid',
    ).toBeNull();
  });

  it('writes one audit row naming the booking and the payment', async () => {
    const { bookingId, ref } = await makeBooking();
    const { paymentId } = await recordManualReceipt(submission(bookingId));

    const rows = await getDb()
      .select({
        action: auditLog.action,
        actorType: auditLog.actorType,
        actorId: auditLog.actorId,
        entity: auditLog.entity,
        entityId: auditLog.entityId,
        data: auditLog.data,
      })
      .from(auditLog)
      .where(eq(auditLog.action, 'payment.receipt_submitted'))
      .orderBy(sql`${auditLog.id} DESC`)
      .limit(1);

    expect(rows[0]!.actorType).toBe('customer');
    expect(rows[0]!.actorId, 'a customer is not a row in any table').toBeNull();
    expect(rows[0]!.entity).toBe('payments');
    expect(Number(rows[0]!.entityId)).toBe(paymentId);
    const data = JSON.stringify(rows[0]!.data);
    expect(data).toContain(ref);
    expect(data).toContain('pending');
  });

  /**
   * **Supersede, not replace** (owner decision 2026-10-14, Q6). Both rows
   * survive: the older one is marked `superseded` and keeps its file, and
   * only the newest is `pending` — which is the one Task 7 can act on.
   */
  it('marks the older pending receipt superseded and keeps it', async () => {
    const { bookingId } = await makeBooking();
    const first = submission(bookingId);
    const second = submission(bookingId);

    const a = await recordManualReceipt(first);
    const b = await recordManualReceipt(second);

    const rows = await readReceipts(bookingId);
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.id === a.paymentId)!.status).toBe('superseded');
    expect(rows.find((r) => r.id === b.paymentId)!.status).toBe('pending');
    // The older row keeps its evidence — that is the point of keeping it.
    expect(rows.find((r) => r.id === a.paymentId)!.receiptPath).toBe(first.receiptPath);
  });

  it('leaves exactly one pending row however long the chain gets', async () => {
    const { bookingId } = await makeBooking();
    for (let i = 0; i < 4; i += 1) await recordManualReceipt(submission(bookingId));

    const rows = await readReceipts(bookingId);
    expect(rows.filter((r) => r.status === 'pending')).toHaveLength(1);
    expect(rows.filter((r) => r.status === 'superseded')).toHaveLength(3);
    // The NEWEST row is the pending one, not the oldest.
    expect(rows[rows.length - 1]!.status).toBe('pending');
  });

  /**
   * The cap (owner decision 2026-10-14, Q6): five, then a human. The sixth
   * writes NOTHING — not a row, not an audit entry — and the error carries
   * the message the portal shows in amber.
   */
  it('REFUSES the sixth upload and writes nothing', async () => {
    const { bookingId } = await makeBooking();
    for (let i = 0; i < RECEIPT_UPLOAD_MAX_PER_BOOKING; i += 1) {
      await recordManualReceipt(submission(bookingId));
    }

    const before = await readReceipts(bookingId);
    await expect(recordManualReceipt(submission(bookingId))).rejects.toBeInstanceOf(
      ReceiptLimitReachedError,
    );

    const after = await readReceipts(bookingId);
    expect(after).toHaveLength(before.length);
    expect(after).toHaveLength(RECEIPT_UPLOAD_MAX_PER_BOOKING);
    /*
     * And the fifth is still the live one: a refused sixth must not
     * supersede the receipt an admin is about to look at, which is what a
     * cap checked after the UPDATE would do.
     */
    expect(after.filter((r) => r.status === 'pending')).toHaveLength(1);
    expect(after[after.length - 1]!.status).toBe('pending');
  });

  it('REFUSES a booking that is already confirmed, writing nothing', async () => {
    const { bookingId } = await makeBooking({
      status: 'confirmed',
      holdExpiresAt: null,
      amountPaidCentavos: DEPOSIT,
    });

    /*
     * The REASON, not only the class. A mutation run caught this: with the
     * status allowlist deleted the refusal still happened, because this
     * fixture also has nothing left to pay — so `toBeInstanceOf` alone
     * passed against a booking refused for the wrong reason, and the guest
     * would have been shown the wrong sentence.
     */
    await expectRefusal(recordManualReceipt(submission(bookingId)), 'already_paid');

    expect(await readReceipts(bookingId)).toHaveLength(0);
    const booking = await readBooking(bookingId);
    expect(booking.status).toBe('confirmed');
    expect(booking.paid).toBe(DEPOSIT);
  });

  it('REFUSES a cancelled or expired booking', async () => {
    for (const [status, reason] of [
      ['cancelled', 'booking_cancelled'],
      ['expired', 'booking_expired'],
    ] as const) {
      const { bookingId } = await makeBooking({ status, holdExpiresAt: null });
      // Again the reason, not the class: every refusal here is the same
      // class, and the reason is what picks the guest's sentence.
      await expectRefusal(
        recordManualReceipt(submission(bookingId)),
        reason,
        `a ${status} booking accepted a receipt`,
      );
      expect(await readReceipts(bookingId)).toHaveLength(0);
    }
  });

  /**
   * §5: an upload BEFORE expiry stops the expiry. After it, the capacity is
   * already someone else's — the sweep has it, or is about to — and a
   * receipt must not quietly resurrect the booking.
   *
   * The boundary instant itself is asserted, not bracketed: a hold that
   * expires exactly now is expired. Bracketing a boundary without landing
   * on it is the mistake this project keeps catching.
   */
  it('REFUSES an upload once the hold has lapsed, at the instant itself', async () => {
    const lapsed = await makeBooking({ holdExpiresAt: new Date(NOW.getTime() - 1000) });
    await expectRefusal(recordManualReceipt(submission(lapsed.bookingId)), 'hold_expired');

    const exact = await makeBooking({ holdExpiresAt: NOW });
    await expectRefusal(
      recordManualReceipt(submission(exact.bookingId)),
      'hold_expired',
      'a hold expiring exactly now was treated as still live',
    );

    const live = await makeBooking({ holdExpiresAt: new Date(NOW.getTime() + 1000) });
    await expect(recordManualReceipt(submission(live.bookingId))).resolves.toMatchObject({
      paymentId: expect.any(Number),
    });
  });

  it('REFUSES a booking id that does not exist', async () => {
    await expect(recordManualReceipt(submission(987_654_321))).rejects.toBeInstanceOf(
      BookingNotFoundError,
    );
  });

  /**
   * The method allowlist is the shared schema's job at the HTTP door, but
   * the service must not take anyone's word for it either: `cash` is a real
   * `PAYMENT_METHODS` value and the office/driver flow of §8, and it must
   * not be reachable through the guest's door.
   */
  it('REFUSES a method outside the manual-transfer list', async () => {
    const { bookingId } = await makeBooking();
    for (const method of ['cash', 'card', 'qrph', 'grab_pay']) {
      await expect(
        recordManualReceipt(submission(bookingId, { method: method as never })),
        `${method} was accepted as a manual transfer`,
      ).rejects.toThrow();
    }
    expect(await readReceipts(bookingId)).toHaveLength(0);
  });

  /**
   * The `receipt_path` column feeds a route that resolves it against a
   * directory, so the service takes only the shape `storeReceipt()`
   * generates: 32 lowercase hex characters and one of four extensions.
   *
   * Added after a mutation run: deleting the regex left every test above
   * green, because every fixture happens to pass a valid filename. A
   * validator nothing exercises is a validator that will be deleted by the
   * next refactor.
   */
  it('REFUSES a receipt path that is not a stored filename', async () => {
    const { bookingId } = await makeBooking();
    const forged = [
      '../../.env',
      '/etc/passwd',
      'receipt.jpg',
      `${'A'.repeat(32)}.jpg`,
      `${'a'.repeat(31)}.jpg`,
      `${'a'.repeat(32)}.exe`,
      '',
    ];
    for (const receiptPath of forged) {
      await expect(
        recordManualReceipt(submission(bookingId, { receiptPath })),
        `${receiptPath || '(empty)'} was accepted as a stored receipt`,
      ).rejects.toThrow();
    }
    expect(await readReceipts(bookingId)).toHaveLength(0);
  });

  /**
   * A driver's pending CASH row is also `provider='manual'` and also
   * `pending` (§8, `recordPendingCash`). It has no receipt, it is finance's
   * to reconcile, and a guest uploading a screenshot must neither supersede
   * it nor spend its budget. This is the bug that would otherwise be
   * invisible: every assertion above passes with a filter loose enough to
   * catch it.
   */
  it('never touches a driver cash row', async () => {
    const { bookingId } = await makeBooking();
    const [cash] = await getDb().insert(payments).values({
      bookingId,
      type: 'payment',
      provider: 'manual',
      method: 'cash',
      amountCentavos: 50_000,
      status: 'pending',
    });

    await recordManualReceipt(submission(bookingId));
    await recordManualReceipt(submission(bookingId));

    const [row] = await getDb()
      .select({ status: payments.status })
      .from(payments)
      .where(eq(payments.id, cash.insertId));
    expect(row!.status, 'a guest receipt superseded a driver cash collection').toBe('pending');
  });
});
