/**
 * `checkout.quote`, `checkout.availability`, `checkout.createHold` — Week 3
 * checkout plan, Task 6.
 *
 * **This router computes nothing.** Every centavo here comes from
 * `priceQuote()` / `loadQuoteInputs()` (pricing.ts) or `createHold()`
 * (create-hold.ts); every capacity verdict comes from `assessCapacity()`
 * (capacity.ts). The three resolvers below only: validate the wire input
 * (Zod, via `.input()`), call exactly one service, and translate a typed
 * service error into a guest-safe `TRPCError`. CLAUDE.md: "The server
 * computes all money" — and here, specifically, the SERVICES do, never the
 * router.
 *
 * All three are `publicProcedure` — a guest has no session (task A4's
 * enumeration guard requires every procedure declare `publicProcedure` or
 * `adminProcedure(area)`, so anything else fails `procedure-role-metadata.test.ts`).
 *
 * **`quote` assembles the wire shape (Ruling 3).** `priceQuote()` stays pure
 * and knows nothing about a quote id; `quoteDigest()` is called here, with
 * the EXACT same inputs `createHold()` recomputes it from — tourId (never
 * slug — see pricing.ts's own note), date, pax, addonIds, couponCode,
 * totalCentavos. A digest built any other way here would refuse every hold.
 *
 * **Error translation is this file's whole job, and it never lets a raw
 * service message through.** tRPC's `errorFormatter` (trpc.ts) scrubs
 * filesystem-shaped substrings out of `message`, but it does not choose a
 * better message — an unexpected internal error still reports the
 * underlying error's own text verbatim. Every branch below picks the
 * message a guest should see, and anything not recognised falls through to
 * `internalError()`'s fixed `INTERNAL_SERVER_ERROR`, with the real error
 * kept only as `cause` (server-side logging, never serialised to the
 * client). **All three procedures wrap their entire body in try/catch for
 * this** — `availability` included, even though its typed outcome
 * (`{ ok: false, reason }`) is a normal RETURN, never a throw. A procedure
 * with no `catch` at all is not "nothing to translate", it is an open door:
 * the thrown error's own `.message` becomes `shape.message` verbatim, and
 * nothing here would have caught it (round 1 review).
 *
 * **The coupon check on `quote` is deliberately a second call.**
 * `loadQuoteInputs()`'s own coupon lookup (shared with `createHold()`'s
 * `loadRecomputeInputs`) is silent by design — an unknown or inactive code
 * simply prices as if no coupon were given, which is correct for
 * `priceQuote()`'s pure arithmetic but wrong for a guest who typed a coupon
 * code and deserves to be told why it didn't apply. So once the subtotal is
 * known, `validateCoupon()` (coupons.ts) re-checks the same code against
 * the full §6 rule set (exists, active, within dates, usage limit, minimum
 * spend — in that order) and throws the first one it fails. This mirrors
 * `createHold()`'s own order: price first with whatever coupon matched,
 * validate the rules against that price, throw before trusting the result.
 */
import { TRPCError } from '@trpc/server';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { createHoldInput, formatPeso, quoteInput, type QuoteResult } from '@rg/shared';
import { getDb } from '../../db/client';
import { tours } from '../../db/schema';
import {
  assessCapacity,
  type CapacityRefusalReason,
  type CapacityVerdict,
} from '../../services/capacity';
import {
  CouponExpiredError,
  CouponInactiveError,
  CouponMinimumSpendNotMetError,
  CouponNotFoundError,
  CouponNotStartedError,
  CouponUsageLimitReachedError,
  validateCoupon,
} from '../../services/coupons';
import {
  CapacityRefusedError,
  createHold as createHoldService,
  HoldContentionError,
  HoldLimitReachedError,
  PriceChangedError,
  TourDateBlockedError,
  TourDatePastError,
} from '../../services/create-hold';
import { loadQuoteInputs, priceQuote, quoteDigest } from '../../services/pricing';
import { publicProcedure, router } from '../../trpc';

/**
 * `checkout.availability`'s own input — a date and a head count against one
 * tour, nothing money-shaped. Not reused from `quoteInput` (which also
 * carries `addonIds`/`couponCode`, irrelevant to a capacity check): a
 * narrower, router-local `.strict()` shape is simpler than picking fields
 * off a schema built for a different consumer.
 */
const civilDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected a YYYY-MM-DD date');
const availabilityInput = z
  .object({
    tourSlug: z.string().min(1).max(160),
    date: civilDate,
    pax: z.number().int().min(1).max(12),
  })
  .strict();

// ---------------------------------------------------------------------------
// Error translation — one guest-safe sentence per typed service error.
// ---------------------------------------------------------------------------

/** §5's four capacity refusals, each its own sentence — never one "sold out". */
const CAPACITY_MESSAGES: Record<CapacityRefusalReason, string> = {
  tour_unavailable: 'This tour is not available.',
  tour_sold_out: 'This tour is fully booked for that date.',
  no_van_available: 'No vehicle is available for that date and group size.',
  no_driver_available: 'No driver is available for that date.',
};

/**
 * The one fallback for anything this router does not recognise — a dropped
 * connection, a query timeout, a service throwing something new. ALL THREE
 * procedures route every unrecognised error through this, not just the ones
 * with a typed vocabulary to translate: a procedure with no `catch` at all
 * lets the thrown error's own `.message` become `shape.message` verbatim,
 * which `trpc.ts`'s `errorFormatter` only path-scrubs — it never replaces
 * it. The real error survives only as `cause` (server-side logging; never
 * part of the response shape tRPC builds).
 */
function internalError(error: unknown): TRPCError {
  return new TRPCError({
    code: 'INTERNAL_SERVER_ERROR',
    message: 'Could not complete the request.',
    cause: error,
  });
}

/**
 * Every coupon rule's typed error (coupons.ts), translated. Returns `null`
 * for anything else, so callers can fall through to their own cases.
 *
 * Order does not matter for correctness — none of these classes extend one
 * another except `CouponExhaustedUnderLockError` (create-hold.ts), which
 * `instanceof CouponUsageLimitReachedError` already catches, so
 * `createHold`'s authoritative re-check under lock gets the exact same
 * guest sentence as `validateCoupon`'s early read.
 */
function translateCouponError(error: unknown): TRPCError | null {
  if (error instanceof CouponMinimumSpendNotMetError) {
    return new TRPCError({
      code: 'BAD_REQUEST',
      message: `Spend ${formatPeso(error.shortfallCentavos)} more to use this coupon.`,
    });
  }
  if (error instanceof CouponUsageLimitReachedError) {
    return new TRPCError({
      code: 'BAD_REQUEST',
      message: 'That coupon code has already been fully claimed.',
    });
  }
  if (error instanceof CouponExpiredError) {
    return new TRPCError({ code: 'BAD_REQUEST', message: 'That coupon code has expired.' });
  }
  if (error instanceof CouponNotStartedError) {
    return new TRPCError({ code: 'BAD_REQUEST', message: "That coupon code isn't active yet." });
  }
  if (error instanceof CouponInactiveError) {
    return new TRPCError({
      code: 'BAD_REQUEST',
      message: 'That coupon code is no longer active.',
    });
  }
  if (error instanceof CouponNotFoundError) {
    return new TRPCError({ code: 'BAD_REQUEST', message: "We couldn't find that coupon code." });
  }
  return null;
}

/**
 * `loadQuoteInputs()` and `priceQuote()` (pricing.ts) each throw a plain
 * `Error` for their one failure case — a slug that names no active tour, and
 * a head count no tier covers — rather than a typed class. Both are
 * CLAUDE.md "do not modify" files, so the match is on the exact text those
 * two throw sites produce, which is as stable as a typed class would be:
 * changing either message is changing this file's contract with them, not
 * an incidental edit.
 */
function translateQuoteError(error: unknown): TRPCError {
  const coupon = translateCouponError(error);
  if (coupon) return coupon;
  if (error instanceof Error && /No active tour found for slug/.test(error.message)) {
    return new TRPCError({ code: 'NOT_FOUND', message: 'No tour found for that selection.' });
  }
  if (error instanceof Error && /No price tier covers a head count/.test(error.message)) {
    return new TRPCError({
      code: 'BAD_REQUEST',
      message: 'No pricing is available for that group size.',
    });
  }
  return internalError(error);
}

/** Every typed refusal `createHold()` (create-hold.ts) can throw, translated. */
function translateHoldError(error: unknown): TRPCError {
  const coupon = translateCouponError(error);
  if (coupon) return coupon;
  if (error instanceof CapacityRefusedError) {
    return new TRPCError({ code: 'BAD_REQUEST', message: CAPACITY_MESSAGES[error.reason] });
  }
  if (error instanceof TourDatePastError) {
    return new TRPCError({ code: 'BAD_REQUEST', message: 'That date has already passed.' });
  }
  if (error instanceof TourDateBlockedError) {
    return new TRPCError({
      code: 'BAD_REQUEST',
      message: "This tour isn't running on that date.",
    });
  }
  if (error instanceof PriceChangedError) {
    return new TRPCError({
      code: 'CONFLICT',
      message: 'The price for this quote has changed. Please request a new quote.',
    });
  }
  if (error instanceof HoldLimitReachedError) {
    return new TRPCError({
      code: 'CONFLICT',
      message:
        'You already have the maximum number of pending bookings for this contact. ' +
        'Please complete or cancel one before starting another.',
    });
  }
  if (error instanceof HoldContentionError) {
    return new TRPCError({
      code: 'CONFLICT',
      message: 'This date is very busy right now. Please try again in a moment.',
    });
  }
  return internalError(error);
}

export const checkoutRouter = router({
  /**
   * Assembles the wire `QuoteResult` (`@rg/shared`'s `checkout.ts`):
   * `priceQuote()`'s pure result plus `quoteId` from `quoteDigest()`.
   * `createHold` later recomputes the same digest from the database and
   * refuses a mismatch (owner decision Q3), so every input to `quoteDigest`
   * here must be exactly what `createHold` will read back — see that
   * module's note on `tourId` vs `tourSlug`.
   */
  quote: publicProcedure.input(quoteInput).query(async ({ input }): Promise<QuoteResult> => {
    try {
      const inputs = await loadQuoteInputs(
        input.tourSlug,
        input.date,
        input.addonIds,
        input.couponCode,
      );
      const quote = priceQuote({ ...inputs, pax: input.pax });

      // The friendly, guest-facing coupon check — see the module note on
      // why this runs as a SECOND call rather than trusting loadQuoteInputs'
      // silent lookup.
      if (input.couponCode) {
        await validateCoupon(input.couponCode, quote.subtotalCentavos, new Date());
      }

      const quoteId = quoteDigest({
        tourId: inputs.tourId,
        date: input.date,
        pax: input.pax,
        addonIds: input.addonIds,
        couponCode: input.couponCode,
        totalCentavos: quote.totalCentavos,
      });

      return { ...quote, quoteId };
    } catch (error) {
      throw translateQuoteError(error);
    }
  }),

  /**
   * An advisory capacity read — NOT the authoritative check. `createHold()`
   * re-runs `assessCapacity()` itself, under its own locks, at the moment it
   * actually writes a booking; nothing here reserves anything, so the
   * verdict returned can be stale by the time a guest submits the form. That
   * is fine for a date-picker hint and would not be fine for a hold.
   *
   * Returns the raw `CapacityVerdict` rather than throwing on `ok: false`:
   * `assessCapacity()` itself returns a verdict rather than a refusal for
   * exactly this reason (its own module note), and "not available" is a
   * normal answer here, not an exceptional one.
   */
  availability: publicProcedure
    .input(availabilityInput)
    .query(async ({ input }): Promise<CapacityVerdict> => {
      try {
        const [tour] = await getDb()
          .select({ id: tours.id })
          .from(tours)
          .where(and(eq(tours.slug, input.tourSlug), eq(tours.isActive, true)));
        // A legitimate answer, not a failure — returned, never thrown.
        if (!tour) return { ok: false, reason: 'tour_unavailable' };

        return await getDb().transaction((tx) =>
          assessCapacity(tx, tour.id, input.date, input.pax),
        );
      } catch (error) {
        throw internalError(error);
      }
    }),

  /**
   * Turns a guest's checkout form into a held booking. Everything — capacity,
   * the date guards, the price recompute, the hold caps, the coupon — is
   * `createHold()`'s (create-hold.ts); this resolver only calls it and
   * translates whichever typed refusal comes back.
   *
   * Rate-limited to 5 per IP per 15 minutes (Ruling 5, owner decision Q4) —
   * see `middleware/rate-limit.ts`'s `createCheckoutHoldLimiter()`, mounted
   * in `app.ts`.
   */
  createHold: publicProcedure.input(createHoldInput).mutation(async ({ input }) => {
    try {
      return await createHoldService(input);
    } catch (error) {
      throw translateHoldError(error);
    }
  }),
});
