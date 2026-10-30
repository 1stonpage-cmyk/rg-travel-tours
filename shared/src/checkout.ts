/**
 * Shared checkout schemas (plan week 3, Task 1).
 *
 * Everything the browser may send during checkout is validated here, and
 * **nothing the browser sends is money** (CLAUDE.md): a quote request names
 * a tour, a date, a head count, add-on ids and an optional coupon code, and
 * never a price. `.strict()` on every object is load-bearing — an unknown
 * key (e.g. a client-supplied `totalCentavos`) is a rejection, not a
 * silently dropped field.
 *
 * `quoteResultSchema` (Task 2) lives at the bottom of this file: it is the
 * wire shape the pricing service's pure `priceQuote()` return value is
 * assembled into, plus the `quoteId` digest — `priceQuote()` itself stays in
 * `server/src/services/pricing.ts` and knows nothing about either this
 * schema or a quote id.
 */
import { z } from 'zod';
import { bookingRefSchema, PAY_MODES } from './booking';
import { formatPeso, PAYMONGO_MIN_CENTAVOS } from './money';

/** A civil date in Asia/Manila — the tour day, not an instant. */
export const civilDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected a YYYY-MM-DD date');

/**
 * A Philippine mobile number, in any of the forms a guest might type it.
 *
 * Owner decision 2026-10-12 (plan Q10, resolved): accepts `09XXXXXXXXX`
 * (11 digits) and `+639XXXXXXXXX`, with spaces or dashes stripped first —
 * the seed data's own numbers are formatted `0908 469 6246`, and a guest who
 * types their number the way they read it must not be rejected for it.
 * `.transform()` normalises every accepted form to `+639XXXXXXXXX`, which is
 * the stored form, so the schema's output is already canonical.
 *
 * Exported and reused by both checkout (`createHoldInput`) and booking
 * lookup, so the two cannot drift on what counts as a valid PH mobile
 * number.
 */
export const phPhoneSchema = z
  .string()
  .transform((value) => value.replace(/[\s-]/g, ''))
  .pipe(z.string().regex(/^(09\d{9}|\+639\d{9})$/, 'Expected a PH mobile number'))
  .transform((value) => (value.startsWith('+') ? value : `+63${value.slice(1)}`));

/**
 * What the browser may ask for. `.strict()` is load-bearing: the server
 * computes all money (CLAUDE.md), so a request carrying `totalCentavos` is a
 * bug or an attack, and either way it must be refused rather than ignored.
 */
export const quoteInput = z
  .object({
    tourSlug: z.string().min(1).max(160),
    date: civilDateSchema,
    pax: z.number().int().min(1).max(12),
    addonIds: z.array(z.number().int().positive()).max(20).default([]),
    couponCode: z.string().min(1).max(40).optional(),
  })
  .strict();
export type QuoteInput = z.infer<typeof quoteInput>;

export const createHoldInput = quoteInput
  .extend({
    payMode: z.enum(PAY_MODES),
    /**
     * Owner decision Q3: the short-lived server-side quote id (a truncated
     * SHA-256 digest, produced in Task 2) that the client echoes back here
     * so a price cannot be replayed after an admin edits a price tier.
     */
    quoteId: z.string().regex(/^[0-9a-f]{32}$/, 'Expected a 32-character lowercase hex quote id'),
    lead: z
      .object({
        name: z.string().min(1).max(160),
        email: z.email().max(200),
        phone: phPhoneSchema,
      })
      .strict(),
    pickup: z.string().max(400).optional(),
    pickupMapUrl: z.url().max(500).optional(),
    requests: z.string().max(2000).optional(),
    /** RA 10173. Anything but `true` fails here, before the router runs. */
    consent: z.boolean().refine((v) => v === true, { message: 'Consent is required' }),
  })
  .strict();
export type CreateHoldInput = z.infer<typeof createHoldInput>;

/**
 * BUG-108: used to be `z.string().min(1).max(12)` — any length, no case
 * rule — while `startPaymentInput` and `bookingStatusInput`
 * (`server/src/routers/public/checkout.ts`) took {@link bookingRefSchema},
 * an uppercase-only regex. A guest who typed `rg-7kq4m9` was refused by two
 * of the three procedures before the query ever ran, and accepted by the
 * third only because `bookings.ref`'s column collation happens to compare
 * case-insensitively — a fact nothing in the code asserted. All three now
 * share {@link bookingRefSchema}, which normalises (trim + uppercase)
 * before checking shape, so the three inputs cannot drift on what counts as
 * a valid ref again.
 */
export const bookingLookupInput = z
  .object({ ref: bookingRefSchema, email: z.email().max(200) })
  .strict();

/** The tier a quote resolved to, mirroring `server/src/services/pricing.ts`'s `PriceTier`. */
const quoteTierSchema = z.object({
  id: z.number().int().positive(),
  minPax: z.number().int().positive(),
  maxPax: z.number().int().positive(),
  pricePerPersonCentavos: z.number().int().nonnegative(),
});

/**
 * The wire shape of a quote (Task 2) — every money field `priceQuote()`
 * returns, plus `quoteId`: the short-lived server-side digest (owner
 * decision Q3, `quoteDigest()` in `server/src/services/pricing.ts`) that the
 * client echoes back in `createHoldInput.quoteId` so a price cannot be
 * replayed after an admin edits a price tier. The router (a later task)
 * assembles this from `priceQuote()` + `quoteDigest()`; `priceQuote()`
 * itself stays pure and never produces a `quoteId`.
 */
export const quoteResultSchema = z.object({
  tier: quoteTierSchema,
  subtotalCentavos: z.number().int().nonnegative(),
  discountCentavos: z.number().int().nonnegative(),
  totalCentavos: z.number().int().nonnegative(),
  depositCentavos: z.number().int().nonnegative(),
  amountDueNowCentavos: z.object({
    full: z.number().int().nonnegative(),
    deposit: z.number().int().nonnegative(),
  }),
  balanceCentavos: z.object({
    full: z.number().int().nonnegative(),
    deposit: z.number().int().nonnegative(),
  }),
  quoteId: z.string().regex(/^[0-9a-f]{32}$/, 'Expected a 32-character lowercase hex quote id'),
});
export type QuoteResult = z.infer<typeof quoteResultSchema>;

/**
 * The one spelling of the "that date is closed" refusal reason — a WIRE
 * contract (`checkout.availability` returns it to the browser, and
 * `server/src/services/create-hold.ts`'s `TourDateNotBookableError.reason`
 * carries the same value) with exactly ONE definition, here. It used to be
 * defined independently in `create-hold.ts` AND here — identical today, but
 * two definitions of one wire contract drift silently the moment either one
 * is edited, with nothing to catch it (a Task 8b review finding, fixed in
 * the same round: `create-hold.ts` now imports this rather than defining its
 * own). A repo-wide search for this declaration must turn up exactly one
 * place that exports it — this one.
 *
 * Not a member of the capacity service's own `CapacityRefusalReason`
 * vocabulary (`server/src/services/capacity.ts`): the booking window has no
 * connection to capacity, and keeping the two reason vocabularies separate
 * is what stops a future reader assuming capacity decides this (see that
 * router's own note on the point).
 */
export const DATE_NOT_BOOKABLE = 'date_not_bookable' as const;

/**
 * The one spelling of "the tour is not running that day" — `tour_blocked_dates`
 * (§5 step 1, second half). Same WIRE-contract-with-one-definition rule as
 * `DATE_NOT_BOOKABLE` above, and defined here for the same measured reason:
 * two independent definitions of one wire value are IDENTICAL to the
 * typechecker (both produce the same literal type), so the drift is
 * invisible until a guest sees the wrong sentence. This week fixed that
 * exact defect twice; this value starts out shared.
 *
 * Deliberately distinct from `DATE_NOT_BOOKABLE` and from every
 * `CapacityRefusalReason` (final whole-branch review, F4). All three are
 * "you cannot book that day", and all three deserve a different sentence:
 * "we're closed for online bookings on that date" (the window), "that day
 * is full" (capacity), "this tour isn't running that day" (an admin blocked
 * it — a fiesta, a closed island, a maintenance day). A blocked date is
 * never going to free up, so telling a guest it is "fully booked" invites
 * them to keep checking back.
 *
 * `createHold()`'s `TourDateBlockedError` is the authoritative refusal for
 * the same condition; `checkout.availability` returns this reason so both
 * surfaces answer the same question with the same reason, which is the whole
 * point of the precedence order they share.
 */
export const DATE_BLOCKED = 'date_blocked' as const;

/**
 * The sentence a guest sees when the amount an online payment would be for is
 * under {@link PAYMONGO_MIN_CENTAVOS} **and paying the whole total instead
 * would clear it** — BUG-110, owner decision 2026-10-23 (Q10). The original
 * and commonest case: a 30% deposit is under the floor on any tour priced
 * below ₱334, while the total itself is fine.
 *
 * Same WIRE-contract-with-one-definition rule as `DATE_NOT_BOOKABLE` and
 * `DATE_BLOCKED` above: two surfaces refuse this (`createHold`, through the
 * router's error translation, and `checkout.startPayment` defensively), and a
 * guest must not be told two different things about one fact. Both go through
 * {@link gatewayMinimumMessage} rather than picking a constant themselves.
 *
 * **It names the way out, in plain words, because here every way out exists.**
 * Pay-in-full really does go through, and the manual QR / bank-transfer flows
 * never touch a gateway, so the office can always take the money another way.
 * "Online payment failed" with no alternative would lose a booking this
 * business can actually fulfil.
 *
 * The amount is interpolated from the constant rather than typed, so the
 * sentence cannot come to disagree with the floor it describes. The wording
 * deliberately names no gateway, no provider and no internal unit: a guest
 * has nothing to do with PayMongo or with centavos.
 */
export const AMOUNT_BELOW_GATEWAY_MINIMUM =
  `Online payments must be at least ${formatPeso(PAYMONGO_MIN_CENTAVOS)}. ` +
  `Please pay in full instead of a deposit if that reaches ${formatPeso(PAYMONGO_MIN_CENTAVOS)}, ` +
  `or contact us to pay by bank transfer or QR code instead.`;

/**
 * The same refusal when the WHOLE TOTAL is under the floor too (fix round 1 of
 * BUG-110): a 90%-off coupon on a ₱900 tour leaves ₱90 to pay, and both pay
 * modes are then refused.
 *
 * So this sentence does **not** say "pay in full instead" — that is not an
 * alternative here, it is the same refusal again. The manual flows are the one
 * real way through, so they are stated as the answer rather than as the second
 * of two options.
 */
export const TOTAL_BELOW_GATEWAY_MINIMUM =
  `Online payments must be at least ${formatPeso(PAYMONGO_MIN_CENTAVOS)}, and this booking's ` +
  `total comes to less than that. Please contact us to pay by bank transfer or QR code instead.`;

/**
 * The same refusal when the total is **exactly nothing** — a 100%-off coupon,
 * or a fixed discount at or above the subtotal (`discountCentavosFor` clamps
 * it to the subtotal, so it lands on zero rather than going negative).
 *
 * Neither "pay in full" nor "pay by bank transfer" means anything here: there
 * is no amount, by any method. It names a floor no guest can act on either, so
 * it names none — only the one thing that can actually happen next, which is
 * the office confirming the booking by hand.
 *
 * **It is still a refusal.** Whether a fully discounted booking should be
 * allowed to confirm with no payment step at all is an open owner decision
 * (flagged in the Task 19 review); until it is taken, such a booking is
 * refused at hold time exactly as before and only the wording is honest about
 * why.
 */
export const NOTHING_TO_PAY_ONLINE =
  `This booking's total comes to ${formatPeso(0)}, so there's nothing to pay online. ` +
  `Please contact us directly to confirm it.`;

/**
 * Which of the three sentences above a guest gets, decided by the booking's
 * TOTAL — the only number that settles it.
 *
 * The total is what makes the difference between the three bands, because
 * `amount_due_now` for `full` IS the total (`services/pricing.ts`): a total at
 * or above the floor means pay-in-full is a genuine alternative to a short
 * deposit; a total below it means both modes are refused; a total of nothing
 * means there is no payment to redirect anywhere.
 *
 * One chooser, called by both refusing surfaces, so neither can offer a guest
 * an alternative that does not exist for them. `<= 0` rather than `=== 0` so a
 * number that should be impossible still gets the sentence that cannot be
 * wrong.
 */
export function gatewayMinimumMessage(totalCentavos: number): string {
  if (totalCentavos <= 0) return NOTHING_TO_PAY_ONLINE;
  if (totalCentavos < PAYMONGO_MIN_CENTAVOS) return TOTAL_BELOW_GATEWAY_MINIMUM;
  return AMOUNT_BELOW_GATEWAY_MINIMUM;
}
