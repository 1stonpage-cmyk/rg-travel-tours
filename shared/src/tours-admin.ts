/**
 * Admin tour editing — the shapes `admin.tours.*` accepts and returns
 * (Week 7 plan, Task 6; BUILD_SPEC §9 "Tours & pricing").
 *
 * **This file describes money.** `pricePerPersonCentavos` is the number
 * `checkout.quote` multiplies by a party size, and `priceCentavos` is what an
 * add-on adds to a total, so both are `z.number().int().nonnegative()` — never
 * a float, never a peso string. CLAUDE.md: integers in centavos everywhere,
 * formatted only at display. A price typed as `1999.5` is a refusal at this
 * boundary, not a rounding decision somewhere downstream.
 *
 * **Every object is `.strict()`.** The screen posts exactly these fields; an
 * extra `isActive` or `historicalTripsCount` is refused rather than quietly
 * ignored, because an input that "drops" a field it was handed looks like it
 * might have honoured it. Two columns are deliberately unreachable from here:
 *
 *  - `isActive` — the soft-delete switch, owned by `admin.tours.setActive`
 *    alone, exactly as `drivers.is_active` is owned by `admin.drivers.setActive`
 *    (CLAUDE.md, "Soft deletes"). One writer, one audit action, one question to
 *    answer when asking who retired a tour.
 *  - `historicalTripsCount` — the "trips run" counter the catalog card shows.
 *    It stays NULL until real bookings can supply it (D8); a field an admin
 *    could type into is the fake social proof CLAUDE.md forbids.
 *
 * **All four child arrays are REQUIRED on both inputs**, because a save states
 * the whole set rather than patching it. That is what makes an OMITTED array
 * dangerous — "leave them alone" or "delete them all" — and the wrong reading
 * of an omitted `priceTiers` is a tour with no prices, which `checkout.quote`
 * cannot quote at all. So there are no defaults: the editing screen loads the
 * detail and posts the whole set back, every time, and `[]` means empty on
 * purpose.
 *
 * **How "the whole set" is applied differs per table, and the difference is a
 * foreign key, not a preference** (review fix, 2026-10-24):
 *
 *  - `priceTiers` and `images` — nothing references them, so they are deleted
 *    and re-inserted wholesale, and their inputs carry no `id`.
 *  - `itinerary` and `addons` — `trip_checkpoints.stop_id` and
 *    `booking_addons.addon_id` reference them `ON DELETE RESTRICT`, so they are
 *    matched BY ID and never bulk-deleted. See `childIdSchema` below and
 *    `services/tours/upsert.ts` for what dropping one of each now means.
 */
import { z } from 'zod';

/** `tours.badge`, mirroring the MySQL enum in `server/src/db/schema.ts`. */
export const TOUR_BADGES = ['none', 'best_seller', 'new', 'seasonal'] as const;
export const tourBadgeSchema = z.enum(TOUR_BADGES);
export type TourBadge = (typeof TOUR_BADGES)[number];

/**
 * The ceiling every centavo amount here shares: `INT` in MySQL, so ₱21,474,836.47.
 * A value above it is a column overflow — a 500 from the driver rather than a
 * refusal a screen can show — so it is caught at the boundary instead.
 */
export const MAX_CENTAVOS = 2_147_483_647;

/** An amount of money, as this project stores money: integer centavos. */
const centavosSchema = z.number().int().nonnegative().max(MAX_CENTAVOS);

/** Party sizes. `maxGuests` is 12 by default but a tour may raise it. */
const paxSchema = z.number().int().positive().max(100);

/** Child-row ordering, as the public reads order by. */
const sortOrderSchema = z.number().int().min(0).max(9_999);

/**
 * One row of a tour's price card.
 *
 * `minPax <= maxPax` is refined HERE, per row, because it is a fact about one
 * tier. Whether two tiers OVERLAP is a fact about the set and is refused by
 * the server with a `CONFLICT` instead (see `services/tours/upsert.ts`): the
 * two refusals read differently to the screen on purpose, and the overlap one
 * is the money rule — `checkout.quote` picks "the tier where
 * `min_pax <= pax <= max_pax`", so two matches make a price non-deterministic.
 */
export const tourPriceTierInputSchema = z
  .object({
    minPax: paxSchema,
    maxPax: paxSchema,
    pricePerPersonCentavos: centavosSchema,
  })
  .strict()
  .refine((tier) => tier.minPax <= tier.maxPax, {
    message: 'A tier needs its smallest party size at or below its largest.',
    path: ['maxPax'],
  });
export type TourPriceTierInput = z.infer<typeof tourPriceTierInputSchema>;

/** `alt` is required and non-empty: CLAUDE.md asks for alt text on every image. */
export const tourImageInputSchema = z
  .object({
    path: z.string().trim().min(1).max(300),
    alt: z.string().trim().min(1, 'Every image needs alt text.').max(300),
    width: z.number().int().positive().max(20_000).nullable(),
    height: z.number().int().positive().max(20_000).nullable(),
    sortOrder: sortOrderSchema,
  })
  .strict();
export type TourImageInput = z.infer<typeof tourImageInputSchema>;

/**
 * The id of a child row being EDITED rather than added (review fix,
 * 2026-10-24).
 *
 * Only `itinerary` and `addons` carry it, and only because those two tables are
 * REFERENCED by rows that record history — `trip_checkpoints.stop_id` and
 * `booking_addons.addon_id`, both `ON DELETE RESTRICT`. They cannot be replaced
 * wholesale (see `services/tours/upsert.ts`), so a save has to be able to say
 * "this is the same stop, edited" instead of "delete everything and re-add".
 * Omit it for a brand-new row.
 *
 * **`priceTiers` and `images` deliberately do NOT take an id.** Nothing
 * references those two tables, so they really are replaced wholesale, and
 * `.strict()` means posting an id on one is a refusal rather than a value
 * silently ignored. A screen that round-trips `admin.tours.detail` therefore
 * strips `id` from tiers and images, and keeps it on stops and add-ons.
 */
const childIdSchema = z.number().int().positive().optional();

/**
 * One itinerary stop. These are the rows the driver's check-in screen counts a
 * trip's progress against (`services/trips/progress.ts`), so editing them
 * changes what "0 of 4 stops" means on the departures board — not only what a
 * guest reads. And once a driver has checked in at one, `trip_checkpoints`
 * points at it for good: removing it is refused, not cascaded.
 */
export const tourItineraryStopInputSchema = z
  .object({
    id: childIdSchema,
    sortOrder: sortOrderSchema,
    name: z.string().trim().min(1).max(200),
    description: z.string().trim().max(4_000).nullable(),
  })
  .strict();
export type TourItineraryStopInput = z.infer<typeof tourItineraryStopInputSchema>;

/**
 * One add-on. `isActive` IS editable here, unlike the tour's own flag: an
 * add-on is a line on this tour's form rather than a catalog entry of its own,
 * the public detail route already filters on it, and nothing else writes it.
 *
 * It is also how an add-on is RETIRED. Dropping one from the input deactivates
 * the row rather than deleting it, because a guest may already have bought it
 * (`booking_addons.addon_id`); posting it back with `isActive: true` revives it.
 */
export const tourAddonInputSchema = z
  .object({
    id: childIdSchema,
    name: z.string().trim().min(1).max(200),
    priceCentavos: centavosSchema,
    perPerson: z.boolean(),
    isActive: z.boolean(),
  })
  .strict();
export type TourAddonInput = z.infer<typeof tourAddonInputSchema>;

/** A short list of bullet strings, as `tours.inclusions` / `.exclusions` hold. */
const bulletsSchema = z.array(z.string().trim().min(1).max(300)).max(50).nullable();

/** Every editable column on `tours`, minus the two named in this file's header. */
const tourFields = {
  slug: z
    .string()
    .trim()
    .min(3)
    .max(160)
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'Use lowercase letters, numbers and hyphens.'),
  title: z.string().trim().min(3).max(200),
  destinationId: z.number().int().positive(),
  summary: z.string().trim().max(400).nullable(),
  about: z.string().trim().max(20_000).nullable(),
  inclusions: bulletsSchema,
  exclusions: bulletsSchema,
  durationHours: z
    .number()
    .int()
    .positive()
    .max(24 * 30)
    .nullable(),
  groupsPerDay: z.number().int().positive().max(20),
  maxGuests: z.number().int().positive().max(100),
  freeCancelHours: z
    .number()
    .int()
    .min(0)
    .max(24 * 365)
    .nullable(),
  isFeatured: z.boolean(),
  sortOrder: sortOrderSchema,
  badge: tourBadgeSchema,
  alertNote: z.string().trim().max(300).nullable(),
  seoTitle: z.string().trim().max(200).nullable(),
  seoDescription: z.string().trim().max(400).nullable(),
  ogImage: z.string().trim().max(300).nullable(),
  priceTiers: z.array(tourPriceTierInputSchema).max(20),
  images: z.array(tourImageInputSchema).max(40),
  itinerary: z.array(tourItineraryStopInputSchema).max(40),
  addons: z.array(tourAddonInputSchema).max(40),
} as const;

export const tourCreateInput = z.object(tourFields).strict();
export type TourCreateInput = z.infer<typeof tourCreateInput>;

/**
 * The same fields plus the id — a FULL replacement, not a patch.
 *
 * A partial patch would have to answer "what does an absent `priceTiers`
 * mean?" and the wholesale child replacement gives that question no safe
 * answer (see this file's header). The screen posts what it loaded.
 */
export const tourUpdateInput = tourCreateInput.extend({ id: z.number().int().positive() }).strict();
export type TourUpdateInput = z.infer<typeof tourUpdateInput>;

export const tourIdInput = z.object({ id: z.number().int().positive() }).strict();

/**
 * `admin.tours.setActive`. The soft delete, modelled on
 * `driverActiveInputSchema`: deactivating a tour hides it from the public
 * catalog and from `tours.bySlug`, and deletes nothing.
 */
export const tourActiveInput = z
  .object({ id: z.number().int().positive(), isActive: z.boolean() })
  .strict();
export type TourActiveInput = z.infer<typeof tourActiveInput>;

/**
 * A saved child row — its input shape with the id made REQUIRED.
 *
 * Tiers and images have no `id` on their input, so the intersection adds it.
 * Stops and add-ons already carry an optional one, which `Omit` + an explicit
 * `id: number` narrows to required: a row that came back from `detail` always
 * has an id, even though a row being posted need not.
 */
export type TourPriceTierRow = TourPriceTierInput & { id: number };
export type TourImageRow = TourImageInput & { id: number };
export type TourItineraryStopRow = Omit<TourItineraryStopInput, 'id'> & { id: number };
export type TourAddonRow = Omit<TourAddonInput, 'id'> & { id: number };

/**
 * One row of `admin.tours.list`.
 *
 * Deliberately NOT a clone of the public `TourListItem`: that type carries
 * guest-facing derivations (a display rating, "booked this week", a hero
 * image) which an editing list has no use for, and omits `isActive` because an
 * inactive tour never reaches a guest. This is the editable record plus the
 * two numbers an owner scans the list for — the cheapest price a guest can
 * see, and whether the tour has any prices at all.
 */
export interface TourAdminListItem {
  id: number;
  slug: string;
  title: string;
  destination: { id: number; name: string };
  isActive: boolean;
  isFeatured: boolean;
  sortOrder: number;
  badge: TourBadge;
  durationHours: number | null;
  groupsPerDay: number;
  maxGuests: number;
  /** MIN(`price_per_person_centavos`) across this tour's tiers; null when it has none. */
  fromPriceCentavos: number | null;
  /** Zero is the state the list has to make visible: a tour nobody can book. */
  priceTierCount: number;
}

/** `admin.tours.detail` — every editable field, with each child row's id. */
export interface TourAdminDetail {
  id: number;
  slug: string;
  title: string;
  destinationId: number;
  summary: string | null;
  about: string | null;
  inclusions: string[] | null;
  exclusions: string[] | null;
  durationHours: number | null;
  groupsPerDay: number;
  maxGuests: number;
  freeCancelHours: number | null;
  isFeatured: boolean;
  sortOrder: number;
  badge: TourBadge;
  alertNote: string | null;
  seoTitle: string | null;
  seoDescription: string | null;
  ogImage: string | null;
  isActive: boolean;
  priceTiers: TourPriceTierRow[];
  images: TourImageRow[];
  itinerary: TourItineraryStopRow[];
  addons: TourAddonRow[];
}
