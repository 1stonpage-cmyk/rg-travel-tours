/**
 * Transfers-launch plan, Task T9 — transfer pricing and the quote surface.
 *
 * Four groups, mirroring what the task built:
 *
 *  1. `quoteTransfer()` — the pure arithmetic. No database, no clock. The
 *     load-bearing property is that **no head count enters the formula**: a
 *     transfer is priced per VEHICLE, and the day someone "helpfully" adds a
 *     `pax` multiplication is the day a family of six is quoted six vans.
 *  2. `vehiclePriceForRouteAndType()` — the catalog read, including every way
 *     it must answer `null` rather than throw.
 *  3. `transferRoutes.list` — the public catalog: active routes only, both
 *     price cards, no admin-only field on the wire.
 *  4. `checkout.quoteTransfer` — the whole thing through the real router,
 *     including the ₱100 and ₱0 refusals, which must be byte-identical to the
 *     tour quote's (plan Global Constraints: "Existing ₱100 gateway minimum and
 *     ₱0-booking refusals apply unchanged").
 *
 * **Every assertion here is scoped to this file's own fixture ids.** Vitest
 * runs test files in parallel against one `rg_travel_test`, and
 * `transferRoutes.list` returns every active route in the database — an
 * assertion on the list's full length or absolute order would fail whenever
 * `admin-transfer-routes.test.ts` happens to hold a route open at the same
 * moment. Relative order among this file's own ids proves the ORDER BY just as
 * well and is not a race.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import {
  NOTHING_TO_PAY_ONLINE,
  PAYMONGO_MIN_CENTAVOS,
  TOTAL_BELOW_GATEWAY_MINIMUM,
  quoteTransferResultSchema,
} from '@rg/shared';
import { getDb } from '../db/client';
import { coupons, destinations, transferRouteVehiclePrices, transferRoutes } from '../db/schema';
import { appRouter } from '../routers/_app';
import {
  quoteTransfer,
  vehiclePriceForRouteAndType,
  type TransferQuoteInput,
} from '../services/transfers/pricing';
import { testContext } from './helpers/ctx';
import { describeWithDb } from './helpers/db';

// ---------------------------------------------------------------------------
// 1. quoteTransfer — pure. No database.
// ---------------------------------------------------------------------------

/** ₱2,500 for the vehicle, the seeded 30% deposit. */
const base = { priceCentavos: 250_000, coupon: null, depositPercent: 30 } as const;

describe('quoteTransfer', () => {
  it('takes the flat catalog rate as the subtotal and the total, with no coupon', () => {
    const q = quoteTransfer(base);
    expect(q.subtotalCentavos).toBe(250_000);
    expect(q.discountCentavos).toBe(0);
    expect(q.totalCentavos).toBe(250_000);
  });

  it('has NO pax parameter — a transfer is priced per vehicle, never per head', () => {
    /*
     * A compile-time guard, deliberately: `pnpm typecheck` goes red the moment
     * `TransferQuoteInput` grows a `pax` field, because `@ts-expect-error` on a
     * line that no longer errors is itself an error. A runtime assertion could
     * not catch this at all — a `pax` the function quietly multiplied by would
     * simply produce different numbers, and the only test that would notice is
     * one written before the change.
     */
    // @ts-expect-error — `pax` is not a member of TransferQuoteInput, and a day
    // when this line compiles cleanly is a day transfers price per person.
    const withPax: TransferQuoteInput = { ...base, pax: 6 };
    // The head count changes nothing, because nothing reads it.
    expect(quoteTransfer(withPax).totalCentavos).toBe(quoteTransfer(base).totalCentavos);
  });

  it('applies a percent coupon in basis points, rounding the discount DOWN', () => {
    const q = quoteTransfer({
      ...base,
      coupon: {
        id: 7,
        code: 'SAVE10',
        discountType: 'percent',
        percentBp: 1000,
        amountCentavos: null,
      },
    });
    expect(q.discountCentavos).toBe(25_000); // 10.00%
    expect(q.totalCentavos).toBe(225_000);
  });

  it('floors a percent discount rather than rounding it up against the business', () => {
    // 250020 * 333bp = 8325.666 centavos. Floor is 8325; ROUND would be 8326,
    // so this case is red under rounding and green only under the floor — the
    // asymmetry that proves the direction rather than asserting a number that
    // happens to need no rounding.
    const coupon = {
      id: 9,
      code: 'ODD',
      discountType: 'percent',
      percentBp: 333,
      amountCentavos: null,
    } as const;
    expect(quoteTransfer({ ...base, priceCentavos: 250_020, coupon }).discountCentavos).toBe(8325);
  });

  it('applies a fixed coupon as a flat centavo amount', () => {
    const q = quoteTransfer({
      ...base,
      coupon: {
        id: 8,
        code: 'FLAT',
        discountType: 'fixed',
        percentBp: null,
        amountCentavos: 50_000,
      },
    });
    expect(q.discountCentavos).toBe(50_000);
    expect(q.totalCentavos).toBe(200_000);
  });

  it('caps a coupon at the subtotal — a discount never makes a total negative', () => {
    const q = quoteTransfer({
      ...base,
      coupon: {
        id: 8,
        code: 'BIG',
        discountType: 'fixed',
        percentBp: null,
        amountCentavos: 99_999_900,
      },
    });
    expect(q.discountCentavos).toBe(250_000);
    expect(q.totalCentavos).toBe(0);
    expect(q.depositCentavos).toBe(0);
  });

  it('computes the deposit through the shared helper, which ceils to a whole peso', () => {
    // 250000 * 30% = 75000 = ₱750.00, already whole.
    expect(quoteTransfer(base).depositCentavos).toBe(75_000);
    // 250000 * 33% = 82500 = ₱825.00 — also whole, so pick a price that is not:
    // 250001 * 33% = 82500.33 -> 82501 centavos -> ceils UP to ₱826.00.
    // Red under floor/round, green only under ceil.
    expect(
      quoteTransfer({ ...base, priceCentavos: 250_001, depositPercent: 33 }).depositCentavos,
    ).toBe(82_600);
  });

  it('amount due now is the total in full mode and the deposit otherwise', () => {
    const q = quoteTransfer(base);
    expect(q.amountDueNowCentavos.full).toBe(q.totalCentavos);
    expect(q.amountDueNowCentavos.deposit).toBe(q.depositCentavos);
    expect(q.balanceCentavos.full).toBe(0);
    expect(q.balanceCentavos.deposit).toBe(q.totalCentavos - q.depositCentavos);
  });

  it('returns only integers — no float ever touches money', () => {
    const q = quoteTransfer({
      ...base,
      priceCentavos: 250_001,
      depositPercent: 33,
      coupon: { id: 9, code: 'ODD', discountType: 'percent', percentBp: 333, amountCentavos: null },
    });
    for (const v of [q.subtotalCentavos, q.discountCentavos, q.totalCentavos, q.depositCentavos]) {
      expect(Number.isInteger(v), `${v} is not an integer`).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Fixtures for groups 2-4. A real connection is required from here on.
// ---------------------------------------------------------------------------

const unique = () => `${Math.floor(Math.random() * 1e9)}_${Date.now()}`;

const PRICES = {
  van: { oneWayPriceCentavos: 250_000, dayUsePriceCentavos: 450_000 },
  suv: { oneWayPriceCentavos: 320_000, dayUsePriceCentavos: 560_000 },
} as const;

const created = {
  routeIds: [] as number[],
  destinationIds: [] as number[],
  couponIds: [] as number[],
};

/**
 * A destination and a route hanging off it, with whatever price rows the caller
 * asks for. Both ids are tracked for teardown; the route's slug and the
 * destination's name carry a per-run suffix so parallel suites cannot collide
 * on the `UNIQUE` columns.
 */
async function makeRoute(options: {
  /** Suffixed and lowercased — it decides the name tie-break in the list order. */
  nameSeed: string;
  sortOrder: number;
  routeActive?: boolean;
  destinationActive?: boolean;
  vehicles?: Array<'van' | 'suv'>;
  vanOneWayCentavos?: number;
}) {
  const db = getDb();
  const suffix = unique().replace('_', '-');
  const name = `__t9__${options.nameSeed}-${suffix}`;
  const [destination] = await db.insert(destinations).values({
    name,
    slug: name.replace(/_/g, 'x'),
    isActive: options.destinationActive ?? true,
  });
  created.destinationIds.push(destination.insertId);

  const [route] = await db.insert(transferRoutes).values({
    destinationId: destination.insertId,
    slug: `t9-${options.nameSeed}-${suffix}`,
    isActive: options.routeActive ?? true,
    sortOrder: options.sortOrder,
    estimatedDurationMinutes: 180,
    freeCancelHours: 24,
    inclusionsText: 'Fuel, driver, tolls',
    exclusionsText: 'Meals',
  });
  created.routeIds.push(route.insertId);

  for (const vehicleType of options.vehicles ?? (['van', 'suv'] as const)) {
    await db.insert(transferRouteVehiclePrices).values({
      routeId: route.insertId,
      vehicleType,
      oneWayPriceCentavos:
        vehicleType === 'van' && options.vanOneWayCentavos !== undefined
          ? options.vanOneWayCentavos
          : PRICES[vehicleType].oneWayPriceCentavos,
      dayUsePriceCentavos: PRICES[vehicleType].dayUsePriceCentavos,
    });
  }

  return { id: route.insertId, destinationName: name };
}

/** A percentage coupon with no limits. */
async function makeCoupon(percentBp: number) {
  const code = `__T9__${unique()}`.toUpperCase().slice(0, 40);
  const [row] = await getDb()
    .insert(coupons)
    .values({ code, discountType: 'percent', percentBp, usageLimit: null, isActive: true });
  created.couponIds.push(row.insertId);
  return { id: row.insertId, code };
}

const caller = appRouter.createCaller(testContext());

/** Both price cards, one vehicle type missing its row, and so on. */
let bothVehicles = { id: 0, destinationName: '' };
let vanOnly = { id: 0, destinationName: '' };
let retiredRoute = { id: 0, destinationName: '' };
let retiredDestination = { id: 0, destinationName: '' };
let cheapRoute = { id: 0, destinationName: '' };

beforeAll(async () => {
  // `aaa` / `zzz` share a sort order, so the destination-name tie-break is
  // what decides their relative position in the list.
  bothVehicles = await makeRoute({ nameSeed: 'aaa', sortOrder: 10 });
  vanOnly = await makeRoute({ nameSeed: 'zzz', sortOrder: 10, vehicles: ['van'] });
  cheapRoute = await makeRoute({ nameSeed: 'cheap', sortOrder: 30, vanOneWayCentavos: 5_000 });
  retiredRoute = await makeRoute({ nameSeed: 'retired-route', sortOrder: 1, routeActive: false });
  retiredDestination = await makeRoute({
    nameSeed: 'retired-dest',
    sortOrder: 2,
    destinationActive: false,
  });
}, 60_000);

afterAll(async () => {
  const db = getDb();
  if (created.routeIds.length > 0) {
    await db
      .delete(transferRouteVehiclePrices)
      .where(inArray(transferRouteVehiclePrices.routeId, created.routeIds));
    await db.delete(transferRoutes).where(inArray(transferRoutes.id, created.routeIds));
  }
  if (created.destinationIds.length > 0) {
    await db.delete(destinations).where(inArray(destinations.id, created.destinationIds));
  }
  for (const id of created.couponIds) await db.delete(coupons).where(eq(coupons.id, id));
});

// ---------------------------------------------------------------------------
// 2. vehiclePriceForRouteAndType — the catalog read.
// ---------------------------------------------------------------------------

describeWithDb('vehiclePriceForRouteAndType', () => {
  it('reads the ONE-WAY column for a one-way transfer and the DAY-USE column for a day-use hire', async () => {
    const oneWay = await vehiclePriceForRouteAndType(bothVehicles.id, 'van', 'transfer_one_way');
    const dayUse = await vehiclePriceForRouteAndType(bothVehicles.id, 'van', 'transfer_day_use');
    expect(oneWay?.priceCentavos).toBe(PRICES.van.oneWayPriceCentavos);
    expect(dayUse?.priceCentavos).toBe(PRICES.van.dayUsePriceCentavos);
  });

  it("reads the requested VEHICLE TYPE's row, not the other one's", async () => {
    const suv = await vehiclePriceForRouteAndType(bothVehicles.id, 'suv', 'transfer_one_way');
    expect(suv?.priceCentavos).toBe(PRICES.suv.oneWayPriceCentavos);
    expect(suv?.priceCentavos).not.toBe(PRICES.van.oneWayPriceCentavos);
  });

  it("carries the route's free-cancellation window and duration for the hold to freeze", async () => {
    const price = await vehiclePriceForRouteAndType(bothVehicles.id, 'van', 'transfer_one_way');
    expect(price?.freeCancelHours).toBe(24);
    expect(price?.routeDurationMinutes).toBe(180);
  });

  it('answers null for a RETIRED route rather than quoting a withdrawn product', async () => {
    await expect(
      vehiclePriceForRouteAndType(retiredRoute.id, 'van', 'transfer_one_way'),
    ).resolves.toBeNull();
  });

  it('answers null for a vehicle type the route has no price row for', async () => {
    // The same route answers a van fine, so this is the missing ROW and not a
    // missing route.
    await expect(
      vehiclePriceForRouteAndType(vanOnly.id, 'van', 'transfer_one_way'),
    ).resolves.not.toBeNull();
    await expect(
      vehiclePriceForRouteAndType(vanOnly.id, 'suv', 'transfer_one_way'),
    ).resolves.toBeNull();
  });

  it('answers null for a route id that does not exist — never throws', async () => {
    await expect(
      vehiclePriceForRouteAndType(2_000_000_000, 'van', 'transfer_one_way'),
    ).resolves.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 3. transferRoutes.list — the public catalog.
// ---------------------------------------------------------------------------

describeWithDb('transferRoutes.list (public)', () => {
  it('lists an active route with both vehicle types priced, and no admin-only field', async () => {
    const row = (await caller.transferRoutes.list()).find((r) => r.id === bothVehicles.id);
    expect(row).toBeDefined();
    expect(row).toMatchObject({
      destinationName: bothVehicles.destinationName,
      estimatedDurationMinutes: 180,
      freeCancelHours: 24,
      inclusionsText: 'Fuel, driver, tolls',
      exclusionsText: 'Meals',
      prices: { van: PRICES.van, suv: PRICES.suv },
    });
    // The admin list carries these three; the public one must not.
    expect(row).not.toHaveProperty('isActive');
    expect(row).not.toHaveProperty('destinationId');
    expect(row).not.toHaveProperty('sortOrder');
  });

  it('reports a vehicle type with no stored price row as null, never as ₱0', async () => {
    const row = (await caller.transferRoutes.list()).find((r) => r.id === vanOnly.id);
    expect(row?.prices.van).toEqual(PRICES.van);
    expect(row?.prices.suv).toBeNull();
  });

  it('OMITS a retired route, and a route whose destination is retired', async () => {
    const ids = (await caller.transferRoutes.list()).map((r) => r.id);
    expect(ids).toContain(bothVehicles.id);
    expect(ids).not.toContain(retiredRoute.id);
    expect(ids).not.toContain(retiredDestination.id);
  });

  it('orders by sort order, then by destination name', async () => {
    const ids = (await caller.transferRoutes.list()).map((r) => r.id);
    const mine = ids.filter((id) => [bothVehicles.id, vanOnly.id, cheapRoute.id].includes(id));
    // sortOrder 10 ('…aaa…'), sortOrder 10 ('…zzz…'), sortOrder 30.
    expect(mine).toEqual([bothVehicles.id, vanOnly.id, cheapRoute.id]);
  });
});

// ---------------------------------------------------------------------------
// 4. checkout.quoteTransfer — the whole thing through the real router.
// ---------------------------------------------------------------------------

describeWithDb('checkout.quoteTransfer', () => {
  it('quotes a flat per-vehicle rate, with the deposit from the shared trust setting', async () => {
    const quote = await caller.checkout.quoteTransfer({
      routeId: bothVehicles.id,
      vehicleType: 'van',
      productType: 'transfer_one_way',
    });

    // The wire shape, validated against the shared schema rather than by hand.
    expect(quoteTransferResultSchema.safeParse(quote).success).toBe(true);
    expect(quote.subtotalCentavos).toBe(PRICES.van.oneWayPriceCentavos);
    expect(quote.totalCentavos).toBe(PRICES.van.oneWayPriceCentavos);
    // 30% of ₱2,500 — the seeded `trust.depositPercent`, the same one tours use.
    expect(quote.depositCentavos).toBe(75_000);
    expect(quote.freeCancelHours).toBe(24);
    // Unlike the tour quote, there is no replay digest to hand back: T10's hold
    // re-derives the price itself (see quoteTransferResultSchema's note).
    expect(quote).not.toHaveProperty('quoteId');
    expect(quote).not.toHaveProperty('tier');
  });

  it('prices the day-use product from the day-use column', async () => {
    const quote = await caller.checkout.quoteTransfer({
      routeId: bothVehicles.id,
      vehicleType: 'suv',
      productType: 'transfer_day_use',
    });
    expect(quote.totalCentavos).toBe(PRICES.suv.dayUsePriceCentavos);
  });

  it('applies a coupon to the catalog rate', async () => {
    const coupon = await makeCoupon(1000); // 10% off
    const quote = await caller.checkout.quoteTransfer({
      routeId: bothVehicles.id,
      vehicleType: 'van',
      productType: 'transfer_one_way',
      couponCode: coupon.code,
    });
    expect(quote.discountCentavos).toBe(25_000);
    expect(quote.totalCentavos).toBe(225_000);
  });

  it('refuses an unknown coupon code with the SAME sentence the tour quote gives', async () => {
    await expect(
      caller.checkout.quoteTransfer({
        routeId: bothVehicles.id,
        vehicleType: 'van',
        productType: 'transfer_one_way',
        couponCode: 'NO-SUCH-T9-CODE',
      }),
    ).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: "We couldn't find that coupon code.",
    });
  });

  it('refuses a retired route, a missing vehicle price and an unknown route id identically', async () => {
    const expected = {
      code: 'NOT_FOUND',
      message: 'No price is available for that route and vehicle.',
    };
    await expect(
      caller.checkout.quoteTransfer({
        routeId: retiredRoute.id,
        vehicleType: 'van',
        productType: 'transfer_one_way',
      }),
    ).rejects.toMatchObject(expected);
    await expect(
      caller.checkout.quoteTransfer({
        routeId: vanOnly.id,
        vehicleType: 'suv',
        productType: 'transfer_one_way',
      }),
    ).rejects.toMatchObject(expected);
    await expect(
      caller.checkout.quoteTransfer({
        routeId: 2_000_000_000,
        vehicleType: 'van',
        productType: 'transfer_one_way',
      }),
    ).rejects.toMatchObject(expected);
  });

  it('refuses a total under the ₱100 gateway floor, without offering "pay in full"', async () => {
    const error = await caller.checkout
      .quoteTransfer({
        routeId: cheapRoute.id,
        vehicleType: 'van',
        productType: 'transfer_one_way',
      })
      .catch((e: unknown) => e);

    expect(error).toMatchObject({ code: 'BAD_REQUEST', message: TOTAL_BELOW_GATEWAY_MINIMUM });
    // The premise, so this test cannot pass for the wrong reason.
    expect(5_000).toBeLessThan(PAYMONGO_MIN_CENTAVOS);
  });

  it('tells a 100%-off guest there is nothing to pay at all', async () => {
    const coupon = await makeCoupon(10000); // 100% off — percent_bp allows it
    const error = await caller.checkout
      .quoteTransfer({
        routeId: bothVehicles.id,
        vehicleType: 'van',
        productType: 'transfer_one_way',
        couponCode: coupon.code,
      })
      .catch((e: unknown) => e);

    expect(error).toMatchObject({ code: 'BAD_REQUEST', message: NOTHING_TO_PAY_ONLINE });
  });

  it('REFUSES an input that carries a price — the server computes all money', async () => {
    await expect(
      caller.checkout.quoteTransfer({
        routeId: bothVehicles.id,
        vehicleType: 'van',
        productType: 'transfer_one_way',
        // @ts-expect-error — `.strict()` rejects it, and the type says so too.
        priceCentavos: 1,
      }),
    ).rejects.toThrow();
  });
});
