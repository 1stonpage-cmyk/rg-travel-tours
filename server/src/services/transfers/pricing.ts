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
 *
 * **A transfer's price is a FLAT PER-VEHICLE rate.** That is the whole
 * difference from the tour formula: there is no tier, no head count and no
 * per-person multiplication anywhere below, because a van costs what a van
 * costs whether one guest or eight ride in it. `quoteTransfer` therefore takes
 * no `pax` parameter at all — the absence is the contract (a test pins it), so
 * a later task needing a passenger count for the seat-fit check (pre-task 0C)
 * must read it where capacity is decided, never here.
 *
 * Architecture §3's formula, verbatim:
 *
 *   subtotal        = vehiclePriceForRouteAndType(route, vehicleType, productType)
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
import { depositCentavos, type TransferProductType, type VehicleType } from '@rg/shared';
import { getDb, type Database, type Transaction } from '../../db/client';
import { destinations, transferRouteVehiclePrices, transferRoutes } from '../../db/schema';
import { discountCentavosFor, type QuoteCoupon } from '../pricing';

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
}

/**
 * The catalog price for one route + vehicle type at one product, or `null`.
 *
 * `null` means every normal "we cannot quote that" case: no such route, a
 * RETIRED route, a route whose DESTINATION is retired, or a route with no price
 * row for the requested vehicle type. **None of those throws.** They are all
 * guest-reachable answers a router turns into a `NOT_FOUND`, not internal
 * failures that deserve a 500 — the same treatment `loadQuoteInputs`' add-on
 * sweep gives a stale add-on id.
 *
 * **Both halves of the soft delete are checked, and that is the point of the
 * join to `destinations`** (T9 review, Important finding). `transferRoutes.list`
 * filters on `transfer_routes.is_active` AND `destinations.is_active`; this
 * function at first filtered only on the route's own flag, so deactivating a
 * destination on the existing destinations screen took the route off the public
 * list while this still quoted it — a live price for a place the business has
 * withdrawn, reachable from a stale tab or by probing small route ids. The two
 * surfaces now ask the same question, which is what lets each stand alone:
 * neither relies on the other having filtered first, and T10 turns this answer
 * into a real reservation.
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
  vehicleType: VehicleType,
  productType: TransferProductType,
  db: Database | Transaction = getDb(),
): Promise<TransferVehiclePrice | null> {
  const [row] = await db
    .select({
      freeCancelHours: transferRoutes.freeCancelHours,
      routeDurationMinutes: transferRoutes.estimatedDurationMinutes,
      oneWayPriceCentavos: transferRouteVehiclePrices.oneWayPriceCentavos,
      dayUsePriceCentavos: transferRouteVehiclePrices.dayUsePriceCentavos,
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
        eq(transferRouteVehiclePrices.vehicleType, vehicleType),
      ),
    )
    // `transfer_routes.destination_id` is NOT NULL with a RESTRICT foreign key,
    // so this join drops nothing a route could have — it exists only to reach
    // `destinations.is_active`, the second half of the soft delete (see above).
    .innerJoin(destinations, eq(destinations.id, transferRoutes.destinationId))
    .where(
      and(
        eq(transferRoutes.id, routeId),
        eq(transferRoutes.isActive, true),
        eq(destinations.isActive, true),
      ),
    )
    .limit(1);

  if (!row) return null;

  return {
    priceCentavos:
      productType === 'transfer_one_way' ? row.oneWayPriceCentavos : row.dayUsePriceCentavos,
    freeCancelHours: row.freeCancelHours,
    routeDurationMinutes: row.routeDurationMinutes,
  };
}
