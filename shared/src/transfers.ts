/**
 * Shared discriminators for the van/SUV transfer product (owner decision
 * 2026-10-28/31), plus the public QUOTE wire shapes (Task T9).
 *
 * The constants are plain data with no database anywhere near them, so every
 * surface — schema, server, client — reads the same vocabulary. Task T9 added
 * the quote input/result and the public route-list row.
 *
 * **The guest-facing HOLD input lives in `./transfers-checkout.ts`, not here,
 * and that is forced rather than chosen** (Task T11). It has to reuse
 * `PAY_MODES`, `civilDateSchema` and `leadSchema`, which live in `./booking`
 * and `./checkout` — and `./booking` imports THIS file (for
 * `TRANSFER_PRODUCT_TYPES` / `VEHICLE_TYPES`), so importing either of them
 * from here is a module cycle. Measured, not theorised: the whole suite failed
 * at import time with `z.enum(undefined)` inside `checkout.ts`, because
 * `transfers.ts` loaded first and got a half-initialised `./booking` back. So
 * the hold input sits DOWNSTREAM of all three, in a module nothing else
 * imports. Keep adding guest-form fields there rather than widening
 * `quoteTransferInput` below: a quote names a product, a hold describes a
 * journey. Anything admin-shaped belongs in `transfers-admin.ts`.
 */
import { z } from 'zod';

export const VEHICLE_TYPES = ['van', 'suv'] as const;
export type VehicleType = (typeof VEHICLE_TYPES)[number];

/**
 * What a booking IS — the `bookings.product_type` discriminator.
 *
 * `'tour'` is first and is the column's default, because every booking that
 * existed before the column did was a tour. The two transfer members are the
 * two products the plan sells: a one-way point-to-point trip and a day-use
 * hire (the same vehicle held for the day), which price from different
 * columns of `transfer_route_vehicle_prices`.
 */
export const PRODUCT_TYPES = ['tour', 'transfer_one_way', 'transfer_day_use'] as const;
export type ProductType = (typeof PRODUCT_TYPES)[number];

/**
 * What a surface puts where a tour title would go, on a booking that has no
 * tour (Task T6's audit).
 *
 * A booking with `tour_id IS NULL` is a transfer and cannot be anything else —
 * the `bookings_product_type_shape` CHECK says so in the database — so this is
 * a fact about the row rather than a guess, and it is honest wherever a
 * now-nullable `tourTitle` reaches a heading or a label.
 *
 * Deliberately generic. Naming the real route, vehicle type and times is the
 * display work of T18 (reports), T22 (driver portal), T23 (admin screens) and
 * T24 (portal + notification copy); this constant is the single string those
 * tasks replace, and the single grep that finds every place needing it.
 */
export const TRANSFER_BOOKING_LABEL = 'Transfer booking';

/**
 * The two members of {@link PRODUCT_TYPES} that are transfers — everything
 * that can be priced from `transfer_route_vehicle_prices`.
 *
 * `satisfies readonly ProductType[]` is the whole point of declaring it rather
 * than retyping the pair at each call site (`services/transfers/overlap.ts`
 * already spells it inline twice): a rename in `PRODUCT_TYPES` is then a
 * compile error here instead of a string that silently matches nothing. The
 * `'tour'` member is deliberately absent — a tour prices from per-person
 * tiers, and a transfer price is a flat per-vehicle rate.
 */
export const TRANSFER_PRODUCT_TYPES = [
  'transfer_one_way',
  'transfer_day_use',
] as const satisfies readonly ProductType[];
export type TransferProductType = (typeof TRANSFER_PRODUCT_TYPES)[number];

/**
 * Both of one vehicle type's prices on one route: the one-way fare and the
 * day-use hire, integer centavos (CLAUDE.md, "Money").
 *
 * Structurally the same two fields as `transfers-admin.ts`'s
 * `TransferRouteVehiclePriceRow` (which is the Zod-inferred admin INPUT shape)
 * and re-declared here on purpose: `transfers-admin.ts` imports from this file,
 * so importing it back would make a module cycle out of two field names. There
 * is nothing to drift — both describe the same two `NOT NULL` columns.
 */
export interface TransferVehiclePriceRow {
  oneWayPriceCentavos: number;
  dayUsePriceCentavos: number;
}

/**
 * One row of the PUBLIC transfer-route list (Task T9) — what a guest choosing
 * a route is allowed to see.
 *
 * Deliberately narrower than `TransferRouteAdminRow`: `isActive` is absent
 * because the list only ever contains active routes (an inactive one is not
 * "shown as off", it is not shown), and `destinationId` / `sortOrder` are
 * absent because they are internal ordering and join keys a guest has no use
 * for. The destination's NAME is denormalised on, exactly as the admin row
 * does it, because the picker has to show a place name beside every route and a
 * lookup per row would be an N+1.
 *
 * `prices` is `null` for a vehicle type with no stored row — never `0`. A
 * fabricated price is the one answer this project refuses to give (see
 * `TransferRouteVehiclePriceRow`'s own note); a null is a vehicle a surface
 * renders as unavailable rather than free.
 */
export interface TransferRoutePublicRow {
  id: number;
  destinationName: string;
  slug: string;
  estimatedDurationMinutes: number;
  freeCancelHours: number;
  inclusionsText: string | null;
  exclusionsText: string | null;
  prices: Record<VehicleType, TransferVehiclePriceRow | null>;
}

/**
 * What the browser may ask `checkout.quoteTransfer` for (Task T9).
 *
 * **Nothing here is money.** A transfer's price is a flat per-vehicle catalog
 * rate the server reads from `transfer_route_vehicle_prices`, so this input
 * names the route, the vehicle and the product and never a price, a subtotal or
 * a total — `.strict()` makes a request that carries one a REFUSAL rather than
 * a silently dropped field, the same rule `quoteInput` (`checkout.ts`) is built
 * on.
 *
 * There is also no `pax`, and that absence is load-bearing: a transfer is
 * priced per vehicle, so a head count cannot change the figure. T12's hold
 * input will carry the passenger count for the SEAT-FIT check (pre-task 0C),
 * which is a capacity question, never a pricing one.
 *
 * `routeId`, `vehicleType` and `productType` are the three identifiers every
 * later schema in this plan keys on — spelled here so T10/T12 reuse them
 * rather than inventing a second spelling.
 */
export const quoteTransferInput = z
  .object({
    routeId: z.number().int().positive(),
    vehicleType: z.enum(VEHICLE_TYPES),
    productType: z.enum(TRANSFER_PRODUCT_TYPES),
    /*
     * The ONE field on this input a guest types, and so the one whose bound a
     * guest can trip — the same 40-character bound, and the same guest-facing
     * sentence, as `quoteInput.couponCode` in `checkout.ts`. Zod's own default
     * there is written for whoever wrote the bound; this one names the field.
     */
    couponCode: z
      .string()
      .min(1, 'Enter a coupon code of up to 40 characters.')
      .max(40, 'Enter a coupon code of up to 40 characters.')
      .optional(),
  })
  .strict();
export type QuoteTransferInput = z.infer<typeof quoteTransferInput>;

/**
 * The wire shape of a transfer quote (Task T9) — every money field
 * `quoteTransfer()` (`server/src/services/transfers/pricing.ts`) returns, plus
 * the route's free-cancellation window.
 *
 * Two deliberate differences from `quoteResultSchema` (the tour's):
 *
 *  - **No `tier`.** A transfer has no price tier at all; the catalog rate IS
 *    the subtotal.
 *  - **No `quoteId`.** The tour's digest (owner decision Q3) exists so
 *    `createHold()` can detect a price edited between quote and hold by
 *    comparing a replayed client-sent digest. T10's `createTransferBooking()`
 *    re-derives the price itself, server-side, from
 *    `vehiclePriceForRouteAndType()` at hold time and trusts no client total,
 *    so there is nothing left for a digest to protect — and a `quoteId` on this
 *    wire would be a field the hold has no contract for.
 */
export const quoteTransferResultSchema = z.object({
  subtotalCentavos: z.number().int().nonnegative(),
  discountCentavos: z.number().int().nonnegative(),
  totalCentavos: z.number().int().nonnegative(),
  depositCentavos: z.number().int().nonnegative(),
  amountDueNowCentavos: z.object({
    full: z.number().int().nonnegative(),
    deposit: z.number().int().nonnegative(),
  }),
  balanceCentavos: z.object({
    full: z.number().int().nonnegative(),
    deposit: z.number().int().nonnegative(),
  }),
  freeCancelHours: z.number().int().nonnegative(),
});
export type QuoteTransferResult = z.infer<typeof quoteTransferResultSchema>;
