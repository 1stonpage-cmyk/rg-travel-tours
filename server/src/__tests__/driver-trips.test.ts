/**
 * Week 6 plan, Task 2 — `driver.trips`, the first thing a signed-in driver
 * sees (BUILD_SPEC §8).
 *
 * Three properties, and only the first is a feature:
 *
 *  1. **The list is bucketed by the MANILA civil date.** `driverTripBucket`
 *     is pure and lives in `@rg/shared`, so the tabs and the server cannot
 *     disagree about which day it is. A driver standing beside a van at
 *     00:30 Manila is on today's trips; a UTC-based bucket would put them
 *     on yesterday's for the whole 00:00-07:59 window.
 *  2. **A driver sees only their own trips, and the filter comes only from
 *     the session.** `ctx.driver.driverId`, never an input and never a URL
 *     parameter. Both directions are asserted — their own trips ARE there,
 *     another driver's are NOT — because a query that never filters at all
 *     passes the first half on its own.
 *  3. **A staff session and a customer session are refused the procedure
 *     entirely**, by the gate rather than by the label. A day sheet carries
 *     other guests' names and phone numbers (RA 10173).
 *
 * The mid-trip reassignment test is the Week 5 carry-forward (owner
 * decision 2026-10-14, Q3): `admin.dispatch.assign` can move a trip between
 * drivers while it is running, and this is the half that makes the move
 * visible. **Both directions**, for the same reason as (2).
 *
 * Fixtures are COMMITTED and rebuilt per test, exactly as
 * `dispatch-assign.test.ts` does: the reassignment test MOVES one of them,
 * so a file-level fixture would make every test above it depend on
 * declaration order. The test database keeps an EMPTY fleet
 * (`capacity.test.ts` counts the whole fleet), so every van and driver this
 * file creates is deleted again in `afterEach`.
 */
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { manilaCivilDate, type PriceSnapshot } from '@rg/shared';
import { appRouter } from '../routers/_app';
import { listDriverTrips } from '../routers/public/driver';
import { getDb, getPool } from '../db/client';
import { bookings, destinations, drivers, tours, users, vans } from '../db/schema';
import { generateBookingRef } from '../services/booking-ref';
import { customerContext, driverCaller, staffContext } from './helpers/ctx';
import { describeWithDb } from './helpers/db';

/** Civil-date arithmetic on a civil-date string: UTC-anchored, no zone shift. */
function plusDays(date: string, days: number): string {
  const at = new Date(`${date}T00:00:00Z`);
  at.setUTCDate(at.getUTCDate() + days);
  return at.toISOString().slice(0, 10);
}

/**
 * The real Manila today, because that is the bucket under test, and every
 * other date in this file is computed from it so the fixtures stay in the
 * right buckets whenever the suite is run.
 *
 * **Read in `beforeEach`, not at module load** (review finding, Task 2). The
 * resolver reads the clock per call, so a run that straddles Manila midnight
 * would compare fixtures built against yesterday's `TODAY` with a resolver
 * answering for today's — a flake in the one suite whose whole subject is
 * dates. Re-reading it per test keeps the two on the same day, and the
 * fixtures are rebuilt per test anyway.
 */
let TODAY = '';
let UPCOMING = '';
let PAST = '';
/** Driver B's own trip, on a date NOBODY else in this file uses — so B is
 *  free on `TODAY` when the reassignment test moves a trip to them. */
let THEIRS = '';
let ALL_DATES: string[] = [];

/** Random first, timestamp second — same discipline as capacity.test.ts. */
const unique = () => `${Math.floor(Math.random() * 1e9)}_${Date.now()}`;

/** Every id this file commits, so `afterEach` removes exactly those rows. */
const created = {
  bookingIds: [] as number[],
  tourIds: [] as number[],
  destIds: [] as number[],
  vanIds: [] as number[],
  driverIds: [] as number[],
  userIds: [] as number[],
};

async function count(statement: Parameters<ReturnType<typeof getDb>['execute']>[0]) {
  const [rows] = (await getDb().execute(statement)) as unknown as [Array<{ n: number }>, unknown];
  return Number(rows[0]?.n ?? -1);
}

async function makeTour(title: string) {
  const db = getDb();
  const slug = `__drvtrips__${unique()}`;
  const [destination] = await db.insert(destinations).values({ name: slug, slug });
  created.destIds.push(destination.insertId);
  const [tour] = await db
    .insert(tours)
    .values({ slug, title, destinationId: destination.insertId, isActive: true });
  created.tourIds.push(tour.insertId);
  return tour.insertId;
}

async function makeVan(plateSeed: string) {
  const [van] = await getDb()
    .insert(vans)
    .values({
      plate: `${plateSeed}${unique()}`.slice(0, 20),
      model: 'Driver Trips Fixture Van',
      capacity: 12,
      status: 'available',
      isActive: true,
    });
  created.vanIds.push(van.insertId);
  return van.insertId;
}

async function makeDriver(label: string) {
  const suffix = unique();
  const [driver] = await getDb()
    .insert(drivers)
    .values({
      name: `Driver Trips ${label} ${suffix}`,
      code: `DT${suffix}`.slice(0, 20),
      phone: '09170000000',
      // Not a real hash: nothing in this file logs in, it arrives with a
      // session already (which is what `driverCaller` is).
      pinHash: '__drvtrips_not_a_pin_hash__',
      isActive: true,
    });
  created.driverIds.push(driver.insertId);
  return driver.insertId;
}

async function makeStaff() {
  const suffix = unique();
  const [row] = await getDb()
    .insert(users)
    .values({
      name: `Driver Trips Owner ${suffix}`,
      email: `drvtrips_${suffix}@example.test`,
      passwordHash: '__drvtrips_not_a_hash__',
      role: 'owner',
      isActive: true,
    });
  created.userIds.push(row.insertId);
  return row.insertId;
}

/** The minimum snapshot `bookings.price_snapshot` will accept. No test reads it. */
const SNAPSHOT: PriceSnapshot = {
  tier: { tierId: 1, minPax: 1, maxPax: 12, pricePerPersonCentavos: 100000 },
  addons: [],
  coupon: null,
  depositPercent: 30,
  freeCancelHours: 48,
  subtotalCentavos: 100000,
  discountCentavos: 0,
  totalCentavos: 100000,
};

async function makeBooking(opts: {
  tourId: number;
  tourDate: string;
  driverId: number;
  vanId: number;
  pax?: number;
  status?: 'assigned' | 'completed';
}) {
  const ref = generateBookingRef();
  const [booking] = await getDb()
    .insert(bookings)
    .values({
      ref,
      tourId: opts.tourId,
      tourDate: new Date(`${opts.tourDate}T00:00:00Z`),
      pax: opts.pax ?? 2,
      leadName: 'Driver Trips Fixture',
      leadEmail: 'drvtrips@example.test',
      leadPhone: '09170000000',
      status: opts.status ?? 'assigned',
      payMode: 'full',
      priceSnapshot: SNAPSHOT,
      subtotalCentavos: 100000,
      totalCentavos: 100000,
      vanId: opts.vanId,
      driverId: opts.driverId,
    });
  created.bookingIds.push(booking.insertId);
  return { id: booking.insertId, ref };
}

/*
 * `driverTripBucket` itself — pure, no database — is tested in the package
 * that owns it: `shared/src/driver.test.ts` (review finding, Task 2). A
 * pure `/shared` function whose only test lived here was not covered by
 * `pnpm --filter @rg/shared test` at all. What stays below is the SERVER's
 * half: which Manila civil date this server picks to bucket against.
 */

/* ------------------------------------------------------------------ *
 * `driver.trips` — the mounted procedure, through the real router.
 * ------------------------------------------------------------------ */

let ownerId = 0;
let driverA = 0;
let driverB = 0;
let vanId = 0;
let tourId = 0;
let todayBookingId = 0;
let theirBookingId = 0;
let someBookingId = 0;
let todayRef = '';
let upcomingRef = '';
let pastRef = '';
let tourTitle = '';

describeWithDb('driver.trips', () => {
  beforeAll(async () => {
    ownerId = await makeStaff();
  }, 30_000);

  afterAll(async () => {
    const pool = getPool();
    for (const id of created.userIds) {
      await pool.query('DELETE FROM sessions WHERE subject_type = ? AND subject_id = ?', [
        'user',
        id,
      ]);
      await pool.query('DELETE FROM users WHERE id = ?', [id]);
    }
    created.userIds = [];
  });

  beforeEach(async () => {
    // Per test, for the reason the declarations give: the resolver reads
    // the clock per call, and these fixtures must be built against the same
    // Manila day it will answer for.
    TODAY = manilaCivilDate(new Date());
    UPCOMING = plusDays(TODAY, 5);
    PAST = plusDays(TODAY, -5);
    THEIRS = plusDays(TODAY, 9);
    ALL_DATES = [TODAY, UPCOMING, PAST, THEIRS];

    // Same sanity check `dispatch-assign.test.ts` opens with: a van or
    // driver left behind by another suite would change what this file's
    // availability re-check (the reassignment test) sees.
    expect(await count(sql`SELECT COUNT(*) n FROM vans`), 'leftover vans in rg_travel_test').toBe(
      0,
    );
    expect(
      await count(sql`SELECT COUNT(*) n FROM drivers`),
      'leftover drivers in rg_travel_test',
    ).toBe(0);

    tourTitle = `Driver Trips Tour ${unique()}`;
    tourId = await makeTour(tourTitle);
    vanId = await makeVan('DTA');
    driverA = await makeDriver('A');
    driverB = await makeDriver('B');

    const today = await makeBooking({ tourId, tourDate: TODAY, driverId: driverA, vanId });
    const upcoming = await makeBooking({ tourId, tourDate: UPCOMING, driverId: driverA, vanId });
    const past = await makeBooking({
      tourId,
      tourDate: PAST,
      driverId: driverA,
      vanId,
      status: 'completed',
    });
    const theirs = await makeBooking({ tourId, tourDate: THEIRS, driverId: driverB, vanId });

    todayBookingId = today.id;
    todayRef = today.ref;
    upcomingRef = upcoming.ref;
    pastRef = past.ref;
    theirBookingId = theirs.id;
    someBookingId = theirs.id;
  }, 30_000);

  afterEach(async () => {
    const pool = getPool();
    for (const id of created.bookingIds) {
      await pool.query('DELETE FROM bookings WHERE id = ?', [id]);
    }
    /*
     * The reassignment test reaches `takeSlotLocks`, which leaves a
     * `tour_date_slots` row keyed by this test's own `tour_id` — and
     * `tours` cannot be deleted while one still references it. Same
     * discipline `dispatch-assign.test.ts` uses, and for the same FK.
     * `fleet_date_slots` is keyed only by date, so it is swept by date.
     */
    for (const id of created.tourIds) {
      await pool.query('DELETE FROM tour_date_slots WHERE tour_id = ?', [id]);
    }
    for (const date of ALL_DATES) {
      await pool.query('DELETE FROM fleet_date_slots WHERE date = ?', [date]);
    }
    for (const id of created.tourIds) await pool.query('DELETE FROM tours WHERE id = ?', [id]);
    for (const id of created.destIds) {
      await pool.query('DELETE FROM destinations WHERE id = ?', [id]);
    }
    for (const id of created.driverIds) await pool.query('DELETE FROM drivers WHERE id = ?', [id]);
    for (const id of created.vanIds) await pool.query('DELETE FROM vans WHERE id = ?', [id]);
    created.bookingIds = [];
    created.tourIds = [];
    created.destIds = [];
    created.driverIds = [];
    created.vanIds = [];
  });

  it('shows this driver their own trips, bucketed', async () => {
    const api = driverCaller(driverA);
    const trips = await api.driver.trips();
    expect(trips.map((t) => t.ref).sort()).toEqual([todayRef, upcomingRef, pastRef].sort());
    expect(trips.find((t) => t.ref === todayRef)!.bucket).toBe('today');
    expect(trips.find((t) => t.ref === upcomingRef)!.bucket).toBe('upcoming');
    expect(trips.find((t) => t.ref === pastRef)!.bucket).toBe('history');
  });

  it('carries the tour title, the van plate and the trip date, in date order', async () => {
    const trips = await driverCaller(driverA).driver.trips();
    const [plate] = await getDb()
      .select({ plate: vans.plate })
      .from(vans)
      .where(sql`${vans.id} = ${vanId}`);

    expect(trips.map((t) => t.tourDate)).toEqual([PAST, TODAY, UPCOMING]);
    expect(trips.map((t) => t.tourTitle)).toEqual([tourTitle, tourTitle, tourTitle]);
    expect(trips.map((t) => t.vanPlate)).toEqual([plate!.plate, plate!.plate, plate!.plate]);
    expect(trips.find((t) => t.ref === pastRef)!.status).toBe('completed');
    expect(trips.find((t) => t.ref === todayRef)!.pax).toBe(2);
  });

  /**
   * The server half of the Manila rule, at the boundary — the half the pure
   * test above cannot reach, because the pure function is handed a civil
   * date and the question here is which civil date the SERVER picks.
   *
   * `listDriverTrips` takes `now` explicitly (CLAUDE.md: "Time-dependent
   * queries take an explicit `now`") precisely so this can be asserted
   * either side of 16:00 UTC without faking the clock for the whole
   * process. Replace `manilaCivilDate(now)` in that function with
   * `now.toISOString().slice(0, 10)` and this test fails; nothing else in
   * the suite would.
   */
  it('takes today from the explicit now, read in MANILA, either side of 16:00 UTC', async () => {
    const boundaryTrip = await makeBooking({
      tourId,
      tourDate: '2026-11-11',
      driverId: driverA,
      vanId,
    });
    const bucketAt = async (now: string) => {
      const rows = await listDriverTrips(driverA, new Date(now));
      return rows.find((t) => t.bookingId === boundaryTrip.id)!.bucket;
    };

    // 16:30 UTC on the 10th IS 00:30 on the 11th in Manila: the driver is
    // standing next to the van, and this is today's trip.
    expect(await bucketAt('2026-11-10T16:30:00Z')).toBe('today');
    // 15:59 UTC is still the 10th there, so the same trip is upcoming.
    expect(await bucketAt('2026-11-10T15:59:00Z')).toBe('upcoming');
    // 16:30 UTC on the 11th is already the 12th in Manila — history.
    expect(await bucketAt('2026-11-11T16:30:00Z')).toBe('history');
  });

  it('NEVER shows one driver another driver trips', async () => {
    const mine = await driverCaller(driverA).driver.trips();
    expect(mine.map((t) => t.bookingId)).not.toContain(theirBookingId);
  });

  it('refuses a STAFF session the driver procedures', async () => {
    const api = appRouter.createCaller(staffContext(ownerId, 'owner') as never);
    await expect(api.driver.trips()).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  });

  it('refuses a CUSTOMER session the driver procedures', async () => {
    const api = appRouter.createCaller(customerContext(someBookingId) as never);
    await expect(api.driver.trips()).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  });

  it('refuses a caller with no session at all', async () => {
    const api = appRouter.createCaller({ session: null } as never);
    await expect(api.driver.trips()).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  });

  it('shows a trip reassigned TO this driver mid-trip, and hides one taken away', async () => {
    // Owner Q3 carry-forward from Week 5: the swap exists; this is the half
    // that makes it visible. Both directions, because only testing the
    // gaining driver would pass with a query that never filters at all.
    const api = appRouter.createCaller(staffContext(ownerId, 'owner') as never);
    await api.admin.dispatch.assign({
      bookingId: todayBookingId,
      vanId,
      driverId: driverB,
      reason: 'Reassignment test: swapped mid-trip.',
    });
    expect((await driverCaller(driverB).driver.trips()).map((t) => t.bookingId)).toContain(
      todayBookingId,
    );
    expect((await driverCaller(driverA).driver.trips()).map((t) => t.bookingId)).not.toContain(
      todayBookingId,
    );
  }, 30_000);
});
