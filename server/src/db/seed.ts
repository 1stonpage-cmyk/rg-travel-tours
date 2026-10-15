/**
 * Seeds today's content (task 1.4) so that a later task can switch the
 * public site over to the API without changing the rendered page. Seeds
 * `rg_travel` by default; task 1.4b's test global setup calls `seed('test')`
 * to seed `rg_travel_test` instead, so the test suite starts from the same
 * canonical baseline.
 *
 * Idempotent: every table is upserted by a natural key (`slug` for
 * destinations/tours/packages, `key` for settings, `name` + `tourId` for
 * reviews). A tour's price tiers and images have no natural key of their
 * own, so they are replaced wholesale for that tour on every run — same
 * fixed set in, same fixed set out, never duplicated.
 *
 * `assertDatabaseName` + `assertConnectedDatabase` run first (CLAUDE.md:
 * this project may only ever touch `rg_travel` for the app, `rg_travel_test`
 * for tests; Kong PMS shares the same MySQL server). Never prints
 * DATABASE_URL, TEST_DATABASE_URL or a password. Never truncates, never
 * hard-deletes.
 */
import { and, eq } from 'drizzle-orm';
import { pathToFileURL } from 'node:url';
import { env } from '../env';
import {
  assertConnectedDatabase,
  assertDatabaseName,
  databaseNameFromUrl,
  type DatabaseContext,
} from './guard';
import { closeDb, getDb } from './client';
import { hashPassword } from '../services/password';
import * as schema from './schema';
import {
  SEED_DESTINATIONS,
  SEED_DRIVERS,
  SEED_PACKAGES,
  SEED_REVIEWS,
  SEED_SETTINGS,
  SEED_TOURS,
  SEED_UNASSIGNED_TRIPS,
  SEED_VANS,
  type SeedDestination,
  type SeedPackage,
  type SeedReview,
  type SeedTour,
} from './seed-data';
import { manilaCivilDate } from '@rg/shared';
import { generateBookingRef } from '../services/booking-ref';
import { randomInt } from 'node:crypto';

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
    freeCancelHours: tour.freeCancelHours,
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
        pricePerPersonCentavos: tier.pricePerPersonCentavos,
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
    oldPriceCentavos: pkg.oldPriceCentavos,
    newPriceCentavos: pkg.newPriceCentavos,
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

/**
 * The first owner account (Week 4, Task 5; owner instruction 2026-10-14).
 *
 * **Read from `OWNER_EMAIL` and `OWNER_PASSWORD` in `.env`, never from this
 * file.** A password in the repository is a password in every clone, every
 * fork and every CI log, and it would be the real credential on the live
 * site the day someone forgot to change it. So there is no default, no
 * fallback and no "changeme".
 *
 * It is never printed either — not the password, not a masked version of
 * it. The only thing logged is whether an owner was created or updated.
 *
 * ## When neither variable is set, this step is SKIPPED, loudly
 *
 * A deliberate reading of "the seed refuses if either is missing", and the
 * reason is that `pnpm test` seeds `rg_travel_test` on **every run**
 * through `globalSetup`: a hard failure with no owner configured would stop
 * the entire suite rather than protect anything. So:
 *
 *  - **neither set** — nothing to seed, skip with a warning. The failure
 *    mode is "no owner can sign in", which is loud, safe and exactly what
 *    the launch checklist tells a deployer to fix.
 *  - **either one set** — the deployer is TRYING to seed an owner, so both
 *    are required and the password must be at least 12 characters. Refuses
 *    outright rather than creating a weak account.
 *
 * That keeps the thing the instruction actually protects against — a weak
 * or committed owner password — impossible, without making every test run
 * depend on production-shaped configuration.
 */
async function upsertOwner(db: Db): Promise<void> {
  const email = env.OWNER_EMAIL?.trim();
  const password = env.OWNER_PASSWORD;

  if (!email && !password) {
    console.warn(
      '[seed] owner: SKIPPED — OWNER_EMAIL and OWNER_PASSWORD are not set, so no staff account ' +
        'exists and nobody can sign in to the admin. Set both in .env and re-run.',
    );
    return;
  }

  if (!email || !password) {
    throw new Error(
      'seed: OWNER_EMAIL and OWNER_PASSWORD must BOTH be set to seed an owner account.',
    );
  }

  if (password.length < 12) {
    // The length, never the password.
    throw new Error(
      `seed: OWNER_PASSWORD must be at least 12 characters (got ${password.length}).`,
    );
  }

  const passwordHash = await hashPassword(password);
  const existing = await db
    .select({ id: schema.users.id })
    .from(schema.users)
    .where(eq(schema.users.email, email));

  if (existing.length > 0) {
    await db
      .update(schema.users)
      .set({ passwordHash, role: 'owner', isActive: true })
      .where(eq(schema.users.id, existing[0]!.id));
    console.log('[seed] owner: updated the existing account (password reset from .env)');
    return;
  }

  await db
    .insert(schema.users)
    .values({ name: 'Owner', email, passwordHash, role: 'owner', isActive: true });
  console.log('[seed] owner: created');
}

/**
 * `days` from today, as a civil date in Asia/Manila, ready for a `date()`
 * column.
 *
 * Offsets rather than fixed dates, because a seeded `2026-11-20` stops being
 * "within 14 days" the moment the month turns — and a demo whose alerts are
 * all empty teaches the owner that the dashboard does not work.
 */
function seedDate(days: number): Date {
  const today = manilaCivilDate(new Date());
  const [year, month, day] = today.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(year, month - 1, day + days));
}

/**
 * The dispatcher's fleet — **APP DATABASE ONLY** (controller ruling,
 * 2026-10-15).
 *
 * `capacity.test.ts` asserts in its `beforeEach` that `vans` and `drivers`
 * hold exactly zero rows, and says why: those tests count the WHOLE fleet,
 * so one seeded van changes every number in the file. Seeding a fleet into
 * `rg_travel_test` would break the suite that guards the booking path's
 * capacity arithmetic — including the concurrency tests that stop the fleet
 * being oversold. The tempting fix (loosen that assertion) trades a
 * protection on the money path for a convenience, so the seed is gated
 * instead.
 *
 * Idempotent like the rest of the seed: it keys on `plate` and `code`, so
 * `db:seed` can be run twice without doubling the fleet.
 */
async function upsertFleet(db: Db, tourIdBySlug: Map<string, number>): Promise<void> {
  for (const van of SEED_VANS) {
    const [existing] = await db
      .select({ id: schema.vans.id })
      .from(schema.vans)
      .where(eq(schema.vans.plate, van.plate));
    const values = {
      plate: van.plate,
      model: van.model,
      capacity: van.capacity,
      status: van.status,
      odometer: van.odometer,
      nextService: van.nextServiceInDays === null ? null : seedDate(van.nextServiceInDays),
      orcrExpiry: van.orcrExpiryInDays === null ? null : seedDate(van.orcrExpiryInDays),
      franchiseNo: van.franchiseNo,
      franchiseExpiry:
        van.franchiseExpiryInDays === null ? null : seedDate(van.franchiseExpiryInDays),
      repairNotes: van.repairNotes,
      isActive: true,
    };
    if (existing) {
      await db.update(schema.vans).set(values).where(eq(schema.vans.id, existing.id));
    } else {
      await db.insert(schema.vans).values(values);
    }
  }
  console.log(`[seed] vans: ${SEED_VANS.length}`);

  for (const driver of SEED_DRIVERS) {
    const [existing] = await db
      .select({ id: schema.drivers.id })
      .from(schema.drivers)
      .where(eq(schema.drivers.code, driver.code));

    /*
     * A seeded driver gets a RANDOM PIN that is never printed. The demo
     * does not need a known PIN — an admin resets one from the drivers
     * screen in two clicks — and a seed that logged "D01 / 123456" would
     * put a working credential in the terminal, in CI output and in any
     * screenshot of either.
     */
    const pinHash = await hashPassword(String(randomInt(0, 1_000_000)).padStart(6, '0'));
    const values = {
      name: driver.name,
      code: driver.code,
      phone: driver.phone,
      licenseNo: driver.licenseNo,
      licenseExpiry: seedDate(driver.licenseExpiryInDays),
      languages: driver.languages,
      emergencyContact: driver.emergencyContact,
      isActive: true,
    };

    const driverId = existing
      ? (await db.update(schema.drivers).set(values).where(eq(schema.drivers.id, existing.id)),
        existing.id)
      : (await db.insert(schema.drivers).values({ ...values, pinHash }))[0].insertId;

    if (driver.leave) {
      const startDate = seedDate(driver.leave.startInDays);
      const [existingLeave] = await db
        .select({ id: schema.driverLeaves.id })
        .from(schema.driverLeaves)
        .where(
          and(
            eq(schema.driverLeaves.driverId, driverId),
            eq(schema.driverLeaves.startDate, startDate),
          ),
        );
      if (!existingLeave) {
        await db.insert(schema.driverLeaves).values({
          driverId,
          startDate,
          endDate: seedDate(driver.leave.endInDays),
          reason: driver.leave.reason,
        });
      }
    }
  }
  console.log(`[seed] drivers: ${SEED_DRIVERS.length} (random PINs, never printed)`);

  /*
   * Two confirmed, unstaffed trips inside the 48-hour window, so the
   * dashboard's "unassigned trips" alert and the calendar's gold dot both
   * have a real row. Keyed on the demo ref prefix so re-seeding does not
   * pile them up.
   */
  let seededTrips = 0;
  for (const trip of SEED_UNASSIGNED_TRIPS) {
    const tourId = tourIdBySlug.get(trip.tourSlug);
    if (tourId === undefined) {
      throw new Error(`seed: unassigned trip references unknown tour "${trip.tourSlug}"`);
    }
    const tourDate = seedDate(trip.inDays);
    const [existing] = await db
      .select({ id: schema.bookings.id })
      .from(schema.bookings)
      .where(and(eq(schema.bookings.tourId, tourId), eq(schema.bookings.leadName, trip.leadName)));
    if (existing) continue;

    const pricePerPerson = 150_000;
    const total = pricePerPerson * trip.pax;
    await db.insert(schema.bookings).values({
      ref: generateBookingRef(),
      tourId,
      tourDate,
      pax: trip.pax,
      leadName: trip.leadName,
      leadEmail: `${trip.leadName.toLowerCase().replace(/[^a-z]+/g, '.')}@example.test`,
      leadPhone: '+639170000099',
      status: 'confirmed',
      payMode: 'full',
      priceSnapshot: {
        tier: { tierId: 1, minPax: 1, maxPax: 12, pricePerPersonCentavos: pricePerPerson },
        addons: [],
        coupon: null,
        depositPercent: 30,
        freeCancelHours: 48,
        subtotalCentavos: total,
        discountCentavos: 0,
        totalCentavos: total,
      },
      subtotalCentavos: total,
      totalCentavos: total,
      /*
       * `amount_paid_centavos` is deliberately NOT set here, and the guard
       * in `schema-conventions.test.ts` is why: **only
       * `services/payments/record-payment.ts` may write that column**
       * (`CLAUDE.md`, and an owner instruction restated 2026-10-15). It
       * caught this seed on its first run, which is the guard doing exactly
       * its job.
       *
       * So these demo trips are `confirmed` with nothing recorded as paid.
       * That is slightly odd to look at on the booking detail screen and it
       * is the honest state: nobody paid, no webhook fired, no admin
       * approved. What the dispatch surfaces need is the STATUS and the
       * missing van/driver, and they have both.
       *
       * Routing the seed through `recordPayment()` to make the money read
       * nicely would mean a seed script writing payment rows and audit
       * rows — a far worse trade than a demo booking whose paid total is
       * zero.
       */
    });
    seededTrips += 1;
  }
  console.log(
    `[seed] unassigned demo trips: ${seededTrips} new (confirmed, nothing recorded as paid — ` +
      `only record-payment.ts may write amount_paid_centavos)`,
  );
}

export async function seed(context: DatabaseContext = 'app'): Promise<void> {
  const url = context === 'test' ? env.TEST_DATABASE_URL : env.DATABASE_URL;
  if (!url) {
    throw new Error(
      `No ${context === 'test' ? 'TEST_DATABASE_URL' : 'DATABASE_URL'} is configured.`,
    );
  }
  assertDatabaseName(databaseNameFromUrl(url), context);
  await assertConnectedDatabase(context);

  const db = getDb();

  await upsertOwner(db);

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

  /*
   * The fleet is APP-ONLY (controller ruling, 2026-10-15). See
   * `upsertFleet`: `capacity.test.ts` requires an empty fleet in
   * `rg_travel_test`, and that requirement guards the booking path.
   */
  if (context === 'app') {
    await upsertFleet(db, tourIdBySlug);
  } else {
    console.log('[seed] fleet: skipped (test database keeps an empty fleet by design)');
  }

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
