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
import {
  coupons,
  transferPlaces,
  transferRouteVehiclePrices,
  transferRoutes,
  vans,
  vehicleTypes,
} from '../db/schema';
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
  placeIds: [] as number[],
  couponIds: [] as number[],
  vehicleTypeIds: [] as number[],
  vanIds: [] as number[],
};

/**
 * The real, global `vehicle_types.id` for `'van'`/`'suv'` — seeded by
 * `seedBase` (migration 0023), never a literal id (CLAUDE.md). Resolved once
 * in `beforeAll`, below.
 */
let VAN_ID = 0;
let SUV_ID = 0;

async function vehicleTypeIdBySlug(slug: string): Promise<number> {
  const [row] = await getDb()
    .select({ id: vehicleTypes.id })
    .from(vehicleTypes)
    .where(eq(vehicleTypes.slug, slug))
    .limit(1);
  if (!row) throw new Error(`No vehicle_types row for slug "${slug}" — expected from seedBase.`);
  return row.id;
}

/**
 * A route between two fresh, admin-managed places, with whatever price rows
 * the caller asks for (owner decision 2026-11-08: `destinationId` ->
 * `fromPlaceId`/`toPlaceId`; `transfer_route_vehicle_prices.vehicleType` ->
 * `.vehicleTypeId`). Every id is tracked for teardown; the route's slug and
 * the TO-place's name carry a per-run suffix so parallel suites cannot
 * collide on the `UNIQUE` columns.
 *
 * **`toPlaceActive` marks the TO-PLACE inactive (renamed from the old
 * `destinationActive`), and `fromPlaceActive` does the same for the
 * FROM-PLACE** — sellability moved from `destinations` to
 * `transfer_places` (design note §1.3), and each half of the route's own
 * soft-delete pair needs its own independent toggle: `vehiclePriceForRouteAndType`
 * joins BOTH places and requires BOTH `is_active`, so a test that can only
 * deactivate the TO-place could never tell the two `eq()` conditions apart.
 */
async function makeRoute(options: {
  /** Suffixed and lowercased — it decides the name tie-break in the list order. */
  nameSeed: string;
  sortOrder: number;
  routeActive?: boolean;
  fromPlaceActive?: boolean;
  toPlaceActive?: boolean;
  vehicles?: Array<'van' | 'suv'>;
  vanOneWayCentavos?: number;
}) {
  const db = getDb();
  const suffix = unique().replace('_', '-');
  const name = `__t9__${options.nameSeed}-${suffix}`;

  const [fromPlace] = await db.insert(transferPlaces).values({
    name: `${name}-from`,
    nameKey: `${name}-from`.toLowerCase(),
    isActive: options.fromPlaceActive ?? true,
  });
  created.placeIds.push(fromPlace.insertId);
  const [toPlace] = await db.insert(transferPlaces).values({
    name,
    nameKey: name.toLowerCase(),
    isActive: options.toPlaceActive ?? true,
  });
  created.placeIds.push(toPlace.insertId);

  const [route] = await db.insert(transferRoutes).values({
    fromPlaceId: fromPlace.insertId,
    toPlaceId: toPlace.insertId,
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
      vehicleTypeId: vehicleType === 'van' ? VAN_ID : SUV_ID,
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

/**
 * One sellable van per seeded type (owner decision 2026-11-08, design note
 * §4): `transferRoutes.list`'s public visibility rule now ALSO requires at
 * least one sellable vehicle of a type before offering it, and
 * `rg_travel_test` keeps an EMPTY fleet by design (CLAUDE.md, "Dispatch") —
 * without these, every `vehiclePrices` array in this whole describe block
 * would be empty regardless of what is priced, and the rule would pass
 * vacuously for the wrong reason. Explicitly called out in the design note
 * as the mistake 1F's acceptance test must not make.
 */
async function makeSellableVan(vehicleTypeId: number) {
  const suffix = unique();
  const [row] = await getDb()
    .insert(vans)
    .values({
      plate: `T9${suffix}`.slice(0, 20),
      model: 'T9 Fixture Van',
      capacity: 12,
      vehicleTypeId,
      status: 'available',
      isActive: true,
    });
  created.vanIds.push(row.insertId);
}

beforeAll(async () => {
  VAN_ID = await vehicleTypeIdBySlug('van');
  SUV_ID = await vehicleTypeIdBySlug('suv');
  await makeSellableVan(VAN_ID);
  await makeSellableVan(SUV_ID);

  /*
   * **Inserted in the REVERSE of the order the list must return them in**
   * (T9 review, Minor finding). `aaa` / `zzz` share a sort order, so the
   * destination-name tie-break decides their relative position — but with the
   * three inserted lowest-sort-order-first, MySQL's natural row order already
   * satisfied the ordering assertion below and deleting the `.orderBy()` clause
   * outright left that test GREEN. Creating the highest sort order first, and
   * the `zzz` tie-break before the `aaa` one, makes insertion order the exact
   * opposite of the expected order, so both ORDER BY keys are genuinely pinned.
   */
  cheapRoute = await makeRoute({ nameSeed: 'cheap', sortOrder: 30, vanOneWayCentavos: 5_000 });
  vanOnly = await makeRoute({ nameSeed: 'zzz', sortOrder: 10, vehicles: ['van'] });
  bothVehicles = await makeRoute({ nameSeed: 'aaa', sortOrder: 10 });
  retiredRoute = await makeRoute({ nameSeed: 'retired-route', sortOrder: 1, routeActive: false });
  retiredDestination = await makeRoute({
    nameSeed: 'retired-dest',
    sortOrder: 2,
    toPlaceActive: false,
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
  if (created.placeIds.length > 0) {
    await db.delete(transferPlaces).where(inArray(transferPlaces.id, created.placeIds));
  }
  for (const id of created.couponIds) await db.delete(coupons).where(eq(coupons.id, id));
  if (created.vanIds.length > 0) {
    await db.delete(vans).where(inArray(vans.id, created.vanIds));
  }
  // Price rows for a test-owned type were already removed above (its only
  // route id is in `created.routeIds`), so the type row itself is safe to
  // delete last.
  if (created.vehicleTypeIds.length > 0) {
    await db.delete(vehicleTypes).where(inArray(vehicleTypes.id, created.vehicleTypeIds));
  }
});

// ---------------------------------------------------------------------------
// 2. vehiclePriceForRouteAndType — the catalog read.
// ---------------------------------------------------------------------------

describeWithDb('vehiclePriceForRouteAndType', () => {
  it('reads the ONE-WAY column for a one-way transfer and the DAY-USE column for a day-use hire', async () => {
    const oneWay = await vehiclePriceForRouteAndType(bothVehicles.id, VAN_ID, 'transfer_one_way');
    const dayUse = await vehiclePriceForRouteAndType(bothVehicles.id, VAN_ID, 'transfer_day_use');
    expect(oneWay?.priceCentavos).toBe(PRICES.van.oneWayPriceCentavos);
    expect(dayUse?.priceCentavos).toBe(PRICES.van.dayUsePriceCentavos);
  });

  it("reads the requested VEHICLE TYPE's row, not the other one's", async () => {
    const suv = await vehiclePriceForRouteAndType(bothVehicles.id, SUV_ID, 'transfer_one_way');
    expect(suv?.priceCentavos).toBe(PRICES.suv.oneWayPriceCentavos);
    expect(suv?.priceCentavos).not.toBe(PRICES.van.oneWayPriceCentavos);
  });

  it("carries the route's free-cancellation window and duration for the hold to freeze", async () => {
    const price = await vehiclePriceForRouteAndType(bothVehicles.id, VAN_ID, 'transfer_one_way');
    expect(price?.freeCancelHours).toBe(24);
    expect(price?.routeDurationMinutes).toBe(180);
  });

  it('answers null for a RETIRED route rather than quoting a withdrawn product', async () => {
    await expect(
      vehiclePriceForRouteAndType(retiredRoute.id, VAN_ID, 'transfer_one_way'),
    ).resolves.toBeNull();
  });

  it('answers null for an ACTIVE route whose TO PLACE is retired', async () => {
    /*
     * T9 review, Important finding: this function used to check only the
     * route's own `is_active`, so deactivating a destination on the existing
     * destinations screen took the route off `transferRoutes.list` and left it
     * quotable here — a live price for a place the business has withdrawn,
     * reachable from a stale tab or by probing small route ids. The route in
     * this fixture is ACTIVE; only its to-place is not, which is what makes
     * this a test of the second filter rather than the first.
     */
    await expect(
      vehiclePriceForRouteAndType(retiredDestination.id, VAN_ID, 'transfer_one_way'),
    ).resolves.toBeNull();
  });

  it('answers null for an ACTIVE route whose FROM PLACE is retired (Opus review finding)', async () => {
    // The TO-place test above exercises `eq(toPlace.isActive, true)`; this one
    // exercises the OTHER aliased join's condition, `eq(fromPlace.isActive,
    // true)` — the two are independent conditions on independent joins, and
    // nothing before this test ever deactivated the FROM place alone.
    const retiredOrigin = await makeRoute({
      nameSeed: 'retired-origin',
      sortOrder: 3,
      fromPlaceActive: false,
    });
    await expect(
      vehiclePriceForRouteAndType(retiredOrigin.id, VAN_ID, 'transfer_one_way'),
    ).resolves.toBeNull();
  });

  it('answers null for a DEACTIVATED vehicle type, even with a priced row on an active route (Opus review finding)', async () => {
    // A test-OWNED vehicle type, never the shared seeded van/suv rows — this
    // suite has no business flipping `is_active` on a row other suites rely
    // on being active throughout the run.
    const db = getDb();
    const slug = `__t9-vt__${unique()}`;
    const [vt] = await db
      .insert(vehicleTypes)
      .values({ name: `T9 fixture ${slug}`, slug, isActive: true, sortOrder: 999 });
    created.vehicleTypeIds.push(vt.insertId);

    await db.insert(transferRouteVehiclePrices).values({
      routeId: bothVehicles.id,
      vehicleTypeId: vt.insertId,
      oneWayPriceCentavos: 111_00,
      dayUsePriceCentavos: 222_00,
    });

    await expect(
      vehiclePriceForRouteAndType(bothVehicles.id, vt.insertId, 'transfer_one_way'),
    ).resolves.not.toBeNull();

    await db.update(vehicleTypes).set({ isActive: false }).where(eq(vehicleTypes.id, vt.insertId));

    await expect(
      vehiclePriceForRouteAndType(bothVehicles.id, vt.insertId, 'transfer_one_way'),
    ).resolves.toBeNull();
  });

  it('answers null for a vehicle type the route has no price row for', async () => {
    // The same route answers a van fine, so this is the missing ROW and not a
    // missing route.
    await expect(
      vehiclePriceForRouteAndType(vanOnly.id, VAN_ID, 'transfer_one_way'),
    ).resolves.not.toBeNull();
    await expect(
      vehiclePriceForRouteAndType(vanOnly.id, SUV_ID, 'transfer_one_way'),
    ).resolves.toBeNull();
  });

  it('answers null for a route id that does not exist — never throws', async () => {
    await expect(
      vehiclePriceForRouteAndType(2_000_000_000, VAN_ID, 'transfer_one_way'),
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
      estimatedDurationMinutes: 180,
      freeCancelHours: 24,
      inclusionsText: 'Fuel, driver, tolls',
      exclusionsText: 'Meals',
    });
    expect(row?.toPlace.name).toBe(bothVehicles.destinationName);
    const vanPrice = row?.vehiclePrices.find((p) => p.vehicleTypeId === VAN_ID);
    const suvPrice = row?.vehiclePrices.find((p) => p.vehicleTypeId === SUV_ID);
    expect(vanPrice).toMatchObject(PRICES.van);
    expect(suvPrice).toMatchObject(PRICES.suv);
    // The admin list carries these three; the public one must not.
    expect(row).not.toHaveProperty('isActive');
    expect(row).not.toHaveProperty('destinationId');
    expect(row).not.toHaveProperty('sortOrder');
  });

  it('OMITS a vehicle type with no stored price row — never a ₱0 placeholder', async () => {
    const row = (await caller.transferRoutes.list()).find((r) => r.id === vanOnly.id);
    const vanPrice = row?.vehiclePrices.find((p) => p.vehicleTypeId === VAN_ID);
    const suvPrice = row?.vehiclePrices.find((p) => p.vehicleTypeId === SUV_ID);
    expect(vanPrice).toMatchObject(PRICES.van);
    expect(suvPrice).toBeUndefined();
  });

  it('OMITS a retired route, and a route whose TO place is retired', async () => {
    const ids = (await caller.transferRoutes.list()).map((r) => r.id);
    expect(ids).toContain(bothVehicles.id);
    expect(ids).not.toContain(retiredRoute.id);
    expect(ids).not.toContain(retiredDestination.id);
  });

  it('orders by sort order, then by place name', async () => {
    const ids = (await caller.transferRoutes.list()).map((r) => r.id);
    const mine = ids.filter((id) => [bothVehicles.id, vanOnly.id, cheapRoute.id].includes(id));
    // sortOrder 10 ('…aaa…'), sortOrder 10 ('…zzz…'), sortOrder 30.
    expect(mine).toEqual([bothVehicles.id, vanOnly.id, cheapRoute.id]);
  });

  it('OMITS a route whose FROM place is retired (symmetric with the TO-place case above)', async () => {
    const retiredOrigin = await makeRoute({
      nameSeed: 'retired-origin-list',
      sortOrder: 4,
      fromPlaceActive: false,
    });
    const ids = (await caller.transferRoutes.list()).map((r) => r.id);
    expect(ids).not.toContain(retiredOrigin.id);
  });

  /**
   * **1F item 1 — the AND-gate itself, deferred twice before this task**
   * (CLAUDE.md, "the test database keeps an EMPTY fleet"). Every scenario
   * above runs against this file's own `beforeAll` seeded van/suv, each of
   * which ALWAYS has a sellable vehicle — so none of them can tell "priced"
   * apart from "priced AND sellable", because sellability never varies in
   * those fixtures. This test varies it directly: a brand-new vehicle type
   * gets one sellable van, a second brand-new type gets none, BOTH are
   * priced on the SAME route, and only the first may appear. If
   * `transferRoutes.list` ever stopped checking `sellableVehiclesByType()`
   * and fell back to "priced, full stop", this test is what would catch it
   * — proven by temporarily removing that check (see the commit message /
   * PR description for the break-red-restore-green record).
   */
  it('shows a priced type with a sellable vehicle and HIDES a priced type with none — the AND gate', async () => {
    const db = getDb();
    // `vehicle_types.slug` is `varchar(40)` (design note §1.1) — `unique()`
    // alone is ~23 chars, so the slug (never the longer, merely-descriptive
    // `name`) gets a short prefix.
    const sellableName = `T9 AND-gate sellable ${unique()}`;
    const sellableSlug = `vts_${unique()}`;
    const [sellableType] = await db
      .insert(vehicleTypes)
      .values({ name: sellableName, slug: sellableSlug, isActive: true, sortOrder: 900 });
    created.vehicleTypeIds.push(sellableType.insertId);
    await makeSellableVan(sellableType.insertId);

    const unsellableName = `T9 AND-gate unsellable ${unique()}`;
    const unsellableSlug = `vtu_${unique()}`;
    const [unsellableType] = await db
      .insert(vehicleTypes)
      .values({ name: unsellableName, slug: unsellableSlug, isActive: true, sortOrder: 901 });
    created.vehicleTypeIds.push(unsellableType.insertId);
    // Deliberately NO van for this type: priced, but nothing to sell.

    const route = await makeRoute({ nameSeed: 'and-gate', sortOrder: 40, vehicles: [] });
    await db.insert(transferRouteVehiclePrices).values([
      {
        routeId: route.id,
        vehicleTypeId: sellableType.insertId,
        oneWayPriceCentavos: 123_00,
        dayUsePriceCentavos: 456_00,
      },
      {
        routeId: route.id,
        vehicleTypeId: unsellableType.insertId,
        oneWayPriceCentavos: 789_00,
        dayUsePriceCentavos: 101_112,
      },
    ]);

    const row = (await caller.transferRoutes.list()).find((r) => r.id === route.id);
    expect(
      row?.vehiclePrices.find((p) => p.vehicleTypeId === sellableType.insertId),
      'a type with a price row AND a sellable vehicle must be offered',
    ).toMatchObject({ oneWayPriceCentavos: 123_00, dayUsePriceCentavos: 456_00 });
    expect(
      row?.vehiclePrices.find((p) => p.vehicleTypeId === unsellableType.insertId),
      'a type with a price row but NO sellable vehicle must be hidden — the AND, not an OR',
    ).toBeUndefined();
  });

  /**
   * **1F item 2 — the "MPV" shape.** A third vehicle type, priced on ONE
   * route only. This proves the PER-ROUTE filter (the price-row join),
   * distinct from the per-type sellability filter the test above proves —
   * both need a sellable vehicle to show at all, which is why this type
   * gets one too.
   */
  it('a vehicle type priced on exactly one route appears there and is absent from a route it was never priced on', async () => {
    const db = getDb();
    const mpvSlug = `__t9-mpv__${unique()}`;
    const [mpvType] = await db
      .insert(vehicleTypes)
      .values({ name: mpvSlug, slug: mpvSlug, isActive: true, sortOrder: 902 });
    created.vehicleTypeIds.push(mpvType.insertId);
    await makeSellableVan(mpvType.insertId);

    const pricedRoute = await makeRoute({ nameSeed: 'mpv-priced', sortOrder: 41, vehicles: [] });
    await db.insert(transferRouteVehiclePrices).values({
      routeId: pricedRoute.id,
      vehicleTypeId: mpvType.insertId,
      oneWayPriceCentavos: 333_00,
      dayUsePriceCentavos: 444_00,
    });

    const rows = await caller.transferRoutes.list();
    const pricedRow = rows.find((r) => r.id === pricedRoute.id);
    // `bothVehicles` never had the MPV type priced on it — the "different route" control.
    const neverPricedRow = rows.find((r) => r.id === bothVehicles.id);

    expect(
      pricedRow?.vehiclePrices.find((p) => p.vehicleTypeId === mpvType.insertId),
    ).toMatchObject({ oneWayPriceCentavos: 333_00, dayUsePriceCentavos: 444_00 });
    expect(
      neverPricedRow?.vehiclePrices.find((p) => p.vehicleTypeId === mpvType.insertId),
      'a type never priced on this route must not appear on it',
    ).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 4. checkout.quoteTransfer — the whole thing through the real router.
// ---------------------------------------------------------------------------

describeWithDb('checkout.quoteTransfer', () => {
  it('quotes a flat per-vehicle rate, with the deposit from the shared trust setting', async () => {
    const quote = await caller.checkout.quoteTransfer({
      routeId: bothVehicles.id,
      vehicleTypeId: VAN_ID,
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
      vehicleTypeId: SUV_ID,
      productType: 'transfer_day_use',
    });
    expect(quote.totalCentavos).toBe(PRICES.suv.dayUsePriceCentavos);
  });

  it('applies a coupon to the catalog rate', async () => {
    const coupon = await makeCoupon(1000); // 10% off
    const quote = await caller.checkout.quoteTransfer({
      routeId: bothVehicles.id,
      vehicleTypeId: VAN_ID,
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
        vehicleTypeId: VAN_ID,
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
        vehicleTypeId: VAN_ID,
        productType: 'transfer_one_way',
      }),
    ).rejects.toMatchObject(expected);
    await expect(
      caller.checkout.quoteTransfer({
        routeId: vanOnly.id,
        vehicleTypeId: SUV_ID,
        productType: 'transfer_one_way',
      }),
    ).rejects.toMatchObject(expected);
    // The retired DESTINATION gets the same sentence as the retired route
    // (T9 review, Important finding) — the router distinguishes none of them.
    await expect(
      caller.checkout.quoteTransfer({
        routeId: retiredDestination.id,
        vehicleTypeId: VAN_ID,
        productType: 'transfer_one_way',
      }),
    ).rejects.toMatchObject(expected);
    await expect(
      caller.checkout.quoteTransfer({
        routeId: 2_000_000_000,
        vehicleTypeId: VAN_ID,
        productType: 'transfer_one_way',
      }),
    ).rejects.toMatchObject(expected);
  });

  it('refuses a total under the ₱100 gateway floor, without offering "pay in full"', async () => {
    const error = await caller.checkout
      .quoteTransfer({
        routeId: cheapRoute.id,
        vehicleTypeId: VAN_ID,
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
        vehicleTypeId: VAN_ID,
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
        vehicleTypeId: VAN_ID,
        productType: 'transfer_one_way',
        // @ts-expect-error — `.strict()` rejects it, and the type says so too.
        priceCentavos: 1,
      }),
    ).rejects.toThrow();
  });
});
