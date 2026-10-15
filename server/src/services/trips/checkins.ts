/**
 * Week 6 "Drivers & verification", Task 5 — `startTrip`, `checkInStop`,
 * `completeTrip` (BUILD_SPEC §8 "Itinerary check-ins").
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
 * owner, by `withDeadlockRetry()` in the router (see the note there).
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
 * ## Both halves in one transaction
 *
 * Start writes the checkpoint, `bookings.status = 'in_progress'` and
 * `vans.status = 'on_trip'` together; completion writes the status and
 * returns the van to `available` together. Splitting either would ship a
 * window in which a started trip has an `available` van — which is a van
 * two bookings can be sold into. The caller owns the transaction (every
 * statement goes through `tx`), exactly as `assignVanAndDriver` does.
 */
import { and, eq } from 'drizzle-orm';
import type { BookingStatus, CheckInRefusal, CheckInResult } from '@rg/shared';
import type { Transaction } from '../../db/client';
import {
  VAN_STATUS_SELLABLE,
  bookings,
  tourItineraryStops,
  tripCheckpoints,
  vans,
} from '../../db/schema';
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

function refuse(reason: CheckInRefusal): CheckInResult {
  return { ok: false, reason };
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

/** The checkpoint write, and the ONLY place `trip_checkpoints` is inserted. */
async function insertCheckpoint(
  tx: Transaction,
  bookingId: number,
  stopId: number | null,
  now: Date,
): Promise<boolean> {
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
    return true;
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
    if (isDuplicateKeyError(error)) return false;
    throw error;
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

  if (!(await insertCheckpoint(tx, bookingId, null, now))) {
    return refuse('already_checked_in');
  }

  await tx.update(bookings).set({ status: 'in_progress' }).where(eq(bookings.id, bookingId));
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

  if (!(await insertCheckpoint(tx, bookingId, stopId, now))) {
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
