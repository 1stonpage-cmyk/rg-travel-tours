/**
 * Week 6 plan, Task 5 — `driver.startTrip`, `driver.checkIn`,
 * `driver.completeTrip` (BUILD_SPEC §8 "Itinerary check-ins").
 *
 * **The first tests over code that writes `trip_checkpoints` at all, and
 * the first over anything that writes `vans.status = 'on_trip'`.** Four
 * properties are the file's reason to exist:
 *
 *  1. **`stop_id` only, never `stop_key`.** `stop_key` is `GENERATED
 *     ALWAYS AS (coalesce(stop_id, 0)) STORED`, so the rows are read back
 *     here and their `stop_key` asserted — 0 for trip start, the stop's id
 *     for a real stop — which is the generated column being *observed*
 *     rather than written.
 *
 *     MEASURED (Task 5), and not what was expected: naming `stopKey` in
 *     `insertCheckpoint`'s `.values()` does NOT turn this file red. Drizzle
 *     excludes a generated column from the insert type, so the attempt is
 *     `error TS2769 … 'stopKey' does not exist in type` at COMPILE time and
 *     the builder drops the key at runtime — MySQL never sees it. The
 *     database's own refusal is real and was confirmed separately against
 *     `rg_travel_test` with a raw statement:
 *     `ER_NON_DEFAULT_VALUE_FOR_GENERATED_COLUMN: The value specified for
 *     generated column 'stop_key' in table 'trip_checkpoints' is not
 *     allowed`. So the rule has two guards (the compiler and the engine)
 *     and no runtime test can express it through Drizzle;
 *     `schema-trips.test.ts` pins the column's shape instead.
 *  2. **The UNIQUE index is the double-tap guard, not a `SELECT`.** The
 *     double-tap test fires **two concurrent calls**, deliberately, because
 *     a sequential pair passes against a `SELECT`-then-`INSERT`
 *     implementation and therefore proves nothing. MEASURED: replacing the
 *     duplicate-key catch with a pre-check makes the concurrent test red
 *     (the loser's `ER_DUP_ENTRY` escapes uncaught) while a sequential pair
 *     stays green.
 *  3. **Start moves the booking AND the van, in one transaction.** A
 *     started trip whose van is still `available` is a van two bookings can
 *     be sold into — `available` is the only sellable status (Week 5's
 *     allow-list), so the pair is asserted together on every path that
 *     moves either, including the last-stop completion.
 *  4. **`checked_at` is SERVER time.** Asserted as "within seconds of real
 *     now", and the inputs are asserted to refuse a timestamp at all —
 *     there is no field through which a device clock can reach the column.
 *
 * Fixtures are rebuilt per test and deleted in `afterEach`: the test
 * database keeps an EMPTY fleet (`capacity.test.ts` counts the whole
 * fleet), so every van and driver created here goes again. The `afterEach`
 * deletes this file's `trip_checkpoints`, `payments` and `audit_log` rows by
 * `booking_id` before the booking itself — `trip_checkpoints` is in
 * `global-setup.ts`'s `LEAK_TABLES` as of this task, so a miss there now
 * fails the run by name instead of quietly changing another suite's count.
 */
import { afterEach, beforeEach, expect, it } from 'vitest';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { type BookingStatus, type PaymentBoxState, type PriceSnapshot } from '@rg/shared';
import { getDb, getPool } from '../db/client';
import {
  auditLog,
  bookings,
  destinations,
  drivers,
  payments,
  tourItineraryStops,
  tours,
  tripCheckpoints,
  vans,
} from '../db/schema';
import { generateBookingRef } from '../services/booking-ref';
import { runCheckIn, startTrip } from '../services/trips/checkins';
import { driverCaller } from './helpers/ctx';
import { describeWithDb } from './helpers/db';

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

const TOTAL = 400_000;

const created = {
  bookingIds: [] as number[],
  tourIds: [] as number[],
  destIds: [] as number[],
  vanIds: [] as number[],
  driverIds: [] as number[],
};

async function count(statement: Parameters<ReturnType<typeof getDb>['execute']>[0]) {
  const [rows] = (await getDb().execute(statement)) as unknown as [Array<{ n: number }>, unknown];
  return Number(rows[0]?.n ?? -1);
}

async function makeDriver(label: string) {
  const suffix = unique();
  const [driver] = await getDb()
    .insert(drivers)
    .values({
      name: `Check-in ${label} ${suffix}`,
      code: `CI${suffix}`.slice(0, 20),
      phone: '09170000002',
      // Not a real hash: nothing here logs in, it arrives with a session
      // already (which is what `driverCaller` is).
      pinHash: '__checkins_not_a_pin_hash__',
      isActive: true,
    });
  created.driverIds.push(driver.insertId);
  return driver.insertId;
}

async function makeVan(status: 'available' | 'on_trip' | 'parked' | 'for_repair' = 'available') {
  const [van] = await getDb()
    .insert(vans)
    .values({
      plate: `CIV${unique()}`.slice(0, 20),
      model: 'Check-in Fixture Van',
      capacity: 12,
      status,
      isActive: true,
    });
  created.vanIds.push(van.insertId);
  return van.insertId;
}

interface BookingOpts {
  driverId: number | null;
  vanId?: number | null;
  status?: BookingStatus;
  tourIdOverride?: number;
  paidCentavos?: number;
}

async function makeBooking(opts: BookingOpts) {
  const ref = generateBookingRef();
  const [booking] = await getDb()
    .insert(bookings)
    .values({
      ref,
      tourId: opts.tourIdOverride ?? tourId,
      tourDate: new Date(`${TOUR_DATE}T00:00:00Z`),
      pax: 4,
      leadName: 'Check-in Lead Guest',
      leadEmail: `checkins_${unique()}@example.test`,
      leadPhone: '09171234567',
      pickup: 'Radisson Blu lobby',
      status: opts.status ?? 'assigned',
      payMode: 'deposit',
      priceSnapshot: { ...SNAPSHOT, subtotalCentavos: TOTAL, totalCentavos: TOTAL },
      subtotalCentavos: TOTAL,
      totalCentavos: TOTAL,
      // The column directly, because only the payments service may move it
      // in application code (CLAUDE.md) and this file is not that service.
      amountPaidCentavos: opts.paidCentavos ?? 0,
      vanId: opts.vanId === undefined ? vanId : opts.vanId,
      driverId: opts.driverId,
    });
  created.bookingIds.push(booking.insertId);
  return { id: booking.insertId, ref };
}

/** This booking's checkpoints, oldest first, with the GENERATED key read back. */
async function checkpointsOf(bookingId: number) {
  return await getDb()
    .select({
      stopId: tripCheckpoints.stopId,
      stopKey: tripCheckpoints.stopKey,
      checkedAt: tripCheckpoints.checkedAt,
      undone: tripCheckpoints.undone,
    })
    .from(tripCheckpoints)
    .where(eq(tripCheckpoints.bookingId, bookingId))
    .orderBy(asc(tripCheckpoints.checkedAt), asc(tripCheckpoints.id));
}

async function bookingStatus(bookingId: number): Promise<BookingStatus | undefined> {
  const [row] = await getDb()
    .select({ status: bookings.status })
    .from(bookings)
    .where(eq(bookings.id, bookingId))
    .limit(1);
  return row?.status;
}

async function vanStatus(id: number): Promise<string | undefined> {
  const [row] = await getDb().select({ status: vans.status }).from(vans).where(eq(vans.id, id));
  return row?.status;
}

/** The audit trail for one booking, in the shape the §9 detail screen reads it. */
async function trailOf(bookingId: number) {
  return await getDb()
    .select({
      actorType: auditLog.actorType,
      actorId: auditLog.actorId,
      action: auditLog.action,
      entity: auditLog.entity,
      entityId: auditLog.entityId,
      data: auditLog.data,
    })
    .from(auditLog)
    .where(
      and(
        eq(auditLog.entityId, bookingId),
        inArray(auditLog.action, ['trip.started', 'trip.checked_in', 'trip.completed']),
      ),
    )
    .orderBy(asc(auditLog.id));
}

let TOUR_DATE = '';
let tourId = 0;
let vanId = 0;
let driverA = 0;
let driverB = 0;
let stopIds: number[] = [];

describeWithDb('driver check-ins', () => {
  beforeEach(async () => {
    const db = getDb();
    // Any civil date: none of these mutations buckets or expires, so the
    // date is data rather than a clock question.
    TOUR_DATE = new Date().toISOString().slice(0, 10);

    expect(await count(sql`SELECT COUNT(*) n FROM vans`), 'leftover vans in rg_travel_test').toBe(
      0,
    );
    expect(
      await count(sql`SELECT COUNT(*) n FROM drivers`),
      'leftover drivers in rg_travel_test',
    ).toBe(0);

    const slug = `__checkins__${unique()}`;
    const [destination] = await db.insert(destinations).values({ name: slug, slug });
    created.destIds.push(destination.insertId);
    const [tour] = await db.insert(tours).values({
      slug,
      title: `Check-in Tour ${slug}`,
      destinationId: destination.insertId,
      isActive: true,
    });
    created.tourIds.push(tour.insertId);
    tourId = tour.insertId;

    // Three stops, so `progress.total` is four with trip start.
    stopIds = [];
    for (const [name, sortOrder] of [
      ['Simala Shrine', 1],
      ['Kawasan Falls', 2],
      ['Lunch stop', 3],
    ] as const) {
      const [stop] = await db
        .insert(tourItineraryStops)
        .values({ tourId: tour.insertId, sortOrder, name });
      stopIds.push(stop.insertId);
    }

    vanId = await makeVan('available');
    driverA = await makeDriver('A');
    driverB = await makeDriver('B');
  }, 30_000);

  afterEach(async () => {
    const pool = getPool();
    for (const id of created.bookingIds) {
      // `trip_checkpoints` is NOT one of global-setup.ts's leak tables, so
      // these rows are removed by hand rather than reported by the teardown.
      await pool.query('DELETE FROM trip_checkpoints WHERE booking_id = ?', [id]);
      await pool.query('DELETE FROM payments WHERE booking_id = ?', [id]);
      /*
       * Keyed on `entity_id` + the action prefix, NEVER on `entity =
       * 'bookings'` (round-1 review, F3): `entity` is the very value these
       * tests assert, so a regression to Week 5's singular `'booking'`
       * would make this delete miss — leaking rows into a table
       * `global-setup.ts`'s `LEAK_TABLES` cannot see, while the test that
       * should have caught the regression fails for an unrelated reason.
       */
      await pool.query("DELETE FROM audit_log WHERE entity_id = ? AND action LIKE 'trip.%'", [id]);
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
   * §8 item 1 — Start trip.
   * ---------------------------------------------------------------- */

  it('starts an assigned trip: one trip-start row, booking in_progress, van on_trip', async () => {
    const booking = await makeBooking({ driverId: driverA });
    const result = await driverCaller(driverA).driver.startTrip({ bookingId: booking.id });

    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (!result.ok) return;
    // Trip start counts towards progress — Task 3's rule, which this task
    // must not adjust. Three stops plus trip start is 1 / 4.
    expect(result.progress.done).toBe(1);
    expect(result.progress.total).toBe(4);
    expect(result.progress.status).toBe('in_progress');

    const rows = await checkpointsOf(booking.id);
    expect(rows).toHaveLength(1);
    // `stop_id` NULL is the trip-start event, and `stop_key` 0 is the
    // GENERATED column following it — written by MySQL, never by us.
    expect(rows[0]?.stopId).toBeNull();
    expect(rows[0]?.stopKey).toBe(0);
    expect(rows[0]?.undone).toBe(false);

    // Both halves of the state change, which is the point of their sharing
    // a transaction: a started trip with an `available` van is a van two
    // bookings can be sold into.
    expect(await bookingStatus(booking.id)).toBe('in_progress');
    expect(await vanStatus(vanId)).toBe('on_trip');
  });

  it('writes one trip.started audit row, actor_type driver, entity the plural bookings', async () => {
    const booking = await makeBooking({ driverId: driverA });
    await driverCaller(driverA).driver.startTrip({ bookingId: booking.id });

    const trail = await trailOf(booking.id);
    expect(trail).toHaveLength(1);
    expect(trail[0]).toMatchObject({
      actorType: 'driver',
      actorId: driverA,
      action: 'trip.started',
      // PLURAL: `admin.bookings.detail` filters its trail on `entity =
      // 'bookings'`, so a singular row is invisible on the one screen that
      // shows it.
      entity: 'bookings',
      entityId: booking.id,
    });
  });

  /**
   * Owner-accepted 2026-10-15 (Q2). The guests are standing at the pickup
   * and the receipt has not been looked at yet; refusing the start would
   * strand a family over an admin's queue. What starting must NOT do is
   * change what the driver is told about money — so the payment box is
   * asserted here as well, after the start, and still says do not collect.
   */
  it('starts a pending_verification trip, and the payment box still says DO NOT COLLECT', async () => {
    const booking = await makeBooking({ driverId: driverA, status: 'pending_verification' });
    await getDb().insert(payments).values({
      bookingId: booking.id,
      type: 'payment',
      provider: 'manual',
      method: 'bank_transfer',
      amountCentavos: TOTAL,
      status: 'pending',
    });

    const result = await driverCaller(driverA).driver.startTrip({ bookingId: booking.id });
    expect(result.ok, JSON.stringify(result)).toBe(true);
    expect(await bookingStatus(booking.id)).toBe('in_progress');
    expect(await vanStatus(vanId)).toBe('on_trip');

    const detail = await driverCaller(driverA).driver.trip({ bookingId: booking.id });
    expect(detail.payment).toEqual<PaymentBoxState>({ kind: 'unverified_do_not_collect' });
  });

  /**
   * **The double tap, raced on purpose.**
   *
   * Two concurrent calls, not a sequential pair: a sequential pair is
   * satisfied by a `SELECT`-then-`INSERT` implementation, which is the one
   * this test exists to refuse. Run concurrently, both requests read "no
   * checkpoint" at the same moment, and only the UNIQUE index on
   * `(booking_id, stop_key)` can tell them apart.
   *
   * `stop_key` is what makes it work for trip start at all: `UNIQUE
   * (booking_id, stop_id)` would permit unlimited NULL rows.
   *
   * The assertions are over rows this test OWNS — one booking's
   * checkpoints and one booking's audit rows — never a table-wide count.
   */
  it('lets exactly one of two concurrent Start taps through, the other already_checked_in', async () => {
    const booking = await makeBooking({ driverId: driverA });
    const caller = driverCaller(driverA);

    const settled = await Promise.allSettled([
      caller.driver.startTrip({ bookingId: booking.id }),
      caller.driver.startTrip({ bookingId: booking.id }),
    ]);

    const rejected = settled.filter((outcome) => outcome.status === 'rejected');
    expect(
      rejected.map((outcome) => String((outcome as PromiseRejectedResult).reason)),
      'a concurrent double tap threw instead of answering a verdict',
    ).toEqual([]);

    const results = settled.map((outcome) =>
      outcome.status === 'fulfilled' ? outcome.value : null,
    );
    expect(results.filter((result) => result?.ok === true)).toHaveLength(1);
    expect(
      results
        .filter((result) => result?.ok === false)
        .map((result) => result && 'reason' in result && result.reason),
    ).toEqual(['already_checked_in']);

    // ONE row and ONE audit row, whichever request won.
    expect(await checkpointsOf(booking.id)).toHaveLength(1);
    expect(await trailOf(booking.id)).toHaveLength(1);
    expect(await bookingStatus(booking.id)).toBe('in_progress');
    expect(await vanStatus(vanId)).toBe('on_trip');
  });

  it('answers already_checked_in on a second, sequential Start tap and changes nothing', async () => {
    const booking = await makeBooking({ driverId: driverA });
    const caller = driverCaller(driverA);
    await caller.driver.startTrip({ bookingId: booking.id });
    const [first] = await checkpointsOf(booking.id);

    const second = await caller.driver.startTrip({ bookingId: booking.id });
    expect(second).toEqual({ ok: false, reason: 'already_checked_in' });

    const rows = await checkpointsOf(booking.id);
    expect(rows).toHaveLength(1);
    // The surviving row is the FIRST tap's, timestamp included: a second
    // tap must not re-stamp when the van left.
    expect(rows[0]?.checkedAt.getTime()).toBe(first?.checkedAt.getTime());
    expect(await trailOf(booking.id)).toHaveLength(1);
  });

  /**
   * A `confirmed` booking has no van and no driver until dispatch assigns
   * them (Week 5), so there is nobody for whom it is their trip. The
   * fixture still sets `driver_id` — otherwise the refusal would be
   * `not_your_trip` and this test would be proving the wrong gate.
   */
  it('refuses to start a confirmed trip: trip_not_startable', async () => {
    const booking = await makeBooking({ driverId: driverA, status: 'confirmed', vanId: null });
    const result = await driverCaller(driverA).driver.startTrip({ bookingId: booking.id });
    expect(result).toEqual({ ok: false, reason: 'trip_not_startable' });
    expect(await checkpointsOf(booking.id)).toEqual([]);
    expect(await bookingStatus(booking.id)).toBe('confirmed');
  });

  /**
   * **The inbound status race, and the mirror image of the completion
   * one** (round-2 review).
   *
   * `startTrip`'s status gate is a PLAIN read — deliberately, because a
   * locking read there would serialise two taps and make a
   * check-then-insert correct. So it answers from the transaction's pinned
   * snapshot, and an admin cancellation landing between that read and the
   * `UPDATE` used to be silently overwritten: a driver's tap resurrecting a
   * cancelled trip as `in_progress`.
   *
   * The interleaving is **forced rather than raced**, on purpose. A
   * `Promise.all` version (below) cannot pin which side lands first, and the
   * ordering where the cancel commits LAST is a legitimately-started trip
   * that was then cancelled — a different fact with a different end state.
   * This test puts the cancel exactly in the window that used to be wrong:
   * a plain read first (which is what `startTrip`'s own first statement
   * does, so the snapshot is pinned the same way), then the cancel on
   * ANOTHER connection, then the real `startTrip` against the stale
   * snapshot.
   *
   * **The rollback is the half most likely to be wrong**, so it is asserted
   * directly: a test that only checked the status would pass with an
   * orphaned checkpoint sitting on a cancelled booking.
   */
  it('refuses, and leaves no checkpoint, when the booking is cancelled under a running start', async () => {
    const booking = await makeBooking({ driverId: driverA });

    const verdict = await runCheckIn(async (tx) => {
      // Pins this transaction's REPEATABLE READ snapshot, exactly as
      // `startTrip`'s own first statement does.
      await tx.select({ id: bookings.id }).from(bookings).where(eq(bookings.id, booking.id));
      // The admin, on another connection, committing immediately: nothing
      // in this transaction holds a lock on the row yet.
      await getPool().query("UPDATE bookings SET status = 'cancelled' WHERE id = ?", [booking.id]);
      // The gate below now reads `assigned` from the stale snapshot.
      return await startTrip(tx, { bookingId: booking.id, driverId: driverA, now: new Date() });
    });

    // The same refusal the gate would have given had the cancel landed
    // first — no new member of `CheckInRefusal` for the race.
    expect(verdict).toEqual({ ok: false, reason: 'trip_not_startable' });
    // The cancel stands. A driver's tap does not resurrect a cancelled trip.
    expect(await bookingStatus(booking.id)).toBe('cancelled');
    // And the write that had already happened went back with it.
    expect(await checkpointsOf(booking.id), 'an orphaned checkpoint survived').toEqual([]);
    expect(await trailOf(booking.id), 'an orphaned trip.started row survived').toEqual([]);
    expect(await vanStatus(vanId)).toBe('available');
  });

  /**
   * The same pair, genuinely concurrent — which means the ordering is NOT
   * ours to choose, so the assertion is the invariant that holds either way:
   * **the checkpoint exists if and only if the start was accepted.** If the
   * cancel lands first the start is refused and rolls back; if the start
   * lands first it really did start and the cancel then closes a trip that
   * was running. Both are coherent; what must never happen is a checkpoint
   * with no accepted start, or an accepted start with nothing recorded.
   *
   * The forced-interleaving test above is the one that PROVES the fix (this
   * one can resolve the harmless way); this one proves the pair stays
   * coherent under a real race.
   */
  it('keeps the checkpoint and the verdict in step when a cancel races a start', async () => {
    const booking = await makeBooking({ driverId: driverA });

    const [verdict] = await Promise.all([
      driverCaller(driverA)
        .driver.startTrip({ bookingId: booking.id })
        .then(
          (value) => value,
          (error: unknown) => error,
        ),
      getPool().query("UPDATE bookings SET status = 'cancelled' WHERE id = ?", [booking.id]),
    ]);

    expect(verdict, 'the start threw instead of answering a verdict').toHaveProperty('ok');
    const accepted = (verdict as { ok?: boolean }).ok === true;
    expect(await checkpointsOf(booking.id)).toHaveLength(accepted ? 1 : 0);
    expect(await trailOf(booking.id)).toHaveLength(accepted ? 1 : 0);
    if (!accepted) expect(verdict).toEqual({ ok: false, reason: 'trip_not_startable' });
  });

  it('refuses to start a cancelled trip, and writes nothing', async () => {
    const booking = await makeBooking({ driverId: driverA, status: 'cancelled' });
    const result = await driverCaller(driverA).driver.startTrip({ bookingId: booking.id });
    expect(result).toEqual({ ok: false, reason: 'trip_not_startable' });
    expect(await checkpointsOf(booking.id)).toEqual([]);
    expect(await vanStatus(vanId)).toBe('available');
    expect(await trailOf(booking.id)).toEqual([]);
  });

  /* ---------------------------------------------------------------- *
   * Another driver's trip.
   * ---------------------------------------------------------------- */

  /**
   * `not_your_trip` for a booking that belongs to driver B, and the SAME
   * answer for a booking id that does not exist — the property
   * `driver.trip` already holds: a mutation that distinguished the two
   * would hand back the enumeration oracle the query withholds, over ids
   * that lead to a guest's phone number (RA 10173).
   */
  it('refuses another driver trip, and an absent one, identically', async () => {
    const theirs = await makeBooking({ driverId: driverB });
    const caller = driverCaller(driverA);

    expect(await caller.driver.startTrip({ bookingId: theirs.id })).toEqual({
      ok: false,
      reason: 'not_your_trip',
    });
    expect(await caller.driver.startTrip({ bookingId: 2_000_000_000 })).toEqual({
      ok: false,
      reason: 'not_your_trip',
    });
    expect(await checkpointsOf(theirs.id)).toEqual([]);
    expect(await bookingStatus(theirs.id)).toBe('assigned');
  });

  it('refuses a stop check-in and a completion on another driver trip', async () => {
    const theirs = await makeBooking({ driverId: driverB, status: 'in_progress' });
    const caller = driverCaller(driverA);
    expect(
      await caller.driver.checkIn({ bookingId: theirs.id, stopId: stopIds[0] as number }),
    ).toEqual({ ok: false, reason: 'not_your_trip' });
    expect(await caller.driver.completeTrip({ bookingId: theirs.id })).toEqual({
      ok: false,
      reason: 'not_your_trip',
    });
    expect(await checkpointsOf(theirs.id)).toEqual([]);
    expect(await bookingStatus(theirs.id)).toBe('in_progress');
  });

  /* ---------------------------------------------------------------- *
   * §8 item 2 — stop check-ins.
   * ---------------------------------------------------------------- */

  it('records a stop with its own stop_id, and stop_key follows it', async () => {
    const booking = await makeBooking({ driverId: driverA });
    const caller = driverCaller(driverA);
    await caller.driver.startTrip({ bookingId: booking.id });

    const result = await caller.driver.checkIn({
      bookingId: booking.id,
      stopId: stopIds[0] as number,
    });
    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (!result.ok) return;
    expect(result.progress.done).toBe(2);
    expect(result.progress.total).toBe(4);

    const rows = await checkpointsOf(booking.id);
    expect(rows.map((row) => row.stopId)).toEqual([null, stopIds[0]]);
    // The GENERATED key, read back: `coalesce(stop_id, 0)`.
    expect(rows.map((row) => row.stopKey)).toEqual([0, stopIds[0]]);

    const trail = await trailOf(booking.id);
    expect(trail.map((row) => row.action)).toEqual(['trip.started', 'trip.checked_in']);
    expect(trail[1]).toMatchObject({ actorType: 'driver', actorId: driverA, entity: 'bookings' });
    expect(trail[1]?.data).toMatchObject({ stopId: stopIds[0] });
  });

  it('refuses a stop check-in before the trip was started: trip_not_started', async () => {
    const booking = await makeBooking({ driverId: driverA });
    const result = await driverCaller(driverA).driver.checkIn({
      bookingId: booking.id,
      stopId: stopIds[0] as number,
    });
    expect(result).toEqual({ ok: false, reason: 'trip_not_started' });
    expect(await checkpointsOf(booking.id)).toEqual([]);
    expect(await bookingStatus(booking.id)).toBe('assigned');
  });

  /**
   * A stop from ANOTHER tour. The fixture builds a second tour with its own
   * stop, so the id is real — a non-existent id would also be refused, but
   * by a path a typo could satisfy.
   */
  it('refuses a stop that belongs to a different tour: unknown_stop', async () => {
    const db = getDb();
    const slug = `__checkins_other__${unique()}`;
    const [destination] = await db.insert(destinations).values({ name: slug, slug });
    created.destIds.push(destination.insertId);
    const [other] = await db.insert(tours).values({
      slug,
      title: `Other Tour ${slug}`,
      destinationId: destination.insertId,
      isActive: true,
    });
    created.tourIds.push(other.insertId);
    const [otherStop] = await db
      .insert(tourItineraryStops)
      .values({ tourId: other.insertId, sortOrder: 1, name: 'Somebody else itinerary' });

    const booking = await makeBooking({ driverId: driverA });
    const caller = driverCaller(driverA);
    await caller.driver.startTrip({ bookingId: booking.id });

    const result = await caller.driver.checkIn({
      bookingId: booking.id,
      stopId: otherStop.insertId,
    });
    expect(result).toEqual({ ok: false, reason: 'unknown_stop' });
    // Trip start only — the refused stop wrote no row.
    expect(await checkpointsOf(booking.id)).toHaveLength(1);
  });

  it('lets exactly one of two concurrent taps on the SAME stop through', async () => {
    const booking = await makeBooking({ driverId: driverA });
    const caller = driverCaller(driverA);
    await caller.driver.startTrip({ bookingId: booking.id });

    const stopId = stopIds[1] as number;
    const settled = await Promise.allSettled([
      caller.driver.checkIn({ bookingId: booking.id, stopId }),
      caller.driver.checkIn({ bookingId: booking.id, stopId }),
    ]);
    expect(
      settled
        .filter((outcome) => outcome.status === 'rejected')
        .map((outcome) => String((outcome as PromiseRejectedResult).reason)),
      'a concurrent double tap on one stop threw instead of answering a verdict',
    ).toEqual([]);

    const results = settled.map((outcome) =>
      outcome.status === 'fulfilled' ? outcome.value : null,
    );
    expect(results.filter((result) => result?.ok === true)).toHaveLength(1);
    expect(
      results
        .filter((result) => result?.ok === false)
        .map((result) => result && 'reason' in result && result.reason),
    ).toEqual(['already_checked_in']);

    const rows = await checkpointsOf(booking.id);
    expect(rows.map((row) => row.stopKey)).toEqual([0, stopId]);
  });

  /* ---------------------------------------------------------------- *
   * §8 item 3 — the last stop completes the trip and frees the van.
   * ---------------------------------------------------------------- */

  it('completes the trip and frees the van when the last stop is tapped', async () => {
    const booking = await makeBooking({ driverId: driverA });
    const caller = driverCaller(driverA);
    await caller.driver.startTrip({ bookingId: booking.id });
    expect(await vanStatus(vanId)).toBe('on_trip');

    for (const stopId of stopIds.slice(0, -1)) {
      const mid = await caller.driver.checkIn({ bookingId: booking.id, stopId });
      expect(mid.ok && mid.progress.status, 'the trip completed before its last stop').toBe(
        'in_progress',
      );
      expect(await vanStatus(vanId), 'the van was freed mid-trip').toBe('on_trip');
    }

    const last = await caller.driver.checkIn({
      bookingId: booking.id,
      stopId: stopIds.at(-1) as number,
    });
    expect(last.ok, JSON.stringify(last)).toBe(true);
    if (!last.ok) return;
    expect(last.progress.done).toBe(4);
    expect(last.progress.total).toBe(4);
    expect(last.progress.status).toBe('completed');

    expect(await bookingStatus(booking.id)).toBe('completed');
    // The clearing half. `available` is the ONLY sellable status (Week 5's
    // allow-list), so a van left `on_trip` is unbookable on EVERY future
    // date — this assertion is the fleet's whole future.
    expect(await vanStatus(vanId)).toBe('available');

    const trail = await trailOf(booking.id);
    expect(trail.map((row) => row.action)).toEqual([
      'trip.started',
      'trip.checked_in',
      'trip.checked_in',
      'trip.checked_in',
      'trip.completed',
    ]);
    expect(trail.at(-1)).toMatchObject({
      actorType: 'driver',
      actorId: driverA,
      entity: 'bookings',
    });
    // Which route closed the trip: the stop that finished it, not the
    // Complete button.
    expect(trail.at(-1)?.data).toMatchObject({ lastStopId: stopIds.at(-1) as number });
  });

  /**
   * **The snapshot trap, raced on purpose** (round-1 review, F1 — the
   * blocking defect this test exists for).
   *
   * Two check-ins on the FINAL TWO stops, overlapping. Each transaction's
   * first statement is a plain read, which pins the REPEATABLE READ
   * snapshot — so a completion decision made from a non-locking count sees
   * its own new row plus everything committed before its snapshot, and
   * never the sibling's. Both therefore count `total - 1` and **neither
   * completes the trip**: all four checkpoints written, the booking left
   * `in_progress`, and the van left `on_trip`, which `VAN_STATUS_SELLABLE`
   * makes unsellable and undispatchable on EVERY future date.
   *
   * It is not exotic. A driver's queued taps flushing when signal returns
   * is two check-ins arriving together, which is exactly the offline story
   * the portal is built for.
   *
   * The assertions are the four facts that failure produced, inverted —
   * and the audit count, because the same stale read can close one trip
   * twice when a `completeTrip` overlaps instead.
   */
  it('completes the trip exactly once when the final two stops are tapped concurrently', async () => {
    const booking = await makeBooking({ driverId: driverA });
    const caller = driverCaller(driverA);
    await caller.driver.startTrip({ bookingId: booking.id });
    // Everything but the last two, sequentially, so the race is over the
    // pair that decides completion.
    await caller.driver.checkIn({ bookingId: booking.id, stopId: stopIds[0] as number });

    const settled = await Promise.allSettled([
      caller.driver.checkIn({ bookingId: booking.id, stopId: stopIds[1] as number }),
      caller.driver.checkIn({ bookingId: booking.id, stopId: stopIds[2] as number }),
    ]);
    expect(
      settled
        .filter((outcome) => outcome.status === 'rejected')
        .map((outcome) => String((outcome as PromiseRejectedResult).reason)),
      'a concurrent pair of stop check-ins threw instead of answering a verdict',
    ).toEqual([]);
    // Different stops, so BOTH are recorded — unlike the double-tap race.
    expect(
      settled.filter((outcome) => outcome.status === 'fulfilled' && outcome.value.ok),
    ).toHaveLength(2);

    expect(await checkpointsOf(booking.id)).toHaveLength(4);
    expect(await bookingStatus(booking.id), 'the trip never finished').toBe('completed');
    // The one that costs real money: a van stranded on `on_trip` is
    // unsellable on every future date.
    expect(await vanStatus(vanId), 'the van was left on_trip').toBe('available');
    // Exactly one, whichever tap got there — not two, and not none.
    expect(
      (await trailOf(booking.id)).filter((row) => row.action === 'trip.completed'),
    ).toHaveLength(1);
  });

  /**
   * The other half of the same stale read: a `completeTrip` landing while a
   * last-stop `checkIn` waits behind its booking-row lock. The check-in's
   * own snapshot still says `in_progress`, so without a conditional status
   * write it closes the trip a second time and the §9 trail shows two
   * `trip.completed` rows for one trip.
   */
  it('closes a trip once even when Complete and the last stop arrive together', async () => {
    const booking = await makeBooking({ driverId: driverA });
    const caller = driverCaller(driverA);
    await caller.driver.startTrip({ bookingId: booking.id });
    for (const stopId of stopIds.slice(0, -1)) {
      await caller.driver.checkIn({ bookingId: booking.id, stopId });
    }

    const settled = await Promise.allSettled([
      caller.driver.completeTrip({ bookingId: booking.id }),
      caller.driver.checkIn({ bookingId: booking.id, stopId: stopIds.at(-1) as number }),
    ]);
    expect(
      settled
        .filter((outcome) => outcome.status === 'rejected')
        .map((outcome) => String((outcome as PromiseRejectedResult).reason)),
      'Complete racing the last stop threw instead of answering a verdict',
    ).toEqual([]);

    expect(await bookingStatus(booking.id)).toBe('completed');
    expect(await vanStatus(vanId)).toBe('available');
    expect(
      (await trailOf(booking.id)).filter((row) => row.action === 'trip.completed'),
      'one trip was closed twice',
    ).toHaveLength(1);
  });

  it('completes on the last stop even when the stops were tapped out of order', async () => {
    // A convoy that reversed the route. "Last stop" means every stop
    // checked in, not the highest sort_order — a trip left one tap short
    // would strand its van on `on_trip` forever.
    const booking = await makeBooking({ driverId: driverA });
    const caller = driverCaller(driverA);
    await caller.driver.startTrip({ bookingId: booking.id });
    for (const stopId of [stopIds[2], stopIds[0], stopIds[1]] as number[]) {
      await caller.driver.checkIn({ bookingId: booking.id, stopId });
    }
    expect(await bookingStatus(booking.id)).toBe('completed');
    expect(await vanStatus(vanId)).toBe('available');
  });

  it('takes no further check-in once the trip is completed', async () => {
    const booking = await makeBooking({ driverId: driverA });
    const caller = driverCaller(driverA);
    await caller.driver.startTrip({ bookingId: booking.id });
    await caller.driver.completeTrip({ bookingId: booking.id });

    const result = await caller.driver.checkIn({
      bookingId: booking.id,
      stopId: stopIds[0] as number,
    });
    expect(result).toEqual({ ok: false, reason: 'trip_not_started' });
    expect(await checkpointsOf(booking.id)).toHaveLength(1);
  });

  /* ---------------------------------------------------------------- *
   * §8 item 3 by hand — Complete trip.
   * ---------------------------------------------------------------- */

  it('completes a running trip by hand, frees the van, and audits trip.completed', async () => {
    const booking = await makeBooking({ driverId: driverA });
    const caller = driverCaller(driverA);
    await caller.driver.startTrip({ bookingId: booking.id });

    const result = await caller.driver.completeTrip({ bookingId: booking.id });
    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (!result.ok) return;
    expect(result.progress.status).toBe('completed');

    expect(await bookingStatus(booking.id)).toBe('completed');
    expect(await vanStatus(vanId)).toBe('available');
    const trail = await trailOf(booking.id);
    expect(trail.map((row) => row.action)).toEqual(['trip.started', 'trip.completed']);
    // By hand, so there is no stop that closed it.
    expect(trail.at(-1)?.data).toMatchObject({ lastStopId: null });
  });

  it('answers already_checked_in on a second Complete tap, and audits once', async () => {
    const booking = await makeBooking({ driverId: driverA });
    const caller = driverCaller(driverA);
    await caller.driver.startTrip({ bookingId: booking.id });
    await caller.driver.completeTrip({ bookingId: booking.id });

    expect(await caller.driver.completeTrip({ bookingId: booking.id })).toEqual({
      ok: false,
      reason: 'already_checked_in',
    });
    const trail = await trailOf(booking.id);
    expect(trail.filter((row) => row.action === 'trip.completed')).toHaveLength(1);
  });

  it('refuses to complete a trip that was never started: trip_not_started', async () => {
    const booking = await makeBooking({ driverId: driverA });
    const result = await driverCaller(driverA).driver.completeTrip({ bookingId: booking.id });
    expect(result).toEqual({ ok: false, reason: 'trip_not_started' });
    expect(await bookingStatus(booking.id)).toBe('assigned');
    expect(await vanStatus(vanId)).toBe('available');
    expect(await trailOf(booking.id)).toEqual([]);
  });

  /**
   * The van status transitions are conditional in SQL (`WHERE status = …`),
   * which is what stops a completion from silently un-doing a dispatcher's
   * decision. A van marked `for_repair` while the trip was running must not
   * be put back on sale by the driver tapping Complete.
   */
  it('leaves a van a dispatcher marked for_repair mid-trip exactly where they left it', async () => {
    const booking = await makeBooking({ driverId: driverA });
    const caller = driverCaller(driverA);
    await caller.driver.startTrip({ bookingId: booking.id });
    await getDb().update(vans).set({ status: 'for_repair' }).where(eq(vans.id, vanId));

    const result = await caller.driver.completeTrip({ bookingId: booking.id });
    expect(result.ok, JSON.stringify(result)).toBe(true);
    // The trip still completes — the driver's day is not blocked by the
    // fleet's paperwork — but the van is not put back on sale.
    expect(await bookingStatus(booking.id)).toBe('completed');
    expect(await vanStatus(vanId)).toBe('for_repair');
  });

  /**
   * `moveVanStatus`'s `vanId === null` branch (round-1 review, F4). A
   * booking with a driver and no van cannot be produced by
   * `assignVanAndDriver` — it writes both or neither — so this is a
   * hand-made row, and the rule is that it must not BLOCK the driver: a
   * guest standing at a pickup is not the moment to refuse over a column
   * nobody filled in. The `confirmed` test also sets `vanId: null` but is
   * refused by the status gate before it ever reaches this branch.
   */
  it('starts and completes a trip with no van at all, skipping the fleet write', async () => {
    const booking = await makeBooking({ driverId: driverA, vanId: null });
    const caller = driverCaller(driverA);

    const started = await caller.driver.startTrip({ bookingId: booking.id });
    expect(started.ok, JSON.stringify(started)).toBe(true);
    expect(await bookingStatus(booking.id)).toBe('in_progress');
    // The fixture van belongs to no booking here — nothing moved it.
    expect(await vanStatus(vanId)).toBe('available');

    const finished = await caller.driver.completeTrip({ bookingId: booking.id });
    expect(finished.ok, JSON.stringify(finished)).toBe(true);
    expect(await bookingStatus(booking.id)).toBe('completed');
    expect(await vanStatus(vanId)).toBe('available');
    // The audit rows still record the trip, with a null van.
    const trail = await trailOf(booking.id);
    expect(trail.map((row) => row.action)).toEqual(['trip.started', 'trip.completed']);
    expect(trail[0]?.data).toMatchObject({ vanId: null });
    expect(trail.at(-1)?.data).toMatchObject({ vanId: null });
  });

  it('starts a trip whose van is parked without moving the van onto the road', async () => {
    const parked = await makeVan('parked');
    const booking = await makeBooking({ driverId: driverA, vanId: parked });
    const result = await driverCaller(driverA).driver.startTrip({ bookingId: booking.id });
    expect(result.ok, JSON.stringify(result)).toBe(true);
    expect(await bookingStatus(booking.id)).toBe('in_progress');
    // `available -> on_trip` only. A van in any other status is left where
    // the human who put it there left it, in both directions.
    expect(await vanStatus(parked)).toBe('parked');
  });

  /* ---------------------------------------------------------------- *
   * `checked_at` is server time, and there is no field to override it.
   * ---------------------------------------------------------------- */

  /**
   * The column is SERVER time (schema: "never the driver's device clock").
   * Asserted as "within a second of real now" rather than against a value
   * this test supplied — the latter would pass against an implementation
   * that trusted an input, which is the thing being refused.
   */
  it('stamps checked_at from the server clock, not from anything a caller sent', async () => {
    const booking = await makeBooking({ driverId: driverA });
    const before = Date.now();
    await driverCaller(driverA).driver.startTrip({ bookingId: booking.id });
    const after = Date.now();

    const [row] = await checkpointsOf(booking.id);
    const stamped = row?.checkedAt.getTime() ?? 0;
    // A one-second slack either side: MySQL's `datetime` has no sub-second
    // precision here, so a stamp taken 40ms after `before` reads back
    // truncated to the second below it.
    expect(stamped).toBeGreaterThanOrEqual(before - 1_000);
    expect(stamped).toBeLessThanOrEqual(after + 1_000);
  });

  /**
   * The other half, and the one a mutation can be proven against: there is
   * no INPUT FIELD through which a device clock could arrive. `.strict()`,
   * so a request carrying one is refused rather than silently ignored — a
   * field quietly dropped is a field somebody will one day decide to honour.
   */
  it('refuses an input that carries a timestamp, a driver, or anything else', async () => {
    const booking = await makeBooking({ driverId: driverA });
    const caller = driverCaller(driverA);
    await expect(
      caller.driver.startTrip({
        bookingId: booking.id,
        checkedAt: '2020-01-01T00:00:00Z',
      } as never),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(
      caller.driver.checkIn({
        bookingId: booking.id,
        stopId: stopIds[0] as number,
        checkedAt: '2020-01-01T00:00:00Z',
      } as never),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(
      caller.driver.completeTrip({ bookingId: booking.id, driverId: driverB } as never),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    // Refused at the input stage means nothing was written.
    expect(await checkpointsOf(booking.id)).toEqual([]);
  });
});
