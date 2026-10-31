/**
 * `upsertTransferRoute` — the ONE writer of `transfer_routes` and
 * `transfer_route_vehicle_prices` (transfers-launch plan, Task T3;
 * Architecture §1 and §5).
 *
 * ## Why this is a service and not two resolver bodies
 *
 * `admin.transferRoutes.create` and `admin.transferRoutes.update` differ by one
 * thing: whether a `transfer_routes` row has to be inserted or updated.
 * Everything after that — the destination check, the duplicate-key
 * translation, and the replacement of the route's two price rows — is
 * identical, and two copies of a delete-then-reinsert of a MONEY table is how
 * one of them quietly stops matching the other. That is not hypothetical here:
 * `services/tours/upsert.ts` exists for exactly this reason, and its own
 * header records BUG-045, where the seed's copy of the same shape could leave
 * a tour with no prices at all.
 *
 * ## It takes a transaction; it never opens one
 *
 * The first parameter is the caller's `Transaction`, there is no `getDb()` call
 * anywhere in this file, and the router opens exactly one transaction per
 * mutation with its `writeAudit` inside it. A rollback therefore takes the
 * route row, both price rows and the audit row together — an audit row that
 * survived a rollback would claim a price change that never happened.
 *
 * ## The two price rows ARE replaced wholesale, and the reason is a foreign key
 *
 * `services/tours/upsert.ts` splits its four child tables in half on exactly
 * this question. `tour_price_tiers` and `tour_images` are still deleted and
 * re-inserted on every save because nothing in the schema references them;
 * `tour_addons` and `tour_itinerary_stops` cannot be, because
 * `booking_addons.addon_id` and `trip_checkpoints.stop_id` reference them `ON
 * DELETE RESTRICT`, so a wholesale delete becomes a permanent 500 the moment
 * real history exists.
 *
 * **`transfer_route_vehicle_prices` is in the first group, and the plan keeps
 * it there.** Nothing references it with a foreign key, in this task or in any
 * later one: a transfer booking freezes the price it was quoted into its own
 * `price_snapshot` JSON at hold time rather than pointing at a price row (plan
 * Architecture §1, "What is deliberately reused, not duplicated"). So there is
 * no RESTRICT to trip over and no history to preserve — a price row is the
 * price, not a record of one — and delete-then-reinsert is both correct and the
 * simplest thing that works. **If a later task ever adds a foreign key to this
 * table, this function has to change shape**, the same way the tours one did.
 *
 * ## What makes the wholesale replacement safe for money
 *
 * It is only safe because every caller hands it a COMPLETE price card.
 * `TransferRouteCreateInput.prices` is `{ van, suv }` with both halves
 * structurally required (`shared/src/transfers-admin.ts`), and `update`'s patch
 * can only omit `prices` entirely — never half of it. A patch that does not
 * mention prices is merged over the STORED card by
 * {@link mergeTransferRoutePatch} before it ever reaches this function, so the
 * two rows re-inserted here always restate both vehicle types.
 *
 * The failure mode that rule exists to prevent is specific and expensive:
 * delete both rows, re-insert only the vehicle type the patch happened to
 * mention, and the other vehicle type's price is gone — a van/SUV product that
 * silently stops being quotable, or (worse, if a zero were invented for it)
 * one that quotes nothing. `admin-transfer-routes.test.ts` pins it.
 */
import { TRPCError } from '@trpc/server';
import { VEHICLE_TYPES, type TransferRouteCreateInput, type TransferRoutePatch } from '@rg/shared';
import { eq } from 'drizzle-orm';
import type { Transaction } from '../../db/client';
import { isDuplicateKeyError } from '../../db/duplicate-key';
import { destinations, transferRouteVehiclePrices, transferRoutes } from '../../db/schema';

/**
 * The refusal for a duplicate `destination_id` OR a duplicate `slug`, in one
 * sentence naming both.
 *
 * **One message rather than two, deliberately** (Task T3 decision). Both
 * columns are UNIQUE, so both races are real rather than theoretical, and both
 * arrive here as the same `ER_DUP_ENTRY`. `isDuplicateKeyError` answers only
 * "was that a duplicate" — by design; its own header says it is the ONLY
 * implementation and forbids a second — so telling the two apart would mean
 * parsing mysql2's error text for a Drizzle-generated index name, which is new
 * infrastructure and brittle in exactly the way a renamed column would expose.
 * Naming both possibilities in one sentence is actionable without it: the owner
 * can see which of the two they just typed.
 */
export const DUPLICATE_TRANSFER_ROUTE_MESSAGE =
  'A transfer route already exists for that destination, or that slug is already taken. ' +
  'A retired route still holds both — reactivate it instead of creating a second one.';

/**
 * The refusal for a `destination_id` no row answers to.
 *
 * Its own constant rather than an import from `services/tours/upsert.ts`,
 * which carries the identical sentence: the two services ask the same question
 * of the same shared table, but coupling the transfers service to the tours
 * one for a four-word string would drag transfers along behind any future
 * refactor of tour content. If a third asker appears, extract it then.
 */
export const UNKNOWN_DESTINATION_MESSAGE = 'No destination with that id.';

/** The refusal for an `id` no transfer route answers to. */
export const UNKNOWN_TRANSFER_ROUTE_MESSAGE = 'No transfer route with that id.';

/** `create` has no id; `update` has one. That is the whole discriminator. */
export type TransferRouteUpsertParams = TransferRouteCreateInput & { id?: number };

/**
 * A stored route, as `update` reads it back before merging a patch over it:
 * structurally the same thing a `create` posts, which is the point — the merge
 * produces a complete create input and the upsert needs nothing else.
 *
 * `prices` is the COMPLETE stored card. The router is responsible for refusing
 * the save when either vehicle type's row is missing from the database, rather
 * than inventing a figure to merge — see its own comment.
 */
export type StoredTransferRoute = TransferRouteCreateInput;

/**
 * A patch applied over the stored route, producing the complete input the
 * upsert requires.
 *
 * Pure, and exported for its own sake: "a patch that changes the duration must
 * not change either price" is a fact about this function alone, provable
 * without a database.
 *
 * Every field is tested with `!== undefined` rather than `??`. Two of them
 * (`inclusionsText`, `exclusionsText`) are nullable, and `null` in a patch
 * means "clear this" — `??` would read that as "leave it alone" and silently
 * ignore the edit. The uniform spelling means no field is one refactor away
 * from acquiring that bug.
 */
export function mergeTransferRoutePatch(
  stored: StoredTransferRoute,
  patch: TransferRoutePatch,
): TransferRouteCreateInput {
  return {
    destinationId: patch.destinationId !== undefined ? patch.destinationId : stored.destinationId,
    slug: patch.slug !== undefined ? patch.slug : stored.slug,
    estimatedDurationMinutes:
      patch.estimatedDurationMinutes !== undefined
        ? patch.estimatedDurationMinutes
        : stored.estimatedDurationMinutes,
    freeCancelHours:
      patch.freeCancelHours !== undefined ? patch.freeCancelHours : stored.freeCancelHours,
    inclusionsText:
      patch.inclusionsText !== undefined ? patch.inclusionsText : stored.inclusionsText,
    exclusionsText:
      patch.exclusionsText !== undefined ? patch.exclusionsText : stored.exclusionsText,
    /*
     * The money line. An absent `prices` keeps the STORED card in full — both
     * vehicle types — so the delete-then-reinsert below restates what was
     * already there. Reading this as `patch.prices` alone is the bug this whole
     * file is arranged to prevent.
     */
    prices: patch.prices !== undefined ? patch.prices : stored.prices,
  };
}

/** The columns `transfer_routes` takes from either path, in one place for both. */
function routeValues(params: TransferRouteUpsertParams) {
  return {
    destinationId: params.destinationId,
    slug: params.slug,
    estimatedDurationMinutes: params.estimatedDurationMinutes,
    freeCancelHours: params.freeCancelHours,
    inclusionsText: params.inclusionsText,
    exclusionsText: params.exclusionsText,
    /*
     * `isActive` and `sortOrder` are absent on purpose, not forgotten: neither
     * is on the input (see `shared/src/transfers-admin.ts`), so `setActive`
     * stays the only writer of the soft-delete flag.
     */
  };
}

/**
 * Creates or updates a transfer route and both of its price rows, using the
 * transaction it is given.
 *
 * The destination check comes FIRST, before any write: `transfer_routes
 * .destination_id` is a real foreign key, so an unknown id would otherwise
 * surface as a driver error — an `INTERNAL_SERVER_ERROR` the screen can say
 * nothing useful about.
 */
export async function upsertTransferRoute(
  tx: Transaction,
  params: TransferRouteUpsertParams,
): Promise<{ id: number }> {
  const [destination] = await tx
    .select({ id: destinations.id })
    .from(destinations)
    .where(eq(destinations.id, params.destinationId))
    .limit(1);
  if (!destination) {
    throw new TRPCError({ code: 'BAD_REQUEST', message: UNKNOWN_DESTINATION_MESSAGE });
  }

  const values = routeValues(params);
  let routeId: number;

  try {
    if (params.id !== undefined) {
      const [result] = await tx
        .update(transferRoutes)
        .set(values)
        .where(eq(transferRoutes.id, params.id));
      /*
       * `affectedRows === 0` is an exact "no such route": mysql2 sets
       * `CLIENT_FOUND_ROWS` in its default client flags and `db/client.ts`
       * turns it off nowhere, so this is the MATCHED count — a save that
       * rewrites a route with the values it already holds still reports 1.
       * (Measured and recorded in `db/client.ts`'s header; restated rather
       * than assumed, because this codebase has believed the opposite twice.)
       */
      if (result.affectedRows === 0) {
        throw new TRPCError({ code: 'NOT_FOUND', message: UNKNOWN_TRANSFER_ROUTE_MESSAGE });
      }
      routeId = params.id;
    } else {
      const [result] = await tx.insert(transferRoutes).values(values);
      routeId = result.insertId;
    }
  } catch (error) {
    /*
     * Catching the constraint rather than checking first is what makes this
     * correct under concurrency: two owners saving the same slug at once both
     * pass a read-then-write check and one of them gets `ER_DUP_ENTRY`.
     * Translating it is what stops mysql2's own sentence reaching a browser
     * (BUG-021's shape; `isDuplicateKeyError` walks Drizzle's `.cause` chain,
     * because `error.code` one level up is `undefined`).
     */
    if (isDuplicateKeyError(error)) {
      throw new TRPCError({ code: 'CONFLICT', message: DUPLICATE_TRANSFER_ROUTE_MESSAGE });
    }
    throw error;
  }

  /*
   * The price card, replaced wholesale — safe because nothing references this
   * table and because `params.prices` is always complete (see this file's
   * header). The delete is a no-op on a create.
   */
  await tx
    .delete(transferRouteVehiclePrices)
    .where(eq(transferRouteVehiclePrices.routeId, routeId));

  /*
   * Driven by `VEHICLE_TYPES` rather than `Object.entries(params.prices)`, so
   * the row count is the constant's length by construction — exactly two rows,
   * never one and never three, whatever a caller's object happens to hold. It
   * is also the compile-time link between the two: a third vehicle type added
   * to `VEHICLE_TYPES` makes `params.prices[vehicleType]` a type error here
   * until `transferRoutePricesInputSchema` gains the key, instead of shipping a
   * vehicle nobody priced.
   */
  await tx.insert(transferRouteVehiclePrices).values(
    VEHICLE_TYPES.map((vehicleType) => ({
      routeId,
      vehicleType,
      oneWayPriceCentavos: params.prices[vehicleType].oneWayPriceCentavos,
      dayUsePriceCentavos: params.prices[vehicleType].dayUsePriceCentavos,
    })),
  );

  return { id: routeId };
}
