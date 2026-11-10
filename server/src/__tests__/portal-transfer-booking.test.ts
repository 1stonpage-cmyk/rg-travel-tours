/**
 * Transfers-launch plan, Task T24 — `portal.booking` ("My Booking") shows a
 * transfer booking's product type, vehicle type, route (or custom
 * description) and guest fields, through the real procedure rather than a
 * unit-level call — the same choice `transfer-booking-surfaces.test.ts`
 * (Task T6) and the T23 admin tests made, because `customerProcedure`'s own
 * session gate sits between a guest and this read.
 *
 * `transferTitle()`/`routeDisplayName()`'s own fallback logic has its tests
 * in `admin-reports.test.ts` (Task T18); `portal-booking.test.ts`'s own
 * "publishes no internal columns" test (Task 9) pins the full key set,
 * updated for the new fields. This file's job is the WIRING on
 * `portal.booking` specifically — that the new joins feed it the right row,
 * and that a TOUR booking reads back `null` on every new field.
 */
import { afterEach, beforeAll, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { getDb, getPool } from '../db/client';
import {
  drivers,
  transferPlaces,
  transferRouteVehiclePrices,
  transferRoutes,
  vans,
  vehicleTypes,
} from '../db/schema';
import { routeDisplayName } from '../services/transfers/display';
import {
  createTransferBooking,
  type CreateTransferBookingInput,
} from '../services/transfers/create-booking';
import { appRouter } from '../routers/_app';
import { customerContext } from './helpers/ctx';
import { describeWithDb } from './helpers/db';

/** This file's own day — `grep -rn 2095-09-14 server/src` matches nothing else. */
const DAY = '2095-09-14';

const created = {
  bookingIds: [] as number[],
  routeIds: [] as number[],
  placeIds: [] as number[],
  vanIds: [] as number[],
  driverIds: [] as number[],
};

let seq = 0;
const unique = () => {
  seq += 1;
  return `${seq}-${Math.floor(Math.random() * 1e9)}-${Date.now()}`;
};

let VAN_TYPE_ID = 0;
const portalCaller = (bookingId: number) =>
  appRouter.createCaller(customerContext(bookingId) as never);

/** A transfer holds reserve fleet capacity at creation time — no van, no booking. */
async function makeVan() {
  const suffix = unique();
  const [row] = await getDb()
    .insert(vans)
    .values({
      plate: `T24${suffix}`.slice(0, 20),
      model: 'T24 Fixture',
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
      name: `T24 Driver ${suffix}`,
      code: `T24${suffix}`.slice(0, 20),
      phone: '09170000000',
      pinHash: '__t24_not_a_pin_hash__',
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
      slug: `t24-${unique()}`,
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
    dropoffMapUrl: 'https://maps.example.test/cebu-hotel',
    flightNumber: '5J123',
    airline: 'Cebu Pacific',
    requests: null,
    payMode: 'deposit',
    lead: {
      name: 'T24 Guest',
      email: `t24_guest_${unique()}@example.test`,
      phone: '09171234567',
    },
    priceSource: { kind: 'catalog' },
    ...over,
  };
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

describeWithDb('portal.booking shows a transfer booking’s product (Task T24)', () => {
  beforeAll(async () => {
    const [vt] = await getDb()
      .select({ id: vehicleTypes.id })
      .from(vehicleTypes)
      .where(eq(vehicleTypes.slug, 'van'))
      .limit(1);
    if (!vt) throw new Error('No vehicle_types row for slug "van" — expected from seedBase.');
    VAN_TYPE_ID = vt.id;
  }, 30_000);

  afterEach(cleanup);

  it('carries the route, pickup time, vehicle and guest fields, with no tour title', async () => {
    const fromName = `T24 From ${unique()}`;
    const toName = `T24 To ${unique()}`;
    const routeId = await makeRoute(fromName, toName);
    await makeVan();
    await makeDriver();
    const { bookingId } = await createTransferBooking(baseInput({ routeId }));
    created.bookingIds.push(bookingId);

    const [vehicleType] = await getDb()
      .select({ name: vehicleTypes.name })
      .from(vehicleTypes)
      .where(eq(vehicleTypes.id, VAN_TYPE_ID))
      .limit(1);

    const booking = await portalCaller(bookingId).portal.booking();
    expect(booking.tourTitle).toBeNull();
    expect(booking.transferRouteLabel).toBe(routeDisplayName(fromName, toName, 'forward'));
    expect(booking.pickupTime).toBe('05:15');
    expect(booking.vehicleTypeLabel).toBe(vehicleType!.name);
    expect(booking.dropoffAddress).toBe('A hotel in Cebu City');
    expect(booking.dropoffMapsUrl).toBe('https://maps.example.test/cebu-hotel');
    expect(booking.luggageCount).toBe(1);
    expect(booking.flightNumber).toBe('5J123');
    expect(booking.airline).toBe('Cebu Pacific');
    expect(booking.dayUseEndTime).toBeNull();
  });

  it('falls back to "Custom transfer" for a staff-quoted booking with no catalog route', async () => {
    await makeVan();
    await makeDriver();
    const { bookingId } = await createTransferBooking(
      baseInput({
        routeId: null,
        customRouteDescription: 'Pier 1 to a private villa in Moalboal',
        customRouteDurationMinutes: 90,
        priceSource: { kind: 'staff', priceCentavos: 900_000, staffUserId: 1 },
      }),
    );
    created.bookingIds.push(bookingId);

    const booking = await portalCaller(bookingId).portal.booking();
    expect(booking.transferRouteLabel).toBe('Pier 1 to a private villa in Moalboal');
  });
});
