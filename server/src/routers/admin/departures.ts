/**
 * `admin.departures.today` — the dispatcher's live board (Week 6 plan, Task
 * 12; BUILD_SPEC §9 "Dashboard: today's departures with stop-by-stop
 * progress bars").
 *
 * ## §9 gives the Dashboard to all three roles
 *
 * `adminProcedure('dashboard')`, and `ROLE_MATRIX.dashboard` is already
 * `['owner', 'dispatcher', 'finance']` — §9's own row, transcribed once.
 * Nothing here is an action finance cannot take: it is a read of where the
 * vans are.
 *
 * ## "Today" is the Manila civil date, and `now` is explicit
 *
 * The clock is read ONCE, in the resolver, and passed to
 * `todayDepartures()` as an argument — the same discipline
 * `listDriverTrips(driverId, now)` follows, for the same reason: a clock
 * read inside the query could not be tested at the 16:00 UTC boundary
 * without faking timers globally, which is how a timezone bug survives its
 * own suite. **The procedure takes no input at all**, so no client can
 * supply the date and ask to be shown another day as today.
 *
 * `bookings.tour_date` is a `date()` column, which Drizzle types as a
 * `Date`, so the comparison goes through the house raw-`sql` helper
 * (`onDate`) against a civil-date STRING — never `eq()`, which would force
 * a `Date` and reopen the midnight-shift hazard. Manila is UTC+8, so a
 * UTC-based "today" is wrong for the whole 00:00–07:59 Manila window and
 * right the rest of the day; `admin-departures.test.ts` stands inside that
 * window on purpose.
 *
 * ## Cancelled and expired trips are not departures
 *
 * The same controller ruling `admin.calendar.month` carries (2026-10-14):
 * they hold no capacity and nobody is driving them. `completed` DOES stay —
 * a trip that finished this morning is still one of today's departures, and
 * a board that drops it the moment the last stop is ticked would make a
 * dispatcher wonder whether the van came back.
 *
 * ## Ordered by `bookings.id`
 *
 * There is no departure-time column in the schema (§5's `bookings` carries
 * a `tour_date`, not a timestamp), so there is no "first out of the yard"
 * to sort by. Insertion order is at least STABLE — the board refreshes
 * every fifteen seconds, and rows that reshuffle under a dispatcher's
 * cursor are worse than rows in an arbitrary but fixed order.
 *
 * ## The query count, decided deliberately
 *
 * `tripProgress()` is **two statements per booking** (it says so, and
 * `trip-progress.test.ts` pins it), so this board costs **1 + 2N**: one
 * statement for the day's departures, then two per departure. That is
 * accepted rather than batched, and the justification is bounded, not
 * hopeful:
 *
 *  - N is bounded by the FLEET, not by sales. A departure needs a van, and
 *    §5's capacity rules stop the system selling more trips per day than
 *    there are groups — so N is a single- to low-double-digit number for
 *    this operator, forever. At twenty departures the board is 41
 *    statements per poll, i.e. under three a second at §9's fifteen-second
 *    interval, against a pool of ten connections.
 *  - The alternative is a second progress query — two `IN (…)` reads
 *    assembled in memory — and that is precisely the drift `tripProgress`
 *    was extracted to prevent. Two implementations of "which stops has
 *    this trip reached" is how the dispatcher's bar and the driver's
 *    checklist come to disagree.
 *
 * `admin-departures.test.ts` MEASURES the count (1 + 2×3 = 7 for three
 * departures) rather than trusting this paragraph, so a per-stop query
 * sneaking into `tripProgress` later fails here too.
 *
 * Sequential, not `Promise.all`: the pool is `connectionLimit: 10` and a
 * board of twenty departures firing forty statements at once would queue on
 * the pool anyway, while making the statement count non-deterministic to
 * read in a log.
 */
import { and, asc, eq, notInArray, sql } from 'drizzle-orm';
import { manilaCivilDate, type TodayDeparture } from '@rg/shared';
import { getDb } from '../../db/client';
import { bookings, drivers, tours, vans } from '../../db/schema';
import { tripProgress } from '../../services/trips/progress';
import { adminProcedure, router } from '../../trpc';

/**
 * `column = :date`, comparing a civil-date column to a civil-date STRING.
 *
 * Raw `sql`, not `eq()`, for the reason the module doc gives. Identical in
 * shape to `onDate()` (`services/dispatch/availability.ts`), `on()`
 * (`services/capacity.ts`) and `betweenDates()` (`admin/calendar.ts`) —
 * kept local for the same reason those three are: this module's date
 * comparison is not any of their jobs.
 */
function onDate(column: typeof bookings.tourDate, date: string) {
  return sql`${column} = ${date}`;
}

/** Terminal statuses that are not a departure — see the module doc. */
const NOT_DEPARTING = ['cancelled', 'expired'] as const;

/**
 * Every trip departing on the Manila civil date of `now`, each with its
 * stop-by-stop progress.
 *
 * Exported so a test can stand on the 16:00 UTC boundary without faking the
 * clock, and for no other reason — the mounted procedure is the only caller
 * and it reads `now` itself.
 */
export async function todayDepartures(now: Date): Promise<TodayDeparture[]> {
  const today = manilaCivilDate(now);
  const db = getDb();

  /*
   * One statement for the day. `tours` is inner-joined (a booking always
   * has one); `vans` and `drivers` are LEFT joined because a trip can sit
   * on today's date with neither assigned, and that trip is the single most
   * important row on this board.
   */
  const rows = await db
    .select({
      bookingId: bookings.id,
      ref: bookings.ref,
      tourTitle: tours.title,
      driverName: drivers.name,
      vanPlate: vans.plate,
      status: bookings.status,
    })
    .from(bookings)
    .innerJoin(tours, eq(tours.id, bookings.tourId))
    .leftJoin(vans, eq(vans.id, bookings.vanId))
    .leftJoin(drivers, eq(drivers.id, bookings.driverId))
    .where(and(onDate(bookings.tourDate, today), notInArray(bookings.status, [...NOT_DEPARTING])))
    .orderBy(asc(bookings.id));

  const departures: TodayDeparture[] = [];
  for (const row of rows) {
    /*
     * Task 3's function, unchanged — the SAME answer the driver's own
     * itinerary screen reads. `progress.status` is the booking's status
     * read inside that call; `row.status` is the one this query read. They
     * cannot disagree within a request, and the row's is the one reported
     * so the board's status and its sort come from one statement.
     */
    departures.push({ ...row, progress: await tripProgress(db, row.bookingId) });
  }
  return departures;
}

export const adminDeparturesRouter = router({
  /**
   * No input. The clock is the server's, the date is Manila's, and there is
   * no field through which to ask for either.
   */
  today: adminProcedure('dashboard').query(async () => await todayDepartures(new Date())),
});
