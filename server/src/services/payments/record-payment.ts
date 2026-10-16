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
 *
 * **Driver-collected cash is deliberately NOT this function** (A5b). §8:
 * the driver "can mark 'cash collected' with the amount → creates a
 * `payments` row (`cash`, collected_by driver) **for admin to reconcile**".
 * Nobody from head office has seen that money yet, so `recordPendingCash()`
 * below writes a `pending` row and credits nothing, and
 * `verifyCashPayment()` turns THAT SAME ROW into `paid` when finance counts
 * the cash. A `status` parameter on `recordPayment()` was the obvious
 * alternative and was rejected on purpose: it would turn "money is
 * received" into "money might be received", and the one function the whole
 * payment rule rests on would stop meaning anything exact.
 */
import { and, eq, isNotNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import { type AdminRole, type BookingStatus, adminRoleSchema, depositCentavos } from '@rg/shared';
import { getDb, type Transaction } from '../../db/client';
import {
  AUDIT_ACTOR_TYPES,
  PAYMENT_METHODS,
  PAYMENT_PROVIDERS,
  PAYMENT_TYPES,
  bookings,
  payments,
} from '../../db/schema';
import { ROLE_MATRIX } from '../../middleware/require-role';
import { writeAudit } from '../audit';
import {
  BookingNotFoundError,
  CashPaymentNotFoundError,
  CashPaymentNotPendingError,
  CashRejectionNeedsReasonError,
  ReceiptAlreadyDecidedError,
  ReceiptPaymentNotFoundError,
  PaymentAmountMismatchError,
  PaymentOverpaysBookingError,
  PaymentVerificationNotPermittedError,
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

/* =========================================================================
 * A5b — driver-collected cash: pending on collection, finance converts the
 * SAME row.
 *
 * BUILD_SPEC §8, item 5. The driver takes the balance in cash at the end of
 * the tour and taps "cash collected". At that instant nothing has been
 * reconciled: the money is in a driver's pocket somewhere on the road back
 * from Oslob, and the only honest record is "a driver says they collected
 * ₱X". So the row goes in as `pending` and the booking is left completely
 * alone — the same shape §6 gives a manual QR transfer, where the payment
 * row is `pending` until an admin approves it.
 *
 * Finance counting the cash is the event that makes it money received, and
 * that is `verifyCashPayment()`. It is an UPDATE of the pending row, never
 * a second INSERT. Inserting would be the easy mistake — `recordPayment()`
 * is right there and does everything else correctly — and it would leave
 * the pending row orphaned forever while the money was credited against a
 * new one. The booking total would look right by accident, and the audit
 * trail would show two payments for one handful of cash.
 * ====================================================================== */

/**
 * No `actor` field: the driver who collected the cash IS the actor, so the
 * audit row is derived from `collectedByDriverId` rather than passed in
 * beside it. Two fields that must agree are two fields that can disagree,
 * and "which driver handed this in" is not a question an audit trail should
 * be able to answer two ways.
 *
 * No `provider`, `method` or `status` either. All three are fixed by what
 * this function IS — a manual cash collection, pending — and a parameter
 * for any of them would let a caller write a `paid` row through the door
 * built for unverified ones.
 */
const recordPendingCashInputSchema = z.object({
  bookingId: z.number().int().positive(),
  /** Centavos, always positive. What the driver says they took. */
  amountCentavos: z.number().int().positive(),
  /** `drivers.id` — never null here, unlike the nullable column. */
  collectedByDriverId: z.number().int().positive(),
});

export type RecordPendingCashInput = z.input<typeof recordPendingCashInputSchema>;

export interface RecordPendingCashResult {
  /** The `pending` row. `verifyCashPayment()` is given this id, and no other. */
  paymentId: number;
}

/**
 * Records driver-collected cash as a PENDING payment, for finance to
 * reconcile (BUILD_SPEC §8 item 5).
 *
 * Writes exactly one `payments` row — `provider='manual'`, `method='cash'`,
 * `status='pending'`, `collected_by_driver_id` set — plus its audit row,
 * and **touches nothing on `bookings`**. Not `amount_paid_centavos`, not
 * `status`, not `payment_review_required`. A driver's word is not a
 * reconciliation, and a booking that reads "paid in full" because someone
 * tapped a button in a van is the whole failure this split exists to
 * prevent.
 *
 * No `FOR UPDATE` on the booking, deliberately: nothing here is written to
 * the booking and no decision is made against its state, so there is no
 * read-modify-write to serialise. Two drivers cannot collect for the same
 * booking anyway — a trip has one driver — and two taps of the same button
 * are two genuinely separate claims of cash, which finance must see as two
 * rows and resolve, not something this function should silently merge.
 *
 * Rejects, writing nothing, when the booking does not exist.
 */
export async function recordPendingCash(
  input: RecordPendingCashInput,
): Promise<RecordPendingCashResult> {
  const parsed = recordPendingCashInputSchema.parse(input);

  return getDb().transaction(async (tx: Transaction) => {
    // Read, not locked, and only for the ref the audit row carries and to
    // fail closed on a bad id with our own error rather than a raw foreign
    // key violation from the INSERT below.
    const [booking] = await tx
      .select({ ref: bookings.ref, status: bookings.status })
      .from(bookings)
      .where(eq(bookings.id, parsed.bookingId))
      .limit(1);
    if (!booking) throw new BookingNotFoundError(parsed.bookingId);

    const [inserted] = await tx.insert(payments).values({
      bookingId: parsed.bookingId,
      type: 'payment',
      provider: 'manual',
      method: 'cash',
      amountCentavos: parsed.amountCentavos,
      // THE point of this function. Not `paid`.
      status: 'pending',
      // Nobody has verified anything yet, so both halves stay null — they
      // are what `verifyCashPayment()` fills in.
      verifiedBy: null,
      verifiedAt: null,
      collectedByDriverId: parsed.collectedByDriverId,
    });
    const paymentId = Number(inserted.insertId);

    await writeAudit(tx, {
      // §10: `driver` -> drivers.id. Not `user` (that is staff) and not
      // `system` (that is a cron job).
      actorType: 'driver',
      actorId: parsed.collectedByDriverId,
      /*
       * Its own verb, unlike the dead-booking branch of `recordPayment()`
       * which stays `payment.recorded`. There the money genuinely HAD been
       * recorded; here it has not — nothing has moved onto the booking —
       * so calling it `payment.recorded` would put a claim of cash and an
       * actual receipt of cash under the same word in the money trail.
       */
      action: 'payment.cash_collected',
      entity: 'payments',
      entityId: paymentId,
      data: {
        bookingRef: booking.ref,
        amountCentavos: parsed.amountCentavos,
        provider: 'manual',
        method: 'cash',
        collectedByDriverId: parsed.collectedByDriverId,
        /*
         * Spelled out so a reader of the trail is never left inferring it.
         * The booking is untouched at this point and its status is whatever
         * the tour left it as.
         */
        paymentStatus: 'pending',
        bookingStatus: booking.status,
      },
    });

    return { paymentId };
  });
}

/**
 * The verifier. `type` and `id` mirror `actorSchema`; `role` is extra and is
 * the whole point.
 *
 * `role` is `unknown` rather than an enum so that a missing role, a number,
 * `'admin'` and `'__proto__'` are refused by the guard below — with
 * `PaymentVerificationNotPermittedError`, fail-closed — instead of by a Zod
 * parse error at the door. The gate decides who may verify; it does not
 * delegate that to a schema that a future refactor could loosen.
 */
const cashVerifierSchema = z.object({
  type: z.enum(AUDIT_ACTOR_TYPES),
  id: z.number().int().positive().nullable(),
  /** `users.role`. Re-parsed against `ADMIN_ROLES`, never trusted as typed. */
  role: z.unknown(),
});

const verifyCashPaymentInputSchema = z.object({
  /** The `pending` row `recordPendingCash()` created. */
  paymentId: z.number().int().positive(),
  verifier: cashVerifierSchema,
});

export type VerifyCashPaymentInput = z.input<typeof verifyCashPaymentInputSchema>;

export interface VerifyCashPaymentResult {
  paymentId: number;
  bookingId: number;
  /** The booking's status AFTER verification. */
  bookingStatus: BookingStatus;
  /** Set when the cash landed on a booking that was already dead. */
  paymentReviewRequired: boolean;
}

/**
 * BUILD_SPEC §9's "Verify payments, record payments" row, widened to
 * `readonly AdminRole[]` so `.includes()` takes any admin role rather than
 * only the two literals in the matrix entry.
 */
const MAY_VERIFY: readonly AdminRole[] = ROLE_MATRIX.verifyPayments;

/**
 * The actor guard, in the shape `RefundNotAdminInitiatedError` established:
 * checked before the transaction opens, because it needs nothing from the
 * database, and refusing everything that is not explicitly allowed.
 *
 * Four ways to be refused, and the first is the one §8 is about: a
 * `driver` actor. A driver may CLAIM cash (`recordPendingCash()`); only
 * finance may turn the claim into money received.
 *
 * Returns the verified `users.id`, so the caller attributes the audit row
 * and `verified_by` to a value this gate has already narrowed rather than
 * asserting the null away afterwards.
 *
 * **Exported** because the manual-receipt REJECTION path needs the same
 * gate and must not grow its own: §9 gives "verify payments" to owner and
 * finance, and rejecting a receipt is that permission being exercised just
 * as much as approving one. Two copies of a role check are two answers to
 * one question.
 */
export function assertMayVerifyPayments(verifier: {
  type: string;
  id: number | null;
  role: unknown;
}): number {
  if (verifier.type !== 'user' || verifier.id === null) {
    throw new PaymentVerificationNotPermittedError(verifier.type);
  }
  const role = adminRoleSchema.safeParse(verifier.role);
  if (!role.success || !MAY_VERIFY.includes(role.data)) {
    throw new PaymentVerificationNotPermittedError(verifier.type);
  }
  return verifier.id;
}

/**
 * Where verifying a pending manual payment may move the booking's status.
 *
 * `recordPayment()` confirms any live booking it touches, because the money
 * it records is the deposit or the full amount and arrives BEFORE the trip.
 * Cash is the balance and arrives at the END of one, so the booking is
 * usually `assigned`, `in_progress` or `completed` by then — and writing
 * `confirmed` over `completed` would walk a finished trip backwards through
 * its own lifecycle, freeing capacity and un-finishing a tour that ran.
 *
 * So the status moves only from the two statuses that mean "not paid for
 * yet", and is otherwise left exactly as it was. Nothing new is invented:
 * `confirmed` is §5's own status and the two sources are §5's own.
 *
 * The same rule serves an approved guest RECEIPT (Week 4 Task 6), which
 * arrives before the trip and whose booking is therefore always one of
 * those two — so the clamp costs it nothing and protects it from the same
 * mistake if that ever stops being true.
 */
function statusAfterManualVerified(current: BookingStatus): BookingStatus {
  return current === 'pending_payment' || current === 'pending_verification'
    ? 'confirmed'
    : current;
}

/** Which pending manual row an id may name. */
type PendingKind = 'cash' | 'receipt';

/**
 * WHICH ROW an id is allowed to name — the one definition of "this is a
 * driver's cash row" / "this is a guest's receipt row" in the system.
 *
 * Extracted from `verifyPendingManualPayment()` unchanged (D2), so that the
 * REFUSAL path below narrows to exactly the rows the APPROVAL path would
 * have accepted. Two answers to "is this a cash row" is how a rejection
 * lands on a receipt — or, worse, how one of the pair quietly widens to a
 * gateway charge while the other does not.
 *
 * Deliberately NOT narrowed to `collected_by_driver_id IS NOT NULL`, even
 * though every cash row written today has one: adding that term here would
 * narrow the approval too, and a manual cash row with no driver named would
 * silently stop being approvable. The `status = 'pending'` check is not here
 * either — it belongs under the lock, where it is re-read.
 */
const manualPendingRow = (paymentId: number, kind: PendingKind) =>
  and(
    eq(payments.id, paymentId),
    eq(payments.type, 'payment'),
    eq(payments.provider, 'manual'),
    kind === 'cash' ? eq(payments.method, 'cash') : isNotNull(payments.receiptPath),
  );

/**
 * Finance confirms that driver-collected cash was actually handed over.
 *
 * Converts the pending row from `recordPendingCash()` **in place** —
 * `status` `pending` -> `paid`, `verified_by` and `verified_at` set — and
 * credits `amount_paid_centavos` exactly once, in one transaction under the
 * booking row lock. **It inserts nothing.** One handful of cash is one
 * `payments` row for its whole life.
 *
 * Rejects, writing nothing, when the verifier is not an owner or a finance
 * user, when the id is not a driver-cash row, when that row is no longer
 * `pending` (the double-verify refusal), when the booking has vanished, or
 * when the credit would overpay the booking.
 *
 * A cash collection against a booking that is cancelled, expired or holding
 * a lapsed hold gets `recordPayment()`'s treatment unchanged: the money is
 * credited, `payment_review_required` goes up, and the status is left alone.
 * Nothing auto-confirms a dead booking.
 */
async function verifyPendingManualPayment(
  paymentId: number,
  kind: PendingKind,
  verifiedBy: number,
): Promise<VerifyCashPaymentResult> {
  const parsed = { paymentId };

  return getDb().transaction(async (tx: Transaction) => {
    /*
     * First read: unlocked, and used ONLY to find which booking to lock.
     * Its `status` is deliberately not trusted for the pending check — by
     * the time the lock below is granted, a concurrent verifier may have
     * committed a change to this very row.
     *
     * Scoped to ONE manual shape — the driver's cash row or the guest's
     * receipt row, never both, and never a gateway charge, whose id is
     * "not found" here rather than something this path could mark paid.
     */
    const pendingRow = manualPendingRow(parsed.paymentId, kind);
    const [unlocked] = await tx
      .select({ bookingId: payments.bookingId })
      .from(payments)
      .where(pendingRow)
      .limit(1);
    if (!unlocked) throw notFound(kind, parsed.paymentId);

    /*
     * THE lock — the same booking row lock that protects the refund cap
     * above, taken for the same reason. Two finance users clicking "verify"
     * on one row at once both read `pending`; this is what serialises them.
     */
    const [booking] = await tx
      .select()
      .from(bookings)
      .where(eq(bookings.id, unlocked.bookingId))
      .for('update')
      .limit(1);
    if (!booking) throw new BookingNotFoundError(unlocked.bookingId);

    /*
     * Second read, and the authoritative one: taken AFTER the booking lock,
     * and taken `FOR UPDATE`. The second of two concurrent verifiers reads
     * `paid` here and is refused, which is the only reason one handful of
     * cash cannot be credited twice.
     *
     * **`FOR UPDATE` is load-bearing, and a plain re-read is not enough.**
     * This was measured, not assumed: with a non-locking re-read the
     * concurrency test below double-credits. InnoDB's default isolation is
     * REPEATABLE READ, and the consistent snapshot a transaction reads from
     * is fixed at its FIRST read — the unlocked lookup above. So the second
     * verifier waits on the booking lock, is granted it after the first
     * one commits, and then a plain `SELECT` still hands it the row as it
     * was BEFORE the first verifier touched it: `pending`. Both pass the
     * check and both credit the cash.
     *
     * A locking read is the exception to that snapshot — it reads the
     * latest committed version — so this one, and only this one, sees the
     * truth. The booking lock sequences the two callers; `FOR UPDATE` here
     * is what lets the second one find out what the first one did.
     *
     * The booking is still locked FIRST, before this row, so every path in
     * this file takes its locks in the same order and none of them can
     * deadlock against another.
     */
    const [payment] = await tx
      .select({
        status: payments.status,
        amountCentavos: payments.amountCentavos,
        // Read rather than assumed: `'cash'` for the driver path, and the
        // real instrument (gcash, maya, bank_transfer) for a receipt.
        method: payments.method,
        receiptPath: payments.receiptPath,
      })
      .from(payments)
      .where(pendingRow)
      .for('update')
      .limit(1);
    if (!payment) throw notFound(kind, parsed.paymentId);
    if (payment.status !== 'pending') {
      throw notPending(kind, parsed.paymentId, payment.status);
    }

    /*
     * The amount comes off the ROW, never off the caller. Finance is
     * verifying what the driver recorded; a caller-supplied amount here
     * would be a browser-adjustable credit to `amount_paid_centavos`.
     *
     * No `expectedAmountCentavos()` check either, unlike the gateway path.
     * For cash, because it is the BALANCE at the end of the tour rather
     * than the deposit the booking expected up front, so an exact match
     * against either would refuse every legitimate collection. For a
     * receipt, because the amount on the row was computed from the booking
     * when the guest uploaded it (`recordManualReceipt`) and is already
     * what the booking expected — re-deriving it here would re-decide it
     * against a booking that may have been part-paid since. The overpay cap
     * below is what bounds both, and that is the cap that matters, because
     * it is measured against money already credited.
     */
    const nextAmountPaidCentavos = booking.amountPaidCentavos + payment.amountCentavos;
    if (nextAmountPaidCentavos > booking.totalCentavos) {
      throw new PaymentOverpaysBookingError(
        booking.totalCentavos,
        booking.amountPaidCentavos,
        payment.amountCentavos,
      );
    }

    const reviewReason = lateMoneyReason(booking, new Date());
    const nextStatus =
      reviewReason === null ? statusAfterManualVerified(booking.status) : booking.status;

    /*
     * The conversion. An UPDATE of the row the driver created — NOT an
     * insert. `verified_by` and `verified_at` are set together: a verifier
     * with no timestamp is an approval nobody can date.
     */
    await tx
      .update(payments)
      .set({ status: 'paid', verifiedBy, verifiedAt: new Date() })
      .where(eq(payments.id, parsed.paymentId));

    await tx
      .update(bookings)
      .set(
        reviewReason === null
          ? {
              amountPaidCentavos: nextAmountPaidCentavos,
              status: nextStatus,
              holdExpiresAt: null,
            }
          : // The dead-booking path, identical to `recordPayment()`'s:
            // the money is real so it is credited, the flag goes up, and
            // `status` is not named in this object at all.
            { amountPaidCentavos: nextAmountPaidCentavos, paymentReviewRequired: true },
      )
      .where(eq(bookings.id, unlocked.bookingId));

    await writeAudit(tx, {
      // The finance user or owner, by `users.id`. §6's precedent: an admin
      // approval is `user` with that admin's id.
      actorType: 'user',
      actorId: verifiedBy,
      action: 'payment.verified',
      entity: 'payments',
      entityId: parsed.paymentId,
      data: {
        bookingRef: booking.ref,
        amountCentavos: payment.amountCentavos,
        provider: 'manual',
        method: payment.method,
        receiptPath: payment.receiptPath,
        bookingStatus: nextStatus,
        priorBookingStatus: booking.status,
        paymentReviewRequired: reviewReason !== null,
        reviewReason,
        /*
         * The two halves of the conversion, named, so the trail says this
         * row CHANGED rather than leaving a reader to wonder whether a
         * second payment appeared.
         */
        priorPaymentStatus: 'pending',
        paymentStatus: 'paid',
      },
    });

    return {
      paymentId: parsed.paymentId,
      bookingId: unlocked.bookingId,
      bookingStatus: nextStatus,
      paymentReviewRequired: reviewReason !== null,
    };
  });
}

/* ======================================================================
 * The two doors onto `verifyPendingManualPayment` above.
 *
 * It is one function because the dangerous part — lock the booking, re-read
 * the payment row `FOR UPDATE`, credit `amount_paid_centavos` exactly once,
 * clamp the status, audit — is identical for a driver's cash and a guest's
 * receipt, and because `amount_paid_centavos` may only be written from this
 * module (the guard in `schema-conventions.test.ts`). Two copies of that
 * body would be two places for the double-credit bug to come back.
 *
 * What differs is only which row the id may name and what the refusal is
 * called, which is what `kind` selects.
 * ====================================================================== */

const notFound = (kind: PendingKind, paymentId: number): Error =>
  kind === 'cash'
    ? new CashPaymentNotFoundError(paymentId)
    : new ReceiptPaymentNotFoundError(paymentId);

const notPending = (kind: PendingKind, paymentId: number, status: unknown): Error =>
  kind === 'cash'
    ? new CashPaymentNotPendingError(paymentId, status)
    : new ReceiptAlreadyDecidedError(paymentId, status);

/**
 * Finance confirms that driver-collected cash was actually handed over
 * (BUILD_SPEC §8 item 5, A5b).
 *
 * Converts the pending row from `recordPendingCash()` **in place** —
 * `status` `pending` -> `paid`, `verified_by` and `verified_at` set — and
 * credits `amount_paid_centavos` exactly once, in one transaction under the
 * booking row lock. **It inserts nothing.** One handful of cash is one
 * `payments` row for its whole life.
 *
 * Rejects, writing nothing, when the verifier is not an owner or a finance
 * user, when the id is not a driver-cash row, when that row is no longer
 * `pending` (the double-verify refusal), when the booking has vanished, or
 * when the credit would overpay the booking.
 *
 * A cash collection against a booking that is cancelled, expired or holding
 * a lapsed hold gets `recordPayment()`'s treatment unchanged: the money is
 * credited, `payment_review_required` goes up, and the status is left alone.
 * Nothing auto-confirms a dead booking.
 */
export async function verifyCashPayment(
  input: VerifyCashPaymentInput,
): Promise<VerifyCashPaymentResult> {
  const parsed = verifyCashPaymentInputSchema.parse(input);
  // Before the transaction opens — it needs nothing from the database.
  const verifiedBy = assertMayVerifyPayments(parsed.verifier);
  return verifyPendingManualPayment(parsed.paymentId, 'cash', verifiedBy);
}

/**
 * An admin approves a guest's uploaded receipt (§6 step 5, Week 4 Task 7).
 *
 * **This is the half of the manual flow that marks money received**, and it
 * is here rather than in `manual-receipt.ts` for one reason: this module
 * owns `bookings.amount_paid_centavos` and nothing else may write it. The
 * rejection half, which moves no money, lives beside the upload instead.
 *
 * Converts the `pending` receipt row in place — never a second insert — so
 * one transfer is one `payments` row from upload to approval, carrying the
 * guest's reference and the file an admin looked at.
 *
 * Rejects, writing nothing, when the verifier is not an owner or finance,
 * when the id is not a receipt row, or when that row is no longer
 * `pending` — which includes a `superseded` one, so only the newest receipt
 * can ever be approved (owner decision 2026-10-14, Q6).
 */
export async function approveManualReceipt(
  input: VerifyCashPaymentInput,
): Promise<VerifyCashPaymentResult> {
  const parsed = verifyCashPaymentInputSchema.parse(input);
  const verifiedBy = assertMayVerifyPayments(parsed.verifier);
  return verifyPendingManualPayment(parsed.paymentId, 'receipt', verifiedBy);
}

/* ======================================================================
 * D2 — refusing a cash claim: "the money never arrived"
 * (owner decision 2026-10-16).
 *
 * The third door onto a pending manual row, and the only one that moves no
 * money at all. It is here rather than beside `verifyCashPayment()` purely
 * so that the "two doors" section above reads as the pair it describes; it
 * shares that pair's row predicate (`manualPendingRow`) and its gate
 * (`assertMayVerifyPayments`), which is what matters.
 * ====================================================================== */

const rejectCashPaymentInputSchema = z.object({
  /** The `pending` row `recordPendingCash()` created. */
  paymentId: z.number().int().positive(),
  /** Bounded by its column (`varchar(400)`). Emptiness is the guard's, below. */
  reason: z.string().max(400),
  verifier: cashVerifierSchema,
});

export type RejectCashPaymentInput = z.input<typeof rejectCashPaymentInputSchema>;

export interface RejectCashPaymentResult {
  paymentId: number;
  bookingId: number;
  /** The booking's ref, for the admin's confirmation line. */
  ref: string;
}

/**
 * Finance or the owner refuses a cash claim: the money never arrived
 * (owner decision 2026-10-16, D2).
 *
 * Converts the driver's `pending` row to `rejected` with the reason, **in
 * place**, and touches NOTHING on the booking. Not `amount_paid_centavos`,
 * not `status`, not `payment_review_required` — there is nothing to undo,
 * because a claim never credited anything in the first place. That is the
 * whole asymmetry with a rejected RECEIPT, which sends the guest back to
 * `pending_payment` with a re-upload deadline: a receipt is money the guest
 * says they sent before the trip, and cash is the balance on a trip that
 * has already run.
 *
 * ## What this unblocks, and why that is a consequence rather than a goal
 *
 * `driver.trip`'s payment box reads `status = 'pending'` only, so refusing
 * the row returns that box to `collect_cash` and lets the driver record the
 * cash again — which is the right outcome when the first tap was a mistake
 * or the guest paid later. Before this existed, one mistaken tap blocked a
 * booking's cash collection permanently: `recordDriverCash` answered
 * `CONFLICT` on every later attempt and nothing could close the row. It is
 * NOT an invitation to re-record: every claim is its own row for its whole
 * life, and the rejected one stays exactly where it is as the record of
 * what was claimed and refused.
 *
 * ## `verified_by` stays NULL
 *
 * Deliberately, unlike nothing else here: `verified_by` means "this person
 * confirmed money arrived", and writing a refuser's id there would make a
 * refusal indistinguishable from an approval in every query that reads that
 * column. The refuser is in the audit row, which is where "who decided
 * what, and why" belongs.
 *
 * Rejects, writing nothing, when the verifier is not an owner or finance
 * user, when the reason is empty or whitespace, when the id is not a
 * driver-cash row, or when that row is no longer `pending`.
 */
export async function rejectCashPayment(
  input: RejectCashPaymentInput,
): Promise<RejectCashPaymentResult> {
  const parsed = rejectCashPaymentInputSchema.parse(input);
  // Both before the transaction opens — neither needs the database, and a
  // refusal that has already written something is not a refusal.
  const verifiedBy = assertMayVerifyPayments(parsed.verifier);
  const reason = parsed.reason.trim();
  if (reason.length === 0) throw new CashRejectionNeedsReasonError();

  return getDb().transaction(async (tx: Transaction) => {
    const cashRow = manualPendingRow(parsed.paymentId, 'cash');

    // Unlocked, and used ONLY to find which booking to lock. Its status is
    // deliberately not trusted — the locking re-read below is.
    const [unlocked] = await tx
      .select({ bookingId: payments.bookingId })
      .from(payments)
      .where(cashRow)
      .limit(1);
    if (!unlocked) throw new CashPaymentNotFoundError(parsed.paymentId);

    /*
     * The booking lock FIRST, then the payment row — the same order
     * `verifyPendingManualPayment` and `decideManualReceipt` take, so none
     * of the three can deadlock against another. Nothing is written to the
     * booking; the lock is taken so that an approval racing this rejection
     * is serialised rather than both landing.
     */
    const [booking] = await tx
      .select({ ref: bookings.ref, status: bookings.status })
      .from(bookings)
      .where(eq(bookings.id, unlocked.bookingId))
      .for('update')
      .limit(1);
    if (!booking) throw new BookingNotFoundError(unlocked.bookingId);

    /*
     * The authoritative read: after the booking lock, and `FOR UPDATE`.
     * Under REPEATABLE READ a plain re-read would hand back the snapshot
     * taken by the unlocked lookup above, so an approval that committed
     * while this caller waited for the lock would still read as `pending`
     * — and the row would be both paid and refused.
     */
    const [payment] = await tx
      .select({
        status: payments.status,
        amountCentavos: payments.amountCentavos,
        collectedByDriverId: payments.collectedByDriverId,
      })
      .from(payments)
      .where(cashRow)
      .for('update')
      .limit(1);
    if (!payment) throw new CashPaymentNotFoundError(parsed.paymentId);
    if (payment.status !== 'pending') {
      throw new CashPaymentNotPendingError(parsed.paymentId, payment.status);
    }

    await tx
      .update(payments)
      .set({ status: 'rejected', rejectReason: reason })
      .where(eq(payments.id, parsed.paymentId));

    await writeAudit(tx, {
      // The finance user or owner, by `users.id` — §6's precedent for an
      // admin decision. Never the driver, who is the subject of it.
      actorType: 'user',
      actorId: verifiedBy,
      action: 'payment.cash_rejected',
      entity: 'payments',
      entityId: parsed.paymentId,
      data: {
        bookingRef: booking.ref,
        amountCentavos: payment.amountCentavos,
        collectedByDriverId: payment.collectedByDriverId,
        reason,
        priorPaymentStatus: 'pending',
        paymentStatus: 'rejected',
        // Spelled out so nobody has to infer that the booking is untouched.
        bookingStatus: booking.status,
        amountPaidChanged: false,
      },
    });

    return { paymentId: parsed.paymentId, bookingId: unlocked.bookingId, ref: booking.ref };
  });
}
