/**
 * Week 6 "Drivers & verification", Tasks 5 and 6 — `startTrip`,
 * `checkInStop`, `completeTrip`, `undoLastCheckIn` (BUILD_SPEC §8 "Itinerary
 * check-ins" and "Undo last check-in").
 *
 * **The first code in this project's history to write `trip_checkpoints`,
 * and the first to write `vans.status = 'on_trip'`.** Read it with that
 * weight: a van left `on_trip` stops being sellable on EVERY future date
 * (`VAN_STATUS_SELLABLE` allow-lists `available` alone), so the clearing
 * half of this file is not a tidy-up — it is the difference between a fleet
 * that can be booked next week and one that cannot.
 *
 * ## The unique index is the double-tap guard, not a `SELECT`
 *
 * A driver on a bumpy road taps "Arrived" twice. Two requests race. A
 * `SELECT`-then-`INSERT` lets both through — both read "no row", both
 * insert, and the tracker shows the van arriving twice (or, once Task 6 adds
 * undo, an undo that retracts only one of two rows). So the INSERT is
 * issued unconditionally and the **database** arbitrates: `UNIQUE
 * (booking_id, stop_key)` refuses the loser and `isDuplicateKeyError()`
 * turns that into `already_checked_in`.
 *
 * That is why nothing here locks the booking row **before** the INSERT. A
 * `SELECT … FOR UPDATE` first would serialise the two taps, and a
 * pre-checking implementation would then be CORRECT — which means the
 * concurrency test could no longer tell the two implementations apart, and
 * a test that cannot fail is a bug (CLAUDE.md). The index is the thing that
 * arbitrates, so the index must be the first thing the two requests meet.
 *
 * `isDuplicateKeyError()` and never `error.code`: Drizzle wraps mysql2 and
 * moves the driver's code onto `.cause`, which has already broken a retry
 * path in this codebase once.
 *
 * ## `stop_id` only — never `stop_key`
 *
 * `trip_checkpoints.stop_key` is `GENERATED ALWAYS AS (coalesce(stop_id, 0))
 * STORED`. Write `stop_id` — `null` for trip start — and the key follows.
 * The generated column exists because `UNIQUE (booking_id, stop_id)` would
 * not constrain the trip-start rows at all: MySQL permits unlimited NULLs in
 * a unique index, so "Start trip" could be tapped twice.
 *
 * **An INSERT that names `stop_key` is rejected by the engine**
 * (`ER_NON_DEFAULT_VALUE_FOR_GENERATED_COLUMN`, measured against
 * `rg_travel_test` with a raw statement). Through Drizzle the mistake is
 * caught earlier still: a generated column is not in the insert type, so
 * `stopKey:` in the `.values()` below is `error TS2769` and the builder
 * would drop it anyway. Two guards, neither of which a runtime test can
 * express — `schema-trips.test.ts` pins the column's shape instead.
 *
 * ## Why no slot lock, and what IS locked
 *
 * CLAUDE.md's lock order — `fleet_date_slots(date)` → `tour_date_slots
 * (tour_id, date)` → the booking row — is absolute for anything that
 * touches a day's CAPACITY. These three mutations take **none of it**, and
 * that is a decision rather than an omission:
 *
 *  - Nothing here creates, cancels or re-dates a booking, moves `pax`, or
 *    changes which van is assigned to which date. The per-date question
 *    those locks serialise ("is there still room on 2026-11-03") has the
 *    same answer before and after a check-in.
 *  - The van status write is **not date-scoped**, so no `fleet_date_slots`
 *    row protects it; `on_trip` is read by availability on every future
 *    date at once. A lock on the trip's own date would be theatre — it
 *    would look like protection while covering none of the dates the write
 *    actually affects. The property that matters for the fleet is
 *    COMPLETENESS (whatever sets `on_trip` clears it), and that is bought
 *    by doing both halves in one transaction, not by a lock.
 *  - Taking the fleet-date lock anyway would serialise a driver's roadside
 *    tap behind every checkout hold for that date, on the one morning of
 *    the year when both are busiest, for no correctness gain.
 *
 * Since no slot lock is taken, no lock ORDER can be violated — the hazard
 * the rule exists for (two paths taking the same pair in opposite orders)
 * cannot arise here.
 *
 * MEASURED, and worth knowing before reordering anything here: inserting
 * the checkpoint and only then UPDATING the booking row has a real deadlock
 * in it — the child INSERT takes a shared FK lock on the parent booking
 * row, so the winner's `UPDATE` is an S→X upgrade while the loser still
 * holds S and waits on the duplicate key. The window is one round trip
 * wide, which is why it does not show up against a loopback socket and
 * widens with latency and pool contention.
 *
 * It is handled where a deadlock has to be handled — at the transaction
 * owner, by `withDeadlockRetry()` inside `runCheckIn()` at the foot of this
 * file (see the note there).
 * **Do not "fix" it by taking the booking lock first:** that serialises the
 * two taps and makes a check-then-insert correct, at which point nothing
 * can tell the two implementations apart. If it ever escapes the retry, the
 * concurrency tests fail loudly on it — they assert that NEITHER call threw
 * — rather than passing quietly.
 *
 * What is locked: `completeTrip` reads the booking `FOR UPDATE`, because it
 * is a read-then-write of `bookings.status` with no index behind it — two
 * finance-grade taps on "Complete trip" must not both pass the
 * `in_progress` gate. `startTrip` and `checkInStop` need no such lock: the
 * UNIQUE index already admits exactly one of any set of racing taps, and
 * only the winner writes.
 *
 * ## The one read here that is a DECISION is locking
 *
 * `countStandingCheckpoints()` — "is this the last stop?" — takes
 * `.for('update')`, and `finishTrip`'s status write is conditional in SQL.
 * Round 1 shipped that decision as a plain read and it was wrong in exactly
 * the way CLAUDE.md warns about: `checkInStop`'s first statement is a
 * non-locking read, so it pins the REPEATABLE READ snapshot and every later
 * plain read — `tripProgress` included — cannot see a sibling check-in that
 * committed in between. Two taps on the final two stops therefore each
 * counted `total - 1` and NEITHER completed the trip, stranding the van on
 * `on_trip` forever. See `countStandingCheckpoints` and `finishTrip` for
 * the mechanics; the rule is that a read whose answer decides a write must
 * be locking, and only `progress.total` (the tour's itinerary, which is not
 * the racing table) is read from the snapshot.
 *
 * ## Task 6: one row per stop, and the audit trail as its history
 *
 * `undone` MARKS, never deletes (CLAUDE.md), and a stop checked in again
 * after an undo gets **the same row back** rather than a second one (owner
 * decision 2026-10-15, Q5) — so the UNIQUE index survives and the double tap
 * stays arbitrated by the database. The reactivation therefore lives inside
 * `insertCheckpoint`'s duplicate-key catch, AFTER the collision, and not in
 * a read before the INSERT; see the long note there, which is the one place
 * in this file where getting the ORDER of two statements wrong would quietly
 * un-prove two concurrency tests.
 *
 * The cost of one row per stop is that the row cannot show that a stop was
 * claimed, retracted and re-claimed. `audit_log` is where that history
 * lives, and it is the justification for one row at all: every check-in,
 * undo and re-check-in writes a row with `actor_type = 'driver'`, `entity`
 * the plural `'bookings'` and a dotted action — `trip.started`,
 * `trip.checked_in`, `trip.completed`, `trip.checkin_undone`,
 * `trip.completion_undone`. **Task 12 reads those strings, so they are a
 * contract**, not labels.
 *
 * ## Both halves in one transaction
 *
 * Start writes the checkpoint, `bookings.status = 'in_progress'` and
 * `vans.status = 'on_trip'` together; completion writes the status and
 * returns the van to `available` together. Splitting either would ship a
 * window in which a started trip has an `available` van — which is a van
 * two bookings can be sold into. The three mutations take a `tx` and every
 * statement goes through it, exactly as `assignVanAndDriver` does;
 * `runCheckIn()` at the foot of this file is the one place that opens it,
 * retries it on a deadlock, and converts a post-write refusal back into a
 * verdict after the rollback.
 */
import { and, desc, eq, inArray } from 'drizzle-orm';
import type { BookingStatus, CheckInRefusal, CheckInResult, CheckInUndoResult } from '@rg/shared';
import { getDb, type Transaction } from '../../db/client';
import {
  VAN_STATUS_SELLABLE,
  bookings,
  tourItineraryStops,
  tripCheckpoints,
  vans,
} from '../../db/schema';
import { withDeadlockRetry } from '../../db/deadlock';
import { isDuplicateKeyError } from '../../db/duplicate-key';
import { writeAudit } from '../audit';
import { tripProgress } from './progress';

/**
 * Statuses a trip can be STARTED from.
 *
 * `pending_verification` is in the list on purpose (owner-accepted
 * 2026-10-15, Q2): the guests are standing at the pickup, the van is there,
 * and the payment box already tells the driver not to collect. Refusing the
 * start would strand a family over a receipt an admin has not looked at yet.
 * Note what starting does NOT do — it does not touch a single money column,
 * so a `pending_verification` trip that runs is still unverified afterwards.
 *
 * `in_progress` is in the list too, and for a different reason: it is how a
 * second tap on "Start trip" reaches the INSERT and is refused by the UNIQUE
 * index as `already_checked_in` — the true answer — instead of being turned
 * away earlier as `trip_not_startable`, which reads as "something is wrong
 * with this trip" to a driver for whom nothing is.
 *
 * `confirmed` is deliberately absent: a confirmed booking has no van and no
 * driver until dispatch assigns them, so there is nobody for whom it is
 * their trip. `pending_payment`, `completed`, `cancelled` and `expired` are
 * absent for the obvious reasons. An allow-list, not a deny-list, so a
 * status added later is unstartable until somebody decides otherwise.
 */
const STARTABLE_STATUSES: readonly BookingStatus[] = [
  'assigned',
  'pending_verification',
  'in_progress',
];

/**
 * The refusal arm, which `CheckInResult` and `CheckInUndoResult` share
 * verbatim — so one `refuse()` serves all four mutations and `runCheckIn`
 * can convert a rolled-back refusal without knowing which it is wrapping.
 */
type CheckInRefused = { ok: false; reason: CheckInRefusal };

function refuse(reason: CheckInRefusal): CheckInRefused {
  return { ok: false, reason };
}

/**
 * A refusal discovered AFTER this transaction already wrote something, which
 * therefore has to take the transaction down with it.
 *
 * Thrown, not returned, and that is the only reason it exists: returning a
 * verdict lets the caller's transaction COMMIT, which would leave the
 * checkpoint row behind on a trip that was refused. Throwing rolls back the
 * INSERT with everything else, so there is nothing to compensate for and no
 * orphan row for anyone to sweep. `runCheckIn()` converts it back into an
 * ordinary verdict once the rollback has happened — the caller sees the same
 * refusal it would have seen if the race had resolved the other way, so the
 * contract is unchanged.
 *
 * Private on purpose: a refusal that needs a rollback is an implementation
 * detail of this module, and `CheckInRefusal` gains no member for it.
 */
class CheckInRollback extends Error {
  constructor(readonly reason: CheckInRefusal) {
    super(`check-in refused after a write: ${reason}`);
    this.name = 'CheckInRollback';
  }
}

/** The booking fields every one of the three mutations needs. */
interface TripRow {
  id: number;
  tourId: number;
  status: BookingStatus;
  vanId: number | null;
}

/**
 * The driver's own trip, or `undefined`.
 *
 * `driver_id` is half of the WHERE and not a check afterwards — the same
 * shape `driverTripDetail` uses, and for the same reason: a booking that
 * belongs to another driver and a booking id that does not exist return the
 * same zero rows, so the refusal cannot be used to discover which bookings
 * exist. Over a numeric id that would be a walk towards a payload carrying
 * a guest's phone number (RA 10173).
 *
 * `forUpdate` is opt-in, not the default. See the module note: locking the
 * booking row before the checkpoint INSERT would make the index stop being
 * the thing that arbitrates a double tap.
 */
async function readTrip(
  tx: Transaction,
  bookingId: number,
  driverId: number,
  forUpdate = false,
): Promise<TripRow | undefined> {
  const query = tx
    .select({
      id: bookings.id,
      tourId: bookings.tourId,
      status: bookings.status,
      vanId: bookings.vanId,
    })
    .from(bookings)
    .where(and(eq(bookings.id, bookingId), eq(bookings.driverId, driverId)))
    .limit(1);

  const [row] = forUpdate ? await query.for('update') : await query;
  return row;
}

/**
 * Moves a van between the two statuses THIS file owns, and no others.
 *
 * `WHERE status = <from>` is the whole safety property. A dispatcher who
 * marked a van `for_repair` mid-trip has made a decision, and a completion
 * that slammed the status to `available` would silently undo it — putting a
 * broken van back on sale. So the transition is conditional in SQL rather
 * than in a read-then-write: `available → on_trip` on start, `on_trip →
 * available` on completion, and a van in any other status is left exactly
 * where the human who put it there left it.
 *
 * Symmetric by construction, which is what keeps the §9 requirement
 * ("whatever sets `on_trip` must also clear it") true: the only way in is
 * from `available` and the only way out is back to it.
 *
 * There is a second door OUT, added by Week 6 Task 13 and in the same
 * direction: `releaseVanFromTrip()` below, which a mid-trip cancellation
 * uses. It is a wrapper on this function rather than a second UPDATE
 * somewhere else, because `on_trip → available` is a dispatch rule and a
 * second copy of it is how a van ends up on sale while it is out.
 */
async function moveVanStatus(
  tx: Transaction,
  vanId: number | null,
  from: 'available' | 'on_trip',
  to: 'available' | 'on_trip',
): Promise<void> {
  /*
   * A trip with a driver but no van cannot be produced by
   * `assignVanAndDriver` (it writes both or neither), so this guard is for
   * a hand-made row rather than a real flow — and it skips the fleet write
   * instead of refusing, because a driver standing at a pickup must not be
   * blocked by a column nobody filled in.
   */
  if (vanId === null) return;
  await tx
    .update(vans)
    .set({ status: to })
    .where(and(eq(vans.id, vanId), eq(vans.status, from)));
}

/**
 * Puts a van back on sale because the trip it was out on has been CANCELLED
 * (Week 6 Task 13, §6's cancel/refund).
 *
 * `startTrip` sets `on_trip` and completion clears it, and CLAUDE.md's rule
 * is that whatever sets that status must also clear it. An admin cancelling
 * a trip mid-journey removes the completion that would have cleared it, so
 * the cancel has to — and it does it through here, conditional on the van
 * still being `on_trip`, so a dispatcher who parked it in `for_repair`
 * meanwhile keeps their decision.
 *
 * Exported rather than copied into the cancel service: this is the only
 * module that writes `vans.status` for a trip, and it stays that way.
 * Cancelling a booking that never started (no van, or a van still
 * `available`) matches nothing and writes nothing.
 */
export async function releaseVanFromTrip(tx: Transaction, vanId: number | null): Promise<void> {
  await moveVanStatus(tx, vanId, 'on_trip', 'available');
}

/**
 * What the one checkpoint write did.
 *
 *  - `inserted` — the first tap on that stop. The INSERT won.
 *  - `reactivated` — the stop had been checked in and UNDONE, and this tap
 *    brought the same row back to life (owner decision 2026-10-15, Q5).
 *  - `already_live` — a row for that stop already stands. The double tap.
 *
 * Three values rather than a boolean because the first two are both
 * successes that must be audited identically (the driver did check in) while
 * the third is `already_checked_in`, and a boolean cannot carry that.
 */
type CheckpointWrite = 'inserted' | 'reactivated' | 'already_live';

/**
 * `trip_checkpoints.stop_key` is `GENERATED ALWAYS AS (coalesce(stop_id, 0))
 * STORED`, so `0` is the trip-start event's key — safe as a sentinel because
 * `tour_itinerary_stops.id` is an AUTO_INCREMENT primary key and never
 * issues 0. Read in a `WHERE`, never written (see the module note).
 */
const TRIP_START_KEY = 0;

/** The checkpoint write, and the ONLY place `trip_checkpoints` is inserted. */
async function insertCheckpoint(
  tx: Transaction,
  bookingId: number,
  stopId: number | null,
  now: Date,
): Promise<CheckpointWrite> {
  try {
    await tx.insert(tripCheckpoints).values({
      bookingId,
      /*
       * `stop_id` ALONE. `stop_key` is `GENERATED ALWAYS` and naming it
       * makes MySQL reject the statement — see the module note. `null` here
       * is the trip-start event, which the generated key maps to 0 so the
       * UNIQUE index constrains it like any other stop.
       */
      stopId,
      /*
       * SERVER time, passed in from the request boundary. There is no field
       * on any input through which a device clock — or a driver who would
       * rather the record said 06:00 — can reach this column.
       */
      checkedAt: now,
    });
    return 'inserted';
  } catch (error) {
    /*
     * The double tap, arbitrated by the index rather than by a `SELECT`
     * this code ran a moment earlier. `isDuplicateKeyError` walks `.cause`
     * because Drizzle wraps mysql2's `ER_DUP_ENTRY` — never `error.code`.
     *
     * Anything that is NOT a duplicate key is re-thrown: a lost connection
     * or a constraint this code does not know about must not be reported to
     * a driver as "already checked in".
     */
    if (!isDuplicateKeyError(error)) throw error;

    /*
     * ## The reactivation (owner decision 2026-10-15, Q5), and why it is HERE
     *
     * A stop that was checked in, UNDONE, and then checked in again gets
     * **the same row back**: fresh `checked_at`, `undone` false, `undone_at`
     * and `undone_by` cleared. No second row, and **the UNIQUE index stays**
     * — which is the whole reason this lives in the duplicate-key catch and
     * not in a `SELECT` before the INSERT.
     *
     * Read that ordering as the implementation, because it is: the INSERT is
     * still the FIRST move, so the index is still the thing that arbitrates
     * two racing taps, and this branch is a RECOVERY AFTER the collision
     * rather than a pre-check. Lifting it in front of the INSERT — "read the
     * row, update it if undone, otherwise insert" — would serialise nothing
     * and make a check-then-insert implementation correct, at which point
     * the two concurrency tests can no longer tell the two apart and a test
     * that cannot fail is a bug (CLAUDE.md).
     *
     * **`undone = true` is in the WHERE and that is the double-tap guard.**
     * The UPDATE is conditional rather than read-then-write for the same
     * reason the status writes in this file are: an `UPDATE` re-reads the
     * row under its own X lock, so it sees the latest COMMITTED state rather
     * than this transaction's pinned snapshot — and by the time a duplicate
     * key surfaces at all, the winner has committed (InnoDB makes the loser
     * WAIT on the key and only then reports `ER_DUP_ENTRY`). So a row that
     * still stands matches nothing, zero rows come back, and the tap is
     * `already_checked_in`. Without that one clause every double tap would
     * re-stamp `checked_at` and quietly rewrite when the van arrived.
     *
     * `stop_key` in the `WHERE`, not `stop_id`: it is the UNIQUE index's own
     * second column, so this finds the exact row the INSERT collided with —
     * including the trip-start row, whose `stop_id` is NULL and would need
     * `IS NULL` rather than `=`. Reading a generated column is fine; only
     * WRITING one is refused by the engine.
     */
    const [header] = await tx
      .update(tripCheckpoints)
      .set({ checkedAt: now, undone: false, undoneAt: null, undoneBy: null })
      .where(
        and(
          eq(tripCheckpoints.bookingId, bookingId),
          eq(tripCheckpoints.stopKey, stopId ?? TRIP_START_KEY),
          eq(tripCheckpoints.undone, true),
        ),
      );
    return header.affectedRows === 0 ? 'already_live' : 'reactivated';
  }
}

/**
 * How many of this trip's check-ins STAND, read under a lock.
 *
 * **This read must be locking, and that is the whole point of the
 * function** (round-1 review, F1). `checkInStop`'s first statement is a
 * plain read, which pins the REPEATABLE READ snapshot; every later
 * non-locking read in that transaction — `tripProgress`'s two queries
 * included — answers from that snapshot plus this transaction's own writes,
 * and therefore cannot see a sibling check-in that committed in between. So
 * two taps on the FINAL TWO stops each counted `total - 1` and **neither
 * completed the trip**, leaving the booking `in_progress` and the van
 * `on_trip` — unsellable on every future date, because `available` is the
 * only sellable status. Reproduced, not theorised.
 *
 * `.for('update')` fixes it twice over: a locking read sees the latest
 * COMMITTED rows rather than the snapshot, and its next-key lock over
 * `(booking_id, …)` serialises the two taps, so exactly one of them can be
 * the transaction that sees a complete set.
 *
 * It is the exact trap CLAUDE.md spells out — "a non-locking read taken
 * first returns the pre-lock snapshot even after the lock is granted" — and
 * the fix has to be on the read that makes the DECISION. Adding
 * `FOR UPDATE` to the booking row instead does nothing, because a locking
 * read does not advance the snapshot for the plain reads that follow it.
 *
 * Rows rather than `COUNT(*)`: there is at most one per stop (the UNIQUE
 * index guarantees it), so this is a handful of ints, and a locking read
 * whose shape nobody has to reason about is worth more here than the
 * aggregate.
 */
async function countStandingCheckpoints(tx: Transaction, bookingId: number): Promise<number> {
  const rows = await tx
    .select({ id: tripCheckpoints.id })
    .from(tripCheckpoints)
    .where(and(eq(tripCheckpoints.bookingId, bookingId), eq(tripCheckpoints.undone, false)))
    .for('update');
  return rows.length;
}

/**
 * Completion: `bookings.status = 'completed'`, the van back to `available`,
 * and one `trip.completed` audit row — in the caller's transaction. Answers
 * the booking's status afterwards.
 *
 * Shared by `completeTrip` (the driver pressed Complete) and `checkInStop`
 * (the last stop was tapped, §8 item 3). `lastStopId` records which of the
 * two happened, because "the trip was closed by the Kawasan check-in" and
 * "the driver closed it by hand" are different facts in an operations
 * review.
 *
 * **The status write is conditional in SQL — `WHERE status = 'in_progress'`
 * — and the audit row and the van write hang off whether it matched**
 * (round-1 review, F1's second symptom). An `UPDATE` re-reads the row under
 * its own X lock, so unlike a plain `SELECT` it sees the latest committed
 * status: a `completeTrip` that landed first while this check-in's FK lock
 * waited behind it closes the trip, and this transaction then affects zero
 * rows and adds nothing. Without the condition, the same trip gets closed
 * twice and the §9 trail shows two `trip.completed` rows for one trip.
 *
 * The same condition is what keeps an admin's mid-trip cancellation from
 * being silently overwritten with `completed`: the trip is simply not
 * closed, and the caller is told the real status rather than the one it
 * wanted.
 */
async function finishTrip(
  tx: Transaction,
  trip: TripRow,
  driverId: number,
  lastStopId: number | null,
): Promise<BookingStatus> {
  const [header] = await tx
    .update(bookings)
    .set({ status: 'completed' })
    .where(and(eq(bookings.id, trip.id), eq(bookings.status, 'in_progress')));

  if (header.affectedRows === 0) {
    /*
     * Somebody else moved this booking out of `in_progress` between our
     * snapshot and this write. A LOCKING read, because a plain one would
     * answer from the same stale snapshot that sent us here.
     */
    const [current] = await tx
      .select({ status: bookings.status })
      .from(bookings)
      .where(eq(bookings.id, trip.id))
      .for('update')
      .limit(1);
    return current?.status ?? trip.status;
  }

  // §9's requirement, and the reason this task could not ship without Task
  // 7's test: `available` is the ONLY sellable status, so a van left
  // `on_trip` is a van no date can be booked into.
  await moveVanStatus(tx, trip.vanId, 'on_trip', VAN_STATUS_SELLABLE);
  await writeAudit(tx, {
    actorType: 'driver',
    actorId: driverId,
    action: 'trip.completed',
    // PLURAL. `admin.bookings.detail`'s trail filters on `entity =
    // 'bookings'`, so a singular row is invisible on the one screen that
    // displays it — Week 5 shipped exactly that bug.
    entity: 'bookings',
    entityId: trip.id,
    data: { vanId: trip.vanId, lastStopId },
  });
  return 'completed';
}

/**
 * §8 item 1: **Start trip** → booking `in_progress`, timestamp saved, van
 * `on_trip`.
 *
 * Order inside the caller's transaction, and it is the implementation:
 *
 *  1. Read the booking narrowed by `driver_id` — a PLAIN read, no lock (see
 *     the module note on why).
 *  2. Refuse unless the status is startable.
 *  3. INSERT the trip-start checkpoint (`stop_id` null). The UNIQUE index
 *     refuses a second tap → `already_checked_in`.
 *  4. Only the winner of step 3 writes: `bookings.status`, then the van.
 *  5. Audit, then read back the progress the screen will draw.
 */
export async function startTrip(
  tx: Transaction,
  input: { bookingId: number; driverId: number; now: Date },
): Promise<CheckInResult> {
  const { bookingId, driverId, now } = input;

  const trip = await readTrip(tx, bookingId, driverId);
  if (!trip) return refuse('not_your_trip');
  if (!STARTABLE_STATUSES.includes(trip.status)) return refuse('trip_not_startable');

  if ((await insertCheckpoint(tx, bookingId, null, now)) === 'already_live') {
    return refuse('already_checked_in');
  }

  /*
   * The status write is conditional on the SAME allow-list the gate above
   * used, and the mirror image of `finishTrip`'s (round-2 review).
   *
   * The gate above is a plain read, so it answers from this transaction's
   * pinned snapshot — and an admin cancellation landing between it and this
   * write would be silently overwritten, walking a CANCELLED booking
   * backwards into `in_progress`. A driver's tap must not resurrect a
   * cancelled trip. An `UPDATE` re-reads the row under its own X lock, so
   * unlike that `SELECT` it sees the latest committed status; naming the
   * allow-list in the `WHERE` is what turns "the booking moved under us"
   * into zero matched rows.
   *
   * It stays an allow-list, so a status added to `BOOKING_STATUSES` later is
   * refused by default rather than started by accident.
   */
  const [header] = await tx
    .update(bookings)
    .set({ status: 'in_progress' })
    .where(and(eq(bookings.id, bookingId), inArray(bookings.status, [...STARTABLE_STATUSES])));

  if (header.affectedRows === 0) {
    /*
     * The booking moved out of the startable set between this
     * transaction's snapshot and the write above, so refuse. A LOCKING
     * read, because a plain one would answer from the same stale snapshot
     * that sent us here.
     *
     * **The `in_progress` arm below is UNREACHABLE while mysql2's default
     * `CLIENT_FOUND_ROWS` flag is on, and the comment that used to claim
     * otherwise was wrong twice over** (Task 6 review, F1 — measured three
     * ways). With that flag set, `affectedRows` is the **matched** count and
     * not the changed count: an `UPDATE` to the value a row already holds
     * reports `affectedRows 1, changedRows 0`. So reaching this block means
     * the `WHERE` matched NOTHING — the row is gone, or its status is
     * outside the allow-list — and both of those are the refusing arm. An
     * already-`in_progress` booking never gets here; it is matched, written
     * as a no-op, and sails past.
     *
     * Task 5's re-review asserted the opposite ("mysql2 does not set
     * `CLIENT_FOUND_ROWS`") and Task 6's first pass believed it; see the
     * note beside `getPool()` in `db/client.ts` for the probe. That item is
     * still OPEN, not closed.
     *
     * The arm stays, deliberately, and is not dead weight: the locking
     * re-read and the membership test are correct in both directions and
     * are exactly what this code needs if the flag is ever turned off. It
     * fails safe — the only way through is a status still in the allow-list.
     * **Do not cite a test as covering it**, and do not use a conditional
     * `UPDATE` anywhere in this project to detect "the value was already
     * what I was setting": `affectedRows` cannot answer that question.
     */
    const [current] = await tx
      .select({ status: bookings.status })
      .from(bookings)
      .where(eq(bookings.id, bookingId))
      .for('update')
      .limit(1);
    if (!current || !STARTABLE_STATUSES.includes(current.status)) {
      // Thrown, so the checkpoint INSERT above goes back with it.
      throw new CheckInRollback('trip_not_startable');
    }
  }

  await moveVanStatus(tx, trip.vanId, VAN_STATUS_SELLABLE, 'on_trip');
  await writeAudit(tx, {
    actorType: 'driver',
    actorId: driverId,
    action: 'trip.started',
    entity: 'bookings',
    entityId: bookingId,
    data: { vanId: trip.vanId, previousStatus: trip.status },
  });

  return { ok: true, progress: await tripProgress(tx, bookingId) };
}

/**
 * §8 item 2: tap a stop on arrival → one `trip_checkpoints` row with a
 * server timestamp. And §8 item 3: the last stop completes the trip.
 *
 * "Last stop" is read as **every itinerary stop checked in**, not "the stop
 * with the highest `sort_order`": a driver who taps Kawasan before Simala
 * (because the convoy reversed the route) has still finished the trip when
 * the second tap lands, and a trip that ended with one stop silently
 * un-tapped would leave its van `on_trip` forever. `tripProgress` already
 * answers exactly that question — `done === total`, trip start included —
 * so the completion rule is read off the same function the driver's screen
 * and the dispatcher's progress bar use, rather than re-derived here.
 *
 * `unknown_stop` is checked before the started gate: a stop that is not on
 * this tour is an incoherent request whatever state the trip is in, and
 * telling the driver to "start the trip first" for a stop their trip does
 * not have would send them looking for the wrong problem.
 */
export async function checkInStop(
  tx: Transaction,
  input: { bookingId: number; driverId: number; stopId: number; now: Date },
): Promise<CheckInResult> {
  const { bookingId, driverId, stopId, now } = input;

  const trip = await readTrip(tx, bookingId, driverId);
  if (!trip) return refuse('not_your_trip');

  /*
   * The stop must belong to THIS trip's tour. `tour_id` is half of the
   * WHERE for the same reason `driver_id` is on the booking: a stop id from
   * another tour must be indistinguishable from one that does not exist.
   */
  const [stop] = await tx
    .select({ id: tourItineraryStops.id })
    .from(tourItineraryStops)
    .where(and(eq(tourItineraryStops.id, stopId), eq(tourItineraryStops.tourId, trip.tourId)))
    .limit(1);
  if (!stop) return refuse('unknown_stop');

  /*
   * `in_progress` and nothing else. It covers both halves of the refusal:
   * a trip not yet started (tap Start first) and one already completed (a
   * finished trip takes no more check-ins). `startTrip` sets this status in
   * the same transaction as the trip-start checkpoint, so the two can never
   * disagree about whether the trip is running.
   */
  if (trip.status !== 'in_progress') return refuse('trip_not_started');

  /*
   * `inserted` and `reactivated` are both the driver checking in and are
   * audited identically — one `trip.checked_in` row per tap, which is what
   * makes the audit trail the only place the claimed → retracted →
   * re-claimed history of a one-row-per-stop table exists.
   */
  if ((await insertCheckpoint(tx, bookingId, stopId, now)) === 'already_live') {
    return refuse('already_checked_in');
  }

  await writeAudit(tx, {
    actorType: 'driver',
    actorId: driverId,
    action: 'trip.checked_in',
    entity: 'bookings',
    entityId: bookingId,
    data: { stopId },
  });

  const progress = await tripProgress(tx, bookingId);
  /*
   * The completion decision is made from a LOCKING count, never from
   * `progress.done` (round-1 review, F1). `progress` was read non-locking,
   * so its `done` is the pinned snapshot's answer and misses a sibling tap
   * that committed after this transaction's first read — which is how two
   * taps on the final two stops both decided the trip was unfinished.
   * `progress.total` is safe to use: it comes from the tour's itinerary,
   * not from the racing table.
   */
  const standing = await countStandingCheckpoints(tx, bookingId);
  if (standing < progress.total) return { ok: true, progress: { ...progress, done: standing } };

  // §8 item 3 — the last stop frees the van.
  const status = await finishTrip(tx, trip, driverId, stopId);
  /*
   * `done` and `status` come from the authoritative sources (the locking
   * count, and the write we just made or the locking re-read behind it).
   * `progress.stops` can still lag by one sibling tap's `checkedAt` in a
   * genuine race, because it was read from the snapshot — the next read of
   * the trip corrects it, and no decision is made from it.
   */
  return { ok: true, progress: { ...progress, done: standing, status } };
}

/**
 * §8 item 3, by hand: **Complete trip** → booking `completed`, van freed.
 *
 * The one mutation here that locks the booking row, because it is the one
 * whose guard is a status read rather than a UNIQUE index — completion
 * inserts no checkpoint (there is no stop for "the trip ended" — `stop_key`
 * 0 is already trip start), so without `FOR UPDATE` two taps could both
 * read `in_progress` and both write a completion with its audit row.
 *
 * An already-completed trip answers `already_checked_in`, not
 * `trip_not_started`: the driver's tap landed on an event that is already
 * recorded, which is a shrug and not an error. Anything else — not started,
 * cancelled, expired — is `trip_not_started`.
 *
 * **No `now`.** The plan's signature named one; this writes no timestamp of
 * its own (`bookings.updated_at` is the column's `$onUpdateFn`, and no
 * checkpoint row is created), and an unused `now` parameter would be a lie
 * about what the answer depends on — the ruling `tripProgress` and
 * `driverTripDetail` already carry. Nothing here is bucketed or compared
 * against a clock.
 */
export async function completeTrip(
  tx: Transaction,
  input: { bookingId: number; driverId: number },
): Promise<CheckInResult> {
  const { bookingId, driverId } = input;

  const trip = await readTrip(tx, bookingId, driverId, true);
  if (!trip) return refuse('not_your_trip');
  if (trip.status === 'completed') return refuse('already_checked_in');
  if (trip.status !== 'in_progress') return refuse('trip_not_started');

  const status = await finishTrip(tx, trip, driverId, null);
  /*
   * `readTrip`'s `FOR UPDATE` is a LOCKING read, which does not pin the
   * REPEATABLE READ snapshot — so `tripProgress` below is this
   * transaction's first consistent read and sees everything committed up to
   * now, this write included. No snapshot correction is needed here, unlike
   * in `checkInStop`.
   */
  return { ok: true, progress: { ...(await tripProgress(tx, bookingId)), status } };
}

/**
 * §8 item 4: **Undo last check-in** — "only the most recent; marked
 * `undone`, not deleted" — with the owner's two decisions of 2026-10-15.
 *
 * ## It reverses ONE event, and a completion is an event
 *
 * The branch at the top is the whole shape of this function. If the booking
 * is `completed` the most recent thing that happened to this trip is the
 * COMPLETION, so that is what an undo reverses: booking back to
 * `in_progress`, van back to `on_trip`, `trip.completion_undone`, and **no
 * checkpoint row is touched**. Only if the trip is still running does the
 * undo retract a check-in.
 *
 * **Q4, and why the van half is not optional.** `VAN_STATUS_SELLABLE`
 * allow-lists `available` alone, so a completion that is undone while
 * leaving the van `available` offers dispatch a van with guests still in it
 * — on every future date at once, because the status is not date-scoped. A
 * mistaken Complete tap must put the van back on the road.
 *
 * **Why the completion undo leaves the checkpoints alone**, which is the one
 * reading of "restores the previous state exactly" that works for both ways
 * a trip can close:
 *
 *  - `completeTrip` writes NO checkpoint (there is no stop for "the trip
 *    ended" — `stop_key` 0 is already trip start). The state before it was
 *    `in_progress` with every recorded tap standing, which is exactly what
 *    this restores. An undo that also retracted "the newest check-in" here
 *    would retract the trip-start row — plainly wrong, and the state nobody
 *    was ever in.
 *  - A last-stop check-in closes the trip in ONE transaction, so strictly
 *    the state before it had that stop un-tapped too. Reversing both halves
 *    at once would mean deciding WHICH route closed the trip, and the only
 *    record of that is the `trip.completed` audit row's `lastStopId` —
 *    reading the audit log to decide a write is a dependency this module
 *    will not take. So the driver taps Undo twice: once to reopen the trip,
 *    once to un-tick the stop. Two events, two undos, two audit rows, and
 *    the second tap is a `trip.checkin_undone` like any other.
 *
 * ## The locks, and why they are the opposite call from `checkInStop`'s
 *
 * This takes the booking row `FOR UPDATE` and then reads the newest
 * standing checkpoint `FOR UPDATE` too — both locking, deliberately, which
 * is the reverse of the ruling in `checkInStop`. The index-arbitration proof
 * there exists because a double TAP must be told apart by the database; an
 * undo has no index to arbitrate it (it writes an existing row), so its
 * guard is a read whose answer decides a write, and CLAUDE.md's rule
 * applies without qualification: take the lock BEFORE reading availability,
 * and make the deciding read locking or it answers from the pre-lock
 * snapshot. Two concurrent Undo taps therefore serialise, and the second
 * finds the row it would otherwise have retracted a second time already
 * retracted — so it moves on to the next-newest, or answers
 * `nothing_to_undo`.
 *
 * A locking read does NOT pin the REPEATABLE READ snapshot, so there is no
 * stale-snapshot correction to make here (the same note `completeTrip`
 * carries).
 *
 * ## "Most recent" is `checked_at`, and `undone = false`
 *
 * By `checked_at` DESC then `id` DESC, among rows that STAND. Two rows can
 * share a second — MySQL's `datetime` here has no sub-second precision —
 * and `id` breaks that tie in insertion order, so "the most recent" is a
 * total order rather than whatever the engine returns. Undoing an arbitrary
 * stop would let a driver rewrite a trip's history after the fact; undoing
 * a row that is already undone would let one tap retract two stops.
 *
 * Note that `checked_at` is the REACTIVATED time for a stop that was undone
 * and tapped again (Q5), which is correct: the most recent claim about that
 * stop is the one an undo should reverse.
 *
 * ## Marked, never deleted
 *
 * `undone = true`, `undone_at = now`, `undone_by = driverId` — a DRIVER, not
 * an admin (the column's own ruling). CLAUDE.md forbids hard deletes, and
 * "arrived 10:15, retracted 10:16" versus "retracted three days later, after
 * the complaint" are very different facts in a refund argument.
 *
 * `reason` is required by the input schema and goes into the audit row's
 * `data`. It is the only part of an undo a column cannot infer.
 */
export async function undoLastCheckIn(
  tx: Transaction,
  input: { bookingId: number; driverId: number; reason: string; now: Date },
): Promise<CheckInUndoResult> {
  const { bookingId, driverId, reason, now } = input;

  const trip = await readTrip(tx, bookingId, driverId, true);
  if (!trip) return refuse('not_your_trip');

  if (trip.status === 'completed') {
    /*
     * Conditional in SQL like every other status write in this file, even
     * though the `FOR UPDATE` above already holds this row — so the claim
     * "the booking was `completed` when we wrote" is enforced by the
     * database rather than by remembering that the lock is there. The
     * zero-row arm is therefore **unreachable by construction** while that
     * lock stands; it is here so the undo fails closed if it ever does not,
     * rather than auditing a reversal that did not happen.
     */
    const [header] = await tx
      .update(bookings)
      .set({ status: 'in_progress' })
      .where(and(eq(bookings.id, bookingId), eq(bookings.status, 'completed')));
    if (header.affectedRows === 0) return refuse('nothing_to_undo');

    // Q4. Conditional on `available`, so a van a dispatcher marked
    // `for_repair` while the trip was closed is left where they put it —
    // the mirror of `finishTrip`'s clearing half.
    await moveVanStatus(tx, trip.vanId, VAN_STATUS_SELLABLE, 'on_trip');
    await writeAudit(tx, {
      actorType: 'driver',
      actorId: driverId,
      action: 'trip.completion_undone',
      // PLURAL, like every other row this file writes: the §9 trail on
      // `admin.bookings.detail` filters on `entity = 'bookings'`.
      entity: 'bookings',
      entityId: bookingId,
      data: { vanId: trip.vanId, reason },
    });
    return { ok: true, stopId: null };
  }

  const [latest] = await tx
    .select({ id: tripCheckpoints.id, stopId: tripCheckpoints.stopId })
    .from(tripCheckpoints)
    .where(and(eq(tripCheckpoints.bookingId, bookingId), eq(tripCheckpoints.undone, false)))
    .orderBy(desc(tripCheckpoints.checkedAt), desc(tripCheckpoints.id))
    .limit(1)
    .for('update');

  if (!latest) return refuse('nothing_to_undo');

  /*
   * `undone = false` stays in the WHERE for the same reason the status write
   * above keeps its condition: the row is held `FOR UPDATE`, so the
   * zero-row arm is unreachable by construction, and the condition is what
   * makes that true rather than assumed. A double-retraction must never be
   * audited as one.
   */
  const [header] = await tx
    .update(tripCheckpoints)
    .set({ undone: true, undoneAt: now, undoneBy: driverId })
    .where(and(eq(tripCheckpoints.id, latest.id), eq(tripCheckpoints.undone, false)));
  if (header.affectedRows === 0) return refuse('nothing_to_undo');

  await writeAudit(tx, {
    actorType: 'driver',
    actorId: driverId,
    action: 'trip.checkin_undone',
    entity: 'bookings',
    entityId: bookingId,
    // `stopId` is null for the trip-start row, which is a legitimate thing
    // to retract: a driver who tapped Start at the wrong pickup.
    data: { stopId: latest.stopId, reason },
  });

  return { ok: true, stopId: latest.stopId };
}

/* ------------------------------------------------------------------ *
 * The transaction each of the four mutations runs in
 * ------------------------------------------------------------------ */

/**
 * Runs ONE check-in as one transaction, retried if InnoDB kills it, and
 * turns a post-write refusal back into an ordinary verdict.
 *
 * Here rather than in the router because all four mutations need exactly
 * this shape and two of its three jobs are properties of this module's
 * locking, not of tRPC:
 *
 * Generic over the verdict so Task 6's undo — whose success arm is a
 * `stopId` rather than a `TripProgress` — runs through the SAME transaction,
 * retry and rollback machinery rather than a second copy of it. The refusal
 * arm is `CheckInRefused`, which both result types include verbatim, so the
 * conversion below is sound for either without this function knowing which
 * it is wrapping.
 *
 * **1. One transaction.** Every statement of a check-in goes through one
 * `tx` — the checkpoint, the booking status and the van together — because
 * splitting them ships a window in which a started trip has an `available`
 * van.
 *
 * **2. `withDeadlockRetry()`**, the same wrapper `createHold` and
 * `assignVanAndDriver` use, and for the reason `deadlock.ts` documents: a
 * deadlocked transaction is already rolled back, so only its owner can
 * start another. It is needed here and the reason is measured: a checkpoint
 * INSERT takes a SHARED foreign-key lock on its parent booking row, so the
 * winner's `UPDATE bookings` is an S→X upgrade while the loser still holds
 * S and waits on the duplicate key — a textbook cycle, one round trip wide.
 * Without the retry the harmless second tap comes back as a 500 instead of
 * `already_checked_in`; with it, the retried attempt hits the duplicate key
 * cleanly and answers properly.
 *
 * It does NOT weaken the index-arbitrated proof: `isDeadlockError()` is
 * deliberately narrow (1213 / `ER_LOCK_DEADLOCK` only — even a lock-wait
 * timeout is excluded), while a check-then-insert implementation fails with
 * an uncaught `ER_DUP_ENTRY`, which the predicate rejects and the wrapper
 * re-throws on the first attempt. MEASURED, twice: the two concurrent tests
 * still redden under that mutation with this wrapper in place.
 *
 * **3. `CheckInRollback` → a verdict.** A refusal discovered after a write
 * has to roll the transaction back (see that class). By the time this
 * `catch` runs the rollback has happened, so the caller gets the same
 * `{ ok: false, reason }` it would have got had the race resolved the other
 * way, and nothing is left on the trip.
 */
export async function runCheckIn<T extends CheckInResult | CheckInUndoResult>(
  attempt: (tx: Transaction) => Promise<T>,
): Promise<T | CheckInRefused> {
  try {
    return await withDeadlockRetry(async () => await getDb().transaction(attempt));
  } catch (error) {
    if (error instanceof CheckInRollback) return refuse(error.reason);
    /*
     * A `CheckInRollback` Drizzle (or any future wrapper) re-threw with the
     * original on `.cause` — the same hazard `isDuplicateKeyError` exists
     * for. Checked rather than assumed: swallowing this would turn a
     * refusal into a 500, and missing it would be invisible until a race.
     */
    const cause = (error as { cause?: unknown } | null)?.cause;
    if (cause instanceof CheckInRollback) return refuse(cause.reason);
    throw error;
  }
}
