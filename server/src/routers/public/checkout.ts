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
 * **`bookingStatus` (Task 9) is this rule's other half: the redirect page's
 * own query.** §6: "The success redirect page only reads status (polls until
 * the webhook lands). It never confirms anything itself." It is a plain
 * `publicProcedure.query`, it writes nothing, and the enumeration test above
 * is what makes "nothing here can confirm a booking" a checked fact rather
 * than a hope — adding a mutation to answer a question this query already
 * answers would be the easiest way to break it by accident.
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
import { and, eq, lt, sql } from 'drizzle-orm';
import { z } from 'zod';
import {
  bookableDateRange,
  bookingLookupInput,
  bookingPagePath,
  bookingRefSchema,
  createHoldInput,
  DATE_BLOCKED,
  DATE_NOT_BOOKABLE,
  depositCentavos,
  formatPeso,
  gatewayMinimumMessage,
  isDateBookable,
  manilaCivilDate,
  PAYMENT_HOLD_MINUTES,
  PAYMONGO_MIN_CENTAVOS,
  quoteInput,
  type BookingStatus,
  type PayMode,
  type QuoteResult,
} from '@rg/shared';
import { readSettingBlock } from '../../content/settings';
import { getDb } from '../../db/client';
import { bookings, tourBlockedDates, tours } from '../../db/schema';
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
  GatewayMinimumNotMetError,
  HoldContentionError,
  HoldLimitReachedError,
  PriceChangedError,
  TourDateBlockedError,
  TourDateNotBookableError,
  TourDatePastError,
} from '../../services/create-hold';
import { findBookingByCredentials } from '../../services/portal-auth';
import { loadQuoteInputs, priceQuote, quoteDigest } from '../../services/pricing';
import { publicProcedure, router } from '../../trpc';

/**
 * What `checkout.availability` answers with: every capacity reason, plus the
 * booking window's own (owner decision 2026-10-13, pending R&G) and the
 * blocked date's (final whole-branch review, F4).
 *
 * `date_not_bookable` and `date_blocked` are deliberately NOT members of
 * `CapacityRefusalReason`: `assessCapacity()` has no clock and no notion of
 * an admin closing a day, and must not grow either, so both are evaluated
 * here and in `createHold()`, never inside the capacity service. Keeping the
 * vocabularies separate is what stops a later reader assuming capacity
 * decides them. Both live in `@rg/shared` as single-definition wire
 * constants so the client's copy cannot drift from the server's reason.
 */
export type AvailabilityVerdict =
  CapacityVerdict | { ok: false; reason: typeof DATE_NOT_BOOKABLE | typeof DATE_BLOCKED };

/**
 * `checkout.availability`'s own input — a date and a head count against one
 * tour, nothing money-shaped. Not reused from `quoteInput` (which also
 * carries `addonIds`/`couponCode`, irrelevant to a capacity check): a
 * narrower, router-local `.strict()` shape is simpler than picking fields
 * off a schema built for a different consumer.
 */
/*
 * The message matches `civilDateSchema`'s in `@rg/shared` (task A4) — the
 * same guest-facing sentence, because this is the same fact about the same
 * field. The two definitions are deliberately independent (see above), so
 * the wording has to be kept in step by hand; the pattern is identical.
 */
const civilDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Enter a valid date.');
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
 * `checkout.bookingStatus`'s own input (Task 9) — a ref and nothing else,
 * for the same reason `startPaymentInput` above is `.strict()`: this is the
 * page a guest lands on after paying, and it must not be possible to ask it
 * to confirm, discount or otherwise decide anything by sending it extra
 * fields. There is nothing to ignore here, either — a ref is the entire
 * question.
 */
const bookingStatusInput = z.object({ ref: bookingRefSchema }).strict();

/**
 * The one "we could not find that booking" refusal, shared by every
 * procedure here that looks a booking up by ref alone (`startPayment`,
 * `bookingStatus`). A ref is half a portal credential (§7) — a stranger who
 * guesses one must get back exactly the same sentence a stranger who typos
 * one does, so this is written once rather than retyped per call site,
 * which would otherwise invite the two copies to quietly drift apart.
 */
function bookingNotFound(): TRPCError {
  return new TRPCError({ code: 'NOT_FOUND', message: 'We could not find that booking.' });
}

/**
 * What `checkout.bookingStatus` answers with (Task 9) — status, amounts and
 * a one-line tour summary, and nothing a guest could use to confirm, pay,
 * cancel or alter the booking: there is no field here the page could feed
 * back into another endpoint to do any of those things.
 *
 * `balanceCentavos` is the one subtraction in this file that is not a typed
 * service's own output: `total - paid`, same formula the `bookings` table's
 * own module note names as deliberately NOT a stored column ("if a query
 * wants it, the query subtracts"). This is that query, run here because
 * CLAUDE.md's "the server computes all money" rule is about who may be
 * TRUSTED to produce a money figure — never about the server being allowed
 * to subtract two of its own already-trusted numbers before replying. The
 * client-side ban on `*Centavos` arithmetic (`checkout-page.test.tsx`'s
 * repo-wide scan) is scoped to `client/` for exactly this reason: nothing
 * under `client/` may compute money, and this file is not under `client/`.
 */
type BookingStatusResult = {
  ref: string;
  status: BookingStatus;
  tourTitle: string;
  /** Civil date (Asia/Manila), e.g. `'2026-12-25'` — see `bookings.tourDate`. */
  date: string;
  pax: number;
  payMode: PayMode;
  totalCentavos: number;
  /**
   * `bookings.amount_paid_centavos`, read-only, renamed on the wire to
   * `paidCentavos`. Not a cosmetic choice: `schema-conventions.test.ts`'s
   * A5b guard greps the whole server tree for the literal text
   * `amountPaidCentavos:` to prove only `record-payment.ts` ever WRITES
   * that column, and its regex cannot tell a `.select()` alias or a
   * returned-object key apart from a `.set()` — a plain READ spelled with
   * the DB column's own camelCase name would false-positive as a second
   * writer. Renaming the field this file hands back is cheaper and more
   * honest than teaching that guard to parse call expressions, and it costs
   * nothing: this type is this procedure's own wire shape, not reused
   * anywhere `amountPaidCentavos` is already the public contract.
   */
  paidCentavos: number;
  balanceCentavos: number;
  /** owner decision 2026-10-11, task 16b-3 — see `bookings.paymentReviewRequired`. */
  paymentReviewRequired: boolean;
};

/**
 * What `checkout.bookingLookup` (Task 10) answers with — §7's guest
 * self-service lookup, authenticated by ref + email together rather than a
 * ref alone. Deliberately the same KIND of read as `BookingStatusResult`
 * above (status, amounts, a one-line tour summary), with one difference:
 * no `balanceCentavos`. Omitting it here is an implementer's choice,
 * narrower than strictly required — not a spec-forbidden field — so unlike
 * `bookingStatus`'s one justified subtraction (`total - paid`, see its own
 * note), this resolver only ever hands back figures the database already
 * carries. If a future screen built on this lookup genuinely needs a
 * balance, the SERVER computes it here the same way `bookingStatus` does —
 * never the client (CLAUDE.md: "If the UI needs a balance, the SERVER
 * provides it").
 */
type BookingLookupResult = {
  ref: string;
  status: BookingStatus;
  tourTitle: string;
  date: string;
  pax: number;
  payMode: PayMode;
  totalCentavos: number;
  paidCentavos: number;
  paymentReviewRequired: boolean;
};

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
  /*
   * BUG-110. The refusal carries the amount and the pay mode; the guest gets
   * neither — only the shared sentence, which names whatever way round the
   * floor actually exists for THIS booking: the total on the error is what
   * decides that (fix round 1), and `gatewayMinimumMessage()` owns the choice
   * so this surface and `startPayment` cannot answer differently.
   * `BAD_REQUEST`, not `CONFLICT`: nothing has changed under the guest and
   * retrying the same request will refuse again.
   */
  if (error instanceof GatewayMinimumNotMetError) {
    return new TRPCError({
      code: 'BAD_REQUEST',
      message: gatewayMinimumMessage(error.totalCentavos),
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
 *
 * **Unstated dependency, now stated.** The "at most once" guarantee above
 * is only as exact as `target`, and `target` is `created_at + 30 minutes`
 * recomputed fresh on every call — so it is only reproducible bit-for-bit
 * across calls if `created_at` itself round-trips through MySQL
 * losslessly. That holds today because both `bookings.created_at`
 * (`server/src/db/schema.ts:951`) and `bookings.hold_expires_at`
 * (`:916`) are a bare `datetime`: no fractional-seconds field, so MySQL
 * stores and returns whole seconds only, and the exact same whole-second
 * value comes back on every read. A future migration to `datetime(3)` on
 * either column would let a sub-second component survive on one side of
 * the `<` comparison below but get rounded away on the other (the write
 * path and the read path do not round fractional seconds the same way),
 * so `holdExpiresAt < target` could stay true forever — every
 * `startPayment` call on the same booking extending the hold again,
 * instead of the second call matching no row as this function's own name
 * promises. Nothing here enforces that dependency; it is just documented
 * so the next person reaching for more precision on these two columns
 * reads this first.
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
         * §5 step 1's date guards, in `createHold()`'s own order (its step
         * 2): blocked first, then the booking window. **The order is the
         * point.** Both surfaces answer the same question, and the
         * precedence is what makes them give the same REASON for it — a
         * blocked date that is also outside the window is "this tour isn't
         * running that day" on both, never one sentence here and a
         * different one on submit. `createHold()`'s past-date guard has no
         * counterpart here because it needs none: `earliest` is never
         * before today, so a past date already answers
         * `date_not_bookable`.
         *
         * **Both reads are outside the locks, and that is safe HERE and
         * only here.** `availability` is a plain advisory query; it reserves
         * nothing and `createHold()` re-checks every one of these under its
         * own locks before it writes. Inside that transaction the same two
         * reads would be subject to `services/capacity.ts`'s PRECONDITION —
         * a non-locking read before `takeSlotLocks()` pins the REPEATABLE
         * READ snapshot and the capacity counts are then answered from
         * before the race's winner committed. There is no snapshot to
         * poison in a query that holds no locks and writes nothing.
         *
         * Final whole-branch review, F4: the blocked-date read used to live
         * ONLY in `createHold()`, so this procedure answered `{ ok: true }`
         * for a blocked date and the guest was refused only at submit.
         */
        const [blocked] = await getDb()
          .select({ id: tourBlockedDates.id })
          .from(tourBlockedDates)
          // The date is compared as a STRING through raw SQL, the same way
          // `capacity.ts` and `create-hold.ts` do it: Drizzle maps a `date`
          // column to a `Date`, and a `Date` is the midnight-shift hazard a
          // civil date must avoid.
          .where(
            and(
              eq(tourBlockedDates.tourId, tour.id),
              sql`${tourBlockedDates.date} = ${input.date}`,
            ),
          )
          .limit(1);
        if (blocked) return { ok: false, reason: DATE_BLOCKED };

        /*
         * The booking window, WITHOUT the locks for the same reason: it is a
         * pure function of the settings and the clock, so it needs no
         * transaction — and answering it here means the date picker greys a
         * closed date out rather than showing it as "fully booked".
         * `createHold()` re-checks it under the locks; this is the friendly
         * early answer, exactly as `validateCoupon()` is for coupons.
         */
        const window = bookableDateRange(await readSettingBlock('booking'), new Date());
        if (!isDateBookable(input.date, window)) {
          return { ok: false, reason: DATE_NOT_BOOKABLE };
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
   * is the last thing before the return. The amount gets the same treatment:
   * a charge under `PAYMONGO_MIN_CENTAVOS` is refused here (BUG-110), as the
   * defensive mirror of `createHold()`'s own check.
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
        // this must not tell a stranger whether a ref exists. Shared with
        // `bookingStatus` below so the two can never say something different
        // for the same fact.
        if (!booking) throw bookingNotFound();

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

        /*
         * The gateway's own floor, checked DEFENSIVELY (BUG-110, owner
         * decision 2026-10-23 Q10). `createHold()` already refuses this shape
         * before it writes anything, so a booking reaching here below the
         * floor means some other path produced the hold — and the gateway is
         * exactly where that would otherwise surface, as PayMongo's own
         * "amount must be at least 10000" turned into this router's generic
         * `SERVICE_UNAVAILABLE`: a guest told to try again shortly about a
         * booking that will never go through. One sentence, one constant,
         * both surfaces, and no payment intent created. The sentence is chosen
         * from the booking's own total by the same shared chooser the hold
         * refusal uses, so a booking whose total is itself under the floor is
         * not told to "pay in full instead" here either.
         */
        if (amountDueNowCentavos < PAYMONGO_MIN_CENTAVOS) {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: gatewayMinimumMessage(booking.totalCentavos),
          });
        }

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

  /**
   * The booking-status / payment-redirect page's own read (Task 9). This is
   * the WHOLE resolver, on purpose: validate the input (`.input()`), read
   * one row, translate "no row" into the shared generic refusal, and hand
   * back a plain object. No write of any kind is reachable from here — see
   * the enumeration test (`exposes no mutation that could confirm a
   * booking`) and §6's own rule this procedure exists to satisfy: "The
   * success redirect page only reads status ... It never confirms anything
   * itself."
   *
   * `startPayment`'s `success_url` / `cancel_url` point at the page that
   * calls this procedure, both built from `bookingPagePath()` (Ruling 25) —
   * so whatever ref a guest is redirected back with is exactly the ref this
   * resolves.
   */
  bookingStatus: publicProcedure
    .input(bookingStatusInput)
    .query(async ({ input }): Promise<BookingStatusResult> => {
      try {
        const [booking] = await getDb()
          .select({
            ref: bookings.ref,
            status: bookings.status,
            payMode: bookings.payMode,
            tourDate: bookings.tourDate,
            pax: bookings.pax,
            totalCentavos: bookings.totalCentavos,
            // Aliased to `paidCentavos` here, not the column's own
            // camelCase name — see `BookingStatusResult.paidCentavos`'s own
            // note on why.
            paidCentavos: bookings.amountPaidCentavos,
            paymentReviewRequired: bookings.paymentReviewRequired,
            tourTitle: tours.title,
          })
          .from(bookings)
          .innerJoin(tours, eq(tours.id, bookings.tourId))
          .where(eq(bookings.ref, input.ref))
          .limit(1);

        // Same generic refusal `startPayment` uses for the same fact — see
        // `bookingNotFound()`'s own note on why the two must agree.
        if (!booking) throw bookingNotFound();

        return {
          ref: booking.ref,
          status: booking.status,
          tourTitle: booking.tourTitle,
          // `bookings.tour_date` reads back as a `Date` at UTC midnight of
          // the civil date (`create-hold.ts`'s own note: the pool runs at
          // `timezone: 'Z'`, so this stores the day the guest picked, in
          // Cebu, exactly) — `manilaCivilDate()` is the one conversion back
          // to the wire's civil-date string, not a hand-rolled
          // `toISOString().slice(0, 10)` that would happen to agree with it
          // only because the offset is positive.
          date: manilaCivilDate(booking.tourDate),
          pax: booking.pax,
          payMode: booking.payMode,
          totalCentavos: booking.totalCentavos,
          paidCentavos: booking.paidCentavos,
          // `total - paid`, computed here rather than stored — see
          // `BookingStatusResult`'s own note.
          balanceCentavos: booking.totalCentavos - booking.paidCentavos,
          paymentReviewRequired: booking.paymentReviewRequired,
        };
      } catch (error) {
        if (error instanceof TRPCError) throw error;
        throw internalError(error);
      }
    }),

  /**
   * §7's guest self-service lookup (Task 10): ref + email, together,
   * case-insensitive on the email half. Rate-limited to 5 FAILED attempts
   * per IP per 15 minutes — `createBookingLookupLimiter()`
   * (`middleware/rate-limit.ts`), mounted in `app.ts` — with
   * `skipSuccessfulRequests` so a guest who keeps re-checking their own real
   * booking is never locked out of reading it.
   *
   * **The one rule this resolver exists to enforce: a wrong ref and a wrong
   * email must be indistinguishable.** A lookup that answered "no such
   * booking" for one and "wrong email" for the other would turn this
   * endpoint into a ref oracle — a stranger could enumerate real refs
   * without ever knowing an email. So there is exactly ONE throw site below,
   * `bookingNotFound()` — the same shared refusal `startPayment` and
   * `bookingStatus` already use for the same reason — reached whether the
   * ref does not exist at all or the ref exists but the email on file does
   * not match it. Nothing before that throw can observe, by branch taken or
   * message produced, which half failed: the email comparison only runs
   * once a row is already in hand, and both outcomes (`!booking` and a row
   * whose email does not match) feed the identical `throw bookingNotFound()`
   * on the identical line.
   *
   * Query, not mutation (Ruling 8) — this reads and changes nothing, and
   * the enumeration test on this router (`exposes no mutation that could
   * confirm a booking`) would fail the moment this became one.
   */
  bookingLookup: publicProcedure
    .input(bookingLookupInput)
    .query(async ({ input }): Promise<BookingLookupResult> => {
      try {
        /*
         * The credential check is `services/portal-auth.ts`'s (Week 4, Task
         * 2), shared with `portal.login`: the same ref + email pair against
         * the same booking must not be two different checks that have to
         * agree forever. It answers an id or null and cannot report WHICH
         * half was wrong, so the §7 "same error for both" guarantee no
         * longer depends on this resolver remembering it.
         *
         * A consequence worth naming: `lead_email` is no longer loaded here
         * at all, so the old warning comment about a field that must never
         * be returned is gone with it.
         */
        const match = await findBookingByCredentials(input.ref, input.email);
        if (!match) throw bookingNotFound();

        const [booking] = await getDb()
          .select({
            ref: bookings.ref,
            status: bookings.status,
            payMode: bookings.payMode,
            tourDate: bookings.tourDate,
            pax: bookings.pax,
            totalCentavos: bookings.totalCentavos,
            paidCentavos: bookings.amountPaidCentavos,
            paymentReviewRequired: bookings.paymentReviewRequired,
            tourTitle: tours.title,
          })
          .from(bookings)
          .innerJoin(tours, eq(tours.id, bookings.tourId))
          .where(eq(bookings.id, match.id))
          .limit(1);

        if (!booking) throw bookingNotFound();

        return {
          ref: booking.ref,
          status: booking.status,
          tourTitle: booking.tourTitle,
          date: manilaCivilDate(booking.tourDate),
          pax: booking.pax,
          payMode: booking.payMode,
          totalCentavos: booking.totalCentavos,
          paidCentavos: booking.paidCentavos,
          paymentReviewRequired: booking.paymentReviewRequired,
        };
      } catch (error) {
        if (error instanceof TRPCError) throw error;
        throw internalError(error);
      }
    }),
});
