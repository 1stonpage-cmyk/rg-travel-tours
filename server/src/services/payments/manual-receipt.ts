/**
 * `recordManualReceipt()` — a guest's transfer receipt (BUILD_SPEC §6 steps
 * 3–4, Week 4 plan Task 6).
 *
 * **This function marks nothing paid, and that is its entire design.** It
 * records a CLAIM: the guest says they sent money and here is a screenshot.
 * The row it writes is `status='pending'`, `bookings.amount_paid_centavos`
 * is not touched, and the booking goes to `pending_verification` — a status
 * that holds capacity but is not `confirmed`. Only an admin approval
 * (Task 7, through `recordPayment()`) or a verified gateway webhook turns
 * money into money, which is CLAUDE.md's rule and §6's.
 *
 * It is deliberately NOT `recordPayment()` with different arguments.
 * `recordPayment()` moves `amount_paid_centavos` and confirms a booking;
 * giving a guest-triggered path any share of that code would be one
 * refactor away from a photo confirming a booking.
 *
 * ## The server computes the amount
 *
 * There is no `amountCentavos` input. The amount recorded is what the
 * BOOKING says is owed — the deposit, or the full total for a `full`
 * booking, less anything already paid — because CLAUDE.md's first DO NOT is
 * "do not trust prices, totals, deposits, or discounts sent from the
 * browser". A guest typing "₱1.00" must not produce a payment row that says
 * so, and an admin comparing the receipt against the amount in Task 7 needs
 * that amount to be ours.
 *
 * ## Supersede, never replace (owner decision 2026-10-14, Q6)
 *
 * A second receipt while the first is still pending does not overwrite it:
 * the older row becomes `superseded` and keeps its file. A replaced row
 * destroys the evidence of what the guest first sent, which is exactly what
 * is wanted when a transfer is disputed. Only the newest row is `pending`,
 * and Task 7 can only act on a `pending` row, so the decision path has
 * exactly one candidate at all times.
 *
 * Five per booking, then a human takes over.
 *
 * ## The booking row is locked FIRST
 *
 * `SELECT … FOR UPDATE` on the same `bookings` row that `recordPayment()`
 * locks, before anything is read or decided. That is what stops a webhook
 * and an upload interleaving: without it, a payment could land between this
 * function's read of the status and its write of `pending_verification`,
 * and the upload would quietly drag a `confirmed` booking backwards.
 *
 * Everything else here — the cap, the supersede, the insert, the booking
 * update, the audit row — happens inside that same transaction, so a
 * failure anywhere leaves no half-submitted receipt.
 */
import { and, eq, inArray, isNotNull } from 'drizzle-orm';
import { z } from 'zod';
import {
  depositCentavos,
  manualTransferMethodSchema,
  RECEIPT_CAP_MESSAGE,
  RECEIPT_UPLOAD_MAX_PER_BOOKING,
  transferReferenceSchema,
} from '@rg/shared';
import { getDb, type Transaction } from '../../db/client';
import { bookings, payments } from '../../db/schema';
import { writeAudit } from '../audit';
import {
  BookingNotFoundError,
  ReceiptLimitReachedError,
  ReceiptNotAcceptedError,
  type ReceiptRefusalReason,
} from './errors';

/**
 * Validated here as well as at the HTTP door, and `method` against the
 * SHARED list rather than the database's `PAYMENT_METHODS`.
 *
 * The difference is the point: `cash` and `card` are real payment methods
 * and real flows (§8's driver collection, the gateway's card charge), and
 * neither is something a guest uploads a receipt for. A schema that
 * accepted every database enum value would let the office's cash flow be
 * driven from the guest's door.
 *
 * `receiptPath` is a bare filename, not a path: `storeReceipt()` generates
 * 32 hex characters plus one of four extensions, and anything with a
 * separator in it has no business reaching a column that a download route
 * resolves against a directory.
 */
const inputSchema = z
  .object({
    bookingId: z.number().int().positive(),
    method: manualTransferMethodSchema,
    txnRef: transferReferenceSchema,
    receiptPath: z
      .string()
      .regex(/^[0-9a-f]{32}\.(jpg|png|webp|pdf)$/, 'not a stored receipt filename'),
    now: z.date(),
  })
  .strict();

export type RecordManualReceiptInput = z.input<typeof inputSchema>;

export interface RecordManualReceiptResult {
  /** The new `pending` row. Task 7's approve/reject is given this id. */
  paymentId: number;
  /** The rows this submission pushed aside, for the caller's audit trail. */
  supersededPaymentIds: number[];
  /** What the guest now owes, as recorded on the row. */
  amountCentavos: number;
}

/** What the booking expects to be paid up front: the deposit, or everything. */
function expectedCentavos(booking: {
  payMode: 'full' | 'deposit';
  totalCentavos: number;
  depositPercent: number;
}): number {
  if (booking.payMode === 'full') return booking.totalCentavos;
  return depositCentavos(booking.totalCentavos, booking.depositPercent);
}

/**
 * Why this booking cannot take a receipt, or `null` if it can — decided
 * from the LOCKED row and nothing else.
 *
 * Only two statuses may receive one: `pending_payment` (the first receipt,
 * and a re-upload after a rejection, which returns the booking there — Q7)
 * and `pending_verification` (a second receipt while the first is waiting).
 * Everything else is refused, and each refusal names itself so the guest
 * gets a sentence that fits what actually happened.
 */
function refusalReason(
  booking: { status: string; holdExpiresAt: Date | null },
  due: number,
  now: Date,
): ReceiptRefusalReason | null {
  if (booking.status === 'cancelled') return 'booking_cancelled';
  if (booking.status === 'expired') return 'booking_expired';
  if (booking.status !== 'pending_payment' && booking.status !== 'pending_verification') {
    // `confirmed`, `assigned`, `in_progress`, `completed` — the money is in
    // and the trip is live or done.
    return 'already_paid';
  }
  /*
   * A hold that lapsed but whose cron sweep has not run yet. §5: an upload
   * BEFORE expiry stops the expiry; after it, the capacity is already being
   * released and a receipt must not resurrect the booking behind the
   * sweep's back. `<=` and not `<`: a hold expiring exactly now has
   * expired, which is the boundary the test lands on.
   */
  if (booking.holdExpiresAt !== null && booking.holdExpiresAt.getTime() <= now.getTime()) {
    return 'hold_expired';
  }
  if (due <= 0) return 'nothing_due';
  return null;
}

/**
 * Records a guest's manual transfer receipt against their booking.
 *
 * Resolves with the new `pending` payment id, the ids it superseded, and
 * the amount recorded. Rejects — writing nothing — when the booking is
 * missing, when it cannot accept a receipt, or when the cap is reached.
 */
export async function recordManualReceipt(
  input: RecordManualReceiptInput,
): Promise<RecordManualReceiptResult> {
  const parsed = inputSchema.parse(input);

  return getDb().transaction(async (tx: Transaction) => {
    /*
     * THE LOCK, and it is the transaction's first statement. The same row
     * `recordPayment()` takes, so an upload and a webhook for one booking
     * are serialised rather than interleaved.
     */
    const [booking] = await tx
      .select({
        ref: bookings.ref,
        status: bookings.status,
        payMode: bookings.payMode,
        totalCentavos: bookings.totalCentavos,
        /*
         * Aliased `paidCentavos`, not `amountPaidCentavos`. The payment
         * guard in `schema-conventions.test.ts` treats ANY
         * `amountPaidCentavos:` in the server tree as a writer of that
         * column — deliberately, since a false positive costs a rename and
         * a false negative costs a money bug — and renaming the read is the
         * accommodation it asks for. This module reads that column and must
         * never write it.
         */
        paidCentavos: bookings.amountPaidCentavos,
        holdExpiresAt: bookings.holdExpiresAt,
        priceSnapshot: bookings.priceSnapshot,
      })
      .from(bookings)
      .where(eq(bookings.id, parsed.bookingId))
      .for('update')
      .limit(1);
    if (!booking) throw new BookingNotFoundError(parsed.bookingId);

    const expected = expectedCentavos({
      payMode: booking.payMode,
      totalCentavos: booking.totalCentavos,
      depositPercent: booking.priceSnapshot.depositPercent,
    });
    const due = expected - booking.paidCentavos;

    const reason = refusalReason(booking, due, parsed.now);
    if (reason) throw new ReceiptNotAcceptedError(parsed.bookingId, reason);

    /*
     * Every receipt this booking has ever had, superseded and rejected ones
     * included. `receipt_path IS NOT NULL` is what separates them from a
     * driver's pending CASH row (§8), which is also `provider='manual'` and
     * also `pending` — and which a guest's upload must neither supersede
     * nor count against.
     */
    const existing = await tx
      .select({ id: payments.id, status: payments.status })
      .from(payments)
      .where(
        and(
          eq(payments.bookingId, parsed.bookingId),
          eq(payments.provider, 'manual'),
          eq(payments.type, 'payment'),
          isNotNull(payments.receiptPath),
        ),
      );

    /*
     * The cap, checked before anything is written.
     *
     * What keeps a refused sixth upload from pushing the fifth receipt
     * aside is the TRANSACTION, not this ordering: a throw anywhere in here
     * rolls the supersede back with everything else. The order is simply
     * the cheap check first. Saying otherwise — as an earlier draft of this
     * comment did — would credit the sequence with a guarantee the
     * transaction is actually providing, and the next person to reorder
     * these lines would believe they had broken something.
     */
    if (existing.length >= RECEIPT_UPLOAD_MAX_PER_BOOKING) {
      throw new ReceiptLimitReachedError(parsed.bookingId, existing.length, RECEIPT_CAP_MESSAGE);
    }

    const supersededPaymentIds = existing.filter((r) => r.status === 'pending').map((r) => r.id);
    if (supersededPaymentIds.length > 0) {
      await tx
        .update(payments)
        .set({ status: 'superseded' })
        .where(inArray(payments.id, supersededPaymentIds));
    }

    const [inserted] = await tx.insert(payments).values({
      bookingId: parsed.bookingId,
      type: 'payment',
      provider: 'manual',
      method: parsed.method,
      // OURS, never the guest's. See the module note.
      amountCentavos: due,
      // THE point of this function. Not `paid`.
      status: 'pending',
      txnRef: parsed.txnRef,
      receiptPath: parsed.receiptPath,
      // Nobody has verified anything: both halves are Task 7's to fill in.
      verifiedBy: null,
      verifiedAt: null,
    });
    const paymentId = Number(inserted.insertId);

    /*
     * §6 step 4 and §5. `hold_expires_at` is NULLED, which is what takes
     * the booking out of the expiry sweep's candidate set: the guest has
     * done their part and the clock must not run out while an admin looks
     * at the receipt. `pending_verification` still holds capacity (§5's
     * table), so nothing is given away by waiting.
     */
    await tx
      .update(bookings)
      .set({ status: 'pending_verification', holdExpiresAt: null })
      .where(eq(bookings.id, parsed.bookingId));

    await writeAudit(tx, {
      // The guest did this. `customer` with a null id, as everywhere else:
      // there is no customers table for an id to point at.
      actorType: 'customer',
      actorId: null,
      /*
       * Its own verb. Not `payment.recorded` — nothing has been recorded as
       * received — and not `payment.cash_collected`, which is the driver's.
       * A money trail that used one word for "a guest says they paid" and
       * "the money arrived" would be unreadable at exactly the moment it
       * mattered.
       */
      action: 'payment.receipt_submitted',
      entity: 'payments',
      entityId: paymentId,
      data: {
        bookingRef: booking.ref,
        bookingStatus: 'pending_verification',
        paymentStatus: 'pending',
        method: parsed.method,
        amountCentavos: due,
        txnRef: parsed.txnRef,
        receiptPath: parsed.receiptPath,
        // Explicit, so the trail says what this submission pushed aside
        // rather than leaving a reader to infer it from timestamps.
        supersededPaymentIds,
      },
    });

    return { paymentId, supersededPaymentIds, amountCentavos: due };
  });
}
