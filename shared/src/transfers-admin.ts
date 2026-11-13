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
import { civilDateSchema, phPhoneSchema } from './checkout';
import { TRANSFER_PLACE_TYPES, TRANSFER_PRODUCT_TYPES } from './transfers';
import type { TransferPlaceType } from './transfers';
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
  placeType: TransferPlaceType;
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
  /**
   * How many `transfer_routes` rows reference this place as either
   * `fromPlaceId` or `toPlaceId`, active or not — a "can I retire this place
   * without surprising anyone" signal for the admin list (Task 1C). Never
   * consulted by sellability or capacity.
   */
  routeCount: number;
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
    placeType: z.enum(TRANSFER_PLACE_TYPES),
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

// ---------------------------------------------------------------------------
// Quote & convert — turning a `transfer_custom` inquiry into a real booking
// ---------------------------------------------------------------------------

/**
 * A civil `HH:mm` clock label, Asia/Manila — the same pattern
 * `transfers-checkout.ts`'s own `CLOCK_TIME_PATTERN` uses, character for
 * character, because both feed the identical `clockTimeToMinutes()` backstop
 * in `server/src/services/transfers/overlap.ts`. Not imported from there:
 * that file's own header explains why it sits downstream of `./checkout` and
 * `./booking` to avoid a module cycle, which would make importing FROM it
 * into THIS file (which `./checkout` already sits upstream of) a cycle the
 * other way. Two three-line constants are cheaper than that cycle.
 */
const CLOCK_TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;
const clockTimeField = (message: string) => z.string().regex(CLOCK_TIME_PATTERN, message);

/**
 * `admin.transferQuotes.convert` (transfers-launch plan, Task T19; §6 step 2)
 * — owner or finance turning a `transfer_custom` inquiry into a real, held
 * transfer booking. Gated `adminProcedure('transferQuoting')`; a dispatcher
 * cannot reach this procedure at all (ROLE_MATRIX, not a hidden button).
 *
 * **Deliberately NOT the `createHoldTransferInput` (`transfers-checkout.ts`)
 * extended or reused** — that file's own header states the controller ruling
 * (2026-11-03) that the custom-description branch belongs to this task and
 * does not come through the guest input at all. This is its own schema.
 *
 * **Two fields §6 step 2 lists as staff-filled are deliberately absent here,
 * because they already exist on the inquiry row and are not re-typed:**
 *
 *  - the route description — `inquiries.routeDescription`. There is no
 *    `customRouteDescription` field on this input; the service reads the
 *    inquiry's own text and passes it to `createTransferBooking()` verbatim.
 *    A stray guest typo in it is a staff phone call away from a fix; it is
 *    the request, not a value staff restate.
 *  - notes — `inquiries.message` becomes `bookings.requests`, the same reuse
 *    `CreateTransferBookingInput.requests` documents for a guest hold.
 *
 * `routeDescription` is nullable at the database (Task T17's own decision
 * not to add a CHECK), so the service re-validates it is actually present
 * before calling `createTransferBooking()` and refuses with a named reason
 * if not — the same "throw rather than silently coerce" discipline
 * `requireVehicleTypeId()`/`requireDirection()` (`reports/money.ts`, Task
 * T18) already use for this exact class of nullable-column gap. `message`
 * needs no such guard: it is `NOT NULL` on `inquiries`, unlike
 * `routeDescription` (dedicated-review nitpick #6 — a previous version of
 * this comment claimed otherwise).
 *
 * **`pax` and `leadPhone` are two fields the §6 step 2 list does NOT name,
 * added anyway, and both required here.** That list is prefaced "the full
 * set of transfer-booking fields" — illustrative, not exhaustive — and both
 * read the same way once `assertBookableShape()` is read closely:
 *
 *  - `inquiries.pax` is nullable (Task T17 added no CHECK on it either), and
 *    `assertBookableShape`'s `pax_not_positive` refusal would otherwise make
 *    any inquiry where the guest skipped it permanently unconvertible — the
 *    exact dead-end `leadPhone` below is written to avoid. Staff confirm the
 *    head count by phone along with everything else; this input is
 *    pre-filled from `inquiries.pax` when present (Task T20) and typed when
 *    not.
 *  - `inquiries.phone` is nullable (a guest may skip it on the public form)
 *    while `bookings.leadPhone` and `TransferBookingLead.phone` are both
 *    `NOT NULL` — the asymmetry `inquiries.name`/`inquiries.email` do not
 *    have, since those two columns are `NOT NULL` already and so need no
 *    counterpart here. `name`/`email` are therefore read from the inquiry
 *    row, never re-typed; `leadPhone` is typed (pre-filled from
 *    `inquiries.phone` by the client when present, Task T20) so a guest who
 *    gave no number — or typed one wrong — does not block a conversion staff
 *    have already picked up the phone to confirm.
 *
 * **`customRouteDurationMinutes` closes a real gap named in the codebase
 * itself, not in the plan.** `services/transfers/overlap.ts`'s
 * `computeTransferWindow()` THROWS for a one-way transfer with no stored
 * duration, and its own doc comment says so in these words: a custom,
 * routeless trip "has no stored duration anywhere in the schema… Task T19
 * must either carry an explicit staff-entered duration… or compute a window
 * some other way; it must not soften this into a default." This is that
 * explicit duration. Required for `transfer_one_way`, refused for
 * `transfer_day_use` by the `superRefine` below (a day-use window ends at
 * `dayUseEndTime` and needs no duration) — the mirror image of the
 * `dayUseEndTime` conditional already in this schema. `createTransferBooking()`
 * refuses a missing one with its own new `custom_one_way_needs_duration`
 * reason, so the two cannot disagree about when it is required.
 *
 * **No `couponCode`, no `payMode`, no `direction`:**
 *
 *  - A coupon is a self-serve discount a guest types at checkout; §6 names no
 *    discount for a staff quote, and `priceCentavos` is already the one
 *    legitimate staff-entered figure (Architecture §3) — a second discount
 *    layered on top of it would be a second, undocumented price adjustment.
 *  - `payMode` is a guest's own choice of paying in full or by deposit now;
 *    nobody is at checkout yet when staff convert a request, so the service
 *    passes `'deposit'` — §6 step 5's own description of what happens next
 *    ("deposit online/QR or wait for cash collection on the day").
 *  - `direction` describes which way a CATALOG route runs; this booking has
 *    none (`routeId` is always null on this path), so the service always
 *    passes `'forward'`, the same normalisation `revenueByRoute()` (Task T18)
 *    already applies to every routeless transfer for the identical reason.
 *
 * The day-use/flight cross-field rules below are copied from
 * `createHoldTransferInput`'s own `superRefine`, not imported, for the same
 * reason the clock pattern above is copied rather than imported — and for the
 * same reason that file states for its own copy of the rule:
 * `assertBookableShape()` is the backstop both schemas restate in a friendlier
 * sentence, and the two must never disagree.
 */
export const transferQuoteConvertInput = z
  .object({
    inquiryId: z.number().int().positive(),
    vehicleTypeId: z.number().int().positive(),
    productType: z.enum(TRANSFER_PRODUCT_TYPES),
    /** The civil PICKUP date in Asia/Manila. */
    date: civilDateSchema,
    pickupTime: clockTimeField('Enter a pickup time as HH:mm, like 08:30.'),
    /** Day-use only — required/refused by the `superRefine` below. */
    dayUseEndTime: clockTimeField('Enter an end time as HH:mm, like 17:00.').optional(),
    /**
     * One-way only — required/refused by the `superRefine` below, the mirror
     * image of `dayUseEndTime`. See this schema's own header note on the gap
     * it closes.
     */
    customRouteDurationMinutes: z
      .number()
      .int('Enter a whole number of minutes.')
      .min(1, 'Enter how long this trip takes, in minutes.')
      .max(1440, 'Enter a duration of less than 24 hours.')
      .optional(),
    pax: z
      .number()
      .int('Enter a whole number of passengers.')
      .min(1, 'Enter how many passengers are travelling.')
      .max(30, 'For a party that size, please arrange several vehicles.'),
    luggageCount: z
      .number()
      .int('Enter a whole number of bags.')
      .min(0, 'Enter how many bags you are bringing (0 if none).')
      .max(200, 'Enter how many bags you are bringing (up to 200).'),
    pickup: z
      .string()
      .max(400, 'Enter a shorter pickup address (up to 400 characters).')
      .optional(),
    pickupMapUrl: z
      .url('Enter a valid map link for the pickup, or leave it blank.')
      .max(500, 'That map link is too long — please shorten it or leave it blank.')
      .optional(),
    dropoffAddress: z
      .string()
      .min(1, 'Enter where this trip is going.')
      .max(400, 'Enter a shorter drop-off address (up to 400 characters).'),
    dropoffMapUrl: z
      .url('Enter a valid map link for the drop-off, or leave it blank.')
      .max(500, 'That map link is too long — please shorten it or leave it blank.')
      .optional(),
    /** One-way only, refused on a day-use hire by the `superRefine` below. */
    flightNumber: z.string().max(20, 'Enter a shorter flight number.').optional(),
    airline: z.string().max(80, 'Enter a shorter airline name.').optional(),
    ferryVesselName: z.string().max(120, 'Enter a shorter vessel name.').optional(),
    ferryArrivalTime: z
      .string()
      .regex(CLOCK_TIME_PATTERN, 'Enter an arrival time as HH:mm, like 14:30.')
      .optional(),
    /**
     * A phone number staff can call, even when the guest gave none — see this
     * schema's own header note. Normalises exactly as `createHoldInput.lead`'s
     * own phone field does.
     */
    leadPhone: phPhoneSchema,
    /**
     * Pesos, converted to centavos by the client, re-validated as whole,
     * positive centavos here. `createTransferBooking()` still applies the
     * ₱100 gateway floor itself, under its own lock, exactly as it would for
     * a catalog price; this boundary refuses a figure that cannot be a price
     * at all, in both directions.
     *
     * **Capped at `MAX_CENTAVOS`, unlike `admin.refunds.refundPayment`'s bare
     * `.positive()` `amountCentavos`** (dedicated-review should-fix #1) —
     * that field's own comment explains why it needs no cap here:
     * `recordPayment()` caps it under the booking row lock before it ever
     * reaches a column. This field has no such downstream cap; it is the
     * figure `createTransferBooking()` freezes onto `bookings.total_centavos`
     * (an `INT` column — see `transferPriceCentavosSchema` above, which this
     * mirrors) essentially unchanged. Without this, a staff typo overflowing
     * `INT` would roll back as a bare MySQL error-1264 rather than the named,
     * screen-showable refusal this project's other money fields all give.
     */
    priceCentavos: z
      .number()
      .int()
      .positive('Enter a quoted price in pesos.')
      .max(MAX_CENTAVOS, 'That price is too large — please double-check it.'),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.productType === 'transfer_day_use') {
      if (value.dayUseEndTime === undefined) {
        ctx.addIssue({
          code: 'custom',
          path: ['dayUseEndTime'],
          message: 'Tell us what time you need the vehicle until.',
        });
      } else if (
        CLOCK_TIME_PATTERN.test(value.pickupTime) &&
        value.dayUseEndTime <= value.pickupTime
      ) {
        ctx.addIssue({
          code: 'custom',
          path: ['dayUseEndTime'],
          message: 'The end time must be later than the pickup time.',
        });
      }
      for (const field of [
        'flightNumber',
        'airline',
        'ferryVesselName',
        'ferryArrivalTime',
      ] as const) {
        if (value[field] !== undefined) {
          ctx.addIssue({
            code: 'custom',
            path: [field],
            message: 'A day-use hire carries no flight — please leave the flight details blank.',
          });
        }
      }
      if (value.customRouteDurationMinutes !== undefined) {
        ctx.addIssue({
          code: 'custom',
          path: ['customRouteDurationMinutes'],
          message: 'A day-use hire has no fixed duration — please leave this blank.',
        });
      }
      return;
    }

    if (value.dayUseEndTime !== undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['dayUseEndTime'],
        message: 'A one-way transfer has no end time — please leave it blank.',
      });
    }
    if (value.customRouteDurationMinutes === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['customRouteDurationMinutes'],
        message: 'Enter how long this trip takes, in minutes.',
      });
    }
  });
export type TransferQuoteConvertInput = z.infer<typeof transferQuoteConvertInput>;
