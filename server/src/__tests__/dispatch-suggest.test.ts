/**
 * Week 5 "Dispatch", Task 11: `admin.dispatch.suggest` / `suggestAssignment`
 * — auto-suggest.
 *
 * Fixtures are COMMITTED and cleaned up per test, same discipline as
 * `dispatch-assign.test.ts` and `dispatch-availability.test.ts`: `vans` and
 * `drivers` are not scoped to a date, so a row left behind here changes what
 * every other dispatch suite's availability queries see.
 *
 * This suite never writes through `suggestAssignment` itself — that is the
 * whole point of the module — so most tests need no `bookings`/`tours`
 * cleanup beyond what they created directly. The one test that calls
 * `admin.dispatch.assign` (to prove suggest and assign agree) cleans up the
 * slot rows that mutation leaves behind, exactly as `dispatch-assign.test.ts`
 * does.
 */
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import type { BookingStatus, PriceSnapshot } from '@rg/shared';
import { appRouter } from '../routers/_app';
import { getDb, getPool } from '../db/client';
import { bookings, destinations, drivers, tours, users, vans } from '../db/schema';
import { generateBookingRef } from '../services/booking-ref';
import { suggestAssignment } from '../services/dispatch/suggest';
import { staffContext } from './helpers/ctx';
import { describeWithDb } from './helpers/db';

/** Far enough out that no seed or other suite's fixture owns it. */
const TOUR_DATE = '2099-10-20';

/** Civil-date arithmetic in UTC, same anchor as `@rg/shared`'s `addCivilDays`
 *  (not exported) — this file needs it only to place "nearby trip" fixtures
 *  inside/outside the seven-day window, nothing production code consumes. */
function addDays(date: string, days: number): string {
  const [year, month, day] = date.split('-').map(Number) as [number, number, number];
  const moved = new Date(Date.UTC(year, month - 1, day) + days * 86_400_000);
  return [
    moved.getUTCFullYear(),
    String(moved.getUTCMonth() + 1).padStart(2, '0'),
    String(moved.getUTCDate()).padStart(2, '0'),
  ].join('-');
}

/** Random first, timestamp second — same discipline as capacity.test.ts. */
const unique = () => `${Math.floor(Math.random() * 1e9)}_${Date.now()}`;

/** Every id/date this file commits, so `afterEach` removes exactly those rows. */
const created = {
  bookingIds: [] as number[],
  tourIds: [] as number[],
  destIds: [] as number[],
  vanIds: [] as number[],
  driverIds: [] as number[],
  dates: new Set<string>(),
};

async function count(statement: Parameters<ReturnType<typeof getDb>['execute']>[0]) {
  const [rows] = (await getDb().execute(statement)) as unknown as [Array<{ n: number }>, unknown];
  return Number(rows[0]?.n ?? -1);
}

async function makeTour() {
  const db = getDb();
  const slug = `__dispsuggest__${unique()}`;
  const [destination] = await db.insert(destinations).values({ name: slug, slug });
  created.destIds.push(destination.insertId);
  const [tour] = await db
    .insert(tours)
    .values({ slug, title: slug, destinationId: destination.insertId, isActive: true });
  created.tourIds.push(tour.insertId);
  return tour.insertId;
}

async function makeVan(opts: { capacity?: number } = {}) {
  const suffix = unique();
  const [van] = await getDb()
    .insert(vans)
    .values({
      plate: `DSG${suffix}`.slice(0, 20),
      model: 'Suggest Fixture Van',
      capacity: opts.capacity ?? 12,
      status: 'available',
      isActive: true,
    });
  created.vanIds.push(van.insertId);
  return van.insertId;
}

/** `namePrefix` lets a test pin alphabetical order ("AAA…" / "BBB…")
 *  deliberately, independent of the random uniqueness suffix. */
async function makeDriver(namePrefix = 'Suggest Fixture Driver') {
  const suffix = unique();
  const [driver] = await getDb()
    .insert(drivers)
    .values({
      name: `${namePrefix} ${suffix}`,
      code: `DSG${suffix}`.slice(0, 20),
      phone: '09170000000',
      // Not a real hash: nothing here logs in.
      pinHash: '__dispsuggest_not_a_pin_hash__',
      isActive: true,
    });
  created.driverIds.push(driver.insertId);
  return driver.insertId;
}

async function makeStaff(role: 'owner' | 'dispatcher' | 'finance') {
  const suffix = unique();
  const [row] = await getDb()
    .insert(users)
    .values({
      name: `Dispatch Suggest ${role} ${suffix}`,
      email: `dispsuggest_${role}_${suffix}@example.test`,
      passwordHash: '__dispsuggest_not_a_hash__',
      role,
      isActive: true,
    });
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
  pax?: number;
  status?: BookingStatus;
  tourDate?: string;
  driverId?: number | null;
  vanId?: number | null;
}) {
  const date = opts.tourDate ?? TOUR_DATE;
  created.dates.add(date);
  const [booking] = await getDb()
    .insert(bookings)
    .values({
      ref: generateBookingRef(),
      tourId: opts.tourId,
      tourDate: new Date(`${date}T00:00:00Z`),
      pax: opts.pax ?? 2,
      leadName: 'Dispatch Suggest Fixture',
      leadEmail: 'dispsuggest@example.test',
      leadPhone: '09170000000',
      status: opts.status ?? 'confirmed',
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

/** `vanId`, `driverId`, `status` — the fields a stray write would touch. */
async function bookingSnapshot(id: number) {
  const [row] = await getDb()
    .select({ vanId: bookings.vanId, driverId: bookings.driverId, status: bookings.status })
    .from(bookings)
    .where(eq(bookings.id, id));
  return row;
}

let dispatcherId = 0;

beforeAll(async () => {
  dispatcherId = await makeStaff('dispatcher');
}, 60_000);

afterAll(async () => {
  const pool = getPool();
  await pool.query('DELETE FROM sessions WHERE subject_type = ? AND subject_id = ?', [
    'user',
    dispatcherId,
  ]);
  await pool.query('DELETE FROM users WHERE id = ?', [dispatcherId]);
});

describeWithDb('admin.dispatch.suggest / suggestAssignment', () => {
  beforeEach(async () => {
    // Same sanity check `dispatch-assign.test.ts` / `dispatch-availability.test.ts`
    // open with: a van or driver left behind by another suite would change
    // what this file's availability reads see.
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
    // Harmless no-op for every test that never calls `assign()`; the one
    // that does leaves exactly these rows behind (see its own comment).
    for (const id of created.tourIds) {
      await pool.query('DELETE FROM tour_date_slots WHERE tour_id = ?', [id]);
    }
    for (const date of created.dates) {
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
    created.dates.clear();
  });

  it('suggests the smallest van that fits, not the first one', async () => {
    // Fleet: 6-seater, 10-seater, 15-seater. Group of 7.
    const tourId = await makeTour();
    await makeVan({ capacity: 6 });
    await makeVan({ capacity: 10 });
    await makeVan({ capacity: 15 });
    await makeDriver();
    const bookingFor7 = await makeBooking({ tourId, pax: 7, status: 'confirmed' });

    const { van } = await getDb().transaction((tx) => suggestAssignment(tx, bookingFor7));
    expect(van?.capacity).toBe(10);
  });

  it('suggests nothing, with a reason, when no van fits', async () => {
    const tourId = await makeTour();
    await makeVan({ capacity: 6 });
    await makeDriver();
    const bookingFor99 = await makeBooking({ tourId, pax: 99, status: 'confirmed' });

    const result = await getDb().transaction((tx) => suggestAssignment(tx, bookingFor99));
    expect(result).toMatchObject({ van: null, note: 'no_van_fits' });
  });

  it('spreads work: suggests the free driver with the fewest nearby trips', async () => {
    // driverA has 2 assigned trips in the window, driverB has none.
    // "AAA"/"BBB" prefixes pin alphabetical order deliberately: driverA
    // sorts FIRST by name, so a buggy `freeDrivers[0]` pick (no load count)
    // would land on driverA — the wrong, busier driver — rather than
    // accidentally agreeing with the correct answer.
    const tourId = await makeTour();
    await makeVan({ capacity: 10 });
    const driverA = await makeDriver('AAA Suggest Spread Driver');
    const driverB = await makeDriver('BBB Suggest Spread Driver');

    await makeBooking({
      tourId,
      pax: 2,
      status: 'confirmed',
      tourDate: addDays(TOUR_DATE, -2),
      driverId: driverA,
    });
    await makeBooking({
      tourId,
      pax: 2,
      status: 'assigned',
      tourDate: addDays(TOUR_DATE, 2),
      driverId: driverA,
    });

    const bookingId = await makeBooking({ tourId, pax: 4, status: 'confirmed' });

    const { driver } = await getDb().transaction((tx) => suggestAssignment(tx, bookingId));
    expect(driver?.id).toBe(driverB);
  });

  it('breaks a tie by name so the suggestion is stable across calls', async () => {
    const tourId = await makeTour();
    await makeVan({ capacity: 10 });
    await makeDriver('AAA Suggest Tie Driver');
    await makeDriver('BBB Suggest Tie Driver');
    const bookingId = await makeBooking({ tourId, pax: 4, status: 'confirmed' });

    const first = await getDb().transaction((tx) => suggestAssignment(tx, bookingId));
    const second = await getDb().transaction((tx) => suggestAssignment(tx, bookingId));
    expect(first.driver?.id).toBe(second.driver?.id);
  });

  it('never suggests a van or driver that assign() would refuse', async () => {
    // The property that matters: suggest and assign must agree, because a
    // suggestion the mutation rejects makes the button look broken.
    //
    // NO `if (s.van && s.driver)` GUARD AROUND THE ASSERTION. An earlier draft
    // of this test wrapped the body in exactly that condition, which makes the
    // test pass by asserting NOTHING the moment `suggestAssignment` returns
    // nulls — and returning nulls is the most likely way for it to be broken.
    // The fixture guarantees a free van and a free driver, so nulls here are a
    // failure, and the two assertions below say so out loud before the
    // agreement is checked at all.
    const tourId = await makeTour();
    await makeVan({ capacity: 4 });
    await makeDriver();
    const bookingId = await makeBooking({ tourId, pax: 2, status: 'confirmed' });

    const s = await getDb().transaction((tx) => suggestAssignment(tx, bookingId));
    expect(s.van, 'fixture guarantees a free van; a null here is the bug').not.toBeNull();
    expect(s.driver, 'fixture guarantees a free driver; a null here is the bug').not.toBeNull();

    const api = appRouter.createCaller(staffContext(dispatcherId, 'dispatcher') as never);
    await expect(
      api.admin.dispatch.assign({ bookingId, vanId: s.van!.id, driverId: s.driver!.id }),
    ).resolves.toEqual({ ok: true });
  });

  it('writes nothing at all', async () => {
    const tourId = await makeTour();
    await makeVan({ capacity: 4 });
    await makeDriver();
    const bookingId = await makeBooking({ tourId, pax: 2, status: 'confirmed' });

    const before = await bookingSnapshot(bookingId);
    expect(before).toMatchObject({ vanId: null, driverId: null, status: 'confirmed' });

    await getDb().transaction((tx) => suggestAssignment(tx, bookingId));
    expect(await bookingSnapshot(bookingId)).toEqual(before);
  });

  /**
   * A stale booking id is a refusal, not a 500 (controller fix,
   * 2026-10-15). Reachable in ordinary use: a bookmarked day, a second tab,
   * a trip someone else cancelled while this screen sat open.
   *
   * It matches `admin.calendar.dayOptions`, which the same screen calls on
   * every day selection and which already answers NOT_FOUND — so the UI has
   * one behaviour to handle rather than two.
   */
  it('refuses a booking id that does not exist, as NOT_FOUND rather than a 500', async () => {
    const api = appRouter.createCaller(staffContext(dispatcherId, 'dispatcher') as never);
    await expect(api.admin.dispatch.suggest({ bookingId: 99_999_999 })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });
});
