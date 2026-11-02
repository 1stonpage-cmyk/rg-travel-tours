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
 * (active, `status = VAN_STATUS_SELLABLE`, `capacity >= pax`) and at least
 * one DRIVER free that day (active, not on leave) — with every TOUR booking
 * already holding capacity that day counting as one van and one driver taken,
 * "so we never sell more trips than the fleet can run".
 *
 * ## The fleet is shared with TRANSFERS now (transfers-launch plan, Task T7)
 *
 * A tour blocks a vehicle and a driver for the whole civil day. A transfer
 * blocks its vehicle TYPE only for `[pickup, estimated end + buffer)`, and
 * consumes one job-unit of one driver's daily cap. So "a booking" is no longer
 * one unit of anything: this file counts TOURS (`countToursOn`) and asks
 * `services/transfers/capacity.ts` what the day's transfers have claimed —
 * each type's PEAK (Architecture §2, conditions 1–3) and the driver pool's
 * leftover job capacity (§2a, conditions 4–5). Both questions are answered
 * under the SAME `fleet_date_slots(date)` lock, in the same transaction, so a
 * hold is refused the instant either resource is short rather than one of them.
 *
 * There is deliberately NO second lock table: conditions (1)–(5) read across
 * both vehicle types and both product types for one date, so a per-type lock
 * would under-serialize exactly where the sharing happens.
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
import { and, eq, gte, sql } from 'drizzle-orm';
import type { Transaction } from '../db/client';
import { bookings, tours, vans, VAN_STATUS_SELLABLE } from '../db/schema';
import { assertCivilDate, holdsCapacity, on, onlyCount, TOTAL } from './capacity-sql';
import {
  countToursOn,
  countTransfersOn,
  driverTransferCapsOn,
  leftoverTransferCapacity,
  readDefaultDriverTransferCap,
  sellableVehiclesByType,
  transferPeaksByType,
} from './transfers/capacity';

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

/**
 * `assertCivilDate`, `onlyCount`, `TOTAL`, `on` and `holdsCapacity` were
 * private to this module until the transfers-launch plan's Task T7 gave the
 * same questions a second asker (`services/transfers/capacity.ts`). They now
 * live in `./capacity-sql` — unchanged, comments included — for the reasons
 * that module's own header gives.
 */

/** Same reasoning as `assertCivilDate`: `pax` of 0 would make `capacity >= pax` match every van. */
function assertPax(pax: number): void {
  if (!Number.isInteger(pax) || pax < 1) {
    throw new RangeError(`Expected a positive whole head count, got ${pax}`);
  }
}

/**
 * The FLEET half of the lock protocol, on its own: creates
 * `fleet_date_slots(date)` if it is absent and locks it. **Always the first
 * lock taken, by every path** — a tour hold (through `takeSlotLocks` below) and
 * a transfer hold (which has no `tour_id` and therefore no second lock to take)
 * alike.
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
export async function takeFleetDateLock(tx: Transaction, date: string): Promise<void> {
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
}

/**
 * Creates both lock rows if they are absent and locks them, **fleet first,
 * tour second**. Every capacity read must happen after this, through the same
 * `tx`, and the same FIRST-statements precondition `takeFleetDateLock` states
 * applies to this whole call.
 *
 * Signature and behaviour are unchanged by Task T7: the fleet half simply moved
 * into `takeFleetDateLock` above, because a TRANSFER hold needs that half alone
 * (no `tour_id`, so no `tour_date_slots` row to take). It is the same protocol,
 * in the same order, with the first half now callable on its own — proven by
 * `capacity.test.ts`'s existing lock-order and race tests passing unchanged.
 */
export async function takeSlotLocks(tx: Transaction, tourId: number, date: string): Promise<void> {
  await takeFleetDateLock(tx, date);

  // 2. Then this tour's own groups_per_day row. ALWAYS second.
  await tx.execute(
    sql`INSERT INTO tour_date_slots (tour_id, date) VALUES (${tourId}, ${date})
        ON DUPLICATE KEY UPDATE tour_id = tour_id`,
  );
  await tx.execute(
    sql`SELECT tour_id FROM tour_date_slots WHERE tour_id = ${tourId} AND date = ${date} FOR UPDATE`,
  );
}

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
 * a driver. Task T7 added a second check inside each of the fleet gates — the
 * shared-pool conditions (3) and (5) — without adding a refusal reason: a tour
 * refused for want of a vehicle gets `no_van_available` whichever of the two
 * vehicle checks refused it, because the sentence a guest reads is the same.
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
   * Every TOUR booking that holds capacity on that date, across all tours —
   * each one takes a van and a driver for the whole day whether or not dispatch
   * has assigned them yet (§5: "count already-confirmed-but-unassigned bookings
   * as consuming one van and one driver each"). This is the number the per-tour
   * lock cannot protect, and the reason `fleet_date_slots` exists.
   *
   * **It is tour-only, and that is a FIX, not a narrowing** (transfers-launch
   * plan, Task T7). Until transfers existed this count had no `product_type`
   * filter, which was correct while every booking was a tour; the moment a
   * transfer booking can exist, the unfiltered count blends the two, and both
   * gates below subtract it as though one held booking were one van plus one
   * driver taken for a day — which a windowed transfer is not. A transfer's
   * claim on the fleet is its type's PEAK (Gate 2) and its job COUNT against
   * the driver pool (Gate 3), both read below.
   */
  const toursToday = await countToursOn(tx, date);

  /*
   * Gate 2 — a van. `status = VAN_STATUS_SELLABLE` (an ALLOW-list), rather
   * than the old deny-list `status <> 'for_repair'` (owner decision
   * 2026-10-14, Q1). A deny-list makes every status added later sellable
   * until somebody notices; an allow-list makes it unsellable until somebody
   * decides. The first direction oversells a trip, the second refuses a
   * booking, and only one of those strands a guest at a pier — see the
   * comment beside `VAN_STATUS_SELLABLE` in `schema.ts` for the `on_trip`
   * consequence this carries.
   *
   * `capacity >= pax` filters the whole fleet by the size of THIS group
   * while the subtraction above counts every held booking regardless of the
   * van size it will need. In a mixed fleet that under-counts what is free,
   * which refuses a booking that might have fitted — the safe direction.
   * Never the other way: §5's rule is "never overbook automatically".
   *
   * ## TWO gates, not one (transfers-launch plan, Task T7)
   *
   * The check immediately below and the one after it answer DIFFERENT
   * questions, and a tour has to pass both:
   *
   *  - **Is a vehicle big enough for THIS party free, net of other tours?**
   *    That is the pax-filtered count below, and it is the check this file has
   *    always made. Seat size is a question transfers do not share — a
   *    transfer's vehicle is the guest's own choice of TYPE, not something
   *    sized against a `pax`.
   *  - **Net of what each vehicle TYPE's transfer peak has already claimed, is
   *    there enough raw vehicle count, fleet-wide, for every tour that day?**
   *    That is Architecture §2's condition (3), and it is deliberately NOT
   *    pax-filtered — the plan's own formula is in raw type counts.
   *
   * Running both is more conservative than either alone, which is the right
   * default where the plan's model has an unaddressed edge: "vehicles within a
   * type are fungible for this count" is its own stated simplification, and
   * erring towards a refusal rather than an oversell is the direction §5 picks
   * everywhere else. **It does not close the edge**, and the residual case is
   * worth knowing: with one 12-seat VAN and one 5-seat SUV, a van-type transfer
   * holding the van, and a tour for 8, both checks pass (the pax filter sees
   * the van and does not know the transfer took it; condition (3) sees one
   * vehicle left over and does not know it is too small) and the tour is sold
   * against the SUV. Closing it needs a per-type, pax-filtered leftover term,
   * which would in exchange refuse tours that a mixed-size fleet could really
   * serve — a trade the owner has to choose, not a silent change here.
   */
  const vansThatFit = onlyCount(
    await tx
      .select(TOTAL)
      .from(vans)
      .where(
        and(eq(vans.isActive, true), eq(vans.status, VAN_STATUS_SELLABLE), gte(vans.capacity, pax)),
      ),
  );
  if (vansThatFit - toursToday < 1) return { ok: false, reason: 'no_van_available' };

  /*
   * Gate 2b — Architecture §2's condition (3), with this candidate's `+ 1`:
   *
   *   toursToday + 1 <= (vanSellable - vanPeak) + (suvSellable - suvPeak)
   *
   * A candidate TOUR changes neither type's transfer peak (conditions (1) and
   * (2) are untouched by adding a tour), so the peaks read here are the current
   * ones. A tour may be driven in either type, which is why the two leftovers
   * are summed rather than asked separately.
   */
  const sellable = await sellableVehiclesByType(tx);
  const peaks = await transferPeaksByType(tx, date);
  const leftoverVehicles = sellable.van - peaks.van + (sellable.suv - peaks.suv);
  if (toursToday + 1 > leftoverVehicles) return { ok: false, reason: 'no_van_available' };

  /*
   * Gate 3 — a driver, now as Architecture §2a's pool rather than a binary.
   *
   * Condition (4), `toursToday + 1 <= N`, is the SAME statement the old check
   * made (`driversOnDuty - heldAcrossTheFleet < 1`), re-scoped to count only
   * tours and expressed as a count of the sorted pool: `N` is the length of the
   * on-duty driver list, and "on duty" is the identical `is_active` +
   * `NOT EXISTS (driver_leaves …)` gate this file used before — moved into
   * `driverTransferCapsOn` so the transfer gate asks it the same way rather
   * than asking it a second way.
   *
   * Condition (5) is the new half, and the candidate tour pays for it twice: it
   * takes a driver (so one MORE of the smallest-cap drivers leaves the leftover
   * pool) and the transfer jobs already booked that day must still fit in what
   * remains. Tours take the smallest caps first because that is provably
   * optimal, not merely safe — see `leftoverTransferCapacity`.
   */
  const driverCaps = await driverTransferCapsOn(tx, date, await readDefaultDriverTransferCap(tx));
  if (toursToday + 1 > driverCaps.length) return { ok: false, reason: 'no_driver_available' };

  const transfersToday = await countTransfersOn(tx, date);
  if (transfersToday > leftoverTransferCapacity(driverCaps, toursToday + 1)) {
    return { ok: false, reason: 'no_driver_available' };
  }

  return { ok: true };
}
