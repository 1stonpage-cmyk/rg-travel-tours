/**
 * `transferRoutes.list` — the PUBLIC transfer-route catalog
 * (transfers-launch plan, File Structure: `routers/public/transfers.ts`).
 * Restructured 2026-11-08 (owner decision: flexible places/routes/vehicle
 * types — see `docs/superpowers/plans/2026-11-08-flexible-routes.md` §2/§4).
 *
 * This router is mounted at the TOP level, beside `tours` and `packages`
 * — this project's public routers are not nested under a `public.*`
 * namespace (see `_app.ts`).
 *
 * The public `vehicleTypes.list` procedure this file used to also export was
 * removed (owner decision 2026-11-09, decision 4): confirmed unused — the
 * public booking UI resolves every vehicle type a guest needs from this
 * router's own `vehiclePrices` array, and nothing else called it. The admin
 * `admin.vehicleTypes.*` router (`routers/admin/vehicle-types.ts`) is
 * unrelated and unaffected.
 *
 * **Two independent soft-delete filters on the route, both meaning what
 * they say.** Only `transfer_routes.is_active` routes are listed, and only
 * routes whose FROM and TO place are both active — the retargeted "0D" rule
 * (owner decision 2026-11-08; `services/transfers/pricing.ts`'s
 * `vehiclePriceForRouteAndType` checks the SAME two places, so neither
 * surface relies on the other having filtered first).
 *
 * **The public visibility rule for which vehicle types to show (owner
 * decision 2026-11-08, design note §4):** a type is OFFERED on a route only
 * when (a) a price row exists for that `(route, vehicleTypeId)` pair AND
 * (b) the fleet has at least one sellable vehicle of that type RIGHT NOW.
 * (b) reuses `sellableVehiclesByType()` rather than a second fleet count —
 * see that function's own doc comment for why it is the one function in
 * `services/transfers/capacity.ts` allowed to default to the pool instead of
 * requiring a transaction: this is a read-only, unlocked public list, never
 * a capacity decision.
 *
 * No admin-only field reaches the wire: `isActive` and `sortOrder` are both
 * absent from `TransferRoutePublicRow` (`sortOrder` still ORDERS the list;
 * it is simply not a number a guest is shown).
 *
 * Three queries for the route list, never one per route — the admin list's
 * own shape, for the same reason: a price/fleet read per row would be an
 * N+1 against tables whose whole purpose is to be read beside their parent.
 */
import type { TransferRoutePublicRow, TransferRoutePublicVehiclePrice } from '@rg/shared';
import { and, asc, eq, inArray } from 'drizzle-orm';
import { alias } from 'drizzle-orm/mysql-core';
import { getDb } from '../../db/client';
import {
  transferPlaces,
  transferRouteVehiclePrices,
  transferRoutes,
  vehicleTypes,
} from '../../db/schema';
import { sellableVehiclesByType } from '../../services/transfers/capacity';
import { publicProcedure, router } from '../../trpc';

/**
 * Two aliases onto the SAME `transfer_places` table — mirrors
 * `services/transfers/pricing.ts`'s own pair, declared separately here for
 * the same reason that file's header gives: each module that needs both
 * sides of a route declares its own.
 */
const fromPlace = alias(transferPlaces, 'fromPlace');
const toPlace = alias(transferPlaces, 'toPlace');

export const transferRoutesRouter = router({
  list: publicProcedure.query(async (): Promise<TransferRoutePublicRow[]> => {
    const db = getDb();
    const rows = await db
      .select({
        id: transferRoutes.id,
        fromPlaceId: fromPlace.id,
        fromPlaceName: fromPlace.name,
        fromPlaceIsAirport: fromPlace.isAirport,
        toPlaceId: toPlace.id,
        toPlaceName: toPlace.name,
        toPlaceIsAirport: toPlace.isAirport,
        reverseEnabled: transferRoutes.reverseEnabled,
        slug: transferRoutes.slug,
        estimatedDurationMinutes: transferRoutes.estimatedDurationMinutes,
        freeCancelHours: transferRoutes.freeCancelHours,
        inclusionsText: transferRoutes.inclusionsText,
        exclusionsText: transferRoutes.exclusionsText,
      })
      .from(transferRoutes)
      // `transfer_routes.from_place_id`/`to_place_id` are both NOT NULL with
      // a RESTRICT foreign key, so an inner join drops nothing a route
      // could have.
      .innerJoin(fromPlace, eq(fromPlace.id, transferRoutes.fromPlaceId))
      .innerJoin(toPlace, eq(toPlace.id, transferRoutes.toPlaceId))
      .where(
        and(
          eq(transferRoutes.isActive, true),
          eq(fromPlace.isActive, true),
          eq(toPlace.isActive, true),
        ),
      )
      // Sort order first, then the destination (to-place) name, so two
      // routes sharing a sort order still come back in the same order on
      // every request — the admin list's own ordering.
      .orderBy(asc(transferRoutes.sortOrder), asc(toPlace.name));

    // `inArray` with an empty list is not a query worth issuing.
    if (rows.length === 0) return [];

    const types = await db
      .select({ id: vehicleTypes.id, name: vehicleTypes.name, slug: vehicleTypes.slug })
      .from(vehicleTypes)
      .where(eq(vehicleTypes.isActive, true))
      .orderBy(asc(vehicleTypes.sortOrder), asc(vehicleTypes.name));

    const priceRows = await db
      .select({
        routeId: transferRouteVehiclePrices.routeId,
        vehicleTypeId: transferRouteVehiclePrices.vehicleTypeId,
        oneWayPriceCentavos: transferRouteVehiclePrices.oneWayPriceCentavos,
        dayUsePriceCentavos: transferRouteVehiclePrices.dayUsePriceCentavos,
      })
      .from(transferRouteVehiclePrices)
      .where(
        inArray(
          transferRouteVehiclePrices.routeId,
          rows.map((row) => row.id),
        ),
      );

    // The ONE fleet count this whole list needs — see this module's header.
    const sellable = await sellableVehiclesByType(db);

    const priceMap = new Map<
      string,
      { oneWayPriceCentavos: number; dayUsePriceCentavos: number }
    >();
    for (const price of priceRows) {
      priceMap.set(`${price.routeId}:${price.vehicleTypeId}`, {
        oneWayPriceCentavos: price.oneWayPriceCentavos,
        dayUsePriceCentavos: price.dayUsePriceCentavos,
      });
    }

    return rows.map((row) => {
      const vehiclePrices: TransferRoutePublicVehiclePrice[] = [];
      for (const type of types) {
        const price = priceMap.get(`${row.id}:${type.id}`);
        if (!price) continue; // Not offered on this route — see §4's rule.
        if ((sellable.get(type.id) ?? 0) < 1) continue; // Priced, but nothing to sell right now.
        vehiclePrices.push({
          vehicleTypeId: type.id,
          vehicleTypeName: type.name,
          slug: type.slug,
          ...price,
        });
      }
      return {
        id: row.id,
        fromPlace: {
          id: row.fromPlaceId,
          name: row.fromPlaceName,
          isAirport: row.fromPlaceIsAirport,
        },
        toPlace: { id: row.toPlaceId, name: row.toPlaceName, isAirport: row.toPlaceIsAirport },
        reverseEnabled: row.reverseEnabled,
        slug: row.slug,
        estimatedDurationMinutes: row.estimatedDurationMinutes,
        freeCancelHours: row.freeCancelHours,
        inclusionsText: row.inclusionsText,
        exclusionsText: row.exclusionsText,
        vehiclePrices,
      };
    });
  }),
});
