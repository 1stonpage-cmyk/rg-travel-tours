/**
 * `transferRoutes.list` — the PUBLIC transfer-route catalog (transfers-launch
 * plan, File Structure: `routers/public/transfers.ts`, `transferRoutes.list
 * (public)`; built in Task T9 because `checkout.quoteTransfer`'s `routeId` has
 * to be obtainable from somewhere public).
 *
 * Mounted at the TOP level as `transferRoutes`, beside `tours`, `packages` and
 * `destinations` — this project's public routers are not nested under a
 * `public.*` namespace (see `_app.ts`), so `transferRoutes.list` is to
 * `admin.transferRoutes.list` exactly what `tours.list` is to
 * `admin.tours.list`.
 *
 * **Two filters, both of them a soft delete meaning what it says.** Only
 * `transfer_routes.is_active` routes are listed, and only routes whose
 * DESTINATION is still active — the same rule `tours.list` enforces (its I1
 * finding: soft-deleting a destination has to hide what hangs off it, or the
 * catalog keeps selling a place the site no longer offers). Retiring either one
 * takes the route off this list, and `vehiclePriceForRouteAndType()` refuses to
 * quote a retired route independently, so neither surface relies on the other.
 *
 * No admin-only field reaches the wire: `isActive`, `destinationId` and
 * `sortOrder` are all absent from `TransferRoutePublicRow`. `sortOrder` still
 * ORDERS the list; it is simply not a number a guest is shown.
 *
 * Two queries, never one per route — the admin `list`'s own shape, for the same
 * reason: a price read per row would be an N+1 against the table whose whole
 * purpose is to be read beside its parent.
 */
import type { TransferRoutePublicRow, TransferVehiclePriceRow, VehicleType } from '@rg/shared';
import { and, asc, eq, inArray } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { destinations, transferRouteVehiclePrices, transferRoutes } from '../../db/schema';
import { publicProcedure, router } from '../../trpc';

/**
 * An empty price card, filled in from whatever rows the database holds.
 *
 * The keys are spelled out rather than built from `VEHICLE_TYPES`, which is
 * what makes a third vehicle type added to that constant a compile error here
 * instead of a silently unpriced vehicle — the same guard `transfers-admin.ts`
 * puts on its own price card.
 */
function emptyPriceCard(): Record<VehicleType, TransferVehiclePriceRow | null> {
  return { van: null, suv: null };
}

export const transferRoutesRouter = router({
  list: publicProcedure.query(async (): Promise<TransferRoutePublicRow[]> => {
    const db = getDb();
    const rows = await db
      .select({
        id: transferRoutes.id,
        destinationName: destinations.name,
        slug: transferRoutes.slug,
        estimatedDurationMinutes: transferRoutes.estimatedDurationMinutes,
        freeCancelHours: transferRoutes.freeCancelHours,
        inclusionsText: transferRoutes.inclusionsText,
        exclusionsText: transferRoutes.exclusionsText,
      })
      .from(transferRoutes)
      // `transfer_routes.destination_id` is NOT NULL with a RESTRICT foreign
      // key, so a route without a destination cannot exist — an inner join
      // invites no nullable column here (the admin list's own note).
      .innerJoin(destinations, eq(destinations.id, transferRoutes.destinationId))
      .where(and(eq(transferRoutes.isActive, true), eq(destinations.isActive, true)))
      // Sort order first, then the destination's name, so two routes sharing a
      // sort order still come back in the same order on every request — the
      // admin list's ordering, so the office and the guest see one sequence.
      .orderBy(asc(transferRoutes.sortOrder), asc(destinations.name));

    // `inArray` with an empty list is not a query worth issuing.
    if (rows.length === 0) return [];

    const priceRows = await db
      .select({
        routeId: transferRouteVehiclePrices.routeId,
        vehicleType: transferRouteVehiclePrices.vehicleType,
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

    const cards = new Map<number, Record<VehicleType, TransferVehiclePriceRow | null>>();
    for (const row of rows) cards.set(row.id, emptyPriceCard());
    for (const price of priceRows) {
      const card = cards.get(price.routeId);
      // Scoped to these ids, so this cannot happen — read back defensively
      // only to keep the map lookup from being an unchecked index.
      if (!card) continue;
      card[price.vehicleType] = {
        oneWayPriceCentavos: price.oneWayPriceCentavos,
        dayUsePriceCentavos: price.dayUsePriceCentavos,
      };
    }

    return rows.map((row) => ({ ...row, prices: cards.get(row.id) ?? emptyPriceCard() }));
  }),
});
