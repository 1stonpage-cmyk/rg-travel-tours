/**
 * `tours.list` and `tours.bySlug` — the catalog and detail reads.
 *
 * `tours.list` is a fixed, small number of round trips no matter how many
 * tours exist: one grouped query for tours+destination+lowest price tier,
 * one batched query for each tour's first image, one batched query
 * (`aggregatesByTour`, services/ratings.ts) for every tour's rating, and one
 * query for the `trust` settings row (Task 1.9, R1's display threshold).
 * None of those run once per tour — see the "no N+1" test in
 * __tests__/public-queries.test.ts, which counts the actual pool.query()
 * calls rather than trusting this comment.
 */
import { toursBySlugInput, toursListInput } from '@rg/shared';
import { TRPCError } from '@trpc/server';
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import { readTrustSettings } from '../../content/settings';
import { getDb } from '../../db/client';
import {
  destinations,
  tourAddons,
  tourImages,
  tourItineraryStops,
  tourPriceTiers,
  tours,
} from '../../db/schema';
import { aggregatesByTour, displayAggregate, type Aggregate } from '../../services/ratings';
import { publicProcedure, router } from '../../trpc';

export interface TourImage {
  path: string;
  alt: string;
  width: number | null;
  height: number | null;
}

export interface TourListItem {
  id: number;
  slug: string;
  title: string;
  destination: { id: number; name: string; slug: string };
  image: TourImage | null;
  /** Integer centavos — MIN(price_per_person) across tiers. Null when a tour somehow has none. */
  fromPriceCentavos: number | null;
  durationHours: number | null;
  /** The display aggregate — ALL published reviews, samples included (D1). */
  rating: Aggregate | null;
  /** Literal 0 until the bookings table exists. Week 3. */
  bookedThisWeek: number;
  /** `historical_trips_count` — NULL in the seed until real bookings exist. */
  tripsRun: number | null;
  freeCancellation: boolean;
  badge: 'none' | 'best_seller' | 'new' | 'seasonal';
  alertNote: string | null;
  isFeatured: boolean;
}

export interface TourDetail extends TourListItem {
  about: string | null;
  inclusions: unknown;
  exclusions: unknown;
  images: TourImage[];
  priceTiers: Array<{ minPax: number; maxPax: number; pricePerPerson: number }>;
  itinerary: Array<{ name: string; description: string | null; sortOrder: number }>;
  addons: Array<{ name: string; price: number; perPerson: boolean }>;
  maxGuests: number;
  freeCancelHours: number | null;
  seoTitle: string | null;
  seoDescription: string | null;
  ogImage: string | null;
}

interface ListRow {
  id: number;
  slug: string;
  title: string;
  destinationId: number;
  destinationName: string;
  destinationSlug: string;
  durationHours: number | null;
  freeCancelHours: number | null;
  isFeatured: boolean;
  sortOrder: number;
  badge: 'none' | 'best_seller' | 'new' | 'seasonal';
  alertNote: string | null;
  historicalTripsCount: number | null;
  fromPriceCentavos: number | null;
}

function freeCancellationFrom(freeCancelHours: number | null): boolean {
  return freeCancelHours != null && freeCancelHours > 0;
}

/**
 * Task 1.9 (R1): withhold the display rating below `minReviewsForRating`
 * published reviews (sample or real — `rating`'s count already is that
 * population). `rating: null` is the only signal the card needs to fall
 * back to a "New" badge; this must never touch `realAggregate`, which feeds
 * JSON-LD and stays exactly as strict as it already was.
 */
function applyRatingThreshold(
  rating: Aggregate | null,
  minReviewsForRating: number,
): Aggregate | null {
  if (rating === null || rating.count < minReviewsForRating) return null;
  return rating;
}

function toListItem(row: ListRow, image: TourImage | null, rating: Aggregate | null): TourListItem {
  return {
    id: row.id,
    slug: row.slug,
    title: row.title,
    destination: { id: row.destinationId, name: row.destinationName, slug: row.destinationSlug },
    image,
    fromPriceCentavos: row.fromPriceCentavos,
    durationHours: row.durationHours,
    rating,
    bookedThisWeek: 0, // Week 3: real counts once the bookings table exists (D8)
    tripsRun: row.historicalTripsCount,
    freeCancellation: freeCancellationFrom(row.freeCancelHours),
    badge: row.badge,
    alertNote: row.alertNote,
    isFeatured: row.isFeatured,
  };
}

/** One query: tours joined to destinations, with the lowest price tier aggregated per tour. Every selected non-aggregate column is in GROUP BY (ONLY_FULL_GROUP_BY). */
async function listRows(destinationSlug: string | undefined): Promise<ListRow[]> {
  const db = getDb();
  // I1: soft-deleting a destination must hide its tours too — otherwise the
  // chip row drops it while the catalog keeps listing (and the ?destination=
  // filter keeps matching) tours under a destination the site no longer
  // publicly offers.
  const conditions = [eq(tours.isActive, true), eq(destinations.isActive, true)];
  if (destinationSlug) conditions.push(eq(destinations.slug, destinationSlug));

  const rows = await db
    .select({
      id: tours.id,
      slug: tours.slug,
      title: tours.title,
      destinationId: destinations.id,
      destinationName: destinations.name,
      destinationSlug: destinations.slug,
      durationHours: tours.durationHours,
      freeCancelHours: tours.freeCancelHours,
      isFeatured: tours.isFeatured,
      sortOrder: tours.sortOrder,
      badge: tours.badge,
      alertNote: tours.alertNote,
      historicalTripsCount: tours.historicalTripsCount,
      fromPriceCentavos: sql<string | null>`min(${tourPriceTiers.pricePerPerson})`,
    })
    .from(tours)
    .innerJoin(destinations, eq(tours.destinationId, destinations.id))
    .leftJoin(tourPriceTiers, eq(tourPriceTiers.tourId, tours.id))
    .where(and(...conditions))
    .groupBy(
      tours.id,
      tours.slug,
      tours.title,
      tours.durationHours,
      tours.freeCancelHours,
      tours.isFeatured,
      tours.sortOrder,
      tours.badge,
      tours.alertNote,
      tours.historicalTripsCount,
      destinations.id,
      destinations.name,
      destinations.slug,
    )
    .orderBy(desc(tours.isFeatured), asc(tours.sortOrder), asc(tours.id));

  return rows.map((row) => ({
    ...row,
    fromPriceCentavos: row.fromPriceCentavos === null ? null : Number(row.fromPriceCentavos),
  }));
}

/** Batched first-image-per-tour lookup — one query for every id, never one per tour. */
async function firstImageByTour(tourIds: number[]): Promise<Map<number, TourImage>> {
  const map = new Map<number, TourImage>();
  if (tourIds.length === 0) return map;

  const db = getDb();
  const rows = await db
    .select({
      tourId: tourImages.tourId,
      path: tourImages.path,
      alt: tourImages.alt,
      width: tourImages.width,
      height: tourImages.height,
    })
    .from(tourImages)
    .where(inArray(tourImages.tourId, tourIds))
    // I3: `id` breaks a tie on `sort_order` deterministically — without it,
    // two images sharing a sort_order leave "the first image" to MySQL's
    // unspecified tie resolution, and the catalog card's hero image could
    // change between requests.
    .orderBy(asc(tourImages.tourId), asc(tourImages.sortOrder), asc(tourImages.id));

  for (const row of rows) {
    if (map.has(row.tourId)) continue; // rows arrive sort_order-ascending per tour; the first one wins
    map.set(row.tourId, { path: row.path, alt: row.alt, width: row.width, height: row.height });
  }
  return map;
}

export const toursRouter = router({
  list: publicProcedure.input(toursListInput).query(async ({ input }): Promise<TourListItem[]> => {
    const rows = await listRows(input.destination);
    const ids = rows.map((row) => row.id);

    const [images, ratings, trust] = await Promise.all([
      firstImageByTour(ids),
      aggregatesByTour(),
      readTrustSettings(),
    ]);

    return rows.map((row) => {
      const rating = applyRatingThreshold(ratings.get(row.id) ?? null, trust.minReviewsForRating);
      return toListItem(row, images.get(row.id) ?? null, rating);
    });
  }),

  bySlug: publicProcedure.input(toursBySlugInput).query(async ({ input }): Promise<TourDetail> => {
    const db = getDb();
    const [row] = await db
      .select({
        id: tours.id,
        slug: tours.slug,
        title: tours.title,
        about: tours.about,
        inclusions: tours.inclusions,
        exclusions: tours.exclusions,
        durationHours: tours.durationHours,
        maxGuests: tours.maxGuests,
        freeCancelHours: tours.freeCancelHours,
        isFeatured: tours.isFeatured,
        sortOrder: tours.sortOrder,
        badge: tours.badge,
        alertNote: tours.alertNote,
        historicalTripsCount: tours.historicalTripsCount,
        seoTitle: tours.seoTitle,
        seoDescription: tours.seoDescription,
        ogImage: tours.ogImage,
        isActive: tours.isActive,
        destinationId: destinations.id,
        destinationName: destinations.name,
        destinationSlug: destinations.slug,
        destinationIsActive: destinations.isActive,
      })
      .from(tours)
      .innerJoin(destinations, eq(tours.destinationId, destinations.id))
      .where(eq(tours.slug, input.slug));

    // I1: an inactive destination makes bySlug throw NOT_FOUND exactly as an
    // inactive tour does — soft delete has to mean "not publicly visible".
    if (!row || !row.isActive || !row.destinationIsActive) {
      throw new TRPCError({
        code: 'NOT_FOUND',
        message: `NOT_FOUND: no tour found for slug "${input.slug}"`,
      });
    }

    const [priceTiers, images, itinerary, addons, rating, trust] = await Promise.all([
      db
        .select({
          minPax: tourPriceTiers.minPax,
          maxPax: tourPriceTiers.maxPax,
          pricePerPerson: tourPriceTiers.pricePerPerson,
        })
        .from(tourPriceTiers)
        .where(eq(tourPriceTiers.tourId, row.id))
        .orderBy(asc(tourPriceTiers.minPax)),
      db
        .select({
          path: tourImages.path,
          alt: tourImages.alt,
          width: tourImages.width,
          height: tourImages.height,
        })
        .from(tourImages)
        .where(eq(tourImages.tourId, row.id))
        // I3: same tie-break as the batched list query — deterministic order.
        .orderBy(asc(tourImages.sortOrder), asc(tourImages.id)),
      db
        .select({
          name: tourItineraryStops.name,
          description: tourItineraryStops.description,
          sortOrder: tourItineraryStops.sortOrder,
        })
        .from(tourItineraryStops)
        .where(eq(tourItineraryStops.tourId, row.id))
        .orderBy(asc(tourItineraryStops.sortOrder)),
      db
        .select({ name: tourAddons.name, price: tourAddons.price, perPerson: tourAddons.perPerson })
        .from(tourAddons)
        .where(and(eq(tourAddons.tourId, row.id), eq(tourAddons.isActive, true))),
      displayAggregate(row.id),
      readTrustSettings(),
    ]);

    const fromPriceCentavos =
      priceTiers.length > 0 ? Math.min(...priceTiers.map((tier) => tier.pricePerPerson)) : null;

    const listItem = toListItem(
      {
        id: row.id,
        slug: row.slug,
        title: row.title,
        destinationId: row.destinationId,
        destinationName: row.destinationName,
        destinationSlug: row.destinationSlug,
        durationHours: row.durationHours,
        freeCancelHours: row.freeCancelHours,
        isFeatured: row.isFeatured,
        sortOrder: row.sortOrder,
        badge: row.badge,
        alertNote: row.alertNote,
        historicalTripsCount: row.historicalTripsCount,
        fromPriceCentavos,
      },
      images[0] ?? null,
      applyRatingThreshold(rating, trust.minReviewsForRating),
    );

    return {
      ...listItem,
      about: row.about,
      inclusions: row.inclusions,
      exclusions: row.exclusions,
      images,
      priceTiers,
      itinerary,
      addons,
      maxGuests: row.maxGuests,
      freeCancelHours: row.freeCancelHours,
      seoTitle: row.seoTitle,
      seoDescription: row.seoDescription,
      ogImage: row.ogImage,
    };
  }),
});
