/**
 * Week 6 "Drivers & verification", Task 7 — the Week 5 carry-forward:
 * **`on_trip` is set AND cleared, and dispatch honours both halves.**
 *
 * Tasks 5 and 6 wrote the code (`moveVanStatus` in
 * `services/trips/checkins.ts`, conditional in SQL in both directions,
 * inside the same transaction as the checkpoint write). This file is the
 * PROOF, and it exists because of a consequence that is invisible from the
 * check-in screen:
 *
 * `VAN_STATUS_SELLABLE` allow-lists `available` **alone** (owner decision
 * 2026-10-14), and `vans.status` is **not date-scoped**. So a van left
 * `on_trip` is refused by `assessCapacity()` on EVERY future date at once.
 * The symptom does not arrive as an error. It arrives weeks later as "we're
 * fully booked" on a day with four idle vans, with nothing in the logs.
 *
 * ## The load-bearing test reads AVAILABILITY, never the column
 *
 * `vans.status` proves the write happened. It does **not** prove that
 * dispatch honours it — a status nothing reads is a column, not a rule. So
 * the test that matters here asks the two functions that answer the
 * question for real: `assessCapacity()` (what checkout asks before it sells
 * a day) and `vansFreeOn()` (what the calendar dropdowns, the auto-suggest
 * and the assignment re-check all read). Both are asked about a date THIRTY
 * DAYS OUT, not the trip's own date, because the un-date-scoped blast
 * radius is the whole point.
 *
 * MEASURED (Task 7, step 5): deleting the clearing half —
 * `moveVanStatus(tx, trip.vanId, 'on_trip', VAN_STATUS_SELLABLE)` in
 * `finishTrip` — turns `makes the van sellable again for a FUTURE date
 * after completion` red on the capacity verdict, not merely on the column.
 * If that mutation ever leaves this file green, the test has drifted back
 * to reading `vans.status` and must be fixed before anything else here is
 * trusted.
 *
 * ## What this file adds that `trip-checkins.test.ts` does not already have
 *
 * That file pins the two column writes and the `for_repair` guard as part
 * of proving the check-in flow, and it pins availability for the UNDO path
 * (a reopened completion takes the van back off sale). The gap it leaves,
 * and the reason this file is separate, is the ordinary forward sequence
 * read through capacity — start, future date refused, complete, future date
 * sellable — plus the orphan below. The column assertions are repeated here
 * deliberately: they are the mechanism the capacity test depends on, and a
 * failure that names both halves says which one broke.
 *
 * ## THE DECLARED GAP: nothing sweeps an orphaned `on_trip`
 *
 * While a trip runs, its van is correctly unsellable on every future date.
 * But **nothing clears `on_trip` for a trip nobody ever completes.** A
 * driver whose phone dies at the last stop, or who simply forgets, leaves
 * that van unsellable indefinitely — and the only thing that frees it today
 * is a hand-written `UPDATE vans`.
 *
 * Task 7 does not close that, because both candidate fixes are new surface
 * area needing an owner decision (a `node-cron` sweep is a new scheduled
 * job and a new failure mode; a dispatcher-facing "force complete" is a new
 * mutation that moves a booking's status). It is DECLARED instead — in
 * `CLAUDE.md`'s Dispatch section, in `BUILD_SPEC.md`'s Week 7
 * carry-forwards, and by the last test in this file, which pins the current
 * behaviour so the gap is a known quantity with a name rather than a
 * surprise. If somebody builds the sweep, that test is the one that goes
 * red, and reading it tells them what they changed.
 *
 * Fixtures are rebuilt per test and deleted in `afterEach`: the test
 * database keeps an EMPTY fleet (`capacity.test.ts` counts the whole
 * fleet), and `bookings`, `drivers`, `vans` and `trip_checkpoints` are all
 * in `global-setup.ts`'s `LEAK_TABLES`, so a miss fails the run by name.
 * `fleet_date_slots` is NOT in that list and has no cascade toward `tours`,
 * so the lock rows `takeSlotLocks()` creates on demand are deleted by hand,
 * before the tour.
 *
 * The tour has no itinerary stops, deliberately: nothing here taps a stop,
 * and the fleet write is the same on both paths into `finishTrip` (the last
 * stop, and the Complete button) because they share it. The stop-closed
 * route is proven in `trip-checkins.test.ts`.
 */
import { afterEach, beforeEach, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import type { PriceSnapshot } from '@rg/shared';
import { getDb, getPool } from '../db/client';
import { bookings, destinations, drivers, tours, vans } from '../db/schema';
import { generateBookingRef } from '../services/booking-ref';
import { assessCapacity, takeSlotLocks } from '../services/capacity';
import { vansFreeOn } from '../services/dispatch/availability';
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
  subtotalCentavos: 400000,
  discountCentavos: 0,
  totalCentavos: 400000,
};

const TOTAL = 400_000;

/** The group this file asks capacity about. Well under the fixture van's 12. */
const PAX = 2;

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

async function vanStatus(id: number): Promise<string | undefined> {
  const [row] = await getDb().select({ status: vans.status }).from(vans).where(eq(vans.id, id));
  return row?.status;
}

/**
 * `assessCapacity` as `createHold()` asks it — both slot locks in the fixed
 * order (`fleet_date_slots` then `tour_date_slots`), then the verdict,
 * through the same transaction. The shape checkout really runs.
 */
function assess(date: string, pax = PAX) {
  return getDb().transaction(async (tx) => {
    await takeSlotLocks(tx, tourId, date);
    return assessCapacity(tx, tourId, date, pax);
  });
}

/**
 * The other half of the same question, from the surface dispatch itself
 * reads. In a transaction because that is the only handle `vansFreeOn`
 * takes — it is written to run inside the assignment's own locks.
 */
function freeVanIds(date: string, minCapacity = PAX) {
  return getDb()
    .transaction((tx) => vansFreeOn(tx, date, minCapacity))
    .then((rows) => rows.map((row) => row.id));
}

/** Today. Nothing here buckets or expires, so the date is data. */
let TOUR_DATE = '';
/**
 * Thirty days out, so no fixture booking holds capacity there and the only
 * thing that can refuse it is the FLEET'S OWN STATE. That is what makes the
 * capacity assertions below about `on_trip` and nothing else.
 */
let FUTURE_DATE = '';
let tourId = 0;
let vanId = 0;
let driverId = 0;

describeWithDb('a van on a trip', () => {
  beforeEach(async () => {
    const db = getDb();
    TOUR_DATE = new Date().toISOString().slice(0, 10);
    FUTURE_DATE = new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10);

    /*
     * `assessCapacity` counts the WHOLE fleet, so every verdict below is
     * only meaningful if this file owns every van and driver in the
     * database. Asserted rather than assumed: a leaked row from a sibling
     * suite would otherwise turn a refusal into a pass and this file would
     * report that `on_trip` is honoured when it is not.
     */
    expect(await count(sql`SELECT COUNT(*) n FROM vans`), 'leftover vans in rg_travel_test').toBe(
      0,
    );
    expect(
      await count(sql`SELECT COUNT(*) n FROM drivers`),
      'leftover drivers in rg_travel_test',
    ).toBe(0);

    const slug = `__vanonTrip__${unique()}`;
    const [destination] = await db.insert(destinations).values({ name: slug, slug });
    created.destIds.push(destination.insertId);

    const [tour] = await db.insert(tours).values({
      slug,
      title: `Van Status Tour ${slug}`,
      destinationId: destination.insertId,
      groupsPerDay: 1,
      isActive: true,
    });
    created.tourIds.push(tour.insertId);
    tourId = tour.insertId;

    const [van] = await db.insert(vans).values({
      plate: `TVS${unique()}`.slice(0, 20),
      model: 'Van Status Fixture Van',
      capacity: 12,
      status: 'available',
      isActive: true,
    });
    created.vanIds.push(van.insertId);
    vanId = van.insertId;

    const [driver] = await db.insert(drivers).values({
      name: `Van Status Driver ${unique()}`,
      code: `TVS${unique()}`.slice(0, 20),
      phone: '09170000003',
      // Not a real hash and not a real PIN: nothing here logs in, the
      // caller arrives with a session already.
      pinHash: '__van_status_not_a_pin_hash__',
      isActive: true,
    });
    created.driverIds.push(driver.insertId);
    driverId = driver.insertId;
  }, 30_000);

  afterEach(async () => {
    const pool = getPool();
    for (const id of created.bookingIds) {
      await pool.query('DELETE FROM trip_checkpoints WHERE booking_id = ?', [id]);
      /*
       * Keyed on `entity_id` + the action prefix, never on `entity =
       * 'bookings'`: `entity` is a value these flows are asserted on
       * elsewhere, so keying the cleanup on it would make the delete miss
       * exactly when a regression made it wrong.
       */
      await pool.query("DELETE FROM audit_log WHERE entity_id = ? AND action LIKE 'trip.%'", [id]);
      await pool.query('DELETE FROM bookings WHERE id = ?', [id]);
    }
    for (const id of created.tourIds) {
      // `tour_date_slots` points at the tour with no cascade, so the
      // lock rows `takeSlotLocks()` created go first or the tour delete
      // fails on the foreign key.
      await pool.query('DELETE FROM tour_date_slots WHERE tour_id = ?', [id]);
      await pool.query('DELETE FROM tours WHERE id = ?', [id]);
    }
    // The fleet half of the same lock pair — no FK, and not in
    // `LEAK_TABLES` either, which is exactly why it is deleted by hand.
    for (const day of [TOUR_DATE, FUTURE_DATE]) {
      if (day) await pool.query('DELETE FROM fleet_date_slots WHERE date = ?', [day]);
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

  /** One assigned booking on TOUR_DATE, holding this file's van and driver. */
  async function makeBooking() {
    const [booking] = await getDb()
      .insert(bookings)
      .values({
        ref: generateBookingRef(),
        tourId,
        tourDate: new Date(`${TOUR_DATE}T00:00:00Z`),
        pax: 4,
        leadName: 'Van Status Lead Guest',
        leadEmail: `vanstatus_${unique()}@example.test`,
        leadPhone: '09171234567',
        pickup: 'Radisson Blu lobby',
        status: 'assigned',
        payMode: 'deposit',
        priceSnapshot: SNAPSHOT,
        subtotalCentavos: TOTAL,
        totalCentavos: TOTAL,
        amountPaidCentavos: 0,
        vanId,
        driverId,
      });
    created.bookingIds.push(booking.insertId);
    return booking.insertId;
  }

  /* ---------------------------------------------------------------- *
   * The column: set on start, cleared on completion.
   * ---------------------------------------------------------------- */

  it('puts the van on_trip when the trip starts', async () => {
    const bookingId = await makeBooking();
    expect(await vanStatus(vanId)).toBe('available');

    const result = await driverCaller(driverId).driver.startTrip({ bookingId });
    expect(result.ok, JSON.stringify(result)).toBe(true);

    expect(await vanStatus(vanId)).toBe('on_trip');
  });

  it('puts the van BACK to available when the trip completes', async () => {
    const bookingId = await makeBooking();
    const caller = driverCaller(driverId);
    await caller.driver.startTrip({ bookingId });
    expect(await vanStatus(vanId)).toBe('on_trip');

    const result = await caller.driver.completeTrip({ bookingId });
    expect(result.ok, JSON.stringify(result)).toBe(true);

    expect(await vanStatus(vanId)).toBe('available');
  });

  /* ---------------------------------------------------------------- *
   * The test that matters: the CAPACITY consequence, on a future date.
   * ---------------------------------------------------------------- */

  /**
   * **The load-bearing test of Task 7.** It reads `assessCapacity` and
   * `vansFreeOn` — not `vans.status` — because the column only proves the
   * write landed, and the bug this task exists for is a van that dispatch
   * refuses on every future date.
   *
   * The premise is asserted FIRST (that date is bookable before anything
   * starts), because without it the refusal in the middle could be any
   * other gate — a sold-out tour, a missing driver — wearing the right
   * reason by accident.
   *
   * Remove the clearing half in `finishTrip` and this goes red on
   * `afterTrip`. That mutation is the whole reason the file is here.
   */
  it('makes the van sellable again for a FUTURE date after completion', async () => {
    const bookingId = await makeBooking();
    const caller = driverCaller(driverId);

    // The premise: thirty days out, the fleet can take a group of two.
    expect(await assess(FUTURE_DATE)).toEqual({ ok: true });
    expect(await freeVanIds(FUTURE_DATE)).toContain(vanId);

    await caller.driver.startTrip({ bookingId });
    const duringTrip = await assess(FUTURE_DATE);
    const duringTripVans = await freeVanIds(FUTURE_DATE);

    await caller.driver.completeTrip({ bookingId });
    const afterTrip = await assess(FUTURE_DATE);
    const afterTripVans = await freeVanIds(FUTURE_DATE);

    // While the guests are in it, that van cannot be sold into a day a
    // MONTH away — `vans.status` is not date-scoped, which is the blast
    // radius this whole task is about.
    expect(duringTrip).toEqual({ ok: false, reason: 'no_van_available' });
    /*
     * Scoped to the van THIS test created, never `toEqual([])`. The test
     * database keeps an empty fleet, but it is shared mutable state across
     * suites — an exact-count assertion here would be a flaky test wearing
     * a precise number, which this project has already paid for once.
     */
    expect(duringTripVans).not.toContain(vanId);

    // And the moment the trip closes, the fleet is whole again.
    expect(afterTrip).toEqual({ ok: true });
    expect(afterTripVans).toContain(vanId);
  });

  /* ---------------------------------------------------------------- *
   * Completing a trip must not undo a dispatcher's decision.
   * ---------------------------------------------------------------- */

  /**
   * `moveVanStatus` is conditional in SQL in BOTH directions (`WHERE status
   * = <from>`), and this is the half that protects a human's decision: a
   * dispatcher who marked a van `for_repair` while it was out has taken it
   * off the road, and a driver tapping Complete must not put a broken van
   * back on sale.
   *
   * Asserted through availability as well as the column, because "not
   * `available`" and "not sellable" are only the same sentence while
   * `VAN_STATUS_SELLABLE` stays an allow-list.
   */
  it('does not make a for_repair van sellable by completing its trip', async () => {
    const bookingId = await makeBooking();
    const caller = driverCaller(driverId);
    await caller.driver.startTrip({ bookingId });

    // The dispatcher's decision, mid-trip.
    await getDb().update(vans).set({ status: 'for_repair' }).where(eq(vans.id, vanId));

    const result = await caller.driver.completeTrip({ bookingId });
    // The trip still completes — the driver's day is not blocked by the
    // fleet's paperwork.
    expect(result.ok, JSON.stringify(result)).toBe(true);

    expect(await vanStatus(vanId)).toBe('for_repair');
    expect(await assess(FUTURE_DATE)).toEqual({ ok: false, reason: 'no_van_available' });
    expect(await freeVanIds(FUTURE_DATE)).not.toContain(vanId);
  });

  /* ---------------------------------------------------------------- *
   * THE DECLARED GAP (Task 7, step 5b) — pinned, not fixed.
   * ---------------------------------------------------------------- */

  /**
   * **A started trip nobody ever completes leaves its van unsellable for
   * good, and this test says so out loud.**
   *
   * It is not a test of a feature. It is a test of an ABSENCE: there is no
   * sweep, no timeout and no dispatcher override, so the only thing that
   * returns this van to `available` is somebody completing the trip or
   * somebody writing SQL. A driver whose phone dies at the last stop is
   * enough to produce it, and the symptom arrives weeks later as "we're
   * fully booked" with nothing in the logs.
   *
   * Both candidate fixes are new surface area that needs an owner decision
   * (CLAUDE.md: stop and ask) and are recorded in `CLAUDE.md`'s Dispatch
   * section and `BUILD_SPEC.md`'s Week 7 carry-forwards:
   *
   *  - a `node-cron` sweep that returns a van to `available` when its trip
   *    has been `in_progress` past its tour date — a new scheduled job, and
   *    so a new failure mode of its own;
   *  - a dispatcher-facing "force complete" on the §9 booking detail,
   *    audited like any other status change — no scheduler, but it needs
   *    somebody to notice first.
   *
   * **When one of them is built, THIS TEST is what goes red**, and whoever
   * reddens it should replace it with the sweep's own proof rather than
   * loosening it. A green run here means the gap is still open.
   */
  it('leaves the van unsellable for future dates while a started trip is never completed', async () => {
    const bookingId = await makeBooking();
    await driverCaller(driverId).driver.startTrip({ bookingId });

    // No completion, no undo, no sweep — the trip is simply abandoned.
    expect(await vanStatus(vanId)).toBe('on_trip');
    expect(await assess(FUTURE_DATE)).toEqual({ ok: false, reason: 'no_van_available' });
    expect(await freeVanIds(FUTURE_DATE)).not.toContain(vanId);

    /*
     * Asked a second time, after the trip's own date has been read and the
     * slot locks for the future date have come and gone: nothing in the
     * system is watching, so the answer does not change on its own. This is
     * the assertion that makes the test about the MISSING sweep rather than
     * about a single query.
     */
    expect(await assess(FUTURE_DATE)).toEqual({ ok: false, reason: 'no_van_available' });
    expect(await vanStatus(vanId)).toBe('on_trip');
  });
});
