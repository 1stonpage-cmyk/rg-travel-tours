/**
 * The capacity service (Week 3 checkout plan, Task 4) — the one place that
 * answers "may one more group book this tour on this day?".
 *
 * §5's rule, as the owner settled it (2026-10-11, Q7, _pending R&G
 * confirmation_): **each booked group requires one van.** Per tour per day,
 * accept bookings up to
 *
 *   MIN(tour.groups_per_day, vans free that day across all tours)
 *
 * and never overbook automatically. §5's checklist spells the fleet half out
 * in two parts, and both are enforced here: at least one VAN free that day
 * (active, not `for_repair`, `capacity >= pax`) and at least one DRIVER free
 * that day (active, not on leave) — with every booking already holding
 * capacity that day counting as one van and one driver taken, "so we never
 * sell more trips than the fleet can run".
 *
 * ## The lock order is the whole point
 *
 * `takeSlotLocks()` takes **`fleet_date_slots(date)` first, then
 * `tour_date_slots(tour_id, date)`** — always, without exception. Two
 * transactions taking the same pair in opposite orders deadlock (A holds
 * fleet and waits for tour while B holds tour and waits for fleet), InnoDB
 * kills one, and a deadlock passes every sequential test and fails on a
 * holiday weekend. A later task adds a THIRD lock — the coupon row — strictly
 * after both of these; nothing here may make that impossible, which is why
 * this function takes the two slot locks and nothing else.
 *
 * Both rows are created on demand (owner decision Q8):
 * `INSERT … ON DUPLICATE KEY UPDATE` — a no-op touch that is safe when two
 * requests race to create the same row — and then `SELECT … FOR UPDATE`.
 *
 * ## Everything reads through `tx`
 *
 * Every query here takes the caller's `Transaction` handle, never `getDb()`.
 * A count read on a pooled connection would be a count taken outside the
 * locks — and under REPEATABLE READ a non-locking re-read can return stale
 * data, which is precisely the bug a sequential test cannot see.
 *
 * ## `assessCapacity` does not throw a refusal
 *
 * It returns `{ ok: false, reason }`, because the caller (`createHold()`,
 * Task 5, and the router above it) turns the reason into guest-facing copy.
 * The only things that throw here are malformed ARGUMENTS — a programmer
 * error, loud by design; see `assertCivilDate`.
 *
 * ## Not in scope
 *
 * §5's step 1 — "date is not past, not blocked for the tour" — is NOT
 * answered here: this function has no clock, and a blocked date is a
 * date-availability question (the date picker's) rather than a capacity one.
 * A tour that does not exist or has been switched off IS refused, because
 * `groups_per_day` is either unknowable or not for sale. The caller still
 * owes the past-date and `tour_blocked_dates` checks.
 */
import { and, eq, gte, inArray, ne, notExists, sql } from 'drizzle-orm';
import { CAPACITY_HOLDING_STATUSES } from '@rg/shared';
import type { Transaction } from '../db/client';
import { bookings, driverLeaves, drivers, tours, vans } from '../db/schema';

/**
 * Why a booking was refused. Each one is a different sentence to a guest —
 * "that day is fully booked for this tour" is not "we have no van big enough
 * for twelve of you" — so they stay separate values rather than one
 * `sold_out`.
 */
export const CAPACITY_REFUSAL_REASONS = [
  /** The tour does not exist, or is not active. */
  'tour_unavailable',
  /** This tour already holds `groups_per_day` bookings for that date. */
  'tour_sold_out',
  /** No van that fits `pax` is free that day, across every tour. */
  'no_van_available',
  /** No driver is free that day, across every tour. */
  'no_driver_available',
] as const;
export type CapacityRefusalReason = (typeof CAPACITY_REFUSAL_REASONS)[number];

/** The verdict. Never an exception — see the module note. */
export type CapacityVerdict = { ok: true } | { ok: false; reason: CapacityRefusalReason };

const CIVIL_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * A tour date is a CIVIL date in Asia/Manila (`YYYY-MM-DD`), never an
 * instant: it is passed and compared as a string from end to end, so no
 * timezone conversion can shift the day near midnight.
 *
 * This THROWS on a malformed date rather than returning a verdict, and the
 * distinction matters: MySQL treats an invalid date literal in a `WHERE` as
 * a warning and compares it as NULL, so a typo'd date would quietly count
 * zero bookings and read as "room available". A programmer error has to be
 * loud. The guest-facing boundary (`quoteInput`/`createHoldInput` in
 * @rg/shared) has already rejected anything but this shape, so a throw here
 * is unreachable from the public flow.
 */
function assertCivilDate(date: string): void {
  if (!CIVIL_DATE.test(date)) {
    throw new TypeError(`Expected a YYYY-MM-DD civil date, got "${date}"`);
  }
}

/** Same reasoning: `pax` of 0 would make `capacity >= pax` match every van. */
function assertPax(pax: number): void {
  if (!Number.isInteger(pax) || pax < 1) {
    throw new RangeError(`Expected a positive whole head count, got ${pax}`);
  }
}

/**
 * Creates both lock rows if they are absent and locks them, **fleet first,
 * tour second**. Every capacity read must happen after this, through the
 * same `tx`.
 *
 * Raw statements rather than the query builder, for two reasons: the civil
 * date stays a string (Drizzle's `date` columns map to `Date`, and a `Date`
 * is exactly the midnight-shift hazard this module avoids), and the four
 * statements then read as the lock protocol §5 writes out.
 */
export async function takeSlotLocks(tx: Transaction, tourId: number, date: string): Promise<void> {
  assertCivilDate(date);

  // 1. The shared fleet for that date. ALWAYS first.
  await tx.execute(
    sql`INSERT INTO fleet_date_slots (date) VALUES (${date}) ON DUPLICATE KEY UPDATE date = date`,
  );
  await tx.execute(sql`SELECT date FROM fleet_date_slots WHERE date = ${date} FOR UPDATE`);

  // 2. Then this tour's own groups_per_day row. ALWAYS second.
  await tx.execute(
    sql`INSERT INTO tour_date_slots (tour_id, date) VALUES (${tourId}, ${date})
        ON DUPLICATE KEY UPDATE tour_id = tour_id`,
  );
  await tx.execute(
    sql`SELECT tour_id FROM tour_date_slots WHERE tour_id = ${tourId} AND date = ${date} FOR UPDATE`,
  );
}

/** `COUNT(*)` from a single-row result. No row at all is a failure, not a zero. */
function onlyCount(rows: Array<{ n: number }>): number {
  const [row] = rows;
  if (!row) throw new Error('COUNT(*) returned no row');
  return Number(row.n);
}

const TOTAL = { n: sql<number>`COUNT(*)` };

/** `column = :date`, comparing a civil date to a civil-date string. */
function on(column: typeof bookings.tourDate, date: string) {
  return sql`${column} = ${date}`;
}

/**
 * Bookings in one of the five statuses that hold capacity — read from the
 * shared `CAPACITY_HOLDING_STATUSES` constant (§5's table), never restated
 * here: removing a status from that set oversells the fleet.
 */
const holdsCapacity = inArray(bookings.status, [...CAPACITY_HOLDING_STATUSES]);

/**
 * The verdict for one more group of `pax` on `tourId` / `date`.
 *
 * **Call `takeSlotLocks(tx, tourId, date)` first.** Without the locks every
 * number below is a read that a concurrent transaction can invalidate before
 * the booking is inserted, and two guests take the same last van.
 *
 * The three gates are §5's checklist in order, and the first one that fails
 * is the reason returned: the tour's own `groups_per_day`, then a van, then
 * a driver.
 */
export async function assessCapacity(
  tx: Transaction,
  tourId: number,
  date: string,
  pax: number,
): Promise<CapacityVerdict> {
  assertCivilDate(date);
  assertPax(pax);

  const [tour] = await tx
    .select({ groupsPerDay: tours.groupsPerDay })
    .from(tours)
    .where(and(eq(tours.id, tourId), eq(tours.isActive, true)))
    .limit(1);
  // Fail closed: no row means `groups_per_day` is unknowable or not for sale.
  if (!tour) return { ok: false, reason: 'tour_unavailable' };

  // Gate 1 — this tour's own limit for the day.
  const heldOnThisTour = onlyCount(
    await tx
      .select(TOTAL)
      .from(bookings)
      .where(and(eq(bookings.tourId, tourId), on(bookings.tourDate, date), holdsCapacity)),
  );
  if (heldOnThisTour >= tour.groupsPerDay) return { ok: false, reason: 'tour_sold_out' };

  /*
   * Every booking that holds capacity on that date, ACROSS ALL TOURS — each
   * one takes a van and a driver whether or not dispatch has assigned them
   * yet (§5: "count already-confirmed-but-unassigned bookings as consuming
   * one van and one driver each"). This is the number the per-tour lock
   * cannot protect, and the reason `fleet_date_slots` exists.
   */
  const heldAcrossTheFleet = onlyCount(
    await tx
      .select(TOTAL)
      .from(bookings)
      .where(and(on(bookings.tourDate, date), holdsCapacity)),
  );

  /*
   * Gate 2 — a van. `status <> 'for_repair'` rather than
   * `status = 'available'`: `on_trip` is where a van is TODAY, not a claim
   * on a future date, and §5 names `for_repair` as the disqualifying one.
   *
   * `capacity >= pax` filters the whole fleet by the size of THIS group
   * while the subtraction above counts every held booking regardless of the
   * van size it will need. In a mixed fleet that under-counts what is free,
   * which refuses a booking that might have fitted — the safe direction.
   * Never the other way: §5's rule is "never overbook automatically".
   */
  const vansThatFit = onlyCount(
    await tx
      .select(TOTAL)
      .from(vans)
      .where(and(eq(vans.isActive, true), ne(vans.status, 'for_repair'), gte(vans.capacity, pax))),
  );
  if (vansThatFit - heldAcrossTheFleet < 1) return { ok: false, reason: 'no_van_available' };

  /*
   * Gate 3 — a driver. `driver_leaves` is INCLUSIVE at both ends, so a
   * one-day leave is `start_date = end_date` and `<=` / `>=` are both
   * correct. `NOT EXISTS` rather than counting the leaves and subtracting:
   * two overlapping leaves for one driver would otherwise remove that driver
   * twice and hide a free van behind a phantom shortage.
   */
  const driversOnDuty = onlyCount(
    await tx
      .select(TOTAL)
      .from(drivers)
      .where(
        and(
          eq(drivers.isActive, true),
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
        ),
      ),
  );
  if (driversOnDuty - heldAcrossTheFleet < 1) return { ok: false, reason: 'no_driver_available' };

  return { ok: true };
}
