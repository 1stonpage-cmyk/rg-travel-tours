/**
 * The pricing service (Week 3 plan, Task 2) — the only place in the system
 * that computes a checkout price (CLAUDE.md: "The server computes all
 * money"). Split in two, deliberately:
 *
 *  - `priceQuote()` is pure arithmetic — a set of tiers, a head count,
 *    add-ons and a coupon in, a quote out. No database, no clock, no
 *    hashing, so it is exhaustively testable with no connection at all.
 *  - `loadQuoteInputs()` does the database reading that feeds it, and stays
 *    thin: it does not do arithmetic. It reads everything `priceQuote` needs
 *    EXCEPT `pax`, which is guest input, not a database fact — the caller
 *    (a later task's router) merges the two: `priceQuote({ ...inputs, pax })`.
 *
 * `quoteDigest()` (owner decision Q3) is the short-lived server-side quote id
 * that lets `createHold()` (Task 5) detect a price that changed between the
 * quote and the hold, by recomputing the same digest from the same inputs
 * and comparing. **One definition, called from both places** — the same
 * discipline that keeps `depositCentavos()` in one place rather than
 * restated at every call site.
 *
 * §5's formula, verbatim (plan Task 2):
 *
 *   tier            = tier where min_pax <= pax <= max_pax
 *   base            = tier.price_per_person_centavos * pax
 *   addons          = sum(per_person ? price_centavos * pax : price_centavos)
 *   subtotal        = base + addons
 *   discount        = coupon applied to subtotal (percent or fixed, capped at subtotal)
 *   total           = subtotal - discount
 *   deposit         = depositCentavos(total, deposit_percent)
 *   amount_due_now  = pay_in_full ? total : deposit
 *   balance         = total - amount_due_now
 *
 * Integer centavos throughout. No float ever touches money.
 */
import { createHash } from 'node:crypto';
import { and, eq, inArray } from 'drizzle-orm';
import { depositCentavos, type CouponDiscount } from '@rg/shared';
import { readSettingBlock } from '../content/settings';
import { getDb } from '../db/client';
import { coupons, tourAddons, tourPriceTiers, tours } from '../db/schema';

export interface PriceTier {
  id: number;
  minPax: number;
  maxPax: number;
  pricePerPersonCentavos: number;
}

export interface QuoteAddon {
  id: number;
  name: string;
  priceCentavos: number;
  perPerson: boolean;
}

/** A coupon as `priceQuote` consumes it — the shared discount union plus its identity. */
export type QuoteCoupon = { id: number; code: string } & CouponDiscount;

export interface PriceQuoteInput {
  tiers: PriceTier[];
  pax: number;
  addons?: QuoteAddon[];
  coupon?: QuoteCoupon | null;
  /** Whole percent, e.g. 30 for a 30% deposit (the `trust` setting, not per-tour). */
  depositPercent: number;
  /** The tour's `free_cancel_hours`. Not used in this arithmetic; carried on
   * the input only because every other quote input lives here too. */
  freeCancelHours: number | null;
}

export interface QuoteResult {
  tier: PriceTier;
  subtotalCentavos: number;
  discountCentavos: number;
  totalCentavos: number;
  depositCentavos: number;
  amountDueNowCentavos: { full: number; deposit: number };
  balanceCentavos: { full: number; deposit: number };
}

/** The tier whose [minPax, maxPax] covers `pax`. Throws rather than guessing. */
function selectTier(tiers: PriceTier[], pax: number): PriceTier {
  const tier = tiers.find((t) => t.minPax <= pax && pax <= t.maxPax);
  if (!tier) {
    throw new Error(`No price tier covers a head count of ${pax}`);
  }
  return tier;
}

/** Per-person add-ons multiply by pax; per-group add-ons count once. */
function addonsTotalCentavos(addons: QuoteAddon[], pax: number): number {
  return addons.reduce(
    (sum, addon) => sum + (addon.perPerson ? addon.priceCentavos * pax : addon.priceCentavos),
    0,
  );
}

/**
 * The discount a coupon takes off `subtotalCentavos`, never more than the
 * subtotal itself (`Math.min` — a discount must never make a total
 * negative) and, on the percent branch, rounded DOWN (`Math.floor` — a
 * discount never rounds up against the business).
 */
function discountCentavosFor(
  coupon: QuoteCoupon | null | undefined,
  subtotalCentavos: number,
): number {
  if (!coupon) return 0;
  const raw =
    coupon.discountType === 'percent'
      ? Math.floor((subtotalCentavos * coupon.percentBp) / 10000)
      : coupon.amountCentavos;
  return Math.min(raw, subtotalCentavos);
}

/**
 * The pure arithmetic. No database, no clock — every input is a plain value
 * the caller already has in hand (directly, or via `loadQuoteInputs`).
 */
export function priceQuote(input: PriceQuoteInput): QuoteResult {
  const { tiers, pax, addons = [], coupon = null, depositPercent } = input;

  const tier = selectTier(tiers, pax);
  const baseCentavos = tier.pricePerPersonCentavos * pax;
  const subtotalCentavos = baseCentavos + addonsTotalCentavos(addons, pax);
  const discountCentavos = discountCentavosFor(coupon, subtotalCentavos);
  const totalCentavos = subtotalCentavos - discountCentavos;
  const deposit = depositCentavos(totalCentavos, depositPercent);

  // amount_due_now = pay_in_full ? total : deposit; balance = total -
  // amount_due_now. Pay mode isn't known at quote time (the guest picks it
  // at checkout), so both branches are computed — `full`'s balance is
  // always 0, by definition.
  const amountDueNowCentavos = { full: totalCentavos, deposit };
  const balanceCentavos = {
    full: totalCentavos - amountDueNowCentavos.full,
    deposit: totalCentavos - amountDueNowCentavos.deposit,
  };

  return {
    tier,
    subtotalCentavos,
    discountCentavos,
    totalCentavos,
    depositCentavos: deposit,
    amountDueNowCentavos,
    balanceCentavos,
  };
}

// ---------------------------------------------------------------------------
// loadQuoteInputs — the database reading, kept thin and separate from the
// arithmetic above.
// ---------------------------------------------------------------------------

/** Everything `priceQuote` needs except `pax`, which is guest input, not a database fact. */
export interface QuoteInputs extends Omit<PriceQuoteInput, 'pax'> {
  tourId: number;
}

async function loadCoupon(couponCode: string): Promise<QuoteCoupon | null> {
  // Codes are compared case-insensitively — the brief's own fixtures
  // ('SAVE10', 'BIG') are uppercase, and quoteDigest() below applies the same
  // normalisation so a code's case can never desync a quote from its digest.
  const normalized = couponCode.trim().toUpperCase();
  const db = getDb();
  const [row] = await db
    .select({
      id: coupons.id,
      code: coupons.code,
      discountType: coupons.discountType,
      percentBp: coupons.percentBp,
      amountCentavos: coupons.amountCentavos,
    })
    .from(coupons)
    .where(and(eq(coupons.code, normalized), eq(coupons.isActive, true)));

  if (!row) return null;

  if (row.discountType === 'percent') {
    return {
      id: row.id,
      code: row.code,
      discountType: 'percent',
      percentBp: row.percentBp!,
      amountCentavos: null,
    };
  }
  return {
    id: row.id,
    code: row.code,
    discountType: 'fixed',
    percentBp: null,
    amountCentavos: row.amountCentavos!,
  };
}

/**
 * Reads everything `priceQuote` needs for a tour, except `pax`. Only ACTIVE
 * add-ons belonging to THIS tour count — an add-on id for another tour, or
 * an inactive one, is silently ignored rather than rejected, the same way a
 * stale link to a retired add-on should fail soft at checkout.
 *
 * `date` is accepted for symmetry with `quoteInput` (the caller already has
 * it on hand) but today's pricing has no date-dependent rule, so it is not
 * used here.
 */
export async function loadQuoteInputs(
  slug: string,
  date: string,
  addonIds: number[],
  couponCode: string | undefined,
): Promise<QuoteInputs> {
  void date;

  const db = getDb();
  const [tour] = await db
    .select({ id: tours.id, freeCancelHours: tours.freeCancelHours })
    .from(tours)
    .where(and(eq(tours.slug, slug), eq(tours.isActive, true)));
  if (!tour) {
    throw new Error(`No active tour found for slug "${slug}"`);
  }

  const [tierRows, addonRows, trust, coupon] = await Promise.all([
    db
      .select({
        id: tourPriceTiers.id,
        minPax: tourPriceTiers.minPax,
        maxPax: tourPriceTiers.maxPax,
        pricePerPersonCentavos: tourPriceTiers.pricePerPersonCentavos,
      })
      .from(tourPriceTiers)
      .where(eq(tourPriceTiers.tourId, tour.id)),
    addonIds.length === 0
      ? Promise.resolve([])
      : db
          .select({
            id: tourAddons.id,
            name: tourAddons.name,
            priceCentavos: tourAddons.priceCentavos,
            perPerson: tourAddons.perPerson,
          })
          .from(tourAddons)
          .where(
            and(
              eq(tourAddons.tourId, tour.id),
              eq(tourAddons.isActive, true),
              inArray(tourAddons.id, addonIds),
            ),
          ),
    readSettingBlock('trust'),
    couponCode ? loadCoupon(couponCode) : Promise.resolve(null),
  ]);

  return {
    tourId: tour.id,
    tiers: tierRows,
    addons: addonRows,
    coupon,
    depositPercent: trust.depositPercent,
    freeCancelHours: tour.freeCancelHours,
  };
}

// ---------------------------------------------------------------------------
// quoteDigest — owner decision Q3's short-lived server-side quote id.
// ---------------------------------------------------------------------------

export interface QuoteDigestInput {
  tourId: number;
  date: string;
  pax: number;
  addonIds: number[];
  couponCode?: string | null;
  totalCentavos: number;
}

/**
 * A short-lived, replay-resistant quote id: a quote names a price, and a
 * price must not be honoured at hold time if an admin edited the tier in
 * between. `createHold()` (Task 5) recomputes this from the SAME inputs it
 * reads from the database and refuses the hold if it doesn't match —
 * which only works if both call sites run the exact same function.
 *
 * `tourId`, never `tourSlug`: a slug can be edited without changing the
 * price, and an edited slug must not spuriously invalidate a live quote.
 *
 * Deduping and sorting `addonIds`, and trimming/uppercasing `couponCode`,
 * means argument order and incidental formatting (a client re-sending the
 * same ids in a different order, or a coupon typed in lowercase) can never
 * produce a different digest for what is, in substance, the same quote.
 */
export function quoteDigest(input: QuoteDigestInput): string {
  const ids = [...new Set(input.addonIds)].sort((a, b) => a - b).join(',');
  const code = (input.couponCode ?? '').trim().toUpperCase();
  const raw = `${input.tourId}|${input.date}|${input.pax}|${ids}|${code}|${input.totalCentavos}`;
  return createHash('sha256').update(raw).digest('hex').slice(0, 32);
}
