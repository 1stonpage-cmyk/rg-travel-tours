/**
 * `driver.trips` — the driver portal's trip list (Week 6 plan, Task 2;
 * BUILD_SPEC §8 "Driver sees their assigned trips: today, upcoming,
 * history").
 *
 * **The first `driverProcedure` ever mounted on `appRouter`.** Task 1 built
 * the gate and could only prove it against a test-local router, because
 * `procedure-role-metadata.test.ts` did not yet recognise the `driver`
 * access kind. This task taught that guard the kind, so every driver
 * procedure from here on is enumerated and must refuse an anonymous, a
 * staff and a customer caller — see the `driver` branch in that file.
 *
 * ## The filter comes from the session and nowhere else
 *
 * `ctx.driver.driverId` is the whole `WHERE`. There is no input on this
 * procedure, so there is no field through which to ask for another
 * driver's day — not a `driverId`, not a `ref`, not a date. That is the
 * control, and it is structural rather than remembered: `requireDriver`
 * put the id there, and a resolver that reached for one anywhere else
 * would have to invent it.
 *
 * ## One query, not one per row
 *
 * `tours` is joined for the title and `vans` left-joined for the plate —
 * `bookings.van_id` is nullable (a trip can be confirmed before dispatch
 * assigns a van) and such a trip must still appear, so `leftJoin` and a
 * `null` plate rather than an inner join that would silently drop it.
 *
 * ## "Today" is the Manila civil date, and `now` is explicit
 *
 * The clock is read ONCE, in the resolver, at the request boundary — the
 * same place `driver.login` reads it — and passed into `listDriverTrips`
 * as an argument. CLAUDE.md's rule, and the reason for it: a clock read
 * inside the query could not be tested at the 16:00 UTC boundary without
 * faking timers globally, which is how a timezone bug survives its own
 * suite. The client sends no time either way, so a driver cannot ask to be
 * shown yesterday's work as today's.
 *
 * `manilaCivilDate(now)` then feeds the pure `driverTripBucket` from
 * `@rg/shared` — the same function the tabs use, which is why the client
 * cannot disagree with this list. The 00:00-07:59 Manila window, where the
 * UTC calendar day is still yesterday, answers correctly without anyone
 * having to remember it exists.
 */
import { asc, eq } from 'drizzle-orm';
import { driverTripBucket, manilaCivilDate, type DriverTripRow } from '@rg/shared';
import { getDb } from '../../db/client';
import { bookings, tours, vans } from '../../db/schema';
import { driverProcedure, router } from '../../trpc';

/**
 * Every trip assigned to ONE driver, oldest first, each carrying the bucket
 * it belongs in as of `now`.
 *
 * ALL of them, not just today's: §8's three tabs are one request, and a
 * driver with no signal at a pier has whatever the last load gave them.
 * Ordered `tour_date` ascending (then `id`, so two trips on one day have a
 * stable order rather than whatever the engine returns).
 *
 * No status filter. A cancelled or expired trip the driver was assigned to
 * still belongs in their history — hiding it would leave a driver who drove
 * to a pickup unable to see the trip that sent them there.
 *
 * `driverId` is a plain argument because the only caller passes
 * `ctx.driver.driverId`; `now` is a plain argument so a test can stand on
 * the 16:00 UTC boundary without faking the clock. Exported for that test
 * and for no other reason — nothing else may call it with a driver id it
 * did not get from a driver's own session.
 */
export async function listDriverTrips(driverId: number, now: Date): Promise<DriverTripRow[]> {
  const todayManila = manilaCivilDate(now);

  const rows = await getDb()
    .select({
      bookingId: bookings.id,
      ref: bookings.ref,
      tourTitle: tours.title,
      tourDate: bookings.tourDate,
      pax: bookings.pax,
      status: bookings.status,
      vanPlate: vans.plate,
    })
    .from(bookings)
    .innerJoin(tours, eq(tours.id, bookings.tourId))
    .leftJoin(vans, eq(vans.id, bookings.vanId))
    .where(eq(bookings.driverId, driverId))
    .orderBy(asc(bookings.tourDate), asc(bookings.id));

  return rows.map((row) => {
    /*
     * `bookings.tour_date` is a `date()` column, so Drizzle hands back a
     * `Date` and every consumer wants the civil string — the same
     * conversion `admin/bookings.ts` and the expiry job apply, through the
     * same helper. A `toISOString().slice(0, 10)` here would be the UTC
     * day, which is the one bug this whole feature is shaped around.
     */
    const tourDate = manilaCivilDate(row.tourDate);
    return { ...row, tourDate, bucket: driverTripBucket(tourDate, todayManila) };
  });
}

export const driverTripsRouter = router({
  /**
   * The signed-in driver's trips. **No input at all**, by design: the
   * driver id comes from `ctx.driver`, so there is no field through which
   * to ask for another driver's day, and `now` is this server's clock.
   */
  trips: driverProcedure.query(
    async ({ ctx }): Promise<DriverTripRow[]> =>
      await listDriverTrips(ctx.driver.driverId, new Date()),
  ),
});
