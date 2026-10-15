/**
 * Week 6 plan, Task 12 — `admin.departures.today`, the dispatcher's live
 * board (BUILD_SPEC §9 "Dashboard: today's departures with stop-by-stop
 * progress bars").
 *
 * Five properties, and the first two are the ones that bite:
 *
 *  1. **"Today" is the MANILA civil date.** Manila is UTC+8, so a
 *     UTC-based "today" diverges only between 00:00 and 07:59 Manila — a
 *     fixture outside that window passes against both implementations and
 *     proves nothing. `NOW_0030_MANILA` sits inside it, with one booking
 *     on each of the two candidate days, so the wrong answer is a wrong
 *     ROW rather than a missing one.
 *  2. **An undone check-in counts as NOT reached.** That is the whole
 *     purpose of `trip_checkpoints.undone` (§8: "marked `undone`, not
 *     deleted"), and the row is still there to be counted by anything that
 *     forgets. Asserted as a DROP from a known count, so a board that
 *     counted rows instead of standing check-ins is red here.
 *  3. **The progress is Task 3's `tripProgress`, trip start included.** A
 *     three-stop tour is `0 / 4` before departure and `1 / 4` once the van
 *     leaves. Not adjusted, on either surface.
 *  4. **1 + 2N statements, measured.** One for the day, two per departure
 *     (`tripProgress`'s own two). Pinned at three departures, so a
 *     per-stop query appearing later fails here as well as in
 *     `trip-progress.test.ts`.
 *  5. **All three roles may read it** (§9 gives the Dashboard to owner,
 *     dispatcher and finance alike), and a trip with no van and no driver
 *     still appears — it is the row a dispatcher opens this board to find.
 *
 * The boundary tests call `todayDepartures(now)` directly, because the
 * mounted procedure reads its own clock and must: a client that could send
 * a date could ask to be shown another day as today. The role tests go
 * through the real router, against a booking on the real Manila today.
 *
 * The test database keeps an EMPTY fleet (`capacity.test.ts` counts the
 * whole fleet), so every van and driver this file creates is deleted again
 * in `afterEach`. Nothing here takes a slot lock, so there are no
 * `tour_date_slots` / `fleet_date_slots` rows to sweep.
 */
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { manilaCivilDate, type AdminRole, type PriceSnapshot } from '@rg/shared';
import { appRouter } from '../routers/_app';
import { todayDepartures } from '../routers/admin/departures';
import { getDb, getPool } from '../db/client';
import {
  bookings,
  destinations,
  drivers,
  tourItineraryStops,
  tours,
  tripCheckpoints,
  users,
  vans,
} from '../db/schema';
import { generateBookingRef } from '../services/booking-ref';
import { staffContext, testContext } from './helpers/ctx';
import { describeWithDb } from './helpers/db';

/**
 * 00:30 on 2026-03-10 in Manila — and still 2026-03-09 in UTC.
 *
 * The same instant `driver-cash.test.ts` stands on, and for the same
 * reason: this is the only part of the day where "today" has two possible
 * answers, so it is the only part of the day where the test can tell which
 * one the code picked.
 */
const NOW_0030_MANILA = new Date('2026-03-09T16:30:00Z');
const MANILA_TODAY = '2026-03-10';
const UTC_TODAY = '2026-03-09';

/** Random first, timestamp second — same discipline as capacity.test.ts. */
const unique = () => `${Math.floor(Math.random() * 1e9)}_${Date.now()}`;

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

const apiFor = (userId: number, role: AdminRole) =>
  appRouter.createCaller(staffContext(userId, role) as never);

let tourId = 0;
let tourTitle = '';
/** The three itinerary stops, keyed by the name they carry. */
let stopIds: Record<'First' | 'Second' | 'Third', number>;
let vanId = 0;
let vanPlate = '';
let driverId = 0;
let driverName = '';
let owner = 0;
let dispatcher = 0;
let finance = 0;

async function makeStaff(role: AdminRole) {
  const suffix = unique();
  const [row] = await getDb()
    .insert(users)
    .values({
      name: `Departures ${role} ${suffix}`,
      email: `departures_${suffix}@example.test`,
      passwordHash: '__departures_not_a_hash__',
      role,
      isActive: true,
    });
  created.userIds.push(row.insertId);
  return row.insertId;
}

async function makeBooking(opts: {
  tourDate: string;
  status?: 'confirmed' | 'assigned' | 'in_progress' | 'completed' | 'cancelled' | 'expired';
  withFleet?: boolean;
}) {
  const ref = generateBookingRef();
  const [booking] = await getDb()
    .insert(bookings)
    .values({
      ref,
      tourId,
      tourDate: new Date(`${opts.tourDate}T00:00:00Z`),
      pax: 2,
      leadName: 'Departures Fixture',
      leadEmail: 'departures@example.test',
      leadPhone: '09170000000',
      status: opts.status ?? 'assigned',
      payMode: 'full',
      priceSnapshot: SNAPSHOT,
      subtotalCentavos: 100000,
      totalCentavos: 100000,
      vanId: opts.withFleet === false ? null : vanId,
      driverId: opts.withFleet === false ? null : driverId,
    });
  created.bookingIds.push(booking.insertId);
  return { id: booking.insertId, ref };
}

/**
 * A `trip_checkpoints` row, written directly.
 *
 * `checked_at` is left to the column's own default — no test here cares
 * when the tap happened, only whether it stands — and a direct insert is
 * also the only way to build an UNDONE row without driving the driver
 * portal's undo mutation through a session this file does not have.
 */
async function checkIn(bookingId: number, stopId: number | null, opts?: { undone?: boolean }) {
  await getDb()
    .insert(tripCheckpoints)
    .values({
      bookingId,
      stopId,
      undone: opts?.undone ?? false,
      undoneAt: opts?.undone ? new Date() : null,
    });
}

describeWithDb('admin.departures.today', () => {
  beforeAll(async () => {
    owner = await makeStaff('owner');
    dispatcher = await makeStaff('dispatcher');
    finance = await makeStaff('finance');
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
    // The same sanity check `dispatch-assign.test.ts` opens with: a van or
    // driver left behind by another suite would appear on this board.
    expect(await count(sql`SELECT COUNT(*) n FROM vans`), 'leftover vans in rg_travel_test').toBe(
      0,
    );
    expect(
      await count(sql`SELECT COUNT(*) n FROM drivers`),
      'leftover drivers in rg_travel_test',
    ).toBe(0);

    const db = getDb();
    const slug = `__departures__${unique()}`;
    const [destination] = await db.insert(destinations).values({ name: slug, slug });
    created.destIds.push(destination.insertId);

    tourTitle = `Departures Tour ${slug}`;
    const [tour] = await db
      .insert(tours)
      .values({ slug, title: tourTitle, destinationId: destination.insertId, isActive: true });
    created.tourIds.push(tour.insertId);
    tourId = tour.insertId;

    /*
     * Inserted THIRD, FIRST, SECOND, exactly as `trip-progress.test.ts`
     * does: `tour_itinerary_stops.id` is AUTO_INCREMENT, so insertion
     * order is id order and the two orders now disagree. Three stops plus
     * trip start is the `0 / 4` this file's progress assertions are built
     * on.
     */
    const insertStop = async (name: string, sortOrder: number) => {
      const [row] = await db
        .insert(tourItineraryStops)
        .values({ tourId: tour.insertId, sortOrder, name });
      return row.insertId;
    };
    const third = await insertStop('Third', 3);
    const first = await insertStop('First', 1);
    const second = await insertStop('Second', 2);
    stopIds = { First: first, Second: second, Third: third };

    vanPlate = `DEP${unique()}`.slice(0, 20);
    const [van] = await db.insert(vans).values({
      plate: vanPlate,
      model: 'Departures Fixture Van',
      capacity: 12,
      status: 'available',
      isActive: true,
    });
    created.vanIds.push(van.insertId);
    vanId = van.insertId;

    const suffix = unique();
    driverName = `Departures Driver ${suffix}`;
    const [driver] = await db.insert(drivers).values({
      name: driverName,
      code: `DEP${suffix}`.slice(0, 20),
      phone: '09170000000',
      // Not a real hash: nothing in this file signs in as a driver.
      pinHash: '__departures_not_a_pin_hash__',
      isActive: true,
    });
    created.driverIds.push(driver.insertId);
    driverId = driver.insertId;
  }, 30_000);

  afterEach(async () => {
    vi.restoreAllMocks();
    const pool = getPool();
    for (const id of created.bookingIds) {
      await pool.query('DELETE FROM trip_checkpoints WHERE booking_id = ?', [id]);
      await pool.query('DELETE FROM bookings WHERE id = ?', [id]);
    }
    for (const id of created.tourIds) {
      await pool.query('DELETE FROM tour_itinerary_stops WHERE tour_id = ?', [id]);
      await pool.query('DELETE FROM tours WHERE id = ?', [id]);
    }
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

  /* ---------------------------------------------------------------- *
   * 1. The Manila civil date
   * ---------------------------------------------------------------- */

  it('lists the trip on the MANILA day at 00:30, not the one on the UTC day', async () => {
    const manila = await makeBooking({ tourDate: MANILA_TODAY });
    const utc = await makeBooking({ tourDate: UTC_TODAY });

    const board = await todayDepartures(NOW_0030_MANILA);

    // Both directions. A query that answered for the UTC day would hold
    // the OTHER booking, so asserting only presence would pass either way.
    expect(board.map((d) => d.ref)).toEqual([manila.ref]);
    expect(board.map((d) => d.ref)).not.toContain(utc.ref);
  });

  it('is empty when nothing departs on the Manila day', async () => {
    await makeBooking({ tourDate: UTC_TODAY });
    expect(await todayDepartures(NOW_0030_MANILA)).toEqual([]);
  });

  /* ---------------------------------------------------------------- *
   * 2. Progress — and the undone check-in
   * ---------------------------------------------------------------- */

  it('reads 0 of 4 for a three-stop trip that has not left yet', async () => {
    await makeBooking({ tourDate: MANILA_TODAY });

    const [departure] = await todayDepartures(NOW_0030_MANILA);

    expect(departure!.progress.done).toBe(0);
    // Four, not three: trip start is a stop on this list, which is what
    // makes the bar move when the van leaves.
    expect(departure!.progress.total).toBe(4);
    expect(departure!.progress.stops.map((stop) => stop.name)).toEqual([
      'Start trip',
      'First',
      'Second',
      'Third',
    ]);
  });

  it('reads 2 of 4 once the van has left and reached one stop', async () => {
    const booking = await makeBooking({ tourDate: MANILA_TODAY, status: 'in_progress' });
    await checkIn(booking.id, null);
    await checkIn(booking.id, stopIds.First);

    const [departure] = await todayDepartures(NOW_0030_MANILA);

    expect(departure!.progress.done).toBe(2);
    expect(departure!.progress.total).toBe(4);
    expect(departure!.status).toBe('in_progress');
  });

  it('drops the count back when a check-in is retracted', async () => {
    const booking = await makeBooking({ tourDate: MANILA_TODAY, status: 'in_progress' });
    await checkIn(booking.id, null);
    await checkIn(booking.id, stopIds.First);
    await checkIn(booking.id, stopIds.Second);

    const before = await todayDepartures(NOW_0030_MANILA);
    expect(before[0]!.progress.done, 'three standing check-ins').toBe(3);

    // The retraction §8 describes: the row stays, marked `undone`.
    await getDb().execute(
      sql`UPDATE trip_checkpoints SET undone = 1, undone_at = NOW()
          WHERE booking_id = ${booking.id} AND stop_id = ${stopIds.Second}`,
    );

    const after = await todayDepartures(NOW_0030_MANILA);
    // Three rows in the table, two of them standing. A board that counted
    // rows would still say three.
    expect(after[0]!.progress.done).toBe(2);
    expect(after[0]!.progress.total).toBe(4);
    // And the retraction is still VISIBLE, not erased — §8 keeps the row
    // so a dispatcher can see that something happened there.
    const retracted = after[0]!.progress.stops.find((stop) => stop.stopId === stopIds.Second);
    expect(retracted!.undone).toBe(true);
    expect(retracted!.checkedAt).not.toBeNull();
  });

  it('reads 4 of 4 for a trip whose every stop is ticked', async () => {
    const booking = await makeBooking({ tourDate: MANILA_TODAY, status: 'completed' });
    await checkIn(booking.id, null);
    await checkIn(booking.id, stopIds.First);
    await checkIn(booking.id, stopIds.Second);
    await checkIn(booking.id, stopIds.Third);

    const [departure] = await todayDepartures(NOW_0030_MANILA);

    expect(departure!.progress.done).toBe(4);
    expect(departure!.progress.total).toBe(4);
    // A trip that finished this morning is still one of today's
    // departures — see the module doc on the router.
    expect(departure!.status).toBe('completed');
  });

  /* ---------------------------------------------------------------- *
   * 3. What each row carries, and what is left out
   * ---------------------------------------------------------------- */

  it('names the tour, the driver and the van plate', async () => {
    const booking = await makeBooking({ tourDate: MANILA_TODAY });

    const [departure] = await todayDepartures(NOW_0030_MANILA);

    expect(departure).toMatchObject({
      bookingId: booking.id,
      ref: booking.ref,
      tourTitle,
      driverName,
      vanPlate,
      status: 'assigned',
    });
  });

  it('still shows a trip with no van and no driver assigned', async () => {
    const booking = await makeBooking({
      tourDate: MANILA_TODAY,
      status: 'confirmed',
      withFleet: false,
    });

    const [departure] = await todayDepartures(NOW_0030_MANILA);

    // The row a dispatcher opens this board to find. An inner join on
    // vans or drivers would have silently dropped it.
    expect(departure!.ref).toBe(booking.ref);
    expect(departure!.driverName).toBeNull();
    expect(departure!.vanPlate).toBeNull();
  });

  it('leaves out a cancelled trip and one whose hold expired', async () => {
    const live = await makeBooking({ tourDate: MANILA_TODAY });
    const cancelled = await makeBooking({ tourDate: MANILA_TODAY, status: 'cancelled' });
    const expired = await makeBooking({ tourDate: MANILA_TODAY, status: 'expired' });

    const refs = (await todayDepartures(NOW_0030_MANILA)).map((d) => d.ref);

    expect(refs).toEqual([live.ref]);
    expect(refs).not.toContain(cancelled.ref);
    expect(refs).not.toContain(expired.ref);
  });

  it('carries no guest name, phone or e-mail', async () => {
    await makeBooking({ tourDate: MANILA_TODAY });

    const [departure] = await todayDepartures(NOW_0030_MANILA);

    // RA 10173: a board polled every fifteen seconds on an office screen
    // is the wrong place for personal data, and the booking detail page is
    // one click away. Asserted on the KEYS, so a field added later is
    // caught rather than a value this test happened to look for.
    expect(Object.keys(departure!).sort()).toEqual([
      'bookingId',
      'driverName',
      'progress',
      'ref',
      'status',
      'tourTitle',
      'vanPlate',
    ]);
  });

  /* ---------------------------------------------------------------- *
   * 4. The statement count
   * ---------------------------------------------------------------- */

  it('issues one statement for the day plus two per departure', async () => {
    const first = await makeBooking({ tourDate: MANILA_TODAY });
    await makeBooking({ tourDate: MANILA_TODAY });
    await makeBooking({ tourDate: MANILA_TODAY });
    await checkIn(first.id, null);

    const pool = getPool();
    const query = vi.spyOn(pool, 'query');
    const execute = vi.spyOn(pool, 'execute');

    const board = await todayDepartures(NOW_0030_MANILA);

    expect(board).toHaveLength(3);
    /*
     * 1 + 2×3. The accepted cost, measured rather than asserted in prose:
     * one statement for the day, then `tripProgress`'s own two per
     * departure. A per-stop query appearing inside `tripProgress` later
     * would make this 1 + 3×(1 + stops) and fail here.
     */
    expect(query.mock.calls.length + execute.mock.calls.length).toBe(7);
  });

  /* ---------------------------------------------------------------- *
   * 5. Who may read it
   * ---------------------------------------------------------------- */

  it('answers owner, dispatcher and finance alike', async () => {
    // Through the MOUNTED procedure, which reads its own clock — so this
    // fixture sits on the real Manila today rather than the boundary
    // instant the pure function is tested with.
    const booking = await makeBooking({ tourDate: manilaCivilDate(new Date()) });

    for (const [userId, role] of [
      [owner, 'owner'],
      [dispatcher, 'dispatcher'],
      [finance, 'finance'],
    ] as const) {
      const board = await apiFor(userId, role).admin.departures.today();
      expect(
        board.map((d) => d.ref),
        `${role} could not read the board`,
      ).toContain(booking.ref);
    }
  });

  it('refuses a caller with no session', async () => {
    const anonymous = appRouter.createCaller(testContext() as never);
    await expect(anonymous.admin.departures.today()).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    });
  });
});
