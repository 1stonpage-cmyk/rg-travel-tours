/**
 * The daily orphaned-van check (owner decision 2026-10-16, D5).
 *
 * **It changes nothing.** It asks `orphanedOnTripVans()` and logs what it
 * finds, so that a van removed from sale by a trip nobody completed shows up
 * within a day instead of surfacing weeks later as a mysteriously full
 * calendar. The dashboard alert is the surface a dispatcher sees; this is the
 * one an operator greps at 2am.
 *
 * Why a log line AND an alert: the alert needs somebody to open the
 * dashboard, and the failure this catches is precisely the kind nobody is
 * looking for. A dated log line is also what makes "how long has that van
 * been stuck?" answerable after the fact.
 *
 * ## It must never write a van status
 *
 * Not "does not currently": MUST NOT. A sweep that freed the van would, on
 * the one day a trip genuinely overran past midnight, put a van with guests
 * in it back on sale. A dispatcher can tell the two apart; a clock cannot.
 * It writes no audit row either — an observation is not an event. Both are
 * pinned by `orphaned-vans.test.ts`, and the first by
 * `trip-van-status.test.ts`'s gap test as well.
 *
 * Same discipline as `expire-holds.ts`: the clock is a PARAMETER, the module
 * exports a plain async function, scheduling lives in `./index.ts`, and
 * importing this starts nothing. `now` is used only in the log line, so a test
 * calls the job directly instead of waiting on a timer.
 */
import { getDb } from '../db/client';
import { orphanedOnTripVans } from '../services/dispatch/alerts';

export async function checkOrphanedVans(now: Date): Promise<{ found: number }> {
  const alert = await getDb().transaction((tx) => orphanedOnTripVans(tx));
  if (alert.count > 0) {
    // `console.warn`, not `error`: nothing is broken, a human needs to look.
    // Plates and refs only, never a guest name (RA 10173). Only the examples
    // the alert carries are named; the count covers the rest.
    console.warn(
      `[jobs] orphaned-vans: ${alert.count} van(s) sitting in on_trip with no running trip ` +
        `as of ${now.toISOString()} — ${alert.examples.map((e) => e.label).join('; ')}. ` +
        'Each is refused on every future date. Nothing has been changed; a dispatcher must ' +
        'complete or correct each trip.',
    );
  }
  return { found: alert.count };
}
