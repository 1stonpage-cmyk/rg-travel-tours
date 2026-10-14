/**
 * `admin.calendar.month` and `admin.calendar.dayOptions` (Week 5 "Dispatch"
 * plan, Task 8; BUILD_SPEC §5C / §9 "Calendar", server half).
 *
 * `month` answers "what is running this month, and what needs staffing" —
 * every day of the requested Manila-local month, each carrying its trips
 * and a `needsAssignmentCount` the dashboard can sum. `dayOptions` answers
 * "who is free to staff one specific booking" — the dropdown contents
 * behind the calendar's assign action.
 *
 * ## Roles
 *
 * `month` is `adminProcedure('bookingsView')` — §9 gives the bookings VIEW
 * to all three admin roles, and a calendar is a read of the same bookings a
 * dispatcher already sees in the list, just grouped by day. `dayOptions` is
 * `adminProcedure('assignVanDriver')` — the dropdown contents are a
 * dispatch tool, and finance has no business assigning a van or driver.
 *
 * ## `vansFreeOn` / `driversFreeOn` are the only source of the exclusion
 * rules
 *
 * `dayOptions` does not filter a van or a driver itself. It reads the
 * booking's `tour_date` and `pax`, then calls the Task 3 availability module
 * — the single place §9's exclusion rules are written. Re-implementing any
 * part of that here would let the two drift, and the specific bug that
 * produces is one van sent to two trips on the same morning.
 * `excludeBookingId` is passed through so re-assigning a booking does not
 * exclude the van/driver it already holds.
 *
 * ## The month is built from civil dates, never a `Date` range
 *
 * `tour_date` is already a civil date (Asia/Manila), so `month: 11, year:
 * 2026` means the days whose string form starts `2026-11-`. The query
 * compares `bookings.tour_date` to two civil-date STRING boundaries with the
 * house raw-`sql` helper, never `eq()`/`between()` — see `betweenDates`
 * below for why. A `Date`-based range would shift the boundary by the
 * UTC+8 offset and silently move trips between months.
 *
 * ## Cancelled and expired trips are absent from the month entirely
 *
 * Controller ruling, 2026-10-14: they hold no capacity (§5's status table),
 * Task 10 refuses to assign either one, and showing a trip in the dispatch
 * calendar that can only ever fail to be assigned is worse than hiding it.
 * §9 gives cancellation history its own home — the bookings list, with a
 * status filter. The day itself still exists in the result, empty.
 */
import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { and, asc, eq, notInArray, sql } from 'drizzle-orm';
import { calendarMonthSchema, manilaCivilDate } from '@rg/shared';
import type { CalendarDay, CalendarTrip } from '@rg/shared';
import { getDb } from '../../db/client';
import { bookings, drivers, tours, vans } from '../../db/schema';
import { driversFreeOn, vansFreeOn } from '../../services/dispatch/availability';
import { adminProcedure, router } from '../../trpc';

/**
 * `column BETWEEN :from AND :to`, comparing a civil date column to two
 * civil-date STRINGS.
 *
 * Raw `sql`, not `eq()`/`between()`: `bookings.tourDate` is Drizzle's `date`
 * column, whose default mode maps to a JS `Date` at the type level, so
 * either operator would force a `Date` here and reopen the midnight-shift
 * hazard this query exists to avoid. Identical in shape to `onDate()`
 * (`services/dispatch/availability.ts`) and `on()` (`services/capacity.ts`)
 * — kept local rather than shared, same reasoning as those two: this
 * module's date comparison isn't either of their jobs.
 */
function betweenDates(column: typeof bookings.tourDate, from: string, to: string) {
  return sql`${column} BETWEEN ${from} AND ${to}`;
}

/**
 * Days in a calendar month (1..31) — pure calendar arithmetic, not a
 * database query and not a timezone conversion. `month` here is 1..12;
 * passing it as the (0-indexed) month argument to `Date` deliberately
 * requests "day 0 of the following month", which `Date` normalizes to the
 * last day of the target month, December included (`month: 12` asks for day
 * 0 of month-index 12, i.e. next January, which rolls back correctly).
 */
function daysInMonth(year: number, month: number): number {
  return new Date(year, month, 0).getDate();
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

const dayOptionsInput = z.object({ bookingId: z.number().int().positive() }).strict();

export const adminCalendarRouter = router({
  /**
   * Every day of the requested month, Manila-local, each carrying its trips
   * and a `needsAssignmentCount`.
   *
   * One query, not one per day: the day list is generated from
   * `year`/`month` first (so empty days exist in the result) and the rows
   * this query returns are bucketed into it afterward.
   */
  month: adminProcedure('bookingsView')
    .input(calendarMonthSchema)
    .query(async ({ input }) => {
      const { year, month } = input;
      const lastDay = daysInMonth(year, month);
      const from = `${year}-${pad(month)}-01`;
      const to = `${year}-${pad(month)}-${pad(lastDay)}`;

      const rows = await getDb()
        .select({
          bookingId: bookings.id,
          ref: bookings.ref,
          tourTitle: tours.title,
          pax: bookings.pax,
          status: bookings.status,
          tourDate: bookings.tourDate,
          vanId: bookings.vanId,
          vanPlate: vans.plate,
          driverId: bookings.driverId,
          driverName: drivers.name,
        })
        .from(bookings)
        .innerJoin(tours, eq(tours.id, bookings.tourId))
        .leftJoin(vans, eq(vans.id, bookings.vanId))
        .leftJoin(drivers, eq(drivers.id, bookings.driverId))
        .where(
          and(
            betweenDates(bookings.tourDate, from, to),
            // Controller ruling 2026-10-14 — see the module doc.
            notInArray(bookings.status, ['cancelled', 'expired']),
          ),
        )
        .orderBy(asc(bookings.tourDate), asc(bookings.id));

      const byDate = new Map<string, CalendarTrip[]>();
      for (let day = 1; day <= lastDay; day += 1) {
        byDate.set(`${year}-${pad(month)}-${pad(day)}`, []);
      }

      for (const row of rows) {
        // The Manila civil date, never a UTC timestamp sliced into one —
        // same conversion `admin.bookings.list`/`.detail` already use for
        // this column.
        const date = manilaCivilDate(row.tourDate);
        const trips = byDate.get(date);
        if (!trips) continue; // Can't happen: the BETWEEN already bounds this.

        const needsAssignment =
          (row.status === 'confirmed' || row.status === 'assigned') &&
          (row.vanId === null || row.driverId === null);

        const trip: CalendarTrip = {
          bookingId: row.bookingId,
          ref: row.ref,
          tourTitle: row.tourTitle,
          pax: row.pax,
          status: row.status,
          vanId: row.vanId,
          vanPlate: row.vanPlate,
          driverId: row.driverId,
          driverName: row.driverName,
          needsAssignment,
          awaitingPaymentCheck: row.status === 'pending_verification',
        };
        trips.push(trip);
      }

      const days: CalendarDay[] = [...byDate.entries()].map(([date, trips]) => ({
        date,
        trips,
        needsAssignmentCount: trips.filter((trip) => trip.needsAssignment).length,
      }));

      return { days };
    }),

  /**
   * The dropdown contents for one booking's assign action: every van and
   * driver free on ITS tour date, excluding its own current assignment (so
   * re-assigning a booking still offers the van/driver it already holds).
   *
   * No SQL filtering of vans or drivers lives here — see the module doc.
   */
  dayOptions: adminProcedure('assignVanDriver')
    .input(dayOptionsInput)
    .query(async ({ input }) => {
      const [booking] = await getDb()
        .select({ tourDate: bookings.tourDate, pax: bookings.pax })
        .from(bookings)
        .where(eq(bookings.id, input.bookingId))
        .limit(1);
      if (!booking) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'No booking with that id.' });
      }

      const date = manilaCivilDate(booking.tourDate);
      return await getDb().transaction(async (tx) => ({
        vans: await vansFreeOn(tx, date, booking.pax, { excludeBookingId: input.bookingId }),
        drivers: await driversFreeOn(tx, date, { excludeBookingId: input.bookingId }),
      }));
    }),
});
