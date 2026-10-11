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
import type { BookingStatus } from '@rg/shared';
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
  /** The booking's status AFTER this call — `confirmed` once money has landed. */
  bookingStatus: BookingStatus;
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
 * The deposit is computed inline here, the way owner decision Q4 fixes it:
 * **UP to the next whole peso, clamped to the total.** Plan Task 19 extracts
 * this into a shared `depositCentavos()` helper with its own rounding tests;
 * when it lands, this function calls it and the arithmetic below goes away.
 * It is NOT implemented here as that shared helper — one task owns that
 * decision, and two copies of a rounding rule is how the two copies come to
 * disagree.
 */
function expectedAmountCentavos(booking: {
  payMode: 'full' | 'deposit';
  totalCentavos: number;
  priceSnapshot: { depositPercent: number };
}): number {
  if (booking.payMode === 'full') return booking.totalCentavos;
  const raw = (booking.totalCentavos * booking.priceSnapshot.depositPercent) / 100;
  // Round UP to the next whole peso (Q4), then clamp: a 100% deposit on an
  // odd total must not round past what the guest actually owes.
  return Math.min(Math.ceil(raw / 100) * 100, booking.totalCentavos);
}

/**
 * The one transactional path that marks a booking paid, or records a refund
 * against it.
 *
 * Resolves with the new payment's id and the booking's status after the
 * change. Rejects — writing NOTHING — when the booking is missing, when the
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
       * §6 step 3: "insert payments row (paid), update booking to confirmed,
       * write audit log". A deposit confirms the booking too — §5's lifecycle
       * has the balance collected on tour day, not a second status.
       *
       * NOTE, deliberately not decided here: this does not refuse a payment
       * for a booking that is already `cancelled` or `expired`. The spec does
       * not say what should happen to money that arrives after a hold lapsed,
       * and inventing a rule in the function that defines "paid" is exactly
       * the change CLAUDE.md says to stop and ask about. Flagged in the Task
       * 14 report.
       */
      nextStatus = 'confirmed';
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
        .set({
          amountPaidCentavos: nextAmountPaidCentavos,
          status: nextStatus,
          // The 15-minute hold has nothing left to expire once the money has
          // landed (schema: "Null once the booking is paid").
          holdExpiresAt: null,
        })
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
      },
    });

    return { paymentId, bookingStatus: nextStatus };
  });
}
