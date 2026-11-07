/**
 * Admin transfer-route editing — the shapes `admin.transferRoutes.*` accepts
 * and returns (transfers-launch plan, Task T3; Architecture §1 and §5).
 * Restructured 2026-11-08 (owner decision: flexible places/routes/vehicle
 * types — see `docs/superpowers/plans/2026-11-08-flexible-routes.md`).
 *
 * **This file describes money.** `oneWayPriceCentavos` and
 * `dayUsePriceCentavos` are what a guest is charged for a private transfer —
 * there is no per-head multiplication, so each one IS the subtotal a quote
 * starts from. Both are integer CENTAVOS (CLAUDE.md, "Money"), never a float
 * and never a peso string: a price typed as `1999.5` is a refusal at this
 * boundary, not a rounding decision somewhere downstream.
 *
 * **Every object is `.strict()`.** Two columns on `transfer_routes` are
 * therefore structurally unreachable from here:
 *
 *  - `isActive` — the soft-delete switch, owned by
 *    `admin.transferRoutes.setActive` alone, exactly as `coupons.is_active` is
 *    owned by `admin.coupons.setActive` (CLAUDE.md, "Soft deletes"). One
 *    writer, one audit action, one question to answer when asking who retired
 *    a route.
 *  - `createdAt` / `updatedAt` — Drizzle's own `$defaultFn` / `$onUpdateFn`.
 *
 * **`prices` is keyed by vehicle-type id, as a SPARSE but COMPLETE card
 * (owner decision 2026-11-08, decision 4 — reversing the old "exactly two
 * rows" rule).** A key absent from the posted object means "not offered on
 * this route" (zero price rows for that type), not "leave whatever was
 * there" — there is no partial-patch form of `prices`: `update`'s patch
 * either omits the `prices` key entirely (keep the stored card unchanged) or
 * sends the WHOLE new card. The compile-time link `VEHICLE_TYPES.map(...)`
 * used to provide (a third enum member became a type error here until this
 * schema gained the key) is gone now that vehicle types are a runtime list,
 * not a compile-time union — a runtime check and a dedicated test
 * (`admin-transfer-routes.test.ts`, "a patch naming one type's price does
 * not remove any other type's existing row") replace it. JSON object keys
 * are always strings, so the wire shape is `Record<string, PriceInput |
 * null>` keyed by the STRINGIFIED `vehicleTypeId`; the router is responsible
 * for converting those keys back to numbers before calling the upsert
 * service.
 */
import { z } from 'zod';
import { MAX_CENTAVOS } from './tours-admin';

/**
 * One transfer price, as this project stores money: integer centavos.
 *
 * `min(1)`, not `nonnegative()`, and that is the difference from
 * `tours-admin.ts`'s `centavosSchema`: a tour add-on may legitimately cost
 * nothing, but a route priced at zero is a product that cannot be sold at all
 * — `checkout`'s own ₱0 refusal (CLAUDE.md, "Checkout & payments") would turn
 * every booking of it away, so it is refused here where an owner can see why.
 * Capped at `MAX_CENTAVOS` because the column is `INT`: a larger value is a
 * driver-level overflow rather than a refusal a screen can show.
 */
const transferPriceCentavosSchema = z.number().int().min(1).max(MAX_CENTAVOS);

/** Both prices for ONE vehicle type on one route. */
export const transferRouteVehiclePriceInputSchema = z
  .object({
    oneWayPriceCentavos: transferPriceCentavosSchema,
    dayUsePriceCentavos: transferPriceCentavosSchema,
  })
  .strict();
export type TransferRouteVehiclePriceInput = z.infer<typeof transferRouteVehiclePriceInputSchema>;

/**
 * A route's whole price card: every OFFERED vehicle type's one-way and
 * day-use price, keyed by the stringified `vehicleTypeId`. A key absent from
 * this object is "not offered" — see this file's header for the completeness
 * contract a present `prices` object must satisfy. The key pattern refuses a
 * non-numeric key before it ever reaches a database lookup.
 */
export const transferRoutePricesInputSchema = z.record(
  z.string().regex(/^\d+$/, 'Vehicle type keys must be numeric ids.'),
  transferRouteVehiclePriceInputSchema.nullable(),
);
export type TransferRoutePricesInput = z.infer<typeof transferRoutePricesInputSchema>;

/** `transfer_routes.id`, and the id of a route being edited. */
const transferRouteIdSchema = z.number().int().positive();

/**
 * Trims surrounding whitespace, then lowercases.
 *
 * Exported because the normalisation is a fact about a slug rather than about
 * one schema: anything that later has to ask "is this the same route" — a
 * lookup, an import, a seed — must ask it of the same normalised form.
 */
export function normalizeTransferRouteSlug(slug: string): string {
  return slug.trim().toLowerCase();
}

/**
 * A route's URL segment: `mactan-airport`.
 *
 * **Two separate reasons this is more than `z.string().max(80)`** (fix round,
 * review finding I2 — fixed while both databases still held zero routes, so
 * no data migration and no broken shared link was involved):
 *
 *  1. **It is destined for a public URL.** A later task publishes
 *     `/transfers/:slug`, and the SEO resolver puts the same string in a
 *     canonical and in `/sitemap.xml`. An owner typing `Mactan Airport` or
 *     `Oslob/Sumilon` into the admin form would produce a canonical containing
 *     `%20`, or a path the SPA router 404s on, and the sitemap guard test
 *     clears `content_unverified` first on purpose — so a malformed URL there
 *     would not be hidden by the site-wide noindex gate. The pattern is
 *     `tourFields.slug`'s own, character for character, because a transfer
 *     route's URL and a tour's are the same kind of thing.
 *  2. **`transfer_routes.slug` is UNIQUE, and that UNIQUE must not depend on
 *     the MySQL collation.** `.transform()` runs
 *     {@link normalizeTransferRouteSlug} BEFORE `.pipe()`'s shape check — the
 *     `bookingRefSchema` ordering (CLAUDE.md, BUG-108) — so `Moalboal`,
 *     `MOALBOAL` and `  moalboal  ` all reach the column as the one byte
 *     sequence `moalboal` and collide on an exact match. CLAUDE.md names
 *     leaning on the `_ci` collation twice as a thing not to repeat (BUG-108
 *     on `bookings.ref`, BUG-107 on `coupons.code`); this is the third place
 *     it could have happened and it does not.
 *
 * Normalising first is not a loosening: a string that is still the wrong
 * charset after trimming and lowercasing is refused exactly as it would have
 * been. The message shows the shape rather than naming the rule, the way every
 * other refusal in this codebase does.
 */
export const transferRouteSlugSchema = z
  .string()
  .transform(normalizeTransferRouteSlug)
  .pipe(
    z
      .string()
      .min(1)
      .max(80)
      .regex(
        /^[a-z0-9]+(?:-[a-z0-9]+)*$/,
        'Use lowercase letters, numbers and hyphens, like mactan-airport.',
      ),
  );

/**
 * The route's fields, unrefined — the base both `create` and the `update`
 * patch are built from. Kept separate from `transferRouteCreateInputSchema`
 * because `.refine()` turns a `ZodObject` into a `ZodEffects`, which has no
 * `.partial()`; the patch needs the plain object to shallow-partial.
 */
const transferRouteFieldsSchema = z
  .object({
    fromPlaceId: z.number().int().positive(),
    toPlaceId: z.number().int().positive(),
    /** Same route, same prices, same duration, the other way too. Owner decision 2026-11-08. */
    reverseEnabled: z.boolean(),
    slug: transferRouteSlugSchema,
    /**
     * Where this route sorts among its siblings, lowest first — mirrors
     * `tours-admin.ts`'s `sortOrder` field on `tourFields` exactly. Optional
     * with no default STATED here (the column's own `DEFAULT 0` is what
     * fills it in on create, via `upsertTransferRoute`'s `params.sortOrder ??
     * 0`), so an owner who never touches this field gets the same "sorts
     * with everything else at 0" behaviour every route had before this field
     * existed (T4, carried forward from T3's review finding M3).
     */
    sortOrder: z.number().int().min(0).max(9999).optional(),
    estimatedDurationMinutes: z.number().int().min(1).max(1440),
    freeCancelHours: z.number().int().min(0).max(168),
    inclusionsText: z.string().trim().max(5000).nullable(),
    exclusionsText: z.string().trim().max(5000).nullable(),
    prices: transferRoutePricesInputSchema,
  })
  .strict();

/**
 * `admin.transferRoutes.create` — the whole route plus its whole price card.
 *
 * `prices` is REQUIRED, with no default: a route with no prices is one no
 * guest can book, and the wrong reading of an omitted price card ("leave them
 * alone" on a create, where there is nothing to leave alone) is the same
 * hazard `tours-admin.ts` records for an omitted `priceTiers`.
 *
 * `fromPlaceId !== toPlaceId` is enforced here (both ids are always present
 * on a create). The identical check for `update` cannot live in a schema —
 * a patch may name only one of the two ids, and knowing whether it collides
 * with the OTHER one requires the stored route — so it is enforced in
 * `upsertTransferRoute()` after merging the patch over the stored row.
 */
export const transferRouteCreateInputSchema = transferRouteFieldsSchema.refine(
  (input) => input.fromPlaceId !== input.toPlaceId,
  { message: 'A route cannot start and end at the same place.', path: ['toPlaceId'] },
);
export type TransferRouteCreateInput = z.infer<typeof transferRouteCreateInputSchema>;

/**
 * `transferRouteFieldsSchema.partial()`, refined to require at least one
 * key — the same shape, and the same message, as `vanPatchSchema` in
 * `server/src/routers/admin/vans.ts`. Also refuses a patch that names BOTH
 * ids and makes them equal — the one self-reference case a schema CAN catch
 * without reading the stored row.
 *
 * `.partial()` is SHALLOW, which is load-bearing rather than incidental:
 * `prices` is either absent entirely or a complete price card. There is no
 * way to post half of one, so the server never has to guess what the
 * unstated half was — and an absent `prices` means "do not touch the price
 * rows", which the router implements by merging the patch over the STORED
 * prices before handing a complete card to the upsert (see
 * `mergeTransferRoutePatch`).
 *
 * `.strict()` on the base object carries through `.partial()` (proven for
 * `vanInputSchema` by `admin-vans.test.ts`), so `isActive` cannot be smuggled
 * through the `update` door instead of through `setActive`.
 */
export const transferRoutePatchSchema = transferRouteFieldsSchema
  .partial()
  .refine((patch) => Object.keys(patch).length > 0, {
    message: 'Provide at least one field to update.',
  })
  .refine(
    (patch) =>
      patch.fromPlaceId === undefined ||
      patch.toPlaceId === undefined ||
      patch.fromPlaceId !== patch.toPlaceId,
    { message: 'A route cannot start and end at the same place.', path: ['toPlaceId'] },
  );
export type TransferRoutePatch = z.infer<typeof transferRoutePatchSchema>;

/** `admin.transferRoutes.update` — which route, and what changed about it. */
export const transferRouteUpdateInputSchema = z
  .object({ id: transferRouteIdSchema, patch: transferRoutePatchSchema })
  .strict();
export type TransferRouteUpdateInput = z.infer<typeof transferRouteUpdateInputSchema>;

/**
 * `admin.transferRoutes.setActive`. The soft delete, modelled on
 * `couponActiveInput`: switching a route off stops it being sellable and
 * deletes nothing — not the route, not its price rows, and not any booking
 * that already took one of those prices (a booking carries its own
 * `price_snapshot`).
 */
export const transferRouteActiveInputSchema = z
  .object({ id: transferRouteIdSchema, isActive: z.boolean() })
  .strict();
export type TransferRouteActiveInput = z.infer<typeof transferRouteActiveInputSchema>;

/**
 * One vehicle type's stored prices, as `admin.transferRoutes.list` returns
 * them — or `null` when `transfer_route_vehicle_prices` holds no row for that
 * vehicle type on that route (owner decision 2026-11-08: `null` here now
 * means "not offered on this route", a legitimate and common state, not an
 * anomaly — see `TransferRoutePricesInput`'s header for the completeness
 * contract this mirrors).
 */
export type TransferRouteVehiclePriceRow = TransferRouteVehiclePriceInput;

/** One active vehicle type's price row on the admin list — `price: null` means "not offered". */
export interface TransferRouteAdminVehiclePrice {
  vehicleTypeId: number;
  vehicleTypeName: string;
  slug: string;
  price: TransferRouteVehiclePriceRow | null;
}

/** One pickup/drop-off place, as the admin route list/form needs it. */
export interface TransferPlaceAdminRow {
  id: number;
  name: string;
  isAirport: boolean;
  isActive: boolean;
}

/**
 * One row of `admin.transferPlaces.list` — every editable field, unlike
 * {@link TransferPlaceAdminRow} (which the route list denormalises and has
 * no use for `sortOrder` or `destinationId`). The places screen is the one
 * surface that edits a place directly, so it needs the whole row.
 */
export interface TransferPlaceAdminListRow extends TransferPlaceAdminRow {
  sortOrder: number;
  /** The optional, informational-only cross-link to `destinations.id`. */
  destinationId: number | null;
}

/**
 * `vehicle_types.slug` is varchar(40) — the same normalisation discipline as
 * {@link normalizeTransferRouteSlug} (trim then lowercase, BEFORE the shape
 * check — BUG-108's ordering), its own function only because the owning
 * table and length bound differ.
 */
export function normalizeVehicleTypeSlug(slug: string): string {
  return slug.trim().toLowerCase();
}

/**
 * A vehicle type's URL-safe-shaped slug. Vehicle types grow no public URL
 * today, but the slug is still a natural key other code (seed data, a
 * future import) may look up by, so it gets the same hygiene
 * `transferRouteSlugSchema` applies rather than a looser one invented for
 * "it's only an admin field."
 */
const vehicleTypeSlugSchema = z
  .string()
  .transform(normalizeVehicleTypeSlug)
  .pipe(
    z
      .string()
      .min(1)
      .max(40)
      .regex(
        /^[a-z0-9]+(?:-[a-z0-9]+)*$/,
        'Use lowercase letters, numbers and hyphens, like mini-van.',
      ),
  );

/**
 * The fields of one vehicle type, unrefined — the base both `create` and the
 * `update` patch are built from, mirroring `transferRouteFieldsSchema`'s own
 * split for the same reason (`.refine()` would turn this into a `ZodEffects`,
 * which has no `.partial()`).
 */
const vehicleTypeFieldsSchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    slug: vehicleTypeSlugSchema,
    /** Prefill only for the admin "add van" form — never consulted by capacity or dispatch. */
    defaultSeats: z.number().int().min(1).max(30).nullable(),
    /** Prefill only — see `defaultSeats`. */
    defaultLuggage: z.number().int().min(0).max(200).nullable(),
    sortOrder: z.number().int().min(0).max(9999).optional(),
  })
  .strict();

/** `admin.vehicleTypes.create`. */
export const vehicleTypeCreateInputSchema = vehicleTypeFieldsSchema;
export type VehicleTypeCreateInput = z.infer<typeof vehicleTypeCreateInputSchema>;

/**
 * `vehicleTypeFieldsSchema.partial()`, refined to require at least one key —
 * the same shape and the same message `transferRoutePatchSchema` uses.
 */
export const vehicleTypePatchSchema = vehicleTypeFieldsSchema
  .partial()
  .refine((patch) => Object.keys(patch).length > 0, {
    message: 'Provide at least one field to update.',
  });
export type VehicleTypePatch = z.infer<typeof vehicleTypePatchSchema>;

/** `admin.vehicleTypes.update` — which type, and what changed about it. */
export const vehicleTypeUpdateInputSchema = z
  .object({ id: z.number().int().positive(), patch: vehicleTypePatchSchema })
  .strict();
export type VehicleTypeUpdateInput = z.infer<typeof vehicleTypeUpdateInputSchema>;

/** `admin.vehicleTypes.setActive`. The soft delete. */
export const vehicleTypeActiveInputSchema = z
  .object({ id: z.number().int().positive(), isActive: z.boolean() })
  .strict();
export type VehicleTypeActiveInput = z.infer<typeof vehicleTypeActiveInputSchema>;

/** One row of `admin.vehicleTypes.list` — every editable field. */
export interface VehicleTypeAdminRow {
  id: number;
  name: string;
  slug: string;
  defaultSeats: number | null;
  defaultLuggage: number | null;
  isActive: boolean;
  sortOrder: number;
}

/**
 * The fields of one transfer place, unrefined — mirrors
 * `transferRouteFieldsSchema`'s own split.
 *
 * `destinationId` is `.nullable()` with no `.optional()`, the same
 * discipline `driverInputSchema.maxTransferJobsPerDay` uses: a `create` must
 * say explicitly that there is no cross-link rather than silently omit the
 * field. The id's existence is checked by the router/service against
 * `destinations`, not here — a Zod schema cannot see the database.
 */
const transferPlaceFieldsSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    isAirport: z.boolean(),
    sortOrder: z.number().int().min(0).max(9999).optional(),
    destinationId: z.number().int().positive().nullable(),
  })
  .strict();

/** `admin.transferPlaces.create`. */
export const transferPlaceCreateInputSchema = transferPlaceFieldsSchema;
export type TransferPlaceCreateInput = z.infer<typeof transferPlaceCreateInputSchema>;

/**
 * `transferPlaceFieldsSchema.partial()`, refined to require at least one
 * key — the same shape and the same message every other patch schema in
 * this file uses.
 */
export const transferPlacePatchSchema = transferPlaceFieldsSchema
  .partial()
  .refine((patch) => Object.keys(patch).length > 0, {
    message: 'Provide at least one field to update.',
  });
export type TransferPlacePatch = z.infer<typeof transferPlacePatchSchema>;

/** `admin.transferPlaces.update` — which place, and what changed about it. */
export const transferPlaceUpdateInputSchema = z
  .object({ id: z.number().int().positive(), patch: transferPlacePatchSchema })
  .strict();
export type TransferPlaceUpdateInput = z.infer<typeof transferPlaceUpdateInputSchema>;

/** `admin.transferPlaces.setActive`. The soft delete. */
export const transferPlaceActiveInputSchema = z
  .object({ id: z.number().int().positive(), isActive: z.boolean() })
  .strict();
export type TransferPlaceActiveInput = z.infer<typeof transferPlaceActiveInputSchema>;

/**
 * One row of `admin.transferRoutes.list` — every editable field plus both
 * places' names (owner decision 2026-11-08, replacing the single
 * `destinationName`/`destinationIsActive` pair).
 *
 * The places are denormalised onto the row the same way `TourAdminListItem`
 * carries `destination: { id, name }`: the list screen has to show both place
 * names beside every route, and a second lookup per row to get them would be
 * an N+1 against a table the list already joins.
 *
 * `isActive` is here even though no input can set it — the admin list is the
 * only place a retired route is visible, and therefore the only place it can
 * be switched back on.
 */
export interface TransferRouteAdminRow {
  id: number;
  fromPlace: TransferPlaceAdminRow;
  toPlace: TransferPlaceAdminRow;
  /**
   * Sellability depends on BOTH places being active, not a single
   * destination (owner decision 2026-11-08, retargeting the 2026-11-06 rule
   * from `destinations` to `transfer_places`) — denormalised onto each
   * place row above so the list screen can flag "this route's from/to place
   * is retired, so the route is not sellable even though it shows Active
   * here" without a second lookup per row. Independent of this row's own
   * `isActive`.
   */
  reverseEnabled: boolean;
  slug: string;
  isActive: boolean;
  sortOrder: number;
  estimatedDurationMinutes: number;
  freeCancelHours: number;
  inclusionsText: string | null;
  exclusionsText: string | null;
  /** Every ACTIVE vehicle type, in sort order. `price: null` means "not offered". */
  prices: TransferRouteAdminVehiclePrice[];
}
