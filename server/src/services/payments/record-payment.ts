/**
 * `recordPayment()` — the ONLY path that moves money onto a booking
 * (plan Task 14).
 *
 * **Two callers, ever:** the verified-webhook route (Task 15) and the admin
 * approval procedure (a later week). Not the success-redirect page —
 * BUILD_SPEC §6 is explicit that it "only **reads** status (polls until the
 * webhook lands). It never confirms anything itself". Not the client. Not a
 * `PaymentProvider` implementation: a provider talks to a gateway and
 * reports what happened, it does not get to decide what the database
 * believes.
 *
 * That is the rule CLAUDE.md and §6 state as "only a verified webhook or an
 * admin approval marks a booking paid — for every provider, without
 * exception", and this file is where it lives. The rule is only as strong as
 * the number of places that can write a `payments` row, so keep that number
 * at one.
 *
 * **It never asks the provider registry.** It records what already
 * happened — the money has moved, or an admin has looked at a receipt — so
 * there is nothing to call. That matters beyond tidiness: `provider` may be
 * `manual` (a QR transfer an admin verified by hand), and `manual` is
 * deliberately not in the registry, so `getProvider('manual')` throws
 * `UnknownProviderError` even though it type-checks (Task 13). A gateway
 * lookup in here would refuse every manual payment.
 *
 * **Everything happens in one transaction:** insert the payment row, move
 * `amount_paid_centavos`, move the booking status, write the audit row. A
 * partial application here is a booking that took money and does not know
 * it, which is why every refusal below aborts before the first write rather
 * than after the third.
 */
import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { type BookingStatus, depositCentavos } from '@rg/shared';
import { getDb, type Transaction } from '../../db/client';
import {
  AUDIT_ACTOR_TYPES,
  PAYMENT_METHODS,
  PAYMENT_PROVIDERS,
  PAYMENT_TYPES,
  bookings,
  payments,
} from '../../db/schema';
import { writeAudit } from '../audit';
import {
  BookingNotFoundError,
  PaymentAmountMismatchError,
  PaymentOverpaysBookingError,
  RefundExceedsPaidError,
  RefundNotAdminInitiatedError,
} from './errors';

/**
 * Who caused this (owner decision 2026-10-11, Q10).
 *
 * A webhook-driven change is `provider` with the gateway named in
 * `data.provider` — **never `system`, which means a cron job**. "The cron
 * expired this hold" and "PayMongo confirmed this payment" are different
 * events and collapsing them makes a money trail unreadable. An admin
 * approval is `user` with that admin's id.
 */
const actorSchema = z.object({
  type: z.enum(AUDIT_ACTOR_TYPES),
  /** Null for `provider` and `system`, which are not rows in any table. */
  id: z.number().int().positive().nullable(),
});

/**
 * Validated at the door even though both callers are server-side (CLAUDE.md
 * — Zod on every input). It is deliberately NOT in `/shared`: nothing a
 * browser sends ever reaches this function, and a schema in `/shared` would
 * imply otherwise.
 *
 * `amountCentavos` is `.positive()`, for refunds too. The column is
 * always-positive by design — direction comes from `type`, never a sign
 * (Q11) — and a zero would otherwise let a 0% deposit booking be marked
 * confirmed for nothing.
 */
const recordPaymentInputSchema = z.object({
  bookingId: z.number().int().positive(),
  /** Money IN or money OUT. A refund is a row here, never a booking status. */
  type: z.enum(PAYMENT_TYPES),
  /** WHO processed it, `manual` included. */
  provider: z.enum(PAYMENT_PROVIDERS),
  /** HOW the guest paid — the instrument, never the processor. */
  method: z.enum(PAYMENT_METHODS),
  /** Centavos, always positive. Server-computed; never a browser value. */
  amountCentavos: z.number().int().positive(),
  /** The gateway's own id for this charge or refund. Null on a manual payment. */
  providerRef: z.string().max(191).nullish(),
  /** The gateway's raw status string, kept verbatim for reconciliation. */
  providerStatus: z.string().max(80).nullish(),
  /** Manual QR flow (§6): the guest-entered transaction reference. */
  txnRef: z.string().max(191).nullish(),
  /** A path under /uploads — outside the web root. Never a public URL. */
  receiptPath: z.string().max(300).nullish(),
  /** The admin who approved a manual payment. Null on every gateway payment. */
  verifiedBy: z.number().int().positive().nullish(),
  /** Driver who took cash on tour day (§8). */
  collectedByDriverId: z.number().int().positive().nullish(),
  actor: actorSchema,
});

export type RecordPaymentInput = z.input<typeof recordPaymentInputSchema>;

export interface RecordPaymentResult {
  paymentId: number;
  /**
   * The booking's status AFTER this call — `confirmed` once money has
   * landed, or **unchanged** when the booking was already dead and the
   * payment was flagged for review instead (see `LateMoneyReason`).
   */
  bookingStatus: BookingStatus;
  /**
   * True when the money was recorded but the booking status was deliberately
   * left alone, and `bookings.payment_review_required` was set for an admin
   * to resolve. The payment row exists either way.
   */
  paymentReviewRequired: boolean;
}

/**
 * Why a payment landed on a booking that could no longer accept it (owner
 * decision 2026-10-11, task 16b-3). Goes verbatim into the audit row's
 * `data.reviewReason`, so an admin reading the trail is told which of the
 * three it was rather than just "something was wrong".
 */
type LateMoneyReason = 'booking_cancelled' | 'booking_expired' | 'hold_expired';

/**
 * Decides whether this booking is still able to accept money into its
 * status, reading ONLY the locked booking row.
 *
 * Returns the reason it cannot, or `null` when it can. Three ways a booking
 * is dead:
 *
 *   - `cancelled` — a guest or an admin cancelled it.
 *   - `expired` — the hold-expiry cron has already flipped it.
 *   - the hold lapsed but the cron has not run yet. `hold_expires_at` is
 *     null on every booking that has nothing left to expire (schema), so a
 *     non-null one in the past is a lapsed hold regardless of status, and
 *     the race between the webhook and the cron must not decide the outcome.
 */
function lateMoneyReason(
  booking: { status: BookingStatus; holdExpiresAt: Date | null },
  now: Date,
): LateMoneyReason | null {
  if (booking.status === 'cancelled') return 'booking_cancelled';
  if (booking.status === 'expired') return 'booking_expired';
  if (booking.holdExpiresAt !== null && booking.holdExpiresAt.getTime() <= now.getTime()) {
    return 'hold_expired';
  }
  return null;
}

/**
 * What the booking expects for its NEXT inbound payment, in centavos
 * (BUILD_SPEC §6: "Check the amount matches the booking's expected
 * amount").
 *
 * Read off the booking row and its frozen `price_snapshot` — never off
 * anything the caller passed in, and never off the live tour, whose price an
 * admin may have edited since (§5, Q5).
 *
 * The deposit comes from `depositCentavos()` in `/shared` (plan Task 19),
 * which owns owner decision Q4 — **UP to the next whole peso, clamped to the
 * total** — and carries the enumerated rounding tests for it. This function
 * computed the same arithmetic inline until Task 19 landed; it calls the
 * helper now, because two copies of a rounding rule is how the two copies
 * come to disagree, and the copy a guest's money is checked against is the
 * worst one to let drift.
 */
function expectedAmountCentavos(booking: {
  payMode: 'full' | 'deposit';
  totalCentavos: number;
  priceSnapshot: { depositPercent: number };
}): number {
  if (booking.payMode === 'full') return booking.totalCentavos;
  return depositCentavos(booking.totalCentavos, booking.priceSnapshot.depositPercent);
}

/**
 * The one transactional path that marks a booking paid, or records a refund
 * against it.
 *
 * Resolves with the new payment's id, the booking's status after the change,
 * and whether the payment needs an admin's review.
 *
 * **A payment for a booking that is already dead — cancelled, expired, or
 * holding a hold that has lapsed — is still RECORDED, but changes no
 * status** (owner decision 2026-10-11, task 16b-3). The money is real;
 * the capacity is gone. `bookings.payment_review_required` goes up and the
 * audit row says why, and an admin decides between re-confirming and
 * refunding. Nothing auto-confirms.
 *
 * Rejects — writing NOTHING — when the booking is missing, when the
 * amount is not what the booking expects, when it would overpay, when a
 * refund would exceed what was paid, or when something other than an admin
 * tries to start a refund.
 */
export async function recordPayment(input: RecordPaymentInput): Promise<RecordPaymentResult> {
  const parsed = recordPaymentInputSchema.parse(input);

  /*
   * BUILD_SPEC §6: "Refunds are admin-only and write to audit_log naming the
   * admin. A gateway webhook may _confirm_ a refund the admin initiated; it
   * may never initiate one." Checked before the transaction opens, because
   * this one needs nothing from the database — a `provider` actor (a
   * webhook) and a `system` actor (a cron job) are refused outright, and
   * only `user` with a real admin id gets through.
   */
  if (parsed.type === 'refund' && (parsed.actor.type !== 'user' || parsed.actor.id === null)) {
    throw new RefundNotAdminInitiatedError(parsed.actor.type);
  }

  return getDb().transaction(async (tx: Transaction) => {
    /*
     * THE row lock, and it is taken before anything else is read or written.
     *
     * Two webhook deliveries for the same booking arriving together would
     * otherwise both read `amount_paid = 0` and both add to it; two admins
     * refunding at once would both read "nothing refunded yet". Every
     * decision below is made against the state this lock pins, and released
     * only when the transaction commits — so the second caller reads the
     * first caller's result and is refused, instead of racing it.
     */
    const [booking] = await tx
      .select()
      .from(bookings)
      .where(eq(bookings.id, parsed.bookingId))
      .for('update')
      .limit(1);
    if (!booking) throw new BookingNotFoundError(parsed.bookingId);

    let nextStatus: BookingStatus = booking.status;
    let nextAmountPaidCentavos = booking.amountPaidCentavos;
    /** Set by the payment branch below when the booking was already dead. */
    let reviewReason: LateMoneyReason | null = null;

    if (parsed.type === 'payment') {
      const expected = expectedAmountCentavos(booking);
      if (parsed.amountCentavos !== expected) {
        throw new PaymentAmountMismatchError(expected, parsed.amountCentavos);
      }
      /*
       * And it must still fit. The amount check above cannot catch a
       * duplicate delivery — a second webhook for the same booking carries
       * exactly the expected amount too — so without this the guest would
       * simply be credited twice. Under the lock, the second caller sees the
       * first caller's `amount_paid` and is refused here. (Task 15 adds the
       * `payment_events` unique index on top; this is the layer underneath
       * it, and it does not depend on the gateway sending an event id.)
       */
      nextAmountPaidCentavos = booking.amountPaidCentavos + parsed.amountCentavos;
      if (nextAmountPaidCentavos > booking.totalCentavos) {
        throw new PaymentOverpaysBookingError(
          booking.totalCentavos,
          booking.amountPaidCentavos,
          parsed.amountCentavos,
        );
      }
      /*
       * **A late payment must not resurrect a dead booking** (owner
       * decision 2026-10-11, task 16b-3 — the question task 14 flagged and
       * declined to invent an answer to).
       *
       * A guest starts a GCash payment, the 15-minute hold lapses or an
       * admin cancels, and the webhook lands a minute later. The money is
       * REAL, so it is still recorded: the `payments` row is inserted and
       * `amount_paid_centavos` still moves — which is also what makes a
       * refund possible, since the refund cap is measured against it.
       *
       * But the booking status is left EXACTLY as it was. The capacity that
       * booking was holding has been released, and confirming it again could
       * overbook the day. Instead `payment_review_required` is set and the
       * audit row below carries the reason and the prior status, so an admin
       * can re-confirm (if capacity allows) or refund.
       *
       * **It does NOT auto-confirm**, under any of the three reasons. That
       * is an explicit owner DO-NOT.
       *
       * Decided here, INSIDE the transaction, under the booking row lock
       * taken above — the same read that `expectedAmountCentavos` used. A
       * status read outside the lock could be stale by the time the UPDATE
       * lands, which is precisely the race between this webhook and the
       * hold-expiry cron.
       */
      reviewReason = lateMoneyReason(booking, new Date());
      /*
       * §6 step 3 for a live booking: "insert payments row (paid), update
       * booking to confirmed, write audit log". A deposit confirms the
       * booking too — §5's lifecycle has the balance collected on tour day,
       * not a second status.
       */
      if (reviewReason === null) nextStatus = 'confirmed';
    }

    if (parsed.type === 'refund') {
      /*
       * Refunds are capped at what was actually paid (owner decision
       * 2026-10-11, Q11). Partial refunds are allowed, so a booking can
       * carry several refund rows — and their SUM must never exceed
       * `amount_paid_centavos`.
       *
       * The sum is read INSIDE this transaction, through `tx`, under the
       * booking row lock taken above. Reading it outside, or without the
       * lock, is the classic double-refund race: two admins each see "₱1,000
       * paid, ₱0 refunded", each refund ₱1,000, and ₱2,000 leaves the
       * account.
       *
       * `amount_paid_centavos` is NOT decremented by a refund — it is the sum
       * of money IN, and the refunds are a separate sum measured against it.
       * Decrementing it would re-open the cap after every refund and let the
       * whole amount leave twice, one partial refund at a time.
       */
      const [refundsSoFar] = await tx
        .select({ refunded: sql<number>`COALESCE(SUM(${payments.amountCentavos}), 0)` })
        .from(payments)
        .where(and(eq(payments.bookingId, parsed.bookingId), eq(payments.type, 'refund')));
      const alreadyRefunded = Number(refundsSoFar?.refunded ?? 0);
      if (alreadyRefunded + parsed.amountCentavos > booking.amountPaidCentavos) {
        throw new RefundExceedsPaidError(
          booking.amountPaidCentavos,
          alreadyRefunded,
          parsed.amountCentavos,
        );
      }
      // §6: "Refunds are never a booking status." The status and
      // `amount_paid_centavos` are both left exactly as they were; the
      // cancellation that usually accompanies a refund is its own audited
      // change, made by its own caller.
    }

    const [inserted] = await tx.insert(payments).values({
      bookingId: parsed.bookingId,
      type: parsed.type,
      provider: parsed.provider,
      method: parsed.method,
      // Always positive, refunds included. Direction comes from `type`.
      amountCentavos: parsed.amountCentavos,
      // OUR vocabulary, not the gateway's — the gateway's own wording is
      // kept verbatim in `provider_status` beside it.
      status: parsed.type === 'refund' ? 'refunded' : 'paid',
      providerRef: parsed.providerRef ?? null,
      providerStatus: parsed.providerStatus ?? null,
      txnRef: parsed.txnRef ?? null,
      receiptPath: parsed.receiptPath ?? null,
      verifiedBy: parsed.verifiedBy ?? null,
      // Set together with `verified_by` or not at all: a verifier with no
      // timestamp is an approval nobody can date.
      verifiedAt: parsed.verifiedBy == null ? null : new Date(),
      collectedByDriverId: parsed.collectedByDriverId ?? null,
    });
    const paymentId = Number(inserted.insertId);

    if (parsed.type === 'payment') {
      await tx
        .update(bookings)
        .set(
          reviewReason === null
            ? {
                amountPaidCentavos: nextAmountPaidCentavos,
                status: nextStatus,
                // The 15-minute hold has nothing left to expire once the
                // money has landed (schema: "Null once the booking is paid").
                holdExpiresAt: null,
              }
            : {
                /*
                 * The dead-booking path. `amount_paid_centavos` moves — the
                 * money is real and a refund is measured against it — and
                 * the flag goes up.
                 *
                 * `status` is NOT in this object at all, rather than set to
                 * its current value: the status column is the thing this
                 * decision is about, and not naming it is the strongest
                 * statement that nothing here touches it.
                 *
                 * `hold_expires_at` is left alone too. On a `cancelled` or
                 * `expired` booking it is already null; on one whose hold
                 * merely lapsed, nulling it would quietly take the booking
                 * off the expiry cron's list and change the lifecycle by
                 * the back door. The flag, not this column, is what gets
                 * the booking an admin's attention.
                 */
                amountPaidCentavos: nextAmountPaidCentavos,
                paymentReviewRequired: true,
              },
        )
        .where(eq(bookings.id, parsed.bookingId));
    }

    await writeAudit(tx, {
      // A webhook-driven change is `provider` with the gateway named in
      // `data.provider` (Q10) — never `system`, which means a cron job.
      actorType: parsed.actor.type,
      actorId: parsed.actor.id,
      action: parsed.type === 'refund' ? 'payment.refunded' : 'payment.recorded',
      entity: 'payments',
      entityId: paymentId,
      // Identifiers and amounts only. Never a secret, never a gateway
      // payload, never card or e-wallet data (see `writeAudit`).
      data: {
        bookingRef: booking.ref,
        amountCentavos: parsed.amountCentavos,
        provider: parsed.provider,
        method: parsed.method,
        bookingStatus: nextStatus,
        /*
         * The task 16b-3 explanation, always present so the shape of a
         * payment audit row does not depend on the outcome.
         *
         * `priorBookingStatus` is what the booking was BEFORE this call;
         * `bookingStatus` above is what it is after. On the review path they
         * are equal, and that equality IS the record that nothing was
         * resurrected. `reviewReason` is null on a live booking.
         *
         * The action stays `payment.recorded` rather than becoming a new
         * verb: the payment genuinely was recorded, and a second action
         * string would silently fall out of every existing and future
         * "payments recorded" query. The review queue is driven by
         * `bookings.payment_review_required`, not by this row.
         */
        paymentReviewRequired: reviewReason !== null,
        reviewReason,
        priorBookingStatus: booking.status,
      },
    });

    return { paymentId, bookingStatus: nextStatus, paymentReviewRequired: reviewReason !== null };
  });
}
