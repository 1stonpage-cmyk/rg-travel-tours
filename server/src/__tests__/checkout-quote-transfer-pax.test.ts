/**
 * `checkout.quoteTransfer` with `pax` (per-person pricing plan, Task 2B /
 * Step 8) — the guest preview's own half of `transferSubtotalCentavos()` and
 * the seat-cap refusal, through the real router rather than the service
 * function directly (`transfer-pricing.test.ts` already covers the service
 * layer; this file is the resolver's own wire-shape and refusal-sentence
 * coverage, the one `pax`-specific surface new to this plan).
 *
 * **Every assertion here is scoped to this file's own fixture ids** — same
 * discipline `transfer-pricing.test.ts`'s own header documents: Vitest runs
 * test files in parallel against one `rg_travel_test`.
 */
import { afterAll, expect, it } from 'vitest';
import { inArray } from 'drizzle-orm';
import { seatCapMessage } from '@rg/shared';
import { getDb } from '../db/client';
import {
  transferPlaces,
  transferRouteVehiclePrices,
  transferRoutes,
  vans,
  vehicleTypes,
} from '../db/schema';
import { appRouter } from '../routers/_app';
import { testContext } from './helpers/ctx';
import { describeWithDb } from './helpers/db';

const unique = () => `${Math.floor(Math.random() * 1e9)}_${Date.now()}`;

const created = {
  routeIds: [] as number[],
  placeIds: [] as number[],
  vanIds: [] as number[],
  vehicleTypeIds: [] as number[],
};

/**
 * A test-owned vehicle type, so this file's seat-cap/per-person cases do not
 * depend on whatever `defaultSeats` the shared seeded `van`/`suv` rows
 * happen to carry in a given environment (CLAUDE.md documents them as
 * `NULL` by design; a dev box that has separately run `db:seed:demo`
 * against the SAME physical database as `rg_travel_test` — not the
 * documented path, but observed — can carry real numbers there instead).
 * `defaultSeats` is always stated explicitly here.
 */
async function makeVehicleType(defaultSeats: number | null) {
  const suffix = unique();
  const [row] = await getDb()
    .insert(vehicleTypes)
    .values({
      name: `Quote Pax Fixture VT ${suffix}`,
      slug: `__qpax-vt__${suffix}`.slice(0, 40),
      defaultSeats,
      isActive: true,
      sortOrder: 998,
    });
  created.vehicleTypeIds.push(row.insertId);
  return row.insertId;
}

async function makeSellableVan(vehicleTypeId: number) {
  const suffix = unique();
  const [row] = await getDb()
    .insert(vans)
    .values({
      plate: `QP${suffix}`.slice(0, 20),
      model: 'Quote Pax Fixture Van',
      capacity: 12,
      vehicleTypeId,
      status: 'available',
      isActive: true,
    });
  created.vanIds.push(row.insertId);
}

async function makeRoute(opts: {
  vehicleTypeId: number;
  pricingMode: 'per_vehicle' | 'per_person';
  minPayingPax?: number;
  oneWayPriceCentavos: number;
}) {
  const suffix = unique();
  const [fromPlace] = await getDb()
    .insert(transferPlaces)
    .values({ name: `__qpax__${suffix}-from`, nameKey: `__qpax__${suffix}-from`, isActive: true });
  created.placeIds.push(fromPlace.insertId);
  const [toPlace] = await getDb()
    .insert(transferPlaces)
    .values({ name: `__qpax__${suffix}-to`, nameKey: `__qpax__${suffix}-to`, isActive: true });
  created.placeIds.push(toPlace.insertId);

  const [route] = await getDb()
    .insert(transferRoutes)
    .values({
      fromPlaceId: fromPlace.insertId,
      toPlaceId: toPlace.insertId,
      slug: `qpax-${suffix}`,
      isActive: true,
      estimatedDurationMinutes: 90,
      freeCancelHours: 24,
      pricingMode: opts.pricingMode,
      minPayingPax: opts.minPayingPax ?? 1,
    });
  created.routeIds.push(route.insertId);

  await getDb()
    .insert(transferRouteVehiclePrices)
    .values({
      routeId: route.insertId,
      vehicleTypeId: opts.vehicleTypeId,
      oneWayPriceCentavos: opts.oneWayPriceCentavos,
      dayUsePriceCentavos: opts.oneWayPriceCentavos * 2,
    });

  return route.insertId;
}

const caller = appRouter.createCaller(testContext());

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
  if (created.vanIds.length > 0) {
    await db.delete(vans).where(inArray(vans.id, created.vanIds));
  }
  // Last: vehicle types, once every van and price row that could reference
  // one is gone.
  if (created.vehicleTypeIds.length > 0) {
    await db.delete(vehicleTypes).where(inArray(vehicleTypes.id, created.vehicleTypeIds));
  }
});

describeWithDb('checkout.quoteTransfer — pax (per-person pricing plan)', () => {
  it('a per-person quote with pax: 3 returns totalCentavos equal to unitPrice * 3', async () => {
    const vehicleTypeId = await makeVehicleType(null);
    await makeSellableVan(vehicleTypeId);
    const routeId = await makeRoute({
      vehicleTypeId,
      pricingMode: 'per_person',
      oneWayPriceCentavos: 35_000,
    });

    const quote = await caller.checkout.quoteTransfer({
      routeId,
      vehicleTypeId,
      productType: 'transfer_one_way',
      pax: 3,
    });

    expect(quote.pricingMode).toBe('per_person');
    expect(quote.paxCharged).toBe(3);
    expect(quote.subtotalCentavos).toBe(105_000); // 35_000 x 3
    expect(quote.totalCentavos).toBe(105_000);
  });

  it('pax over the seat cap is refused with the plain seat-cap sentence', async () => {
    const vehicleTypeId = await makeVehicleType(4);
    await makeSellableVan(vehicleTypeId);
    const routeId = await makeRoute({
      vehicleTypeId,
      pricingMode: 'per_vehicle',
      oneWayPriceCentavos: 250_000,
    });

    await expect(
      caller.checkout.quoteTransfer({
        routeId,
        vehicleTypeId,
        productType: 'transfer_one_way',
        pax: 5,
      }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST', message: seatCapMessage(4) });
  });

  it("a per-vehicle route's quote is byte-identical to today's (no behaviour change) when pax: 1", async () => {
    const vehicleTypeId = await makeVehicleType(null);
    await makeSellableVan(vehicleTypeId);
    const routeId = await makeRoute({
      vehicleTypeId,
      pricingMode: 'per_vehicle',
      oneWayPriceCentavos: 250_000,
    });

    const quote = await caller.checkout.quoteTransfer({
      routeId,
      vehicleTypeId,
      productType: 'transfer_one_way',
      pax: 1,
    });

    // Every pre-existing money field, exactly as `quoteTransfer()`'s own
    // "no pax" contract has always produced for a per_vehicle route.
    expect(quote.subtotalCentavos).toBe(250_000);
    expect(quote.discountCentavos).toBe(0);
    expect(quote.totalCentavos).toBe(250_000);
    expect(quote.depositCentavos).toBe(75_000); // 30% of ₱2,500
    // And the same figure, regardless of a higher pax — because a
    // per_vehicle route ignores pax entirely.
    const quoteWithMorePax = await caller.checkout.quoteTransfer({
      routeId,
      vehicleTypeId,
      productType: 'transfer_one_way',
      pax: 6,
    });
    expect(quoteWithMorePax.totalCentavos).toBe(quote.totalCentavos);
    expect(quote.pricingMode).toBe('per_vehicle');
    expect(quote.paxCharged).toBe(1);
  });
});
