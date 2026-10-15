/**
 * Shared driver-portal contracts (Week 6 plan, Task 1 — BUILD_SPEC §8).
 *
 * **In `shared/` and not in `server/`, and that is the whole point of the
 * file** (pre-flight ruling, 2026-10-15). Task 9's login screen builds a
 * compiler-exhaustive `Record<DriverLoginRefusal, string>` copy map, exactly
 * as Week 5's `AssignRefusal` / `REFUSAL_COPY` pair does — so the day a
 * sixth refusal is added, the build fails on the screen that has no words
 * for it rather than falling through to generic copy. The client cannot
 * import from `server/`, so the union has to live here for that to work.
 *
 * `shared/src/dispatch.ts` is the pattern this follows.
 */
import { z } from 'zod';
import type { BookingStatus } from './booking';

/**
 * What the driver types on the portal: their short code and a six-digit PIN.
 *
 * `.strict()` for the same reason the staff and checkout schemas use it — a
 * request carrying a `driverId`, an `isActive` or a `now` is refused at the
 * input stage rather than silently ignored. A login that quietly drops an
 * unexpected field is a login that looks like it might honour one.
 *
 * `.toUpperCase()` on the code because `drivers.code` is stored uppercase
 * (`D07`) and a driver typing `d07` on a phone keyboard — where the first
 * letter is often auto-lowercased — must not be told their code is wrong.
 * The PIN is matched as a STRING, never a number: `z.number()` would accept
 * `1234` for `001234` and drop the leading zeros a PIN is allowed to have.
 */
export const driverLoginSchema = z
  .object({
    code: z.string().trim().min(1).max(20).toUpperCase(),
    pin: z.string().regex(/^[0-9]{6}$/, 'A PIN is six digits'),
  })
  .strict();
export type DriverLoginInput = z.infer<typeof driverLoginSchema>;

/**
 * §8: "Session lasts 12 hours."
 *
 * This is NOT the shared session TTL (owner decision 2026-10-15, Q1). The
 * authority is `SESSION_TTL_MS_BY_SUBJECT` in
 * `server/src/services/sessions.ts`; this constant exists so the client can
 * say "12 hours" in copy without importing from the server, and
 * `driver-auth.test.ts` asserts the two agree.
 */
export const DRIVER_SESSION_HOURS = 12;

/**
 * Every way a driver login can be refused, and nothing else.
 *
 * `wrong_credentials` covers an unknown code AND a wrong PIN, deliberately
 * and indivisibly — the same rule §7's booking lookup follows. Two
 * distinguishable answers would tell an attacker which half of the pair
 * they already have, which on a portal whose codes are short and printed on
 * a van is the only half that is hard to get.
 *
 * `locked` and `needs_admin_unlock` are separate because the driver's next
 * action differs: wait fifteen minutes, or ring the office. Telling someone
 * to wait when only a dispatcher can help them is how a van leaves without
 * its manifest.
 */
export type DriverLoginRefusal =
  'wrong_credentials' | 'locked' | 'needs_admin_unlock' | 'driver_inactive';

/* ------------------------------------------------------------------ *
 * The driver's trip list (Week 6 plan, Task 2 — BUILD_SPEC §8)
 * ------------------------------------------------------------------ */

/** The three tabs the driver portal's trip list is divided into. */
export type DriverTripBucket = 'today' | 'upcoming' | 'history';

/**
 * Which tab a trip belongs in. PURE, and shared, so the tabs and the server
 * cannot disagree about what "today" means.
 *
 * **Both arguments are Manila CIVIL DATES (`YYYY-MM-DD`), and `todayManila`
 * comes from `manilaCivilDate(now)` on the server — never from the device.**
 * The comparison is then a plain string compare, which is exact for
 * zero-padded ISO civil dates and has no instant, zone or DST in it at all.
 *
 * Why that matters rather than being pedantry: Manila is UTC+8 with no DST,
 * so for the whole 00:00-07:59 Manila window the UTC calendar day is still
 * YESTERDAY. A driver opening the portal at 00:30 to check the morning's
 * pickup would be shown it under "Upcoming" and their finished trip under
 * "Today" — the one moment of the day when being wrong costs a departure.
 *
 * The client may re-bucket without a round trip (the server sends `bucket`
 * already resolved), but it must re-bucket against a Manila date it was
 * GIVEN, not one it computed from the handset's clock.
 */
export function driverTripBucket(tourDate: string, todayManila: string): DriverTripBucket {
  if (tourDate === todayManila) return 'today';
  return tourDate > todayManila ? 'upcoming' : 'history';
}

/**
 * One row of `driver.trips()` — everything the list needs and nothing a
 * driver has no business holding.
 *
 * `vanPlate` is nullable because `bookings.van_id` is: a trip can be
 * confirmed before dispatch has assigned a van, and the list must still
 * render rather than hide the trip. The guest's name, phone and e-mail are
 * deliberately NOT here: the list is a list, and the manifest (Task 3) is
 * where a driver is shown contact details for one trip at a time.
 *
 * `bucket` is resolved server-side from the Manila civil date and sent
 * with the row, so the first render needs no client clock.
 */
export interface DriverTripRow {
  bookingId: number;
  ref: string;
  tourTitle: string;
  /** Manila civil date, `YYYY-MM-DD`. */
  tourDate: string;
  pax: number;
  status: BookingStatus;
  vanPlate: string | null;
  bucket: DriverTripBucket;
}

/* ------------------------------------------------------------------ *
 * Trip progress (Week 6 plan, Task 3 — BUILD_SPEC §8 "Itinerary check-ins")
 * ------------------------------------------------------------------ */

/**
 * The label the trip-start pseudo-stop carries, from §8's own wording
 * ("**Start trip** → booking `in_progress`"). Shared so the driver's button
 * and the dispatcher's progress bar name the same event the same way.
 */
export const TRIP_START_STOP_NAME = 'Start trip';

/**
 * One row of a trip's itinerary, with its check-in state.
 *
 * `stopId` is `null` for the trip-start pseudo-stop — the event that
 * happens before any itinerary stop is reached, stored as a
 * `trip_checkpoints` row with a null `stop_id`.
 *
 * **`checkedAt` and `undone` are both kept, deliberately.** An undone
 * check-in counts as NOT done (that is the entire purpose of the column),
 * but it is not erased either: §8 says "marked `undone`, not deleted", and
 * a driver who retracted a tap at 10:16 and a dispatcher asking why the
 * van is still at Kawasan both need to see that something happened there.
 * Consumers decide what to render; they must not treat a non-null
 * `checkedAt` as "done" on its own.
 *
 * `checkedAt` is an ISO instant in UTC — SERVER time, never the driver's
 * device clock. Formatting it for Manila is the view's job, not this
 * layer's.
 *
 * `sortOrder` is the tour's own `tour_itinerary_stops.sort_order`, echoed
 * for real stops and `0` for trip start. **Render `stops` in array order**
 * — the array is already correct, and trip start precedes every itinerary
 * stop regardless of what number that stop carries, so sorting by this
 * field is not the same question.
 */
export interface TripProgressStop {
  /** `null` for the trip-start pseudo-stop. */
  stopId: number | null;
  name: string;
  sortOrder: number;
  checkedAt: string | null; // ISO instant, server time
  undone: boolean;
}

/**
 * A whole trip's itinerary and how far along it is — **one answer, two
 * surfaces**: the driver's trip screen (Task 4) and the admin's live
 * departures board (Task 12) both read exactly this.
 *
 * Two implementations of this question would drift, and the drift shows up
 * as a dispatcher ringing a driver who has already checked in. Hence the
 * types living in `shared/` rather than in a driver-only module: Task 12 is
 * an admin surface and imports the same shape.
 *
 * `done` counts stops checked in and NOT undone; `total` is `stops.length`,
 * trip start included — so the dispatcher's bar moves when the van leaves,
 * which is the first thing the board is watched for.
 */
export interface TripProgress {
  bookingId: number;
  status: BookingStatus;
  /** Trip start first, then `tour_itinerary_stops` by `sort_order`. */
  stops: TripProgressStop[];
  /** Stops checked in and not undone, over total. For the admin's bar. */
  done: number;
  total: number;
}

/* ------------------------------------------------------------------ *
 * One trip's detail and §8's payment box (Week 6 plan, Task 4)
 * ------------------------------------------------------------------ */

/**
 * Which `bookings.id` the driver is asking about — and the ONLY input this
 * procedure has.
 *
 * `.strict()`, as every other input schema in this package is: a request
 * carrying a `driverId` is refused at the input stage rather than silently
 * ignored. **There is deliberately no driver field of any kind** — the
 * driver comes from the session (`ctx.driver.driverId`) and the booking id
 * is only ever narrowed by it, never widened. A `driverId` quietly dropped
 * from an input is a field somebody will one day decide to honour.
 */
export const driverTripInputSchema = z
  .object({
    bookingId: z.number().int().positive(),
  })
  .strict();
export type DriverTripInput = z.infer<typeof driverTripInputSchema>;

/**
 * §8's payment box: **the single most consequential thing in the driver
 * portal**, because it tells a driver whether to take money from a guest.
 *
 * Three states, and the middle one is the dangerous one:
 *
 *  - `fully_paid` — nothing is owed. Wave them aboard.
 *  - `unverified_do_not_collect` — money is claimed but nobody has verified
 *    it (a `pending` payment row), or the booking's money needs an admin's
 *    eyes (`bookings.payment_review_required`). **Do not collect**; §8's
 *    copy is "Not paid — don't collect, call office".
 *  - `collect_cash` — take exactly `amountCentavos`, in centavos.
 *
 * **The state is computed on the server and the client only renders it.**
 * Not a hint, not a convenience: a second derivation in the browser is a
 * second chance to get it wrong, and getting it wrong either takes a
 * guest's money twice or lets them ride for free. The client receives no
 * totals to re-derive it from either — `amountCentavos` is the server's
 * arithmetic, already done.
 *
 * A discriminated union rather than a flag plus a nullable amount, so
 * `amountCentavos` cannot be read on a state that has no amount and a
 * `switch` over the three is exhaustive at compile time (the same
 * discipline Week 5's `AssignRefusal` copy map uses).
 */
export type PaymentBoxState =
  | { kind: 'collect_cash'; amountCentavos: number }
  | { kind: 'fully_paid' }
  | { kind: 'unverified_do_not_collect' };

/**
 * One trip, as the driver who is driving it sees it (§8 "Trip detail").
 *
 * **`leadPhone` is here on purpose, and it is why this is a
 * `driverProcedure` filtered on the session.** §8 gives the driver
 * call/text/WhatsApp buttons, which need a number. That makes this the most
 * sensitive payload in the portal under RA 10173, so the payload is exactly
 * §8's list and stops there:
 *
 *  - the LEAD guest only — no other guests' details exist on a booking, and
 *    none are invented here;
 *  - no `leadEmail`: §8 gives the driver call, text and WhatsApp, all of
 *    which are the phone. An address a driver never uses is an address that
 *    leaks for nothing;
 *  - no money except `payment`: not the total, not what has been paid, not
 *    the deposit percent. The box is the answer, and the inputs to it are
 *    not a driver's business — nor could a tampered client re-derive a
 *    different answer from them;
 *  - no payment instrument data of any kind. PayMongo holds that and this
 *    system never stores it.
 *
 * `pickup`, `pickupMapsUrl` and `vanPlate` are nullable because their
 * columns are: a trip can be confirmed before dispatch assigns a van, and a
 * guest may be met at a pier with no map link. The screen must render the
 * trip rather than hide it.
 *
 * `officeNotes` is §8's "Office notes" — `booking_notes`, oldest first,
 * **text only**: no author and no timestamp, because the driver needs the
 * instruction ("guest waiting at the second gate") and not an audit trail
 * of who typed it. The admin surface has that.
 *
 * `progress` is `tripProgress()`'s answer UNCHANGED, which is what keeps
 * the driver's itinerary and the dispatcher's progress bar from disagreeing.
 * Note `total` counts the trip-start pseudo-stop, so a three-stop tour
 * reads 0 / 4.
 */
export interface TripDetail {
  bookingId: number;
  ref: string;
  tourTitle: string;
  /** Manila civil date, `YYYY-MM-DD`. */
  tourDate: string;
  pax: number;
  status: BookingStatus;
  leadName: string;
  /** §8: the driver calls or texts the lead guest. Their OWN trip only. */
  leadPhone: string;
  pickup: string | null;
  pickupMapsUrl: string | null;
  vanPlate: string | null;
  /** `booking_notes.note`, oldest first. Text only. */
  officeNotes: string[];
  payment: PaymentBoxState;
  progress: TripProgress;
}

/* ------------------------------------------------------------------ *
 * Check-ins: start, stop, complete (Week 6 plan, Task 5 — BUILD_SPEC §8
 * "Itinerary check-ins")
 * ------------------------------------------------------------------ */

/**
 * Every way a check-in can be refused, and nothing else.
 *
 * In `shared/` for the same reason `DriverLoginRefusal` is (pre-flight
 * ruling, 2026-10-15): Task 10 builds an exhaustive
 * `Record<CheckInRefusal, string>` of the copy a driver reads in a van, so
 * the day a seventh refusal is added the build fails on the screen that has
 * no words for it rather than falling through to generic copy. The client
 * cannot import from `server/`, so the union has to live here for that to
 * work.
 *
 * Why each is separate — the driver's next action differs for every one:
 *
 *  - `not_your_trip` — the booking is not theirs, or does not exist. ONE
 *    answer for both, deliberately: `driver.trip` already refuses the two
 *    indistinguishably so a numeric id cannot be walked towards a guest's
 *    phone number (RA 10173), and a mutation that distinguished them would
 *    hand back the oracle the query withholds.
 *  - `trip_not_startable` — the booking is not in a state that has a trip
 *    to start. A `confirmed` booking has no van and no driver, so nobody
 *    can start it; dispatch has to assign one first.
 *  - `already_checked_in` — that exact event is already recorded. The
 *    double tap on a bumpy road, and the answer is "nothing to do", not an
 *    error.
 *  - `unknown_stop` — the stop is not on this trip's tour.
 *  - `trip_not_started` — a stop was tapped before "Start trip", or after
 *    the trip was completed. Tap Start first.
 *  - `nothing_to_undo` — Task 6's undo, with no most-recent check-in to
 *    retract.
 */
export type CheckInRefusal =
  | 'not_your_trip'
  | 'trip_not_startable'
  | 'already_checked_in'
  | 'unknown_stop'
  | 'trip_not_started'
  | 'nothing_to_undo';

/**
 * What a check-in mutation answers: the trip's new progress, or a reason.
 *
 * A refusal is a VERDICT and not a thrown error, the same contract
 * `assessCapacity` and `assignVanAndDriver` carry — the six reasons above
 * are all ordinary outcomes of a driver tapping a button in a van with one
 * bar of signal, and a `TRPCError` for "you already tapped that" would
 * reach the screen as a failure instead of as a shrug.
 *
 * `progress` on success is `tripProgress()`'s own answer, read inside the
 * same transaction that wrote the checkpoint — so the screen redraws from
 * the committed truth without a second round trip. That is not a nicety at
 * a pier with no signal: a mutation whose result the client has to re-fetch
 * is two chances to fail instead of one.
 */
export type CheckInResult =
  { ok: true; progress: TripProgress } | { ok: false; reason: CheckInRefusal };

/**
 * Which stop on which booking — and NOTHING else, `.strict()`.
 *
 * **There is deliberately no timestamp field.** `trip_checkpoints.checked_at`
 * is server time (schema: "never the driver's device clock"), so there is no
 * input through which a handset whose clock is three hours out — or a driver
 * who would rather the record said 06:00 — can say when it happened. There
 * is no driver field either: the driver comes from the session and only ever
 * narrows the booking id.
 */
export const driverStopCheckInSchema = z
  .object({
    bookingId: z.number().int().positive(),
    stopId: z.number().int().positive(),
  })
  .strict();
export type DriverStopCheckInInput = z.infer<typeof driverStopCheckInSchema>;

/* ------------------------------------------------------------------ *
 * Undo the last check-in (Week 6 plan, Task 6 — BUILD_SPEC §8 "Undo last
 * check-in (only the most recent; marked `undone`, not deleted)")
 * ------------------------------------------------------------------ */

/**
 * Which booking, and **why** — `.strict()`, like every other input here.
 *
 * `reason` is REQUIRED and non-empty after trimming (owner decision
 * 2026-10-15, Q4), which is the one way this schema differs from
 * `driverTripInputSchema`. An undo rewrites what the system says happened
 * on a trip: "arrived 10:15, retracted 10:16" and "retracted three days
 * later, after the complaint" are different facts in a refund argument, and
 * the reason is the only part of that a column cannot infer. `.trim()`
 * before `.min(1)` so a reason of three spaces is refused rather than
 * stored — an optional-in-practice field is not a required one.
 *
 * There is deliberately no timestamp and no driver field: `undone_at` is
 * server time and `undone_by` comes from the session, exactly as
 * `checked_at` does.
 */
export const driverUndoCheckInSchema = z
  .object({
    bookingId: z.number().int().positive(),
    reason: z.string().trim().min(1).max(500),
  })
  .strict();
export type DriverUndoCheckInInput = z.infer<typeof driverUndoCheckInSchema>;

/**
 * What an undo answers: which stop was retracted, or a reason it was not.
 *
 * A VERDICT and not a thrown error, the same contract `CheckInResult`
 * carries — `nothing_to_undo` is an ordinary outcome of a driver tapping
 * Undo twice, not a failure.
 *
 * `stopId` is `null` for two different retractions, and that is deliberate
 * rather than an omission: the trip-start pseudo-stop has no `stop_id`, and
 * an undone COMPLETION has no stop at all. Nothing decides anything from
 * this field — the screen refetches `driver.trip`, whose `progress` and
 * `status` are the authority — so a discriminator here would be a second
 * source of truth for a question already answered.
 *
 * It is NOT a `CheckInResult`: an undo returns no `TripProgress`, because
 * the one thing it must not do is let a client redraw a trip from a payload
 * that says the trip is further along than the database does.
 */
export type CheckInUndoResult =
  { ok: true; stopId: number | null } | { ok: false; reason: CheckInRefusal };

/* ------------------------------------------------------------------ *
 * Cash collected (Week 6 plan, Task 8 — BUILD_SPEC §8 item 5)
 * ------------------------------------------------------------------ */

/**
 * What a driver's cash claim answers — **a claim, not a reconciliation.**
 *
 * The driver's tap writes one `pending` `payments` row and moves nothing on
 * the booking. Finance (or the owner) converts that same row to `paid` and
 * credits the booking, which is a different person on a different screen:
 * a driver who could verify their own collection could pocket the cash and
 * leave the booking reading "paid in full".
 *
 * There is no input type here — the procedure takes `driverTripInputSchema`,
 * a `bookingId` and nothing else. **Deliberately no amount**: the browser
 * does not say how much cash was handed over. The server derives it from
 * the booking (`total_centavos - amount_paid_centavos`, through the same
 * `PaymentBoxState` the trip screen is given), so the figure the driver was
 * shown and the figure the claim records cannot differ.
 */
export interface CashClaimResult {
  /** The `pending` row. Finance verifies this id and no other (Task 11). */
  paymentId: number;
  /** Centavos, as derived on the server. What the claim says was taken. */
  amountCentavos: number;
}
