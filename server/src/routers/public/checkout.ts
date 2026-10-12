/**
 * `checkout.quote`, `checkout.availability`, `checkout.createHold` — Week 3
 * checkout plan, Task 6 — and `checkout.startPayment`, Task 7.
 *
 * **This router computes nothing.** Every centavo here comes from
 * `priceQuote()` / `loadQuoteInputs()` (pricing.ts) or `createHold()`
 * (create-hold.ts); every capacity verdict comes from `assessCapacity()`
 * (capacity.ts). The resolvers below only: validate the wire input
 * (Zod, via `.input()`), call exactly one service, and translate a typed
 * service error into a guest-safe `TRPCError`. CLAUDE.md: "The server
 * computes all money" — and here, specifically, the SERVICES do, never the
 * router. `startPayment` holds to the same rule in the one place it would be
 * tempting to break it: the amount it sends a gateway is READ off the
 * booking row, with the deposit arithmetic left to `depositCentavos()` in
 * `@rg/shared`.
 *
 * **`createHold` and `startPayment` are the only two mutations here, and
 * that is a tested property** (plan Task 9). Neither marks anything paid: a
 * third mutation on this router is how a redirect page quietly becomes a way
 * to confirm a booking.
 *
 * All of them are `publicProcedure` — a guest has no session (task A4's
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
 * client). **Every procedure here wraps its entire body in try/catch for
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
import { and, eq, lt } from 'drizzle-orm';
import { z } from 'zod';
import {
  bookableDateRange,
  bookingPagePath,
  bookingRefSchema,
  createHoldInput,
  depositCentavos,
  formatPeso,
  isDateBookable,
  quoteInput,
  type QuoteResult,
} from '@rg/shared';
import { readSettingBlock } from '../../content/settings';
import { getDb } from '../../db/client';
import { bookings, tours } from '../../db/schema';
import { env } from '../../env';
import { writeAudit } from '../../services/audit';
import { getProvider } from '../../services/payments/registry';
import type { CreateCheckoutResult, PaymentMethod } from '../../services/payments/types';
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
  TourDateNotBookableError,
  TourDatePastError,
} from '../../services/create-hold';
import { loadQuoteInputs, priceQuote, quoteDigest } from '../../services/pricing';
import { publicProcedure, router } from '../../trpc';

/**
 * What `checkout.availability` answers with: every capacity reason, plus the
 * booking window's own (owner decision 2026-10-13, pending R&G).
 *
 * `date_not_bookable` is deliberately NOT a member of
 * `CapacityRefusalReason`: `assessCapacity()` has no clock and must not grow
 * one, so the window is evaluated here and in `createHold()`, never inside
 * the capacity service. Keeping the vocabularies separate is what stops a
 * later reader assuming capacity decides it.
 */
type AvailabilityVerdict = CapacityVerdict | { ok: false; reason: 'date_not_bookable' };

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

/**
 * `checkout.startPayment`'s input — **a booking ref and nothing else.**
 *
 * `.strict()` is the money rule expressed as a schema: a request that
 * carries an amount, a total, a deposit or a currency is REFUSED by tRPC's
 * input stage before the resolver runs, rather than quietly ignored. The
 * amount is read off the booking row inside the resolver (see
 * `amountDueNowCentavos` below), so there is nothing a browser could send
 * that would change it — but "ignored" and "rejected" are different
 * contracts, and a caller sending `amountCentavos` deserves to be told it
 * has misunderstood this endpoint.
 */
const startPaymentInput = z.object({ ref: bookingRefSchema }).strict();

/**
 * The instruments offered at a PayMongo checkout (owner Ruling 7 / Q6).
 *
 * Fixed here, never chosen by the caller. The list is OUR vocabulary
 * (`PAYMENT_METHODS`); the gateway client maps `maya` onto PayMongo's own
 * `paymaya` on the way out.
 *
 * What is deliberately absent:
 *   - `qrph` — waits on BUILD_SPEC §15's own open question.
 *   - `bank_transfer` and `cash` — both are MANUAL flows an admin
 *     reconciles by hand (`provider='manual'`: a receipt upload, cash to
 *     the driver). Offering them at a gateway checkout would promise a
 *     redirect that cannot exist.
 */
export const CHECKOUT_PAYMENT_METHODS = [
  'card',
  'gcash',
  'maya',
  'grab_pay',
] as const satisfies readonly PaymentMethod[];

/**
 * How long a hold lasts once the guest has reached the gateway (owner
 * Ruling 4 / Q5): `created_at + 30 minutes`, replacing the 15 minutes
 * `createHold()` set.
 *
 * **Extended ONCE, and that is the whole subtlety.** A guest who has
 * reached the payment page has committed, and typing a card number slowly
 * should not land their money in `recordPayment()`'s review queue — that
 * queue is for genuine anomalies. But an extension that reapplied on every
 * `startPayment` call would be a renewable hold: reload the page, keep the
 * slot forever, and the capacity nobody is paying for is never released.
 *
 * So the extension is computed FROM `created_at` and the UPDATE only
 * matches a row whose `hold_expires_at` is still short of that target
 * (`extendHoldForPayment`). A second call matches nothing, writes nothing
 * and audits nothing. No new column is needed to remember that it already
 * happened, because `created_at` already remembers.
 *
 * **It does not change what happens when the money lands late anyway.**
 * `recordPayment()` still records such a payment, still leaves the status
 * alone and still raises `payment_review_required`. This makes that path
 * rarer; it does not remove it.
 */
export const PAYMENT_HOLD_MINUTES = 30;

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
 * connection, a query timeout, a service throwing something new. EVERY
 * procedure routes every unrecognised error through this, not just the ones
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
  /*
   * The booking window (owner decision 2026-10-13, pending R&G). Its own
   * message, naming the dates that ARE open: a guest told only "not
   * available" at 18:05 for tomorrow will retry, and a guest told "fully
   * booked" will give up on a tour that has seats.
   */
  if (error instanceof TourDateNotBookableError) {
    return new TRPCError({
      code: 'BAD_REQUEST',
      message:
        `We're not taking bookings for that date. ` +
        `Please pick a date between ${error.earliest} and ${error.latest}.`,
    });
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

/**
 * The gateway could not give us a checkout — for ANY reason.
 *
 * One branch on purpose. A missing `PAYMONGO_SECRET_KEY` (the live state of
 * this project: all three `PAYMONGO_*` variables are empty), a provider
 * name with no implementation, a 4xx from PayMongo, a dropped connection —
 * from the guest's side these are one fact: no payment can be started right
 * now. What they must never become is a redirect to nowhere or a
 * success-shaped response, so this is a refusal with its own code rather
 * than a fallback.
 *
 * `cause` carries the real error for the server log, and nothing else does:
 * the gateway client's "not configured" error names the variable (never its
 * value) and its API error carries PayMongo's own `detail` text — neither
 * belongs in a response to a guest, and tRPC's `errorFormatter` only
 * path-scrubs a message, it never replaces one.
 */
function gatewayUnavailable(error: unknown): TRPCError {
  return new TRPCError({
    code: 'SERVICE_UNAVAILABLE',
    message:
      'Online payment is temporarily unavailable. ' +
      'Please try again shortly, or contact us to pay another way.',
    cause: error,
  });
}

/**
 * `startPayment` raises its own guest-safe `TRPCError`s inline — the booking
 * it cannot find, the booking it refuses to charge, the gateway it could not
 * reach — so this only has to let those through untouched and funnel
 * everything unexpected into `internalError()`. Without the first line a
 * deliberately chosen `NOT_FOUND` would be rewritten as a generic 500 by
 * its own catch block.
 */
function translateStartPaymentError(error: unknown): TRPCError {
  if (error instanceof TRPCError) return error;
  return internalError(error);
}

/**
 * The hold extension of owner Ruling 4, applied at most once per booking.
 *
 * Idempotent by construction rather than by a prior read: the UPDATE itself
 * carries `hold_expires_at < target`, so a second call matches no row and
 * the audit write is skipped on its affected-row count. Two concurrent
 * `startPayment` calls therefore produce one extension and one audit row,
 * not two — and the status is re-checked in the same WHERE, so a booking
 * cancelled between the resolver's read and this write is not extended.
 *
 * It extends and audits; it does NOT touch `status`, `amount_paid_centavos`
 * or the `payments` table. Starting a payment is not recording one.
 */
async function extendHoldForPayment(
  booking: { id: number; ref: string; createdAt: Date; holdExpiresAt: Date },
  providerRef: string,
): Promise<void> {
  const target = new Date(booking.createdAt.getTime() + PAYMENT_HOLD_MINUTES * 60_000);

  await getDb().transaction(async (tx) => {
    const [result] = await tx
      .update(bookings)
      .set({ holdExpiresAt: target })
      .where(
        and(
          eq(bookings.id, booking.id),
          eq(bookings.status, 'pending_payment'),
          lt(bookings.holdExpiresAt, target),
        ),
      );
    if (result.affectedRows === 0) return;

    await writeAudit(tx, {
      // A guest, not staff and not a cron — the same actor `booking.held`
      // uses, and for the same reason: a guest is not a row in any table.
      actorType: 'customer',
      actorId: null,
      action: 'booking.hold_extended',
      entity: 'bookings',
      entityId: booking.id,
      // Identifiers and timestamps only. `providerRef` is the gateway's
      // checkout-session id, which is what an admin reconciles against —
      // never a key, never a signature, never a request body.
      data: {
        ref: booking.ref,
        reason: 'payment_started',
        previousHoldExpiresAt: booking.holdExpiresAt.toISOString(),
        holdExpiresAt: target.toISOString(),
        providerRef,
      },
    });
  });
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
    .query(async ({ input }): Promise<AvailabilityVerdict> => {
      try {
        const [tour] = await getDb()
          .select({ id: tours.id })
          .from(tours)
          .where(and(eq(tours.slug, input.tourSlug), eq(tours.isActive, true)));
        // A legitimate answer, not a failure — returned, never thrown.
        if (!tour) return { ok: false, reason: 'tour_unavailable' };

        /*
         * The booking window first, and WITHOUT the locks: it is a pure
         * function of the settings and the clock, so it needs no transaction
         * — and answering it here means the date picker greys a closed date
         * out rather than showing it as "fully booked". `createHold()`
         * re-checks it under the locks; this is the friendly early answer,
         * exactly as `validateCoupon()` is for coupons.
         */
        const window = bookableDateRange(await readSettingBlock('booking'), new Date());
        if (!isDateBookable(input.date, window)) {
          return { ok: false, reason: 'date_not_bookable' };
        }

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

  /**
   * Starts a gateway payment for a held booking and returns where to send
   * the guest. **It starts a payment; it never records one.** Nothing here
   * writes a `payments` row, moves `amount_paid_centavos` or changes
   * `status` — only a verified PayMongo webhook or an admin approval may
   * (CLAUDE.md DO NOT), and both already exist elsewhere.
   *
   * **The amount comes from the BOOKING, never from the request.** The
   * input is a ref and nothing else (`startPaymentInput` is `.strict()`),
   * and `amount_due_now` is read off the stored row: `total_centavos` for
   * `pay_mode = 'full'`, otherwise `depositCentavos()` from `@rg/shared`
   * applied to that same total and the frozen
   * `price_snapshot.depositPercent`. Both were settled at hold time and
   * neither is recomputed here. The deposit's rounding rule is NOT restated
   * in this file — `depositCentavos()` owns it, and a second copy of a
   * rounding rule is how the two copies come to disagree.
   *
   * PayMongo's amounts are already centavos and so are ours, so there is no
   * conversion anywhere on this path, and none is missing.
   *
   * **It refuses any booking that is not payable, before touching the
   * gateway.** A refusal that still reached PayMongo would have created a
   * payment intent someone can complete — against a slot that is gone. The
   * guard is therefore the first thing after the read, and the gateway call
   * is the last thing before the return.
   *
   * The success and cancel URLs are built from `bookingPagePath()` in
   * `@rg/shared` (owner Ruling 25), which is the same constant the client
   * mounts its booking-status route from — so the page a paying guest lands
   * on cannot drift away from the page that exists.
   *
   * No rate limit of its own: `createHold` is already capped at 5 per IP
   * per 15 minutes (Ruling 5), and this endpoint needs a ref that only a
   * successful hold can produce.
   */
  startPayment: publicProcedure
    .input(startPaymentInput)
    .mutation(async ({ input }): Promise<{ redirectUrl: string }> => {
      try {
        const [booking] = await getDb()
          .select({
            id: bookings.id,
            ref: bookings.ref,
            status: bookings.status,
            payMode: bookings.payMode,
            totalCentavos: bookings.totalCentavos,
            priceSnapshot: bookings.priceSnapshot,
            holdExpiresAt: bookings.holdExpiresAt,
            createdAt: bookings.createdAt,
            tourTitle: tours.title,
          })
          .from(bookings)
          .innerJoin(tours, eq(tours.id, bookings.tourId))
          .where(eq(bookings.ref, input.ref))
          .limit(1);

        // Generic on purpose: a ref is half a portal credential (§7), so
        // this must not tell a stranger whether a ref exists.
        if (!booking) {
          throw new TRPCError({ code: 'NOT_FOUND', message: 'We could not find that booking.' });
        }

        /*
         * Payable means `pending_payment` AND a hold that has not lapsed.
         *
         * The status half is the obvious one: a confirmed booking has
         * already been paid, and a cancelled or expired one has released
         * its capacity, so neither may be paid again.
         *
         * The hold half is the one that is easy to miss. The expiry sweep
         * is a cron, so a lapsed hold still reads `pending_payment` for up
         * to a minute — and `hold_expires_at` is null on every booking
         * with nothing left to expire (schema), which makes a non-null one
         * in the past a lapsed hold regardless of status. `recordPayment()`
         * already reasons exactly this way about late money; this refuses
         * on the same fact, one step earlier, so the race between the cron
         * and the guest never decides whether an intent gets created.
         */
        const holdExpiresAt = booking.holdExpiresAt;
        const payable =
          booking.status === 'pending_payment' &&
          holdExpiresAt !== null &&
          holdExpiresAt.getTime() > Date.now();
        if (!payable) {
          throw new TRPCError({
            code: 'CONFLICT',
            message:
              'This booking can no longer be paid online. ' +
              'Please start a new booking, or contact us if you have already paid.',
          });
        }

        const amountDueNowCentavos =
          booking.payMode === 'full'
            ? booking.totalCentavos
            : depositCentavos(booking.totalCentavos, booking.priceSnapshot.depositPercent);

        const successUrl = `${env.PUBLIC_BASE_URL}${bookingPagePath(booking.ref)}`;

        // Annotated rather than left to inference: an un-annotated `let`
        // is an evolving `any`, so a later reorder could lose every check
        // on `checkout.redirectUrl` / `checkout.providerRef` silently.
        let checkout: CreateCheckoutResult;
        try {
          // `getProvider` inside the try as well: an unregistered name is
          // the same guest-facing fact as an unreachable gateway.
          checkout = await getProvider('paymongo').createCheckout({
            bookingRef: booking.ref,
            amountCentavos: amountDueNowCentavos,
            // What PayMongo's own dashboard shows an admin reconciling.
            // The tour and the public ref — never a name, an email or a
            // phone number (RA 10173: the gateway gets what the payment
            // needs and nothing else).
            description: `${booking.tourTitle} — booking ${booking.ref}`,
            methods: CHECKOUT_PAYMENT_METHODS,
            successUrl,
            cancelUrl: `${successUrl}?cancelled=1`,
          });
        } catch (error) {
          throw gatewayUnavailable(error);
        }

        /*
         * The extension runs AFTER the gateway answered, deliberately: a
         * checkout that was never created is not a guest at a payment page,
         * and an audit row saying "hold extended, payment started" must not
         * exist for a redirect that never happened.
         */
        await extendHoldForPayment(
          {
            id: booking.id,
            ref: booking.ref,
            createdAt: booking.createdAt,
            holdExpiresAt,
          },
          checkout.providerRef,
        );

        // The redirect URL only. `providerRef` is the gateway's id and is
        // of no use to a browser; it belongs in the audit row.
        return { redirectUrl: checkout.redirectUrl };
      } catch (error) {
        throw translateStartPaymentError(error);
      }
    }),
});
