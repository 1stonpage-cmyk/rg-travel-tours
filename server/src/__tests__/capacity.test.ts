/**
 * Week 3 checkout plan, Task 4: the capacity service.
 *
 * Two functions, and the hard part is not the arithmetic — it is the
 * LOCKING. §5's rule is
 * `MIN(tour.groups_per_day, vans free that day across all tours)`, and the
 * "across all tours" half cannot be enforced by a per-tour lock: two
 * bookings for DIFFERENT tours on the same date lock different
 * `tour_date_slots` rows, never wait for each other, and both take the last
 * van. Hence `fleet_date_slots(date)` and a fixed lock order — fleet first,
 * tour second, no exceptions.
 *
 * **Why the fixtures here are COMMITTED, and cleaned up per test.**
 *
 * The sibling schema suites (`schema-fleet.test.ts`, `schema-trips.test.ts`)
 * build everything inside one transaction they always roll back, which is
 * the cheapest possible isolation. That is not usable here for two reasons:
 *
 *  1. The concurrency test needs TWO genuinely in-flight transactions, which
 *     means two connections, which means committed state — a row inside an
 *     uncommitted transaction is invisible to the other connection, so a
 *     rolled-back fixture would make both bookings see an empty fleet and
 *     the test would pass against code with no lock at all. That is exactly
 *     the trap this task exists to avoid.
 *  2. `vans` and `drivers` are NOT scoped to a date — the capacity rule
 *     counts the whole fleet — so every test here depends on the fleet
 *     being exactly what it built. Fixtures are therefore torn down after
 *     EVERY test (`afterEach`), not once at the end, so each test starts
 *     from an empty fleet.
 *
 * And the fleet is built here rather than read out of the seed: the seed has
 * no vans and no drivers at all, so a test that looked for "any van" would
 * find none and pass vacuously. `beforeEach` proves that premise rather than
 * assuming it — a van or driver left behind by another suite would change
 * every count in this file.
 *
 * Nothing in this file deletes a booking that production code created; the
 * teardown deletes exactly the ids this file committed, in `rg_travel_test`
 * only (`per-file-setup.ts` proves the connection with a real
 * `SELECT DATABASE()` before the first test).
 */
import { afterEach, beforeEach, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import {
  BOOKING_STATUSES,
  CAPACITY_HOLDING_STATUSES,
  type BookingStatus,
  type PriceSnapshot,
} from '@rg/shared';
import { getDb, getPool, type Transaction } from '../db/client';
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
import { assessCapacity, takeSlotLocks } from '../services/capacity';
import { describeWithDb } from './helpers/db';

/** The tour day every test uses, far enough out that no seed or fixture owns it. */
const DAY = '2099-11-05';
const DAY_BEFORE = '2099-11-04';
const DAY_AFTER = '2099-11-06';

/** Every id this file committed, so teardown removes exactly those rows. */
const created = {
  bookingIds: [] as number[],
  tourIds: [] as number[],
  destinationIds: [] as number[],
  vanIds: [] as number[],
  driverIds: [] as number[],
  leaveIds: [] as number[],
};

/**
 * RANDOM FIRST, timestamp second. `vans.plate` and `drivers.code` are
 * `varchar(20)`, so a prefix + a 13-digit millisecond timestamp leaves only
 * about three random digits — and the four-van loop below creates several
 * fixtures inside the same millisecond, which made a duplicate-key flake a
 * one-in-a-thousand event. With the random part in front, truncation keeps
 * the entropy.
 */
const unique = () => `${Math.floor(Math.random() * 1e9)}_${Date.now()}`;

/**
 * The five statuses that hold capacity, as a SQL list — interpolated from
 * the shared constant rather than written out, so a sixth status cannot
 * silently narrow what a test looks for.
 */
const HOLDING_STATUSES_SQL = sql.join(
  CAPACITY_HOLDING_STATUSES.map((status) => sql`${status}`),
  sql`, `,
);

async function count(statement: Parameters<ReturnType<typeof getDb>['execute']>[0]) {
  const [rows] = (await getDb().execute(statement)) as unknown as [Array<{ n: number }>, unknown];
  return Number(rows[0]?.n ?? -1);
}

/** A tour, plus the destination its foreign key needs. */
async function makeTour(opts: { groupsPerDay?: number; isActive?: boolean } = {}) {
  const db = getDb();
  const slug = `__cap__${unique()}`;
  const [destination] = await db.insert(destinations).values({ name: slug, slug });
  created.destinationIds.push(destination.insertId);
  const [tour] = await db.insert(tours).values({
    slug,
    title: slug,
    destinationId: destination.insertId,
    groupsPerDay: opts.groupsPerDay ?? 1,
    isActive: opts.isActive ?? true,
  });
  created.tourIds.push(tour.insertId);
  return tour.insertId;
}

async function makeVan(
  opts: {
    capacity?: number;
    status?: (typeof VAN_STATUSES)[number];
    isActive?: boolean;
  } = {},
) {
  const suffix = unique();
  const [van] = await getDb()
    .insert(vans)
    .values({
      plate: `CAP${suffix}`.slice(0, 20),
      model: 'Capacity Fixture Van',
      capacity: opts.capacity ?? 12,
      status: opts.status ?? 'available',
      isActive: opts.isActive ?? true,
    });
  created.vanIds.push(van.insertId);
  return van.insertId;
}

async function makeDriver(opts: { isActive?: boolean } = {}) {
  const suffix = unique();
  const [driver] = await getDb()
    .insert(drivers)
    .values({
      name: `Capacity Fixture Driver ${suffix}`,
      code: `CAP${suffix}`.slice(0, 20),
      phone: '09170000000',
      // Not a real hash and not a real PIN: nothing here logs in.
      pinHash: '__capacity_not_a_pin_hash__',
      isActive: opts.isActive ?? true,
    });
  created.driverIds.push(driver.insertId);
  return driver.insertId;
}

/** A leave covering `startDate`..`endDate`, INCLUSIVE at both ends. */
async function makeLeave(driverId: number, startDate: string, endDate: string) {
  const [leave] = await getDb()
    .insert(driverLeaves)
    .values({
      driverId,
      startDate: new Date(`${startDate}T00:00:00Z`),
      endDate: new Date(`${endDate}T00:00:00Z`),
    });
  created.leaveIds.push(leave.insertId);
  return leave.insertId;
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
 * midnight — the way Drizzle's `date` column wants it — while the service
 * under test compares civil-date STRINGS. That mismatch is deliberate: if
 * either side shifted a day at midnight, the adjacent-day test below would
 * catch it.
 */
async function makeBooking(opts: {
  tourId: number;
  date: string;
  pax?: number;
  status?: BookingStatus;
}) {
  const [booking] = await getDb()
    .insert(bookings)
    .values({
      ref: generateBookingRef(),
      tourId: opts.tourId,
      tourDate: new Date(`${opts.date}T00:00:00Z`),
      pax: opts.pax ?? 2,
      leadName: 'Capacity Fixture',
      leadEmail: 'fixture@example.test',
      leadPhone: '09170000000',
      status: opts.status ?? 'pending_payment',
      payMode: 'full',
      priceSnapshot: SNAPSHOT,
      subtotalCentavos: 100000,
      totalCentavos: 100000,
    });
  created.bookingIds.push(booking.insertId);
  return booking.insertId;
}

/**
 * The call under test, as `createHold()` will make it (Task 5): one
 * transaction, both locks in the fixed order, then the verdict.
 */
function assess(tourId: number, date: string, pax: number) {
  return getDb().transaction(async (tx) => {
    await takeSlotLocks(tx, tourId, date);
    return assessCapacity(tx, tourId, date, pax);
  });
}

/**
 * One tour with room, one big van, one free driver — the state every
 * refusal test below starts from and then breaks in exactly one way.
 */
async function aBookableDay(opts: { groupsPerDay?: number } = {}) {
  const tourId = await makeTour({ groupsPerDay: opts.groupsPerDay ?? 1 });
  await makeVan();
  await makeDriver();
  return tourId;
}

/**
 * A whole booking in one transaction — what `createHold()` will do (Task 5):
 * both locks in the fixed order, the verdict, then the insert. Used by the
 * three concurrency tests at the bottom of this file.
 *
 * `beforeLocks` runs INSIDE the transaction but BEFORE `takeSlotLocks`, and
 * exists for exactly one test: the hazard guard, which needs a plain
 * consistent read there to pin the REPEATABLE READ snapshot early. Every
 * other caller leaves it out, which is the order the service documents as
 * its precondition.
 */
function bookOnTour(
  tourId: number,
  date: string,
  beforeLocks?: (tx: Transaction) => Promise<unknown>,
) {
  return getDb().transaction(async (tx) => {
    if (beforeLocks) await beforeLocks(tx);
    await takeSlotLocks(tx, tourId, date);
    const verdict = await assessCapacity(tx, tourId, date, 4);
    if (!verdict.ok) throw new Error(`refused: ${verdict.reason}`);
    const [row] = await tx.insert(bookings).values({
      ref: generateBookingRef(),
      tourId,
      tourDate: new Date(`${date}T00:00:00Z`),
      pax: 4,
      leadName: 'Race Fixture',
      leadEmail: 'race@example.test',
      leadPhone: '09170000000',
      status: 'pending_payment',
      payMode: 'full',
      priceSnapshot: SNAPSHOT,
      subtotalCentavos: 100000,
      totalCentavos: 100000,
    });
    created.bookingIds.push(row.insertId);
    return row.insertId;
  });
}

/** Bookings holding capacity on one date, across every tour. */
function heldOnDate(date: string) {
  return count(
    sql`SELECT COUNT(*) n FROM bookings
        WHERE tour_date = ${date} AND status IN (${HOLDING_STATUSES_SQL})`,
  );
}

/** The reasons the settled promises of a concurrent pair rejected with. */
function rejectionMessages(results: PromiseSettledResult<unknown>[]) {
  return results
    .filter((r): r is PromiseRejectedResult => r.status === 'rejected')
    .map((r) => (r.reason instanceof Error ? r.reason.message : String(r.reason)));
}

/**
 * A rendezvous for N transactions: every one of them waits here until all N
 * have arrived. The hazard test needs both snapshots pinned before either
 * transaction commits, and a bare `Promise.allSettled` only makes that
 * likely — this makes it certain.
 */
function barrier(parties: number) {
  let arrived = 0;
  let release: () => void;
  const open = new Promise<void>((resolve) => {
    release = resolve;
  });
  return async () => {
    arrived += 1;
    if (arrived >= parties) release();
    await open;
  };
}

describeWithDb('capacity', () => {
  beforeEach(async () => {
    /*
     * These tests count the WHOLE fleet, so a van or driver left behind by
     * another suite would change every number in this file. The seed
     * creates neither, so the premise is an empty fleet — prove it rather
     * than assume it. If this fails, `rg_travel_test` has leftovers from an
     * interrupted run.
     */
    expect(await count(sql`SELECT COUNT(*) n FROM vans`), 'leftover vans in rg_travel_test').toBe(
      0,
    );
    expect(
      await count(sql`SELECT COUNT(*) n FROM drivers`),
      'leftover drivers in rg_travel_test',
    ).toBe(0);
  });

  afterEach(cleanup);

  // -------------------------------------------------------------------------
  // takeSlotLocks
  // -------------------------------------------------------------------------

  it('creates both lock rows on demand, and is safe to call twice', async () => {
    const tourId = await makeTour();
    const slotRows = () =>
      count(
        sql`SELECT (SELECT COUNT(*) FROM fleet_date_slots WHERE date = ${DAY})
                 + (SELECT COUNT(*) FROM tour_date_slots WHERE tour_id = ${tourId} AND date = ${DAY}) n`,
      );

    expect(await slotRows()).toBe(0);
    await getDb().transaction((tx) => takeSlotLocks(tx, tourId, DAY));
    expect(await slotRows()).toBe(2);
    // Owner decision Q8: created on demand, so the second caller must find
    // the rows there and take them rather than fail on a duplicate key.
    await getDb().transaction((tx) => takeSlotLocks(tx, tourId, DAY));
    expect(await slotRows()).toBe(2);
  });

  /**
   * **The lock ORDER, observed rather than assumed.** Fleet first, tour
   * second (§5), because two transactions taking the pair in opposite
   * orders deadlock — and a deadlock passes every sequential test.
   *
   * The probe: another connection holds the TOUR row, so `takeSlotLocks`
   * must block on it. While it is blocked, a third connection asks for the
   * FLEET row with `NOWAIT`. If the fleet lock was taken first — correctly —
   * that request is refused, because the blocked caller is holding it. If
   * the order were reversed, the caller would still be waiting for the tour
   * row having never touched the fleet row, and the `NOWAIT` request would
   * succeed.
   */
  it('takes the fleet lock BEFORE the tour lock', async () => {
    const tourId = await makeTour();
    // Pre-create both rows so this test measures locking, not insertion.
    await getDb().transaction((tx) => takeSlotLocks(tx, tourId, DAY));

    const holder = await getPool().getConnection();
    let locks: Promise<unknown> | undefined;
    try {
      await holder.beginTransaction();
      await holder.query(
        'SELECT tour_id FROM tour_date_slots WHERE tour_id = ? AND date = ? FOR UPDATE',
        [tourId, DAY],
      );

      // Now `takeSlotLocks` must get the fleet row and then stall on the tour row.
      locks = getDb().transaction((tx) => takeSlotLocks(tx, tourId, DAY));
      await new Promise((r) => setTimeout(r, 300));

      const probe = await getPool().getConnection();
      try {
        await probe.beginTransaction();
        // Resolved to a sentinel either way, so a FAILURE of this test reads
        // as "acquired" rather than as a formatting error on a driver object.
        const outcome = await probe
          .query('SELECT date FROM fleet_date_slots WHERE date = ? FOR UPDATE NOWAIT', [DAY])
          .then(() => 'no error: the probe got the row')
          .catch((error: Error) => error.message);
        expect(
          outcome,
          'the fleet row was free while the caller waited on the tour row — the locks are not fleet-first',
        ).toMatch(/could not be acquired|NOWAIT/i);
      } finally {
        await probe.rollback();
        probe.release();
      }
    } finally {
      await holder.rollback();
      holder.release();
      await locks;
    }
  });

  // -------------------------------------------------------------------------
  // assessCapacity
  // -------------------------------------------------------------------------

  it('accepts a booking when the tour has room and the fleet has a van and a driver', async () => {
    const tourId = await aBookableDay();
    expect(await assess(tourId, DAY, 4)).toEqual({ ok: true });
  });

  it('refuses the next booking once the tour is at groups_per_day', async () => {
    // Two groups allowed, two already held, and a fleet big enough that the
    // fleet is not what refuses this.
    const tourId = await makeTour({ groupsPerDay: 2 });
    for (let i = 0; i < 4; i += 1) {
      await makeVan();
      await makeDriver();
    }
    await makeBooking({ tourId, date: DAY });
    expect(await assess(tourId, DAY, 4)).toEqual({ ok: true });

    await makeBooking({ tourId, date: DAY });
    expect(await assess(tourId, DAY, 4)).toEqual({ ok: false, reason: 'tour_sold_out' });
  });

  /**
   * **The cross-tour case `fleet_date_slots` exists for.** Tour A has four
   * of its five groups free, but the single van in the fleet is already
   * committed to tour B that day. A per-tour check sees room and sells a
   * trip nobody can drive.
   */
  it('refuses when every van is committed, even though the tour itself has room', async () => {
    const tourA = await makeTour({ groupsPerDay: 5 });
    const tourB = await makeTour({ groupsPerDay: 5 });
    await makeVan();
    await makeDriver();
    await makeBooking({ tourId: tourB, date: DAY });

    expect(await assess(tourA, DAY, 4)).toEqual({ ok: false, reason: 'no_van_available' });
  });

  it('does not count a van too small for the group', async () => {
    const tourId = await makeTour({ groupsPerDay: 1 });
    await makeVan({ capacity: 6 });
    await makeDriver();

    expect(await assess(tourId, DAY, 7)).toEqual({ ok: false, reason: 'no_van_available' });
    // `>=`, not `>`: a 6-seater fits a party of exactly six.
    expect(await assess(tourId, DAY, 6)).toEqual({ ok: true });
  });

  it('does not count a van unless it is available, or if it has left the fleet', async () => {
    const tourId = await makeTour({ groupsPerDay: 1 });
    await makeDriver();
    const repairVanId = await makeVan({ status: 'for_repair' });

    expect(await assess(tourId, DAY, 4)).toEqual({ ok: false, reason: 'no_van_available' });

    /*
     * Gate 2 is an ALLOW-list (owner decision 2026-10-14, Q1; Ruling 6):
     * only `status = VAN_STATUS_SELLABLE` ('available') counts, so a van
     * left `on_trip` does not count either — even though §9 means `on_trip`
     * as a today-only DERIVED status, not a claim on a future date. That is
     * the deliberate consequence of the allow-list, not an oversight: Week
     * 6's check-ins must CLEAR `on_trip` when a trip ends, or the van stops
     * being sellable on every future date (see the comment beside
     * `VAN_STATUS_SELLABLE` in `schema.ts`).
     */
    await getPool().query('UPDATE vans SET status = ? WHERE id = ?', ['on_trip', repairVanId]);
    expect(await assess(tourId, DAY, 4)).toEqual({ ok: false, reason: 'no_van_available' });

    // `parked` — BUILD_SPEC §9's fourth status — is excluded the same way.
    await getPool().query('UPDATE vans SET status = ? WHERE id = ?', ['parked', repairVanId]);
    expect(await assess(tourId, DAY, 4)).toEqual({ ok: false, reason: 'no_van_available' });

    // A van soft-deleted out of the fleet does not count either.
    await getPool().query('UPDATE vans SET is_active = 0 WHERE id = ?', [repairVanId]);
    expect(await assess(tourId, DAY, 4)).toEqual({ ok: false, reason: 'no_van_available' });
  });

  it('does not count a driver on leave that day', async () => {
    const tourId = await aBookableDay();
    const driverId = created.driverIds[0]!;
    await makeLeave(driverId, DAY, DAY);

    expect(await assess(tourId, DAY, 4)).toEqual({ ok: false, reason: 'no_driver_available' });
  });

  /**
   * `driver_leaves` is inclusive at BOTH ends, so a leave of
   * `DAY_BEFORE..DAY` covers `DAY` and one of `DAY_BEFORE..DAY_BEFORE` does
   * not. An off-by-one here dispatches a driver on a day they told dispatch
   * they were away.
   */
  it('treats a leave range as inclusive at both ends', async () => {
    const tourId = await aBookableDay();
    const driverId = created.driverIds[0]!;

    const leaveId = await makeLeave(driverId, DAY_BEFORE, DAY);
    expect(await assess(tourId, DAY, 4)).toEqual({ ok: false, reason: 'no_driver_available' });

    await getPool().query('UPDATE driver_leaves SET end_date = ? WHERE id = ?', [
      DAY_BEFORE,
      leaveId,
    ]);
    expect(await assess(tourId, DAY, 4)).toEqual({ ok: true });
  });

  it('does not count a driver who has left the roster', async () => {
    const tourId = await makeTour({ groupsPerDay: 1 });
    await makeVan();
    await makeDriver({ isActive: false });

    expect(await assess(tourId, DAY, 4)).toEqual({ ok: false, reason: 'no_driver_available' });
  });

  /**
   * Every one of the five statuses in `CAPACITY_HOLDING_STATUSES` consumes
   * the day's one group. Looped over the shared constant rather than listed
   * again here: removing a status from that set oversells the fleet, and
   * this test is one of the two places that notices.
   */
  it('lets every capacity-holding status consume the slot', async () => {
    for (const status of CAPACITY_HOLDING_STATUSES) {
      const tourId = await aBookableDay();
      await makeBooking({ tourId, date: DAY, status });
      expect(await assess(tourId, DAY, 4), `${status} did not hold capacity`).toEqual({
        ok: false,
        reason: 'tour_sold_out',
      });
      await cleanup();
    }
  });

  /** And the three that do not: a cancelled or expired booking frees its slot. */
  it('frees the slot for every status that does not hold capacity', async () => {
    const free = BOOKING_STATUSES.filter(
      (s) => !(CAPACITY_HOLDING_STATUSES as readonly BookingStatus[]).includes(s),
    );
    expect(free).toEqual(['completed', 'cancelled', 'expired']);

    for (const status of free) {
      const tourId = await aBookableDay();
      await makeBooking({ tourId, date: DAY, status });
      expect(await assess(tourId, DAY, 4), `${status} wrongly held capacity`).toEqual({ ok: true });
      await cleanup();
    }
  });

  /**
   * A tour date is a CIVIL date, not an instant. A booking on the 4th or the
   * 6th must not consume the 5th's only group — which is what a service that
   * compared a shifted `datetime` would do.
   */
  it('counts only bookings on the day asked for, not the days either side', async () => {
    const tourId = await aBookableDay();
    await makeBooking({ tourId, date: DAY_BEFORE });
    await makeBooking({ tourId, date: DAY_AFTER });

    expect(await assess(tourId, DAY, 4)).toEqual({ ok: true });
  });

  /**
   * Fail closed. `groups_per_day` is unknowable for a tour that is not
   * there, and a tour switched off is not for sale — neither may read as
   * "room available".
   */
  it('fails closed for a tour that does not exist', async () => {
    const verdict = await getDb().transaction((tx) => assessCapacity(tx, 2 ** 30, DAY, 4));
    expect(verdict).toEqual({ ok: false, reason: 'tour_unavailable' });
  });

  it('refuses a tour that is switched off', async () => {
    const tourId = await makeTour({ groupsPerDay: 5, isActive: false });
    await makeVan();
    await makeDriver();

    expect(await assess(tourId, DAY, 4)).toEqual({ ok: false, reason: 'tour_unavailable' });
  });

  // -------------------------------------------------------------------------
  // The race
  // -------------------------------------------------------------------------

  /**
   * **The reason `fleet_date_slots` exists.** Both tours have room; the
   * fleet has exactly one van. Without the date-level lock both
   * transactions read "one van free" and both succeed.
   *
   * Driven CONCURRENTLY with `Promise.allSettled`, not sequentially: a
   * sequential pair passes against code with no lock at all, because the
   * first booking is already committed when the second one reads. Both
   * transactions have to be in flight at the same time for the lock to be
   * the thing that separates them.
   */
  it('serialises two bookings for DIFFERENT tours on the same date', async () => {
    const tourA = await makeTour({ groupsPerDay: 5 });
    const tourB = await makeTour({ groupsPerDay: 5 });
    await makeVan();
    await makeDriver();

    const results = await Promise.allSettled([bookOnTour(tourA, DAY), bookOnTour(tourB, DAY)]);

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    /*
     * The loser must be REFUSED, not killed. A deadlock (`ER_LOCK_DEADLOCK`)
     * or a lock-wait timeout satisfies "exactly one rejected" identically —
     * and "a deadlock passes every sequential test" is the exact failure
     * this test exists to catch. The guest-visible difference is "that day
     * is full" versus a 500, so the reason is asserted, not just the count.
     */
    expect(rejectionMessages(results)).toEqual(['refused: no_van_available']);
    // And the state afterwards: ONE booking on that date, for one van.
    expect(await heldOnDate(DAY), 'the fleet was oversold').toBe(1);
  });

  /**
   * The other direction, and the reason the fleet lock is keyed by DATE
   * alone: two bookings on DIFFERENT dates contend for nothing and must
   * BOTH succeed. Without this, "take more locks" would look like a free
   * improvement — it is not. A `FOR SHARE` on the booking counts (the
   * obvious fix for the snapshot precondition below) turns the gap locks
   * those reads take into a deadlock with the other transaction's insert,
   * and this is the test that measured it. See the Task 4 fix report.
   */
  it('does NOT serialise two bookings on different dates — they deadlock nothing', async () => {
    const tourId = await makeTour({ groupsPerDay: 5 });
    await makeVan();
    await makeVan();
    await makeDriver();
    await makeDriver();

    const results = await Promise.allSettled([
      bookOnTour(tourId, DAY),
      bookOnTour(tourId, DAY_AFTER),
    ]);

    expect(rejectionMessages(results), 'a booking on an unrelated date was refused').toEqual([]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(2);
    expect(await heldOnDate(DAY)).toBe(1);
    expect(await heldOnDate(DAY_AFTER)).toBe(1);
  });

  /**
   * **A HAZARD GUARD, NOT A FEATURE.** This test asserts that the fleet IS
   * oversold, and it is here so that the precondition both exported
   * functions document cannot quietly stop being true.
   *
   * Under REPEATABLE READ, InnoDB pins the transaction's consistent-read
   * snapshot at its first NON-LOCKING read. `INSERT … ON DUPLICATE KEY
   * UPDATE` and `SELECT … FOR UPDATE` do not pin one, so `takeSlotLocks`
   * leaves the snapshot unpinned and the capacity counts that follow read
   * live data. But a plain `SELECT` taken BEFORE the locks pins the snapshot
   * before the lock is granted — and then the loser of the race counts
   * bookings as of a moment before the winner committed, passes the check,
   * and books the same van. **The locks are granted and change nothing.**
   *
   * The `beforeLocks` read below is that mistake, made deliberately, with a
   * barrier so both snapshots are pinned before either transaction commits.
   *
   * If this test ever fails because only ONE booking committed, the hazard
   * has been fixed (locking reads, or a different isolation level) — delete
   * this test and the precondition it guards rather than "repairing" it.
   */
  it('HAZARD: a consistent read taken BEFORE the locks lets both bookings through', async () => {
    const tourA = await makeTour({ groupsPerDay: 5 });
    const tourB = await makeTour({ groupsPerDay: 5 });
    await makeVan();
    await makeDriver();

    const arrive = barrier(2);
    /** The precondition violation: a plain read, so the snapshot is pinned early. */
    const pinTheSnapshot = async (tx: Transaction) => {
      await tx.execute(sql`SELECT COUNT(*) n FROM bookings WHERE tour_date = ${DAY}`);
      await arrive();
    };

    const results = await Promise.allSettled([
      bookOnTour(tourA, DAY, pinTheSnapshot),
      bookOnTour(tourB, DAY, pinTheSnapshot),
    ]);

    expect(
      results.filter((r) => r.status === 'fulfilled'),
      'the hazard is gone — see the comment above this test',
    ).toHaveLength(2);
    expect(await heldOnDate(DAY), 'the hazard is gone — see the comment above this test').toBe(2);
  });
});

/**
 * Deletes exactly the rows this file committed, in foreign-key order. Runs
 * after every test — the fleet is not date-scoped, so each test must start
 * from an empty one — and also between the cases of a looped test, where
 * `afterEach` cannot reach.
 */
async function cleanup() {
  const pool = getPool();
  for (const id of created.bookingIds) await pool.query('DELETE FROM bookings WHERE id = ?', [id]);
  for (const id of created.leaveIds) {
    await pool.query('DELETE FROM driver_leaves WHERE id = ?', [id]);
  }
  for (const id of created.tourIds) {
    // The lock row points at the tour, so it goes first.
    await pool.query('DELETE FROM tour_date_slots WHERE tour_id = ?', [id]);
    await pool.query('DELETE FROM tours WHERE id = ?', [id]);
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
  created.destinationIds = [];
  created.driverIds = [];
  created.vanIds = [];
}
