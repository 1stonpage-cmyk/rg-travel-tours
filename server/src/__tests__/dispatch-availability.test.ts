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
import { readTransferOperationsSettings } from '../content/settings';
import { getDb, getPool } from '../db/client';
import {
  VAN_STATUSES,
  bookingTransferDetails,
  bookings,
  destinations,
  driverLeaves,
  drivers,
  tours,
  transferPlaces,
  transferRoutes,
  vans,
  vehicleTypes,
} from '../db/schema';
import { generateBookingRef } from '../services/booking-ref';
import { assessCapacity } from '../services/capacity';
import { driversFreeOn, vansFreeOn } from '../services/dispatch/availability';
import type { TransferProductType } from '../services/transfers/capacity';
import { describeWithDb } from './helpers/db';

/** The tour day every test uses, far enough out that no seed or fixture owns it. */
const DATE = '2099-10-20';

/* ----- Task T8 (transfers-launch plan, Architecture §2/§2a) ----- */

/** The seeded `transfer_operations` values, asserted in `beforeEach`. */
const BUFFER = 60;
const DEFAULT_DRIVER_CAP = 2;
/** The one-way route duration every transfer fixture here shares. */
const DURATION = 120;

/** Minutes since midnight, so the cases read as times. */
const at = (hours: number, minutes = 0) => hours * 60 + minutes;
/** Minutes back to the `"HH:mm"` civil label the column stores. */
const hhmm = (minutes: number) =>
  `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
/** A candidate window, the shape `vansFreeOn`/`driversFreeOn` take. */
const window = (startMinutes: number, endMinutes: number) => ({ startMinutes, endMinutes });

/** Every id this file committed, so teardown removes exactly those rows. */
const created = {
  bookingIds: [] as number[],
  tourIds: [] as number[],
  routeIds: [] as number[],
  destinationIds: [] as number[],
  placeIds: [] as number[],
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

/**
 * The real, global `vehicle_types.id` for `'van'`/`'suv'` — seeded by
 * `seedBase` (migration 0023), never a literal id (CLAUDE.md). Resolved
 * fresh in `beforeEach` into `VAN_ID`/`SUV_ID`, below.
 */
let VAN_ID: number;
let SUV_ID: number;

async function vehicleTypeIdBySlug(slug: string): Promise<number> {
  const [row] = await getDb()
    .select({ id: vehicleTypes.id })
    .from(vehicleTypes)
    .where(eq(vehicleTypes.slug, slug))
    .limit(1);
  if (!row) throw new Error(`No vehicle_types row for slug "${slug}" — expected from seedBase.`);
  return row.id;
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
  opts: {
    capacity?: number;
    status?: (typeof VAN_STATUSES)[number];
    isActive?: boolean;
    vehicleTypeId?: number;
  } = {},
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
      vehicleTypeId: opts.vehicleTypeId ?? VAN_ID,
    });
  created.vanIds.push(van.insertId);
  return van.insertId;
}

/** `maxTransferJobsPerDay: undefined` leaves the column NULL — "use the default". */
async function makeDriver(
  opts: { isActive?: boolean; name?: string; maxTransferJobsPerDay?: number } = {},
) {
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
      maxTransferJobsPerDay: opts.maxTransferJobsPerDay ?? null,
    });
  created.driverIds.push(driver.insertId);
  return driver.insertId;
}

/** An admin-managed pickup/drop-off place — a route's `from`/`to` endpoint. */
async function makePlace() {
  const db = getDb();
  const slug = `__avail__${unique()}`;
  const [place] = await db
    .insert(transferPlaces)
    .values({ name: slug, nameKey: slug.toLowerCase() });
  created.placeIds.push(place.insertId);
  return place.insertId;
}

/** A transfer route, plus the two places its `from`/`to` foreign keys need. */
async function makeRoute() {
  const db = getDb();
  const fromPlaceId = await makePlace();
  const toPlaceId = await makePlace();
  const slug = `__avail__${unique()}`;
  const [route] = await db
    .insert(transferRoutes)
    .values({ fromPlaceId, toPlaceId, slug, estimatedDurationMinutes: DURATION });
  created.routeIds.push(route.insertId);
  return route.insertId;
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

/**
 * A committed TRANSFER booking and its `booking_transfer_details` row, already
 * ASSIGNED to a van and/or a driver — which is what makes it this file's
 * business rather than `transfer-capacity.test.ts`'s. That file asks the pool
 * question at hold time, where nothing is assigned yet; these ask the
 * dispatch-time one about a specific vehicle and a specific human.
 *
 * Written by hand, in one transaction, exactly as `transfer-capacity.test.ts`
 * does and for the same reason: `createTransferBooking()` is Task T10 and does
 * not exist yet. Both frozen values (`buffer_minutes_used`,
 * `route_duration_minutes_used`) are stored, because the module under test
 * recomputes the window from those and never from the catalog route.
 */
async function makeTransferBooking(opts: {
  routeId: number;
  pickupMinutes: number;
  dayUseEndMinutes?: number;
  productType?: TransferProductType;
  vehicleTypeId?: number;
  date?: string;
  status?: BookingStatus;
  vanId?: number;
  driverId?: number;
  bufferMinutes?: number;
}) {
  const productType = opts.productType ?? 'transfer_one_way';
  const id = await getDb().transaction(async (tx) => {
    const [booking] = await tx.insert(bookings).values({
      ref: generateBookingRef(),
      tourId: null,
      productType,
      routeId: opts.routeId,
      vehicleTypeId: opts.vehicleTypeId ?? VAN_ID,
      tourDate: new Date(`${opts.date ?? DATE}T00:00:00Z`),
      pax: 2,
      leadName: 'Availability Transfer Fixture',
      leadEmail: 'fixture@example.test',
      leadPhone: '09170000000',
      status: opts.status ?? 'assigned',
      payMode: 'full',
      priceSnapshot: SNAPSHOT,
      subtotalCentavos: 100000,
      totalCentavos: 100000,
      vanId: opts.vanId ?? null,
      driverId: opts.driverId ?? null,
    });
    await tx.insert(bookingTransferDetails).values({
      bookingId: booking.insertId,
      pickupTime: hhmm(opts.pickupMinutes),
      dayUseEndTime: opts.dayUseEndMinutes === undefined ? null : hhmm(opts.dayUseEndMinutes),
      dropoffAddress: 'Fixture drop-off',
      bufferMinutesUsed: opts.bufferMinutes ?? BUFFER,
      routeDurationMinutesUsed: productType === 'transfer_day_use' ? null : DURATION,
    });
    return booking.insertId;
  });
  created.bookingIds.push(id);
  return id;
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

    /*
     * Task T8's driver-cap and window expectations are arithmetic over these
     * two seeded values, so a change to the owner's defaults must fail HERE,
     * by name, rather than as a handful of unexplained exclusions below.
     */
    const operations = await readTransferOperationsSettings();
    expect(operations.bufferMinutes, 'the seeded buffer changed').toBe(BUFFER);
    expect(operations.maxTransferJobsPerDriverPerDay, 'the seeded driver cap changed').toBe(
      DEFAULT_DRIVER_CAP,
    );

    VAN_ID = await vehicleTypeIdBySlug('van');
    SUV_ID = await vehicleTypeIdBySlug('suv');
  });

  afterEach(async () => {
    const pool = getPool();
    for (const id of created.bookingIds) {
      // The details row FIRST: it references the booking, so the delete below
      // would otherwise die on the foreign key.
      await pool.query('DELETE FROM booking_transfer_details WHERE booking_id = ?', [id]);
      await pool.query('DELETE FROM bookings WHERE id = ?', [id]);
    }
    for (const id of created.leaveIds) {
      await pool.query('DELETE FROM driver_leaves WHERE id = ?', [id]);
    }
    for (const id of created.tourIds) await pool.query('DELETE FROM tours WHERE id = ?', [id]);
    // Before the places/destinations they reference.
    for (const id of created.routeIds) {
      await pool.query('DELETE FROM transfer_routes WHERE id = ?', [id]);
    }
    for (const id of created.placeIds) {
      await pool.query('DELETE FROM transfer_places WHERE id = ?', [id]);
    }
    for (const id of created.destinationIds) {
      await pool.query('DELETE FROM destinations WHERE id = ?', [id]);
    }
    for (const id of created.driverIds) await pool.query('DELETE FROM drivers WHERE id = ?', [id]);
    for (const id of created.vanIds) await pool.query('DELETE FROM vans WHERE id = ?', [id]);
    created.bookingIds = [];
    created.leaveIds = [];
    created.tourIds = [];
    created.placeIds = [];
    created.routeIds = [];
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

  /* ======================================================================= *
   * Task T8 — TRANSFER dispatch: windows for vehicles, windows AND a daily
   * job count for drivers (transfers-launch plan, Architecture §2 and §2a).
   *
   * Every test below passes `transferWindow`, which is what selects the
   * window-aware branch; the two that deliberately do NOT pass it are
   * asserting that the whole-day branch is unchanged. `minCapacity: 0` goes
   * with `vehicleType` on every transfer call, because the TYPE is the fit
   * for a transfer and the seat count is not consulted.
   * ======================================================================= */

  /** Pickup 08:00 + 120 duration + 60 buffer = `[08:00, 11:00)`. */
  const MORNING_PICKUP = at(8);

  it('excludes a van holding a TOUR for the whole day, however narrow the transfer window', async () => {
    // A tour takes the van all day. A 20-minute airport run at 05:00 cannot
    // be squeezed around it, because nothing says when the tour is.
    const tourId = await makeTour();
    const vanId = await makeVan({ vehicleTypeId: VAN_ID });
    const tourBooking = await makeBooking({ tourId, date: DATE });
    await getDb()
      .update(bookings)
      .set({ vanId, status: 'assigned' })
      .where(eq(bookings.id, tourBooking));

    const free = await getDb().transaction((tx) =>
      vansFreeOn(tx, DATE, 0, {
        vehicleTypeId: VAN_ID,
        transferWindow: window(at(5), at(5, 20)),
      }),
    );
    expect(free.map((v) => v.id)).not.toContain(vanId);
  });

  it('excludes a van holding even a NON-overlapping transfer from a TOUR assignment', async () => {
    /*
     * Re-derived rather than assumed: the no-`transferWindow` branch is one
     * `NOT EXISTS` with NO product-type filter, so ANY assigned
     * capacity-holding booking excludes the van — and that is right, not an
     * oversight. A tour needs the whole day; a van with a 2pm transfer on it
     * cannot also run a day tour, even though the two windows do not touch.
     */
    const routeId = await makeRoute();
    const vanId = await makeVan({ vehicleTypeId: VAN_ID });
    await makeTransferBooking({ routeId, pickupMinutes: at(14), vanId });

    const free = await getDb().transaction((tx) => vansFreeOn(tx, DATE, 2));
    expect(free.map((v) => v.id)).not.toContain(vanId);
  });

  it('keeps a van free for a transfer whose window does NOT overlap the one it holds', async () => {
    // This is the owner's "several jobs a day". [08:00, 11:00) then
    // [11:00, 14:00): half-open, so the touching pair is one van's work.
    const routeId = await makeRoute();
    const vanId = await makeVan({ vehicleTypeId: VAN_ID });
    await makeTransferBooking({ routeId, pickupMinutes: MORNING_PICKUP, vanId });

    const free = await getDb().transaction((tx) =>
      vansFreeOn(tx, DATE, 0, { vehicleTypeId: VAN_ID, transferWindow: window(at(11), at(14)) }),
    );
    expect(free.map((v) => v.id)).toContain(vanId);
  });

  it('excludes a van whose held transfer window overlaps — and the BUFFER is what overlaps', async () => {
    /*
     * The held job's vehicle is physically back at 10:00 (08:00 + 120); the
     * 60-minute buffer is what carries its window to 11:00. A candidate at
     * 10:30 therefore clashes ONLY because the buffer is counted — so this
     * test reddens if the stored `buffer_minutes_used` is ever dropped from
     * the window, which a same-hour overlap test would not notice.
     */
    const routeId = await makeRoute();
    const vanId = await makeVan({ vehicleTypeId: VAN_ID });
    await makeTransferBooking({ routeId, pickupMinutes: MORNING_PICKUP, vanId });

    const free = await getDb().transaction((tx) =>
      vansFreeOn(tx, DATE, 0, {
        vehicleTypeId: VAN_ID,
        transferWindow: window(at(10, 30), at(12)),
      }),
    );
    expect(free.map((v) => v.id)).not.toContain(vanId);
  });

  it('offers only vans of the requested vehicle type', async () => {
    const vanId = await makeVan({ vehicleTypeId: VAN_ID });
    const suvId = await makeVan({ vehicleTypeId: SUV_ID });

    const free = await getDb().transaction((tx) =>
      vansFreeOn(tx, DATE, 0, {
        vehicleTypeId: SUV_ID,
        transferWindow: window(MORNING_PICKUP, at(11)),
      }),
    );
    const ids = free.map((v) => v.id);
    expect(ids).toContain(suvId);
    // Otherwise free — nothing is assigned to it at all — and still refused.
    expect(ids).not.toContain(vanId);
  });

  /**
   * **`vehicleType` is TRANSFER-only (dedicated review finding, T8).** Passing
   * it WITHOUT `transferWindow` must have no effect at all — a TOUR can use
   * either vehicle type, and nothing in this codebase has a reason to call
   * `vansFreeOn` that way today, but the TYPE makes it legal, so it is pinned
   * here rather than left to never be exercised.
   */
  it('ignores vehicleType entirely when transferWindow is absent — the TOUR shape', async () => {
    const vanId = await makeVan({ vehicleTypeId: VAN_ID });
    const suvId = await makeVan({ vehicleTypeId: SUV_ID });

    const free = await getDb().transaction((tx) =>
      vansFreeOn(tx, DATE, 0, { vehicleTypeId: SUV_ID }),
    );
    const ids = free.map((v) => v.id);
    // Both vans free — `vehicleTypeId: SUV_ID` did NOT narrow the pool to SUVs.
    expect(ids).toContain(vanId);
    expect(ids).toContain(suvId);
  });

  it('does not exclude the transfer being re-assigned from seeing its own van', async () => {
    // The fully-overlapping case on purpose: the same window, so only
    // `excludeBookingId` can keep this van in the answer.
    const routeId = await makeRoute();
    const vanId = await makeVan({ vehicleTypeId: VAN_ID });
    const mineId = await makeTransferBooking({ routeId, pickupMinutes: MORNING_PICKUP, vanId });

    const free = await getDb().transaction((tx) =>
      vansFreeOn(tx, DATE, 0, {
        vehicleTypeId: VAN_ID,
        transferWindow: window(MORNING_PICKUP, at(11)),
        excludeBookingId: mineId,
      }),
    );
    expect(free.map((v) => v.id)).toContain(vanId);
  });

  /* ---- drivers: the COUNT rule, which vehicles do not have ---- */

  it('excludes a driver already at their daily transfer-job cap, overlap or not', async () => {
    // Two jobs at the seeded default cap of 2, both nowhere near the
    // candidate: [06:00, 09:00) and [12:00, 15:00) against [18:00, 21:00).
    const routeId = await makeRoute();
    const driverId = await makeDriver();
    await makeTransferBooking({ routeId, pickupMinutes: at(6), driverId });
    await makeTransferBooking({ routeId, pickupMinutes: at(12), driverId });

    const free = await getDb().transaction((tx) =>
      driversFreeOn(tx, DATE, { transferWindow: window(at(18), at(21)) }),
    );
    expect(free.map((d) => d.id)).not.toContain(driverId);
  });

  it('keeps a driver with capacity left and no overlap', async () => {
    const routeId = await makeRoute();
    const driverId = await makeDriver();
    await makeTransferBooking({ routeId, pickupMinutes: at(6), driverId });

    const free = await getDb().transaction((tx) =>
      driversFreeOn(tx, DATE, { transferWindow: window(at(18), at(21)) }),
    );
    expect(free.map((d) => d.id)).toContain(driverId);
  });

  it('respects a per-driver override against the settings default', async () => {
    /*
     * One job each, and the ONLY difference is the override: the capped driver
     * is out at one job, the default driver still has a second in them. Both
     * in one test, because the point is the comparison — a test of the
     * override alone would also pass if the default were being read for both.
     */
    const routeId = await makeRoute();
    const cappedId = await makeDriver({ name: 'Capped Carlos', maxTransferJobsPerDay: 1 });
    const defaultId = await makeDriver({ name: 'Default Dolores' });
    await makeTransferBooking({ routeId, pickupMinutes: at(6), driverId: cappedId });
    await makeTransferBooking({ routeId, pickupMinutes: at(6), driverId: defaultId });

    const free = await getDb().transaction((tx) =>
      driversFreeOn(tx, DATE, { transferWindow: window(at(18), at(21)) }),
    );
    const ids = free.map((d) => d.id);
    expect(ids).not.toContain(cappedId);
    expect(ids).toContain(defaultId);
  });

  it('excludes a driver whose override is 0 even with no jobs at all', async () => {
    // A driver kept for tours. `0 >= 0` excludes them, which is the same
    // meaning a 0 override has at hold time — and `||` instead of `??` in the
    // cap lookup would silently hand them the default 2 instead.
    const driverId = await makeDriver({ maxTransferJobsPerDay: 0 });

    const free = await getDb().transaction((tx) =>
      driversFreeOn(tx, DATE, { transferWindow: window(at(18), at(21)) }),
    );
    expect(free.map((d) => d.id)).not.toContain(driverId);
  });

  it('excludes a driver whose held transfer window overlaps, under their cap', async () => {
    // One job of two allowed, so the count rule says yes and only the overlap
    // can refuse: [08:00, 11:00) against a candidate at 10:00.
    const routeId = await makeRoute();
    const driverId = await makeDriver();
    await makeTransferBooking({ routeId, pickupMinutes: MORNING_PICKUP, driverId });

    const free = await getDb().transaction((tx) =>
      driversFreeOn(tx, DATE, { transferWindow: window(at(10), at(13)) }),
    );
    expect(free.map((d) => d.id)).not.toContain(driverId);
  });

  it('excludes a driver holding a TOUR for the whole day', async () => {
    const tourId = await makeTour();
    const driverId = await makeDriver();
    const tourBooking = await makeBooking({ tourId, date: DATE });
    await getDb()
      .update(bookings)
      .set({ driverId, status: 'assigned' })
      .where(eq(bookings.id, tourBooking));

    const free = await getDb().transaction((tx) =>
      driversFreeOn(tx, DATE, { transferWindow: window(at(5), at(5, 20)) }),
    );
    expect(free.map((d) => d.id)).not.toContain(driverId);
  });

  it('does not exclude the transfer being re-assigned from seeing its own driver', async () => {
    /*
     * Both rules at once: the driver's only job IS this booking, so without
     * `excludeBookingId` they would be refused twice over — the window
     * overlaps itself exactly, and one job against a cap of… well, the point
     * is the booking must not compete with itself.
     */
    const routeId = await makeRoute();
    const driverId = await makeDriver({ maxTransferJobsPerDay: 1 });
    const mineId = await makeTransferBooking({
      routeId,
      pickupMinutes: MORNING_PICKUP,
      driverId,
    });

    const free = await getDb().transaction((tx) =>
      driversFreeOn(tx, DATE, {
        transferWindow: window(MORNING_PICKUP, at(11)),
        excludeBookingId: mineId,
      }),
    );
    expect(free.map((d) => d.id)).toContain(driverId);
  });

  it('gives a cancelled transfer its van and driver back', async () => {
    // The same release `CAPACITY_HOLDING_STATUSES` already gives a tour,
    // reached through the new branch: a cancelled transfer's window is not a
    // claim on anything.
    const routeId = await makeRoute();
    const vanId = await makeVan({ vehicleTypeId: VAN_ID });
    const driverId = await makeDriver();
    await makeTransferBooking({
      routeId,
      pickupMinutes: MORNING_PICKUP,
      vanId,
      driverId,
      status: 'cancelled',
    });

    const [freeVans, freeDrivers] = await getDb().transaction(async (tx) => [
      await vansFreeOn(tx, DATE, 0, {
        vehicleTypeId: VAN_ID,
        transferWindow: window(MORNING_PICKUP, at(11)),
      }),
      await driversFreeOn(tx, DATE, { transferWindow: window(MORNING_PICKUP, at(11)) }),
    ]);
    expect(freeVans.map((v) => v.id)).toContain(vanId);
    expect(freeDrivers.map((d) => d.id)).toContain(driverId);
  });
});
