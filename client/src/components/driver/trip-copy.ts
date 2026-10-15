/**
 * The words the driver portal reads out loud, in one place (Week 6 plan,
 * Task 10).
 *
 * Not a component file, deliberately: both maps below are shared across the
 * trip list, the trip screen and the checklist, and exporting a constant
 * from a component module breaks Fast Refresh (the lint rule that says so
 * is the reason this file exists rather than a re-export from
 * `DriverTripsPage`).
 *
 * Both are **exhaustive `Record`s over a union from `@rg/shared`**, which is
 * the whole point of them. The day a seventh `CheckInRefusal` or a ninth
 * `BookingStatus` is added, the build fails HERE — on the copy that does
 * not exist — rather than falling through to a generic sentence in a van.
 * That is the discipline `AssignPanel`'s `AssignRefusal` / `REFUSAL_COPY`
 * pair established in Week 5 and Task 9's login screen repeated.
 */
import type { BookingStatus, CheckInRefusal } from '@rg/shared';

/**
 * A booking status in the words a driver reads — short, because this is a
 * chip on a list and on a trip header, not a sentence.
 *
 * One definition for both surfaces, so the list and the detail screen
 * cannot describe one booking two different ways.
 */
export const STATUS_LABEL: Record<BookingStatus, string> = {
  pending_payment: 'Not paid',
  pending_verification: 'Payment being checked',
  confirmed: 'Confirmed',
  assigned: 'Assigned to you',
  in_progress: 'Under way',
  completed: 'Completed',
  cancelled: 'Cancelled',
  expired: 'Expired',
};

/**
 * Every way a check-in or an undo can be refused, and the words for it.
 *
 * The six reasons are ordinary outcomes of a driver tapping a button in a
 * van with one bar of signal — the server answers them as verdicts
 * (`{ ok: false, reason }`) rather than as errors, so each one needs a
 * sentence that says what to do next, not an apology.
 */
export const CHECK_IN_REFUSAL_COPY: Record<CheckInRefusal, string> = {
  not_your_trip: 'This trip is not on your list any more. Go back and reload, or ring the office.',
  trip_not_startable:
    'This trip cannot be started yet — the office still has to assign a van and driver.',
  already_checked_in: 'That one is already checked in. Nothing more to do.',
  unknown_stop: 'That stop is no longer on this trip. Go back and reload the trip.',
  trip_not_started: 'Tap Start trip first.',
  nothing_to_undo: 'There is nothing left to undo on this trip.',
};
