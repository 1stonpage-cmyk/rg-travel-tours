/**
 * `admin.bookings.approveReceipt` / `.rejectReceipt` — the verification
 * queue's two buttons (Week 4 plan, Task 7; BUILD_SPEC §6 step 5).
 *
 * **The reject half did not exist anywhere in this codebase before.**
 * `verifyCashPayment()` only ever approved; `payments.reject_reason` was a
 * column nothing wrote and `status='rejected'` a value nothing set. A guest
 * whose transfer could not be matched therefore had no way to be told so
 * and no way to try again, which is the gap this closes.
 *
 * Both procedures are `adminProcedure('verifyPayments')` — §9's "Verify
 * payments, record payments" row, which is **owner and finance only**. A
 * dispatcher may run the day and assign a van; they may not decide that
 * money arrived. The gate is the builder's, not this file's: there is no
 * role check in here to forget to write.
 *
 * ## Two procedures rather than one `decide({ decision })`
 *
 * They are different permissions in spirit even though §9 grants them
 * together — one credits money, the other sets a deadline a guest has to
 * meet — and a single procedure taking a `decision` string makes "who may
 * approve" and "who may reject" one question forever. Two names also keep
 * the audit trail legible from the client side: the mutation a reviewer
 * sees in a log is the thing that happened.
 *
 * ## Nothing here decides anything
 *
 * The resolvers read the session, hand off to `decideManualReceipt()` and
 * send an email. The money, the locks, the audit row and the re-upload
 * deadline are all in `services/payments/` where they can be tested without
 * a transport — and the emails are sent AFTER the service resolves, so a
 * mail failure cannot un-approve a payment.
 */
import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { manilaCivilDate } from '@rg/shared';
import { eq } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { bookings, tours } from '../../db/schema';
import { notify } from '../../services/notify';
import {
  ReceiptAlreadyDecidedError,
  ReceiptPaymentNotFoundError,
  ReceiptRejectionNeedsReasonError,
} from '../../services/payments/errors';
import { decideManualReceipt } from '../../services/payments/manual-receipt';
import { adminProcedure, router } from '../../trpc';

/**
 * The rejection reason, bounded by its column (`varchar(400)`).
 *
 * `min(1)` after trimming, because the guest is SHOWN this: a blank reason
 * leaves the portal saying "your payment was not accepted" and nothing a
 * guest could act on. The service refuses a blank one too — this is the
 * friendly refusal, that one is the guarantee.
 */
const rejectInput = z
  .object({
    paymentId: z.number().int().positive(),
    reason: z.string().trim().min(1, 'Tell the guest what was wrong, in a sentence.').max(400),
  })
  .strict();

const approveInput = z.object({ paymentId: z.number().int().positive() }).strict();

/**
 * Service errors an admin should see as a sentence rather than a 500.
 *
 * `ReceiptAlreadyDecidedError` is the one that will actually happen: two
 * people working the queue, or one person double-clicking. `CONFLICT`, not
 * `BAD_REQUEST` — nothing was wrong with the request, the row simply moved
 * on, and the UI should refetch rather than ask the admin to correct
 * anything.
 */
function asTrpcError(error: unknown): TRPCError {
  if (error instanceof ReceiptPaymentNotFoundError) {
    return new TRPCError({
      code: 'NOT_FOUND',
      message: 'That receipt is no longer waiting for a decision.',
    });
  }
  if (error instanceof ReceiptAlreadyDecidedError) {
    return new TRPCError({
      code: 'CONFLICT',
      message: `This receipt has already been handled (it is "${error.status}"). Refresh the queue.`,
    });
  }
  if (error instanceof ReceiptRejectionNeedsReasonError) {
    return new TRPCError({
      code: 'BAD_REQUEST',
      message: 'Tell the guest what was wrong, in a sentence.',
    });
  }
  return error instanceof TRPCError
    ? error
    : new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'That did not work.' });
}

/** What the §11 emails need, read once after the decision has committed. */
async function mailPayload(bookingId: number) {
  const [row] = await getDb()
    .select({
      ref: bookings.ref,
      leadEmail: bookings.leadEmail,
      tourTitle: tours.title,
      tourDate: bookings.tourDate,
      totalCentavos: bookings.totalCentavos,
      paidCentavos: bookings.amountPaidCentavos,
    })
    .from(bookings)
    .innerJoin(tours, eq(tours.id, bookings.tourId))
    .where(eq(bookings.id, bookingId))
    .limit(1);
  if (!row) return null;
  return {
    to: row.leadEmail,
    ref: row.ref,
    tourTitle: row.tourTitle,
    // The Manila civil date, never a UTC timestamp sliced into a date — on
    // a UTC+8 box that reads as the day before.
    tourDate: manilaCivilDate(row.tourDate),
    totalCentavos: row.totalCentavos,
    paidCentavos: row.paidCentavos,
  };
}

export const adminBookingsRouter = router({
  /**
   * Approve: the payment becomes `paid`, the booking `confirmed`, and the
   * guest gets §11's confirmation email.
   */
  approveReceipt: adminProcedure('verifyPayments')
    .input(approveInput)
    .mutation(async ({ input, ctx }) => {
      let result;
      try {
        result = await decideManualReceipt({
          paymentId: input.paymentId,
          decision: 'approve',
          verifier: {
            type: 'user',
            id: ctx.session.subjectId,
            // The LIVE role from the session, which `readSession` resolves
            // from `users` on every request — so a demoted admin's open tab
            // cannot approve a payment.
            role: ctx.session.role,
          },
          now: new Date(),
        });
      } catch (error) {
        throw asTrpcError(error);
      }

      const payload = await mailPayload(result.bookingId);
      if (payload) await notify('booking_confirmed', payload);

      return { bookingStatus: result.bookingStatus };
    }),

  /**
   * Reject: the payment becomes `rejected` with the reason, the booking
   * returns to `pending_payment` (owner decision 2026-10-13, Q7), and the
   * guest gets the amber "please re-upload" email carrying that reason.
   */
  rejectReceipt: adminProcedure('verifyPayments')
    .input(rejectInput)
    .mutation(async ({ input, ctx }) => {
      let result;
      try {
        result = await decideManualReceipt({
          paymentId: input.paymentId,
          decision: 'reject',
          reason: input.reason,
          verifier: { type: 'user', id: ctx.session.subjectId, role: ctx.session.role },
          now: new Date(),
        });
      } catch (error) {
        throw asTrpcError(error);
      }

      const payload = await mailPayload(result.bookingId);
      // The admin's own words go to the guest verbatim — escaped in the
      // template, never trusted as HTML.
      if (payload) await notify('payment_rejected', { ...payload, reason: input.reason });

      return { bookingStatus: result.bookingStatus, reuploadBy: result.reuploadBy };
    }),
});
