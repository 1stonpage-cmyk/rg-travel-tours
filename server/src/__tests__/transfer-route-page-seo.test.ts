/**
 * Task 8 (SEO fixes, 2026-11-24) — direction-specific transfer route landing
 * pages: the loader (`loadTransferRouteSeo`), the title/description
 * formulas, and the two new JSON-LD node builders (`serviceNode`,
 * `breadcrumbListNode`). Resolver-level (`resolvePage('/transfers/:slug')`)
 * and sitemap-level assertions live in `seo-resolvers.test.ts` and
 * `sitemap-robots.test.ts` respectively, per this task's own file split.
 */
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { reverseTransferRouteSlug } from '@rg/shared';
import { getDb } from '../db/client';
import {
  destinations,
  transferPlaces,
  transferRouteVehiclePrices,
  transferRoutes,
  vans,
  vehicleTypes,
} from '../db/schema';
import { SEED_TRANSFER_AIRPORT_NAME, SEED_TRANSFER_ROUTES } from '../db/seed-data';
import {
  loadTransferRouteSeo,
  transferRouteDescription,
  transferRouteTitle,
  type TransferRouteSeoRow,
} from '../seo/resolvers';
import { breadcrumbListNode, serviceNode } from '../seo/jsonld';
import { describeWithDb } from './helpers/db';

// ---------------------------------------------------------------------------
// Fixtures — self-contained, cleaned up after every test that creates them.
// ---------------------------------------------------------------------------

const unique = () => `${Math.floor(Math.random() * 1e9)}_${Date.now()}`;

const created = {
  placeIds: [] as number[],
  routeIds: [] as number[],
  vanIds: [] as number[],
  vehicleTypeIds: [] as number[],
  destinationIds: [] as number[],
};

async function makeVehicleType(): Promise<number> {
  const suffix = unique();
  const [row] = await getDb()
    .insert(vehicleTypes)
    .values({ name: `Fixture Vehicle ${suffix}`, slug: `seo-fixture-${suffix}`.slice(0, 40) });
  created.vehicleTypeIds.push(row.insertId);
  return row.insertId;
}

/**
 * The real, global `vehicle_types.id` for a slug, or null when this
 * database does not carry it. `rg_travel_test` keeps only the backfilled
 * `van`/`suv` rows (migration 0023) — `mpv` (seeded in the recipe for
 * `mactan-airport-to-cebu-city`) does not exist here, so a caller building a
 * fixture from the recipe data skips that one price row rather than
 * inventing a vehicle type.
 */
async function vehicleTypeIdBySlug(slug: string): Promise<number | null> {
  const [row] = await getDb()
    .select({ id: vehicleTypes.id })
    .from(vehicleTypes)
    .where(eq(vehicleTypes.slug, slug));
  return row?.id ?? null;
}

async function makeDestination(imagePath: string | null = null): Promise<number> {
  const slug = `__seo-route-fixture__${unique()}`;
  const [row] = await getDb()
    .insert(destinations)
    .values({ name: slug, slug, imagePath: imagePath ?? undefined });
  created.destinationIds.push(row.insertId);
  return row.insertId;
}

async function makePlace(
  opts: { name?: string; destinationId?: number | null } = {},
): Promise<number> {
  const name = opts.name ?? `Fixture Place ${unique()}`;
  const [row] = await getDb()
    .insert(transferPlaces)
    .values({
      name,
      nameKey: name.trim().toLowerCase(),
      destinationId: opts.destinationId ?? null,
    });
  created.placeIds.push(row.insertId);
  return row.insertId;
}

async function makeRoute(opts: {
  slug?: string;
  fromPlaceId: number;
  toPlaceId: number;
  reverseEnabled?: boolean;
  durationMinutes?: number;
}): Promise<{ id: number; slug: string }> {
  const slug = opts.slug ?? `seo-fixture-route-to-${unique()}`;
  const [row] = await getDb()
    .insert(transferRoutes)
    .values({
      fromPlaceId: opts.fromPlaceId,
      toPlaceId: opts.toPlaceId,
      slug,
      reverseEnabled: opts.reverseEnabled ?? true,
      estimatedDurationMinutes: opts.durationMinutes ?? 120,
      freeCancelHours: 24,
    });
  created.routeIds.push(row.insertId);
  return { id: row.insertId, slug };
}

async function makeVan(
  vehicleTypeId: number,
  status: 'available' | 'for_repair' = 'available',
): Promise<number> {
  const [row] = await getDb()
    .insert(vans)
    .values({
      plate: `SEO${unique()}`.slice(0, 20),
      model: 'SEO Route Fixture',
      capacity: 10,
      vehicleTypeId,
      status,
      isActive: true,
    });
  created.vanIds.push(row.insertId);
  return row.insertId;
}

async function cleanup(): Promise<void> {
  const db = getDb();
  for (const id of created.vanIds.splice(0)) {
    await db.delete(vans).where(eq(vans.id, id));
  }
  for (const id of created.routeIds.splice(0)) {
    await db.delete(transferRouteVehiclePrices).where(eq(transferRouteVehiclePrices.routeId, id));
    await db.delete(transferRoutes).where(eq(transferRoutes.id, id));
  }
  for (const id of created.placeIds.splice(0)) {
    await db.delete(transferPlaces).where(eq(transferPlaces.id, id));
  }
  for (const id of created.destinationIds.splice(0)) {
    await db.delete(destinations).where(eq(destinations.id, id));
  }
  for (const id of created.vehicleTypeIds.splice(0)) {
    await db.delete(vehicleTypes).where(eq(vehicleTypes.id, id));
  }
}

// ---------------------------------------------------------------------------
// Step 2b: the stability rule
// ---------------------------------------------------------------------------

describeWithDb('loadTransferRouteSeo — price stability', () => {
  it('cheapestOneWayCentavos (and therefore the title/description) does not change when the whole fleet is unsellable', async () => {
    try {
      const vehicleTypeId = await makeVehicleType();
      const fromPlaceId = await makePlace({ name: `Fixture Origin ${unique()}` });
      const toPlaceId = await makePlace({ name: `Fixture Destination ${unique()}` });
      const { id: routeId, slug } = await makeRoute({ fromPlaceId, toPlaceId });
      await getDb().insert(transferRouteVehiclePrices).values({
        routeId,
        vehicleTypeId,
        oneWayPriceCentavos: 123_456,
        dayUsePriceCentavos: 200_000,
      });
      const vanId = await makeVan(vehicleTypeId, 'available');

      const before = await loadTransferRouteSeo(slug);
      expect(before).not.toBeNull();
      expect(before!.cheapestOneWayCentavos).toBe(123_456);

      await getDb().update(vans).set({ status: 'for_repair' }).where(eq(vans.id, vanId));

      const after = await loadTransferRouteSeo(slug);
      expect(after).not.toBeNull();
      expect(after!.cheapestOneWayCentavos).toBe(before!.cheapestOneWayCentavos);
      expect(transferRouteTitle(after!)).toBe(transferRouteTitle(before!));
    } finally {
      await cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// Step 2c: the direction match itself
// ---------------------------------------------------------------------------

describeWithDb('loadTransferRouteSeo — direction match', () => {
  /**
   * `rg_travel_test` is deliberately kept at zero `transfer_places`/
   * `transfer_routes` rows (same discipline as the fleet — this project's
   * seed gates both to the APP database only; see `db/seed.ts`'s own
   * comments and `seed-demo-transfer-bookings.test.ts`'s header for why).
   * So this builds its own fixture route — `mactan-airport-to-moalboal`
   * does not exist in this database — rather than depending on
   * `SEED_TRANSFER_ROUTES` actually being present here.
   */
  it('resolves the forward slug and the reverse slug to the two opposite directions of the SAME route', async () => {
    try {
      const fromPlaceId = await makePlace({ name: `Direction Match Origin ${unique()}` });
      const toPlaceId = await makePlace({ name: `Direction Match Destination ${unique()}` });
      const vehicleTypeId = await makeVehicleType();
      const { id: routeId, slug } = await makeRoute({ fromPlaceId, toPlaceId });
      await getDb().insert(transferRouteVehiclePrices).values({
        routeId,
        vehicleTypeId,
        oneWayPriceCentavos: 570_000,
        dayUsePriceCentavos: 800_000,
      });

      const forward = await loadTransferRouteSeo(slug);
      const reverse = await loadTransferRouteSeo(reverseTransferRouteSlug(slug));
      expect(forward).not.toBeNull();
      expect(reverse).not.toBeNull();
      expect(forward!.id).toBe(reverse!.id);
      expect(forward!.direction).toBe('forward');
      expect(reverse!.direction).toBe('reverse');
      // The load-bearing proof: names are genuinely swapped, not coincidentally equal.
      expect(forward!.fromPlaceName).toBe(reverse!.toPlaceName);
      expect(forward!.toPlaceName).toBe(reverse!.fromPlaceName);
      expect(forward!.fromPlaceName).not.toBe(forward!.toPlaceName);
      // Price/duration are the same product either way.
      expect(forward!.cheapestOneWayCentavos).toBe(reverse!.cheapestOneWayCentavos);
      expect(forward!.estimatedDurationMinutes).toBe(reverse!.estimatedDurationMinutes);
    } finally {
      await cleanup();
    }
  });

  it('a route with reverseEnabled=false has no reverse page', async () => {
    try {
      const fromPlaceId = await makePlace({ name: `One Way Origin ${unique()}` });
      const toPlaceId = await makePlace({ name: `One Way Destination ${unique()}` });
      const { slug } = await makeRoute({ fromPlaceId, toPlaceId, reverseEnabled: false });

      const forward = await loadTransferRouteSeo(slug);
      expect(forward).not.toBeNull();
      expect(forward!.reverseEnabled).toBe(false);

      const reverse = await loadTransferRouteSeo(reverseTransferRouteSlug(slug));
      expect(reverse).toBeNull();
    } finally {
      await cleanup();
    }
  });

  it("the dropoff place's linked destination photo swaps by direction", async () => {
    try {
      const fromDestId = await makeDestination('/placeholders/fixture-from.svg');
      const toDestId = await makeDestination('/placeholders/fixture-to.svg');
      const fromPlaceId = await makePlace({
        name: `Image Origin ${unique()}`,
        destinationId: fromDestId,
      });
      const toPlaceId = await makePlace({
        name: `Image Destination ${unique()}`,
        destinationId: toDestId,
      });
      const { slug } = await makeRoute({ fromPlaceId, toPlaceId });

      const forward = await loadTransferRouteSeo(slug);
      expect(forward!.imagePath).toBe('/placeholders/fixture-to.svg');

      const reverse = await loadTransferRouteSeo(reverseTransferRouteSlug(slug));
      expect(reverse!.imagePath).toBe('/placeholders/fixture-from.svg');
    } finally {
      await cleanup();
    }
  });

  it('returns null for an inactive route and for an unknown slug', async () => {
    try {
      const fromPlaceId = await makePlace({ name: `Inactive Origin ${unique()}` });
      const toPlaceId = await makePlace({ name: `Inactive Destination ${unique()}` });
      const { slug } = await makeRoute({ fromPlaceId, toPlaceId });
      await getDb()
        .update(transferRoutes)
        .set({ isActive: false })
        .where(eq(transferRoutes.slug, slug));

      expect(await loadTransferRouteSeo(slug)).toBeNull();
      expect(await loadTransferRouteSeo('no-such-route-at-all')).toBeNull();
    } finally {
      await cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// Step 3: title / description — brief fixtures plus real seeded data,
// both directions.
// ---------------------------------------------------------------------------

describe('transferRouteTitle', () => {
  it('keeps the title at or under 60 chars, dropping the price clause first', () => {
    const row = {
      fromPlaceName: 'Mactan-Cebu International Airport',
      toPlaceName: 'Moalboal Town Proper',
      cheapestOneWayCentavos: 250_000,
    } as TransferRouteSeoRow;
    const title = transferRouteTitle(row);
    expect(title.length).toBeLessThanOrEqual(60);
    expect(title).toContain('Mactan-Cebu International Airport');
  });

  it('the reverse direction gets its own, genuinely different title', () => {
    const forward = {
      fromPlaceName: 'Mactan Airport',
      toPlaceName: 'Moalboal',
      cheapestOneWayCentavos: 570_000,
    } as TransferRouteSeoRow;
    const reverse = {
      fromPlaceName: 'Moalboal',
      toPlaceName: 'Mactan Airport',
      cheapestOneWayCentavos: 570_000,
    } as TransferRouteSeoRow;
    expect(transferRouteTitle(forward)).not.toBe(transferRouteTitle(reverse));
    expect(transferRouteTitle(reverse)).toContain('Moalboal to Mactan Airport');
  });
});

describe('transferRouteDescription', () => {
  it('description is 140-160 chars and names the real duration and price', () => {
    const row = {
      fromPlaceName: 'Airport',
      toPlaceName: 'Moalboal',
      estimatedDurationMinutes: 150,
      cheapestOneWayCentavos: 250_000,
      freeCancelHours: 24,
    } as TransferRouteSeoRow;
    const desc = transferRouteDescription(row);
    expect(desc.length).toBeGreaterThanOrEqual(140);
    expect(desc.length).toBeLessThanOrEqual(160);
    expect(desc).toContain('2 hr 30 min');
  });
});

/**
 * Every `SEED_TRANSFER_ROUTES` slug round-trips through
 * `reverseTransferRouteSlug` twice back to itself — the self-review
 * requirement, over the REAL catalog rather than one hand-picked example
 * (`shared/src/__tests__/transfers.test.ts` covers the one example; `shared`
 * cannot import `db/seed-data`, so the full-catalog sweep lives here).
 */
describe('reverseTransferRouteSlug — round-trips every seeded route slug', () => {
  it.each(SEED_TRANSFER_ROUTES.map((r) => r.slug))('%s', (slug) => {
    expect(reverseTransferRouteSlug(reverseTransferRouteSlug(slug))).toBe(slug);
  });
});

/**
 * The bound checks above use the brief's own fixtures. This is the
 * self-review requirement: the same bounds, against the REAL
 * `SEED_TRANSFER_ROUTES`/`SEED_TRANSFER_PLACES` names, durations and
 * prices, BOTH directions — not only hand-picked fixtures.
 *
 * `rg_travel_test` has no `transfer_routes` rows of its own (see the
 * direction-match block above), so this block builds its OWN fixture row
 * per recipe, using the exact real place names, durations and per-vehicle
 * prices `SEED_TRANSFER_ROUTES`/`SEED_TRANSFER_PLACES` define — genuinely
 * the real catalog's data, just not depending on it already being seeded
 * into this database.
 */
describeWithDb(
  'transferRouteTitle / transferRouteDescription — real catalog names, durations and prices, both directions',
  () => {
    const fixtureSlugByRecipeSlug = new Map<string, string>();

    beforeAll(async () => {
      const db = getDb();
      const airportPlaceId = await makePlace({ name: SEED_TRANSFER_AIRPORT_NAME });
      for (const recipe of SEED_TRANSFER_ROUTES) {
        const toPlaceId = await makePlace({ name: recipe.toPlaceName });
        const fixtureSlug = `fixture-${recipe.slug}-${unique()}`;
        const { id: routeId } = await makeRoute({
          slug: fixtureSlug,
          fromPlaceId: airportPlaceId,
          toPlaceId,
          durationMinutes: recipe.estimatedDurationMinutes,
        });
        for (const price of recipe.prices) {
          const vehicleTypeId = await vehicleTypeIdBySlug(price.vehicleTypeSlug);
          if (vehicleTypeId === null) continue; // e.g. 'mpv' — not backfilled into rg_travel_test
          await db.insert(transferRouteVehiclePrices).values({
            routeId,
            vehicleTypeId,
            oneWayPriceCentavos: price.oneWayPricePesos * 100,
            dayUsePriceCentavos: price.dayUsePricePesos * 100,
          });
        }
        fixtureSlugByRecipeSlug.set(recipe.slug, fixtureSlug);
      }
    });

    afterAll(cleanup);

    it.each(SEED_TRANSFER_ROUTES.map((r) => r.slug))(
      '%s — forward and reverse title/description both hold their bounds',
      async (recipeSlug) => {
        const slug = fixtureSlugByRecipeSlug.get(recipeSlug)!;
        const forward = await loadTransferRouteSeo(slug);
        expect(forward, slug).not.toBeNull();
        const forwardTitle = transferRouteTitle(forward!);
        const forwardDesc = transferRouteDescription(forward!);
        expect(forwardTitle.length, `forward title: "${forwardTitle}"`).toBeLessThanOrEqual(60);
        expect(forwardDesc.length, `forward description: "${forwardDesc}"`).toBeGreaterThanOrEqual(
          140,
        );
        expect(forwardDesc.length, `forward description: "${forwardDesc}"`).toBeLessThanOrEqual(
          160,
        );

        const reverseSlug = reverseTransferRouteSlug(slug);
        const reverse = await loadTransferRouteSeo(reverseSlug);
        expect(reverse, reverseSlug).not.toBeNull();
        const reverseTitle = transferRouteTitle(reverse!);
        const reverseDesc = transferRouteDescription(reverse!);
        expect(reverseTitle.length, `reverse title: "${reverseTitle}"`).toBeLessThanOrEqual(60);
        expect(reverseDesc.length, `reverse description: "${reverseDesc}"`).toBeGreaterThanOrEqual(
          140,
        );
        expect(reverseDesc.length, `reverse description: "${reverseDesc}"`).toBeLessThanOrEqual(
          160,
        );

        expect(forwardTitle).not.toBe(reverseTitle);
      },
    );
  },
);

// ---------------------------------------------------------------------------
// Step 4: serviceNode / breadcrumbListNode — pure
// ---------------------------------------------------------------------------

describe('serviceNode', () => {
  const base = {
    name: 'Mactan Airport to Moalboal Private Transfer',
    url: 'https://travelsugbo.com/transfers/mactan-airport-to-moalboal',
    description: 'd',
    imageUrl: null,
    siteUrl: 'https://travelsugbo.com/',
    areaServed: 'Cebu, Philippines',
    offers: [] as { name: string; priceCentavos: number }[],
  };

  it('builds a Service node with the TravelAgency as provider', () => {
    const node = serviceNode(base);
    expect(node['@type']).toBe('Service');
    expect(node.serviceType).toBe('Private transfer');
    expect(node.name).toBe(base.name);
    expect(node.url).toBe(base.url);
    expect((node.provider as Record<string, unknown>)['@id']).toBe(
      'https://travelsugbo.com/#organization',
    );
    expect((node.provider as Record<string, unknown>).name).toBe('TravelSugbo');
  });

  it('omits offers entirely when none are supplied, rather than an empty array', () => {
    const node = serviceNode(base);
    expect(Object.keys(node)).not.toContain('offers');
  });

  it('builds one Offer per offered vehicle type, in PHP', () => {
    const node = serviceNode({
      ...base,
      offers: [{ name: 'Mactan Airport to Moalboal', priceCentavos: 570_000 }],
    });
    const offers = node.offers as Array<Record<string, unknown>>;
    expect(offers).toHaveLength(1);
    expect(offers[0]).toMatchObject({
      '@type': 'Offer',
      price: '5700.00',
      priceCurrency: 'PHP',
      url: base.url,
    });
  });

  it('omits the image key when there is none', () => {
    const node = serviceNode(base);
    expect(Object.keys(node)).not.toContain('image');
  });
});

describe('breadcrumbListNode', () => {
  it('numbers each item by position, in order', () => {
    const node = breadcrumbListNode([
      { name: 'Home', url: 'https://travelsugbo.com/' },
      { name: 'Transfers', url: 'https://travelsugbo.com/transfer' },
      { name: 'Mactan Airport to Moalboal', url: 'https://travelsugbo.com/transfers/x' },
    ]);
    expect(node['@type']).toBe('BreadcrumbList');
    const items = node.itemListElement as Array<Record<string, unknown>>;
    expect(items.map((i) => i.position)).toEqual([1, 2, 3]);
    expect(items[0]).toMatchObject({ '@type': 'ListItem', name: 'Home' });
    expect(items[2]).toMatchObject({ name: 'Mactan Airport to Moalboal' });
  });
});
