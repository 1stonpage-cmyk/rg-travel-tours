/**
 * How a transfer booking names itself on a screen — the one function each,
 * shared by every surface that shows a transfer next to a tour's title.
 *
 * Extracted from `services/reports/money.ts` (Task T23). That module's own
 * doc comments named this moment: `routeDisplayName`/`transferTitle` started
 * there as `revenueByRoute`'s and `outstandingBookings`'s private helpers,
 * were exported narrowly for `routers/public/driver.ts` (Task T22) as the
 * second caller, and said T23 — the third caller, now three more
 * (`admin/bookings.ts`, `admin/calendar.ts`, `admin/departures.ts`) — was
 * the point to decide whether this belongs in its own module rather than
 * guessing from one. Five callers across reports, the driver portal and the
 * admin screens is not "one module's narrow re-export" any more.
 */
import type { TransferDirection } from '@rg/shared';

/**
 * A route's two places, in guest-facing order for the direction travelled —
 * the same forward/reverse swap `RoutePicker.tsx`'s `legsFor()` does for the
 * booking flow, read backwards here for reporting and for every screen that
 * shows a booked transfer's route.
 */
export function routeDisplayName(
  fromName: string,
  toName: string,
  direction: TransferDirection,
): string {
  return direction === 'reverse' ? `${toName} → ${fromName}` : `${fromName} → ${toName}`;
}

/**
 * The label a transfer booking shows in place of a tour's title: the route,
 * travelled order, or "Custom transfer" for a staff-quoted booking with no
 * catalog route.
 *
 * **The caller decides whether to call this at all.** Every input here is
 * `null` for a TOUR booking (no route, no custom description), and this
 * function cannot tell a tour from a routeless, description-less transfer —
 * it would answer `'Custom transfer'` for both. Every caller must check
 * `tourId === null` (or the booking's own `productType <> 'tour'`) first, or
 * risk naming a tour "Custom transfer".
 */
export function transferTitle(opts: {
  fromName: string | null;
  toName: string | null;
  direction: TransferDirection | null;
  customRouteDescription: string | null;
}): string {
  if (opts.fromName !== null && opts.toName !== null) {
    return routeDisplayName(opts.fromName, opts.toName, opts.direction ?? 'forward');
  }
  return opts.customRouteDescription ?? 'Custom transfer';
}
