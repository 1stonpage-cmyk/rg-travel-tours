/**
 * Week 6, Task 12 (6D): today's departures, stop by stop (BUILD_SPEC §9
 * "Dashboard: today's departures with stop-by-stop progress bars").
 *
 * This is the panel the Week 5 dashboard left a line of apology in. It
 * replaces that line.
 *
 * ## The numbers are written out, and the bar is decoration
 *
 * `3 of 7 stops`, in text, beside a bar that is `aria-hidden`. A bar alone
 * is length and colour, which `CLAUDE.md` forbids as a sole signal (WCAG
 * 1.4.1) — so the bar duplicates the sentence rather than replacing it, and
 * is hidden from assistive technology precisely because it says nothing the
 * sentence has not already said. `progress.total` counts the trip-start
 * pseudo-stop, so a three-stop tour reads `0 of 4` before departure and `1
 * of 4` once the van leaves: that is what makes this bar move at departure,
 * and it is NOT adjusted here — the driver's checklist reads the same
 * numbers (`StopList.tsx`), and a board that quietly subtracted one would
 * disagree with the screen in the van.
 *
 * ## Fifteen seconds, and no spinner
 *
 * §9: "Check-ins update the admin dashboard within ~15 seconds (polling is
 * fine; no websockets needed)". So a `refetchInterval`, and nothing more
 * exotic. **A background refresh is not a page load**: the rows stay on
 * screen while one is in flight and the busy state is reported with
 * `aria-busy` on the region, not with a spinner that blinks every fifteen
 * seconds in a dispatcher's peripheral vision. The design doc settles this
 * (`driver-screen-design.md`, "The departures board") on the
 * `ui-ux-pro-max` loading-indicator guidance: one timing threshold does not
 * fit both a first load and a poll.
 *
 * The header says "Updates every 15 seconds" permanently rather than
 * appearing only while fetching — a static sentence is what tells an
 * operator the screen is live; a flickering one tells them the screen is
 * busy, which is not the same information.
 *
 * ## No second status region
 *
 * The dashboard already owns ONE `role="status"` for the alert set, and
 * five competing live regions is the named anti-pattern. This board adds
 * none: its own state is `aria-busy` (an attribute, not an announcement)
 * plus ordinary prose for the empty and error cases.
 *
 * ## Amber for a gap, never the forbidden hue
 *
 * A departure with no van or no driver is the row this board exists to
 * surface, and it is marked amber — `CLAUDE.md`: warnings amber/orange,
 * errors `#334155` (`text-brand-error`). The load failure is prose in
 * `text-brand-error`, not a coloured banner.
 */
import {
  BOOKING_STATUS_LABELS,
  TRIP_START_STOP_NAME,
  manilaTimeHHMM,
  type BookingStatus,
  type TodayDeparture,
  type TripProgressStop,
} from '@rg/shared';
import { Link } from 'react-router-dom';
import { trpc } from '@/lib/trpc';

/**
 * §9's "within ~15 seconds", as a number in one place.
 *
 * Exported so the dashboard and the test read the same value rather than
 * two literals that can drift.
 */
export const DEPARTURES_POLL_MS = 15_000;

/**
 * The status pill: words always, tone only to help the eye.
 *
 * The WORDS are `BOOKING_STATUS_LABELS` (`@rg/shared`), shared with the three
 * admin screens and the pill component. This tone grouping is the board's
 * own: a departures row highlights `in_progress` because that is the van
 * that is out right now.
 */
function statusPillClass(status: BookingStatus): string {
  if (status === 'in_progress') return 'bg-brand-blue-100 text-brand-blue-800';
  if (status === 'completed' || status === 'cancelled' || status === 'expired') {
    return 'bg-slate-100 text-brand-error';
  }
  return 'border-brand-blue-200 text-brand-blue-800 border bg-white';
}

/** A check-in is DONE only when it happened and was not retracted. */
function isDone(stop: TripProgressStop): boolean {
  return stop.checkedAt !== null && !stop.undone;
}

/**
 * The last stop this trip actually reached, or `null` before it leaves.
 *
 * Read from the END of the array, which `tripProgress` already returns in
 * driving order (trip start, then `sort_order`) — so this is "where the van
 * is", not "the highest id that was tapped".
 */
function lastReached(departure: TodayDeparture): TripProgressStop | null {
  const done = departure.progress.stops.filter(isDone);
  return done.length === 0 ? null : done[done.length - 1]!;
}

/** `'2026-10-16T01:45:00.000Z'` -> `'09:45'`, Manila, display only. */
function atTime(iso: string): string {
  return manilaTimeHHMM(new Date(iso));
}

function DepartureRow({ departure }: { departure: TodayDeparture }) {
  const { progress } = departure;
  const reached = lastReached(departure);
  /*
   * Guarded against a zero total even though `tripProgress` always returns
   * at least trip start: a NaN width is a silently invisible bar, and the
   * guard costs one comparison.
   */
  const percent = progress.total === 0 ? 0 : Math.round((progress.done / progress.total) * 100);
  const missing: string[] = [];
  if (departure.vanPlate === null) missing.push('van');
  if (departure.driverName === null) missing.push('driver');

  return (
    <li
      data-testid={`departure-${departure.ref}`}
      className="border-brand-blue-100 border-t px-5 py-4 first:border-t-0"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <p className="text-brand-ink font-mono text-sm font-bold">{departure.ref}</p>
        <p
          className={[
            'rounded-full px-2.5 py-1 text-xs font-semibold',
            statusPillClass(departure.status),
          ].join(' ')}
        >
          {BOOKING_STATUS_LABELS[departure.status]}
        </p>
      </div>

      <p className="text-brand-ink mt-1 text-base font-semibold">{departure.tourTitle}</p>

      <p className="text-brand-error mt-0.5 text-sm">
        {departure.driverName ?? 'No driver yet'} · {departure.vanPlate ?? 'No van yet'}
      </p>

      {missing.length > 0 ? (
        <p className="text-brand-ink mt-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm font-medium">
          Departing today with no {missing.join(' and no ')} assigned.
        </p>
      ) : null}

      {/* The numbers, in words. The bar below only repeats them. */}
      <p className="text-brand-ink mt-3 text-sm font-semibold">
        {progress.done} of {progress.total} stops
      </p>
      <div
        aria-hidden="true"
        className="bg-brand-blue-100 mt-1 h-2 w-full overflow-hidden rounded-full"
      >
        <div
          /*
           * Tailwind transitions only (`emilkowalski-motion` is not
           * installed). No `motion-reduce:` variant here on purpose: the
           * unconditional `prefers-reduced-motion` block in `index.css`
           * already clamps every `transition-duration` to 0.01ms, so a
           * per-class override would be a second, narrower copy of a rule
           * the stylesheet already applies site-wide — the same reasoning
           * `FloatingWhatsApp.tsx` and `SiteHeader.tsx` record.
           */
          className="bg-brand-blue-600 h-full rounded-full transition-[width] duration-500 ease-out"
          style={{ width: `${percent}%` }}
        />
      </div>

      <p className="text-brand-error mt-1 text-sm">
        {reached === null
          ? 'Not started — the van has not left yet.'
          : reached.name === TRIP_START_STOP_NAME
            ? `Left for the pickup at ${atTime(reached.checkedAt!)}`
            : `${reached.name} at ${atTime(reached.checkedAt!)}`}
      </p>

      <Link
        to={`/admin/bookings/${departure.ref}`}
        className="text-brand-blue-700 tap-target mt-2 inline-flex items-center text-sm font-medium underline-offset-4 hover:underline"
      >
        Open this booking
      </Link>
    </li>
  );
}

export interface DeparturesBoardProps {
  /** Draw a "Departures board" link to the full-screen version (the dashboard does; the board's own page does not). */
  showBoardLink?: boolean;
  /**
   * The poll interval. Defaults to §9's fifteen seconds; a test passes a
   * few milliseconds so that "it really does poll" is something asserted
   * rather than read off a constant.
   */
  pollMs?: number;
}

export default function DeparturesBoard({
  pollMs = DEPARTURES_POLL_MS,
  showBoardLink = false,
}: DeparturesBoardProps) {
  const query = trpc.admin.departures.today.useQuery(undefined, {
    refetchInterval: pollMs,
    retry: false,
  });

  const departures = query.data ?? [];

  return (
    <section
      aria-labelledby="departures-heading"
      /*
       * The accessible busy state. True on the first load AND on every
       * background refresh — the rows below are not replaced either way,
       * which is the point: a dispatcher reading a plate does not want it
       * swapped for a spinner.
       */
      aria-busy={query.isFetching}
      data-testid="departures-board"
      className="border-brand-blue-100 overflow-hidden rounded-[14px] border bg-white"
    >
      <div className="border-brand-blue-100 flex flex-wrap items-center justify-between gap-x-3 gap-y-1 border-b px-5 py-4">
        <h2 id="departures-heading" className="text-brand-ink text-lg font-bold">
          Leaving today
        </h2>
        <p className="text-brand-error text-xs">Updates every 15 seconds.</p>
        {showBoardLink ? (
          <Link
            to="/admin/departures"
            className="text-brand-blue-700 hover:text-brand-blue-900 tap-target inline-flex items-center text-sm font-semibold underline underline-offset-4 transition-colors"
          >
            Departures board
          </Link>
        ) : null}
      </div>

      {query.isPending ? (
        <p className="text-brand-error px-5 py-4 text-sm">Loading today's departures…</p>
      ) : null}

      {query.isError ? (
        <p role="alert" className="text-brand-error px-5 py-4 text-sm">
          Today's departures could not load. Reload the page to try again.
        </p>
      ) : null}

      {!query.isPending && !query.isError && departures.length === 0 ? (
        <p className="text-brand-error px-5 py-4 text-sm">
          No departures today. Trips appear here on their tour date.
        </p>
      ) : null}

      {departures.length > 0 ? (
        <ul>
          {departures.map((departure) => (
            <DepartureRow key={departure.bookingId} departure={departure} />
          ))}
        </ul>
      ) : null}
    </section>
  );
}
