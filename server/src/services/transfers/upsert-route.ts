/**
 * `upsertTransferRoute` — the ONE writer of `transfer_routes` and
 * `transfer_route_vehicle_prices` (transfers-launch plan, Task T3;
 * Architecture §1 and §5). Restructured 2026-11-08 (owner decision: flexible
 * places/routes/vehicle types — see
 * `docs/superpowers/plans/2026-11-08-flexible-routes.md`, design note §1.3/§1.4).
 *
 * ## Why this is a service and not two resolver bodies
 *
 * `admin.transferRoutes.create` and `admin.transferRoutes.update` differ by one
 * thing: whether a `transfer_routes` row has to be inserted or updated.
 * Everything after that — the places check, the duplicate-key
 * translation, and the replacement of the route's price rows — is
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
 * route row, every price row and the audit row together — an audit row that
 * survived a rollback would claim a price change that never happened.
 *
 * ## The price rows ARE replaced wholesale, and the reason is a foreign key
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
 * ## What makes the wholesale replacement safe for money — THE COMPLETENESS CONTRACT
 *
 * Owner decision 2026-11-08 (design note §1.4) REVERSED the old rule here: a
 * route no longer carries "exactly two rows, never more, never fewer" — it
 * carries **one row per OFFERED active vehicle type, zero or more total,
 * zero being legitimate.** What stayed the same, and had to be RESTATED
 * rather than silently dropped once `VEHICLE_TYPES.map(...)`'s compile-time
 * link disappeared (vehicle types are a runtime list now, not a union type):
 * a present `prices` object is read as the COMPLETE price card for the
 * route — every type the admin wants offered, keyed by its stringified id,
 * with an ABSENT key meaning "not offered" (zero rows for that type). There
 * is no partial-patch form: `update`'s patch either omits `prices` entirely
 * (keep the stored card, merged in by {@link mergeTransferRoutePatch} before
 * it ever reaches this function) or sends the WHOLE new card. The failure
 * mode this exists to prevent is unchanged from before: delete every row,
 * re-insert only the type a caller happened to mention, and every OTHER
 * type's price silently vanishes. `admin-transfer-routes.test.ts` pins it —
 * now as "a patch naming one type's price does not remove any other type's
 * existing row" rather than the old "both rows always restated" assertion.
 *
 * **"Complete" is scoped to ACTIVE vehicle types, not every id that ever
 * existed — the one qualifier the paragraph above needs, found in the 1D/1E
 * review round.** `admin.transferRoutes`'s route form builds its `prices`
 * card from `admin.vehicleTypes.list` filtered to `isActive`, because that
 * is the only list it can show an admin — a type retired last month is not
 * a row the form can render a checkbox for, so it can never appear as a key
 * in anything the form posts. If the delete below still wiped every row for
 * the route, saving ANY unrelated field on a route that still carried a
 * price for a since-deactivated type would silently destroy that price,
 * with no error and no way to notice from the screen that did it. So the
 * delete is scoped to **the union of (a) every currently-active vehicle
 * type id and (b) every id the caller actually named as a key in `prices`,
 * active or not.** (a) is what makes the completeness contract above still
 * true for the only card an admin can ever author — every active type is
 * restated or dropped, exactly as documented. (b) is what lets a caller who
 * DOES know about an inactive type's id (there is no UI for this today, but
 * the existence check two call sites up already allows it — see
 * {@link UNKNOWN_VEHICLE_TYPE_MESSAGE}'s own comment) explicitly remove or
 * reprice it by naming it, same as always. An inactive type's id that is
 * NEITHER currently active NOR named in the card is the one case that used
 * to get silently swept into the old unconditional delete, and now survives
 * — "survives" meaning its value is preserved, not that the row is
 * necessarily left physically alone: an `update` whose patch omits `prices`
 * entirely restates the FULL stored card (inactive types included, via
 * `storedPriceRows` in the router), so that type's id becomes a posted key
 * again on this path and the row is deleted and reinserted with the same
 * values. Only the UI-shaped path — a posted card naming active types only
 * — leaves it genuinely untouched in the database. Both paths land on the
 * same end state, which is what the table's own header ("nothing
 * references it, so delete-then-reinsert is safe") already promises.
 * `admin-transfer-routes.test.ts`'s "a since-deactivated vehicle type's
 * stray price survives a save that never mentions it" test pins the
 * UI-shaped path, which is the one this fix exists for.
 */
import { TRPCError } from '@trpc/server';
import type { TransferRouteCreateInput, TransferRoutePatch } from '@rg/shared';
import { and, eq, inArray } from 'drizzle-orm';
import type { Transaction } from '../../db/client';
import { isDuplicateKeyError } from '../../db/duplicate-key';
import {
  transferPlaces,
  transferRouteVehiclePrices,
  transferRoutes,
  vehicleTypes,
} from '../../db/schema';

/**
 * The refusal for a duplicate `(from_place_id, to_place_id)` pair OR a
 * duplicate `slug`, in one sentence naming both.
 *
 * **One message rather than two, deliberately** (Task T3 decision, carried
 * forward 2026-11-08 onto the new place pair). Both are UNIQUE, so both races
 * are real rather than theoretical, and both arrive here as the same
 * `ER_DUP_ENTRY`. `isDuplicateKeyError` answers only "was that a duplicate" —
 * by design; its own header says it is the ONLY implementation and forbids a
 * second — so telling the two apart would mean parsing mysql2's error text
 * for a Drizzle-generated index name, which is new infrastructure and brittle
 * in exactly the way a renamed column would expose. Naming both possibilities
 * in one sentence is actionable without it: the owner can see which of the
 * two they just typed.
 */
export const DUPLICATE_TRANSFER_ROUTE_MESSAGE =
  'A transfer route already exists for that from/to pair, or that slug is already taken. ' +
  'A retired route still holds both — reactivate it instead of creating a second one.';

/**
 * The refusal for a `fromPlaceId`/`toPlaceId` no row answers to.
 *
 * Its own constant rather than an import from `services/tours/upsert.ts`,
 * which carries a similarly-shaped sentence about destinations: the two
 * services ask the same KIND of question of different tables, but coupling
 * the transfers service to the tours one for a few words of copy would drag
 * transfers along behind any future refactor of tour content. If a third
 * asker appears, extract it then.
 */
export const UNKNOWN_TRANSFER_PLACE_MESSAGE = 'No transfer place with that id.';

/**
 * The refusal for a `prices` card keyed by a vehicle-type id no row answers
 * to.
 *
 * Mirrors the places check below for exactly the same reason:
 * `transfer_route_vehicle_prices.vehicle_type_id` is a real foreign key, and
 * without this check an admin typo (or a stale key from a type that was
 * deleted outright rather than deactivated — it cannot be, but nothing
 * stopped the input from naming an id that was never real) would surface at
 * the final `insert` as a driver error the screen can say nothing about,
 * after the route row has already been written. Checking existence only,
 * not `isActive`: a type retired AFTER its price was set is still a price
 * this route legitimately carries (`setActive` never touches this table),
 * the same way a route may keep referencing a since-retired place.
 */
export const UNKNOWN_VEHICLE_TYPE_MESSAGE = 'No vehicle type with that id.';

/** The refusal for an `id` no transfer route answers to. */
export const UNKNOWN_TRANSFER_ROUTE_MESSAGE = 'No transfer route with that id.';

/**
 * The refusal for a route that would make BOTH directions of a place pair
 * independently bookable through two different rows (owner decision 2,
 * 2026-11-09 — design note §6 item 4a, previously an open question).
 *
 * **The bug this closes.** `UNIQUE(from_place_id, to_place_id)` treats
 * `(A,B)` and `(B,A)` as different rows, so nothing in the schema stops an
 * admin creating both — the identical journey listed twice, possibly at
 * different prices. A `reverseEnabled` row already serves BOTH directions on
 * its own (that is what the flag means), so a separate row for the opposite
 * pair is never needed and is always a duplicate of one direction or the
 * other.
 *
 * **The full condition** (worked through as a state-space, not just the
 * single case the owner's own example names): a pair is "effectively
 * bookable in both directions through two different rows" exactly when the
 * OPPOSITE row exists AT ALL and EITHER row has (or would have, with this
 * save) `reverseEnabled = true`. Two one-directional rows with
 * `reverseEnabled = false` on both are NOT refused — that is a legitimate,
 * deliberate case (two one-way routes, each priced independently for its own
 * direction, neither using the shared-price reverse mechanism). Only once
 * one side's reverse flag is (or becomes) true does the pair collide, because
 * that flag alone already covers the other row's entire journey.
 *
 * Named with real place names, in both orders, so an owner can see exactly
 * which pair conflicts — a function rather than a static string (unlike
 * {@link DUPLICATE_TRANSFER_ROUTE_MESSAGE}) because the two place names vary
 * per call.
 *
 * **The sentence has to name the retired case** (reviewer finding, 2026-11-09),
 * because the check below deliberately matches an INACTIVE opposite row and
 * there is no delete mutation on this table at all (see
 * `routers/admin/transfer-routes.ts`'s header): an earlier wording offered
 * "or remove the other route", which is an operation that does not exist, and
 * the nearest thing an admin would reach for (Retire) provably does not clear
 * the conflict. Same stance {@link DUPLICATE_TRANSFER_ROUTE_MESSAGE} already
 * spells out in words ("a retired route still holds both"); this one now says
 * it too rather than assuming the admin has read the other.
 */
export function reversePairConflictMessage(fromPlaceName: string, toPlaceName: string): string {
  return (
    `${fromPlaceName} → ${toPlaceName} is already sold as the reverse of ` +
    `${toPlaceName} → ${fromPlaceName}. A route and its reverse pair cannot both be ` +
    'independently bookable — turn off "also bookable in reverse" on one of them. ' +
    'A retired route still holds the pair, so retiring one does not free the other.'
  );
}

/**
 * The refusal when a route's from/to pair would name the same place twice.
 * The Zod schema (`transferRouteCreateInputSchema`) already refuses this on a
 * `create`, where both ids are always present; `update`'s patch may name only
 * ONE of the two, so the schema cannot know whether it collides with the
 * OTHER, stored id — only this function, after merging the patch over the
 * stored route, can (design note §1.4).
 */
export const SAME_FROM_TO_PLACE_MESSAGE = 'A route cannot start and end at the same place.';

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
    fromPlaceId: patch.fromPlaceId !== undefined ? patch.fromPlaceId : stored.fromPlaceId,
    toPlaceId: patch.toPlaceId !== undefined ? patch.toPlaceId : stored.toPlaceId,
    reverseEnabled:
      patch.reverseEnabled !== undefined ? patch.reverseEnabled : stored.reverseEnabled,
    slug: patch.slug !== undefined ? patch.slug : stored.slug,
    sortOrder: patch.sortOrder !== undefined ? patch.sortOrder : stored.sortOrder,
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
     * The money line. An absent `prices` keeps the STORED card in full —
     * every vehicle type that was offered — so the delete-then-reinsert
     * below restates what was already there. Reading this as `patch.prices`
     * alone is the bug this whole file is arranged to prevent. See this
     * file's header for the completeness contract a PRESENT `prices` object
     * must satisfy instead.
     */
    prices: patch.prices !== undefined ? patch.prices : stored.prices,
  };
}

/** The columns `transfer_routes` takes from either path, in one place for both. */
function routeValues(params: TransferRouteUpsertParams) {
  return {
    fromPlaceId: params.fromPlaceId,
    toPlaceId: params.toPlaceId,
    reverseEnabled: params.reverseEnabled,
    slug: params.slug,
    // Defaults to the column's own `DEFAULT 0` when the caller (a bare
    // `create` whose input never named it) omits it — T4's M3 addition.
    // `update` never hits this default in practice: `mergeTransferRoutePatch`
    // always hands this function a complete, already-resolved number.
    sortOrder: params.sortOrder ?? 0,
    estimatedDurationMinutes: params.estimatedDurationMinutes,
    freeCancelHours: params.freeCancelHours,
    inclusionsText: params.inclusionsText,
    exclusionsText: params.exclusionsText,
    /*
     * `isActive` is absent on purpose, not forgotten: it is not on the input
     * (see `shared/src/transfers-admin.ts`), so `setActive` stays the only
     * writer of the soft-delete flag.
     */
  };
}

/**
 * Creates or updates a transfer route and its whole price card, using the
 * transaction it is given.
 *
 * **The self-reference check comes FIRST, before any write and before either
 * id is even looked up** — `mergeTransferRoutePatch` has already resolved a
 * patch naming only one id against the OTHER, stored one by the time this
 * function sees `params`, so this is the cheapest possible refusal for the
 * cheapest possible mistake. See {@link SAME_FROM_TO_PLACE_MESSAGE}'s own
 * doc comment for why this cannot live in the Zod schema for `update`.
 *
 * **The places check comes second, still before any write**, and it checks
 * BOTH `fromPlaceId` and `toPlaceId` (owner decision 2026-11-08, replacing
 * the old single `destinationId` check): `transfer_routes.from_place_id` /
 * `.to_place_id` are real foreign keys, so an unknown id would otherwise
 * surface as a driver error — an `INTERNAL_SERVER_ERROR` the screen can say
 * nothing useful about. A single query against both ids with `inArray`,
 * rather than two round trips, so the existence check costs what it did
 * before this restructuring.
 *
 * **The reverse-pair conflict check comes third, still before any write**
 * (owner decision 2, 2026-11-09) — reusing the SAME places query's result
 * for the two place NAMES the refusal message needs, so this costs no extra
 * round trip beyond the one query it adds (reading whether the opposite pair
 * exists). See {@link reversePairConflictMessage}'s own doc comment for the
 * full state-space the condition covers.
 *
 * **The price card's vehicle-type ids are checked fourth, still before any
 * write** — every non-null key of `params.prices`, in one more `inArray`
 * query, for the same reason the places are: `transfer_route_vehicle_prices
 * .vehicle_type_id` is a real foreign key too, and catching an unknown id
 * here keeps the whole mutation a no-op rather than a route row written
 * with no matching price rows beneath it. See
 * {@link UNKNOWN_VEHICLE_TYPE_MESSAGE}'s own doc comment.
 */
export async function upsertTransferRoute(
  tx: Transaction,
  params: TransferRouteUpsertParams,
): Promise<{ id: number }> {
  if (params.fromPlaceId === params.toPlaceId) {
    throw new TRPCError({ code: 'BAD_REQUEST', message: SAME_FROM_TO_PLACE_MESSAGE });
  }

  const places = await tx
    .select({ id: transferPlaces.id, name: transferPlaces.name })
    .from(transferPlaces)
    .where(inArray(transferPlaces.id, [params.fromPlaceId, params.toPlaceId]));
  const placeNameById = new Map(places.map((place) => [place.id, place.name]));
  if (!placeNameById.has(params.fromPlaceId) || !placeNameById.has(params.toPlaceId)) {
    throw new TRPCError({ code: 'BAD_REQUEST', message: UNKNOWN_TRANSFER_PLACE_MESSAGE });
  }

  /*
   * The reverse-pair conflict (owner decision 2, 2026-11-09) — see
   * `reversePairConflictMessage`'s own doc comment for the full
   * state-space. Queried UNCONDITIONALLY (not gated on
   * `params.reverseEnabled`), because the conflict is symmetric: it fires
   * when EITHER this row's own `reverseEnabled` (as it will be saved) OR the
   * OPPOSITE row's stored `reverseEnabled` is true — a narrower query gated
   * on only one side would miss the other.
   *
   * `reverseRoute.id !== params.id` is what lets an UPDATE that swaps a
   * route's own `fromPlaceId`/`toPlaceId` (making it look, for a moment,
   * like its own opposite) save itself: on an `update`, the opposite-pair
   * query can otherwise match the very row being saved, still holding its
   * PRE-update values at read time.
   *
   * Matches an INACTIVE opposite row too — deliberately not filtered to
   * `isActive`, the same stance `DUPLICATE_TRANSFER_ROUTE_MESSAGE` already
   * takes ("a retired route still holds both"): `setActive` never clears
   * this conflict, only `update`/`create` can, so a retire-then-recreate
   * dance cannot be used to sidestep it.
   */
  const [reverseRoute] = await tx
    .select({ id: transferRoutes.id, reverseEnabled: transferRoutes.reverseEnabled })
    .from(transferRoutes)
    .where(
      and(
        eq(transferRoutes.fromPlaceId, params.toPlaceId),
        eq(transferRoutes.toPlaceId, params.fromPlaceId),
      ),
    )
    .limit(1);
  if (
    reverseRoute !== undefined &&
    reverseRoute.id !== params.id &&
    (params.reverseEnabled || reverseRoute.reverseEnabled)
  ) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: reversePairConflictMessage(
        placeNameById.get(params.fromPlaceId)!,
        placeNameById.get(params.toPlaceId)!,
      ),
    });
  }

  // The complete price card's requested vehicle-type ids — see this
  // function's own doc comment for why this runs before any write.
  const requestedVehicleTypeIds = Object.entries(params.prices)
    .filter(([, price]) => price !== null)
    .map(([vehicleTypeId]) => Number(vehicleTypeId));
  if (requestedVehicleTypeIds.length > 0) {
    const foundVehicleTypes = await tx
      .select({ id: vehicleTypes.id })
      .from(vehicleTypes)
      .where(inArray(vehicleTypes.id, requestedVehicleTypeIds));
    const foundVehicleTypeIds = new Set(foundVehicleTypes.map((vt) => vt.id));
    if (requestedVehicleTypeIds.some((id) => !foundVehicleTypeIds.has(id))) {
      throw new TRPCError({ code: 'BAD_REQUEST', message: UNKNOWN_VEHICLE_TYPE_MESSAGE });
    }
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
   * The price card, replaced wholesale OVER ACTIVE TYPES ONLY — safe because
   * nothing references this table and because `params.prices` is always
   * complete over every active type (see this file's header, "Complete is
   * scoped to ACTIVE vehicle types"). The delete is a no-op on a create.
   *
   * Scoped to the union of every active vehicle-type id and every id named
   * as a key in `params.prices` — NOT a blanket `routeId` match. A price row
   * for a vehicle type that is neither active nor named in this card belongs
   * to a type the caller's form could not have shown, and is left standing.
   */
  const activeVehicleTypes = await tx
    .select({ id: vehicleTypes.id })
    .from(vehicleTypes)
    .where(eq(vehicleTypes.isActive, true));
  const deleteScope = new Set(activeVehicleTypes.map((vt) => vt.id));
  for (const key of Object.keys(params.prices)) {
    deleteScope.add(Number(key));
  }
  if (deleteScope.size > 0) {
    await tx
      .delete(transferRouteVehiclePrices)
      .where(
        and(
          eq(transferRouteVehiclePrices.routeId, routeId),
          inArray(transferRouteVehiclePrices.vehicleTypeId, [...deleteScope]),
        ),
      );
  }

  /*
   * Driven by `Object.entries(params.prices)` rather than a fixed
   * `VEHICLE_TYPES` constant (owner decision 2026-11-08 — vehicle types are
   * now a runtime-managed list, not a compile-time union, so there is no
   * longer a constant to drive this from). Keys are the STRINGIFIED
   * vehicle-type id (`transferRoutePricesInputSchema`'s own wire shape); a
   * `null` value or an absent key both mean "not offered" and insert ZERO
   * rows for that type — `.filter()` below drops exactly the `null` entries,
   * never a fabricated zero-price row for one. The row count is therefore
   * the number of non-null entries in the card: zero, or more, never a fixed
   * two.
   *
   * What used to be a compile-time link (`VEHICLE_TYPES.map(...)` made a
   * third type a type error here until the input schema caught up) is now a
   * runtime one, proven instead by `admin-transfer-routes.test.ts`'s
   * completeness test — see this file's header.
   *
   * Every id below already passed the existence check above, before the
   * route row was written — this is a second filter over the same card, not
   * a second validation.
   */
  const priceRows = Object.entries(params.prices)
    .filter(([, price]) => price !== null)
    .map(([vehicleTypeId, price]) => ({
      routeId,
      vehicleTypeId: Number(vehicleTypeId),
      oneWayPriceCentavos: price!.oneWayPriceCentavos,
      dayUsePriceCentavos: price!.dayUsePriceCentavos,
    }));
  if (priceRows.length > 0) {
    await tx.insert(transferRouteVehiclePrices).values(priceRows);
  }

  return { id: routeId };
}
