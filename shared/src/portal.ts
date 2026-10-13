/**
 * The customer portal's two pieces of business logic (BUILD_SPEC §7,
 * Week 4 Task 9).
 *
 * Both live in `/shared` and both are PURE: the server decides with them
 * and the client renders from them, so "which step is the booking on" and
 * "may this guest still see the driver's number" have exactly one answer
 * each. A copy of either in the browser is a copy that will disagree with
 * the server on the day it matters.
 */
import { manilaCivilDate } from './time';
import type { BookingStatus } from './booking';

/** §7's five steps, in order, by their table's own names. */
export const TRACKER_STEPS = [
  'Booked',
  'Payment sent',
  'Verified by admin',
  'Driver assigned',
  'Tour day',
] as const;
export type TrackerStep = (typeof TRACKER_STEPS)[number];

/** The facts §7's table decides from, and nothing else. */
export interface TrackerFacts {
  status: BookingStatus;
  /** `bookings.amount_paid_centavos`. Above zero means money has landed. */
  paidCentavos: number;
  /** Whether a receipt has been uploaded at all, whatever became of it. */
  hasReceipt: boolean;
}

export interface TrackerState {
  step: TrackerStep;
  /** This step has happened. */
  done: boolean;
}

/**
 * **§7's tracker table, implemented exactly as written:**
 *
 * | Step              | Done when                                    |
 * | ----------------- | -------------------------------------------- |
 * | Booked            | Booking exists                               |
 * | Payment sent      | Online payment received, or receipt uploaded  |
 * | Verified by admin | Payment `paid` (auto for PayMongo)           |
 * | Driver assigned   | Booking `assigned`                           |
 * | Tour day          | Booking `in_progress` or `completed`         |
 *
 * Read as five independent predicates rather than a single "furthest step
 * reached", because they are not strictly nested in real life: a guest can
 * have sent a receipt that was then rejected, and a `cancelled` booking can
 * carry money that was paid before it was cancelled. A step index would
 * have to pick one story; five booleans tell the true one.
 *
 * `cancelled` and `expired` light whatever actually happened and nothing
 * more — the page says in words that the booking is cancelled, which is
 * clearer than a tracker pretending to be mid-journey.
 */
export function portalTracker(facts: TrackerFacts): TrackerState[] {
  const { status, paidCentavos, hasReceipt } = facts;
  const verified = paidCentavos > 0;
  const afterAssignment =
    status === 'assigned' || status === 'in_progress' || status === 'completed';

  return [
    { step: 'Booked', done: true },
    // "Online payment received, or receipt uploaded" — either one.
    { step: 'Payment sent', done: verified || hasReceipt },
    { step: 'Verified by admin', done: verified },
    { step: 'Driver assigned', done: afterAssignment },
    { step: 'Tour day', done: status === 'in_progress' || status === 'completed' },
  ];
}

/**
 * Whether the assigned driver's details may still be shown (§7: "visible
 * from assignment until tour day ends").
 *
 * **"Until tour day ends" is the END OF THE TOUR DATE in Asia/Manila.**
 * _Proposed by the developer 2026-10-14 — pending R&G confirmation (plan
 * question Q9)._ §7 does not define it and the schema cannot: `tours` has
 * `duration_hours` but no departure time, so there is no instant to add it
 * to. The civil day is the one bound that is both unambiguous and generous
 * to the guest — a trip that runs late still has a reachable driver, and a
 * guest who needs to call at 9pm on tour day can.
 *
 * Deliberately NOT "forever once assigned": a driver's personal mobile
 * number is personal data (RA 10173), and a booking page that keeps
 * serving it for years is a slow leak with no purpose.
 *
 * @param tourDate a civil date, `YYYY-MM-DD` — never a timestamp.
 */
export function isDriverVisible(status: BookingStatus, tourDate: string, now: Date): boolean {
  if (status !== 'assigned' && status !== 'in_progress' && status !== 'completed') return false;
  // String comparison, safe because both sides are zero-padded `YYYY-MM-DD`
  // — the same discipline `isDateBookable` uses.
  return manilaCivilDate(now) <= tourDate;
}

/**
 * §7: "Auto-refresh status every 20 seconds while `pending_verification`."
 */
export const PORTAL_POLL_MS = 20_000;

/**
 * How often the portal page should re-ask the server, or `false` for never.
 *
 * **Only `pending_verification` polls**, and that is the whole rule. That
 * is the one status where the answer changes without the guest doing
 * anything: an admin is looking at their receipt right now. Every other
 * status changes only when the guest acts (so the mutation refetches) or
 * days later (so a poll is a waste of a mobile data allowance).
 *
 * A function rather than a ternary inside the component, because "when does
 * the portal poll" is a rule worth testing over all eight statuses rather
 * than a detail buried in a hook argument.
 */
export function portalPollMs(status: BookingStatus): number | false {
  return status === 'pending_verification' ? PORTAL_POLL_MS : false;
}
