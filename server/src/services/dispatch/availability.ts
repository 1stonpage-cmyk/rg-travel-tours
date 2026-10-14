/**
 * Week 5 "Dispatch", Task 3: the availability module.
 *
 * The single source of truth for "which van and which driver are free on
 * this date" — §9 "Calendar"'s exclusion rules, written once here and
 * nowhere else. Five later tasks read this module (the calendar's
 * dropdowns, the auto-suggest, the assignment mutation's re-check inside
 * its lock, and two screens); if the rules lived in more than one place
 * they would drift, and the specific thing that drift produces is one van
 * sent to two trips on the same morning.
 *
 * **This module WRITES NOTHING.** `vansFreeOn` and `driversFreeOn` are
 * reads only — the assignment mutation that writes `bookings.van_id` /
 * `driver_id` is a later task, not this one.
 *
 * ## Capacity COUNTS, availability IDENTIFIES
 *
 * `assessCapacity()` (`services/capacity.ts`) answers "may one more group
 * book this tour on this day?" by counting the whole fleet against every
 * capacity-holding booking on that date, across ALL tours. This module
 * answers a different question — "which specific vans/drivers are free?" —
 * by identifying rows, one at a time, each checked against bookings that
 * are actually assigned to IT.
 *
 * The two are allowed to disagree in exactly one direction: `vansFreeOn` /
 * `driversFreeOn` may be MORE generous than `assessCapacity`'s arithmetic,
 * because capacity deducts every capacity-holding booking from the fleet
 * whether or not it has a van yet, while this module only excludes a van
 * that is actually assigned. They must NEVER disagree about whether a
 * van's STATUS makes it usable at all — that is the one-van, one-date,
 * no-other-bookings condition the status-agreement test in
 * `dispatch-availability.test.ts` pins.
 *
 * ## The exclusion rules (§9 "Calendar")
 *
 * Excluded van:
 *  - `is_active = 0` — soft-deleted.
 *  - `status <> VAN_STATUS_SELLABLE` — anything but `available`. Allow-list,
 *    per the owner's Q1 decision (2026-10-14) — imported from `db/schema`,
 *    never restated as a literal and never written as a deny-list.
 *  - `capacity < minCapacity` — too small for this group.
 *  - Assigned to another booking on this date whose status holds capacity.
 *
 * Excluded driver:
 *  - `is_active = 0` — soft-deleted.
 *  - A `driver_leaves` row covers the date — inclusive at both ends.
 *  - Assigned to another booking on this date whose status holds capacity.
 *
 * **Not excluded, deliberately:** `drivers.status = 'off_duty'`. §9 lists
 * driver status as active / on leave (a date range) / inactive — leave is a
 * range, not a flag, and excluding on the flag would hide a driver from
 * every future date the moment someone set it. If the owner wants the flag
 * to block dispatch too, that is Q4 — not decided here.
 *
 * ## NOT EXISTS, never a count, never a LEFT JOIN … IS NULL
 *
 * Two bookings holding the same van/driver would make a count subtract
 * twice — the exact bug `assessCapacity`'s Gate 3 comment warns about for
 * drivers. A correlated `NOT EXISTS` has no such failure mode.
 */
import { and, asc, eq, gte, inArray, isNotNull, ne, notExists, sql } from 'drizzle-orm';
import { CAPACITY_HOLDING_STATUSES } from '@rg/shared';
import type { Transaction } from '../../db/client';
import { bookings, driverLeaves, drivers, vans, VAN_STATUS_SELLABLE } from '../../db/schema';

export interface FreeVan {
  id: number;
  plate: string;
  model: string;
  capacity: number;
}

export interface FreeDriver {
  id: number;
  name: string;
  code: string;
}

export interface FreeOnOptions {
  /** Ignore this booking's own current assignment, so re-assigning a
   *  booking does not exclude the van/driver it already holds. */
  excludeBookingId?: number;
}

/**
 * Bookings in one of the five statuses that hold capacity — read from the
 * shared `CAPACITY_HOLDING_STATUSES` constant, never restated here.
 * `cancelled`, `expired` and `completed` release the day, which is why a
 * cancelled booking's van/driver comes back free.
 */
const holdsCapacity = inArray(bookings.status, [...CAPACITY_HOLDING_STATUSES]);

/**
 * `column = :date`, comparing a civil date to a civil-date string.
 *
 * Raw `sql`, not `eq()`: `bookings.tourDate` is Drizzle's `date` column
 * type, whose default mode maps to a JS `Date` at the type level, so `eq()`
 * would force a `Date` here and reopen the midnight-shift hazard this whole
 * module avoids by staying on civil-date strings end to end. Identical to
 * the helper of the same shape in `services/capacity.ts` — kept local
 * rather than shared, so this module does not depend on the capacity
 * service for something that isn't the capacity service's job.
 */
function onDate(column: typeof bookings.tourDate, date: string) {
  return sql`${column} = ${date}`;
}

/**
 * Every van free for `minCapacity` guests on `date`.
 *
 * Ordered by `capacity` then `id`, so the dropdowns are stable and the
 * "smallest that fits" auto-suggest is just `[0]`.
 */
export async function vansFreeOn(
  tx: Transaction,
  date: string,
  minCapacity: number,
  opts?: FreeOnOptions,
): Promise<FreeVan[]> {
  const busyClauses = [
    onDate(bookings.tourDate, date),
    holdsCapacity,
    isNotNull(bookings.vanId),
    eq(bookings.vanId, vans.id),
  ];
  if (opts?.excludeBookingId !== undefined) {
    busyClauses.push(ne(bookings.id, opts.excludeBookingId));
  }

  return await tx
    .select({ id: vans.id, plate: vans.plate, model: vans.model, capacity: vans.capacity })
    .from(vans)
    .where(
      and(
        eq(vans.isActive, true),
        eq(vans.status, VAN_STATUS_SELLABLE),
        gte(vans.capacity, minCapacity),
        notExists(
          tx
            .select({ one: sql`1` })
            .from(bookings)
            .where(and(...busyClauses)),
        ),
      ),
    )
    .orderBy(asc(vans.capacity), asc(vans.id));
}

/**
 * Every driver free on `date`.
 *
 * Ordered by `name` then `id`, so the dropdowns are stable.
 */
export async function driversFreeOn(
  tx: Transaction,
  date: string,
  opts?: FreeOnOptions,
): Promise<FreeDriver[]> {
  const busyClauses = [
    onDate(bookings.tourDate, date),
    holdsCapacity,
    isNotNull(bookings.driverId),
    eq(bookings.driverId, drivers.id),
  ];
  if (opts?.excludeBookingId !== undefined) {
    busyClauses.push(ne(bookings.id, opts.excludeBookingId));
  }

  return await tx
    .select({ id: drivers.id, name: drivers.name, code: drivers.code })
    .from(drivers)
    .where(
      and(
        eq(drivers.isActive, true),
        // On leave — `driver_leaves` is INCLUSIVE at both ends, so `<=` /
        // `>=` (not `<` / `>`): a one-day leave is `start_date = end_date`.
        notExists(
          tx
            .select({ one: sql`1` })
            .from(driverLeaves)
            .where(
              and(
                eq(driverLeaves.driverId, drivers.id),
                sql`${driverLeaves.startDate} <= ${date}`,
                sql`${driverLeaves.endDate} >= ${date}`,
              ),
            ),
        ),
        notExists(
          tx
            .select({ one: sql`1` })
            .from(bookings)
            .where(and(...busyClauses)),
        ),
      ),
    )
    .orderBy(asc(drivers.name), asc(drivers.id));
}
