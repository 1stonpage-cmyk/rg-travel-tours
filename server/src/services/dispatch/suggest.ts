/**
 * Week 5 "Dispatch", Task 11: `admin.dispatch.suggest` — auto-suggest.
 *
 * BUILD_SPEC §5: "Admin calendar auto-suggests a van (smallest that fits)
 * and an available driver."
 *
 * **Smallest van that fits** is unambiguous and falls straight out of
 * Task 3's ordering: `vansFreeOn()` already returns vans sorted by
 * `capacity` then `id`, so the smallest that fits is simply `[0]`.
 *
 * **"An available driver" is ambiguous, and this is a developer proposal,
 * not R&G policy** (Q6, _proposed by developer — pending R&G confirmation_,
 * the same convention Week 4's twelve-hour window uses). Lowest-id-wins
 * would hand the same driver every trip, which a dispatcher would undo by
 * hand every morning. So the rule here is: among the drivers `driversFreeOn`
 * already says are free, pick the one with the FEWEST capacity-holding
 * bookings in the seven days centred on the tour date (the date minus three
 * days through the date plus three), tie-broken by name then id. The
 * tiebreak needs no extra sort key of its own — `driversFreeOn` already
 * orders its answer by name then id, and a stable sort by load count alone
 * (Array#sort is guaranteed stable, ECMA-262 23.1.3.30) preserves that order
 * for every tie.
 *
 * **This module WRITES NOTHING** — no `INSERT`, `UPDATE` or `DELETE`, and it
 * never calls `assignVanAndDriver`. It returns a suggestion; the dispatcher
 * presses Assign, and Task 10's locked mutation is the only writer. A
 * suggest that assigned would turn a dispatcher's mis-click into a driver's
 * morning.
 *
 * No money is read or written here: `pax` and dates only.
 */
import { TRPCError } from '@trpc/server';
import { and, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import { CAPACITY_HOLDING_STATUSES, civilDateFromDate } from '@rg/shared';
import type { Transaction } from '../../db/client';
import { bookings } from '../../db/schema';
import { driversFreeOn, vansFreeOn, type FreeDriver, type FreeVan } from './availability';

export interface Suggestion {
  van: FreeVan | null;
  driver: FreeDriver | null;
  /** Why nothing was suggested, when either side is null. */
  note: 'ok' | 'no_van_fits' | 'no_driver_free' | 'nothing_free';
}

/**
 * `column` falls within the seven civil days centred on `centerDate`
 * (`centerDate - 3` through `centerDate + 3`, inclusive both ends).
 *
 * Raw SQL `DATE_SUB` / `DATE_ADD` on the DATE column, comparing against the
 * civil-date STRING directly — the same reason `availability.ts`'s
 * `onDate()` stays on raw `sql` rather than `eq()`: `bookings.tourDate`'s
 * default mode maps to a JS `Date` at the type level, and doing the
 * arithmetic in SQL means this never has to parse or re-serialize a civil
 * date in TypeScript to compute the window.
 */
function withinSevenDayWindow(column: typeof bookings.tourDate, centerDate: string) {
  return sql`${column} BETWEEN DATE_SUB(${centerDate}, INTERVAL 3 DAY) AND DATE_ADD(${centerDate}, INTERVAL 3 DAY)`;
}

/**
 * Every free driver's count of capacity-holding bookings in the seven-day
 * window centred on `date` — keyed by driver id, 0 for a driver with none.
 * One grouped query, not one query per driver.
 */
async function loadCounts(
  tx: Transaction,
  date: string,
  driverIds: readonly number[],
): Promise<Map<number, number>> {
  const counts = new Map<number, number>();
  if (driverIds.length === 0) return counts;

  const rows = await tx
    .select({ driverId: bookings.driverId, n: sql<string>`count(*)` })
    .from(bookings)
    .where(
      and(
        isNotNull(bookings.driverId),
        inArray(bookings.driverId, driverIds as number[]),
        inArray(bookings.status, [...CAPACITY_HOLDING_STATUSES]),
        withinSevenDayWindow(bookings.tourDate, date),
      ),
    )
    .groupBy(bookings.driverId);

  for (const row of rows) {
    if (row.driverId !== null) counts.set(row.driverId, Number(row.n));
  }
  return counts;
}

/**
 * Suggests a van and a driver for one booking — never writes, never throws
 * a refusal (it has no refusal type; a side that found nothing is `null`
 * with `note` explaining why).
 *
 * Must be called inside a transaction the caller owns, same discipline as
 * every other reader in this module: a read on a pooled connection would be
 * a read outside this function's own consistency with whatever locks the
 * CALLER may be holding (it takes none of its own).
 */
export async function suggestAssignment(tx: Transaction, bookingId: number): Promise<Suggestion> {
  const [booking] = await tx
    .select({ tourDate: bookings.tourDate, pax: bookings.pax })
    .from(bookings)
    .where(eq(bookings.id, bookingId))
    .limit(1);
  if (!booking) {
    // The `Suggestion` shape has no slot for "no such booking" — the one
    // caller (the dispatch screen for a booking it already has open) cannot
    // reach this with an id that does not exist. Loud rather than silently
    // suggesting nothing for a booking that was never there, same discipline
    // as `assignVanAndDriver`'s null-tour_date throw.
    /*
     * A stale booking id is a REFUSAL, not a programmer error (controller
     * fix, 2026-10-15). The implementer flagged that the brief's
     * `Suggestion.note` union has no value for it and threw a plain
     * `Error` rather than invent one — the right instinct, and the right
     * answer is neither: a plain `Error` surfaces as a 500.
     *
     * This is reachable in ordinary use: a bookmarked day, a second tab, a
     * trip cancelled by someone else while this screen sat open. The
     * sibling `admin.calendar.dayOptions` — which the SAME screen calls on
     * every day selection — already answers `NOT_FOUND` for exactly this,
     * so the two now agree and the UI has one thing to handle.
     *
     * `note` stays reserved for "nothing is free", which is a successful
     * answer to a valid question.
     */
    throw new TRPCError({ code: 'NOT_FOUND', message: 'No booking with that id.' });
  }

  const date = civilDateFromDate(booking.tourDate);
  if (date === null) {
    // Can't happen: `tour_date` is NOT NULL at the schema.
    throw new Error(`booking ${bookingId} has a null tour_date`);
  }

  const [freeVans, freeDrivers] = await Promise.all([
    vansFreeOn(tx, date, booking.pax, { excludeBookingId: bookingId }),
    driversFreeOn(tx, date, { excludeBookingId: bookingId }),
  ]);

  const van: FreeVan | null = freeVans[0] ?? null;

  let driver: FreeDriver | null = null;
  if (freeDrivers.length > 0) {
    const counts = await loadCounts(
      tx,
      date,
      freeDrivers.map((d) => d.id),
    );
    // Stable sort by load count ONLY. `freeDrivers` already comes back from
    // `driversFreeOn` ordered by name then id — restating that tiebreak
    // here would be a second home for a rule that already has one.
    const byLoad = [...freeDrivers].sort(
      (a, b) => (counts.get(a.id) ?? 0) - (counts.get(b.id) ?? 0),
    );
    driver = byLoad[0] ?? null;
  }

  const note: Suggestion['note'] =
    van !== null && driver !== null
      ? 'ok'
      : van !== null
        ? 'no_driver_free'
        : driver !== null
          ? 'no_van_fits'
          : 'nothing_free';

  return { van, driver, note };
}
