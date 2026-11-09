/**
 * `admin.transferQuotes.convert` (transfers-launch plan, Task T19; §6 steps
 * 2–3) — owner or finance turning a `transfer_custom` inquiry into a real,
 * held transfer booking.
 *
 * `adminProcedure('transferQuoting')` — a **new** ROLE_MATRIX area, owner and
 * finance only (owner answer 4). A dispatcher is denied by the gate itself,
 * never by a hidden button; `role-isolation.test.ts`'s generated 39-case
 * matrix already covers the denial the moment the area exists, and T21's own
 * dedicated test is the end-to-end proof against this exact procedure.
 *
 * Nothing here decides anything — the same discipline `admin/refunds.ts`
 * documents for itself. The resolver reads the admin's id off the gate's
 * validated session, hands off to `services/transfers/convert-quote.ts`,
 * and turns a refusal into a sentence.
 */
import { TRPCError } from '@trpc/server';
import { transferQuoteConvertInput } from '@rg/shared';
import {
  GatewayMinimumNotMetError,
  HoldContentionError,
  HoldLimitReachedError,
} from '../../services/create-hold';
import {
  TransferBookingShapeError,
  TransferCapacityRefusedError,
  TransferNoticeTooShortError,
} from '../../services/transfers/create-booking';
import {
  convertTransferQuote,
  TransferQuoteConvertRaceError,
  TransferQuoteInquiryNotConvertibleError,
  TransferQuoteInquiryNotFoundError,
  TransferQuoteLinkUnconfirmedError,
} from '../../services/transfers/convert-quote';
import { adminProcedure, router } from '../../trpc';

/** Why the inquiry itself refused conversion, in a sentence a staff screen can show. */
const NOT_CONVERTIBLE_MESSAGE: Record<TransferQuoteInquiryNotConvertibleError['reason'], string> = {
  wrong_type: 'This inquiry is not a custom trip request, so it cannot be converted.',
  already_converted: 'This request has already been converted to a booking.',
  missing_route_description:
    'This request has no route description on file — it cannot be converted as it stands. ' +
    'Contact the guest and ask them to resubmit the request.',
};

/**
 * `createTransferBooking()`'s refusals, reached through this path too.
 * Staff-facing rather than guest-facing — the screen is internal, so a
 * sentence may name the mechanics the guest-facing
 * `translateHoldTransferError` (`routers/public/checkout.ts`) deliberately
 * doesn't.
 */
function asTrpcError(error: unknown): TRPCError {
  if (error instanceof TransferQuoteInquiryNotFoundError) {
    return new TRPCError({ code: 'NOT_FOUND', message: 'That inquiry no longer exists.' });
  }
  if (error instanceof TransferQuoteInquiryNotConvertibleError) {
    return new TRPCError({
      code: 'CONFLICT',
      message: NOT_CONVERTIBLE_MESSAGE[error.reason],
      cause: error,
    });
  }
  /*
   * The race this module's own header note describes: a booking now exists
   * ({@link TransferQuoteConvertRaceError.newBookingRef}) that is not linked
   * to any inquiry, because another conversion won in between. `CONFLICT`,
   * naming both refs, so staff can cancel the duplicate through
   * `admin.refunds.cancelBooking` — the message is the whole point, not a
   * detail to trim.
   */
  if (error instanceof TransferQuoteConvertRaceError) {
    return new TRPCError({
      code: 'CONFLICT',
      message:
        `This request was already converted to booking ${error.existingBookingId} by someone ` +
        `else while this one was being created. A SECOND booking (${error.newBookingRef}) was ` +
        'created and is not linked to this request — please cancel it.',
      cause: error,
    });
  }
  /*
   * Dedicated-review should-fix #5: a deadlock survived every retry, or the
   * inquiry's own link changed again while this call was reporting the
   * first race — either way, {@link error.bookingRef} is a real, live
   * booking this call created, which the message names rather than losing.
   */
  if (error instanceof TransferQuoteLinkUnconfirmedError) {
    return new TRPCError({
      code: 'CONFLICT',
      message:
        `Booking ${error.bookingRef} was created, but linking it back to this request could ` +
        'not be confirmed. Check the inquiry and the booking, and cancel the booking if it is ' +
        'a duplicate.',
      cause: error,
    });
  }
  if (error instanceof TransferBookingShapeError) {
    return new TRPCError({
      code: 'BAD_REQUEST',
      message: `This request cannot be booked as entered (${error.reason}). ${error.message}`,
      cause: error,
    });
  }
  if (error instanceof TransferCapacityRefusedError) {
    const sentence: Record<TransferCapacityRefusedError['reason'], string> = {
      no_vehicle_available: 'No vehicle of that type is free for that pickup time.',
      no_driver_available: 'No driver has capacity left on that date.',
      pickup_crosses_midnight: 'That trip would run past midnight — choose an earlier pickup time.',
    };
    return new TRPCError({ code: 'CONFLICT', message: sentence[error.reason], cause: error });
  }
  if (error instanceof TransferNoticeTooShortError) {
    return new TRPCError({
      code: 'BAD_REQUEST',
      message:
        error.hoursUntilPickup < 0
          ? 'That pickup time has already passed.'
          : `This transfer needs at least ${error.minNoticeHours}h notice before pickup; ` +
            `this one is ${error.hoursUntilPickup.toFixed(1)}h away.`,
      cause: error,
    });
  }
  if (error instanceof GatewayMinimumNotMetError) {
    return new TRPCError({
      code: 'BAD_REQUEST',
      message:
        `The amount due now (₱${(error.amountDueNowCentavos / 100).toFixed(2)}) is below the ` +
        `₱${(error.minimumCentavos / 100).toFixed(2)} gateway minimum. Quote a higher price.`,
      cause: error,
    });
  }
  if (error instanceof HoldLimitReachedError) {
    return new TRPCError({
      code: 'CONFLICT',
      message: `This guest's ${error.scope} already holds ${error.limit} unpaid bookings.`,
      cause: error,
    });
  }
  if (error instanceof HoldContentionError) {
    return new TRPCError({
      code: 'CONFLICT',
      message: 'This date is very busy right now. Please try again in a moment.',
      cause: error,
    });
  }
  return error instanceof TRPCError
    ? error
    : new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'That did not work.', cause: error });
}

export const adminTransferQuotesRouter = router({
  convert: adminProcedure('transferQuoting')
    .input(transferQuoteConvertInput)
    .mutation(async ({ input, ctx }) => {
      try {
        return await convertTransferQuote(
          {
            inquiryId: input.inquiryId,
            vehicleTypeId: input.vehicleTypeId,
            productType: input.productType,
            date: input.date,
            pickupTime: input.pickupTime,
            dayUseEndTime: input.dayUseEndTime ?? null,
            customRouteDurationMinutes: input.customRouteDurationMinutes ?? null,
            pax: input.pax,
            luggageCount: input.luggageCount,
            pickup: input.pickup ?? null,
            pickupMapUrl: input.pickupMapUrl ?? null,
            dropoffAddress: input.dropoffAddress,
            dropoffMapUrl: input.dropoffMapUrl ?? null,
            flightNumber: input.flightNumber ?? null,
            airline: input.airline ?? null,
            leadPhone: input.leadPhone,
            priceCentavos: input.priceCentavos,
          },
          // The gate's validated session, never a value from the payload —
          // "who quoted this" is not a question a client may answer.
          ctx.adminSession.subjectId,
        );
      } catch (error) {
        throw asTrpcError(error);
      }
    }),
});
