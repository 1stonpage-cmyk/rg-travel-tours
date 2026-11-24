/**
 * Task 9 (SEO fixes, 2026-11-24), Step 0 — `transferRoutes.list` publishes
 * BOTH direction titles (`pageTitle`/`reversePageTitle`) on the wire, computed
 * from the SAME `transferRouteTitle()` formula Task 8's `resolvePage` uses
 * for `/transfers/:slug` — one formula, three callers (forward resolver,
 * reverse resolver, this router), proven to agree rather than assumed to.
 *
 * `rg_travel_test` ships zero `transfer_routes` rows (same discipline as the
 * fleet — see `transfer-route-page-seo.test.ts`'s own header), so this test
 * builds a self-contained fixture route via Drizzle, cleaned up afterward in
 * FK-safe order (prices -> routes -> places), mirroring Task 8's pattern.
 */
import { eq } from 'drizzle-orm';
import { expect, it } from 'vitest';
import { reverseTransferRouteSlug } from '@rg/shared';
import { getDb } from '../db/client';
import {
  transferPlaces,
  transferRouteVehiclePrices,
  transferRoutes,
  vehicleTypes,
} from '../db/schema';
import { resolvePage } from '../seo/resolvers';
import { testContext } from './helpers/ctx';
import { describeWithDb } from './helpers/db';
import { appRouter } from '../routers/_app';

const caller = appRouter.createCaller(testContext());

const unique = () => `${Math.floor(Math.random() * 1e9)}_${Date.now()}`;

const created = {
  placeIds: [] as number[],
  routeIds: [] as number[],
  vehicleTypeIds: [] as number[],
};

async function makePlace(name: string): Promise<number> {
  const [row] = await getDb()
    .insert(transferPlaces)
    .values({ name, nameKey: name.trim().toLowerCase() });
  created.placeIds.push(row.insertId);
  return row.insertId;
}

async function makeVehicleType(): Promise<number> {
  const suffix = unique();
  const [row] = await getDb()
    .insert(vehicleTypes)
    .values({
      name: `Router Fixture Vehicle ${suffix}`,
      slug: `router-fixture-${suffix}`.slice(0, 40),
    });
  created.vehicleTypeIds.push(row.insertId);
  return row.insertId;
}

async function makeRoute(opts: {
  fromPlaceId: number;
  toPlaceId: number;
  reverseEnabled?: boolean;
}): Promise<{ id: number; slug: string }> {
  const slug = `router-fixture-route-to-${unique()}`;
  const [row] = await getDb()
    .insert(transferRoutes)
    .values({
      fromPlaceId: opts.fromPlaceId,
      toPlaceId: opts.toPlaceId,
      slug,
      reverseEnabled: opts.reverseEnabled ?? true,
      estimatedDurationMinutes: 120,
      freeCancelHours: 24,
    });
  created.routeIds.push(row.insertId);
  return { id: row.insertId, slug };
}

async function cleanup(): Promise<void> {
  const db = getDb();
  for (const id of created.routeIds.splice(0)) {
    await db.delete(transferRouteVehiclePrices).where(eq(transferRouteVehiclePrices.routeId, id));
    await db.delete(transferRoutes).where(eq(transferRoutes.id, id));
  }
  for (const id of created.placeIds.splice(0)) {
    await db.delete(transferPlaces).where(eq(transferPlaces.id, id));
  }
  for (const id of created.vehicleTypeIds.splice(0)) {
    await db.delete(vehicleTypes).where(eq(vehicleTypes.id, id));
  }
}

describeWithDb('transferRoutes.list — pageTitle / reversePageTitle', () => {
  it("a route's pageTitle/reversePageTitle are byte-identical to resolvePage's injected titles for the same slugs", async () => {
    try {
      const fromPlaceId = await makePlace(`Router Fixture Origin ${unique()}`);
      const toPlaceId = await makePlace(`Router Fixture Destination ${unique()}`);
      const { id: routeId, slug } = await makeRoute({ fromPlaceId, toPlaceId });
      // No price row — `pageTitle` must still resolve (the no-price,
      // no-price-clause candidate), matching `resolvePage`'s own fallback.

      const rows = await caller.transferRoutes.list();
      const row = rows.find((r) => r.id === routeId);
      expect(row).toBeDefined();

      const forwardMeta = await resolvePage(`/transfers/${slug}`);
      expect(row!.pageTitle).toBe(forwardMeta.title);

      const reverseSlug = reverseTransferRouteSlug(slug);
      const reverseMeta = await resolvePage(`/transfers/${reverseSlug}`);
      expect(row!.reversePageTitle).toBe(reverseMeta.title);
    } finally {
      await cleanup();
    }
  });

  it('reversePageTitle is null exactly when reverseEnabled is false', async () => {
    try {
      const fromPlaceId = await makePlace(`One Way Router Origin ${unique()}`);
      const toPlaceId = await makePlace(`One Way Router Destination ${unique()}`);
      const { id: routeId } = await makeRoute({
        fromPlaceId,
        toPlaceId,
        reverseEnabled: false,
      });

      const rows = await caller.transferRoutes.list();
      const row = rows.find((r) => r.id === routeId);
      expect(row).toBeDefined();
      expect(row!.reverseEnabled).toBe(false);
      expect(row!.reversePageTitle).toBeNull();
      expect(typeof row!.pageTitle).toBe('string');
    } finally {
      await cleanup();
    }
  });

  it('a priced route carries a price clause in pageTitle, matching the stable (non-sellability-filtered) cheapest price, for both directions', async () => {
    try {
      const vehicleTypeId = await makeVehicleType();
      // Short, fixed names (no `unique()` suffix) — the title formula drops
      // its price clause once the candidate string exceeds 60 chars, and a
      // long random suffix on BOTH place names would trip that fallback,
      // defeating the point of this test. Collision risk across concurrent
      // test runs is immaterial: nothing here keys off the place name, only
      // off the inserted `routeId`.
      const fromPlaceId = await makePlace('Priced Router A');
      const toPlaceId = await makePlace('Priced Router B');
      const { id: routeId, slug } = await makeRoute({ fromPlaceId, toPlaceId });
      await getDb().insert(transferRouteVehiclePrices).values({
        routeId,
        vehicleTypeId,
        oneWayPriceCentavos: 345_600,
        dayUsePriceCentavos: 500_000,
      });

      const rows = await caller.transferRoutes.list();
      const row = rows.find((r) => r.id === routeId);
      expect(row).toBeDefined();
      expect(row!.pageTitle).toContain('3,456');

      const forwardMeta = await resolvePage(`/transfers/${slug}`);
      expect(row!.pageTitle).toBe(forwardMeta.title);

      const reverseSlug = reverseTransferRouteSlug(slug);
      const reverseMeta = await resolvePage(`/transfers/${reverseSlug}`);
      expect(row!.reversePageTitle).toBe(reverseMeta.title);
    } finally {
      await cleanup();
    }
  });

  /**
   * Bug 1D (2026-11-24): the page's OWN `pageTitle` (not just `resolvePage`'s
   * SEO meta) must exclude an inactive vehicle type's lower price — the
   * "visible prices and meta/JSON-LD cannot drift" half of the fix. Both
   * `transferRoutes.list` and `resolvePage` now call the SAME shared
   * `cheapestActiveOneWayCentavos`, so this also re-proves they agree.
   */
  it("pageTitle's price clause ignores a lower price on an INACTIVE vehicle type", async () => {
    try {
      const activeVehicleTypeId = await makeVehicleType();
      const inactiveVehicleTypeId = await makeVehicleType();
      await getDb()
        .update(vehicleTypes)
        .set({ isActive: false })
        .where(eq(vehicleTypes.id, inactiveVehicleTypeId));

      const fromPlaceId = await makePlace('Bug 1D Router A');
      const toPlaceId = await makePlace('Bug 1D Router B');
      const { id: routeId, slug } = await makeRoute({ fromPlaceId, toPlaceId });
      await getDb()
        .insert(transferRouteVehiclePrices)
        .values([
          {
            routeId,
            vehicleTypeId: activeVehicleTypeId,
            oneWayPriceCentavos: 600_000,
            dayUsePriceCentavos: 900_000,
          },
          {
            routeId,
            vehicleTypeId: inactiveVehicleTypeId,
            oneWayPriceCentavos: 500_000,
            dayUsePriceCentavos: 800_000,
          },
        ]);

      const rows = await caller.transferRoutes.list();
      const row = rows.find((r) => r.id === routeId);
      expect(row).toBeDefined();
      // The active type's ₱6,000 must win — never the inactive type's ₱5,000.
      expect(row!.pageTitle).toContain('6,000');
      expect(row!.pageTitle).not.toContain('5,000');

      const forwardMeta = await resolvePage(`/transfers/${slug}`);
      expect(row!.pageTitle).toBe(forwardMeta.title);
    } finally {
      await cleanup();
    }
  });
});
