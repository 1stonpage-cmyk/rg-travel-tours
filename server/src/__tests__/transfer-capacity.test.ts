/**
 * Transfer capacity — the DB-aware half (transfers-launch plan, Architecture
 * §2 and §2a; Task T7). `assessTransferCapacity` for a candidate TRANSFER, and
 * the extended `assessCapacity` for a candidate TOUR that now shares the fleet
 * with transfers.
 *
 * The pure window math is `transfer-overlap.test.ts`. What is here is
 * everything that needs real rows and real transactions, and the four races at
 * the bottom are the point of the file.
 *
 * **Why the fixtures are COMMITTED, and cleaned up after every test** — the
 * same two reasons `capacity.test.ts` gives, and they apply identically:
 *
 *  1. A concurrency test needs TWO genuinely in-flight transactions, which
 *     means two connections, which means committed state. A rolled-back fixture
 *     would be invisible to the other connection, both candidates would see an
 *     empty fleet, and the test would pass against code with no lock at all.
 *  2. `vans` and `drivers` are not date-scoped — these counts are of the whole
 *     fleet — so every test depends on the fleet being exactly what it built.
 *
 * Nothing here deletes a row production code created; the teardown deletes
 * exactly the ids this file committed, in `rg_travel_test` only
 * (`per-file-setup.ts` proves the connection with a real `SELECT DATABASE()`
 * before the first test).
 *
 * **No real transfer booking can be created anywhere in this codebase yet** —
 * `createTransferBooking()` is Task T10. The `bookTransfer` helper below writes
 * the `bookings` + `booking_transfer_details` pair by hand, which is a
 * simulation of what T10 will do and deliberately not a second implementation
 * of it: the only thing under test is the capacity verdict and the lock that
 * serialises it.
 */
import { afterEach, beforeEach, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { type BookingStatus, type PriceSnapshot, type VehicleType } from '@rg/shared';
import { getDb, getPool } from '../db/client';
import {
  bookingTransferDetails,
  bookings,
  destinations,
  driverLeaves,
  drivers,
  tours,
  transferRoutes,
  vans,
} from '../db/schema';
import { generateBookingRef } from '../services/booking-ref';
import { assessCapacity, takeFleetDateLock, takeSlotLocks } from '../services/capacity';
import {
  assessTransferCapacity,
  leftoverTransferCapacity,
  transferWindowsByType,
  type TransferProductType,
} from '../services/transfers/capacity';
import { MINUTES_PER_DAY } from '../services/transfers/overlap';
import { readTransferOperationsSettings } from '../content/settings';
import { describeWithDb } from './helpers/db';

/** The day every test uses, far enough out that no seed or fixture owns it. */
const DAY = '2099-12-04';
const DAY_BEFORE = '2099-12-03';
const DAY_AFTER = '2099-12-05';

/** The seeded `transfer_operations.bufferMinutes`, asserted in `beforeEach`. */
const BUFFER = 60;
/** The seeded `transfer_operations.maxTransferJobsPerDriverPerDay`, likewise. */
const DEFAULT_DRIVER_CAP = 2;

/** Minutes since midnight, so the cases read as times. */
const at = (hours: number, minutes = 0) => hours * 60 + minutes;
/** Minutes back to the `"HH:mm"` civil label the column stores. */
const hhmm = (minutes: number) =>
  `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;

/** A one-way route duration every fixture shares, so windows are easy to read. */
const DURATION = 120;

/** Every id this file committed, so teardown removes exactly those rows. */
const created = {
  bookingIds: [] as number[],
  tourIds: [] as number[],
  routeIds: [] as number[],
  destinationIds: [] as number[],
  vanIds: [] as number[],
  driverIds: [] as number[],
  leaveIds: [] as number[],
};

/** Random FIRST, timestamp second — the reasoning is `capacity.test.ts`'s. */
const unique = () => `${Math.floor(Math.random() * 1e9)}_${Date.now()}`;

async function count(statement: Parameters<ReturnType<typeof getDb>['execute']>[0]) {
  const [rows] = (await getDb().execute(statement)) as unknown as [Array<{ n: number }>, unknown];
  return Number(rows[0]?.n ?? -1);
}

async function makeDestination() {
  const slug = `__xfercap__${unique()}`;
  const [row] = await getDb().insert(destinations).values({ name: slug, slug });
  created.destinationIds.push(row.insertId);
  return row.insertId;
}

/** A transfer route, plus the destination its unique foreign key needs. */
async function makeRoute(opts: { durationMinutes?: number } = {}) {
  const destinationId = await makeDestination();
  const slug = `xfercap-${unique()}`;
  const [row] = await getDb()
    .insert(transferRoutes)
    .values({
      destinationId,
      slug,
      estimatedDurationMinutes: opts.durationMinutes ?? DURATION,
    });
  created.routeIds.push(row.insertId);
  return row.insertId;
}

async function makeTour(opts: { groupsPerDay?: number } = {}) {
  const destinationId = await makeDestination();
  const slug = `__xfercap__${unique()}`;
  const [row] = await getDb()
    .insert(tours)
    .values({
      slug,
      title: slug,
      destinationId,
      groupsPerDay: opts.groupsPerDay ?? 5,
      isActive: true,
    });
  created.tourIds.push(row.insertId);
  return row.insertId;
}

async function makeVan(
  opts: { vehicleType?: VehicleType; capacity?: number; status?: 'available' | 'for_repair' } = {},
) {
  const suffix = unique();
  const [row] = await getDb()
    .insert(vans)
    .values({
      plate: `XC${suffix}`.slice(0, 20),
      model: 'Transfer Capacity Fixture',
      capacity: opts.capacity ?? 12,
      vehicleType: opts.vehicleType ?? 'van',
      status: opts.status ?? 'available',
      isActive: true,
    });
  created.vanIds.push(row.insertId);
  return row.insertId;
}

/** `maxTransferJobsPerDay: undefined` leaves the column NULL — "use the default". */
async function makeDriver(opts: { maxTransferJobsPerDay?: number; isActive?: boolean } = {}) {
  const suffix = unique();
  const [row] = await getDb()
    .insert(drivers)
    .values({
      name: `Transfer Capacity Fixture ${suffix}`,
      code: `XC${suffix}`.slice(0, 20),
      phone: '09170000000',
      // Not a real hash and not a real PIN: nothing here logs in.
      pinHash: '__transfer_capacity_not_a_pin_hash__',
      maxTransferJobsPerDay: opts.maxTransferJobsPerDay ?? null,
      isActive: opts.isActive ?? true,
    });
  created.driverIds.push(row.insertId);
  return row.insertId;
}

async function makeLeave(driverId: number, startDate: string, endDate: string) {
  const [row] = await getDb()
    .insert(driverLeaves)
    .values({
      driverId,
      startDate: new Date(`${startDate}T00:00:00Z`),
      endDate: new Date(`${endDate}T00:00:00Z`),
    });
  created.leaveIds.push(row.insertId);
  return row.insertId;
}

/**
 * The minimum snapshot `bookings.price_snapshot` will accept. No test reads it,
 * and it is the TOUR shape even on a transfer row deliberately: the column is
 * JSON, the database does not care, and the transfer snapshot shape is T9/T10's
 * decision (T5's report §6). This is a fixture, not a precedent.
 */
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

/** A committed TOUR booking, which blocks a vehicle and a driver for the day. */
async function makeTourBooking(opts: { tourId: number; date: string; status?: BookingStatus }) {
  const [row] = await getDb()
    .insert(bookings)
    .values({
      ref: generateBookingRef(),
      tourId: opts.tourId,
      tourDate: new Date(`${opts.date}T00:00:00Z`),
      pax: 4,
      leadName: 'Transfer Capacity Fixture',
      leadEmail: 'fixture@example.test',
      leadPhone: '09170000000',
      status: opts.status ?? 'confirmed',
      payMode: 'full',
      priceSnapshot: SNAPSHOT,
      subtotalCentavos: 100000,
      totalCentavos: 100000,
    });
  created.bookingIds.push(row.insertId);
  return row.insertId;
}

interface TransferFixture {
  routeId: number;
  date: string;
  vehicleType: VehicleType;
  productType?: TransferProductType;
  pickupMinutes: number;
  dayUseEndMinutes?: number;
  /** The FROZEN buffer, as `booking_transfer_details.buffer_minutes_used`. */
  bufferMinutes?: number;
  /**
   * The FROZEN duration, as `booking_transfer_details.route_duration_minutes_used`
   * — ignored (and stored NULL) for a day-use fixture, same as production
   * will do. One-way fixtures default to `DURATION`, matching `makeRoute()`'s
   * own default, since every call site below uses an unmodified route.
   */
  routeDurationMinutes?: number;
  status?: BookingStatus;
}

/**
 * A committed TRANSFER booking and its details row — what T10 will write.
 * Inserted through two statements in one transaction, as T10 must.
 */
async function makeTransferBooking(fixture: TransferFixture) {
  const productType = fixture.productType ?? 'transfer_one_way';
  const id = await getDb().transaction(async (tx) => {
    const [row] = await tx.insert(bookings).values({
      ref: generateBookingRef(),
      tourId: null,
      productType,
      routeId: fixture.routeId,
      vehicleTypeRequested: fixture.vehicleType,
      tourDate: new Date(`${fixture.date}T00:00:00Z`),
      pax: 2,
      leadName: 'Transfer Capacity Fixture',
      leadEmail: 'fixture@example.test',
      leadPhone: '09170000000',
      status: fixture.status ?? 'confirmed',
      payMode: 'full',
      priceSnapshot: SNAPSHOT,
      subtotalCentavos: 100000,
      totalCentavos: 100000,
    });
    await tx.insert(bookingTransferDetails).values({
      bookingId: row.insertId,
      pickupTime: hhmm(fixture.pickupMinutes),
      dayUseEndTime: fixture.dayUseEndMinutes === undefined ? null : hhmm(fixture.dayUseEndMinutes),
      dropoffAddress: 'Fixture drop-off',
      bufferMinutesUsed: fixture.bufferMinutes ?? BUFFER,
      routeDurationMinutesUsed:
        productType === 'transfer_day_use' ? null : (fixture.routeDurationMinutes ?? DURATION),
    });
    return row.insertId;
  });
  created.bookingIds.push(id);
  return id;
}

interface Candidate {
  date?: string;
  vehicleType: VehicleType;
  productType?: TransferProductType;
  pickupMinutes: number;
  dayUseEndMinutes?: number | null;
  routeDurationMinutes?: number | null;
  bufferMinutes?: number;
}

function candidateParams(candidate: Candidate) {
  const productType = candidate.productType ?? 'transfer_one_way';
  return {
    date: candidate.date ?? DAY,
    vehicleType: candidate.vehicleType,
    productType,
    pickupTimeMinutes: candidate.pickupMinutes,
    dayUseEndTimeMinutes: candidate.dayUseEndMinutes ?? null,
    routeDurationMinutes:
      candidate.routeDurationMinutes === undefined ? DURATION : candidate.routeDurationMinutes,
    bufferMinutes: candidate.bufferMinutes ?? BUFFER,
  };
}

/** The transfer call under test, as `createTransferBooking()` will make it. */
function assessTransfer(candidate: Candidate) {
  const params = candidateParams(candidate);
  return getDb().transaction(async (tx) => {
    await takeFleetDateLock(tx, params.date);
    return assessTransferCapacity(tx, params);
  });
}

/** The tour call under test, unchanged in shape from `capacity.test.ts`. */
function assessTour(tourId: number, date: string, pax: number) {
  return getDb().transaction(async (tx) => {
    await takeSlotLocks(tx, tourId, date);
    return assessCapacity(tx, tourId, date, pax);
  });
}

/**
 * A whole transfer hold in one transaction — the fleet lock FIRST (a transfer
 * has no `tour_date_slots` row), then the verdict, then the two inserts. The
 * four races at the bottom of this file drive two of these concurrently.
 *
 * A refusal is thrown as `refused: <reason>` so a race can assert the SPECIFIC
 * reason: a deadlock or a lock-wait timeout would satisfy "exactly one
 * rejected" identically, and "a deadlock passes every sequential test" is the
 * exact failure these tests exist to catch.
 */
function bookTransfer(routeId: number, candidate: Candidate) {
  const params = candidateParams(candidate);
  return getDb().transaction(async (tx) => {
    await takeFleetDateLock(tx, params.date);
    const verdict = await assessTransferCapacity(tx, params);
    if (!verdict.ok) throw new Error(`refused: ${verdict.reason}`);

    const [row] = await tx.insert(bookings).values({
      ref: generateBookingRef(),
      tourId: null,
      productType: params.productType,
      routeId,
      vehicleTypeRequested: params.vehicleType,
      tourDate: new Date(`${params.date}T00:00:00Z`),
      pax: 2,
      leadName: 'Transfer Race Fixture',
      leadEmail: 'race@example.test',
      leadPhone: '09170000000',
      status: 'pending_payment',
      payMode: 'full',
      priceSnapshot: SNAPSHOT,
      subtotalCentavos: 100000,
      totalCentavos: 100000,
    });
    await tx.insert(bookingTransferDetails).values({
      bookingId: row.insertId,
      pickupTime: hhmm(params.pickupTimeMinutes),
      dayUseEndTime:
        params.dayUseEndTimeMinutes === null ? null : hhmm(params.dayUseEndTimeMinutes),
      dropoffAddress: 'Race drop-off',
      bufferMinutesUsed: params.bufferMinutes,
      routeDurationMinutesUsed:
        params.productType === 'transfer_day_use' ? null : params.routeDurationMinutes,
    });
    created.bookingIds.push(row.insertId);
    return row.insertId;
  });
}

/** Capacity-holding TRANSFER bookings on one date — the post-race state. */
function transfersHeldOn(date: string) {
  return count(
    sql`SELECT COUNT(*) n FROM bookings
        WHERE tour_date = ${date} AND product_type <> 'tour'
          AND status IN ('pending_payment', 'pending_verification', 'confirmed', 'assigned', 'in_progress')`,
  );
}

/** The reasons the settled promises of a concurrent pair rejected with. */
function rejectionMessages(results: PromiseSettledResult<unknown>[]) {
  return results
    .filter((r): r is PromiseRejectedResult => r.status === 'rejected')
    .map((r) => (r.reason instanceof Error ? r.reason.message : String(r.reason)));
}

async function cancel(bookingId: number) {
  await getPool().query('UPDATE bookings SET status = ? WHERE id = ?', ['cancelled', bookingId]);
}

describeWithDb('transfer capacity', () => {
  beforeEach(async () => {
    /*
     * These tests count the WHOLE fleet, so a van or driver left behind by
     * another suite would change every number in this file. The seed creates
     * neither (`seedDemo` gates the fleet on the app database), so the premise
     * is an empty fleet — proven rather than assumed.
     */
    expect(await count(sql`SELECT COUNT(*) n FROM vans`), 'leftover vans in rg_travel_test').toBe(
      0,
    );
    expect(
      await count(sql`SELECT COUNT(*) n FROM drivers`),
      'leftover drivers in rg_travel_test',
    ).toBe(0);

    /*
     * Every expectation below is arithmetic over these two seeded values, so a
     * change to the owner's defaults must fail HERE, by name, rather than as a
     * dozen unexplained refusals further down.
     */
    const operations = await readTransferOperationsSettings();
    expect(operations.bufferMinutes, 'the seeded buffer changed').toBe(BUFFER);
    expect(operations.maxTransferJobsPerDriverPerDay, 'the seeded driver cap changed').toBe(
      DEFAULT_DRIVER_CAP,
    );
  });

  afterEach(cleanup);

  // -------------------------------------------------------------------------
  // The vehicle pool — conditions (1), (2) and (3)
  // -------------------------------------------------------------------------

  it('accepts a transfer when a sellable vehicle of that type and a driver are free', async () => {
    await makeVan({ vehicleType: 'van' });
    await makeDriver();

    expect(await assessTransfer({ vehicleType: 'van', pickupMinutes: at(8) })).toEqual({
      ok: true,
    });
  });

  /**
   * The cross-midnight refusal comes FIRST, with no database read at all — and
   * this proves the order rather than asserting it: the fleet here is EMPTY, so
   * a check that read the fleet first would answer `no_vehicle_available`.
   */
  it('refuses a window past midnight before it asks the fleet anything', async () => {
    expect(
      await assessTransfer({
        vehicleType: 'van',
        pickupMinutes: at(23),
        routeDurationMinutes: 180,
      }),
    ).toEqual({ ok: false, reason: 'pickup_crosses_midnight' });
  });

  it('refuses when the only vehicle of that type is claimed by an OVERLAPPING window', async () => {
    const routeId = await makeRoute();
    await makeVan({ vehicleType: 'van' });
    await makeDriver();
    // [08:00, 11:00) — pickup 08:00 + 120 duration + 60 buffer.
    await makeTransferBooking({ routeId, date: DAY, vehicleType: 'van', pickupMinutes: at(8) });

    // [10:00, 13:00) overlaps it, so the peak would be 2 against 1 van.
    expect(await assessTransfer({ vehicleType: 'van', pickupMinutes: at(10) })).toEqual({
      ok: false,
      reason: 'no_vehicle_available',
    });
  });

  /**
   * **"Several jobs a day", which is the owner's whole reason for windows.**
   * The first job ends at 11:00 with its buffer already inside that end, and
   * the second starts at 11:00 — one van serves both.
   */
  it('accepts a BACK-TO-BACK second job on the same single vehicle', async () => {
    const routeId = await makeRoute();
    await makeVan({ vehicleType: 'van' });
    await makeDriver();
    await makeTransferBooking({ routeId, date: DAY, vehicleType: 'van', pickupMinutes: at(8) });

    expect(await assessTransfer({ vehicleType: 'van', pickupMinutes: at(11) })).toEqual({
      ok: true,
    });
    // One minute earlier overlaps, and is refused.
    expect(await assessTransfer({ vehicleType: 'van', pickupMinutes: at(11) - 1 })).toEqual({
      ok: false,
      reason: 'no_vehicle_available',
    });
  });

  it('does not let one vehicle TYPE answer for the other', async () => {
    const routeId = await makeRoute();
    await makeVan({ vehicleType: 'van' });
    await makeDriver();

    // An SUV is asked for and the fleet has none, however free the van is.
    expect(await assessTransfer({ vehicleType: 'suv', pickupMinutes: at(8) })).toEqual({
      ok: false,
      reason: 'no_vehicle_available',
    });

    // And a van-type booking does not raise the SUV peak.
    await makeTransferBooking({ routeId, date: DAY, vehicleType: 'van', pickupMinutes: at(8) });
    await makeVan({ vehicleType: 'suv' });
    expect(await assessTransfer({ vehicleType: 'suv', pickupMinutes: at(9) })).toEqual({
      ok: true,
    });
  });

  it('counts only a van that is active and sellable', async () => {
    await makeRoute();
    await makeDriver();
    const vanId = await makeVan({ vehicleType: 'van', status: 'for_repair' });

    expect(await assessTransfer({ vehicleType: 'van', pickupMinutes: at(8) })).toEqual({
      ok: false,
      reason: 'no_vehicle_available',
    });

    // `VAN_STATUS_SELLABLE` is an allow-list of one, so `on_trip` and `parked`
    // are excluded too, and a soft-deleted van does not count either.
    for (const status of ['on_trip', 'parked']) {
      await getPool().query('UPDATE vans SET status = ? WHERE id = ?', [status, vanId]);
      expect(await assessTransfer({ vehicleType: 'van', pickupMinutes: at(8) }), status).toEqual({
        ok: false,
        reason: 'no_vehicle_available',
      });
    }
    await getPool().query('UPDATE vans SET status = ?, is_active = 0 WHERE id = ?', [
      'available',
      vanId,
    ]);
    expect(await assessTransfer({ vehicleType: 'van', pickupMinutes: at(8) })).toEqual({
      ok: false,
      reason: 'no_vehicle_available',
    });
  });

  /**
   * A transfer's vehicle is the guest's own choice of TYPE, never sized against
   * a party the way a tour's van is — so the sellable count here is deliberately
   * NOT filtered by seats (Architecture §2's raw `vanSellable`). A four-seater
   * counts as a van.
   */
  it('ignores seat capacity for a transfer, unlike the tour gate', async () => {
    await makeRoute();
    await makeVan({ vehicleType: 'van', capacity: 4 });
    await makeDriver();

    expect(await assessTransfer({ vehicleType: 'van', pickupMinutes: at(8) })).toEqual({
      ok: true,
    });
  });

  it('counts only the day asked for, not the days either side', async () => {
    const routeId = await makeRoute();
    await makeVan({ vehicleType: 'van' });
    await makeDriver();
    for (const date of [DAY_BEFORE, DAY_AFTER]) {
      await makeTransferBooking({ routeId, date, vehicleType: 'van', pickupMinutes: at(8) });
    }

    expect(await assessTransfer({ vehicleType: 'van', pickupMinutes: at(8) })).toEqual({
      ok: true,
    });
  });

  it('computes a DAY-USE window from its end time, not the route duration', async () => {
    const routeId = await makeRoute();
    await makeVan({ vehicleType: 'van' });
    await makeDriver();
    // [07:00, 18:00) — 17:00 end + 60 buffer.
    await makeTransferBooking({
      routeId,
      date: DAY,
      vehicleType: 'van',
      productType: 'transfer_day_use',
      pickupMinutes: at(7),
      dayUseEndMinutes: at(17),
    });

    // 14:00 is inside that window even though the route's own duration is 2h.
    expect(await assessTransfer({ vehicleType: 'van', pickupMinutes: at(14) })).toEqual({
      ok: false,
      reason: 'no_vehicle_available',
    });
    // 18:00 is not.
    expect(await assessTransfer({ vehicleType: 'van', pickupMinutes: at(18) })).toEqual({
      ok: true,
    });
  });

  /**
   * **The duration-freeze fix (dedicated review finding C1).** Before this
   * fix, `windowForBookedTransfer` joined `transfer_routes` live, so an admin
   * SHORTENING a route's duration after a booking was taken silently shrank
   * that booking's already-reserved window — the vehicle read as free sooner
   * than it would really be, an oversell. `route_duration_minutes_used` now
   * freezes the duration at hold time, exactly as the buffer already was.
   *
   * One van. Booked at 08:00 with duration 180 + buffer 60 → frozen window
   * `[08:00, 12:00)` (180 duration + 60 buffer). The route is then shortened
   * to 60 minutes. A candidate at 11:00 overlaps the FROZEN window and must
   * still be refused — proving the live catalog edit cannot reach an
   * existing booking's window.
   */
  it('freezes the route duration at hold time — a later shortened route does not free the vehicle early', async () => {
    const routeId = await makeRoute({ durationMinutes: 180 });
    await makeVan({ vehicleType: 'van' });
    await makeDriver();
    await makeTransferBooking({
      routeId,
      date: DAY,
      vehicleType: 'van',
      pickupMinutes: at(8),
      routeDurationMinutes: 180,
    });

    // The admin shortens the catalog route AFTER the booking was taken.
    await getPool().query(
      'UPDATE transfer_routes SET estimated_duration_minutes = ? WHERE id = ?',
      [60, routeId],
    );

    // Un-fixed, the booking's window would recompute to [08:00, 09:00) and
    // let 11:00 through. Fixed, it is still [08:00, 12:00) and refuses it.
    expect(await assessTransfer({ vehicleType: 'van', pickupMinutes: at(11) })).toEqual({
      ok: false,
      reason: 'no_vehicle_available',
    });
    // And a pickup genuinely after the FROZEN window (12:00, back-to-back) still fits.
    expect(await assessTransfer({ vehicleType: 'van', pickupMinutes: at(12) })).toEqual({
      ok: true,
    });
  });

  /**
   * **`windowForBookedTransfer`'s fail-closed branches (dedicated review
   * finding I2).** None of these were exercised before. Each must resolve to
   * the WHOLE DAY rather than silently vanishing — the dangerous direction is
   * UNDER-claiming the fleet, never over-claiming it. Driven through the
   * exported `transferWindowsByType` directly, since the function that does
   * this is private.
   */
  it('counts a transfer with no booking_transfer_details row as occupying the whole day', async () => {
    const routeId = await makeRoute();
    const id = await makeTransferBooking({
      routeId,
      date: DAY,
      vehicleType: 'van',
      pickupMinutes: at(8),
    });
    await getPool().query('DELETE FROM booking_transfer_details WHERE booking_id = ?', [id]);

    const windows = await getDb().transaction((tx) => transferWindowsByType(tx, DAY));
    expect(windows.van).toEqual([{ startMinutes: 0, endMinutes: MINUTES_PER_DAY }]);
  });

  it('counts a transfer with an unreadable pickup_time as occupying the whole day', async () => {
    const routeId = await makeRoute();
    const id = await makeTransferBooking({
      routeId,
      date: DAY,
      vehicleType: 'van',
      pickupMinutes: at(8),
    });
    await getPool().query(
      'UPDATE booking_transfer_details SET pickup_time = ? WHERE booking_id = ?',
      ['99:99', id],
    );

    const windows = await getDb().transaction((tx) => transferWindowsByType(tx, DAY));
    expect(windows.van).toEqual([{ startMinutes: 0, endMinutes: MINUTES_PER_DAY }]);
  });

  it('counts a DAY-USE transfer with no end time as occupying the whole day', async () => {
    const routeId = await makeRoute();
    const id = await makeTransferBooking({
      routeId,
      date: DAY,
      vehicleType: 'van',
      productType: 'transfer_day_use',
      pickupMinutes: at(7),
      dayUseEndMinutes: at(17),
    });
    await getPool().query(
      'UPDATE booking_transfer_details SET day_use_end_time = NULL WHERE booking_id = ?',
      [id],
    );

    const windows = await getDb().transaction((tx) => transferWindowsByType(tx, DAY));
    expect(windows.van).toEqual([{ startMinutes: 0, endMinutes: MINUTES_PER_DAY }]);
  });

  /**
   * A stored row whose FROZEN values push past midnight is clamped to the end
   * of the day, not treated as broken — `[start, 1440)` is exactly the part
   * of the window that falls on this civil date. Unreachable through the real
   * writer once T10 ships (it refuses this at hold time), so this crafts the
   * row directly, as corruption would.
   */
  it('clamps a stored window that runs past midnight to the end of the day, rather than failing', async () => {
    const routeId = await makeRoute({ durationMinutes: 180 });
    await makeTransferBooking({
      routeId,
      date: DAY,
      vehicleType: 'van',
      pickupMinutes: at(23),
      routeDurationMinutes: 180,
      bufferMinutes: 60,
    });

    const windows = await getDb().transaction((tx) => transferWindowsByType(tx, DAY));
    expect(windows.van).toEqual([{ startMinutes: at(23), endMinutes: MINUTES_PER_DAY }]);
  });

  /**
   * **The START boundary of `driver_leaves` (dedicated review finding I3).**
   * The sibling test above only ever shrinks an END date; this is the other
   * edge — a leave that BEGINS on the capacity date must still count it
   * (inclusive), and one that begins the day after must not.
   */
  it('treats a leave range as inclusive on its START date too', async () => {
    await makeRoute();
    await makeVan({ vehicleType: 'van' });
    const driverId = await makeDriver();
    const leaveId = await makeLeave(driverId, DAY, DAY_AFTER);

    expect(await assessTransfer({ vehicleType: 'van', pickupMinutes: at(8) })).toEqual({
      ok: false,
      reason: 'no_driver_available',
    });

    // Pushing the start to tomorrow frees the driver TODAY.
    await getPool().query('UPDATE driver_leaves SET start_date = ? WHERE id = ?', [
      DAY_AFTER,
      leaveId,
    ]);
    expect(await assessTransfer({ vehicleType: 'van', pickupMinutes: at(8) })).toEqual({
      ok: true,
    });
  });

  /**
   * **Condition (3), from the transfer side.** One van, no SUV, and a tour has
   * already taken the day's whole-day vehicle. The candidate transfer's own
   * peak of 1 fits the van fleet (condition 1 passes), but there is then
   * nothing left for the tour — so the day as a whole is infeasible and the
   * transfer is refused. Drivers are deliberately ample, so the refusal can
   * only be the vehicle pool.
   */
  it('refuses a transfer when the day’s tours need the vehicle it would take', async () => {
    await makeVan({ vehicleType: 'van' });
    await makeDriver();
    await makeDriver();
    const tourId = await makeTour();
    const tourBookingId = await makeTourBooking({ tourId, date: DAY });

    expect(await assessTransfer({ vehicleType: 'van', pickupMinutes: at(8) })).toEqual({
      ok: false,
      reason: 'no_vehicle_available',
    });

    // Cancel the tour and the same transfer fits — the tour was the refuser.
    await cancel(tourBookingId);
    expect(await assessTransfer({ vehicleType: 'van', pickupMinutes: at(8) })).toEqual({
      ok: true,
    });
  });

  it('lets a leftover vehicle of the OTHER type cover the day’s tour', async () => {
    await makeRoute();
    await makeVan({ vehicleType: 'van' });
    await makeVan({ vehicleType: 'suv' });
    await makeDriver();
    await makeDriver();
    const tourId = await makeTour();
    await makeTourBooking({ tourId, date: DAY });

    // The van transfer takes the van; the tour can still have the SUV.
    expect(await assessTransfer({ vehicleType: 'van', pickupMinutes: at(8) })).toEqual({
      ok: true,
    });
  });

  // -------------------------------------------------------------------------
  // The driver pool — conditions (4) and (5)
  // -------------------------------------------------------------------------

  it('refuses when the only driver’s daily transfer cap is already used', async () => {
    const routeId = await makeRoute();
    // Two vans, non-overlapping windows: the vehicle gate cannot be the refuser.
    await makeVan({ vehicleType: 'van' });
    await makeVan({ vehicleType: 'van' });
    await makeDriver({ maxTransferJobsPerDay: 1 });
    await makeTransferBooking({ routeId, date: DAY, vehicleType: 'van', pickupMinutes: at(6) });

    expect(await assessTransfer({ vehicleType: 'van', pickupMinutes: at(14) })).toEqual({
      ok: false,
      reason: 'no_driver_available',
    });
  });

  /**
   * **A per-driver override of 0 means "no transfer jobs", not "use the
   * default".** `?? default` versus `|| default` is the whole test: with `||`,
   * this driver would silently be given the seeded default of two.
   */
  it('treats a per-driver cap of ZERO as no transfer jobs at all', async () => {
    await makeRoute();
    await makeVan({ vehicleType: 'van' });
    await makeDriver({ maxTransferJobsPerDay: 0 });

    expect(await assessTransfer({ vehicleType: 'van', pickupMinutes: at(8) })).toEqual({
      ok: false,
      reason: 'no_driver_available',
    });
  });

  it('uses the admin default when a driver has no override', async () => {
    const routeId = await makeRoute();
    for (let i = 0; i < 3; i += 1) await makeVan({ vehicleType: 'van' });
    await makeDriver(); // NULL override -> the seeded default of 2.

    // Two jobs fit the default; the third does not.
    await makeTransferBooking({ routeId, date: DAY, vehicleType: 'van', pickupMinutes: at(6) });
    expect(await assessTransfer({ vehicleType: 'van', pickupMinutes: at(12) })).toEqual({
      ok: true,
    });

    await makeTransferBooking({ routeId, date: DAY, vehicleType: 'van', pickupMinutes: at(12) });
    expect(await assessTransfer({ vehicleType: 'van', pickupMinutes: at(18) })).toEqual({
      ok: false,
      reason: 'no_driver_available',
    });
  });

  it('does not count a driver on leave that day, or one off the roster', async () => {
    await makeRoute();
    await makeVan({ vehicleType: 'van' });
    const driverId = await makeDriver();
    await makeDriver({ isActive: false });
    // DAY_BEFORE..DAY, so the end can later be shrunk to DAY_BEFORE without
    // tripping the `driver_leaves_date_order` CHECK (end >= start).
    const leaveId = await makeLeave(driverId, DAY_BEFORE, DAY);

    expect(await assessTransfer({ vehicleType: 'van', pickupMinutes: at(8) })).toEqual({
      ok: false,
      reason: 'no_driver_available',
    });

    // `driver_leaves` is inclusive at both ends: ending it the day before frees them.
    await getPool().query('UPDATE driver_leaves SET end_date = ? WHERE id = ?', [
      DAY_BEFORE,
      leaveId,
    ]);
    expect(await assessTransfer({ vehicleType: 'van', pickupMinutes: at(8) })).toEqual({
      ok: true,
    });
  });

  it('gives a TOUR a whole driver for the day, not one job unit', async () => {
    await makeRoute();
    await makeVan({ vehicleType: 'van' });
    await makeVan({ vehicleType: 'van' });
    // One driver, default cap 2 — enough for two transfer jobs, or for one tour
    // and nothing else.
    await makeDriver();
    const tourId = await makeTour();
    const tourBookingId = await makeTourBooking({ tourId, date: DAY });

    expect(await assessTransfer({ vehicleType: 'van', pickupMinutes: at(8) })).toEqual({
      ok: false,
      reason: 'no_driver_available',
    });

    await cancel(tourBookingId);
    expect(await assessTransfer({ vehicleType: 'van', pickupMinutes: at(8) })).toEqual({
      ok: true,
    });
  });

  /**
   * **The exchange argument, measured.** Caps are 1 and 3; one tour and two
   * transfer jobs are already booked, and a third transfer is asked for.
   *
   *   tours take the SMALLEST cap  -> leftover 3, and 2 + 1 <= 3 ACCEPTS
   *   tours take the largest cap   -> leftover 1, and 2 + 1 > 1  REFUSES
   *
   * So this test fails against a smallest-last implementation, and it is the
   * only place in the suite that distinguishes the two.
   */
  it('hands tours the SMALLEST-capacity drivers, which leaves the most for transfers', async () => {
    const routeId = await makeRoute();
    for (let i = 0; i < 4; i += 1) await makeVan({ vehicleType: 'van' });
    await makeDriver({ maxTransferJobsPerDay: 1 });
    await makeDriver({ maxTransferJobsPerDay: 3 });
    const tourId = await makeTour();
    await makeTourBooking({ tourId, date: DAY });
    await makeTransferBooking({ routeId, date: DAY, vehicleType: 'van', pickupMinutes: at(6) });
    await makeTransferBooking({ routeId, date: DAY, vehicleType: 'van', pickupMinutes: at(12) });

    expect(await assessTransfer({ vehicleType: 'van', pickupMinutes: at(18) })).toEqual({
      ok: true,
    });
  });

  it('leaves nothing over when there are more tours than drivers', () => {
    // A state reachable from existing data: a driver deactivated after their
    // tour was booked. Zero, never a negative — the caller then refuses.
    expect(leftoverTransferCapacity([2, 2], 2)).toBe(0);
    expect(leftoverTransferCapacity([2, 2], 5)).toBe(0);
    expect(leftoverTransferCapacity([1, 2, 3], 1)).toBe(5);
    expect(leftoverTransferCapacity([], 0)).toBe(0);
    // Ascending is the caller's contract, asserted rather than silently fixed.
    expect(() => leftoverTransferCapacity([3, 1], 1)).toThrow(/ascending/);
  });

  // -------------------------------------------------------------------------
  // The TOUR gate, now sharing the pool
  // -------------------------------------------------------------------------

  /**
   * **The test that proves condition (3) is load-bearing on the tour side.**
   * One van in the whole fleet, and a van-type transfer holds a window across
   * the working day. `vansThatFit - toursToday` is `1 - 0 = 1`, so the
   * pax-filtered gate — the only one this file had before Task T7 — would
   * ACCEPT this tour and sell a trip with no vehicle to run it.
   */
  it('refuses a TOUR when a transfer has already claimed the only vehicle', async () => {
    const routeId = await makeRoute();
    await makeVan({ vehicleType: 'van', capacity: 12 });
    await makeDriver();
    await makeDriver();
    const tourId = await makeTour({ groupsPerDay: 5 });
    const transferId = await makeTransferBooking({
      routeId,
      date: DAY,
      vehicleType: 'van',
      productType: 'transfer_day_use',
      pickupMinutes: at(6),
      dayUseEndMinutes: at(20),
    });

    expect(await assessTour(tourId, DAY, 4)).toEqual({
      ok: false,
      reason: 'no_van_available',
    });

    // Cancel the transfer and the same tour fits: the transfer was the refuser,
    // not the tour's own `groups_per_day` and not the pax filter.
    await cancel(transferId);
    expect(await assessTour(tourId, DAY, 4)).toEqual({ ok: true });
  });

  /**
   * The driver half of the same claim. One driver with a cap of 1, already
   * holding one transfer job: condition (5) with the candidate tour removing
   * that driver from the pool leaves 0 for a job that is already booked.
   * Vehicles are deliberately ample.
   */
  it('refuses a TOUR when the only driver’s transfer jobs are already booked', async () => {
    const routeId = await makeRoute();
    await makeVan({ vehicleType: 'van', capacity: 12 });
    await makeVan({ vehicleType: 'van', capacity: 12 });
    await makeDriver({ maxTransferJobsPerDay: 1 });
    const tourId = await makeTour({ groupsPerDay: 5 });
    const transferId = await makeTransferBooking({
      routeId,
      date: DAY,
      vehicleType: 'van',
      pickupMinutes: at(8),
    });

    expect(await assessTour(tourId, DAY, 4)).toEqual({
      ok: false,
      reason: 'no_driver_available',
    });

    await cancel(transferId);
    expect(await assessTour(tourId, DAY, 4)).toEqual({ ok: true });
  });

  /**
   * And the blended count that used to be here, from the side that exposes it:
   * a TRANSFER booking must not consume a tour's van the way another tour does
   * when it has not actually claimed the vehicle for the whole day. Two vans,
   * one transfer in the morning only, one tour asked for — the old
   * `heldAcrossTheFleet` subtracted the transfer as a whole-day van AND a
   * whole-day driver.
   */
  it('does not charge a tour for a transfer the fleet can still absorb', async () => {
    const routeId = await makeRoute();
    await makeVan({ vehicleType: 'van', capacity: 12 });
    await makeVan({ vehicleType: 'van', capacity: 12 });
    await makeDriver();
    await makeDriver();
    const tourId = await makeTour({ groupsPerDay: 5 });
    await makeTransferBooking({ routeId, date: DAY, vehicleType: 'van', pickupMinutes: at(6) });

    expect(await assessTour(tourId, DAY, 4)).toEqual({ ok: true });
  });

  // -------------------------------------------------------------------------
  // The races
  // -------------------------------------------------------------------------

  /**
   * **Vehicle-short.** One sellable van, no SUVs, and two candidate van-type
   * transfers whose windows OVERLAP — so exactly one can be served. Without the
   * date-level lock both transactions read "peak 0, one van free" and both
   * commit.
   *
   * Driven CONCURRENTLY with `Promise.allSettled`, never sequentially: a
   * sequential pair passes against code with no lock at all, because the first
   * booking is already committed when the second one reads.
   */
  it('serialises two OVERLAPPING transfers for the last vehicle', async () => {
    const routeId = await makeRoute();
    await makeVan({ vehicleType: 'van' });
    await makeDriver({ maxTransferJobsPerDay: 4 });

    const results = await Promise.allSettled([
      bookTransfer(routeId, { vehicleType: 'van', pickupMinutes: at(8) }),
      bookTransfer(routeId, { vehicleType: 'van', pickupMinutes: at(9) }),
    ]);

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    /*
     * The loser must be REFUSED, not killed: a deadlock (`ER_LOCK_DEADLOCK`) or
     * a lock-wait timeout satisfies "exactly one rejected" identically, and the
     * guest-visible difference is "no van free around then" versus a 500.
     */
    expect(rejectionMessages(results)).toEqual(['refused: no_vehicle_available']);
    expect(await transfersHeldOn(DAY), 'the fleet was oversold').toBe(1);
  });

  /**
   * The other direction, and the reason the vehicle check is a PEAK rather than
   * a count: two NON-overlapping windows on one van must BOTH succeed. Without
   * this, "refuse whenever the van is busy that day" would look like a free
   * improvement — it is exactly the whole-day blocking the owner replaced.
   */
  it('does NOT falsely serialise two NON-overlapping transfers on one vehicle', async () => {
    const routeId = await makeRoute();
    await makeVan({ vehicleType: 'van' });
    await makeDriver({ maxTransferJobsPerDay: 4 });

    const results = await Promise.allSettled([
      bookTransfer(routeId, { vehicleType: 'van', pickupMinutes: at(6) }),
      bookTransfer(routeId, { vehicleType: 'van', pickupMinutes: at(14) }),
    ]);

    expect(rejectionMessages(results), 'a transfer that fitted was refused').toEqual([]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(2);
    expect(await transfersHeldOn(DAY)).toBe(2);
  });

  /**
   * **Driver-short.** Vehicles for both (two vans) and windows that do NOT
   * overlap, so the vehicle gate would pass both — the only thing that can
   * refuse one is the driver pool, whose single driver has a cap of one.
   * Architecture §2a is explicit that the hold-time driver check is a job COUNT
   * and not a time-of-day question, which is exactly what non-overlapping
   * windows isolate.
   */
  it('serialises two transfers for the last DRIVER job of the day', async () => {
    const routeId = await makeRoute();
    await makeVan({ vehicleType: 'van' });
    await makeVan({ vehicleType: 'van' });
    await makeDriver({ maxTransferJobsPerDay: 1 });

    const results = await Promise.allSettled([
      bookTransfer(routeId, { vehicleType: 'van', pickupMinutes: at(6) }),
      bookTransfer(routeId, { vehicleType: 'van', pickupMinutes: at(14) }),
    ]);

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(rejectionMessages(results)).toEqual(['refused: no_driver_available']);
    expect(await transfersHeldOn(DAY), 'a driver was overworked past their cap').toBe(1);
  });

  /** And the driver pool must not over-refuse when the day really has room. */
  it('does NOT falsely serialise two transfers when driver capacity covers both', async () => {
    const routeId = await makeRoute();
    await makeVan({ vehicleType: 'van' });
    await makeVan({ vehicleType: 'van' });
    await makeDriver({ maxTransferJobsPerDay: 1 });
    await makeDriver({ maxTransferJobsPerDay: 1 });

    // Overlapping windows this time: two vans, two drivers, one job each.
    const results = await Promise.allSettled([
      bookTransfer(routeId, { vehicleType: 'van', pickupMinutes: at(8) }),
      bookTransfer(routeId, { vehicleType: 'van', pickupMinutes: at(9) }),
    ]);

    expect(rejectionMessages(results), 'a transfer the fleet could run was refused').toEqual([]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(2);
    expect(await transfersHeldOn(DAY)).toBe(2);
  });
});

/**
 * Deletes exactly the rows this file committed, in foreign-key order. Runs
 * after every test — the fleet is not date-scoped, so each test must start from
 * an empty one.
 */
async function cleanup() {
  const pool = getPool();
  for (const id of created.bookingIds) {
    await pool.query('DELETE FROM booking_transfer_details WHERE booking_id = ?', [id]);
    // Raw parameterized SQL, not `db.delete(bookings)` — `schema-conventions
    // .test.ts` scans the tree for the Drizzle form of a bookings hard-delete
    // and exempts only the raw form in a test file.
    await pool.query('DELETE FROM bookings WHERE id = ?', [id]);
  }
  for (const id of created.leaveIds) {
    await pool.query('DELETE FROM driver_leaves WHERE id = ?', [id]);
  }
  for (const id of created.tourIds) {
    await pool.query('DELETE FROM tour_date_slots WHERE tour_id = ?', [id]);
    await pool.query('DELETE FROM tours WHERE id = ?', [id]);
  }
  for (const id of created.routeIds) {
    await pool.query('DELETE FROM transfer_routes WHERE id = ?', [id]);
  }
  for (const id of created.destinationIds) {
    await pool.query('DELETE FROM destinations WHERE id = ?', [id]);
  }
  for (const id of created.driverIds) await pool.query('DELETE FROM drivers WHERE id = ?', [id]);
  for (const id of created.vanIds) await pool.query('DELETE FROM vans WHERE id = ?', [id]);
  for (const day of [DAY_BEFORE, DAY, DAY_AFTER]) {
    await pool.query('DELETE FROM fleet_date_slots WHERE date = ?', [day]);
  }
  created.bookingIds = [];
  created.leaveIds = [];
  created.tourIds = [];
  created.routeIds = [];
  created.destinationIds = [];
  created.driverIds = [];
  created.vanIds = [];
}
