/**
 * `admin.refunds.cancelBooking` / `.refundPayment` — §13's 6F (BUILD_SPEC §6
 * "Refunds & cancellations", §9's "Cancel / refund" row).
 *
 * Both are `adminProcedure('cancelRefund')`, which is **owner and finance
 * only**: a dispatcher may run the day, assign a van and watch a trip, and
 * may not cancel a booking or send money back. The gate is the builder's,
 * not this file's — there is no role check in here to forget to write, and
 * `procedure-role-metadata.test.ts` fails the build if either procedure ever
 * stops declaring §9's row for that area.
 *
 * **Two procedures, not one `cancelAndRefund`.** §6 is explicit that an
 * admin cancels "choosing a refund amount (full, partial, none)", and *none*
 * is a real and common choice — a guest who cancelled inside the policy
 * window with nothing paid yet. The other direction happens too: a trip that
 * ran badly gets money back and is NOT cancelled, because "a refund is never
 * a booking status". One procedure doing both would make those two cases
 * special-case each other, and would put one audit verb on two different
 * decisions.
 *
 * Nothing here decides anything. The resolvers read the admin's id off the
 * gate's validated session, hand off to `services/payments/cancel-refund.ts`
 * — which itself composes `recordPayment()` for every centavo — and turn a
 * refusal into a sentence. No money arithmetic, no `payments` insert, no
 * write of `bookings.amount_paid_centavos`; all three belong to
 * `record-payment.ts` and this task added no second copy of any of them.
 */
import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { PAYMENT_METHODS } from '../../db/schema';
import { cancelBooking, refundPayment } from '../../services/payments/cancel-refund';
import {
  BookingNotCancellableError,
  BookingNotFoundError,
  ProviderNotEnabledError,
  RefundExceedsPaidError,
  RefundNotAdminInitiatedError,
  RefundNotPossibleError,
  RefundNotRecordedError,
  RefundOutcomeUnknownError,
  RefundSourcePaymentNotFoundError,
  UnknownProviderError,
} from '../../services/payments/errors';
import { adminProcedure, router } from '../../trpc';

/**
 * A cancellation needs a reason, and it is not paperwork: this is the one
 * record of WHY seats were given back, and §9's audit trail is read by
 * people reconstructing a bad week months later. Bounded by the column the
 * audit row's JSON ends up in, and trimmed, so whitespace is not a reason.
 */
const cancelInput = z
  .object({
    bookingId: z.number().int().positive(),
    reason: z.string().trim().min(1, 'Say why this booking is being cancelled.').max(400),
  })
  .strict();

const refundInput = z
  .object({
    /** The PAID payment row the money came in through. */
    paymentId: z.number().int().positive(),
    /**
     * Centavos. The admin chooses it (§6: "full, partial, none"), the server
     * CAPS it — `recordPayment()`, inside the transaction, under the booking
     * row lock. This boundary only refuses a figure that is not a positive
     * whole number of centavos; it has no opinion about how big it is,
     * because an opinion here would be a second copy of the cap.
     */
    amountCentavos: z.number().int().positive(),
    reason: z.string().trim().min(1, 'Say why this money is going back.').max(400),
    /**
     * §6's offline half, for a `manual` payment: how the money went back and
     * what the admin can point at afterwards. Optional at this boundary
     * because Zod cannot see which provider the payment row names — the
     * service decides, and refuses either way round (a manual row without
     * it, a gateway row with it).
     */
    offline: z
      .object({
        method: z.enum(PAYMENT_METHODS),
        reference: z.string().trim().min(1).max(191),
      })
      .strict()
      .optional(),
  })
  .strict();

/** What an admin should see instead of a 500, per refusal. */
const REFUND_REFUSAL_MESSAGE = {
  manual_needs_offline_record:
    'This payment was taken by hand, so there is no gateway to refund through. ' +
    'Record how the money went back and its reference.',
  gateway_takes_no_offline_record:
    'This payment went through a gateway, so the refund goes back the same way. ' +
    'Leave the offline method and reference empty.',
  gateway_payment_has_no_reference:
    'This payment has no gateway reference on it, so it cannot be refunded automatically. ' +
    'Refund it at the gateway and record it against a manual payment instead.',
} as const;

function asTrpcError(error: unknown): TRPCError {
  if (error instanceof BookingNotFoundError) {
    return new TRPCError({
      code: 'NOT_FOUND',
      message: 'That booking no longer exists.',
      cause: error,
    });
  }
  /*
   * `CONFLICT`, not `BAD_REQUEST`: nothing was wrong with the request — the
   * booking has moved on, or is a finished trip — so the screen should
   * refresh rather than ask the admin to correct anything.
   */
  if (error instanceof BookingNotCancellableError) {
    return new TRPCError({
      code: 'CONFLICT',
      message:
        `This booking is "${error.status}", so it cannot be cancelled. ` +
        'Refresh the screen. A refund does not need a cancellation.',
      cause: error,
    });
  }
  if (error instanceof RefundSourcePaymentNotFoundError) {
    return new TRPCError({
      code: 'NOT_FOUND',
      message: 'That payment is not one this booking received, so there is nothing to refund.',
      cause: error,
    });
  }
  if (error instanceof RefundNotPossibleError) {
    return new TRPCError({
      code: 'BAD_REQUEST',
      message: REFUND_REFUSAL_MESSAGE[error.reason],
      cause: error,
    });
  }
  /*
   * The cap. `BAD_REQUEST`: the figures genuinely do not add up, and the
   * message quotes both halves so the admin can correct the amount without
   * going to look them up.
   */
  if (error instanceof RefundExceedsPaidError) {
    return new TRPCError({
      code: 'BAD_REQUEST',
      message:
        'That is more than this booking can give back: ' +
        `${(error.amountPaidCentavos / 100).toFixed(2)} pesos were paid and ` +
        `${(error.alreadyRefundedCentavos / 100).toFixed(2)} has already been refunded.`,
      cause: error,
    });
  }
  /*
   * The money left and the `payments` row did not. The admin is the only
   * person who can resolve it, so the message says what to do rather than
   * apologising — and the gateway's own reference is NOT in it, because a
   * refund id in a browser is not what makes this actionable. It is durable
   * in two places instead: the server log, and a `payment.refund_unrecorded`
   * row in `audit_log` written by the service in a fresh transaction (fix
   * round 1, finding 3 — this comment used to claim the audit row while none
   * was written). `cause` carries the error object, whose `providerRef`
   * property any future tRPC `onError` logger can read.
   */
  if (error instanceof RefundNotRecordedError) {
    return new TRPCError({
      code: 'INTERNAL_SERVER_ERROR',
      message:
        'The gateway accepted this refund but it could not be recorded. ' +
        'Do NOT refund again — check the gateway and tell whoever keeps the books.',
      cause: error,
    });
  }
  /*
   * **The gateway never answered** (fix round 1, finding 1): a timeout, a
   * 5xx, a dropped socket, or a 2xx whose body could not be read. The payout
   * may or may not exist, and PayMongo's `/refunds` takes no idempotency
   * key, so the one thing this copy must not invite is a retry — the admin
   * is sent to the gateway to look, which is the only way to find out. The
   * service has already logged it and written a `payment.refund_unconfirmed`
   * audit row.
   */
  if (error instanceof RefundOutcomeUnknownError) {
    return new TRPCError({
      code: 'INTERNAL_SERVER_ERROR',
      message:
        `The ${error.provider} gateway did not confirm this refund, so it may or may not have ` +
        'paid out. Do NOT refund again — check it at the gateway first, and tell whoever keeps ' +
        'the books.',
      cause: error,
    });
  }
  /*
   * A gateway that is registered but switched off (Xendit today), or a
   * provider name no implementation answers to. Both mean the money did not
   * move: `provider.refund()` threw before any request was built.
   */
  if (error instanceof ProviderNotEnabledError || error instanceof UnknownProviderError) {
    return new TRPCError({
      code: 'INTERNAL_SERVER_ERROR',
      message:
        'The gateway that took this payment cannot be reached from here, so nothing was ' +
        'refunded. Refund it at the gateway and record it by hand.',
      cause: error,
    });
  }
  /*
   * `FORBIDDEN`, and it should be unreachable through tRPC: `cancelRefund`
   * has already refused anyone but an owner or a finance user. Mapped anyway
   * because `recordPayment()` keeps its own admin-only gate — a webhook may
   * confirm a refund, never start one — and a fail-closed refusal must not
   * surface as a 500 if the two ever disagree.
   */
  if (error instanceof RefundNotAdminInitiatedError) {
    return new TRPCError({
      code: 'FORBIDDEN',
      message: 'Not permitted for this account.',
      cause: error,
    });
  }
  return error instanceof TRPCError
    ? error
    : new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'That did not work.', cause: error });
}

export const adminRefundsRouter = router({
  /**
   * Cancels a booking. **Moves no money**, by construction: this resolver
   * cannot reach `recordPayment()`.
   *
   * A cancellation mid-trip is allowed and leaves the check-ins already
   * recorded standing — the van really did reach those stops (owner ruling
   * 2026-10-16, written up in CLAUDE.md's Dispatch section). What it does do
   * is put an `on_trip` van back on sale, because the completion that would
   * have done that is never going to happen now.
   */
  cancelBooking: adminProcedure('cancelRefund')
    .input(cancelInput)
    .mutation(async ({ input, ctx }) => {
      try {
        return await cancelBooking({
          bookingId: input.bookingId,
          reason: input.reason,
          // The gate's validated session, never a value from the payload:
          // "who cancelled this" is not a question a client may answer.
          actorUserId: ctx.adminSession.subjectId,
          // The clock, read once here at the request boundary.
          now: new Date(),
        });
      } catch (error) {
        throw asTrpcError(error);
      }
    }),

  /**
   * Sends money back through the provider that took it, and records one
   * positive `refund` row for it.
   *
   * Partial refunds are allowed and a booking may carry several; their sum
   * can never exceed what it was paid, which `recordPayment()` enforces
   * under the booking row lock. **The booking's status is not touched here
   * at all** — §6: a refund is never a booking status.
   */
  refundPayment: adminProcedure('cancelRefund')
    .input(refundInput)
    .mutation(async ({ input, ctx }) => {
      try {
        return await refundPayment({
          paymentId: input.paymentId,
          amountCentavos: input.amountCentavos,
          reason: input.reason,
          offline: input.offline,
          actorUserId: ctx.adminSession.subjectId,
        });
      } catch (error) {
        throw asTrpcError(error);
      }
    }),
});
