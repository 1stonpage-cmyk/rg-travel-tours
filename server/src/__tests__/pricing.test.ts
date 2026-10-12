/**
 * Week 3 plan, Task 2: the pricing service — the only place in the system
 * that computes a checkout price.
 *
 * Three groups, mirroring `services/pricing.ts`'s three exports:
 *
 *  1. `priceQuote` — the brief's test block, used VERBATIM (every number in
 *     it is hand-verified and encodes §5's formula). Pure; no database.
 *  2. `quoteDigest` — owner decision Q3's short-lived server-side quote id.
 *     Pure; no database.
 *  3. `loadQuoteInputs` — the database reading. Needs a real connection
 *     (`describeWithDb`), so it is skipped if MySQL is unreachable.
 */
import { createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getDb } from '../db/client';
import { coupons, destinations, tourAddons, tourPriceTiers, tours } from '../db/schema';
import { loadQuoteInputs, priceQuote, quoteDigest } from '../services/pricing';
import { describeWithDb } from './helpers/db';

// ---------------------------------------------------------------------------
// 1. priceQuote — the brief's Step 1 test block, verbatim.
// ---------------------------------------------------------------------------

const TIERS = [
  { id: 1, minPax: 1, maxPax: 3, pricePerPersonCentavos: 250000 },
  { id: 2, minPax: 4, maxPax: 6, pricePerPersonCentavos: 189000 },
];
const base = { tiers: TIERS, addons: [], coupon: null, depositPercent: 30, freeCancelHours: 24 };

describe('priceQuote', () => {
  it('picks the tier the head count falls in, not the cheapest', () => {
    expect(priceQuote({ ...base, pax: 2 }).tier.id).toBe(1);
    expect(priceQuote({ ...base, pax: 4 }).tier.id).toBe(2);
  });

  it('REFUSES a head count no tier covers rather than guessing', () => {
    expect(() => priceQuote({ ...base, pax: 11 })).toThrow(/no price tier/i);
  });

  it('multiplies a per-person add-on by pax and a per-group add-on once', () => {
    const addons = [
      { id: 1, name: 'Lunch', priceCentavos: 35000, perPerson: true },
      { id: 2, name: 'Drone video', priceCentavos: 150000, perPerson: false },
    ];
    const q = priceQuote({ ...base, pax: 4, addons });
    // base 189000*4 = 756000; lunch 35000*4 = 140000; drone 150000
    expect(q.subtotalCentavos).toBe(756000 + 140000 + 150000);
  });

  it('applies a percent coupon in basis points', () => {
    const q = priceQuote({
      ...base,
      pax: 4,
      coupon: {
        id: 7,
        code: 'SAVE10',
        discountType: 'percent',
        percentBp: 1000,
        amountCentavos: null,
      },
    });
    expect(q.subtotalCentavos).toBe(756000);
    expect(q.discountCentavos).toBe(75600); // 10.00%
    expect(q.totalCentavos).toBe(680400);
  });

  it('caps a fixed coupon at the subtotal — a discount never makes a total negative', () => {
    const q = priceQuote({
      ...base,
      pax: 1,
      coupon: {
        id: 8,
        code: 'BIG',
        discountType: 'fixed',
        percentBp: null,
        amountCentavos: 99_999_900,
      },
    });
    expect(q.discountCentavos).toBe(250000);
    expect(q.totalCentavos).toBe(0);
  });

  it('rounds the deposit UP to a whole peso via the shared helper', () => {
    // 189000*4 = 756000; 30% of 756000 = 226800 = ₱2,268.00, already a whole
    // peso, so the ceil is a no-op here (confirmed against the pinned
    // whole-peso case in shared/src/__tests__/money.test.ts:
    // depositCentavos(189_000, 30) === 56_700).
    const q = priceQuote({ ...base, pax: 4 });
    expect(q.depositCentavos).toBe(226800);
  });

  it('actually ceils a non-whole-peso deposit up, not just leaving a whole one unchanged', () => {
    // 756000 * 33% = 249480 = ₱2,494.80 -> ceils UP to ₱2,495.00 = 249500.
    // Unlike the 226800 case above, this one is red under Math.floor/round
    // and only green under ceil — the asymmetry that proves the helper is
    // actually rounding up, not merely being asserted against a number that
    // happens to need no rounding.
    const q = priceQuote({ ...base, pax: 4, depositPercent: 33 });
    expect(q.depositCentavos).toBe(249500);
  });

  it('amount due now is the total in full mode and the deposit otherwise', () => {
    const q = priceQuote({ ...base, pax: 4 });
    expect(q.amountDueNowCentavos.full).toBe(q.totalCentavos);
    expect(q.amountDueNowCentavos.deposit).toBe(q.depositCentavos);
    expect(q.balanceCentavos.deposit).toBe(q.totalCentavos - q.depositCentavos);
  });

  it('returns only integers — no float ever touches money', () => {
    const q = priceQuote({
      ...base,
      pax: 4,
      coupon: { id: 9, code: 'ODD', discountType: 'percent', percentBp: 333, amountCentavos: null },
    });
    for (const v of [q.subtotalCentavos, q.discountCentavos, q.totalCentavos, q.depositCentavos]) {
      expect(Number.isInteger(v), `${v} is not an integer`).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// 2. quoteDigest — owner decision Q3. Pure; no database.
// ---------------------------------------------------------------------------

describe('quoteDigest', () => {
  const digestBase = {
    tourId: 5,
    date: '2026-11-01',
    pax: 4,
    addonIds: [2, 1],
    couponCode: 'save10',
    totalCentavos: 680400,
  };

  it('gives the same digest for the same inputs', () => {
    expect(quoteDigest(digestBase)).toBe(quoteDigest({ ...digestBase }));
  });

  it('is unaffected by add-on id order or duplicates', () => {
    const inOrder = quoteDigest({ ...digestBase, addonIds: [1, 2] });
    const reorderedWithDupes = quoteDigest({ ...digestBase, addonIds: [2, 1, 1, 2] });
    expect(reorderedWithDupes).toBe(inOrder);
  });

  it('is unaffected by coupon-code case and surrounding whitespace', () => {
    const lower = quoteDigest({ ...digestBase, couponCode: 'save10' });
    const upperPadded = quoteDigest({ ...digestBase, couponCode: '  SAVE10  ' });
    expect(upperPadded).toBe(lower);
  });

  it('treats no coupon the same as an empty code', () => {
    const noCoupon = quoteDigest({ ...digestBase, couponCode: undefined });
    const emptyCode = quoteDigest({ ...digestBase, couponCode: '' });
    expect(emptyCode).toBe(noCoupon);
  });

  it('changes when the total changes', () => {
    const original = quoteDigest(digestBase);
    const differentTotal = quoteDigest({
      ...digestBase,
      totalCentavos: digestBase.totalCentavos + 1,
    });
    expect(differentTotal).not.toBe(original);
  });

  it('matches the 32-hex-char shape createHoldInput.quoteId requires', () => {
    expect(quoteDigest(digestBase)).toMatch(/^[0-9a-f]{32}$/);
  });

  it('builds the digest from the exact pipe-delimited string — deduped, sorted ids and an uppercased, trimmed code', () => {
    const expected = createHash('sha256')
      .update('5|2026-11-01|4|1,2|SAVE10|680400')
      .digest('hex')
      .slice(0, 32);
    expect(quoteDigest(digestBase)).toBe(expected);
  });
});

// ---------------------------------------------------------------------------
// 3. loadQuoteInputs — the database reading. Needs a real connection.
// ---------------------------------------------------------------------------

describeWithDb('loadQuoteInputs', () => {
  // Fixtures created for this suite and removed after it, unrelated to the
  // seeded catalog — same pattern as ratings.test.ts's fixture suite.
  const unique = `__pricing__${Date.now() % 1e9}`;
  let destinationId = 0;
  let tourId = 0; // active, the tour under test
  let otherTourId = 0; // active, owns the "foreign" add-on
  let inactiveTourId = 0;
  let activeAddonId = 0;
  let inactiveAddonId = 0;
  let foreignAddonId = 0;
  let activeCouponId = 0;

  beforeAll(async () => {
    const db = getDb();
    const [destination] = await db
      .insert(destinations)
      .values({ name: unique, slug: unique, isActive: false });
    destinationId = destination.insertId;

    const [tour] = await db.insert(tours).values({
      slug: `${unique}-tour`,
      title: unique,
      destinationId,
      freeCancelHours: 24,
      isActive: true,
    });
    tourId = tour.insertId;

    const [otherTour] = await db.insert(tours).values({
      slug: `${unique}-other-tour`,
      title: `${unique}-other`,
      destinationId,
      isActive: true,
    });
    otherTourId = otherTour.insertId;

    const [inactiveTour] = await db.insert(tours).values({
      slug: `${unique}-inactive-tour`,
      title: `${unique}-inactive`,
      destinationId,
      isActive: false,
    });
    inactiveTourId = inactiveTour.insertId;

    await db.insert(tourPriceTiers).values([
      { tourId, minPax: 1, maxPax: 3, pricePerPersonCentavos: 250000 },
      { tourId, minPax: 4, maxPax: 6, pricePerPersonCentavos: 189000 },
    ]);

    const [activeAddon] = await db
      .insert(tourAddons)
      .values({ tourId, name: 'Lunch', priceCentavos: 35000, perPerson: true, isActive: true });
    activeAddonId = activeAddon.insertId;

    const [inactiveAddon] = await db.insert(tourAddons).values({
      tourId,
      name: 'Retired add-on',
      priceCentavos: 1000,
      perPerson: true,
      isActive: false,
    });
    inactiveAddonId = inactiveAddon.insertId;

    const [foreignAddon] = await db.insert(tourAddons).values({
      tourId: otherTourId,
      name: "Another tour's add-on",
      priceCentavos: 1000,
      perPerson: true,
      isActive: true,
    });
    foreignAddonId = foreignAddon.insertId;

    const [activeCoupon] = await db.insert(coupons).values({
      code: `${unique.toUpperCase()}-10`,
      discountType: 'percent',
      percentBp: 500,
      isActive: true,
    });
    activeCouponId = activeCoupon.insertId;

    await db.insert(coupons).values({
      code: `${unique.toUpperCase()}-DEAD`,
      discountType: 'fixed',
      amountCentavos: 10000,
      isActive: false,
    });
  });

  afterAll(async () => {
    const db = getDb();
    await db.delete(coupons).where(eq(coupons.id, activeCouponId));
    await db.delete(coupons).where(eq(coupons.code, `${unique.toUpperCase()}-DEAD`));
    await db.delete(tourAddons).where(eq(tourAddons.tourId, tourId));
    await db.delete(tourAddons).where(eq(tourAddons.tourId, otherTourId));
    await db.delete(tourPriceTiers).where(eq(tourPriceTiers.tourId, tourId));
    await db.delete(tours).where(eq(tours.id, tourId));
    await db.delete(tours).where(eq(tours.id, otherTourId));
    await db.delete(tours).where(eq(tours.id, inactiveTourId));
    await db.delete(destinations).where(eq(destinations.id, destinationId));
  });

  it("reads the tour's price tiers, its freeCancelHours, and the deposit-percent setting", async () => {
    const result = await loadQuoteInputs(`${unique}-tour`, '2026-11-01', [], undefined);
    expect(result.tourId).toBe(tourId);
    expect(result.freeCancelHours).toBe(24);
    expect(result.depositPercent).toBe(30); // seeded `trust.depositPercent`
    expect(result.tiers.map((t) => t.pricePerPersonCentavos).sort()).toEqual([189000, 250000]);
  });

  it("returns only the tour's own ACTIVE add-ons — an inactive id and another tour's id are ignored, not rejected", async () => {
    const result = await loadQuoteInputs(
      `${unique}-tour`,
      '2026-11-01',
      [activeAddonId, inactiveAddonId, foreignAddonId],
      undefined,
    );
    expect(result.addons).toEqual([
      { id: activeAddonId, name: 'Lunch', priceCentavos: 35000, perPerson: true },
    ]);
  });

  it('loads a coupon by code, case-insensitively and with surrounding whitespace trimmed', async () => {
    const code = `${unique.toUpperCase()}-10`;
    const result = await loadQuoteInputs(
      `${unique}-tour`,
      '2026-11-01',
      [],
      `  ${code.toLowerCase()}  `,
    );
    expect(result.coupon).toEqual({
      id: activeCouponId,
      code,
      discountType: 'percent',
      percentBp: 500,
      amountCentavos: null,
    });
  });

  it('returns a null coupon for an unknown or inactive code rather than throwing', async () => {
    const unknown = await loadQuoteInputs(`${unique}-tour`, '2026-11-01', [], 'NO-SUCH-CODE');
    expect(unknown.coupon).toBeNull();

    const inactive = await loadQuoteInputs(
      `${unique}-tour`,
      '2026-11-01',
      [],
      `${unique.toUpperCase()}-DEAD`,
    );
    expect(inactive.coupon).toBeNull();
  });

  it('throws for a slug with no ACTIVE tour (inactive or unknown)', async () => {
    await expect(
      loadQuoteInputs(`${unique}-inactive-tour`, '2026-11-01', [], undefined),
    ).rejects.toThrow();
    await expect(
      loadQuoteInputs(`${unique}-does-not-exist`, '2026-11-01', [], undefined),
    ).rejects.toThrow();
  });
});
