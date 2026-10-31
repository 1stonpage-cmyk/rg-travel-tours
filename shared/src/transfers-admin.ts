/**
 * Admin transfer-route editing — the shapes `admin.transferRoutes.*` accepts
 * and returns (transfers-launch plan, Task T3; Architecture §1 and §5).
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
 * **`prices` is an OBJECT keyed by vehicle type, not an array.** `{ van: …,
 * suv: … }` makes "a duplicate vehicle type" and "a missing vehicle type"
 * impossible to express rather than something a `.refine()` has to catch after
 * the fact — and a save that states one vehicle type's price always states the
 * other's too, which is the shape that keeps `services/transfers/upsert-route
 * .ts`'s delete-then-reinsert from ever being handed half a price card.
 */
import { z } from 'zod';
import { MAX_CENTAVOS } from './tours-admin';
import type { VehicleType } from './transfers';

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
 * A route's whole price card: both vehicle types, both products.
 *
 * Keyed rather than listed — see this file's header. The keys are spelled out
 * instead of built from `VEHICLE_TYPES` so that adding a third vehicle type to
 * that constant is a COMPILE error here and in the upsert service, rather than
 * a silently unpriced vehicle.
 */
export const transferRoutePricesInputSchema = z
  .object({
    van: transferRouteVehiclePriceInputSchema,
    suv: transferRouteVehiclePriceInputSchema,
  })
  .strict();
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
 * `admin.transferRoutes.create` — the whole route plus its whole price card.
 *
 * `prices` is REQUIRED, with no default: a route with no prices is one no
 * guest can book, and the wrong reading of an omitted price card ("leave them
 * alone" on a create, where there is nothing to leave alone) is the same
 * hazard `tours-admin.ts` records for an omitted `priceTiers`.
 */
export const transferRouteCreateInputSchema = z
  .object({
    destinationId: z.number().int().positive(),
    slug: transferRouteSlugSchema,
    estimatedDurationMinutes: z.number().int().min(1).max(1440),
    freeCancelHours: z.number().int().min(0).max(168),
    inclusionsText: z.string().trim().max(5000).nullable(),
    exclusionsText: z.string().trim().max(5000).nullable(),
    prices: transferRoutePricesInputSchema,
  })
  .strict();
export type TransferRouteCreateInput = z.infer<typeof transferRouteCreateInputSchema>;

/**
 * `transferRouteCreateInputSchema.partial()`, refined to require at least one
 * key — the same shape, and the same message, as `vanPatchSchema` in
 * `server/src/routers/admin/vans.ts`.
 *
 * `.partial()` is SHALLOW, which is load-bearing rather than incidental:
 * `prices` is either absent entirely or a complete price card for both vehicle
 * types. There is no way to post half of one, so the server never has to guess
 * what the unstated half was — and an absent `prices` means "do not touch the
 * price rows", which the router implements by merging the patch over the
 * STORED prices before handing a complete card to the upsert (see
 * `mergeTransferRoutePatch`).
 *
 * `.strict()` on the base object carries through `.partial()` (proven for
 * `vanInputSchema` by `admin-vans.test.ts`), so `isActive` cannot be smuggled
 * through the `update` door instead of through `setActive`.
 */
export const transferRoutePatchSchema = transferRouteCreateInputSchema
  .partial()
  .refine((patch) => Object.keys(patch).length > 0, {
    message: 'Provide at least one field to update.',
  });
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
 * vehicle type on that route.
 *
 * **Nullable on purpose, and it is a money decision.** The upsert always
 * writes both rows, so a null here means something wrote this route without
 * going through it (a hand-written INSERT, a half-applied migration). The
 * honest answers are "missing" or a 500; reporting `0` would be a fabricated
 * price, and this project's rule is that a figure nobody entered is shown as
 * absent, never invented (the same treatment the pending DOT/DTI/BIR permit
 * numbers get). The admin screen renders the gap; `update` refuses to merge
 * over it (see `mergeTransferRoutePatch`'s caller).
 */
export type TransferRouteVehiclePriceRow = TransferRouteVehiclePriceInput;

/**
 * One row of `admin.transferRoutes.list` — every editable field plus the
 * destination's NAME.
 *
 * The name is denormalised onto the row the same way `TourAdminListItem`
 * carries `destination: { id, name }`: the list screen has to show a place
 * name beside every route, and a second lookup per row to get it would be an
 * N+1 against a table the list already joins.
 *
 * `isActive` is here even though no input can set it — the admin list is the
 * only place a retired route is visible, and therefore the only place it can
 * be switched back on.
 */
export interface TransferRouteAdminRow {
  id: number;
  destinationId: number;
  destinationName: string;
  slug: string;
  isActive: boolean;
  sortOrder: number;
  estimatedDurationMinutes: number;
  freeCancelHours: number;
  inclusionsText: string | null;
  exclusionsText: string | null;
  /** Keyed by vehicle type, mirroring the input. `null` means no stored row. */
  prices: Record<VehicleType, TransferRouteVehiclePriceRow | null>;
}
