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
import { and, eq, inArray, isNotNull, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import {
  bookingCutoffInstant,
  depositCentavos,
  manilaCivilDate,
  manualTransferMethodSchema,
  RECEIPT_CAP_MESSAGE,
  RECEIPT_REUPLOAD_WINDOW_MS,
  RECEIPT_UPLOAD_MAX_PER_BOOKING,
  transferReferenceSchema,
  type BookingStatus,
  type BookingWindowSettings,
} from '@rg/shared';
import { readSettingBlock } from '../../content/settings';
import { getDb, type Transaction } from '../../db/client';
import { AUDIT_ACTOR_TYPES, bookings, payments } from '../../db/schema';
import { writeAudit } from '../audit';
import {
  BookingNotFoundError,
  ReceiptAlreadyDecidedError,
  ReceiptLimitReachedError,
  ReceiptNotAcceptedError,
  ReceiptPaymentNotFoundError,
  ReceiptRejectionNeedsReasonError,
  type ReceiptRefusalReason,
} from './errors';
import { approveManualReceipt, assertMayVerifyPayments } from './record-payment';

/**
 * The one definition of "a guest receipt row", used by the cap, the
 * supersede and the decision alike.
 *
 * `receipt_path IS NOT NULL` is what separates it from a driver's pending
 * CASH row (§8), which is also `provider='manual'` and also `pending`. Every
 * query in this module goes through here so that distinction cannot be
 * forgotten in one place and remembered in three.
 */
function receiptRow(paymentId: number): SQL {
  return and(
    eq(payments.id, paymentId),
    eq(payments.type, 'payment'),
    eq(payments.provider, 'manual'),
    isNotNull(payments.receiptPath),
  ) as SQL;
}

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

/* ======================================================================
 * The decision (Week 4 plan, Task 7; §6 step 5).
 *
 * **Approve lives in `record-payment.ts`, and that split is deliberate.**
 * Approval moves `bookings.amount_paid_centavos`, which only the module
 * that owns `recordPayment()` may write — a rule a guard test enforces
 * rather than a convention. Rejection moves no money at all, so it lives
 * here beside the upload it undoes, and `decideManualReceipt()` is the one
 * door an admin screen calls either way.
 * ====================================================================== */

/**
 * The verifier, in `assertMayVerifyPayments`'s shape. `role` is `unknown`
 * on purpose: the gate re-parses it against `ADMIN_ROLES` and refuses a
 * missing role, a number and a plausible-looking string alike, rather than
 * trusting what a type annotation claims.
 */
export interface ReceiptVerifier {
  /**
   * The audit actor types, so a caller cannot invent one at compile time.
   * `driver`, `system` and `provider` are representable and are REFUSED by
   * the gate rather than by the type system, because that refusal is the
   * property worth testing: §8's driver may claim money, never verify it.
   */
  type: (typeof AUDIT_ACTOR_TYPES)[number];
  id: number | null;
  /** `users.role`, re-parsed against `ADMIN_ROLES` by the gate. */
  role: unknown;
}

export interface DecideManualReceiptResult {
  paymentId: number;
  bookingId: number;
  decision: 'approve' | 'reject';
  /** The booking's status after the decision. */
  bookingStatus: BookingStatus;
  /**
   * When a rejected guest must have re-uploaded by — null on an approval.
   * The earlier of twelve hours and the booking cutoff for the tour date.
   */
  reuploadBy: Date | null;
}

/**
 * The deadline a rejection leaves the guest (owner decision 2026-10-13, Q8
 * — _proposed by developer, pending R&G confirmation_).
 *
 *     min(rejectedAt + 12h, bookingCutoffInstant(tourDate))
 *
 * The second bound is the one that matters. Twelve flat hours would hand a
 * guest rejected at 23:00 the night before a tour until 11:00 the next
 * morning, for a trip that left at 7am — and the hold would keep a van
 * seat that nobody can now pay for. The cutoff is the same instant the
 * booking window itself closes for that date, so the two cannot disagree.
 *
 * It may be in the PAST, when a receipt is rejected after the cutoff has
 * already gone by. That is correct and needs no special case: the expiry
 * sweep releases the capacity on its next run, which is exactly what should
 * happen to a booking that can no longer be paid for.
 */
export function reuploadDeadline(
  rejectedAt: Date,
  tourDate: Date,
  settings: Pick<BookingWindowSettings, 'minLeadDays' | 'nextDayCutoffTime'>,
): Date {
  const twelveHours = new Date(rejectedAt.getTime() + RECEIPT_REUPLOAD_WINDOW_MS);
  const cutoff = bookingCutoffInstant(manilaCivilDate(tourDate), settings);
  return cutoff.getTime() < twelveHours.getTime() ? cutoff : twelveHours;
}

/**
 * Approve or reject the pending receipt on a booking.
 *
 * **Approve** hands straight to `approveManualReceipt()`: payment `paid`,
 * `verified_by` / `verified_at` set, `amount_paid_centavos` credited once,
 * booking `confirmed`.
 *
 * **Reject** sets `status='rejected'` with the reason the GUEST will read,
 * returns the booking to `pending_payment` — not cancelled (owner
 * decision 2026-10-13, Q7) — and sets `hold_expires_at` to the Q8
 * deadline. Nothing else changes: no money moves, and the receipt file
 * stays exactly where it is.
 *
 * **The expiry sweep needs no change to release the capacity afterwards.**
 * It already expires `pending_payment` bookings whose `hold_expires_at` has
 * passed and already skips anything with money against it or flagged for
 * review. Setting the status and the deadline IS the release, which is why
 * `jobs/expire-holds.ts` is untouched by this task — and why
 * `manual-receipt-decide.test.ts` drives the real sweep to prove it rather
 * than asserting it in a comment.
 *
 * Rejects, writing nothing, when the actor may not verify payments, when
 * the id is not a receipt row, when that row is not `pending` (already
 * decided, or superseded by a newer upload), or when a rejection carries no
 * reason.
 */
export async function decideManualReceipt(input: {
  paymentId: number;
  decision: 'approve' | 'reject';
  reason?: string;
  verifier: ReceiptVerifier;
  now: Date;
}): Promise<DecideManualReceiptResult> {
  const { paymentId, decision, verifier, now } = input;

  if (decision === 'approve') {
    const result = await approveManualReceipt({ paymentId, verifier });
    return {
      paymentId,
      bookingId: result.bookingId,
      decision,
      bookingStatus: result.bookingStatus,
      reuploadBy: null,
    };
  }

  /*
   * The reason is checked BEFORE the role gate would even matter, because
   * it costs nothing — but after it in order, so that an unauthorised
   * actor learns nothing from the shape of the refusal. Trimmed, because a
   * reason of three spaces is a blank one with extra steps.
   */
  const verifiedBy = assertMayVerifyPayments(verifier);
  const reason = (input.reason ?? '').trim();
  if (reason.length === 0) throw new ReceiptRejectionNeedsReasonError();

  /*
   * Read OUTSIDE the transaction: it is a different pooled connection, and
   * holding the booking row lock while fetching settings would widen the
   * window every other writer waits on for no reason.
   */
  const bookingSettings = await readSettingBlock('booking');

  return getDb().transaction(async (tx: Transaction) => {
    // Unlocked, and used only to find which booking to lock — its status
    // is deliberately not trusted; the locking re-read below is.
    const [unlocked] = await tx
      .select({ bookingId: payments.bookingId })
      .from(payments)
      .where(receiptRow(paymentId))
      .limit(1);
    if (!unlocked) throw new ReceiptPaymentNotFoundError(paymentId);

    const [booking] = await tx
      .select({ ref: bookings.ref, status: bookings.status, tourDate: bookings.tourDate })
      .from(bookings)
      .where(eq(bookings.id, unlocked.bookingId))
      .for('update')
      .limit(1);
    if (!booking) throw new BookingNotFoundError(unlocked.bookingId);

    /*
     * The authoritative read, `FOR UPDATE` and after the booking lock — the
     * same ordering every path in `record-payment.ts` uses, so none of them
     * can deadlock against another. Two admins deciding one receipt at once
     * are serialised here, and the second is refused.
     */
    const [payment] = await tx
      .select({ status: payments.status })
      .from(payments)
      .where(receiptRow(paymentId))
      .for('update')
      .limit(1);
    if (!payment) throw new ReceiptPaymentNotFoundError(paymentId);
    if (payment.status !== 'pending') {
      throw new ReceiptAlreadyDecidedError(paymentId, payment.status);
    }

    const reuploadBy = reuploadDeadline(now, booking.tourDate, bookingSettings);

    await tx
      .update(payments)
      .set({ status: 'rejected', rejectReason: reason })
      .where(eq(payments.id, paymentId));

    /*
     * Back to `pending_payment`, which is the owner's Q7 answer and the
     * opposite of what this plan originally proposed: the guest still has a
     * booking and something to do about it. `payment_review_required` is
     * deliberately NOT set — that flag means "money arrived that an admin
     * must resolve", and here no money arrived.
     */
    await tx
      .update(bookings)
      .set({ status: 'pending_payment', holdExpiresAt: reuploadBy })
      .where(eq(bookings.id, unlocked.bookingId));

    await writeAudit(tx, {
      // The admin, by `users.id`. "Who rejected what, and why" has to be
      // answerable months later (§10, and the owner's Q7).
      actorType: 'user',
      actorId: verifiedBy,
      action: 'payment.rejected',
      entity: 'payments',
      entityId: paymentId,
      data: {
        bookingRef: booking.ref,
        reason,
        priorPaymentStatus: 'pending',
        paymentStatus: 'rejected',
        priorBookingStatus: booking.status,
        bookingStatus: 'pending_payment',
        reuploadBy: reuploadBy.toISOString(),
      },
    });

    return {
      paymentId,
      bookingId: unlocked.bookingId,
      decision: 'reject' as const,
      bookingStatus: 'pending_payment' as const,
      reuploadBy,
    };
  });
}
