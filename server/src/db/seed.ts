/**
 * Seeds today's content (task 1.4) so that a later task can switch the
 * public site over to the API without changing the rendered page. Seeds
 * `rg_travel` by default; task 1.4b's test global setup calls `seed('test')`
 * to seed `rg_travel_test` instead, so the test suite starts from the same
 * canonical baseline.
 *
 * ## BASE vs DEMO (BUG-118, Week 7 Task B2)
 *
 * `seed()` itself is now `await seedBase(context); await seedDemo(context);`
 * — two halves with opposite re-run contracts, because they used to be one
 * function with one (wrong) contract: a plain upsert on every table, which on
 * 2026-10-28 reset a hand-entered `settings` row on the live `rg_travel`
 * database (see `insertSettingIfMissing`) and, less visibly, could do the
 * same to an admin-edited tour price, a deactivated driver or an `on_trip`
 * van on every subsequent re-seed. A2 fixed `settings` alone; this task fixes
 * the rest by giving each half its own rule instead of one rule for both:
 *
 *  - **`seedBase`** — `seedFirstOwner`, destinations, settings. **Insert-only,
 *    forever**, on every table it touches: a row that already exists is left
 *    exactly as it is, because by the time it exists it may be real,
 *    admin-entered configuration the seed cannot tell apart from its own
 *    default. Safe to re-run against production at any time — that is the
 *    whole point of the split. Wired to `pnpm --filter @rg/server db:seed`.
 *  - **`seedDemo`** — tours (incl. price tiers and images), packages, reviews,
 *    and, app-database only, the fleet and itinerary stops. **Unchanged
 *    upsert behaviour** — this is dev/demo content, and keeping it
 *    overwritable on a dev box is the whole point of it existing. **Refuses
 *    to run against anything but `rg_travel` or `rg_travel_test`** (its own
 *    `assertDatabaseName`/`assertConnectedDatabase` call, independent of
 *    `seedBase`'s), and must never be run against production once real
 *    content replaces the seed. Wired to `pnpm --filter @rg/server
 *    db:seed:demo`.
 *
 * Idempotent: every table `seedDemo` touches is upserted by a natural key
 * (`slug` for tours/packages, `name` + `tourId` for reviews). A tour's price
 * tiers and images have no natural key of their own, so they are replaced
 * wholesale for that tour on every run — same fixed set in, same fixed set
 * out, never duplicated. Itinerary stops follow the same rule but are
 * app-database only (`upsertItineraryStops`).
 *
 * **`settings` and now `destinations` are insert-only, never overwritten.**
 * They are the tables whose rows an admin edits in place rather than through
 * a screen that owns its own content, so a re-seed must leave an existing key
 * alone. See `insertSettingIfMissing` for the incident that made this a rule,
 * and `insertDestinationIfMissing` for the mirror of it.
 *
 * `assertDatabaseName` + `assertConnectedDatabase` run first, in BOTH halves
 * (CLAUDE.md: this project may only ever touch `rg_travel` for the app,
 * `rg_travel_test` for tests; Kong PMS shares the same MySQL server). Running
 * it twice when `seed()` calls both halves in sequence is deliberate and
 * cheap, not a defect to optimise away — it is what keeps a standalone
 * `seedDemo()` invocation guarded on its own. Never prints DATABASE_URL,
 * TEST_DATABASE_URL or a password. Never truncates, never hard-deletes.
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
import { closeDb, getDb, type Transaction } from './client';
import { hashPassword } from '../services/password';
import * as schema from './schema';
import {
  SEED_DEMO_TRANSFER_BOOKINGS,
  SEED_DEMO_TRIP_REQUEST,
  SEED_DESTINATIONS,
  SEED_DRIVERS,
  SEED_PACKAGES,
  SEED_REVIEWS,
  SEED_SETTINGS,
  SEED_TOURS,
  SEED_TRANSFER_AIRPORT_NAME,
  SEED_TRANSFER_PLACES,
  SEED_TRANSFER_ROUTES,
  SEED_UNASSIGNED_TRIPS,
  SEED_VANS,
  SEED_VEHICLE_TYPES,
  type SeedDestination,
  type SeedPackage,
  type SeedReview,
  type SeedTour,
} from './seed-data';
import {
  addCivilDays,
  bookingRefSchema,
  depositCentavos,
  manilaCivilDate,
  manilaInstant,
  type TransferRoutePricesInput,
} from '@rg/shared';
import { REF_ALPHABET } from '../services/booking-ref';
import { randomInt } from 'node:crypto';
import { withDeadlockRetry } from './deadlock';
import { readTransferOperationsSettings } from '../content/settings';
import { assignVanAndDriver } from '../services/dispatch/assign';
import { recordPayment } from '../services/payments/record-payment';
import { createTransferBooking } from '../services/transfers/create-booking';
import { clockTimeToMinutes } from '../services/transfers/overlap';
import { upsertTransferRoute } from '../services/transfers/upsert-route';

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

/**
 * A destination row is INSERT-ONLY, mirroring `insertSettingIfMissing` (Week
 * 7 Task B2 / BUG-118): a slug already in the table is left exactly as it
 * is, never re-upserted back to the seed's own name/blurb/image/ordering.
 * There is no destinations admin screen yet, but the same reasoning
 * `insertSettingIfMissing` documents applies pre-emptively — a table a
 * future admin screen edits in place must not have its rows reset by a
 * re-seed in the meantime.
 *
 * Returns `true` when it inserted, so the caller can report how many slugs
 * it left alone, same as the settings loop.
 *
 * The flip side of insert-only: once a slug exists, editing its fixture in
 * `SEED_DESTINATIONS` (a new blurb, a corrected image) is a silent no-op
 * against any database that already has that row — the same trade
 * `insertSettingIfMissing` makes, accepted for the same reason.
 */
async function insertDestinationIfMissing(db: Db, destination: SeedDestination): Promise<boolean> {
  const existing = await db
    .select({ id: schema.destinations.id })
    .from(schema.destinations)
    .where(eq(schema.destinations.slug, destination.slug));

  if (existing.length > 0) return false;

  await db.insert(schema.destinations).values({
    slug: destination.slug,
    name: destination.name,
    displayName: destination.displayName,
    blurb: destination.blurb,
    imagePath: destination.imagePath,
    imageAlt: destination.imageAlt,
    sortOrder: destination.sortOrder,
    featuredSortOrder: destination.featuredSortOrder,
    isFeatured: destination.isFeatured,
  });
  return true;
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
 * The three demo vehicle types (Task 1G, design note §1.1) — **APP DATABASE
 * ONLY**, same gate as `upsertFleet`/`upsertItineraryStops` below: nothing
 * here runs for `context === 'test'`, so `rg_travel_test` never gets an
 * `mpv` row and keeps exactly the two (`van`, `suv`) migration 0023 itself
 * backfilled.
 *
 * `van`/`suv` already exist by the time this runs — inserted by migration
 * 0023's own backfill, never by this seed — so for those two this is an
 * UPDATE-IF-UNSET on `defaultSeats`/`defaultLuggage` only, and never
 * overwrites a value that is already set (an admin may have filled one in
 * by hand since; see `vehicle_types`'s own schema comment on why the
 * backfill left them `NULL` rather than guessing). `mpv` is new: there is no
 * row for it anywhere, so the first run genuinely inserts it.
 *
 * Idempotent like the rest of `seedDemo`: matched on `slug`, never a literal
 * id. Returns the slug -> id map `upsertFleet` and `upsertDemoTransferRoutes`
 * both need to resolve the rest of this task's demo content.
 */
export async function upsertDemoVehicleTypes(db: Db): Promise<Map<string, number>> {
  const idBySlug = new Map<string, number>();
  for (const vt of SEED_VEHICLE_TYPES) {
    const [existing] = await db
      .select({
        id: schema.vehicleTypes.id,
        defaultSeats: schema.vehicleTypes.defaultSeats,
        defaultLuggage: schema.vehicleTypes.defaultLuggage,
      })
      .from(schema.vehicleTypes)
      .where(eq(schema.vehicleTypes.slug, vt.slug));

    if (existing) {
      const patch: Partial<typeof schema.vehicleTypes.$inferInsert> = {};
      if (existing.defaultSeats === null) patch.defaultSeats = vt.defaultSeats;
      if (existing.defaultLuggage === null) patch.defaultLuggage = vt.defaultLuggage;
      if (Object.keys(patch).length > 0) {
        await db
          .update(schema.vehicleTypes)
          .set(patch)
          .where(eq(schema.vehicleTypes.id, existing.id));
      }
      idBySlug.set(vt.slug, existing.id);
      continue;
    }

    const [result] = await db.insert(schema.vehicleTypes).values({
      name: vt.name,
      slug: vt.slug,
      defaultSeats: vt.defaultSeats,
      defaultLuggage: vt.defaultLuggage,
      sortOrder: vt.sortOrder,
    });
    idBySlug.set(vt.slug, result.insertId);
  }
  console.log(
    `[seed] vehicle types: ${SEED_VEHICLE_TYPES.length} (van/suv defaults filled only if unset; mpv created if missing)`,
  );
  return idBySlug;
}

/** The one normalisation `transfer_places.name_key` is built from — the same rule `admin.transferPlaces` enforces (BUG-107/BUG-108's lesson: normalise explicitly, never lean on collation). */
function transferPlaceNameKey(name: string): string {
  return name.trim().toLowerCase();
}

/**
 * The five demo transfer places (Task 1G, design note §1.2) — **APP DATABASE
 * ONLY**. Matched by `name_key`, never a literal id: the airport row may
 * already exist (migration 0024's conditional backfill creates it the
 * moment any `transfer_routes` row exists on the database being migrated),
 * and this resolves it rather than risking a duplicate on the `name_key`
 * UNIQUE.
 *
 * Idempotent like the rest of `seedDemo`: a re-run restates the same
 * name/isAirport/sortOrder rather than drifting. Returns the name-key -> id
 * map `upsertDemoTransferRoutes` needs.
 */
export async function upsertDemoTransferPlaces(db: Db): Promise<Map<string, number>> {
  const idByNameKey = new Map<string, number>();
  for (const place of SEED_TRANSFER_PLACES) {
    const nameKey = transferPlaceNameKey(place.name);
    const [existing] = await db
      .select({ id: schema.transferPlaces.id })
      .from(schema.transferPlaces)
      .where(eq(schema.transferPlaces.nameKey, nameKey));

    if (existing) {
      await db
        .update(schema.transferPlaces)
        .set({ name: place.name, isAirport: place.isAirport, sortOrder: place.sortOrder })
        .where(eq(schema.transferPlaces.id, existing.id));
      idByNameKey.set(nameKey, existing.id);
      continue;
    }

    const [result] = await db.insert(schema.transferPlaces).values({
      name: place.name,
      nameKey,
      isAirport: place.isAirport,
      sortOrder: place.sortOrder,
    });
    idByNameKey.set(nameKey, result.insertId);
  }
  console.log(`[seed] transfer places: ${SEED_TRANSFER_PLACES.length}`);
  return idByNameKey;
}

/**
 * The four demo transfer routes and their price cards (Task 1G, design note
 * §1.3/§1.4) — **APP DATABASE ONLY**.
 *
 * Reuses `upsertTransferRoute()`, the ONE writer of `transfer_routes` and
 * `transfer_route_vehicle_prices` (`services/transfers/upsert-route.ts`),
 * rather than a second hand-rolled insert of a money table. That matters
 * here specifically: `upsertTransferRoute`'s completeness contract reads a
 * present `prices` object as the WHOLE price card for the route, so leaving
 * `mpv` out of three of the four cards is exactly what makes it "not
 * offered" on those routes rather than "the seed forgot it" — the
 * demonstration this fixture exists to give (owner decision 4: a route need
 * not offer every vehicle type).
 *
 * Idempotent: each route is looked up by its `(fromPlaceId, toPlaceId)` pair
 * before the call, so a re-run updates the existing row rather than
 * colliding with the UNIQUE index.
 */
export async function upsertDemoTransferRoutes(
  db: Db,
  placeIdByNameKey: Map<string, number>,
  vehicleTypeIdBySlug: Map<string, number>,
): Promise<void> {
  const airportId = placeIdByNameKey.get(transferPlaceNameKey(SEED_TRANSFER_AIRPORT_NAME));
  if (airportId === undefined) {
    throw new Error(
      `seed: transfer routes need the "${SEED_TRANSFER_AIRPORT_NAME}" place to exist first`,
    );
  }

  await db.transaction(async (tx: Transaction) => {
    for (const route of SEED_TRANSFER_ROUTES) {
      const toPlaceId = placeIdByNameKey.get(transferPlaceNameKey(route.toPlaceName));
      if (toPlaceId === undefined) {
        throw new Error(
          `seed: transfer route "${route.slug}" references unknown place "${route.toPlaceName}"`,
        );
      }

      const prices: TransferRoutePricesInput = {};
      for (const price of route.prices) {
        const vehicleTypeId = vehicleTypeIdBySlug.get(price.vehicleTypeSlug);
        if (vehicleTypeId === undefined) {
          throw new Error(
            `seed: transfer route "${route.slug}" prices an unknown vehicle type "${price.vehicleTypeSlug}"`,
          );
        }
        prices[String(vehicleTypeId)] = {
          oneWayPriceCentavos: price.oneWayPricePesos * 100,
          dayUsePriceCentavos: price.dayUsePricePesos * 100,
        };
      }

      const [existing] = await tx
        .select({ id: schema.transferRoutes.id })
        .from(schema.transferRoutes)
        .where(
          and(
            eq(schema.transferRoutes.fromPlaceId, airportId),
            eq(schema.transferRoutes.toPlaceId, toPlaceId),
          ),
        );

      await upsertTransferRoute(tx, {
        id: existing?.id,
        fromPlaceId: airportId,
        toPlaceId,
        reverseEnabled: true,
        slug: route.slug,
        estimatedDurationMinutes: route.estimatedDurationMinutes,
        freeCancelHours: 24,
        inclusionsText: null,
        exclusionsText: null,
        prices,
      });
    }
  });
  console.log(
    `[seed] transfer routes: ${SEED_TRANSFER_ROUTES.length} (from "${SEED_TRANSFER_AIRPORT_NAME}")`,
  );
}

/**
 * The first active owner, or failing that any active staff account — just
 * an id to attribute a seed-driven payment/assignment to. Demo bookings are
 * app-only and this is always called after `seedBase` has had the chance to
 * create the first owner, but a fresh database where `OWNER_EMAIL`/
 * `OWNER_PASSWORD` were never set would have none — caught here with a
 * clear instruction rather than a foreign-key-shaped crash deep inside
 * `recordPayment`/`assignVanAndDriver`.
 */
async function resolveSeedActorUserId(db: Db): Promise<number> {
  const [owner] = await db
    .select({ id: schema.users.id })
    .from(schema.users)
    .where(and(eq(schema.users.role, 'owner'), eq(schema.users.isActive, true)))
    .limit(1);
  if (owner) return owner.id;

  const [anyStaff] = await db
    .select({ id: schema.users.id })
    .from(schema.users)
    .where(eq(schema.users.isActive, true))
    .limit(1);
  if (anyStaff) return anyStaff.id;

  throw new Error(
    'seed: demo transfer bookings need at least one active staff account to attribute the ' +
      'payment/assignment to — run db:seed (base) with OWNER_EMAIL/OWNER_PASSWORD set first.',
  );
}

/**
 * Fixed daytime pickup-time options for a `daysFromToday: 0` demo recipe.
 * NEVER derived from the clock — `now` only SELECTS among these constants
 * (via {@link pickTodayPickupSlot}); it never computes a new time by adding
 * an offset to itself. See that function and `upsertDemoTransferBookings`'s
 * own doc comment for why a fixed clock time cannot work here.
 *
 * Six slots, roughly 2.5 hours apart, stopping at `19:00`: that leaves every
 * slot safely clear of `MINUTES_PER_DAY` even for `mactan-airport-to-oslob`'s
 * 210-minute duration plus the seeded 60-minute buffer (19:00 + 210 + 60 =
 * 23:30, before midnight with 30 minutes to spare) — the longest route any
 * `daysFromToday: 0` recipe uses today. A future recipe on an even longer
 * route would need this list rechecked against its own duration.
 */
const TODAY_PICKUP_SLOT_CANDIDATES = [
  '06:30',
  '09:00',
  '11:30',
  '14:00',
  '16:30',
  '19:00',
] as const;

/**
 * The earliest of {@link TODAY_PICKUP_SLOT_CANDIDATES} that is still at
 * least `minNoticeHours` away from `now` AND keeps a one-way transfer of
 * `routeDurationMinutes` (plus `bufferMinutes`) from crossing midnight —
 * `null` when none of the six fixed options clears both, which only
 * happens on a seed run late enough in the evening that no same-day pickup
 * can satisfy the real notice rule without also running past midnight.
 *
 * Picking the EARLIEST viable slot (rather than, say, the latest) is
 * deliberate: it leaves the most margin against both boundaries, and there
 * is no reason for a demo booking to cut either closer than it has to.
 */
function pickTodayPickupSlot(
  now: Date,
  todayCivil: string,
  minNoticeHours: number,
  routeDurationMinutes: number,
  bufferMinutes: number,
): string | null {
  const noticeFloorMs = now.getTime() + minNoticeHours * 3_600_000;
  for (const slot of TODAY_PICKUP_SLOT_CANDIDATES) {
    const slotMinutes = clockTimeToMinutes(slot);
    /* istanbul ignore next -- every literal above matches `HH:mm` by construction */
    if (slotMinutes === null) continue;
    if (slotMinutes + routeDurationMinutes + bufferMinutes > 1440) continue;
    if (manilaInstant(todayCivil, slot).getTime() >= noticeFloorMs) return slot;
  }
  return null;
}

/**
 * The five demo items Task 1E adds: four real transfer bookings plus one
 * custom trip-request inquiry (handled separately, see
 * `upsertDemoTripRequest` below) — APP DATABASE ONLY, never `seedBase`,
 * never `rg_travel_test`, same gate every other demo-content helper in this
 * file uses.
 *
 * **Driven by the real services, not raw inserts** (owner decision 4 /
 * this task's own DO-NOT list, which explicitly authorizes this —
 * `createTransferBooking()` for the hold, `recordPayment()` for a deposit,
 * `assignVanAndDriver()` for dispatch — the opposite choice from
 * `SEED_UNASSIGNED_TRIPS` above, which deliberately avoids `recordPayment()`
 * for TOUR demo data. The difference is the brief: that trip only needed a
 * STATUS and a missing van/driver; this one needs a genuinely paid deposit
 * so the dashboard's money block and the payment box have something real to
 * show.
 *
 * **`daysFromToday: 0` pickup times are picked from a FIXED list, never
 * computed from the clock — and the real `minNoticeHours` rule is identical
 * for every `priceSource`, so there is no "staff path" shortcut around it.**
 * (Confirmed by reading `create-booking.ts`: the notice check runs
 * unconditionally before any `priceSource` branch, and `convert-quote.ts`'s
 * staff-conversion path calls the same function with the same check — this
 * was the wrong assumption behind this function's first version, which
 * computed a pushed-forward pickup from `now + minNoticeHours + 30 minutes`
 * and could land past the midnight-crossing capacity refusal on a
 * late-afternoon run, exactly the failure that made this file's second
 * version necessary.)
 *
 * `pickTodayPickupSlot()` picks the earliest fixed daytime slot that clears
 * both the real `minNoticeHours` rule and the midnight-crossing window for
 * the recipe's actual route duration. **When no fixed slot clears both**
 * (a seed run late enough in the evening that even `19:00` cannot satisfy
 * `minNoticeHours` without crossing midnight) **the recipe is rolled to
 * tomorrow's civil date instead, at the earliest candidate slot** — which
 * trivially clears both boundaries a full day out. This keeps the five
 * DO-NOTs intact: no rule is bypassed (the booking that lands "today" always
 * really does clear every real check; the ones that cannot, don't pretend
 * to), and nothing is hand-set outside `createTransferBooking()`/
 * `recordPayment()`.
 */
export async function upsertDemoTransferBookings(db: Db, now: Date = new Date()): Promise<void> {
  const todayCivil = manilaCivilDate(now);
  const operations = await readTransferOperationsSettings();
  const actorUserId = await resolveSeedActorUserId(db);

  let created = 0;
  let skipped = 0;

  for (const recipe of SEED_DEMO_TRANSFER_BOOKINGS) {
    const [existing] = await db
      .select({ id: schema.bookings.id })
      .from(schema.bookings)
      .where(eq(schema.bookings.leadEmail, recipe.leadEmail));
    if (existing) {
      skipped += 1;
      continue;
    }

    const [route] = await db
      .select({
        id: schema.transferRoutes.id,
        estimatedDurationMinutes: schema.transferRoutes.estimatedDurationMinutes,
      })
      .from(schema.transferRoutes)
      .where(eq(schema.transferRoutes.slug, recipe.routeSlug));
    if (!route) {
      throw new Error(`seed: demo transfer booking references unknown route "${recipe.routeSlug}"`);
    }
    const [vehicleType] = await db
      .select({ id: schema.vehicleTypes.id })
      .from(schema.vehicleTypes)
      .where(eq(schema.vehicleTypes.slug, recipe.vehicleTypeSlug));
    if (!vehicleType) {
      throw new Error(
        `seed: demo transfer booking references unknown vehicle type "${recipe.vehicleTypeSlug}"`,
      );
    }

    let civilDate = addCivilDays(todayCivil, recipe.daysFromToday);
    let pickupTime = recipe.pickupTime;
    if (recipe.daysFromToday === 0) {
      const slot = pickTodayPickupSlot(
        now,
        todayCivil,
        operations.minNoticeHours,
        route.estimatedDurationMinutes,
        operations.bufferMinutes,
      );
      if (slot !== null) {
        pickupTime = slot;
      } else {
        // No fixed slot today clears both minNoticeHours and the
        // midnight-crossing window — roll to tomorrow, where the earliest
        // candidate trivially clears both.
        civilDate = addCivilDays(todayCivil, 1);
        pickupTime = TODAY_PICKUP_SLOT_CANDIDATES[0];
        console.log(
          `[seed] demo transfer booking "${recipe.leadEmail}": no same-day slot clears ` +
            `minNoticeHours/midnight at this run time — rolled to tomorrow (${civilDate}, ${pickupTime}).`,
        );
      }
    }

    const held = await createTransferBooking(
      {
        date: civilDate,
        routeId: route.id,
        customRouteDescription: null,
        vehicleTypeId: vehicleType.id,
        productType: recipe.productType,
        customRouteDurationMinutes: null,
        direction: recipe.direction,
        pickupTime,
        dayUseEndTime: recipe.dayUseEndTime,
        pax: recipe.pax,
        luggageCount: recipe.luggageCount,
        pickup: null,
        pickupMapUrl: null,
        dropoffAddress: recipe.dropoffAddress,
        dropoffMapUrl: null,
        flightNumber: recipe.flightNumber,
        airline: recipe.airline,
        requests: null,
        payMode: 'deposit',
        lead: {
          name: recipe.leadName,
          email: recipe.leadEmail,
          phone: '+639170000098',
        },
        priceSource: { kind: 'catalog' },
      },
      now,
    );

    if (recipe.payDeposit) {
      const [booking] = await db
        .select({
          totalCentavos: schema.bookings.totalCentavos,
          priceSnapshot: schema.bookings.priceSnapshot,
        })
        .from(schema.bookings)
        .where(eq(schema.bookings.id, held.bookingId));
      if (!booking) {
        throw new Error(`seed: demo transfer booking ${held.ref} vanished right after creation`);
      }
      const deposit = depositCentavos(booking.totalCentavos, booking.priceSnapshot.depositPercent);
      await recordPayment(
        {
          bookingId: held.bookingId,
          type: 'payment',
          provider: 'manual',
          method: 'gcash',
          amountCentavos: deposit,
          actor: { type: 'system', id: null },
        },
        now,
      );

      if (recipe.assignTo) {
        const [van] = await db
          .select({ id: schema.vans.id })
          .from(schema.vans)
          .where(eq(schema.vans.plate, recipe.assignTo.vanPlate));
        const [driver] = await db
          .select({ id: schema.drivers.id })
          .from(schema.drivers)
          .where(eq(schema.drivers.code, recipe.assignTo.driverCode));
        if (!van || !driver) {
          throw new Error(
            `seed: demo transfer booking ${held.ref} wants van "${recipe.assignTo.vanPlate}"/driver ` +
              `"${recipe.assignTo.driverCode}", neither of which should be missing from the seeded fleet`,
          );
        }
        const verdict = await withDeadlockRetry(() =>
          db.transaction((tx) =>
            assignVanAndDriver(tx, {
              bookingId: held.bookingId,
              vanId: van.id,
              driverId: driver.id,
              actorUserId,
            }),
          ),
        );
        if (!verdict.ok) {
          throw new Error(
            `seed: demo transfer booking ${held.ref} could not be assigned (${verdict.reason}) — ` +
              "check the recipe's pickup time against the fleet fixtures for an overlap.",
          );
        }
      }
    }

    created += 1;
  }

  console.log(
    `[seed] demo transfer bookings: ${created} new, ${skipped} already present (left untouched)`,
  );
}

/**
 * The fifth demo item: a custom trip-request inquiry. App-only, same gate.
 * Direct insert, matching this file's own house style for demo content with
 * no existing public-mutation seed helper (`inquiries.create` needs a full
 * tRPC context this script does not build) — `status: 'new'` is set exactly
 * as the real mutation sets it.
 */
export async function upsertDemoTripRequest(db: Db): Promise<void> {
  const [existing] = await db
    .select({ id: schema.inquiries.id })
    .from(schema.inquiries)
    .where(eq(schema.inquiries.email, SEED_DEMO_TRIP_REQUEST.email));
  if (existing) {
    console.log('[seed] demo trip request: already present (left untouched)');
    return;
  }

  const requestedDate = addCivilDays(
    manilaCivilDate(new Date()),
    SEED_DEMO_TRIP_REQUEST.requestedDateDaysFromToday,
  );

  await db.insert(schema.inquiries).values({
    type: 'transfer_custom',
    name: SEED_DEMO_TRIP_REQUEST.name,
    email: SEED_DEMO_TRIP_REQUEST.email,
    phone: SEED_DEMO_TRIP_REQUEST.phone,
    message: SEED_DEMO_TRIP_REQUEST.message,
    status: 'new',
    requestedDate,
    pax: SEED_DEMO_TRIP_REQUEST.pax,
    routeDescription: SEED_DEMO_TRIP_REQUEST.routeDescription,
  });
  console.log('[seed] demo trip request: 1 new');
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
  /*
   * Resolved by `vehicle_types.slug`, never a literal id (owner decision
   * 2026-11-08) — vehicle types are an admin-managed list now, and the two
   * natural-key rows (`van`, `suv`) are inserted by migration 0023, not by
   * this seed, so this lookup must tolerate running against a database
   * where they already exist rather than creating them again.
   */
  const vehicleTypeRows = await db
    .select({ id: schema.vehicleTypes.id, slug: schema.vehicleTypes.slug })
    .from(schema.vehicleTypes);
  const vehicleTypeIdBySlug = new Map(vehicleTypeRows.map((row) => [row.slug, row.id]));

  for (const van of SEED_VANS) {
    const vehicleTypeId = vehicleTypeIdBySlug.get(van.vehicleTypeSlug);
    if (vehicleTypeId === undefined) {
      throw new Error(
        `[seed] no vehicle_types row for slug "${van.vehicleTypeSlug}" (van ${van.plate}) — ` +
          'has migration 0023 been applied to this database?',
      );
    }

    const [existing] = await db
      .select({ id: schema.vans.id })
      .from(schema.vans)
      .where(eq(schema.vans.plate, van.plate));
    const values = {
      plate: van.plate,
      model: van.model,
      capacity: van.capacity,
      status: van.status,
      vehicleTypeId,
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

/**
 * Guard-then-connect, shared by `seedBase` and `seedDemo`: resolve the right
 * URL for `context`, fail loudly if it is missing, then run the same
 * two-step check every entry point into this database runs
 * (`assertDatabaseName` against the URL's own declared name, then
 * `assertConnectedDatabase` against what the live connection actually
 * resolved to). Returns the open `Db` handle so each caller does not repeat
 * the `getDb()` call.
 *
 * Called once by `seedBase` and once by `seedDemo` — twice in total when
 * `seed()` runs both in sequence. That duplication is deliberate (see the
 * module doc-comment): it is what keeps a standalone `seedDemo()` CLI
 * invocation guarded even though nothing calls `seedBase()` first.
 */
export async function guardAndConnect(context: DatabaseContext): Promise<Db> {
  const url = context === 'test' ? env.TEST_DATABASE_URL : env.DATABASE_URL;
  if (!url) {
    throw new Error(
      `No ${context === 'test' ? 'TEST_DATABASE_URL' : 'DATABASE_URL'} is configured.`,
    );
  }
  assertDatabaseName(databaseNameFromUrl(url), context);
  await assertConnectedDatabase(context);
  return getDb();
}

/**
 * The BASE half (Week 7 Task B2, BUG-118): the first owner, destinations,
 * settings. Every table here is insert-only — see the module doc-comment
 * and `insertSettingIfMissing`/`insertDestinationIfMissing` — so this is
 * safe to re-run against the production database at any time. Wired to
 * `pnpm --filter @rg/server db:seed`.
 */
export async function seedBase(context: DatabaseContext = 'app'): Promise<void> {
  const db = await guardAndConnect(context);

  await seedFirstOwner(db);

  /*
   * Destinations are INSERT-ONLY, like settings (see
   * `insertDestinationIfMissing`): a slug already in the table is left
   * exactly as it is.
   */
  let destinationsInserted = 0;
  for (const destination of SEED_DESTINATIONS) {
    if (await insertDestinationIfMissing(db, destination)) destinationsInserted += 1;
  }
  console.log(
    `[seed] destinations: ${destinationsInserted} inserted, ` +
      `${SEED_DESTINATIONS.length - destinationsInserted} already present (left untouched)`,
  );

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
}

/**
 * The DEMO half (Week 7 Task B2, BUG-118): tours (with their price tiers and
 * images), packages, reviews, and — app database only — the fleet and
 * itinerary stops. **Unchanged upsert behaviour**: this is dev/demo content,
 * and keeping it overwritable on a dev box is the entire point of the split.
 * **Must never be run against production once real content replaces the
 * seed** — `db:seed:demo` is a dev-only command, enforced the only way a
 * seed script can enforce anything: it guards its own database name
 * (`guardAndConnect`, same as `seedBase`) rather than trusting the caller to
 * remember. Wired to `pnpm --filter @rg/server db:seed:demo`.
 *
 * ## Task C2 — the real guard, on top of the database-name one
 *
 * `guardAndConnect`'s `assertDatabaseName`/`assertConnectedDatabase` call
 * does NOT protect production: production's own database is also named
 * `rg_travel` (`APP_DATABASE_NAME`), so that guard waves a production run
 * straight through. Before anything else — ahead of `guardAndConnect`, so
 * no connection is even opened — two independent checks, each refusing with
 * its own distinct message naming which one failed:
 *
 *  - `ALLOW_DEMO_SEED` must be the exact string `'1'`. Unset, empty, or any
 *    other value refuses. This is a deliberate opt-in a deployer must set
 *    by hand; there is no default that makes this command runnable.
 *  - `NODE_ENV` must not be `'production'`. A command this overwrite-happy
 *    (BUG-118) must never run on a production box regardless of what else
 *    is configured there.
 *
 * Both checks apply regardless of `context` — they guard the DEMO half
 * specifically, not `seedBase`/the base seed, and both run for a standalone
 * `seedDemo('test')` call exactly as they do for `seedDemo('app')`. The test
 * suite's own `seed('test')` callers need `ALLOW_DEMO_SEED=1` in the test
 * process's environment, and `server/vitest.config.ts` sets it through TWO
 * mechanisms protecting two different callers:
 *  - a top-level `process.env.ALLOW_DEMO_SEED ??= '1';` statement (outside
 *    `defineConfig`), which is what `global-setup.ts` actually relies on —
 *    its static `import { env } from '../env'` runs in Vitest's MAIN
 *    process, before any worker exists, and `test.env` below never reaches
 *    that process;
 *  - the `test.env` option, which Vitest applies inside each test FILE's own
 *    worker — what a test that calls `seed('test')`/`seedDemo('test')`
 *    directly, inside its own worker, is relying on instead.
 * Their `NODE_ENV` is already `'test'`, so the production check never has to
 * be loosened for them.
 */
export async function seedDemo(context: DatabaseContext = 'app'): Promise<void> {
  if (env.ALLOW_DEMO_SEED !== '1') {
    throw new Error(
      'seedDemo: refusing to run — set ALLOW_DEMO_SEED=1 to run this. Dev-only; never set this ' +
        'on a production server.',
    );
  }
  if (env.NODE_ENV === 'production') {
    throw new Error(
      'seedDemo: refusing to run — this command must never run with NODE_ENV=production.',
    );
  }

  const db = await guardAndConnect(context);

  /*
   * Destinations are `seedBase`'s table now, not this one's — read the ids
   * `seedBase` already wrote rather than re-inserting or upserting them. A
   * missing destination means `seedBase` (or an equivalent `db:seed`) has
   * never been run against this database; that is a real ordering error,
   * not something this half should paper over.
   */
  const destinationIdBySlug = new Map<string, number>();
  for (const destination of SEED_DESTINATIONS) {
    const [existing] = await db
      .select({ id: schema.destinations.id })
      .from(schema.destinations)
      .where(eq(schema.destinations.slug, destination.slug));
    if (!existing) {
      throw new Error(
        `seedDemo: destination "${destination.slug}" does not exist — run db:seed (base) first.`,
      );
    }
    destinationIdBySlug.set(destination.slug, existing.id);
  }

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
   * Vehicle types are APP-ONLY too (Task 1G): `rg_travel_test` keeps exactly
   * the two rows migration 0023 backfilled (`van`, `suv`) and never gets
   * `mpv`. Resolved before the fleet so the two new demo vans below
   * (`DEMO-SUV-01`, `DEMO-MPV-01`) have an id to resolve against.
   */
  let vehicleTypeIdBySlug = new Map<string, number>();
  if (context === 'app') {
    vehicleTypeIdBySlug = await upsertDemoVehicleTypes(db);
  } else {
    console.log(
      '[seed] vehicle types: skipped (test database keeps only the backfilled van/suv rows)',
    );
  }

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
   * Transfer places and routes are APP-ONLY, same reasoning (Task 1G):
   * `rg_travel_test` keeps zero rows in `transfer_places`/`transfer_routes`/
   * `transfer_route_vehicle_prices` — there is no suite that counts them the
   * way `capacity.test.ts` counts the fleet, but there is also no reason for
   * demo marketing content to exist on the database the money-path tests run
   * against.
   */
  if (context === 'app') {
    const placeIdByNameKey = await upsertDemoTransferPlaces(db);
    await upsertDemoTransferRoutes(db, placeIdByNameKey, vehicleTypeIdBySlug);
  } else {
    console.log('[seed] transfer places/routes: skipped (app-only demo content)');
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

  /*
   * Demo transfer bookings are APP-ONLY (Task 1E, admin dashboard batch,
   * owner decision 2026-11-10, decision 4) — after the fleet, the routes
   * and the vehicle types, all of which this needs to already exist.
   * `rg_travel_test` gets none: `capacity.test.ts` counts the whole fleet
   * and `dashboard-summary.test.ts`/`dashboard-alerts.test.ts` build their
   * own isolated fixtures, so seed content here would only change their
   * answers for no benefit, the same reasoning the fleet itself is gated on.
   */
  if (context === 'app') {
    await upsertDemoTransferBookings(db);
    await upsertDemoTripRequest(db);
  } else {
    console.log('[seed] demo transfer bookings/trip request: skipped (app-only demo content)');
  }

  console.log('[seed] done.');
}

/**
 * Both halves, in order — unchanged external behaviour from before the
 * split (Week 7 Task B2). Every existing caller that imports `seed` (test
 * files, `global-setup.ts`, `helpers/test-db.ts`) keeps working exactly as
 * it did; only the CLI entry points below were repointed at the two halves
 * directly.
 */
export async function seed(context: DatabaseContext = 'app'): Promise<void> {
  await seedBase(context);
  await seedDemo(context);
}

const isMainModule =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMainModule) {
  seedBase()
    .then(async () => {
      await closeDb();
    })
    .catch(async (error: unknown) => {
      console.error('[seed] failed:', error instanceof Error ? error.message : error);
      await closeDb();
      process.exit(1);
    });
}
