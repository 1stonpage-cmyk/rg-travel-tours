/**
 * The four primitives both capacity services share — the TOUR one
 * (`services/capacity.ts`) and the TRANSFER one
 * (`services/transfers/capacity.ts`).
 *
 * They were private to `capacity.ts` until the transfers-launch plan's Task T7
 * gave the same questions a second asker. They live here, in a module that
 * imports neither of them, for one reason: the alternative shapes are both
 * worse. Re-declaring `holdsCapacity` in the transfer module would put the set
 * of statuses that hold a van in two places, which is the single thing §5's
 * shared `CAPACITY_HOLDING_STATUSES` constant exists to prevent; importing them
 * from one capacity module into the other makes a cycle, since the tour module
 * also calls the transfer module's pool functions.
 *
 * Nothing here takes a lock or decides anything. Every caller still owes the
 * lock order and THE PRECONDITION documented in `services/capacity.ts`.
 */
import { inArray, sql } from 'drizzle-orm';
import { CAPACITY_HOLDING_STATUSES } from '@rg/shared';
import { bookings } from '../db/schema';

const CIVIL_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * A tour date is a CIVIL date in Asia/Manila (`YYYY-MM-DD`), never an instant:
 * it is passed and compared as a string from end to end, so no timezone
 * conversion can shift the day near midnight.
 *
 * This THROWS on a malformed date rather than returning a verdict, and the
 * distinction matters: MySQL treats an invalid date literal in a `WHERE` as a
 * warning and compares it as NULL, so a typo'd date would quietly count zero
 * bookings and read as "room available". A programmer error has to be loud. The
 * guest-facing boundary (`quoteInput`/`createHoldInput` in @rg/shared) has
 * already rejected anything but this shape, so a throw here is unreachable from
 * the public flow.
 */
export function assertCivilDate(date: string): void {
  if (!CIVIL_DATE.test(date)) {
    throw new TypeError(`Expected a YYYY-MM-DD civil date, got "${date}"`);
  }
}

/** `COUNT(*)` from a single-row result. No row at all is a failure, not a zero. */
export function onlyCount(rows: Array<{ n: number }>): number {
  const [row] = rows;
  if (!row) throw new Error('COUNT(*) returned no row');
  return Number(row.n);
}

export const TOTAL = { n: sql<number>`COUNT(*)` };

/** `column = :date`, comparing a civil date to a civil-date string. */
export function on(column: typeof bookings.tourDate, date: string) {
  return sql`${column} = ${date}`;
}

/**
 * Bookings in one of the five statuses that hold capacity — read from the
 * shared `CAPACITY_HOLDING_STATUSES` constant (§5's table), never restated
 * here: removing a status from that set oversells the fleet.
 */
export const holdsCapacity = inArray(bookings.status, [...CAPACITY_HOLDING_STATUSES]);
