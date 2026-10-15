/**
 * Week 6 plan, Task 3 — `tripProgress`, the one answer two surfaces read
 * (BUILD_SPEC §8 "Itinerary check-ins").
 *
 * The driver's itinerary screen (Task 4) and the dispatcher's stop-by-stop
 * progress bar (Task 12) ask the same question, so there is one function
 * and these are its properties:
 *
 *  1. **Trip start first, then the itinerary in `sort_order`.** The
 *     fixtures are inserted in a different order from the one they must
 *     come back in, so ordering by `stop_id` — insertion order — is red
 *     here rather than passing by coincidence. An itinerary reordered in
 *     the admin screen would otherwise be read back to the driver in the
 *     order it was typed instead of the order the van drives it.
 *  2. **An undone check-in counts as NOT done.** That is the whole purpose
 *     of the `undone` column (§8: "marked `undone`, not deleted"), and the
 *     row is still there to be counted by anything that forgets.
 *  3. **`checked_at` is the SERVER's time.** The fixtures let the column's
 *     own default supply it, and the assertion is that the answer is
 *     within seconds of real `now` — not that it equals a value this test
 *     passed in. `tripProgress` takes no time argument at all.
 *  4. **Two SQL statements, whatever the itinerary's length.** The
 *     departures board calls this once per departure, so one query per
 *     stop here is N×M on one screen.
 *
 * Nothing in this file writes `trip_checkpoints` through application code,
 * because nothing can yet: Task 5 is the writer. The fixtures are direct
 * inserts, which is also what lets this file build an undone row.
 *
 * No vans and no drivers are created — `bookings.van_id` / `driver_id` are
 * nullable and this function reads neither. The test database keeps an
 * EMPTY fleet (`capacity.test.ts` counts the whole fleet), and the cheapest
 * way to keep it empty is to need nothing from it.
 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { TRPCError } from '@trpc/server';
import { TRIP_START_STOP_NAME, type PriceSnapshot } from '@rg/shared';
import { getDb, getPool } from '../db/client';
import { bookings, destinations, tourItineraryStops, tours, tripCheckpoints } from '../db/schema';
import { generateBookingRef } from '../services/booking-ref';
import { tripProgress } from '../services/trips/progress';
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

/** Every id this file commits, so `afterEach` removes exactly those rows. */
const created = {
  bookingIds: [] as number[],
  tourIds: [] as number[],
  destIds: [] as number[],
};

let bookingId = 0;
/** The three itinerary stops, keyed by the name they carry. */
let stopIds: Record<'First' | 'Second' | 'Third', number>;

describeWithDb('tripProgress', () => {
  beforeEach(async () => {
    const db = getDb();
    const slug = `__tripprog__${unique()}`;

    const [destination] = await db.insert(destinations).values({ name: slug, slug });
    created.destIds.push(destination.insertId);
    const [tour] = await db.insert(tours).values({
      slug,
      title: `Trip Progress Tour ${slug}`,
      destinationId: destination.insertId,
      isActive: true,
    });
    created.tourIds.push(tour.insertId);

    /*
     * Inserted THIRD, FIRST, SECOND on purpose. `tour_itinerary_stops.id`
     * is AUTO_INCREMENT, so insertion order is id order — and the two
     * orders now disagree, which is what makes the ordering assertion
     * below able to fail.
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

    const [booking] = await db.insert(bookings).values({
      ref: generateBookingRef(),
      tourId: tour.insertId,
      tourDate: new Date('2026-11-11T00:00:00Z'),
      pax: 2,
      leadName: 'Trip Progress Fixture',
      leadEmail: 'tripprog@example.test',
      leadPhone: '09170000000',
      status: 'in_progress',
      payMode: 'full',
      priceSnapshot: SNAPSHOT,
      subtotalCentavos: 100000,
      totalCentavos: 100000,
    });
    created.bookingIds.push(booking.insertId);
    bookingId = booking.insertId;
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
    created.bookingIds = [];
    created.tourIds = [];
    created.destIds = [];
  });

  /**
   * `checked_at` is left to the column's own default everywhere a test does
   * not care when the tap happened — which is everywhere, including the
   * server-time test, whose whole point is that nobody passed a value.
   */
  const checkIn = async (stopId: number | null, opts?: { undone?: boolean }) => {
    await getDb()
      .insert(tripCheckpoints)
      .values({
        bookingId,
        stopId,
        undone: opts?.undone ?? false,
        undoneAt: opts?.undone ? new Date() : null,
      });
  };

  it('puts trip start first, then the itinerary stops in sort_order', async () => {
    const progress = await tripProgress(getDb(), bookingId);

    expect(progress.stops.map((stop) => stop.name)).toEqual([
      TRIP_START_STOP_NAME,
      'First',
      'Second',
      'Third',
    ]);
    // Trip start is the pseudo-stop — a null `stop_id`, not a real row.
    expect(progress.stops[0]!.stopId).toBeNull();
    // And the real stops carry their own ids, in sort_order and NOT in id
    // order: `Third` was inserted first, so its id is the lowest.
    expect(progress.stops.slice(1).map((stop) => stop.stopId)).toEqual([
      stopIds.First,
      stopIds.Second,
      stopIds.Third,
    ]);
    expect(stopIds.Third).toBeLessThan(stopIds.First);
  });

  it('reports the booking id and status it was asked about', async () => {
    const progress = await tripProgress(getDb(), bookingId);
    expect(progress.bookingId).toBe(bookingId);
    expect(progress.status).toBe('in_progress');
  });

  it('is 0 of 4 for a trip with no check-ins', async () => {
    const progress = await tripProgress(getDb(), bookingId);
    expect(progress.done).toBe(0);
    // Four, not three: trip start is a stop on this list, so the
    // dispatcher's bar moves when the van leaves.
    expect(progress.total).toBe(4);
    expect(progress.stops.every((stop) => stop.checkedAt === null)).toBe(true);
    expect(progress.stops.every((stop) => stop.undone === false)).toBe(true);
  });

  it('counts an UNDONE check-in as not done, and still reports when it happened', async () => {
    await checkIn(null); // trip start
    await checkIn(stopIds.First);
    await checkIn(stopIds.Second, { undone: true });

    const progress = await tripProgress(getDb(), bookingId);

    // Three rows in the table, two of them standing.
    expect(progress.done).toBe(2);
    expect(progress.total).toBe(4);

    const second = progress.stops.find((stop) => stop.stopId === stopIds.Second)!;
    expect(second.undone).toBe(true);
    // §8: "marked `undone`, not deleted" — the retraction must not erase
    // the fact that a tap happened, which is why both fields are carried.
    expect(second.checkedAt).not.toBeNull();

    const first = progress.stops.find((stop) => stop.stopId === stopIds.First)!;
    expect(first.undone).toBe(false);
    expect(first.checkedAt).not.toBeNull();
    expect(progress.stops.find((stop) => stop.stopId === stopIds.Third)!.checkedAt).toBeNull();
  });

  it("reports checked_at as the server's own instant, in UTC, within seconds of now", async () => {
    const before = Date.now();
    // No `checked_at` is passed: the column's default supplies it, which is
    // the server's clock. `tripProgress` itself takes no time argument —
    // there is no value a caller could have handed it instead.
    await checkIn(null);

    const progress = await tripProgress(getDb(), bookingId);
    const checkedAt = progress.stops[0]!.checkedAt;

    expect(checkedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    const at = Date.parse(checkedAt!);
    // A second of slack either side: MySQL `datetime` has no sub-second
    // precision here, so the stored instant can round down below `before`.
    expect(at).toBeGreaterThanOrEqual(before - 1000);
    expect(at).toBeLessThanOrEqual(Date.now() + 1000);
  });

  it('issues two SQL statements for a four-stop trip, not one per stop', async () => {
    await checkIn(null);
    await checkIn(stopIds.First);

    const pool = getPool();
    const query = vi.spyOn(pool, 'query');
    const execute = vi.spyOn(pool, 'execute');

    await tripProgress(getDb(), bookingId);

    // Stops, then checkpoints, joined in memory. The departures board calls
    // this once per departure, so a per-stop query here is N×M on one
    // screen.
    expect(query.mock.calls.length + execute.mock.calls.length).toBe(2);
  });

  it('refuses a booking id that does not exist', async () => {
    // Fails closed rather than answering with an empty itinerary that
    // would render as a trip nobody has started. Same NOT_FOUND the
    // dispatch screen's sibling reads give a stale id.
    await expect(tripProgress(getDb(), 0)).rejects.toBeInstanceOf(TRPCError);
    await expect(tripProgress(getDb(), 0)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});
