/**
 * Seeds the `rg_travel` database with today's content (task 1.4) so that a
 * later task can switch the public site over to the API without changing
 * the rendered page.
 *
 * Idempotent: every table is upserted by a natural key (`slug` for
 * destinations/tours/packages, `key` for settings, `name` + `tourId` for
 * reviews). A tour's price tiers and images have no natural key of their
 * own, so they are replaced wholesale for that tour on every run — same
 * fixed set in, same fixed set out, never duplicated.
 *
 * `assertDatabaseName` + `assertConnectedDatabase` run first (CLAUDE.md:
 * this project may only ever touch `rg_travel`; Kong PMS shares the same
 * MySQL server). Never prints DATABASE_URL or a password. Never truncates,
 * never hard-deletes.
 */
import { eq, and } from 'drizzle-orm';
import { pathToFileURL } from 'node:url';
import { env } from '../env';
import { assertConnectedDatabase, assertDatabaseName, databaseNameFromUrl } from './guard';
import { closeDb, getDb } from './client';
import * as schema from './schema';
import {
  SEED_DESTINATIONS,
  SEED_PACKAGES,
  SEED_REVIEWS,
  SEED_SETTINGS,
  SEED_TOURS,
  type SeedDestination,
  type SeedPackage,
  type SeedReview,
  type SeedTour,
} from './seed-data';

type Db = ReturnType<typeof getDb>;

async function upsertDestination(db: Db, destination: SeedDestination): Promise<number> {
  const values = {
    name: destination.name,
    displayName: destination.displayName,
    blurb: destination.blurb,
    imagePath: destination.imagePath,
    imageAlt: destination.imageAlt,
    sortOrder: destination.sortOrder,
    featuredSortOrder: destination.featuredSortOrder,
    isFeatured: destination.isFeatured,
  };

  const existing = await db
    .select({ id: schema.destinations.id })
    .from(schema.destinations)
    .where(eq(schema.destinations.slug, destination.slug));

  if (existing.length > 0) {
    const id = existing[0]!.id;
    await db.update(schema.destinations).set(values).where(eq(schema.destinations.id, id));
    return id;
  }

  const [result] = await db
    .insert(schema.destinations)
    .values({ slug: destination.slug, ...values });
  return result.insertId;
}

async function upsertTour(db: Db, tour: SeedTour, destinationId: number): Promise<number> {
  const values = {
    title: tour.title,
    destinationId,
    durationHours: tour.durationHours,
    isFeatured: tour.isFeatured,
    sortOrder: tour.sortOrder,
    badge: 'none' as const,
    alertNote: null,
    // D8: booking counters stay hidden until real bookings exist, never faked.
    historicalTripsCount: null,
  };

  const existing = await db
    .select({ id: schema.tours.id })
    .from(schema.tours)
    .where(eq(schema.tours.slug, tour.slug));

  let tourId: number;
  if (existing.length > 0) {
    tourId = existing[0]!.id;
    await db.update(schema.tours).set(values).where(eq(schema.tours.id, tourId));
  } else {
    const [result] = await db.insert(schema.tours).values({ slug: tour.slug, ...values });
    tourId = result.insertId;
  }

  // No natural key of their own — replace wholesale for this tour so re-runs
  // never duplicate rows.
  await db.delete(schema.tourPriceTiers).where(eq(schema.tourPriceTiers.tourId, tourId));
  if (tour.priceTiers.length > 0) {
    await db.insert(schema.tourPriceTiers).values(
      tour.priceTiers.map((tier) => ({
        tourId,
        minPax: tier.minPax,
        maxPax: tier.maxPax,
        pricePerPerson: tier.pricePerPerson,
      })),
    );
  }

  await db.delete(schema.tourImages).where(eq(schema.tourImages.tourId, tourId));
  if (tour.images.length > 0) {
    await db.insert(schema.tourImages).values(
      tour.images.map((image) => ({
        tourId,
        path: image.path,
        alt: image.alt,
        width: image.width,
        height: image.height,
        sortOrder: image.sortOrder,
      })),
    );
  }

  return tourId;
}

async function upsertPackage(db: Db, pkg: SeedPackage): Promise<void> {
  const values = {
    title: pkg.title,
    days: pkg.days,
    oldPrice: pkg.oldPrice,
    newPrice: pkg.newPrice,
    description: pkg.description,
    imagePath: pkg.imagePath,
    imageAlt: pkg.imageAlt,
    highlights: pkg.highlights,
    sortOrder: pkg.sortOrder,
  };

  const existing = await db
    .select({ id: schema.packages.id })
    .from(schema.packages)
    .where(eq(schema.packages.slug, pkg.slug));

  if (existing.length > 0) {
    await db.update(schema.packages).set(values).where(eq(schema.packages.id, existing[0]!.id));
    return;
  }

  await db.insert(schema.packages).values({ slug: pkg.slug, ...values });
}

async function upsertReview(db: Db, review: SeedReview, tourId: number): Promise<void> {
  const values = {
    tourId,
    name: review.name,
    rating: review.rating,
    body: review.body,
    status: review.status,
    isSample: review.isSample,
  };

  // Natural key: name + tourId. No DB-level unique constraint backs this
  // (reviews have no natural uniqueness beyond that pair), so the upsert is
  // a manual select-then-write rather than ON DUPLICATE KEY UPDATE.
  const existing = await db
    .select({ id: schema.reviews.id })
    .from(schema.reviews)
    .where(and(eq(schema.reviews.tourId, tourId), eq(schema.reviews.name, review.name)));

  if (existing.length > 0) {
    await db.update(schema.reviews).set(values).where(eq(schema.reviews.id, existing[0]!.id));
    return;
  }

  await db.insert(schema.reviews).values(values);
}

async function upsertSetting(db: Db, key: string, value: unknown): Promise<void> {
  const existing = await db
    .select({ key: schema.settings.key })
    .from(schema.settings)
    .where(eq(schema.settings.key, key));

  if (existing.length > 0) {
    await db.update(schema.settings).set({ value }).where(eq(schema.settings.key, key));
    return;
  }

  await db.insert(schema.settings).values({ key, value });
}

export async function seed(): Promise<void> {
  assertDatabaseName(databaseNameFromUrl(env.DATABASE_URL));
  await assertConnectedDatabase();

  const db = getDb();

  const destinationIdBySlug = new Map<string, number>();
  for (const destination of SEED_DESTINATIONS) {
    destinationIdBySlug.set(destination.slug, await upsertDestination(db, destination));
  }
  console.log(`[seed] destinations: ${SEED_DESTINATIONS.length}`);

  const tourIdBySlug = new Map<string, number>();
  for (const tour of SEED_TOURS) {
    const destinationId = destinationIdBySlug.get(tour.destinationSlug);
    if (destinationId === undefined) {
      throw new Error(
        `seed: tour "${tour.slug}" references unknown destination "${tour.destinationSlug}"`,
      );
    }
    tourIdBySlug.set(tour.slug, await upsertTour(db, tour, destinationId));
  }
  console.log(`[seed] tours: ${SEED_TOURS.length} (3 price tiers + 1 image each)`);

  for (const pkg of SEED_PACKAGES) {
    await upsertPackage(db, pkg);
  }
  console.log(`[seed] packages: ${SEED_PACKAGES.length}`);

  for (const review of SEED_REVIEWS) {
    const tourId = tourIdBySlug.get(review.tourSlug);
    if (tourId === undefined) {
      throw new Error(`seed: review "${review.name}" references unknown tour "${review.tourSlug}"`);
    }
    await upsertReview(db, review, tourId);
  }
  console.log(`[seed] reviews: ${SEED_REVIEWS.length}`);

  const settingKeys = Object.keys(SEED_SETTINGS) as Array<keyof typeof SEED_SETTINGS>;
  for (const key of settingKeys) {
    await upsertSetting(db, key, SEED_SETTINGS[key]);
  }
  console.log(`[seed] settings: ${settingKeys.length} keys`);

  console.log('[seed] done.');
}

const isMainModule =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMainModule) {
  seed()
    .then(async () => {
      await closeDb();
    })
    .catch(async (error: unknown) => {
      console.error('[seed] failed:', error instanceof Error ? error.message : error);
      await closeDb();
      process.exit(1);
    });
}
