/**
 * Transfer pricing (transfers-launch plan, Task T9; Architecture §3).
 *
 * Split exactly as `services/pricing.ts` is, and for the same reasons:
 *
 *  - {@link quoteTransfer} is pure arithmetic — a catalog price, a coupon and
 *    a deposit percent in, a quote out. No database, no clock, so it is
 *    exhaustively testable with no connection at all.
 *  - {@link vehiclePriceForRouteAndType} does the one database read that feeds
 *    it, and does no arithmetic.
 *  - {@link transferSubtotalCentavos} (owner decision 2026-11-18, per-person
 *    pricing plan) is the OTHER pure arithmetic: the one place a catalog unit
 *    rate and a head count turn into a subtotal.
 *
 * **A transfer's price is a flat per-vehicle rate, OR a per-person rate
 * (owner decision 2026-11-18).** `transferRoutes.pricingMode` picks which: a
 * `per_vehicle` route still prices exactly as before (a van costs what a van
 * costs whether one guest or eight ride in it), and a `per_person` route
 * multiplies the catalog unit rate by `max(pax, minPayingPax)`
 * ({@link transferSubtotalCentavos}). **`quoteTransfer` itself still takes no
 * `pax` parameter at all** — the absence is the contract a test still pins —
 * because the multiplication happens ONE step earlier, in
 * {@link transferSubtotalCentavos}, and every caller passes ITS OWN result in
 * as `quoteTransfer`'s `priceCentavos` (a no-op pass-through on a
 * `per_vehicle` route, where `transferSubtotalCentavos` returns the unit rate
 * unchanged). Keeping the pax-sensitive arithmetic in its own function, never
 * folded into `quoteTransfer`, is what lets `quoteTransfer`'s own "no pax"
 * contract keep meaning something.
 *
 * Architecture §3's formula, verbatim (now reading "subtotal" as whichever of
 * the two pricing modes produced it):
 *
 *   subtotal        = transferSubtotalCentavos(vehiclePriceForRouteAndType(...), pax)
 *   discount        = coupon applied to subtotal (percent or fixed, capped at subtotal)
 *   total           = subtotal - discount
 *   deposit         = depositCentavos(total, deposit_percent)
 *   amount_due_now  = pay_in_full ? total : deposit
 *   balance         = total - amount_due_now
 *
 * The discount is `discountCentavosFor()` imported from `services/pricing.ts`
 * and the deposit is `depositCentavos()` from `@rg/shared` — neither rule is
 * restated here, because a second copy of a rounding rule is how two copies
 * come to disagree.
 *
 * Integer centavos throughout. No float ever touches money.
 */
import { and, eq } from 'drizzle-orm';
import { alias } from 'drizzle-orm/mysql-core';
import { depositCentavos, type TransferPricingMode, type TransferProductType } from '@rg/shared';
import { getDb, type Database, type Transaction } from '../../db/client';
import {
  transferPlaces,
  transferRouteVehiclePrices,
  transferRoutes,
  vehicleTypes,
} from '../../db/schema';
import { discountCentavosFor, type QuoteCoupon } from '../pricing';

/**
 * Two aliases onto the SAME `transfer_places` table — a route's `from_place`
 * and `to_place` are two different rows of one table, and joining it twice
 * unaliased is invalid SQL (`alias()` from `drizzle-orm/mysql-core`, per the
 * design note §2's own instruction). Module-level, like `destinations` used
 * to be imported module-level, so both queries in this file (were there a
 * second) would share one spelling.
 */
const fromPlace = alias(transferPlaces, 'fromPlace');
const toPlace = alias(transferPlaces, 'toPlace');

export interface TransferQuoteInput {
  /** The catalog price for this route + vehicle type + product, in centavos. */
  priceCentavos: number;
  /**
   * `services/pricing.ts`'s own coupon shape, reused rather than redeclared —
   * and `services/coupons.ts`'s `ValidCoupon` is structurally identical to it,
   * so a validated coupon can be handed straight here with no conversion.
   */
  coupon?: QuoteCoupon | null;
  /** Whole percent, e.g. 30 for a 30% deposit (the `trust` setting). */
  depositPercent: number;
}

/**
 * What {@link quoteTransfer} returns.
 *
 * Named `TransferQuoteResult`, not `QuoteTransferResult`, because `@rg/shared`
 * exports a DIFFERENT `QuoteTransferResult` — the wire shape, which is this
 * plus the route's `freeCancelHours`. Same naming care `PriceQuoteResult` takes
 * against the tour's wire `QuoteResult`, for the same reason: two same-named
 * types one import apart is a bug waiting for a careless auto-import.
 */
export interface TransferQuoteResult {
  subtotalCentavos: number;
  discountCentavos: number;
  totalCentavos: number;
  depositCentavos: number;
  amountDueNowCentavos: { full: number; deposit: number };
  balanceCentavos: { full: number; deposit: number };
}

/**
 * The pure arithmetic. No database, no clock, and **no `pax`** — see this
 * module's header on why that absence is the contract.
 */
export function quoteTransfer(input: TransferQuoteInput): TransferQuoteResult {
  const { priceCentavos, coupon = null, depositPercent } = input;

  // The flat catalog rate IS the subtotal. Nothing multiplies it.
  const subtotalCentavos = priceCentavos;
  const discountCentavos = discountCentavosFor(coupon, subtotalCentavos);
  const totalCentavos = subtotalCentavos - discountCentavos;
  const deposit = depositCentavos(totalCentavos, depositPercent);

  // Pay mode isn't known at quote time (the guest picks it at checkout), so
  // both branches are computed — `full`'s balance is always 0, by definition.
  const amountDueNowCentavos = { full: totalCentavos, deposit };
  const balanceCentavos = {
    full: totalCentavos - amountDueNowCentavos.full,
    deposit: totalCentavos - amountDueNowCentavos.deposit,
  };

  return {
    subtotalCentavos,
    discountCentavos,
    totalCentavos,
    depositCentavos: deposit,
    amountDueNowCentavos,
    balanceCentavos,
  };
}

/**
 * The ONE multiply function (owner decision 2026-11-18, per-person pricing
 * plan) — a catalog unit rate and a head count turn into a subtotal here,
 * nowhere else. `quoteTransfer()` above deliberately does not do this; every
 * caller computes this FIRST and passes its `subtotalCentavos` into
 * `quoteTransfer()` as `priceCentavos` (see this module's header).
 *
 * `per_vehicle` ignores `pax` entirely — the unit rate IS the subtotal, byte
 * for byte, exactly as every route priced before this plan. `per_person`
 * multiplies by `max(pax, minPayingPax)`, never by `pax` alone: a route with
 * a minimum of, say, two paying passengers charges for two even when one
 * guest books alone. `paxCharged` is returned alongside the subtotal so a
 * caller can freeze it onto the price snapshot — the figure the arithmetic
 * actually used, not the figure the guest typed.
 */
export function transferSubtotalCentavos(args: {
  pricingMode: TransferPricingMode;
  unitPriceCentavos: number;
  pax: number;
  minPayingPax: number;
}): { subtotalCentavos: number; paxCharged: number } {
  if (args.pricingMode === 'per_vehicle') {
    return { subtotalCentavos: args.unitPriceCentavos, paxCharged: args.pax };
  }
  const paxCharged = Math.max(args.pax, args.minPayingPax);
  return { subtotalCentavos: args.unitPriceCentavos * paxCharged, paxCharged };
}

/** What the catalog holds for one route + vehicle type, at one product. */
export interface TransferVehiclePrice {
  priceCentavos: number;
  freeCancelHours: number;
  /**
   * `transfer_routes.estimated_duration_minutes`. Not used by this module's
   * arithmetic — it is here because `createTransferBooking()` (T10) needs it to
   * compute the vehicle's occupancy window (`computeTransferWindow`, T7) and
   * must not query the route a second time to get it. The name matches
   * `TransferWindowInput.routeDurationMinutes` exactly.
   */
  routeDurationMinutes: number;
  /**
   * `vehicle_types.name`, as it stood at the moment of this read (owner
   * decision 2026-11-08) — here because `createTransferBooking()` freezes it
   * onto the price snapshot's `vehicleTypeName` and the `vehicle_types` join
   * already added for the is_active check (see this function's own doc
   * comment) makes the name free to select alongside it, avoiding a second
   * query the same way `routeDurationMinutes` above avoids one for the
   * route.
   */
  vehicleTypeName: string;
  /**
   * `transfer_routes.pricing_mode`/`min_paying_pax` (owner decision
   * 2026-11-18, per-person pricing plan) — route-level, read alongside the
   * price because every caller that reads one needs the other to call
   * {@link transferSubtotalCentavos}.
   */
  pricingMode: TransferPricingMode;
  minPayingPax: number;
  /**
   * `vehicle_types.default_seats` — the guest-facing passenger cap for this
   * vehicle type (same decision). `null` means no cap. Read here, alongside
   * the price, because `createTransferBooking()`'s seat-cap check runs right
   * after this same read and must not query `vehicle_types` a second time.
   */
  defaultSeats: number | null;
}

/**
 * The catalog price for one route + vehicle type at one product, or `null`.
 *
 * `null` means every normal "we cannot quote that" case: no such route, a
 * RETIRED route, a route whose FROM or TO place is inactive, a DEACTIVATED
 * vehicle type, or a route with no price row for the requested vehicle type.
 * **None of those throws.** They are all
 * guest-reachable answers a router turns into a `NOT_FOUND`, not internal
 * failures that deserve a 500 — the same treatment `loadQuoteInputs`' add-on
 * sweep gives a stale add-on id.
 *
 * **Both halves of the soft delete are checked, and that is the point of the
 * joins to `transfer_places`** (T9 review, Important finding; retargeted from
 * `destinations` to `from`/`to` PLACES by owner decision 2026-11-08 — design
 * note §1.3 and §2 — because sellability now depends on the ROUTE'S OWN pair
 * of places, not a single tour destination). `transferRoutes.list`
 * filters on `transfer_routes.is_active` AND both places' `is_active`; this
 * function at first filtered only on the route's own flag, so deactivating a
 * place on the admin places screen took the route off the public
 * list while this still quoted it — a live price for a place the business has
 * withdrawn, reachable from a stale tab or by probing small route ids. The two
 * surfaces now ask the same question, which is what lets each stand alone:
 * neither relies on the other having filtered first, and T10 turns this answer
 * into a real reservation.
 *
 * **Also joins `vehicle_types` and requires `is_active = true`** (owner
 * decision 2026-11-08, design note §2 — NOT present in the original T9
 * destination-only check). Vehicle types are now an admin-managed list, so
 * the identical disclosure T9 fixed for destinations exists here too: without
 * this join, an admin deactivating a vehicle type leaves its price rows
 * quotable and bookable from a stale tab or a direct call naming its id. The
 * money path must check the type's own `is_active` here, not only on the
 * public route list — the two surfaces must ask the same question, exactly
 * as the from/to place check above does.
 *
 * `productType` picks the COLUMN: `one_way_price_centavos` for a one-way trip,
 * `day_use_price_centavos` for a day-use hire. Both columns are `NOT NULL`, so
 * a row existing means both prices exist.
 *
 * **`db` takes either handle, defaulting to the pool** — `validateCoupon`'s own
 * pattern, and for its reason. This task never opens a transaction (it is a
 * read-only quote outside any lock), but T10 calls this same function from
 * INSIDE the hold transaction, and a function that checked out its own
 * connection there would deadlock the pool under concurrency (see
 * `services/coupons.ts`'s note on the eleventh connection).
 */
export async function vehiclePriceForRouteAndType(
  routeId: number,
  vehicleTypeId: number,
  productType: TransferProductType,
  db: Database | Transaction = getDb(),
): Promise<TransferVehiclePrice | null> {
  const [row] = await db
    .select({
      freeCancelHours: transferRoutes.freeCancelHours,
      routeDurationMinutes: transferRoutes.estimatedDurationMinutes,
      oneWayPriceCentavos: transferRouteVehiclePrices.oneWayPriceCentavos,
      dayUsePriceCentavos: transferRouteVehiclePrices.dayUsePriceCentavos,
      vehicleTypeName: vehicleTypes.name,
      pricingMode: transferRoutes.pricingMode,
      minPayingPax: transferRoutes.minPayingPax,
      defaultSeats: vehicleTypes.defaultSeats,
    })
    .from(transferRoutes)
    /*
     * INNER join: a route with no price row for this vehicle type is as
     * unquotable as a route that does not exist, and both must answer `null`
     * from the same branch below rather than one answering `null` and the other
     * a row with a fabricated zero price.
     */
    .innerJoin(
      transferRouteVehiclePrices,
      and(
        eq(transferRouteVehiclePrices.routeId, transferRoutes.id),
        eq(transferRouteVehiclePrices.vehicleTypeId, vehicleTypeId),
      ),
    )
    /*
     * The vehicle type's own soft-delete half — new, see the doc comment
     * above. An INNER join: a deactivated type must answer this function's
     * `null` branch exactly as a retired route or place does, not a row with
     * a price nobody may sell any more.
     */
    .innerJoin(vehicleTypes, eq(vehicleTypes.id, transferRouteVehiclePrices.vehicleTypeId))
    // `transfer_routes.from_place_id`/`to_place_id` are both NOT NULL with a
    // RESTRICT foreign key, so these joins drop nothing a route could have —
    // they exist only to reach each place's `is_active`, the other half of
    // the soft delete (see above). Two ALIASED joins, never two unaliased
    // joins to the same table.
    .innerJoin(fromPlace, eq(fromPlace.id, transferRoutes.fromPlaceId))
    .innerJoin(toPlace, eq(toPlace.id, transferRoutes.toPlaceId))
    .where(
      and(
        eq(transferRoutes.id, routeId),
        eq(transferRoutes.isActive, true),
        eq(fromPlace.isActive, true),
        eq(toPlace.isActive, true),
        eq(vehicleTypes.isActive, true),
      ),
    )
    .limit(1);

  if (!row) return null;

  return {
    priceCentavos:
      productType === 'transfer_one_way' ? row.oneWayPriceCentavos : row.dayUsePriceCentavos,
    freeCancelHours: row.freeCancelHours,
    routeDurationMinutes: row.routeDurationMinutes,
    vehicleTypeName: row.vehicleTypeName,
    pricingMode: row.pricingMode,
    minPayingPax: row.minPayingPax,
    defaultSeats: row.defaultSeats,
  };
}
