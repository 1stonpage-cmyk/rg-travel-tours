/**
 * `convertTransferQuote()` (transfers-launch plan, Task T19; §6 steps 2–3) —
 * the business logic behind `admin.transferQuotes.convert`: turns a
 * `transfer_custom` inquiry into a real, held transfer booking and links the
 * two together.
 *
 * **Three steps, deliberately NOT one transaction**, because
 * `createTransferBooking()` manages its own self-contained transaction
 * (`services/transfers/create-booking.ts`'s own module note: "every read in
 * the transaction goes through `tx`", because a second connection checked
 * out while one is held can wedge the pool) and this function cannot hold a
 * lock open across that call without risking exactly that:
 *
 *  1. A plain, lockless read of the inquiry — cheap, and catches the
 *     overwhelmingly common case (a double-click, a second staff tab already
 *     converted) before any booking is created at all.
 *  2. `createTransferBooking()`, which commits independently.
 *  3. A SMALL transaction that links the inquiry to the booking it just
 *     created and writes the dedicated `transfer.custom_quote_converted`
 *     audit row the plan names — using a conditional UPDATE
 *     (`WHERE id = ? AND converted_booking_id IS NULL`) as the actual
 *     decision, not step 1's read, which only pre-filters. Two staff
 *     converting the same inquiry within the same narrow window both pass
 *     step 1; InnoDB serialises the two UPDATEs in step 3, and exactly one
 *     matches a row — the same compare-and-swap `admin.auth.resetPassword`
 *     uses on `password_reset_tokens.used_at` for the identical reason.
 *
 * **The race's loser has already created a real, live booking in step 2**,
 * and step 3 cannot undo that — there is no "uncreate a booking" path, and
 * inventing one here would be a second, narrower cancellation flow. So a
 * lost race is not swallowed: {@link TransferQuoteConvertRaceError} carries
 * both booking refs, and the router surfaces it as a `CONFLICT` naming both,
 * so staff can cancel the duplicate through the existing
 * `admin.refunds.cancelBooking` path. A duplicate `pending_payment` hold with
 * no payment against it is recoverable; silently discarding which one is not.
 */
import { and, eq, isNull } from 'drizzle-orm';
import type { TransferProductType } from '@rg/shared';
import { getDb } from '../../db/client';
import { inquiries } from '../../db/schema';
import { writeAudit } from '../audit';
import type { HeldBooking } from '../create-hold';
import { createTransferBooking } from './create-booking';

/** Everything staff type or confirm on the "Quote & convert to booking" form. */
export interface ConvertTransferQuoteInput {
  inquiryId: number;
  vehicleTypeId: number;
  productType: TransferProductType;
  /** The civil pickup date in Asia/Manila. */
  date: string;
  pickupTime: string;
  dayUseEndTime: string | null;
  /** Required for `transfer_one_way`, null for `transfer_day_use`. */
  customRouteDurationMinutes: number | null;
  pax: number;
  luggageCount: number;
  pickup: string | null;
  pickupMapUrl: string | null;
  dropoffAddress: string;
  dropoffMapUrl: string | null;
  flightNumber: string | null;
  airline: string | null;
  /**
   * Pre-filled from `inquiries.phone` by the client when present (Task T20),
   * typed by staff otherwise — see `transferQuoteConvertInput`'s own header
   * note on why this is required here when it is nullable on the inquiry.
   */
  leadPhone: string;
  priceCentavos: number;
}

/** No inquiry with this id exists. */
export class TransferQuoteInquiryNotFoundError extends Error {
  readonly inquiryId: number;
  constructor(inquiryId: number) {
    super(`Inquiry ${inquiryId} does not exist`);
    this.name = 'TransferQuoteInquiryNotFoundError';
    this.inquiryId = inquiryId;
  }
}

/** Why this inquiry cannot be converted right now. */
export const TRANSFER_QUOTE_NOT_CONVERTIBLE_REASONS = [
  /** Not a `transfer_custom` inquiry at all — a general or package enquiry. */
  'wrong_type',
  /** `convertedBookingId` is already set. */
  'already_converted',
  /**
   * `routeDescription` is null. Nothing at the database enforces it is set
   * for a `transfer_custom` row (Task T17's own deliberate decision not to
   * add a CHECK), so this is a malformed row, not a guest choice — see
   * `transferQuoteConvertInput`'s header note on why this is NOT a staff-
   * typed field.
   */
  'missing_route_description',
] as const;
export type TransferQuoteNotConvertibleReason =
  (typeof TRANSFER_QUOTE_NOT_CONVERTIBLE_REASONS)[number];

export class TransferQuoteInquiryNotConvertibleError extends Error {
  readonly inquiryId: number;
  readonly reason: TransferQuoteNotConvertibleReason;
  constructor(inquiryId: number, reason: TransferQuoteNotConvertibleReason) {
    super(`Inquiry ${inquiryId} cannot be converted (${reason})`);
    this.name = 'TransferQuoteInquiryNotConvertibleError';
    this.inquiryId = inquiryId;
    this.reason = reason;
  }
}

/**
 * Step 1 passed, a booking was created in step 2, and step 3's
 * compare-and-swap then found the inquiry already linked to a DIFFERENT
 * booking — another conversion won the race in between. See this module's
 * own header note: there is no path to un-create {@link newBookingRef}.
 */
export class TransferQuoteConvertRaceError extends Error {
  readonly inquiryId: number;
  readonly newBookingRef: string;
  readonly newBookingId: number;
  readonly existingBookingId: number;
  constructor(
    inquiryId: number,
    newBookingRef: string,
    newBookingId: number,
    existingBookingId: number,
  ) {
    super(
      `Inquiry ${inquiryId} was converted to booking ${existingBookingId} while this request ` +
        `was in flight; a second booking (${newBookingRef}, id ${newBookingId}) was already ` +
        'created and now needs cancelling by hand',
    );
    this.name = 'TransferQuoteConvertRaceError';
    this.inquiryId = inquiryId;
    this.newBookingRef = newBookingRef;
    this.newBookingId = newBookingId;
    this.existingBookingId = existingBookingId;
  }
}

export async function convertTransferQuote(
  input: ConvertTransferQuoteInput,
  staffUserId: number,
  now: Date = new Date(),
): Promise<HeldBooking> {
  const db = getDb();

  // 1. The plain, lockless pre-check.
  const [inquiry] = await db
    .select({
      type: inquiries.type,
      name: inquiries.name,
      email: inquiries.email,
      message: inquiries.message,
      routeDescription: inquiries.routeDescription,
      convertedBookingId: inquiries.convertedBookingId,
    })
    .from(inquiries)
    .where(eq(inquiries.id, input.inquiryId))
    .limit(1);

  if (!inquiry) throw new TransferQuoteInquiryNotFoundError(input.inquiryId);
  if (inquiry.type !== 'transfer_custom') {
    throw new TransferQuoteInquiryNotConvertibleError(input.inquiryId, 'wrong_type');
  }
  if (inquiry.convertedBookingId !== null) {
    throw new TransferQuoteInquiryNotConvertibleError(input.inquiryId, 'already_converted');
  }
  if (inquiry.routeDescription === null || inquiry.routeDescription.trim() === '') {
    throw new TransferQuoteInquiryNotConvertibleError(input.inquiryId, 'missing_route_description');
  }

  // 2. The one shared writer. Commits independently of steps 1 and 3.
  const held = await createTransferBooking(
    {
      date: input.date,
      routeId: null,
      customRouteDescription: inquiry.routeDescription,
      customRouteDurationMinutes: input.customRouteDurationMinutes,
      vehicleTypeId: input.vehicleTypeId,
      productType: input.productType,
      // No catalog route on this path, so there is no reversible direction
      // to describe — see `CreateTransferBookingInput.direction`'s own note
      // and `revenueByRoute()`'s identical normalisation (Task T18).
      direction: 'forward',
      pickupTime: input.pickupTime,
      dayUseEndTime: input.dayUseEndTime,
      pax: input.pax,
      luggageCount: input.luggageCount,
      pickup: input.pickup,
      pickupMapUrl: input.pickupMapUrl,
      dropoffAddress: input.dropoffAddress,
      dropoffMapUrl: input.dropoffMapUrl,
      flightNumber: input.flightNumber,
      airline: input.airline,
      requests: inquiry.message,
      // Nobody is at checkout yet — §6 step 5's own description of what
      // happens next ("deposit online/QR or wait for cash collection").
      payMode: 'deposit',
      lead: { name: inquiry.name, email: inquiry.email, phone: input.leadPhone },
      priceSource: { kind: 'staff', priceCentavos: input.priceCentavos, staffUserId },
    },
    now,
  );

  // 3. The link and the dedicated audit row — see the module note on why
  //    this is its own transaction rather than wrapping step 2.
  await db.transaction(async (tx) => {
    const [claimed] = await tx
      .update(inquiries)
      .set({ convertedBookingId: held.bookingId })
      .where(and(eq(inquiries.id, input.inquiryId), isNull(inquiries.convertedBookingId)));
    // The race, decided here and nowhere else. A loser matches no row.
    if (claimed.affectedRows !== 1) {
      const [current] = await tx
        .select({ convertedBookingId: inquiries.convertedBookingId })
        .from(inquiries)
        .where(eq(inquiries.id, input.inquiryId))
        .limit(1);
      /*
       * No hard deletes anywhere in this project (CLAUDE.md), so the WHERE
       * above matched this inquiry's id but not its `IS NULL` half — the row
       * exists with a real `convertedBookingId`. `current` being absent, or
       * carrying `null`, would mean the row vanished or raced a second time
       * in the few milliseconds since; loud rather than a silent wrong
       * booking id in the error a staff member is about to act on.
       */
      if (current?.convertedBookingId == null) {
        throw new Error(
          `Inquiry ${input.inquiryId}'s converted_booking_id changed again while ` +
            'reporting the first race — cannot name the booking it now points to',
        );
      }
      throw new TransferQuoteConvertRaceError(
        input.inquiryId,
        held.ref,
        held.bookingId,
        current.convertedBookingId,
      );
    }

    await writeAudit(tx, {
      actorType: 'user',
      actorId: staffUserId,
      action: 'transfer.custom_quote_converted',
      entity: 'bookings',
      entityId: held.bookingId,
      // Identifiers and the amount only — no name, email or phone (audit
      // rows are read by every admin and exported in reports).
      data: {
        inquiryId: input.inquiryId,
        priceCentavos: input.priceCentavos,
      },
    });
  });

  return held;
}
