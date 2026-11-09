/**
 * Task 1G — the demo transfer catalog (vehicle types, places, routes and
 * their price cards), app-database only
 * (docs/superpowers/plans/2026-11-08-flexible-routes.md §1G). Two
 * guarantees:
 *
 *  1. The writer functions produce exactly the owner-given catalog: 4
 *     routes from the one seeded airport place, and MPV priced on Cebu
 *     City's route ONLY — not Moalboal, Oslob or Hagnaya Port.
 *  2. `seedDemo('test')` (and therefore `seed('test')`, which calls it)
 *     writes NONE of this. The app-only gate actually holds, proven the
 *     same way `upsertItineraryStops`'s own app-only gate is proven in
 *     `seed-itinerary.test.ts`: call the real function against the test
 *     database and assert it left nothing behind.
 *
 * ## Why this calls the writers directly rather than `seedDemo('app')`
 *
 * Under Vitest every connection resolves to `TEST_DATABASE_URL`
 * (`db/client.ts`'s `resolveDatabaseUrl()`) regardless of which `context` a
 * caller passes. Calling `seedDemo('app')` here would therefore connect to
 * `rg_travel_test` while asking `guardAndConnect` to assert it is named
 * `rg_travel` — a guaranteed `DB_WRONG_DATABASE` refusal, not a real
 * exercise of the app-only code. So this file calls
 * `upsertDemoVehicleTypes`/`upsertDemoTransferPlaces`/
 * `upsertDemoTransferRoutes` directly against `getDb()`, the same "borrow
 * the table for one run, give it back in a `finally`" pattern every other
 * app-only seed writer in this codebase is tested with.
 *
 * Test files run one at a time (`fileParallelism: false`), and this file
 * restores every row it touches — including `vehicle_types.van`/`.suv`'s
 * `default_seats`/`default_luggage`, which the first test may fill in if a
 * prior run left them `NULL` — so nothing here leaks into a later file.
 */
import { afterAll, expect, it } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import { getDb } from '../db/client';
import {
  transferPlaces,
  transferRouteVehiclePrices,
  transferRoutes,
  vehicleTypes,
} from '../db/schema';
import {
  seedDemo,
  upsertDemoTransferPlaces,
  upsertDemoTransferRoutes,
  upsertDemoVehicleTypes,
} from '../db/seed';
import {
  SEED_TRANSFER_AIRPORT_NAME,
  SEED_TRANSFER_PLACES,
  SEED_TRANSFER_ROUTES,
} from '../db/seed-data';
import { describeWithDb } from './helpers/db';
import { resetTestDb } from './helpers/test-db';

const AIRPORT_NAME_KEY = SEED_TRANSFER_AIRPORT_NAME.trim().toLowerCase();
const PLACE_NAME_KEYS = SEED_TRANSFER_PLACES.map((place) => place.name.trim().toLowerCase());
const ROUTE_SLUGS = SEED_TRANSFER_ROUTES.map((route) => route.slug);

/**
 * Deletes exactly what this file's own writers could have created —
 * matched by the same natural keys the writers themselves use — and
 * nothing else. Safe to call even when nothing was created (every delete is
 * scoped to an `inArray`/`eq` that simply matches zero rows).
 */
async function cleanupDemoTransferCatalog(): Promise<void> {
  const db = getDb();
  const routeRows = await db
    .select({ id: transferRoutes.id })
    .from(transferRoutes)
    .where(inArray(transferRoutes.slug, ROUTE_SLUGS));
  const routeIds = routeRows.map((row) => row.id);
  if (routeIds.length > 0) {
    await db
      .delete(transferRouteVehiclePrices)
      .where(inArray(transferRouteVehiclePrices.routeId, routeIds));
    await db.delete(transferRoutes).where(inArray(transferRoutes.id, routeIds));
  }
  await db.delete(transferPlaces).where(inArray(transferPlaces.nameKey, PLACE_NAME_KEYS));
  await db.delete(vehicleTypes).where(eq(vehicleTypes.slug, 'mpv'));
}

afterAll(async () => {
  await cleanupDemoTransferCatalog();
  await resetTestDb();
});

describeWithDb('seedDemo transfer catalog writers (Task 1G)', () => {
  it('writes exactly 4 routes from the seeded airport, with MPV priced on Cebu City only', async () => {
    const db = getDb();

    // `upsertDemoVehicleTypes` fills `van`/`suv`'s defaults only if they are
    // currently NULL — captured here so the `finally` can put back whatever
    // was really there, leaving no trace on a table this file does not own.
    const originalDefaults = await db
      .select({
        slug: vehicleTypes.slug,
        defaultSeats: vehicleTypes.defaultSeats,
        defaultLuggage: vehicleTypes.defaultLuggage,
      })
      .from(vehicleTypes)
      .where(inArray(vehicleTypes.slug, ['van', 'suv']));

    try {
      const vehicleTypeIdBySlug = await upsertDemoVehicleTypes(db);
      const placeIdByNameKey = await upsertDemoTransferPlaces(db);
      await upsertDemoTransferRoutes(db, placeIdByNameKey, vehicleTypeIdBySlug);

      const airportId = placeIdByNameKey.get(AIRPORT_NAME_KEY);
      expect(airportId, 'the airport place was not created').toBeDefined();

      const routes = await db
        .select({ id: transferRoutes.id, toPlaceId: transferRoutes.toPlaceId })
        .from(transferRoutes)
        .where(eq(transferRoutes.fromPlaceId, airportId!));
      expect(routes, 'exactly 4 demo routes must exist from the airport place').toHaveLength(4);

      // MPV priced on Cebu City's route, and ONLY that one — not Moalboal,
      // Oslob or Hagnaya Port.
      const mpvId = vehicleTypeIdBySlug.get('mpv');
      expect(mpvId, 'the mpv vehicle type was not created').toBeDefined();
      const mpvPriceRows = await db
        .select({ routeId: transferRouteVehiclePrices.routeId })
        .from(transferRouteVehiclePrices)
        .where(eq(transferRouteVehiclePrices.vehicleTypeId, mpvId!));
      expect(mpvPriceRows, 'MPV must be priced on exactly one route').toHaveLength(1);

      const cebuCityId = placeIdByNameKey.get('cebu city');
      expect(cebuCityId, 'the Cebu City place was not created').toBeDefined();
      const [mpvRoute] = await db
        .select({ toPlaceId: transferRoutes.toPlaceId })
        .from(transferRoutes)
        .where(eq(transferRoutes.id, mpvPriceRows[0]!.routeId));
      expect(mpvRoute?.toPlaceId, 'MPV must be priced on the Cebu City route specifically').toBe(
        cebuCityId,
      );

      // Idempotent: re-running the same writers must restate the same 4
      // routes, never duplicate them.
      await upsertDemoTransferRoutes(db, placeIdByNameKey, vehicleTypeIdBySlug);
      const afterRerun = await db
        .select({ id: transferRoutes.id })
        .from(transferRoutes)
        .where(eq(transferRoutes.fromPlaceId, airportId!));
      expect(afterRerun, 're-running the seed must not duplicate routes').toHaveLength(4);
    } finally {
      await cleanupDemoTransferCatalog();
      for (const row of originalDefaults) {
        await db
          .update(vehicleTypes)
          .set({ defaultSeats: row.defaultSeats, defaultLuggage: row.defaultLuggage })
          .where(eq(vehicleTypes.slug, row.slug));
      }
    }
  });
});

describeWithDb('the test-context seed (seedDemo app-only gate, Task 1G)', () => {
  it('seedDemo("test") writes no transfer place, route, price row or mpv vehicle type', async () => {
    try {
      await seedDemo('test');

      const places = await getDb()
        .select({ id: transferPlaces.id })
        .from(transferPlaces)
        .where(inArray(transferPlaces.nameKey, PLACE_NAME_KEYS));
      expect(places, 'seedDemo("test") must not create any demo transfer place').toHaveLength(0);

      const routes = await getDb()
        .select({ id: transferRoutes.id })
        .from(transferRoutes)
        .where(inArray(transferRoutes.slug, ROUTE_SLUGS));
      expect(routes, 'seedDemo("test") must not create any demo transfer route').toHaveLength(0);

      const mpv = await getDb()
        .select({ id: vehicleTypes.id })
        .from(vehicleTypes)
        .where(eq(vehicleTypes.slug, 'mpv'));
      expect(mpv, 'seedDemo("test") must not create an mpv vehicle type').toHaveLength(0);
    } finally {
      await cleanupDemoTransferCatalog();
    }
  });
});
