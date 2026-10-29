/**
 * Seeds today's content (task 1.4) so that a later task can switch the
 * public site over to the API without changing the rendered page. Seeds
 * `rg_travel` by default; task 1.4b's test global setup calls `seed('test')`
 * to seed `rg_travel_test` instead, so the test suite starts from the same
 * canonical baseline.
 *
 * Idempotent: every table is upserted by a natural key (`slug` for
 * destinations/tours/packages, `name` + `tourId` for reviews). A tour's price
 * tiers and images have no natural key of their own, so they are replaced
 * wholesale for that tour on every run — same fixed set in, same fixed set
 * out, never duplicated. Itinerary stops follow the same rule but are
 * app-database only (`upsertItineraryStops`).
 *
 * **`settings` is the exception: insert-only, never overwritten.** It is the
 * one table whose rows an admin edits in place rather than through a screen
 * that owns its own content, so a re-seed must leave an existing key alone.
 * See `insertSettingIfMissing` for the incident that made this a rule.
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
import { bookingRefSchema, manilaCivilDate } from '@rg/shared';
import { REF_ALPHABET } from '../services/booking-ref';
import { randomInt } from 'node:crypto';

type Db = ReturnType<typeof getDb>;

/**
 * What every demo booking's ref starts with (7N item 10).
 *
 * `RG-SEED` plus each trip's own two characters is a valid
 * `bookingRefSchema` ref — six characters from `REF_ALPHABET` after the
 * `RG-` — so a demo row is a real booking that merely says so in its ref,
 * never a special-cased string the rest of the system has to tolerate.
 */
const DEMO_REF_PREFIX = 'RG-SEED';

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

/**
 * A settings row is INSERT-ONLY — the seed never touches one that already
 * exists (LAUNCH BLOCKER, found 2026-10-28).
 *
 * This was an upsert, and on 2026-10-28 a `db:seed` against the live
 * `rg_travel` database reset the `payment_qr` block back to its seed default
 * (`isConfigured: false`, every field `null`), wiping a real configuration
 * somebody had entered through the admin Settings screens. Every other table
 * the seed writes holds seed CONTENT that an admin edits through a screen
 * that owns it; `settings` is the one table where the seed's "today's
 * content" and the owner's live configuration share the same rows. So the
 * seed gets one chance at each key — the first run, when the row is missing —
 * and after that the row belongs to the admin.
 *
 * Not even a read-and-compare: there is nothing the seed could usefully
 * decide by looking at a stored value, and a comparison is how an overwrite
 * grows back.
 *
 * **The test database is unaffected and needs no escape hatch.**
 * `resetTestDb()` deletes every `settings` row before calling `seed('test')`,
 * so there is never an existing row for this to skip and the canonical
 * baseline is restored in full on every reset.
 *
 * Returns `true` when it inserted, so the caller can say how many keys it
 * left alone.
 */
async function insertSettingIfMissing(db: Db, key: string, value: unknown): Promise<boolean> {
  const existing = await db
    .select({ key: schema.settings.key })
    .from(schema.settings)
    .where(eq(schema.settings.key, key));

  // Never touch a row that already exists — it may be real, admin-entered
  // configuration, and the seed cannot tell the difference.
  if (existing.length > 0) return false;

  await db.insert(schema.settings).values({ key, value });
  return true;
}

/**
 * The first owner account (Week 4, Task 5; owner instruction 2026-10-14; changed to
 * create-only by owner decision 2026-10-23).
 *
 * **Read from `OWNER_EMAIL` and `OWNER_PASSWORD` in `.env`, never from this
 * file.** A password in the repository is a password in every clone, every
 * fork and every CI log, and it would be the real credential on the live
 * site the day someone forgot to change it. So there is no default, no
 * fallback and no "changeme".
 *
 * It is never printed either — not the password, not a masked version of
 * it. The only thing logged is whether an owner was created or left alone.
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
async function seedFirstOwner(db: Db): Promise<void> {
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

  /*
   * Only the FIRST owner (owner decision 2026-10-23). Once any active owner
   * exists, accounts are managed from the admin and this step touches nothing:
   * re-seeding must never reset a password or change a role that a person set.
   * An email that already belongs to some other account is left alone too.
   */
  const [activeOwner] = await db
    .select({ id: schema.users.id })
    .from(schema.users)
    .where(and(eq(schema.users.role, 'owner'), eq(schema.users.isActive, true)))
    .limit(1);
  if (activeOwner) {
    console.log('[seed] owner: an active owner already exists, nothing changed');
    return;
  }

  const [sameEmail] = await db
    .select({ id: schema.users.id })
    .from(schema.users)
    .where(eq(schema.users.email, email.toLowerCase()))
    .limit(1);
  if (sameEmail) {
    console.warn(
      '[seed] owner: SKIPPED — OWNER_EMAIL already belongs to an existing account and no active ' +
        'owner exists. Reactivate it in the database or use another email; the seed never ' +
        'overwrites an account.',
    );
    return;
  }

  const passwordHash = await hashPassword(password);
  await db.insert(schema.users).values({
    name: 'Owner',
    email: email.toLowerCase(),
    passwordHash,
    role: 'owner',
    isActive: true,
    mustChangePassword: false,
  });
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
   * have a real row.
   *
   * **Keyed on the demo REF** (7N item 10). The comment that used to sit here
   * claimed exactly that and the code underneath it matched on
   * `(tour_id, lead_name)` — a false comment, and a key that is wrong in both
   * directions: a real guest booking the same tour under the same name
   * SUPPRESSED the demo row (the seed decided it already existed), and
   * renaming a demo lead DUPLICATED it (the old row stayed, a new one
   * appeared). `bookings.ref` is UNIQUE and is a booking's real identity, so
   * that is what is matched now. The ref is also what makes the row
   * recognisable as demo data in the admin list.
   */
  let seededTrips = 0;
  for (const trip of SEED_UNASSIGNED_TRIPS) {
    const tourId = tourIdBySlug.get(trip.tourSlug);
    if (tourId === undefined) {
      throw new Error(`seed: unassigned trip references unknown tour "${trip.tourSlug}"`);
    }
    const ref = `${DEMO_REF_PREFIX}${trip.refSuffix}`;
    /*
     * Asserted, not assumed: `RG-SEED` plus a two-character suffix is a REAL
     * booking ref only while both characters are in `REF_ALPHABET`. A typo
     * here would otherwise write a row the portal's own ref validation
     * rejects, and the seed is the one place that could do that — every other
     * ref comes from `generateBookingRef()`.
     */
    if (!bookingRefSchema.safeParse(ref).success) {
      throw new Error(
        `seed: demo ref "${ref}" is not a valid booking ref — refSuffix must be two ` +
          `characters from REF_ALPHABET (${REF_ALPHABET})`,
      );
    }

    const tourDate = seedDate(trip.inDays);
    const [existing] = await db
      .select({ id: schema.bookings.id })
      .from(schema.bookings)
      .where(eq(schema.bookings.ref, ref));
    if (existing) continue;

    const pricePerPerson = 150_000;
    const total = pricePerPerson * trip.pax;
    await db.insert(schema.bookings).values({
      ref,
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

/**
 * Each tour's itinerary stops, in van order — **APP DATABASE ONLY** (owner
 * decision 2026-10-16, C4). Called from `seed()` beside `upsertFleet`, never
 * from `upsertTour`, so the gate is visible in one place.
 *
 * `rg_travel_test` keeps a narrower baseline on purpose: suites count
 * checkpoints and stops to decide how far a trip has progressed
 * (`tripProgress`, `checkins.ts`), and seed content those suites did not
 * create would change their answers.
 *
 * What this fixes is the fresh clone: `db:seed` shipped zero stops, so the
 * driver's itinerary screen showed "Start trip" and nothing else and the
 * departures board read 0/1 for every trip. 6C was built and tested all
 * along; it was simply undemonstrable.
 *
 * ## It never deletes a stop a driver has checked in at (7N, batch-3 carry-forward)
 *
 * This used to be the wholesale `DELETE FROM tour_itinerary_stops WHERE
 * tour_id = ?` that `admin.tours.update` also had before Task 6 fixed it, and
 * it had the identical bug: `trip_checkpoints.stop_id` references this table
 * with RESTRICT, so the FIRST real driver check-in against any seeded stop
 * broke `db:seed` for every future re-seed — against the dev database, which
 * is the only one that ships stops. On a laptop that has been used to walk
 * through a trip once, re-seeding would simply stop working, with a foreign-key
 * error pointing at a table nobody was thinking about.
 *
 * So the set is upserted instead, matched on `sort_order` — which IS this
 * data's natural key: the stops are a tour's call order and the seed gives
 * each one a distinct position. Matching that way keeps each stop's `id`
 * stable across re-seeds, which is worth more here than it is in the admin
 * path: a checkpoint already pointing at "stop 2" keeps pointing at the stop
 * the van actually reached.
 *
 * A stop the seed no longer lists is deleted ONLY when nothing has checked in
 * there; one with history is left standing and counted in the log. The seed
 * has nobody to refuse to, so Task 6's CONFLICT is not the right shape here —
 * the equivalent is to never attempt the impossible delete and to say what it
 * left behind.
 *
 * A slug that is not a seeded tour still throws rather than writing stops
 * against an id nobody can trace back.
 */
export async function upsertItineraryStops(
  db: Db,
  tourIdBySlug: Map<string, number>,
): Promise<void> {
  let written = 0;
  let kept = 0;
  for (const [slug, tourId] of tourIdBySlug) {
    const tour = SEED_TOURS.find((t) => t.slug === slug);
    if (tour === undefined) {
      throw new Error(`seed: itinerary stops requested for unknown tour "${slug}"`);
    }

    const stored = await db
      .select({ id: schema.tourItineraryStops.id, sortOrder: schema.tourItineraryStops.sortOrder })
      .from(schema.tourItineraryStops)
      .where(eq(schema.tourItineraryStops.tourId, tourId));
    const storedBySortOrder = new Map(stored.map((row) => [row.sortOrder, row.id]));

    for (const stop of tour.stops) {
      const existingId = storedBySortOrder.get(stop.sortOrder);
      if (existingId === undefined) {
        await db.insert(schema.tourItineraryStops).values({
          tourId,
          sortOrder: stop.sortOrder,
          name: stop.name,
          description: stop.description,
        });
      } else {
        // Scoped by `tour_id` as well as the row id, like the admin path's own
        // writes: one tour's save can never reach another tour's stop.
        await db
          .update(schema.tourItineraryStops)
          .set({ name: stop.name, description: stop.description })
          .where(
            and(
              eq(schema.tourItineraryStops.id, existingId),
              eq(schema.tourItineraryStops.tourId, tourId),
            ),
          );
        storedBySortOrder.delete(stop.sortOrder);
      }
    }

    /*
     * Whatever the seed no longer lists. Each is removed only if no checkpoint
     * points at it — the read is what stops the RESTRICT foreign key from
     * turning a re-seed into a crash, and it is deliberately per-stop rather
     * than one `NOT IN`, because the two outcomes differ per row.
     */
    for (const [, staleId] of storedBySortOrder) {
      const [checkedIn] = await db
        .select({ id: schema.tripCheckpoints.id })
        .from(schema.tripCheckpoints)
        .where(eq(schema.tripCheckpoints.stopId, staleId))
        .limit(1);
      if (checkedIn) {
        kept += 1;
        continue;
      }
      await db
        .delete(schema.tourItineraryStops)
        .where(
          and(
            eq(schema.tourItineraryStops.id, staleId),
            eq(schema.tourItineraryStops.tourId, tourId),
          ),
        );
    }

    written += tour.stops.length;
  }
  console.log(
    `[seed] itinerary stops: ${written} across ${tourIdBySlug.size} tours` +
      (kept > 0
        ? ` (${kept} stop(s) the seed no longer lists were KEPT — a trip has checked in there)`
        : ''),
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

  await seedFirstOwner(db);

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

  /*
   * Settings are INSERT-ONLY (see `insertSettingIfMissing`): a key already in
   * the table is left exactly as it is, because it may be configuration an
   * admin entered for real. The counts are printed so a re-seed's output says
   * so out loud rather than looking identical to the old overwriting one.
   */
  const settingKeys = Object.keys(SEED_SETTINGS) as Array<keyof typeof SEED_SETTINGS>;
  let settingsInserted = 0;
  for (const key of settingKeys) {
    if (await insertSettingIfMissing(db, key, SEED_SETTINGS[key])) settingsInserted += 1;
  }
  console.log(
    `[seed] settings: ${settingsInserted} inserted, ` +
      `${settingKeys.length - settingsInserted} already present (left untouched)`,
  );

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

  /*
   * Itinerary stops are APP-ONLY, like the fleet (owner decision
   * 2026-10-16, C4). `rg_travel_test` keeps a narrower baseline on
   * purpose: suites count checkpoints and stops to decide how far a trip
   * has progressed (`tripProgress`, `checkins.ts`), and seed content
   * those suites did not create would change their answers.
   *
   * What this fixes is the fresh clone: `db:seed` shipped zero stops, so
   * the driver's itinerary screen showed "Start trip" and nothing else
   * and the departures board read 0/1 for every trip. 6C was built and
   * tested all along; it was simply undemonstrable.
   */
  if (context === 'app') {
    await upsertItineraryStops(db, tourIdBySlug);
  } else {
    console.log('[seed] itinerary stops: skipped (test database ships none by design)');
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
