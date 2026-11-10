/**
 * Transfers-launch plan, Task T25b (owner-added 2026-11-10) —
 * `checkout.bookingStatus`, `checkout.bookingLookup` and
 * `portal.manualPayment` carry a transfer booking's guest field subset:
 * route + direction, vehicle type, pickup time, drop-off, flight if set.
 * The same join quartet and `tourId === null` guard `portal.booking` (T24)
 * established, through each of these three procedures specifically.
 *
 * Deliberately a NARROWER field set than `portal.booking`'s own (no
 * `dayUseEndTime`, `luggageCount`, `dropoffMapsUrl`) — the owner's own
 * list names exactly: route + direction, vehicle type, pickup time,
 * pickup/drop-off, flight if set. `portal-transfer-booking.test.ts` (T24)
 * already proves `transferTitle()`/`routeDisplayName()`'s own fallback
 * logic; this file's job is the WIRING on these three procedures.
 */
import { afterEach, beforeAll, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { PriceSnapshot } from '@rg/shared';
import { getDb, getPool } from '../db/client';
import {
  bookings,
  destinations,
  drivers,
  tours,
  transferPlaces,
  transferRouteVehiclePrices,
  transferRoutes,
  vans,
  vehicleTypes,
} from '../db/schema';
import { generateBookingRef } from '../services/booking-ref';
import { routeDisplayName } from '../services/transfers/display';
import {
  createTransferBooking,
  type CreateTransferBookingInput,
} from '../services/transfers/create-booking';
import { appRouter } from '../routers/_app';
import { customerContext, testContext } from './helpers/ctx';
import { describeWithDb } from './helpers/db';

const TOUR_SNAPSHOT: PriceSnapshot = {
  tier: { tierId: 1, minPax: 1, maxPax: 12, pricePerPersonCentavos: 100_000 },
  addons: [],
  coupon: null,
  depositPercent: 30,
  freeCancelHours: 48,
  subtotalCentavos: 400_000,
  discountCentavos: 0,
  totalCentavos: 400_000,
};

/** This file's own day — `grep -rn 2095-09-15 server/src` matches nothing else. */
const DAY = '2095-09-15';

const created = {
  bookingIds: [] as number[],
  routeIds: [] as number[],
  placeIds: [] as number[],
  vanIds: [] as number[],
  driverIds: [] as number[],
  tourIds: [] as number[],
  destIds: [] as number[],
};

let seq = 0;
const unique = () => {
  seq += 1;
  return `${seq}-${Math.floor(Math.random() * 1e9)}-${Date.now()}`;
};

let VAN_TYPE_ID = 0;
const caller = appRouter.createCaller(testContext());
const portalCaller = (bookingId: number) =>
  appRouter.createCaller(customerContext(bookingId) as never);

async function makeVan() {
  const suffix = unique();
  const [row] = await getDb()
    .insert(vans)
    .values({
      plate: `T25B${suffix}`.slice(0, 20),
      model: 'T25b Fixture',
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
      name: `T25b Driver ${suffix}`,
      code: `T25B${suffix}`.slice(0, 20),
      phone: '09170000000',
      pinHash: '__t25b_not_a_pin_hash__',
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
      slug: `t25b-${unique()}`,
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
    pickupTime: '06:30',
    dayUseEndTime: null,
    pax: 2,
    luggageCount: 1,
    pickup: 'Mactan-Cebu International Airport, Terminal 2',
    pickupMapUrl: null,
    dropoffAddress: 'A resort in Moalboal',
    dropoffMapUrl: null,
    flightNumber: '5J456',
    airline: 'Cebu Pacific',
    requests: null,
    payMode: 'deposit',
    lead: {
      name: 'T25b Guest',
      email: `t25b_guest_${unique()}@example.test`,
      phone: '09171234567',
    },
    priceSource: { kind: 'catalog' },
    ...over,
  };
}

/**
 * A plain Drizzle insert, the same lightweight pattern
 * `transfer-booking-surfaces.test.ts` (Task T6) uses — a real tour and a
 * real `tour_id`, so the negative case below is a genuine tour booking, not
 * a transfer with `tourTitle` set by hand.
 */
async function makeTourBooking() {
  const db = getDb();
  const slug = `__t25b_tour__${unique()}`;
  const [dest] = await db.insert(destinations).values({ name: slug, slug });
  created.destIds.push(dest.insertId);
  const [tour] = await db.insert(tours).values({
    slug,
    title: 'T25b Fixture Tour',
    destinationId: dest.insertId,
    groupsPerDay: 2,
    freeCancelHours: 48,
    isActive: true,
  });
  created.tourIds.push(tour.insertId);

  const ref = generateBookingRef();
  const email = `t25b_tour_${unique()}@example.test`;
  const [row] = await db.insert(bookings).values({
    ref,
    tourId: tour.insertId,
    tourDate: new Date(`${DAY}T00:00:00Z`),
    pax: 2,
    leadName: 'T25b Tour Guest',
    leadEmail: email,
    leadPhone: '09170000001',
    status: 'confirmed',
    payMode: 'full',
    priceSnapshot: TOUR_SNAPSHOT,
    subtotalCentavos: 400_000,
    totalCentavos: 400_000,
    amountPaidCentavos: 100_000,
  });
  created.bookingIds.push(row.insertId);
  return { bookingId: row.insertId, ref, email };
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
  for (const id of created.tourIds) await pool.query('DELETE FROM tours WHERE id = ?', [id]);
  for (const id of created.destIds) await pool.query('DELETE FROM destinations WHERE id = ?', [id]);
  await pool.query('DELETE FROM fleet_date_slots WHERE date = ?', [DAY]);
  created.bookingIds = [];
  created.routeIds = [];
  created.placeIds = [];
  created.vanIds = [];
  created.driverIds = [];
  created.tourIds = [];
  created.destIds = [];
}

describeWithDb(
  'checkout.bookingStatus / .bookingLookup / portal.manualPayment show a transfer’s product (Task T25b)',
  () => {
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

    it('checkout.bookingStatus carries the route, vehicle, pickup time and flight, with no tour title', async () => {
      const fromName = `T25b From ${unique()}`;
      const toName = `T25b To ${unique()}`;
      const routeId = await makeRoute(fromName, toName);
      await makeVan();
      await makeDriver();
      const { bookingId, ref } = await createTransferBooking(baseInput({ routeId }));
      created.bookingIds.push(bookingId);

      const [vehicleType] = await getDb()
        .select({ name: vehicleTypes.name })
        .from(vehicleTypes)
        .where(eq(vehicleTypes.id, VAN_TYPE_ID))
        .limit(1);

      const status = await caller.checkout.bookingStatus({ ref });
      expect(status.tourTitle).toBeNull();
      expect(status.transferRouteLabel).toBe(routeDisplayName(fromName, toName, 'forward'));
      expect(status.pickupTime).toBe('06:30');
      expect(status.vehicleTypeLabel).toBe(vehicleType!.name);
      expect(status.dropoffAddress).toBe('A resort in Moalboal');
      expect(status.flightNumber).toBe('5J456');
      expect(status.airline).toBe('Cebu Pacific');
    });

    it('checkout.bookingLookup carries the same transfer fields', async () => {
      const fromName = `T25b From ${unique()}`;
      const toName = `T25b To ${unique()}`;
      const routeId = await makeRoute(fromName, toName);
      await makeVan();
      await makeDriver();
      const email = `t25b_lookup_${unique()}@example.test`;
      const { bookingId, ref } = await createTransferBooking(
        baseInput({ routeId, lead: { name: 'T25b Guest', email, phone: '09171234567' } }),
      );
      created.bookingIds.push(bookingId);

      const lookup = await caller.checkout.bookingLookup({ ref, email });
      expect(lookup.tourTitle).toBeNull();
      expect(lookup.transferRouteLabel).toBe(routeDisplayName(fromName, toName, 'forward'));
      expect(lookup.pickupTime).toBe('06:30');
      expect(lookup.dropoffAddress).toBe('A resort in Moalboal');
      expect(lookup.flightNumber).toBe('5J456');
      expect(lookup.airline).toBe('Cebu Pacific');
    });

    it('portal.manualPayment carries the same transfer fields', async () => {
      const fromName = `T25b From ${unique()}`;
      const toName = `T25b To ${unique()}`;
      const routeId = await makeRoute(fromName, toName);
      await makeVan();
      await makeDriver();
      const { bookingId } = await createTransferBooking(baseInput({ routeId }));
      created.bookingIds.push(bookingId);

      const payment = await portalCaller(bookingId).portal.manualPayment();
      expect(payment.tourTitle).toBeNull();
      expect(payment.transferRouteLabel).toBe(routeDisplayName(fromName, toName, 'forward'));
      expect(payment.pickupTime).toBe('06:30');
      expect(payment.dropoffAddress).toBe('A resort in Moalboal');
      expect(payment.flightNumber).toBe('5J456');
      expect(payment.airline).toBe('Cebu Pacific');
    });

    it('falls back to "Custom transfer" for a staff-quoted booking with no catalog route, on all three procedures', async () => {
      await makeVan();
      await makeDriver();
      const email = `t25b_custom_${unique()}@example.test`;
      const { bookingId, ref } = await createTransferBooking(
        baseInput({
          routeId: null,
          customRouteDescription: 'Pier 1 to a private villa in Moalboal',
          customRouteDurationMinutes: 90,
          lead: { name: 'T25b Guest', email, phone: '09171234567' },
          priceSource: { kind: 'staff', priceCentavos: 900_000, staffUserId: 1 },
        }),
      );
      created.bookingIds.push(bookingId);

      const status = await caller.checkout.bookingStatus({ ref });
      expect(status.transferRouteLabel).toBe('Pier 1 to a private villa in Moalboal');

      const lookup = await caller.checkout.bookingLookup({ ref, email });
      expect(lookup.transferRouteLabel).toBe('Pier 1 to a private villa in Moalboal');

      const payment = await portalCaller(bookingId).portal.manualPayment();
      expect(payment.transferRouteLabel).toBe('Pier 1 to a private villa in Moalboal');
    });

    it('reads back null on every new field for a TOUR booking, on all three procedures', async () => {
      const { bookingId, ref, email } = await makeTourBooking();

      const status = await caller.checkout.bookingStatus({ ref });
      expect(status.tourTitle).toBe('T25b Fixture Tour');
      expect(status.transferRouteLabel).toBeNull();
      expect(status.pickupTime).toBeNull();
      expect(status.dropoffAddress).toBeNull();
      expect(status.flightNumber).toBeNull();
      expect(status.airline).toBeNull();
      expect(status.vehicleTypeLabel).toBeNull();

      const lookup = await caller.checkout.bookingLookup({ ref, email });
      expect(lookup.transferRouteLabel).toBeNull();
      expect(lookup.pickupTime).toBeNull();
      expect(lookup.dropoffAddress).toBeNull();
      expect(lookup.flightNumber).toBeNull();
      expect(lookup.airline).toBeNull();
      expect(lookup.vehicleTypeLabel).toBeNull();

      const payment = await portalCaller(bookingId).portal.manualPayment();
      expect(payment.transferRouteLabel).toBeNull();
      expect(payment.pickupTime).toBeNull();
      expect(payment.dropoffAddress).toBeNull();
      expect(payment.flightNumber).toBeNull();
      expect(payment.airline).toBeNull();
      expect(payment.vehicleTypeLabel).toBeNull();
    });
  },
);
