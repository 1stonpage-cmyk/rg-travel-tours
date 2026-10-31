/**
 * `admin.transferRoutes.*` — the private-transfer route catalog and its
 * per-vehicle-type prices (transfers-launch plan, Task T3; Architecture §1 and
 * §5).
 *
 * Every procedure is `adminProcedure('toursPricing')` — §9's "Tours, pricing,
 * coupons" row, which is **owner only**, the same area `admin.tours.*` and
 * `admin.coupons.*` use. The plan reuses it rather than adding a thirteenth
 * area on purpose (Architecture §5: "unchanged area, owner-only"): a per-route
 * transfer price is the number a guest is actually charged for a van, exactly
 * as a tour's per-person tier is, so it belongs behind the narrowest row in the
 * matrix and not beside it. A dispatcher and a finance user are both refused by
 * the GATE, not by a resolver finding nothing to do.
 *
 * There is deliberately **no delete mutation**, and nothing here deletes a
 * route. A route is retired through `setActive(false)` (CLAUDE.md, "Soft
 * deletes"), which keeps it on this list — the only screen a retired route is
 * visible on, and therefore the only place it can be switched back on. Its
 * price rows are never deleted independently of it either: they live and die
 * with the route through the upsert's delete-then-reinsert, which only ever
 * touches rows for a route that still exists.
 *
 * One transaction per mutation, opened here, with `writeAudit` inside it — an
 * audit row that survives a rollback claims a price change that never happened.
 */
import { TRPCError } from '@trpc/server';
import {
  VEHICLE_TYPES,
  transferRouteActiveInputSchema,
  transferRouteCreateInputSchema,
  transferRouteUpdateInputSchema,
  type TransferRouteAdminRow,
  type TransferRoutePricesInput,
  type TransferRouteVehiclePriceRow,
  type VehicleType,
} from '@rg/shared';
import { asc, eq, inArray } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { destinations, transferRouteVehiclePrices, transferRoutes } from '../../db/schema';
import { writeAudit } from '../../services/audit';
import {
  UNKNOWN_TRANSFER_ROUTE_MESSAGE,
  mergeTransferRoutePatch,
  upsertTransferRoute,
} from '../../services/transfers/upsert-route';
import { adminProcedure, router } from '../../trpc';

/**
 * The refusal for an `update` that would have to GUESS a price.
 *
 * It can only fire for a route whose price rows went missing behind the
 * upsert's back — a hand-written INSERT, a half-applied migration — because
 * every save through this router writes both. The alternative to refusing is
 * merging a fabricated figure (a zero, or the other vehicle type's price) into
 * a money column, which is worse than saying so.
 */
function missingPricesMessage(vehicleTypes: readonly VehicleType[]): string {
  return (
    `This route has no stored price for: ${vehicleTypes.join(', ')}. ` +
    'Include both vehicle types’ prices in this save.'
  );
}

/** An empty price card, filled in from whatever rows the database holds. */
function emptyPriceCard(): Record<VehicleType, TransferRouteVehiclePriceRow | null> {
  return { van: null, suv: null };
}

export const adminTransferRoutesRouter = router({
  /**
   * Every route, **inactive ones included**, each with its destination's name
   * and both price rows.
   *
   * Two queries, never one per route: the routes joined to `destinations`, then
   * one `IN (…)` sweep of the price rows for the ids that came back. A price
   * read per row would be an N+1 against the table whose whole purpose is to be
   * read beside its parent.
   *
   * The join to `destinations` is an `innerJoin` because
   * `transfer_routes.destination_id` is `NOT NULL` with a RESTRICT foreign key
   * — a route without a destination cannot exist, so a `LEFT JOIN` would only
   * invite a nullable column nobody can produce.
   *
   * Ordered by `sort_order` then the destination's name, so two routes sharing
   * a sort order still come back in the same order on every run.
   */
  list: adminProcedure('toursPricing').query(async (): Promise<TransferRouteAdminRow[]> => {
    const db = getDb();
    const rows = await db
      .select({
        id: transferRoutes.id,
        destinationId: transferRoutes.destinationId,
        destinationName: destinations.name,
        slug: transferRoutes.slug,
        isActive: transferRoutes.isActive,
        sortOrder: transferRoutes.sortOrder,
        estimatedDurationMinutes: transferRoutes.estimatedDurationMinutes,
        freeCancelHours: transferRoutes.freeCancelHours,
        inclusionsText: transferRoutes.inclusionsText,
        exclusionsText: transferRoutes.exclusionsText,
      })
      .from(transferRoutes)
      .innerJoin(destinations, eq(destinations.id, transferRoutes.destinationId))
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

    const cards = new Map<number, Record<VehicleType, TransferRouteVehiclePriceRow | null>>();
    for (const row of rows) cards.set(row.id, emptyPriceCard());
    for (const price of priceRows) {
      const card = cards.get(price.routeId);
      // A price row for a route this query did not select cannot happen (the
      // sweep is scoped to these ids), but reading it back defensively keeps
      // the map lookup from being an unchecked index.
      if (!card) continue;
      card[price.vehicleType] = {
        oneWayPriceCentavos: price.oneWayPriceCentavos,
        dayUsePriceCentavos: price.dayUsePriceCentavos,
      };
    }

    return rows.map((row) => ({ ...row, prices: cards.get(row.id) ?? emptyPriceCard() }));
  }),

  /**
   * A new route and its whole price card, in one transaction.
   *
   * The audit payload names the destination, the slug AND the prices. The
   * prices are the point: the plan's Global Constraints put `audit_log` on
   * "every money movement, status change, assignment, and price CHANGE", and a
   * route's creation is the first price it ever had. Nothing here is sensitive
   * — `transfer_routes` holds no personal data, no hash and no token.
   */
  create: adminProcedure('toursPricing')
    .input(transferRouteCreateInputSchema)
    .mutation(async ({ input, ctx }) => {
      const id = await getDb().transaction(async (tx) => {
        const result = await upsertTransferRoute(tx, input);
        await writeAudit(tx, {
          actorType: 'user',
          actorId: ctx.adminSession.subjectId,
          action: 'transfer_route_created',
          entity: 'transfer_route',
          entityId: result.id,
          data: { destinationId: input.destinationId, slug: input.slug, prices: input.prices },
        });
        return result.id;
      });
      return { id };
    }),

  /**
   * A patch over a stored route — the only procedure in this file that READS
   * before it writes, and the reason the read is a locking one.
   *
   * `transferRoutePatchSchema` is shallow, so `prices` is either a complete
   * card or absent. An absent one has to be filled in from what is stored, and
   * a read-modify-write of a money column needs the row held for the whole of
   * it: two owners saving different fields of the same route at once would
   * otherwise each merge over the state they read first, and the loser's price
   * edit would vanish with no error. So the route row is taken `FOR UPDATE`
   * **before** anything else in this transaction reads anything — CLAUDE.md's
   * "take the lock BEFORE reading" rule, which exists because under REPEATABLE
   * READ a plain `SELECT` taken first pins a snapshot the lock cannot refresh.
   * The price rows are locked the same way, for the same reason: they are what
   * the merge reads and what the upsert is about to replace.
   *
   * The audit payload is `input.patch` — exactly what changed and nothing else,
   * the shape `admin.vans.update` uses. An update that does not mention prices
   * therefore records no prices, which is correct: none changed.
   */
  update: adminProcedure('toursPricing')
    .input(transferRouteUpdateInputSchema)
    .mutation(async ({ input, ctx }) => {
      await getDb().transaction(async (tx) => {
        const [stored] = await tx
          .select({
            destinationId: transferRoutes.destinationId,
            slug: transferRoutes.slug,
            estimatedDurationMinutes: transferRoutes.estimatedDurationMinutes,
            freeCancelHours: transferRoutes.freeCancelHours,
            inclusionsText: transferRoutes.inclusionsText,
            exclusionsText: transferRoutes.exclusionsText,
          })
          .from(transferRoutes)
          .where(eq(transferRoutes.id, input.id))
          .for('update');
        if (!stored) {
          throw new TRPCError({ code: 'NOT_FOUND', message: UNKNOWN_TRANSFER_ROUTE_MESSAGE });
        }

        const storedPriceRows = await tx
          .select({
            vehicleType: transferRouteVehiclePrices.vehicleType,
            oneWayPriceCentavos: transferRouteVehiclePrices.oneWayPriceCentavos,
            dayUsePriceCentavos: transferRouteVehiclePrices.dayUsePriceCentavos,
          })
          .from(transferRouteVehiclePrices)
          .where(eq(transferRouteVehiclePrices.routeId, input.id))
          .for('update');

        const card = emptyPriceCard();
        for (const price of storedPriceRows) {
          card[price.vehicleType] = {
            oneWayPriceCentavos: price.oneWayPriceCentavos,
            dayUsePriceCentavos: price.dayUsePriceCentavos,
          };
        }

        /*
         * Fail closed rather than merge a price nobody set. Only reachable for
         * a route written around the upsert; see `missingPricesMessage`.
         */
        const missing = VEHICLE_TYPES.filter((vehicleType) => card[vehicleType] === null);
        if (input.patch.prices === undefined && missing.length > 0) {
          throw new TRPCError({ code: 'CONFLICT', message: missingPricesMessage(missing) });
        }

        const merged = mergeTransferRoutePatch(
          {
            ...stored,
            /*
             * The cast is discharged by the refusal immediately above: when
             * the patch omits `prices`, every vehicle type has a stored row,
             * so the card really is complete. When the patch SUPPLIES prices,
             * `mergeTransferRoutePatch` never reads this field at all.
             *
             * The refusal is pinned by `admin-transfer-routes.test.ts`'s
             * "refuses an update that would have to invent a missing price"
             * (review finding I1): replacing it with a `?? 0` default turns
             * that test red with `promise resolved "{ ok: true }"`, which is
             * exactly the silent ₱0 repricing it exists to stop.
             */
            prices: card as TransferRoutePricesInput,
          },
          input.patch,
        );

        await upsertTransferRoute(tx, { id: input.id, ...merged });

        await writeAudit(tx, {
          actorType: 'user',
          actorId: ctx.adminSession.subjectId,
          action: 'transfer_route_updated',
          entity: 'transfer_route',
          entityId: input.id,
          data: input.patch,
        });
      });
      return { ok: true as const };
    }),

  /**
   * The soft delete, and the only writer of `transfer_routes.is_active`.
   *
   * Carved out of `update` for the reason `admin.vans.setStatus` and
   * `admin.coupons.setActive` are: `transferRouteCreateInputSchema` is
   * `.strict()` and does not name `isActive`, so a client cannot smuggle a
   * retirement through the CRUD door. Deactivating stops the route being
   * sellable and changes nothing else — not its prices, and not any booking
   * that already took one of them (a booking carries its own `price_snapshot`,
   * which is what makes a repriced or retired route harmless to guests who
   * already paid).
   */
  setActive: adminProcedure('toursPricing')
    .input(transferRouteActiveInputSchema)
    .mutation(async ({ input, ctx }) => {
      await getDb().transaction(async (tx) => {
        const [result] = await tx
          .update(transferRoutes)
          .set({ isActive: input.isActive })
          .where(eq(transferRoutes.id, input.id));
        if (result.affectedRows === 0) {
          throw new TRPCError({ code: 'NOT_FOUND', message: UNKNOWN_TRANSFER_ROUTE_MESSAGE });
        }
        await writeAudit(tx, {
          actorType: 'user',
          actorId: ctx.adminSession.subjectId,
          action: 'transfer_route_active_changed',
          entity: 'transfer_route',
          entityId: input.id,
          data: { isActive: input.isActive },
        });
      });
      return { ok: true as const };
    }),
});
