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
 * `INSERT … ON DUPLICATE KEY UPDATE` — safe when two requests race to create
 * the same row — and then `SELECT … FOR UPDATE`. Calling the `INSERT` "a
 * no-op touch" understates it: see the measurement note on the statement
 * itself, which is what actually serialises today.
 *
 * ## THE PRECONDITION: `takeSlotLocks` must come FIRST in the transaction
 *
 * Under REPEATABLE READ, InnoDB pins the transaction's consistent-read
 * snapshot at its first **non-locking** read, and every plain `SELECT`
 * afterwards is answered from that snapshot no matter what has committed
 * since. `INSERT … ON DUPLICATE KEY UPDATE` and `SELECT … FOR UPDATE` do not
 * pin one, so the locks themselves are safe to take — but a plain `SELECT`
 * taken BEFORE them (recomputing a quote, reading a tour, anything) pins the
 * snapshot before the lock is granted. The loser of a race then counts
 * bookings as of a moment before the winner committed, passes the capacity
 * check and books the same van: **the locks are granted and change nothing.**
 *
 * So: in the booking transaction, `takeSlotLocks()` comes first, before any
 * consistent read. `assessCapacity()`'s own first plain read is the `tours`
 * select below, which is already after the locks.
 *
 * This is a documented precondition rather than a defence inside the code
 * because the obvious defence was measured and rejected. Turning the two
 * booking counts into locking reads (`FOR SHARE`) does fix the snapshot —
 * locking reads see the latest committed row, not the snapshot — but a
 * ranged locking read on `bookings` takes GAP locks, and the other
 * transaction's own `INSERT` into that gap needs an insert-intention lock
 * that conflicts with it. Two bookings for the same tour on DIFFERENT dates
 * both SUCCEED today; with `FOR SHARE` they died with `ER_LOCK_DEADLOCK`
 * (1213). Trading a precondition for a deadlock between unrelated bookings
 * is not a fix. Both halves of that measurement are pinned by tests: `does
 * NOT serialise two bookings on different dates` (which `FOR SHARE` turns
 * red) and the hazard guard `HAZARD: a consistent read taken BEFORE the
 * locks …`.
 *
 * "Both succeed", deliberately, rather than "contend for nothing" (Ruling
 * 20, corrected from a Task 5 measurement): until a date's lock rows exist,
 * the `INSERT … ON DUPLICATE KEY UPDATE` below inserts a NEW key and takes a
 * next-key lock on it, so a second transaction inserting a neighbouring date
 * — in either table — WAITS for the first to commit. It then proceeds and
 * books its own day, which is why the test above is green and why the
 * difference matters: waiting costs latency, whereas the `FOR SHARE`
 * variant killed one of the two outright. Once the rows exist (every date
 * after its first booking) the two contend for nothing at all. Anything
 * engineering a race between two neighbouring dates has to pre-create the
 * rows first, or it is measuring this insert serialisation instead of
 * whatever it meant to measure (see `create-hold.test.ts`'s coupon race).
 *
 * ## Everything reads through `tx`
 *
 * Every query here takes the caller's `Transaction` handle, never `getDb()`.
 * A count read on a pooled connection would be a count taken outside the
 * locks — and under REPEATABLE READ a non-locking re-read can return stale
 * data, which is precisely the bug a sequential test cannot see.
 *
 * ## `assessCapacity` never throws a REFUSAL
 *
 * It returns `{ ok: false, reason }`, because the caller (`createHold()`,
 * Task 5, and the router above it) turns the reason into guest-facing copy.
 * It does still throw on a malformed ARGUMENT — deliberately, because that is
 * a programmer error and the alternative fails open; see `assertCivilDate`.
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

/** The verdict. Never a thrown REFUSAL — see the module note. */
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
 * **These must be the FIRST statements of the booking transaction.** A plain
 * `SELECT` before them pins the REPEATABLE READ snapshot before the lock is
 * granted, and the capacity check that follows is then answered from a
 * moment before the winner of the race committed — the locks are taken and
 * enforce nothing. See "THE PRECONDITION" in the module note; it is pinned
 * by a hazard-guard test rather than left as a claim.
 *
 * Raw statements rather than the query builder, for two reasons: the civil
 * date stays a string (Drizzle's `date` columns map to `Date`, and a `Date`
 * is exactly the midnight-shift hazard this module avoids), and the four
 * statements then read as the lock protocol §5 writes out.
 */
export async function takeSlotLocks(tx: Transaction, tourId: number, date: string): Promise<void> {
  assertCivilDate(date);

  /*
   * 1. The shared fleet for that date. ALWAYS first.
   *
   * MEASURED, and worth knowing before touching either statement: when the
   * row does not exist yet, two concurrent `INSERT`s of the same date can
   * deadlock (the duplicate-key path takes an S lock and then needs an X
   * lock), which at three or more concurrent bookings for one date becomes
   * likely rather than theoretical. `createHold()` therefore wants a retry
   * on MySQL error 1213 (`ER_LOCK_DEADLOCK`) around the whole transaction;
   * it is not built here, because retrying is the caller's transaction's
   * business, not this function's.
   */
  await tx.execute(
    sql`INSERT INTO fleet_date_slots (date) VALUES (${date}) ON DUPLICATE KEY UPDATE date = date`,
  );
  /*
   * MEASURED (Task 4, mutation M3): deleting THIS statement and keeping the
   * `INSERT` above leaves the whole suite green — the `ON DUPLICATE KEY
   * UPDATE` takes an exclusive lock on the row it touches, created or
   * duplicate, and is what serialises today. So this line is the CONTRACT
   * (§5 names it) but is not independently pinned by a test: do not delete it
   * as dead code on the strength of a green run. A lock that depends on
   * InnoDB locking a no-op `date = date` update is an implementation detail,
   * not a guarantee.
   */
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
 * **Call `takeSlotLocks(tx, tourId, date)` first, as the transaction's first
 * statements.** Two distinct requirements hide in that one sentence:
 *
 *  1. Without the locks, every number below is a read that a concurrent
 *     transaction can invalidate before the booking is inserted, and two
 *     guests take the same last van.
 *  2. Without the locks being **first** — no plain `SELECT` anywhere before
 *     them — the REPEATABLE READ snapshot is pinned before the lock is
 *     granted, the counts below are answered from before the winner's
 *     commit, and holding the locks changes nothing. A quote recomputed from
 *     the database earlier in the same transaction is exactly that mistake.
 *     See "THE PRECONDITION" in the module note.
 *
 * The counts are deliberately NOT locking reads; the module note records the
 * `FOR SHARE` measurement and the deadlock that ruled it out.
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
