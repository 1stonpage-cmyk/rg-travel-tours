/**
 * Task 1E (admin dashboard batch, owner decision 2026-11-10, decision 4):
 * `upsertDemoTransferBookings` / `upsertDemoTripRequest` in `db/seed.ts`.
 *
 * **Why this file builds its own route/place/van/driver fixtures instead of
 * calling the real `upsertDemoVehicleTypes`/`upsertDemoTransferPlaces`/
 * `upsertDemoTransferRoutes`/`upsertFleet` helpers.** Those helpers write
 * demo marketing content and a demo fleet, and `rg_travel_test` is
 * DELIBERATELY kept at zero rows in `vans`/`drivers`/`transfer_places`/
 * `transfer_routes` — `capacity.test.ts` counts the WHOLE fleet, so a
 * leftover van breaks a completely unrelated, money-path-guarding suite
 * (`db/seed.ts`'s own doc comments on `upsertFleet` and the transfer
 * places/routes gate explain why). This file instead inserts exactly the
 * rows `upsertDemoTransferBookings`'s recipes need (matching the real
 * `SEED_TRANSFER_ROUTES`/`SEED_DEMO_TRANSFER_BOOKINGS` slugs/plates/codes
 * exactly), and removes every one of them in `afterAll` — the same
 * discipline `dashboard-alerts.test.ts`'s own van/driver fixtures already
 * follow in this same database.
 *
 * `vehicle_types` is the one exception: `van`/`suv` are backfilled by
 * migration 0023 into EVERY database including `rg_travel_test`, so they
 * are read, never inserted or removed here.
 */
import { afterAll, beforeAll, expect, it } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import { seedBase, seedDemo, upsertDemoTransferBookings, upsertDemoTripRequest } from '../db/seed';
import {
  SEED_DEMO_TRANSFER_BOOKINGS,
  SEED_DEMO_TRIP_REQUEST,
  type SeedDemoTransferBooking,
} from '../db/seed-data';
import { addCivilDays, civilDateFromDate, manilaCivilDate, manilaInstant } from '@rg/shared';
import { getDb, getPool } from '../db/client';
import {
  bookingTransferDetails,
  bookings,
  drivers,
  inquiries,
  transferPlaces,
  transferRouteVehiclePrices,
  transferRoutes,
  users,
  vans,
  vehicleTypes,
} from '../db/schema';
import { describeWithDb } from './helpers/db';

/** The exact slugs/plates/codes `SEED_DEMO_TRANSFER_BOOKINGS` references. */
const ROUTE_SLUGS = [
  'mactan-airport-to-cebu-city',
  'mactan-airport-to-moalboal',
  'mactan-airport-to-oslob',
] as const;
const VAN_PLATE = 'SEED-001';
const DRIVER_CODE = 'D01';
/** The Moalboal/flight recipe wants an SUV — a second fixture van, a second type. */
const SUV_PLATE = 'SEED-SUV-01';

/**
 * Every civil date `SEED_DEMO_TRANSFER_BOOKINGS` can touch (its
 * `daysFromToday` values), computed the same way the function under test
 * does. `takeFleetDateLock` (inside `createTransferBooking`) writes a
 * `fleet_date_slots` row for the date on EVERY call, including one that
 * later refuses for capacity — so this is cleaned up in `afterAll`
 * unconditionally, not only when a booking actually landed.
 */
const TOUCHED_CIVIL_DATES = [
  ...new Set(SEED_DEMO_TRANSFER_BOOKINGS.map((b) => b.daysFromToday)),
].map((days) => addCivilDays(manilaCivilDate(new Date()), days));

/**
 * The two `daysFromToday: 0` recipes exist so the dashboard and Departures
 * board have something to show for "today" in a demo. This is the civil
 * date they must land on whenever the real rules allow it at all — see
 * `TEST_RUN_NOW` below for why the main creation test pins an explicit,
 * safe `now` rather than trusting the real wall clock at whatever hour this
 * suite happens to run.
 */
const TODAY_CIVIL_DATE = manilaCivilDate(new Date());

/**
 * A fixed, deterministic `now` for the main creation test — `06:00` Manila
 * on the real "today". Not the real wall clock: `pickTodayPickupSlot`'s
 * candidates stop at `19:00`, so whether a `daysFromToday: 0` recipe can
 * still land on TODAY at all depends on what time of day this suite
 * happens to run (default `minNoticeHours` is 6, so any real run past
 * ~13:00 Manila would roll both today-recipes to tomorrow and this test's
 * "lands on today" assertions would fail for a reason that has nothing to
 * do with a regression). `06:00` guarantees a same-day slot exists
 * (`now + 6h = 12:00`, and `14:00` clears both minNoticeHours and the
 * midnight-crossing window for every route a `daysFromToday: 0` recipe
 * uses today) without this particular test needing to know which exact
 * slot gets picked — that exact-slot assertion is its own test, below
 * ("creates today's two recipes at 14:00 when run at 06:00 Manila").
 */
const TEST_RUN_NOW = manilaInstant(TODAY_CIVIL_DATE, '06:00');

const created = {
  placeIds: [] as number[],
  routeIds: [] as number[],
  vanIds: [] as number[],
  driverIds: [] as number[],
  userIds: [] as number[],
};

async function vehicleTypeId(slug: 'van' | 'suv'): Promise<number> {
  const [row] = await getDb()
    .select({ id: vehicleTypes.id })
    .from(vehicleTypes)
    .where(eq(vehicleTypes.slug, slug));
  if (!row) {
    throw new Error(
      `No vehicle_types row for slug "${slug}" — expected from migration 0023's backfill.`,
    );
  }
  return row.id;
}

async function bookingByEmail(email: string) {
  const [row] = await getDb().select().from(bookings).where(eq(bookings.leadEmail, email));
  return row ?? null;
}

/**
 * Deletes one demo booking and every row that references it — shared by
 * `afterAll` (the suite's own teardown) and the two notice-boundary tests
 * below, which each delete and recreate the two `daysFromToday: 0` recipes
 * under a different injected `now` to exercise `pickTodayPickupSlot`
 * without tripping the real function's own idempotency (keyed on
 * `leadEmail`) against a row a PRIOR test in this file already created.
 */
async function deleteBookingAndDependents(email: string): Promise<void> {
  const pool = getPool();
  const booking = await bookingByEmail(email);
  if (!booking) return;
  await pool.query('DELETE FROM payments WHERE booking_id = ?', [booking.id]);
  await pool.query('DELETE FROM booking_transfer_details WHERE booking_id = ?', [booking.id]);
  await pool.query('DELETE FROM audit_log WHERE entity = ? AND entity_id = ?', [
    'bookings',
    booking.id,
  ]);
  await pool.query('DELETE FROM bookings WHERE id = ?', [booking.id]);
}

describeWithDb('db/seed.ts — upsertDemoTransferBookings / upsertDemoTripRequest (Task 1E)', () => {
  beforeAll(async () => {
    const db = getDb();

    // One active owner, so `resolveSeedActorUserId` has something to find.
    const [owner] = await db.insert(users).values({
      name: 'Seed Demo Fixture Owner',
      email: `seeddemo_owner_${Date.now()}@example.test`,
      passwordHash: '__seeddemo_fixture_not_a_hash__',
      role: 'owner',
      isActive: true,
    });
    created.userIds.push(owner.insertId);

    // The airport plus the three destinations the three routes need.
    const [airport] = await db.insert(transferPlaces).values({
      name: 'Mactan-Cebu International Airport',
      nameKey: '__seeddemo__airport',
      isAirport: true,
    });
    created.placeIds.push(airport.insertId);

    const destNames: Record<string, string> = {
      'mactan-airport-to-cebu-city': 'Cebu City',
      'mactan-airport-to-moalboal': 'Moalboal',
      'mactan-airport-to-oslob': 'Oslob',
    };
    const vanTypeId = await vehicleTypeId('van');
    const suvTypeId = await vehicleTypeId('suv');

    for (const slug of ROUTE_SLUGS) {
      const toName = destNames[slug]!;
      const [place] = await db
        .insert(transferPlaces)
        .values({ name: toName, nameKey: `__seeddemo__${slug}`, isAirport: false });
      created.placeIds.push(place.insertId);

      const [route] = await db.insert(transferRoutes).values({
        fromPlaceId: airport.insertId,
        toPlaceId: place.insertId,
        reverseEnabled: true,
        slug,
        estimatedDurationMinutes: 60,
        freeCancelHours: 24,
      });
      created.routeIds.push(route.insertId);

      const typeId = slug === 'mactan-airport-to-moalboal' ? suvTypeId : vanTypeId;
      await db.insert(transferRouteVehiclePrices).values({
        routeId: route.insertId,
        vehicleTypeId: typeId,
        oneWayPriceCentavos: 500_000,
        dayUsePriceCentavos: 700_000,
      });
    }

    const [van] = await db.insert(vans).values({
      plate: VAN_PLATE,
      model: 'Seed Demo Fixture Van',
      capacity: 10,
      vehicleTypeId: vanTypeId,
      status: 'available',
      isActive: true,
    });
    created.vanIds.push(van.insertId);

    // A SECOND van-type vehicle, matching the real app database (which has
    // four, `SEED-001`..`SEED-004`). Needed here because both
    // `daysFromToday: 0` recipes are `van`-type and share the exact same
    // fixed candidate-slot list and selection rule (`pickTodayPickupSlot`),
    // so at `TEST_RUN_NOW` (06:00) they both independently resolve to the
    // same `14:00` slot on the same civil date — two simultaneous van
    // requests against a one-van fixture fleet is a genuine, if test-only,
    // capacity collision, not a bug in `upsertDemoTransferBookings` itself.
    const [secondVan] = await db.insert(vans).values({
      plate: 'SEED-002',
      model: 'Seed Demo Fixture Van 2',
      capacity: 10,
      vehicleTypeId: vanTypeId,
      status: 'available',
      isActive: true,
    });
    created.vanIds.push(secondVan.insertId);

    // The Moalboal/flight recipe (`SEED_DEMO_TRANSFER_BOOKINGS`) wants an
    // SUV — capacity has nothing to offer it without a sellable SUV in the
    // fixture fleet.
    const [suv] = await db.insert(vans).values({
      plate: SUV_PLATE,
      model: 'Seed Demo Fixture SUV',
      capacity: 4,
      vehicleTypeId: suvTypeId,
      status: 'available',
      isActive: true,
    });
    created.vanIds.push(suv.insertId);

    const [driver] = await db.insert(drivers).values({
      name: 'Seed Demo Fixture Driver',
      code: DRIVER_CODE,
      phone: '09170000097',
      pinHash: '__seeddemo_fixture_not_a_pin_hash__',
      isActive: true,
    });
    created.driverIds.push(driver.insertId);

    // A SECOND driver (default cap 2/day each, from `transfer_operations`'s
    // seeded `maxTransferJobsPerDriverPerDay`). The notice-boundary tests
    // below exercise a day that already carries the flight recipe
    // (`daysFromToday: 1`) plus BOTH `daysFromToday: 0` recipes rolled onto
    // the same civil date by a late-enough `now` — three transfers wanting
    // a driver on one day, which a one-driver pool (cap 2) cannot cover.
    const [secondDriver] = await db.insert(drivers).values({
      name: 'Seed Demo Fixture Driver 2',
      code: 'D02',
      phone: '09170000096',
      pinHash: '__seeddemo_fixture_not_a_pin_hash__',
      isActive: true,
    });
    created.driverIds.push(secondDriver.insertId);
  });

  afterAll(async () => {
    const pool = getPool();
    for (const booking of SEED_DEMO_TRANSFER_BOOKINGS) {
      await deleteBookingAndDependents(booking.leadEmail);
    }
    await getDb().delete(inquiries).where(eq(inquiries.email, SEED_DEMO_TRIP_REQUEST.email));

    // `takeFleetDateLock` (inside `createTransferBooking`) writes a
    // `fleet_date_slots` row for the date on every call, including a call
    // that then refuses for capacity — so this runs unconditionally, not
    // only for dates a booking actually landed on. Raw `pool.query`, not
    // Drizzle's `inArray`: `fleet_date_slots.date` is a `date()` column
    // (typed `Date` in TS), and these are civil-date STRINGS — the house
    // rule against comparing the two through a typed Drizzle operator.
    for (const civilDate of TOUCHED_CIVIL_DATES) {
      await pool.query('DELETE FROM fleet_date_slots WHERE date = ?', [civilDate]);
    }

    if (created.routeIds.length > 0) {
      await getDb()
        .delete(transferRouteVehiclePrices)
        .where(inArray(transferRouteVehiclePrices.routeId, created.routeIds));
      await getDb().delete(transferRoutes).where(inArray(transferRoutes.id, created.routeIds));
    }
    if (created.placeIds.length > 0) {
      await getDb().delete(transferPlaces).where(inArray(transferPlaces.id, created.placeIds));
    }
    for (const id of created.vanIds) await pool.query('DELETE FROM vans WHERE id = ?', [id]);
    for (const id of created.driverIds) {
      await pool.query('DELETE FROM sessions WHERE subject_type = ? AND subject_id = ?', [
        'driver',
        id,
      ]);
      await pool.query('DELETE FROM drivers WHERE id = ?', [id]);
    }
    if (created.userIds.length > 0) {
      await getDb().delete(users).where(inArray(users.id, created.userIds));
    }
  });

  it('creates all four demo bookings with the right statuses, and the fifth item as an inquiry', async () => {
    await upsertDemoTransferBookings(getDb(), TEST_RUN_NOW);
    await upsertDemoTripRequest(getDb());

    const assigned = await bookingByEmail('demo.transfer.assigned@example.test');
    expect(assigned?.status).toBe('assigned');
    expect(assigned?.vanId).not.toBeNull();
    expect(assigned?.driverId).not.toBeNull();
    expect(assigned?.amountPaidCentavos).toBeGreaterThan(0);
    // Both `daysFromToday: 0` recipes land on TODAY's Manila civil date at
    // `TEST_RUN_NOW` (06:00, a time a fixed slot genuinely clears both real
    // rules) — the two tests below pin the boundary where that stops being
    // true and the function correctly rolls to tomorrow instead.
    expect(civilDateFromDate(assigned!.tourDate)).toBe(TODAY_CIVIL_DATE);

    const unassigned = await bookingByEmail('demo.transfer.unassigned@example.test');
    expect(unassigned?.status).toBe('confirmed');
    expect(unassigned?.vanId).toBeNull();
    expect(unassigned?.amountPaidCentavos).toBeGreaterThan(0);
    expect(civilDateFromDate(unassigned!.tourDate)).toBe(TODAY_CIVIL_DATE);

    const held = await bookingByEmail('demo.transfer.flight@example.test');
    expect(held?.status).toBe('pending_payment');
    expect(held?.amountPaidCentavos).toBe(0);
    const [heldDetails] = await getDb()
      .select()
      .from(bookingTransferDetails)
      .where(eq(bookingTransferDetails.bookingId, held!.id));
    expect(heldDetails?.flightNumber).toBe('PR1831');

    const dayUse = await bookingByEmail('demo.transfer.dayuse@example.test');
    expect(dayUse?.status).toBe('confirmed');
    expect(dayUse?.productType).toBe('transfer_day_use');
    const [dayUseDetails] = await getDb()
      .select()
      .from(bookingTransferDetails)
      .where(eq(bookingTransferDetails.bookingId, dayUse!.id));
    expect(dayUseDetails?.dayUseEndTime).toBe('18:00');

    const [inquiryRow] = await getDb()
      .select()
      .from(inquiries)
      .where(eq(inquiries.email, SEED_DEMO_TRIP_REQUEST.email));
    expect(inquiryRow).toMatchObject({ type: 'transfer_custom', status: 'new' });
  });

  it('is idempotent: running it again creates zero additional bookings or inquiries', async () => {
    const before = await Promise.all(
      SEED_DEMO_TRANSFER_BOOKINGS.map((b: SeedDemoTransferBooking) => bookingByEmail(b.leadEmail)),
    );
    expect(before.every((b: Awaited<ReturnType<typeof bookingByEmail>>) => b !== null)).toBe(true);

    await upsertDemoTransferBookings(getDb(), TEST_RUN_NOW);
    await upsertDemoTripRequest(getDb());

    for (let i = 0; i < SEED_DEMO_TRANSFER_BOOKINGS.length; i += 1) {
      const after = await bookingByEmail(SEED_DEMO_TRANSFER_BOOKINGS[i]!.leadEmail);
      // Same row, not a second one: the re-run skip is keyed on email, and a
      // booking table has no other way to tell "the same demo item" apart
      // from "a new one with a coincidentally identical email" than the id.
      expect(after?.id).toBe(before[i]?.id);
    }

    const inquiryRows = await getDb()
      .select()
      .from(inquiries)
      .where(eq(inquiries.email, SEED_DEMO_TRIP_REQUEST.email));
    expect(inquiryRows).toHaveLength(1);
  });

  /**
   * The two boundary tests the owner asked for directly: `upsertDemoTransferBookings`
   * must behave correctly no matter what time of day it is run, which is
   * exactly the thing `now` being an explicit, overridable parameter
   * (rather than read from the clock inside the function) makes testable
   * without waiting for the real clock to reach either hour. Each deletes
   * and recreates the two `daysFromToday: 0` recipes first, so this test's
   * own call is not skipped by the idempotency check against whatever the
   * tests above already created.
   */
  it('rolls both today-recipes to tomorrow when run at 23:30 Manila — no fixed slot can clear 6h notice without crossing midnight', async () => {
    await deleteBookingAndDependents('demo.transfer.assigned@example.test');
    await deleteBookingAndDependents('demo.transfer.unassigned@example.test');

    const lateNow = manilaInstant(TODAY_CIVIL_DATE, '23:30');
    await upsertDemoTransferBookings(getDb(), lateNow);

    const tomorrow = addCivilDays(TODAY_CIVIL_DATE, 1);
    const assigned = await bookingByEmail('demo.transfer.assigned@example.test');
    expect(civilDateFromDate(assigned!.tourDate)).toBe(tomorrow);
    const unassigned = await bookingByEmail('demo.transfer.unassigned@example.test');
    expect(civilDateFromDate(unassigned!.tourDate)).toBe(tomorrow);

    // The earliest candidate — trivially safe a full day out — not a
    // leftover near-midnight value from the old push-forward mechanism.
    const [assignedDetails] = await getDb()
      .select()
      .from(bookingTransferDetails)
      .where(eq(bookingTransferDetails.bookingId, assigned!.id));
    expect(assignedDetails?.pickupTime).toBe('06:30');
  });

  it("creates today's two recipes at 14:00 when run at 06:00 Manila — the earliest fixed slot clearing 6h notice", async () => {
    await deleteBookingAndDependents('demo.transfer.assigned@example.test');
    await deleteBookingAndDependents('demo.transfer.unassigned@example.test');

    const earlyNow = manilaInstant(TODAY_CIVIL_DATE, '06:00');
    await upsertDemoTransferBookings(getDb(), earlyNow);

    const assigned = await bookingByEmail('demo.transfer.assigned@example.test');
    expect(civilDateFromDate(assigned!.tourDate)).toBe(TODAY_CIVIL_DATE);
    const [assignedDetails] = await getDb()
      .select()
      .from(bookingTransferDetails)
      .where(eq(bookingTransferDetails.bookingId, assigned!.id));
    expect(assignedDetails?.pickupTime).toBe('14:00');

    const unassigned = await bookingByEmail('demo.transfer.unassigned@example.test');
    expect(civilDateFromDate(unassigned!.tourDate)).toBe(TODAY_CIVIL_DATE);
    const [unassignedDetails] = await getDb()
      .select()
      .from(bookingTransferDetails)
      .where(eq(bookingTransferDetails.bookingId, unassigned!.id));
    expect(unassignedDetails?.pickupTime).toBe('14:00');
  });
});

describeWithDb('seedBase never creates a demo transfer booking or trip-request inquiry', () => {
  it('running seedBase("test") alone leaves every demo-transfer email and the trip-request email absent', async () => {
    // `seedBase` is insert-only and safe to call directly — the same call
    // `global-setup.ts` already makes for every test file in this suite.
    // If `upsertDemoTransferBookings`/`upsertDemoTripRequest` were ever
    // wired into `seedBase` by mistake, this is what would catch it: these
    // seven emails would exist in `rg_travel_test` even though this file's
    // own `describeWithDb` block above never ran (a fresh `it` has no
    // ordering guarantee relative to it, so this must hold independently).
    await seedBase('test');

    for (const booking of SEED_DEMO_TRANSFER_BOOKINGS) {
      const row = await bookingByEmail(booking.leadEmail);
      expect(row).toBeNull();
    }
    const [inquiryRow] = await getDb()
      .select({ id: inquiries.id })
      .from(inquiries)
      .where(eq(inquiries.email, SEED_DEMO_TRIP_REQUEST.email));
    expect(inquiryRow).toBeUndefined();
  });

  it('running the full seedDemo("test") also leaves every demo-transfer email and the trip-request email absent — the app-only gate actually gates', async () => {
    // The real risk this guards: `seedDemo`'s `if (context === 'app')`
    // block around `upsertDemoTransferBookings`/`upsertDemoTripRequest`
    // (db/seed.ts) silently dropped or inverted, which would start writing
    // demo transfer content into `rg_travel_test` on every test run —
    // content `capacity.test.ts` and this very suite's own isolation does
    // not expect. `seedDemo('test')` is already the exact call this
    // project's test suite runs for every other table (tours, packages,
    // reviews), so this is not a new risk, only a new assertion on an
    // existing, already-exercised call.
    await seedDemo('test');

    for (const booking of SEED_DEMO_TRANSFER_BOOKINGS) {
      const row = await bookingByEmail(booking.leadEmail);
      expect(row).toBeNull();
    }
    const [inquiryRow] = await getDb()
      .select({ id: inquiries.id })
      .from(inquiries)
      .where(eq(inquiries.email, SEED_DEMO_TRIP_REQUEST.email));
    expect(inquiryRow).toBeUndefined();
  });
});
