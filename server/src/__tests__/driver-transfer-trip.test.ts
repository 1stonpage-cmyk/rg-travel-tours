/**
 * Transfers-launch plan, Task T22 — `TripDetail` AND `DriverTripRow` carry
 * the transfer fields (`services/transfers/display.ts`'s
 * `transferTitle`/`routeDisplayName` — extracted from `services/reports
 * /money.ts` in Task T23, its original home — now wired into both of
 * `routers/public/driver.ts`'s `loadDriverTrip` and `listDriverTrips`), and
 * the zero-itinerary-stop check-in path is CONFIRMED here, not assumed.
 *
 * `DriverTripRow` is in scope alongside `TripDetail` because
 * `listDriverTrips`'s OWN comment named it: "what the screen should show
 * instead (the route, the pickup time, the vehicle) is T22's" — a second
 * code comment, inside this same task's own target function, pointing at
 * the trips LIST rather than only the detail screen. Narrowing to the
 * detail screen alone would have left that comment's promise unmet.
 *
 * Two things this file proves, and each is its own `it()`:
 *
 *  1. `driverTripDetail()`'s (and, inline in the same test, `listDriverTrips()`'s)
 *     payload actually carries the new fields, correctly, for BOTH transfer
 *     shapes — a catalog-route one-way and a staff-quoted, routeless
 *     day-use. The route label's own fallback logic (`transferTitle`) has
 *     its own tests in `admin-reports.test.ts` (Task T18); this file's job
 *     is the WIRING — that the new joins actually feed it the right row,
 *     not a duplicated or dropped one — so the expected label is computed
 *     by calling the same exported `routeDisplayName` this file imports,
 *     rather than a second hand-typed copy of the string that could drift
 *     from it unnoticed.
 *  2. A transfer booking — which owns no `tour_itinerary_stops` rows at
 *     all — walks Start → (no stop to tap) → Complete through the REAL
 *     driver session, with the exact `tripProgress` numbers pinned at each
 *     step. `services/trips/checkins.ts`'s own `checkInStop` comment says
 *     plainly that this task decides what check-in means for a product
 *     with no stop list; the answer this file confirms is: nothing changes
 *     in `checkins.ts` or `tripProgress` — a transfer's only stop is the
 *     trip-start pseudo-stop, `checkInStop` already refuses any stop id for
 *     one (`unknown_stop`), and `completeTrip` needs no stop at all.
 *
 * Driver id is set on the booking by a direct `UPDATE` after
 * `createTransferBooking()` returns, the same way `driver-trip-detail
 * .test.ts`'s own fixtures do — that service has no `driverId` input
 * because nothing writes it except `admin.dispatch.assign`, which test 2
 * goes through for real.
 */
import { afterEach, beforeEach, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { TransferPlaceType } from '@rg/shared';
import { getDb, getPool } from '../db/client';
import {
  bookingTransferDetails,
  bookings,
  drivers,
  transferPlaces,
  transferRouteVehiclePrices,
  transferRoutes,
  users,
  vans,
  vehicleTypes,
} from '../db/schema';
import { routeDisplayName } from '../services/transfers/display';
import {
  createTransferBooking,
  type CreateTransferBookingInput,
} from '../services/transfers/create-booking';
import { driverTripDetail, listDriverTrips } from '../routers/public/driver';
import { appRouter } from '../routers/_app';
import { driverCaller, staffContext } from './helpers/ctx';
import { describeWithDb } from './helpers/db';

/** This file's own day — unclaimed by any other suite (`grep -rn 2096 server/src` matches nothing else). */
const DAY = '2096-11-20';
/** A fixed instant, not `new Date()` (T22 review finding) — `listDriverTrips` takes `now` as a parameter precisely so a suite need not read the machine clock. */
const NOW = new Date(`${DAY}T00:00:00Z`);

const created = {
  userIds: [] as number[],
  bookingIds: [] as number[],
  driverIds: [] as number[],
  vanIds: [] as number[],
  routeIds: [] as number[],
  placeIds: [] as number[],
};

let seq = 0;
const unique = () => {
  seq += 1;
  return `${seq}-${Math.floor(Math.random() * 1e9)}-${Date.now()}`;
};

let VAN_TYPE_ID = 0;
let ownerId = 0;
const ownerApi = () => appRouter.createCaller(staffContext(ownerId, 'owner') as never);

async function vehicleTypeIdBySlug(slug: string): Promise<number> {
  const [row] = await getDb()
    .select({ id: vehicleTypes.id })
    .from(vehicleTypes)
    .where(eq(vehicleTypes.slug, slug))
    .limit(1);
  if (!row) throw new Error(`No vehicle_types row for slug "${slug}"`);
  return row.id;
}

async function makePlace(name: string, placeType: TransferPlaceType = 'destination') {
  const [row] = await getDb()
    .insert(transferPlaces)
    .values({ name, nameKey: `${name}-${unique()}`.toLowerCase(), isActive: true, placeType });
  created.placeIds.push(row.insertId);
  return row.insertId;
}

/** A sellable catalog route, both places named so the expected label is computable. */
async function makeRoute(fromName: string, toName: string) {
  const fromPlaceId = await makePlace(fromName);
  const toPlaceId = await makePlace(toName);
  const [row] = await getDb()
    .insert(transferRoutes)
    .values({
      fromPlaceId,
      toPlaceId,
      reverseEnabled: true,
      slug: `t22-${unique()}`,
      estimatedDurationMinutes: 60,
      freeCancelHours: 24,
      isActive: true,
    });
  created.routeIds.push(row.insertId);
  await getDb().insert(transferRouteVehiclePrices).values({
    routeId: row.insertId,
    vehicleTypeId: VAN_TYPE_ID,
    oneWayPriceCentavos: 500_000,
    dayUsePriceCentavos: 900_000,
  });
  return { routeId: row.insertId, fromName, toName };
}

async function makeStaff() {
  const suffix = unique();
  const [row] = await getDb()
    .insert(users)
    .values({
      name: `T22 owner ${suffix}`,
      email: `t22_owner_${suffix}@example.test`,
      passwordHash: '__t22_fixture_not_a_hash__',
      role: 'owner',
      isActive: true,
    });
  created.userIds.push(row.insertId);
  return row.insertId;
}

async function makeVan() {
  const suffix = unique();
  const [row] = await getDb()
    .insert(vans)
    .values({
      plate: `T22${suffix}`.slice(0, 20),
      model: 'T22 Fixture',
      capacity: 12,
      vehicleTypeId: VAN_TYPE_ID,
      status: 'available',
      isActive: true,
    });
  created.vanIds.push(row.insertId);
  return row.insertId;
}

async function makeDriver() {
  const suffix = unique();
  const [row] = await getDb()
    .insert(drivers)
    .values({
      name: `T22 Driver ${suffix}`,
      code: `T22${suffix}`.slice(0, 20),
      phone: '09170000000',
      pinHash: '__t22_not_a_pin_hash__',
      maxTransferJobsPerDay: 4,
      isActive: true,
    });
  created.driverIds.push(row.insertId);
  return row.insertId;
}

function baseInput(over: Partial<CreateTransferBookingInput> = {}): CreateTransferBookingInput {
  return {
    date: DAY,
    routeId: null,
    customRouteDescription: null,
    customRouteDurationMinutes: null,
    vehicleTypeId: VAN_TYPE_ID,
    direction: 'forward',
    productType: 'transfer_one_way',
    pickupTime: '08:00',
    dayUseEndTime: null,
    pax: 3,
    luggageCount: 2,
    pickup: 'Mactan-Cebu International Airport, Terminal 2',
    pickupMapUrl: null,
    dropoffAddress: 'A private resort in Argao',
    dropoffMapUrl: 'https://maps.example.test/argao-resort',
    flightNumber: null,
    airline: null,
    ferryVesselName: null,
    ferryArrivalTime: null,
    requests: null,
    payMode: 'deposit',
    lead: {
      name: 'T22 Guest',
      email: `t22_guest_${unique()}@example.test`,
      phone: '09171234567',
    },
    priceSource: { kind: 'catalog' },
    ...over,
  };
}

async function assignDriver(bookingId: number, driverId: number) {
  await getDb().update(bookings).set({ driverId }).where(eq(bookings.id, bookingId));
}

async function cleanup() {
  const pool = getPool();
  const db = getDb();
  for (const id of created.bookingIds) {
    // `trip_checkpoints` first — a RESTRICT FK onto `bookings.id`, the same
    // ordering every other cleanup here follows for its own FKs.
    await pool.query('DELETE FROM trip_checkpoints WHERE booking_id = ?', [id]);
    await pool.query('DELETE FROM audit_log WHERE entity = ? AND entity_id = ?', ['bookings', id]);
    await db.delete(bookingTransferDetails).where(eq(bookingTransferDetails.bookingId, id));
    await pool.query('DELETE FROM bookings WHERE id = ?', [id]);
  }
  for (const id of created.driverIds) await db.delete(drivers).where(eq(drivers.id, id));
  for (const id of created.vanIds) await db.delete(vans).where(eq(vans.id, id));
  for (const id of created.routeIds) {
    await pool.query('DELETE FROM transfer_route_vehicle_prices WHERE route_id = ?', [id]);
    await pool.query('DELETE FROM transfer_routes WHERE id = ?', [id]);
  }
  for (const id of created.placeIds)
    await pool.query('DELETE FROM transfer_places WHERE id = ?', [id]);
  await pool.query('DELETE FROM fleet_date_slots WHERE date = ?', [DAY]);
  created.bookingIds = [];
  created.driverIds = [];
  created.vanIds = [];
  created.routeIds = [];
  created.placeIds = [];
}

describeWithDb('driverTripDetail carries transfer fields (Task T22)', () => {
  beforeEach(async () => {
    VAN_TYPE_ID = await vehicleTypeIdBySlug('van');
  });

  afterEach(async () => {
    await cleanup();
    for (const id of created.userIds) await getDb().delete(users).where(eq(users.id, id));
    created.userIds = [];
  });

  it('reads the catalog route label, pickup time and drop-off for a route-based transfer', async () => {
    const driverId = await makeDriver();
    // A transfer hold reserves fleet capacity at CREATION time (T19/T21's
    // own lesson) — the van must exist before `createTransferBooking()` is
    // called at all, or it refuses `no_vehicle_available`.
    await makeVan();
    const { routeId, fromName, toName } = await makeRoute(
      `T22 From ${unique()}`,
      `T22 To ${unique()}`,
    );

    const held = await createTransferBooking(
      baseInput({ routeId, pickupTime: '08:30', priceSource: { kind: 'catalog' } }),
    );
    created.bookingIds.push(held.bookingId);
    await assignDriver(held.bookingId, driverId);

    const detail = await driverTripDetail(driverId, held.bookingId);
    expect(detail.tourTitle).toBeNull();
    // Wired, not duplicated: the expected string comes from the same
    // exported function `loadDriverTrip` calls — a swapped join or a
    // mixed-up fromPlace/toPlace would make these diverge.
    expect(detail.transferRouteLabel).toBe(routeDisplayName(fromName, toName, 'forward'));
    expect(detail.pickupTime).toBe('08:30');
    expect(detail.dropoffAddress).toBe('A private resort in Argao');
    expect(detail.dropoffMapsUrl).toBe('https://maps.example.test/argao-resort');
    expect(detail.dayUseEndTime).toBeNull();

    // `listDriverTrips` (the trips list) carries the same two fields —
    // widened alongside `driverTripDetail` once `driver.ts:127`'s own
    // comment ("what the screen should show instead … is T22's") named it
    // as part of this task too, not deferred to a later one.
    const rows = await listDriverTrips(driverId, NOW);
    const row = rows.find((candidate) => candidate.bookingId === held.bookingId);
    expect(row?.transferRouteLabel).toBe(routeDisplayName(fromName, toName, 'forward'));
    expect(row?.pickupTime).toBe('08:30');
  });

  /**
   * T22 review finding: every other assertion here pins `direction:
   * 'forward'`, the input's own default — so dropping
   * `bookingTransferDetails.direction` from either query's `select` would
   * change nothing observable (`transferTitle`'s own fallback is `??
   * 'forward'`). This pins the REVERSE half, where a dropped column would
   * show the driver the route backwards.
   */
  it('reads the route backwards for a reverse-direction booking', async () => {
    const driverId = await makeDriver();
    await makeVan();
    const { routeId, fromName, toName } = await makeRoute(
      `T22 Rev-From ${unique()}`,
      `T22 Rev-To ${unique()}`,
    );

    const held = await createTransferBooking(
      baseInput({ routeId, direction: 'reverse', priceSource: { kind: 'catalog' } }),
    );
    created.bookingIds.push(held.bookingId);
    await assignDriver(held.bookingId, driverId);

    const detail = await driverTripDetail(driverId, held.bookingId);
    expect(detail.transferRouteLabel).toBe(routeDisplayName(fromName, toName, 'reverse'));
    // Not the forward label — the two must actually differ for this to
    // mean anything, since `fromName`/`toName` are distinct places.
    expect(detail.transferRouteLabel).not.toBe(routeDisplayName(fromName, toName, 'forward'));

    const rows = await listDriverTrips(driverId, NOW);
    const row = rows.find((candidate) => candidate.bookingId === held.bookingId);
    expect(row?.transferRouteLabel).toBe(routeDisplayName(fromName, toName, 'reverse'));
  });

  it('falls back to the custom route description and carries the day-use end time', async () => {
    const driverId = await makeDriver();
    ownerId = await makeStaff();
    await makeVan();

    const held = await createTransferBooking(
      baseInput({
        routeId: null,
        customRouteDescription: 'A private island-hopping day trip',
        productType: 'transfer_day_use',
        dayUseEndTime: '17:00',
        priceSource: { kind: 'staff', priceCentavos: 900_000, staffUserId: ownerId },
      }),
    );
    created.bookingIds.push(held.bookingId);
    await assignDriver(held.bookingId, driverId);

    const detail = await driverTripDetail(driverId, held.bookingId);
    expect(detail.tourTitle).toBeNull();
    expect(detail.transferRouteLabel).toBe('A private island-hopping day trip');
    expect(detail.dayUseEndTime).toBe('17:00');
  });
});

describeWithDb('a zero-itinerary-stop transfer: start, no stop to tap, complete (Task T22)', () => {
  beforeEach(async () => {
    VAN_TYPE_ID = await vehicleTypeIdBySlug('van');
    ownerId = await makeStaff();
  });

  afterEach(async () => {
    await cleanup();
    for (const id of created.userIds) await getDb().delete(users).where(eq(users.id, id));
    created.userIds = [];
  });

  it('starts, refuses any check-in as unknown_stop, and completes — through the real driver session', async () => {
    const driverId = await makeDriver();
    const vanId = await makeVan();

    const held = await createTransferBooking(
      baseInput({
        customRouteDescription: 'Custom airport pickup',
        customRouteDurationMinutes: 45,
        priceSource: { kind: 'staff', priceCentavos: 500_000, staffUserId: ownerId },
      }),
    );
    created.bookingIds.push(held.bookingId);

    // Fixture shortcut: a direct status write stands in for the payment
    // flow (already proven, step by step, in `transfer-quote-lifecycle
    // .test.ts`) — this test's own job is the check-in path, not money.
    await getDb()
      .update(bookings)
      .set({ status: 'confirmed' })
      .where(eq(bookings.id, held.bookingId));

    await ownerApi().admin.dispatch.assign({
      bookingId: held.bookingId,
      vanId,
      driverId,
      reason: 'T22 fixture assignment',
    });

    const driver = driverCaller(driverId);

    // Before Start: the trip-start pseudo-stop is this transfer's only
    // stop — `total === 1` — and it has not happened yet.
    const before = await driver.driver.trip({ bookingId: held.bookingId });
    expect(before.progress).toEqual(
      expect.objectContaining({ bookingId: held.bookingId, done: 0, total: 1 }),
    );
    expect(before.progress.stops).toHaveLength(1);
    expect(before.progress.stops[0]!.stopId).toBeNull();

    const started = await driver.driver.startTrip({ bookingId: held.bookingId });
    expect(started.ok).toBe(true);
    if (started.ok) {
      expect(started.progress.status).toBe('in_progress');
      expect(started.progress.done).toBe(1);
      expect(started.progress.total).toBe(1);
    }

    /*
     * No itinerary stop exists on this booking at all — `checkInStop`
     * refuses any stop id as `unknown_stop` the moment it reads
     * `trip.tourId === null`, before it even looks the id up. Any
     * positive integer proves the same refusal; this one just needs to
     * not collide with a real id.
     */
    const checkIn = await driver.driver.checkIn({ bookingId: held.bookingId, stopId: 999_999 });
    expect(checkIn).toEqual({ ok: false, reason: 'unknown_stop' });

    const completed = await driver.driver.completeTrip({ bookingId: held.bookingId });
    expect(completed.ok).toBe(true);
    if (completed.ok) {
      expect(completed.progress.status).toBe('completed');
      // Still just the one stop — completion inserts no checkpoint of its
      // own (`stop_key` 0 is already trip start).
      expect(completed.progress.done).toBe(1);
      expect(completed.progress.total).toBe(1);
    }

    const [vanRow] = await getDb().select().from(vans).where(eq(vans.id, vanId));
    expect(vanRow?.status, 'the van was not freed by Complete').toBe('available');

    const after = await driver.driver.trip({ bookingId: held.bookingId });
    expect(after.status).toBe('completed');
  });
});
