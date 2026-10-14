/**
 * Week 5 "Dispatch", Task 3: the availability module.
 *
 * `vansFreeOn()` / `driversFreeOn()` are the single source of truth for
 * "which van and which driver are free on this date" — every exclusion
 * rule from §9 "Calendar" is pinned here and nowhere else, because a rule
 * that drifts between two places produces one van sent to two trips on the
 * same morning.
 *
 * **Fixtures are COMMITTED and cleaned up per test**, exactly as in
 * `capacity.test.ts` and for the same two reasons: `vans` and `drivers` are
 * not scoped to a date (every test here depends on the fleet being exactly
 * what it built), and a rolled-back fixture is invisible to a second
 * connection — not needed here, but keeping the same discipline means a
 * leftover row from an interrupted run is caught by the `beforeEach` sanity
 * check instead of silently changing every count in this file.
 *
 * Each `it()` creates exactly the fixtures it needs, inline, and
 * `afterEach(cleanup)` tears them down — so no test depends on another
 * test's leftover state, and the status-agreement test's "one van, one
 * date, no other bookings" premise is actually true every time it runs.
 */
import { afterEach, beforeEach, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import type { BookingStatus, PriceSnapshot } from '@rg/shared';
import { getDb, getPool } from '../db/client';
import {
  VAN_STATUSES,
  bookings,
  destinations,
  driverLeaves,
  drivers,
  tours,
  vans,
} from '../db/schema';
import { generateBookingRef } from '../services/booking-ref';
import { assessCapacity } from '../services/capacity';
import { driversFreeOn, vansFreeOn } from '../services/dispatch/availability';
import { describeWithDb } from './helpers/db';

/** The tour day every test uses, far enough out that no seed or fixture owns it. */
const DATE = '2099-10-20';

/** Every id this file committed, so teardown removes exactly those rows. */
const created = {
  bookingIds: [] as number[],
  tourIds: [] as number[],
  destinationIds: [] as number[],
  vanIds: [] as number[],
  driverIds: [] as number[],
  leaveIds: [] as number[],
};

/** Random first, timestamp second — see capacity.test.ts for why. */
const unique = () => `${Math.floor(Math.random() * 1e9)}_${Date.now()}`;

async function count(statement: Parameters<ReturnType<typeof getDb>['execute']>[0]) {
  const [rows] = (await getDb().execute(statement)) as unknown as [Array<{ n: number }>, unknown];
  return Number(rows[0]?.n ?? -1);
}

/** A tour, plus the destination its foreign key needs. */
async function makeTour(opts: { groupsPerDay?: number } = {}) {
  const db = getDb();
  const slug = `__avail__${unique()}`;
  const [destination] = await db.insert(destinations).values({ name: slug, slug });
  created.destinationIds.push(destination.insertId);
  const [tour] = await db.insert(tours).values({
    slug,
    title: slug,
    destinationId: destination.insertId,
    groupsPerDay: opts.groupsPerDay ?? 2,
    isActive: true,
  });
  created.tourIds.push(tour.insertId);
  return tour.insertId;
}

async function makeVan(
  opts: { capacity?: number; status?: (typeof VAN_STATUSES)[number]; isActive?: boolean } = {},
) {
  const suffix = unique();
  const [van] = await getDb()
    .insert(vans)
    .values({
      plate: `AVL${suffix}`.slice(0, 20),
      model: 'Availability Fixture Van',
      capacity: opts.capacity ?? 12,
      status: opts.status ?? 'available',
      isActive: opts.isActive ?? true,
    });
  created.vanIds.push(van.insertId);
  return van.insertId;
}

async function makeDriver(opts: { isActive?: boolean; name?: string } = {}) {
  const suffix = unique();
  const [driver] = await getDb()
    .insert(drivers)
    .values({
      name: opts.name ?? `Availability Fixture Driver ${suffix}`,
      code: `AVL${suffix}`.slice(0, 20),
      phone: '09170000000',
      // Not a real hash and not a real PIN: nothing here logs in.
      pinHash: '__availability_not_a_pin_hash__',
      isActive: opts.isActive ?? true,
    });
  created.driverIds.push(driver.insertId);
  return driver.insertId;
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

/**
 * A committed booking on a tour/date. `tourDate` goes in as a `Date` at UTC
 * midnight — the way Drizzle's `date` column wants it — while the module
 * under test compares civil-date STRINGS.
 */
async function makeBooking(opts: {
  tourId: number;
  date: string;
  pax?: number;
  status?: BookingStatus;
  vanId?: number;
  driverId?: number;
}) {
  const [booking] = await getDb()
    .insert(bookings)
    .values({
      ref: generateBookingRef(),
      tourId: opts.tourId,
      tourDate: new Date(`${opts.date}T00:00:00Z`),
      pax: opts.pax ?? 2,
      leadName: 'Availability Fixture',
      leadEmail: 'fixture@example.test',
      leadPhone: '09170000000',
      status: opts.status ?? 'pending_payment',
      payMode: 'full',
      priceSnapshot: SNAPSHOT,
      subtotalCentavos: 100000,
      totalCentavos: 100000,
      vanId: opts.vanId ?? null,
      driverId: opts.driverId ?? null,
    });
  created.bookingIds.push(booking.insertId);
  return booking.insertId;
}

describeWithDb('vans', () => {
  beforeEach(async () => {
    // Every test here counts the WHOLE fleet, so a van or driver left
    // behind by another suite would change every result in this file.
    expect(await count(sql`SELECT COUNT(*) n FROM vans`), 'leftover vans in rg_travel_test').toBe(
      0,
    );
    expect(
      await count(sql`SELECT COUNT(*) n FROM drivers`),
      'leftover drivers in rg_travel_test',
    ).toBe(0);
  });

  afterEach(async () => {
    const pool = getPool();
    for (const id of created.bookingIds) {
      await pool.query('DELETE FROM bookings WHERE id = ?', [id]);
    }
    for (const id of created.leaveIds) {
      await pool.query('DELETE FROM driver_leaves WHERE id = ?', [id]);
    }
    for (const id of created.tourIds) await pool.query('DELETE FROM tours WHERE id = ?', [id]);
    for (const id of created.destinationIds) {
      await pool.query('DELETE FROM destinations WHERE id = ?', [id]);
    }
    for (const id of created.driverIds) await pool.query('DELETE FROM drivers WHERE id = ?', [id]);
    for (const id of created.vanIds) await pool.query('DELETE FROM vans WHERE id = ?', [id]);
    created.bookingIds = [];
    created.leaveIds = [];
    created.tourIds = [];
    created.destinationIds = [];
    created.driverIds = [];
    created.vanIds = [];
  });

  it('excludes a van that is too small', async () => {
    await makeVan({ capacity: 5 });
    const db = getDb();
    const free = await db.transaction((tx) => vansFreeOn(tx, DATE, 99));
    expect(free).toEqual([]);
  });

  it('excludes a van already assigned to a capacity-holding booking that day', async () => {
    const tourId = await makeTour();
    const vanId = await makeVan({ capacity: 2 });
    const otherId = await makeBooking({ tourId, date: DATE });

    const db = getDb();
    const before = await db.transaction((tx) => vansFreeOn(tx, DATE, 2));
    expect(before.map((v) => v.id)).toContain(vanId);

    await db.update(bookings).set({ vanId, status: 'assigned' }).where(eq(bookings.id, otherId));

    const after = await db.transaction((tx) => vansFreeOn(tx, DATE, 2));
    expect(after.map((v) => v.id)).not.toContain(vanId);
  });

  it('does NOT exclude a van assigned to a booking that no longer holds capacity', async () => {
    // `cancelled`, `expired` and `completed` release the day. A cancelled
    // trip must give its van back, or one cancellation wastes a van forever.
    const tourId = await makeTour();
    const vanId = await makeVan({ capacity: 2 });
    const otherId = await makeBooking({ tourId, date: DATE, status: 'assigned', vanId });

    const db = getDb();
    await db.update(bookings).set({ vanId, status: 'cancelled' }).where(eq(bookings.id, otherId));
    const free = await db.transaction((tx) => vansFreeOn(tx, DATE, 2));
    expect(free.map((v) => v.id)).toContain(vanId);
  });

  it('does not exclude the booking being re-assigned from seeing its own van', async () => {
    const tourId = await makeTour();
    const vanId = await makeVan({ capacity: 2 });
    const mineId = await makeBooking({ tourId, date: DATE });

    const db = getDb();
    await db.update(bookings).set({ vanId, status: 'assigned' }).where(eq(bookings.id, mineId));
    const free = await db.transaction((tx) =>
      vansFreeOn(tx, DATE, 2, { excludeBookingId: mineId }),
    );
    expect(free.map((v) => v.id)).toContain(vanId);
  });

  it('excludes a driver on leave, inclusively at both ends', async () => {
    const driverId = await makeDriver();

    const db = getDb();
    const [leave] = await db.insert(driverLeaves).values({
      driverId,
      startDate: new Date(`${DATE}T00:00:00Z`),
      endDate: new Date(`${DATE}T00:00:00Z`),
    });
    created.leaveIds.push(leave.insertId);

    const free = await db.transaction((tx) => driversFreeOn(tx, DATE));
    expect(free.map((d) => d.id)).not.toContain(driverId);
  });

  /**
   * THE STATUS-AGREEMENT TEST — the owner's second named Q1 test, moved here
   * from Task 2 because it needs both modules (controller ruling).
   *
   * Capacity COUNTS and availability IDENTIFIES, so they answer different
   * questions — but they must never disagree about whether a van's status
   * makes it usable at all. One van, one date, no other bookings: the only
   * condition under which the two answers must be identical, which is why
   * this test builds its own isolated tour/van/driver rather than reusing
   * any fixture another test in this file created.
   */
  it.each([...VAN_STATUSES])('capacity and dispatch agree about a %s van', async (status) => {
    const tourId = await makeTour();
    const onlyVanId = await makeVan({ capacity: 2 });
    await makeDriver();

    const db = getDb();
    await db.update(vans).set({ status }).where(eq(vans.id, onlyVanId));
    const [verdict, free] = await db.transaction(async (tx) => [
      await assessCapacity(tx, tourId, DATE, 2),
      await vansFreeOn(tx, DATE, 2),
    ]);
    expect(free.some((v) => v.id === onlyVanId)).toBe(verdict.ok);
  });

  /**
   * Both ordering tie-breaks below were flagged as UNPROVEN by the Task 3
   * review: the capacity test above uses three distinct capacities, so
   * `asc(vans.id)` never fires, and `driversFreeOn`'s `name, id` ordering
   * had no coverage at all. Neither is cosmetic — Task 11's auto-suggest
   * takes `[0]` from each list and owes a test that the same booking
   * suggests the same driver twice running. An unstable sort would make
   * that test flaky rather than failing, which is the worse outcome: a
   * flake gets re-run, a failure gets fixed.
   */
  it('breaks a van capacity tie by id, so the order is deterministic', async () => {
    // Same capacity on purpose. Inserted largest-id-first would still come
    // back id-ascending if the tie-break is doing its job.
    const firstId = await makeVan({ capacity: 8 });
    const secondId = await makeVan({ capacity: 8 });
    const thirdId = await makeVan({ capacity: 8 });

    const db = getDb();
    const free = await db.transaction((tx) => vansFreeOn(tx, DATE, 1));
    const ids = free.filter((v) => v.capacity === 8).map((v) => v.id);
    expect(ids).toEqual([firstId, secondId, thirdId]);
  });

  it('orders free drivers by name, then id', async () => {
    const zeldaId = await makeDriver({ name: 'Zelda Zulueta' });
    const arturoId = await makeDriver({ name: 'Arturo Abella' });
    const mariaId = await makeDriver({ name: 'Maria Medina' });

    const db = getDb();
    const free = await db.transaction((tx) => driversFreeOn(tx, DATE));
    const mine = free.filter((d) => [zeldaId, arturoId, mariaId].includes(d.id));
    // Vacuity guard: an empty `mine` would satisfy any ordering assertion.
    expect(mine).toHaveLength(3);
    expect(mine.map((d) => d.name)).toEqual(['Arturo Abella', 'Maria Medina', 'Zelda Zulueta']);
  });

  it('orders vans smallest first so auto-suggest can take [0]', async () => {
    await makeVan({ capacity: 15 });
    await makeVan({ capacity: 4 });
    await makeVan({ capacity: 9 });

    const db = getDb();
    const free = await db.transaction((tx) => vansFreeOn(tx, DATE, 1));
    const caps = free.map((v) => v.capacity);
    expect(caps).toEqual([...caps].sort((a, b) => a - b));
  });

  /**
   * THE AGREEMENT TEST. If checkout accepted a booking, dispatch must be
   * able to fulfil it — a business that sells a trip it cannot run has a
   * worse problem than a failed request. The reverse is NOT asserted:
   * `vansFreeOn` is allowed to be more generous than `assessCapacity`'s
   * arithmetic, because capacity deducts every capacity-holding booking
   * from the fleet whether or not it has a van yet.
   */
  it('can always assign a van and a driver to a booking capacity accepted', async () => {
    const tourId = await makeTour({ groupsPerDay: 1 });
    await makeVan({ capacity: 4 });
    await makeDriver();

    const db = getDb();
    const verdict = await db.transaction((tx) => assessCapacity(tx, tourId, DATE, 4));
    expect(verdict).toEqual({ ok: true });

    const [freeVans, freeDrivers] = await db.transaction(async (tx) => [
      await vansFreeOn(tx, DATE, 4),
      await driversFreeOn(tx, DATE),
    ]);
    expect(freeVans.length).toBeGreaterThan(0);
    expect(freeDrivers.length).toBeGreaterThan(0);
  });
});
