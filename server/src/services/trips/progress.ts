/**
 * `tripProgress` — the itinerary of one trip with each stop's check-in
 * state (Week 6 plan, Task 3; BUILD_SPEC §8 "Itinerary check-ins").
 *
 * ## Why this is its own module
 *
 * The driver's itinerary screen (Task 4) and the dispatcher's
 * "stop-by-stop progress" on the live departures board (Task 12) are **the
 * same question**. Two implementations would drift, and the drift shows up
 * as a dispatcher ringing a driver who has already checked in. So this is
 * the single answer, and both surfaces consume it unchanged — which is
 * also why `TripProgress` / `TripProgressStop` live in `@rg/shared` and not
 * in a driver-only module.
 *
 * ## An undone check-in counts as NOT done
 *
 * `trip_checkpoints.undone` exists because §8 says "Undo last check-in …
 * marked `undone`, not deleted". A row that was retracted is still a row,
 * so anything that counts progress must exclude it explicitly — a
 * `COUNT(*)` over the table is the bug this function exists to not have.
 * `checkedAt` is still reported for such a stop (see `TripProgressStop`):
 * dropping it would erase the fact the undo column was added to preserve.
 *
 * ## Two queries, never one per stop
 *
 * Query 1 is the booking joined to its tour's stops; query 2 is the
 * booking's checkpoints. They are joined **in memory**, on
 * `COALESCE(stop_id, 0)` — the same key the table's own UNIQUE index uses,
 * which is what makes a `Map` lookup exact rather than a best guess.
 *
 * This is not tidiness. The departures board calls this once per departure,
 * so a per-stop query here becomes N×M on the dashboard: twenty vans with
 * eight stops each is 160 round trips for one screen.
 *
 * ## No `now`
 *
 * CLAUDE.md requires time-dependent code to take an explicit `now`. This
 * function is not time-dependent: it reads timestamps the database already
 * holds and compares nothing against the clock. There is deliberately no
 * `now` parameter to pass — an unused one would be a lie about what the
 * answer depends on. Nothing here is bucketed, expired or "today".
 *
 * ## Read-only, so it takes either handle
 *
 * The plan's signature named `tx: Transaction`. This takes
 * `Database | Transaction` instead (`db/client.ts`'s documented shape for a
 * read-only service, as `validateCoupon` does): a `Transaction` still
 * satisfies it, so Task 5's check-in mutation can read inside its own
 * transaction, while Tasks 4 and 12 — plain queries holding no transaction
 * — can pass the pool without opening one purely to read. The pool is
 * `connectionLimit: 10`, and a read that insists on its own transaction
 * while its caller already holds a connection is how that pool deadlocks.
 */
import { asc, eq } from 'drizzle-orm';
import { TRPCError } from '@trpc/server';
import { TRIP_START_STOP_NAME, type TripProgress, type TripProgressStop } from '@rg/shared';
import type { Database, Transaction } from '../../db/client';
import { bookings, tourItineraryStops, tripCheckpoints } from '../../db/schema';

/**
 * `trip_checkpoints.stop_key` is `GENERATED ALWAYS AS (coalesce(stop_id, 0))
 * STORED`, so `0` is the trip-start event's key. Safe as a sentinel because
 * `tour_itinerary_stops.id` is an AUTO_INCREMENT primary key and never
 * issues 0 — see the column's comment in `db/schema.ts`.
 */
const TRIP_START_KEY = 0;

export async function tripProgress(
  db: Database | Transaction,
  bookingId: number,
): Promise<TripProgress> {
  /*
   * Query 1. The booking AND its tour's stops in one go, `leftJoin` so a
   * tour with no itinerary rows still returns the booking (its progress is
   * then trip start alone, which is a real answer — not an empty screen).
   *
   * Ordered by `sort_order`, then `id` so two stops sharing a number have a
   * stable order rather than whatever the engine returns. **Never by
   * `stop_id`**: the ids are insertion order, and an itinerary reordered in
   * the admin screen would then be read back to the driver in the order it
   * was typed instead of the order the van drives it.
   */
  const rows = await db
    .select({
      status: bookings.status,
      stopId: tourItineraryStops.id,
      stopName: tourItineraryStops.name,
      sortOrder: tourItineraryStops.sortOrder,
    })
    .from(bookings)
    .leftJoin(tourItineraryStops, eq(tourItineraryStops.tourId, bookings.tourId))
    .where(eq(bookings.id, bookingId))
    .orderBy(asc(tourItineraryStops.sortOrder), asc(tourItineraryStops.id));

  const first = rows[0];
  if (!first) {
    /*
     * A stale booking id is a refusal, not a programmer error — the same
     * ruling `suggestAssignment` carries, and for the same reasons: a
     * bookmarked departures board, a second tab, a trip cancelled while
     * the screen sat open. `NOT_FOUND`, so the two agree and the UI has
     * one thing to handle, rather than a plain `Error` surfacing as a 500.
     */
    throw new TRPCError({ code: 'NOT_FOUND', message: 'No booking with that id.' });
  }

  /*
   * Query 2. This booking's checkpoints — including the undone ones, which
   * are the point. `undone` is carried through rather than filtered in SQL
   * so the driver's screen can say a tap was retracted; only `done` below
   * excludes them.
   *
   * The UNIQUE index on `(booking_id, stop_key)` means at most one row per
   * key, so the `Map` cannot silently drop a second check-in — there
   * cannot be one.
   */
  const checkpoints = await db
    .select({
      stopId: tripCheckpoints.stopId,
      checkedAt: tripCheckpoints.checkedAt,
      undone: tripCheckpoints.undone,
    })
    .from(tripCheckpoints)
    .where(eq(tripCheckpoints.bookingId, bookingId));

  const byKey = new Map(checkpoints.map((row) => [row.stopId ?? TRIP_START_KEY, row]));

  const stopFor = (stopId: number | null, name: string, sortOrder: number): TripProgressStop => {
    const checkpoint = byKey.get(stopId ?? TRIP_START_KEY);
    return {
      stopId,
      name,
      sortOrder,
      /*
       * `checked_at` is a `datetime` the pool reads with `timezone: 'Z'`,
       * so the `Date` is the UTC instant the server recorded. Emitted as an
       * ISO instant and NOT formatted for Manila here — the view formats,
       * this layer reports (CLAUDE.md: store UTC, display Manila).
       */
      checkedAt: checkpoint ? checkpoint.checkedAt.toISOString() : null,
      undone: checkpoint?.undone ?? false,
    };
  };

  /** Trip start first, then the itinerary in `sort_order`. */
  const stops: TripProgressStop[] = [stopFor(null, TRIP_START_STOP_NAME, 0)];
  for (const row of rows) {
    /*
     * `leftJoin` with no itinerary rows yields one row of nulls, not zero
     * rows — that booking has trip start and nothing else. `name` and
     * `sort_order` are NOT NULL at the schema, so they are only ever null
     * on that same missed join; the fallbacks below are unreachable and
     * exist to satisfy the left-join's nullable types, not to paper over a
     * real nameless stop.
     */
    if (row.stopId === null) continue;
    stops.push(stopFor(row.stopId, row.stopName ?? '', row.sortOrder ?? 0));
  }

  return {
    bookingId,
    status: first.status,
    stops,
    done: stops.filter((stop) => stop.checkedAt !== null && !stop.undone).length,
    total: stops.length,
  };
}
