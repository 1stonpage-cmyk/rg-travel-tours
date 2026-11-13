/**
 * `admin.transferRoutes.*` — the private-transfer route catalog and its
 * per-vehicle-type prices (transfers-launch plan, Task T3; Architecture §1
 * and §5). Restructured 2026-11-08 (owner decision: flexible
 * places/routes/vehicle types — see
 * `docs/superpowers/plans/2026-11-08-flexible-routes.md`).
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
 * **`prices` is no longer "exactly two rows, never more, never fewer".**
 * Owner decision 2026-11-08 (design note §1.4) reversed that rule: a route
 * carries one row per OFFERED active vehicle type, zero or more total, zero
 * being legitimate — "no row = that type isn't offered." The old
 * `missingPricesMessage`/`CONFLICT` refusal for a route with a stored price
 * row missing no longer applies, because there is nothing missing about a
 * route with fewer than every vehicle type priced any more.
 *
 * One transaction per mutation, opened here, with `writeAudit` inside it — an
 * audit row that survives a rollback claims a price change that never happened.
 */
import { TRPCError } from '@trpc/server';
import {
  transferRouteActiveInputSchema,
  transferRouteCreateInputSchema,
  transferRouteUpdateInputSchema,
  type TransferRouteAdminRow,
  type TransferRouteAdminVehiclePrice,
  type TransferRoutePricesInput,
} from '@rg/shared';
import { asc, eq, inArray } from 'drizzle-orm';
import { alias } from 'drizzle-orm/mysql-core';
import { getDb } from '../../db/client';
import {
  transferPlaces,
  transferRouteVehiclePrices,
  transferRoutes,
  vehicleTypes,
} from '../../db/schema';
import { writeAudit } from '../../services/audit';
import {
  UNKNOWN_TRANSFER_ROUTE_MESSAGE,
  mergeTransferRoutePatch,
  upsertTransferRoute,
} from '../../services/transfers/upsert-route';
import { adminProcedure, router } from '../../trpc';

/**
 * Two aliases onto the SAME `transfer_places` table — mirrors
 * `services/transfers/pricing.ts`'s own pair (each module that needs both
 * sides of a route declares its own).
 */
const fromPlace = alias(transferPlaces, 'fromPlace');
const toPlace = alias(transferPlaces, 'toPlace');

export const adminTransferRoutesRouter = router({
  /**
   * Every route, **inactive ones included**, each with both places' names
   * and every ACTIVE vehicle type's price (`price: null` meaning "not
   * offered").
   *
   * Three queries, never one per route: the routes joined to `transfer_places`
   * (twice, aliased), the active vehicle types, then one `IN (…)` sweep of the
   * price rows for the ids that came back. A price read per row would be an
   * N+1 against the table whose whole purpose is to be read beside its parent.
   *
   * The joins to `transfer_places` are `innerJoin`s because
   * `transfer_routes.from_place_id`/`to_place_id` are both `NOT NULL` with a
   * RESTRICT foreign key — a route without both places cannot exist.
   *
   * Ordered by `sort_order` then the to-place's name, so two routes sharing a
   * sort order still come back in the same order on every run.
   */
  list: adminProcedure('toursPricing').query(async (): Promise<TransferRouteAdminRow[]> => {
    const db = getDb();
    const rows = await db
      .select({
        id: transferRoutes.id,
        fromPlaceId: fromPlace.id,
        fromPlaceName: fromPlace.name,
        fromPlaceType: fromPlace.placeType,
        fromPlaceIsActive: fromPlace.isActive,
        toPlaceId: toPlace.id,
        toPlaceName: toPlace.name,
        toPlaceType: toPlace.placeType,
        toPlaceIsActive: toPlace.isActive,
        reverseEnabled: transferRoutes.reverseEnabled,
        slug: transferRoutes.slug,
        isActive: transferRoutes.isActive,
        sortOrder: transferRoutes.sortOrder,
        estimatedDurationMinutes: transferRoutes.estimatedDurationMinutes,
        freeCancelHours: transferRoutes.freeCancelHours,
        inclusionsText: transferRoutes.inclusionsText,
        exclusionsText: transferRoutes.exclusionsText,
        showOnHomePage: transferRoutes.showOnHomePage,
        homePageBadge: transferRoutes.homePageBadge,
        homePageOrder: transferRoutes.homePageOrder,
        homePageShortDescription: transferRoutes.homePageShortDescription,
      })
      .from(transferRoutes)
      .innerJoin(fromPlace, eq(fromPlace.id, transferRoutes.fromPlaceId))
      .innerJoin(toPlace, eq(toPlace.id, transferRoutes.toPlaceId))
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
      const prices: TransferRouteAdminVehiclePrice[] = types.map((type) => ({
        vehicleTypeId: type.id,
        vehicleTypeName: type.name,
        slug: type.slug,
        price: priceMap.get(`${row.id}:${type.id}`) ?? null,
      }));
      return {
        id: row.id,
        fromPlace: {
          id: row.fromPlaceId,
          name: row.fromPlaceName,
          placeType: row.fromPlaceType,
          isActive: row.fromPlaceIsActive,
        },
        toPlace: {
          id: row.toPlaceId,
          name: row.toPlaceName,
          placeType: row.toPlaceType,
          isActive: row.toPlaceIsActive,
        },
        reverseEnabled: row.reverseEnabled,
        slug: row.slug,
        isActive: row.isActive,
        sortOrder: row.sortOrder,
        estimatedDurationMinutes: row.estimatedDurationMinutes,
        freeCancelHours: row.freeCancelHours,
        inclusionsText: row.inclusionsText,
        exclusionsText: row.exclusionsText,
        showOnHomePage: row.showOnHomePage,
        homePageBadge: row.homePageBadge,
        homePageOrder: row.homePageOrder,
        homePageShortDescription: row.homePageShortDescription,
        prices,
      };
    });
  }),

  /**
   * A new route and its whole price card, in one transaction.
   *
   * The audit payload names both places, the slug, `reverseEnabled` AND the
   * prices. The prices are the point: `audit_log` carries "every money
   * movement, status change, assignment, and price CHANGE", and a route's
   * creation is the first price it ever had. Nothing here is sensitive —
   * `transfer_routes` holds no personal data, no hash and no token.
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
          data: {
            fromPlaceId: input.fromPlaceId,
            toPlaceId: input.toPlaceId,
            reverseEnabled: input.reverseEnabled,
            slug: input.slug,
            prices: input.prices,
          },
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
   * "take the lock BEFORE reading" rule. The price rows are locked the same
   * way, for the same reason: they are what the merge reads and what the
   * upsert is about to replace.
   *
   * **The stored price card is built directly from whatever rows exist**,
   * keyed by the stringified `vehicleTypeId` — there is no "every type,
   * filled with null" base to build any more (owner decision 2026-11-08):
   * an absent key already means "not offered", so a row that is not there
   * needs no explicit `null` placeholder. This is also why the old
   * "refuses an update that would have to invent a missing price" refusal
   * is gone — there is nothing left to invent; a merge over a card with a
   * type missing simply keeps that type unpriced.
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
            fromPlaceId: transferRoutes.fromPlaceId,
            toPlaceId: transferRoutes.toPlaceId,
            reverseEnabled: transferRoutes.reverseEnabled,
            slug: transferRoutes.slug,
            sortOrder: transferRoutes.sortOrder,
            estimatedDurationMinutes: transferRoutes.estimatedDurationMinutes,
            freeCancelHours: transferRoutes.freeCancelHours,
            inclusionsText: transferRoutes.inclusionsText,
            exclusionsText: transferRoutes.exclusionsText,
            showOnHomePage: transferRoutes.showOnHomePage,
            homePageBadge: transferRoutes.homePageBadge,
            homePageOrder: transferRoutes.homePageOrder,
            homePageShortDescription: transferRoutes.homePageShortDescription,
          })
          .from(transferRoutes)
          .where(eq(transferRoutes.id, input.id))
          .for('update');
        if (!stored) {
          throw new TRPCError({ code: 'NOT_FOUND', message: UNKNOWN_TRANSFER_ROUTE_MESSAGE });
        }

        const storedPriceRows = await tx
          .select({
            vehicleTypeId: transferRouteVehiclePrices.vehicleTypeId,
            oneWayPriceCentavos: transferRouteVehiclePrices.oneWayPriceCentavos,
            dayUsePriceCentavos: transferRouteVehiclePrices.dayUsePriceCentavos,
          })
          .from(transferRouteVehiclePrices)
          .where(eq(transferRouteVehiclePrices.routeId, input.id))
          .for('update');

        const storedPrices: TransferRoutePricesInput = {};
        for (const price of storedPriceRows) {
          storedPrices[String(price.vehicleTypeId)] = {
            oneWayPriceCentavos: price.oneWayPriceCentavos,
            dayUsePriceCentavos: price.dayUsePriceCentavos,
          };
        }

        const merged = mergeTransferRoutePatch({ ...stored, prices: storedPrices }, input.patch);

        await upsertTransferRoute(tx, { id: input.id, ...merged });

        await writeAudit(tx, {
          actorType: 'user',
          actorId: ctx.adminSession.subjectId,
          action: 'transfer_route_updated',
          entity: 'transfer_route',
          entityId: input.id,
          data: {
            // What changed — unchanged from before.
            patch: input.patch,
            /*
             * Task T20b (owner-added 2026-11-10): every price edit must
             * audit old -> new. `storedPrices` above is already read, in
             * scope, before `upsertTransferRoute` writes anything — this
             * adds it to the SAME audit row rather than reading anything
             * new, so it changes no money math.
             */
            previousPrices: storedPrices,
          },
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
