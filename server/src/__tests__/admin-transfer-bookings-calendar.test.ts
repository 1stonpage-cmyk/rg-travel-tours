/**
 * Transfers-launch plan, Task T23 — `admin.bookings.list`/`.detail` and
 * `admin.calendar.month` show a transfer booking's product type, vehicle
 * type and route (or custom description), through the real routers rather
 * than the exported functions directly — the same choice
 * `transfer-booking-surfaces.test.ts` (Task T6) made, because a role gate
 * or an input schema sitting between the client and the query is exactly
 * the kind of thing a unit-level call would not exercise.
 *
 * `todayDepartures()`'s own wiring has its coverage in
 * `admin-transfer-departures.test.ts` — split out because that surface
 * landed in its own commit alongside the `DeparturesBoard.tsx` "1 of 1
 * stops" fix, independent of this file's two.
 *
 * `transferTitle()`/`routeDisplayName()`'s own fallback logic has its tests
 * in `admin-reports.test.ts` (Task T18) and its reverse-direction coverage
 * in `driver-transfer-trip.test.ts` (Task T22); this file's job is the
 * WIRING on these two call sites — that the new joins on each feed the
 * right row, not a duplicated or dropped one, and that a TOUR booking
 * (which has none of the four new joins' rows) reads back `null` on every
 * one of them rather than "Custom transfer".
 */
import { afterAll, afterEach, beforeAll, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { getDb, getPool } from '../db/client';
import {
  bookings,
  destinations,
  drivers,
  tours,
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
import { appRouter } from '../routers/_app';
import { generateBookingRef } from '../services/booking-ref';
import { staffContext } from './helpers/ctx';
import { describeWithDb } from './helpers/db';

/** This file's own day — `grep -rn 2095-09-12 server/src` matches nothing else. */
const DAY = '2095-09-12';

const created = {
  userIds: [] as number[],
  bookingIds: [] as number[],
  routeIds: [] as number[],
  placeIds: [] as number[],
  tourIds: [] as number[],
  destIds: [] as number[],
  vanIds: [] as number[],
  driverIds: [] as number[],
};

let seq = 0;
const unique = () => {
  seq += 1;
  return `${seq}-${Math.floor(Math.random() * 1e9)}-${Date.now()}`;
};

let VAN_TYPE_ID = 0;
let ownerId = 0;
const ownerApi = () => appRouter.createCaller(staffContext(ownerId, 'owner') as never);

/** A transfer holds reserve fleet capacity at creation time — no van, no booking. */
async function makeVan() {
  const suffix = unique();
  const [row] = await getDb()
    .insert(vans)
    .values({
      plate: `T23${suffix}`.slice(0, 20),
      model: 'T23 Fixture',
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
      name: `T23 Driver ${suffix}`,
      code: `T23${suffix}`.slice(0, 20),
      phone: '09170000000',
      pinHash: '__t23_not_a_pin_hash__',
      maxTransferJobsPerDay: 4,
      isActive: true,
    });
  created.driverIds.push(row.insertId);
  return row.insertId;
}

async function makePlace(name: string) {
  const [row] = await getDb()
    .insert(transferPlaces)
    .values({ name, nameKey: `${name}-${unique()}`.toLowerCase(), isActive: true });
  created.placeIds.push(row.insertId);
  return row.insertId;
}

async function makeRoute(fromName: string, toName: string) {
  const fromPlaceId = await makePlace(fromName);
  const toPlaceId = await makePlace(toName);
  const [row] = await getDb()
    .insert(transferRoutes)
    .values({
      fromPlaceId,
      toPlaceId,
      reverseEnabled: true,
      slug: `t23-${unique()}`,
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
    pickupTime: '05:15',
    dayUseEndTime: null,
    pax: 2,
    luggageCount: 1,
    pickup: 'Mactan-Cebu International Airport, Terminal 2',
    pickupMapUrl: null,
    dropoffAddress: 'A hotel in Cebu City',
    dropoffMapUrl: null,
    flightNumber: null,
    airline: null,
    requests: null,
    payMode: 'deposit',
    lead: {
      name: 'T23 Guest',
      email: `t23_guest_${unique()}@example.test`,
      phone: '09171234567',
    },
    priceSource: { kind: 'catalog' },
    ...over,
  };
}

async function makeTourBooking(): Promise<{ ref: string; id: number }> {
  const ref = generateBookingRef();
  const [row] = await getDb()
    .insert(bookings)
    .values({
      ref,
      tourId: created.tourIds[0]!,
      tourDate: new Date(`${DAY}T00:00:00Z`),
      pax: 2,
      leadName: 'T23 Tour Guest',
      leadEmail: `t23_tour_${unique()}@example.test`,
      leadPhone: '09170000000',
      status: 'confirmed',
      payMode: 'full',
      priceSnapshot: {
        tier: { tierId: 1, minPax: 1, maxPax: 12, pricePerPersonCentavos: 100000 },
        addons: [],
        coupon: null,
        depositPercent: 30,
        freeCancelHours: 48,
        subtotalCentavos: 200000,
        discountCentavos: 0,
        totalCentavos: 200000,
      },
      subtotalCentavos: 200000,
      totalCentavos: 200000,
      amountPaidCentavos: 0,
    });
  created.bookingIds.push(row.insertId);
  return { ref, id: row.insertId };
}

async function cleanup() {
  const pool = getPool();
  for (const id of created.bookingIds) {
    await pool.query('DELETE FROM trip_checkpoints WHERE booking_id = ?', [id]);
    await pool.query('DELETE FROM audit_log WHERE entity = ? AND entity_id = ?', ['bookings', id]);
    await pool.query('DELETE FROM booking_transfer_details WHERE booking_id = ?', [id]);
    await pool.query('DELETE FROM bookings WHERE id = ?', [id]);
  }
  for (const id of created.routeIds) {
    await pool.query('DELETE FROM transfer_route_vehicle_prices WHERE route_id = ?', [id]);
    await pool.query('DELETE FROM transfer_routes WHERE id = ?', [id]);
  }
  for (const id of created.placeIds)
    await pool.query('DELETE FROM transfer_places WHERE id = ?', [id]);
  for (const id of created.vanIds) await pool.query('DELETE FROM vans WHERE id = ?', [id]);
  for (const id of created.driverIds) await pool.query('DELETE FROM drivers WHERE id = ?', [id]);
  await pool.query('DELETE FROM fleet_date_slots WHERE date = ?', [DAY]);
  created.bookingIds = [];
  created.routeIds = [];
  created.placeIds = [];
  created.vanIds = [];
  created.driverIds = [];
}

describeWithDb('Admin screens show a transfer booking’s product (Task T23)', () => {
  beforeAll(async () => {
    const [vt] = await getDb()
      .select({ id: vehicleTypes.id })
      .from(vehicleTypes)
      .where(eq(vehicleTypes.slug, 'van'))
      .limit(1);
    if (!vt) throw new Error('No vehicle_types row for slug "van" — expected from seedBase.');
    VAN_TYPE_ID = vt.id;

    const slug = `__t23__${unique()}`;
    const [destination] = await getDb().insert(destinations).values({ name: slug, slug });
    created.destIds.push(destination.insertId);
    const [tour] = await getDb()
      .insert(tours)
      .values({ slug, title: 'T23 Audit Fixture Tour', destinationId: destination.insertId });
    created.tourIds.push(tour.insertId);

    const [owner] = await getDb()
      .insert(users)
      .values({
        name: `T23 Owner ${slug}`,
        email: `t23_owner_${unique()}@example.test`,
        passwordHash: '__t23_fixture_not_a_hash__',
        role: 'owner',
        isActive: true,
      });
    created.userIds.push(owner.insertId);
    ownerId = owner.insertId;
  }, 30_000);

  afterEach(cleanup);

  afterAll(async () => {
    const pool = getPool();
    for (const id of created.userIds) await pool.query('DELETE FROM users WHERE id = ?', [id]);
    for (const id of created.tourIds) {
      await pool.query('DELETE FROM tour_date_slots WHERE tour_id = ?', [id]);
      await pool.query('DELETE FROM tours WHERE id = ?', [id]);
    }
    for (const id of created.destIds)
      await pool.query('DELETE FROM destinations WHERE id = ?', [id]);
  });

  it('shows the route, pickup time and vehicle on the bookings list and detail', async () => {
    const fromName = `T23 From ${unique()}`;
    const toName = `T23 To ${unique()}`;
    const routeId = await makeRoute(fromName, toName);
    await makeVan();
    await makeDriver();
    const { ref, bookingId } = await createTransferBooking(
      baseInput({ routeId, customRouteDescription: null }),
    );
    created.bookingIds.push(bookingId);

    const [vehicleType] = await getDb()
      .select({ name: vehicleTypes.name })
      .from(vehicleTypes)
      .where(eq(vehicleTypes.id, VAN_TYPE_ID))
      .limit(1);

    const list = await ownerApi().admin.bookings.list({ from: DAY, to: DAY });
    const row = list.items.find((item) => item.ref === ref);
    expect(row, 'the new transfer booking is missing from the list').toBeDefined();
    expect(row!.tourTitle).toBeNull();
    expect(row!.transferRouteLabel).toBe(routeDisplayName(fromName, toName, 'forward'));
    expect(row!.pickupTime).toBe('05:15');
    expect(row!.vehicleTypeLabel).toBe(vehicleType!.name);

    const detail = await ownerApi().admin.bookings.detail({ ref });
    expect(detail.transferRouteLabel).toBe(routeDisplayName(fromName, toName, 'forward'));
    expect(detail.pickupTime).toBe('05:15');
    expect(detail.vehicleTypeLabel).toBe(vehicleType!.name);
    expect(detail.dropoffAddress).toBe('A hotel in Cebu City');
    expect(detail.luggageCount).toBe(1);
    // Not an airport pickup in this fixture — null, not a crash.
    expect(detail.flightNumber).toBeNull();
    expect(detail.airline).toBeNull();
    expect(detail.dayUseEndTime).toBeNull();
  });

  it('falls back to "Custom transfer" for a staff-quoted booking with no catalog route', async () => {
    await makeVan();
    await makeDriver();
    const { ref, bookingId } = await createTransferBooking(
      baseInput({
        routeId: null,
        customRouteDescription: 'Pier 1 to a private villa in Moalboal',
        customRouteDurationMinutes: 90,
        priceSource: { kind: 'staff', priceCentavos: 900_000, staffUserId: ownerId },
      }),
    );
    created.bookingIds.push(bookingId);

    const detail = await ownerApi().admin.bookings.detail({ ref });
    expect(detail.transferRouteLabel).toBe('Pier 1 to a private villa in Moalboal');
  });

  it('shows the route and pickup time on the dispatch calendar', async () => {
    const fromName = `T23 Cal From ${unique()}`;
    const toName = `T23 Cal To ${unique()}`;
    const routeId = await makeRoute(fromName, toName);
    await makeVan();
    await makeDriver();
    const { ref, bookingId } = await createTransferBooking(baseInput({ routeId }));
    created.bookingIds.push(bookingId);

    const { days } = await ownerApi().admin.calendar.month({
      year: Number(DAY.slice(0, 4)),
      month: Number(DAY.slice(5, 7)),
    });
    const day = days.find((d) => d.date === DAY)!;
    const trip = day.trips.find((t) => t.ref === ref);
    expect(trip, 'the transfer is missing from the calendar day').toBeDefined();
    expect(trip!.tourTitle).toBeNull();
    expect(trip!.transferRouteLabel).toBe(routeDisplayName(fromName, toName, 'forward'));
    expect(trip!.pickupTime).toBe('05:15');
    expect(trip!.vehicleTypeLabel).not.toBeNull();
  });

  it('reads null on every new field for a tour booking', async () => {
    const tour = await makeTourBooking();

    const list = await ownerApi().admin.bookings.list({ from: DAY, to: DAY });
    const listRow = list.items.find((item) => item.ref === tour.ref)!;
    expect(listRow.transferRouteLabel).toBeNull();

    const detail = await ownerApi().admin.bookings.detail({ ref: tour.ref });
    expect(detail.transferRouteLabel).toBeNull();
    expect(detail.pickupTime).toBeNull();
    expect(detail.vehicleTypeLabel).toBeNull();
    expect(detail.dropoffAddress).toBeNull();
    expect(detail.luggageCount).toBeNull();
    expect(detail.flightNumber).toBeNull();
    expect(detail.airline).toBeNull();
    expect(detail.dayUseEndTime).toBeNull();

    const { days } = await ownerApi().admin.calendar.month({
      year: Number(DAY.slice(0, 4)),
      month: Number(DAY.slice(5, 7)),
    });
    const day = days.find((d) => d.date === DAY)!;
    const calTrip = day.trips.find((t) => t.ref === tour.ref)!;
    expect(calTrip.transferRouteLabel).toBeNull();
    expect(calTrip.pickupTime).toBeNull();
    expect(calTrip.vehicleTypeLabel).toBeNull();
  });
});
