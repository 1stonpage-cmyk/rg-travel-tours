/**
 * The driver's trip list — §8's **Today / Upcoming / History** (Week 6
 * plan, Task 10). This is `/driver`'s index: it replaced Task 9's one-line
 * stand-in, and it owns the tabs because it owns the three buckets they
 * switch between.
 *
 * ## There is no second "what is today" in this file
 *
 * `driver.trips` sends every row with its `bucket` already resolved from
 * the Manila civil date on the SERVER's clock, and this page groups by that
 * field. It does not call `driverTripBucket` and it does not read the
 * handset's clock: for the whole 00:00-07:59 Manila window the device's UTC
 * calendar day is still yesterday, so a driver opening the portal at 00:30
 * to check the morning's pickup would be shown it under "Upcoming" and
 * their finished trip under "Today" — the one moment of the day when being
 * wrong costs a departure. The shared `driverTripBucket` exists for a
 * surface that must re-bucket against a Manila date it was GIVEN; this one
 * was given the answer itself, which is strictly better.
 *
 * One request feeds all three tabs. §8's three tabs are one payload, and a
 * driver at a pier with one bar of signal keeps whatever the last load gave
 * them rather than losing a tab to a failed fetch.
 *
 * ## The tabs are bottom-anchored
 *
 * Within the five-item bottom-nav ceiling, and the only nav a driver gets —
 * no breadcrumbs (two levels), no admin chrome. Fixed to the bottom of the
 * viewport where a thumb reaches, with `env(safe-area-inset-bottom)`
 * padding via `.driver-tabs-safe`, and the list reserves room for it with
 * `.pb-driver-tabs-safe` so the last trip can always be scrolled clear.
 * `client/index.html` carries `viewport-fit=cover`; without it that padding
 * is inert (BUG-079).
 *
 * The selected tab is marked by `aria-selected`, by weight, and by a solid
 * top rule — never by colour on its own.
 */
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { CalendarDays, ChevronRight, Clock, History, Users } from 'lucide-react';
import type { DriverTripBucket, DriverTripRow } from '@rg/shared';
import { STATUS_LABEL } from '@/components/driver/trip-copy';
import { trpc } from '@/lib/trpc';

const TABS: { bucket: DriverTripBucket; label: string; icon: typeof Clock }[] = [
  { bucket: 'today', label: 'Today', icon: Clock },
  { bucket: 'upcoming', label: 'Upcoming', icon: CalendarDays },
  { bucket: 'history', label: 'History', icon: History },
];

const EMPTY_COPY: Record<DriverTripBucket, string> = {
  today: 'Nothing for you today. Ring the office if you were expecting a trip.',
  upcoming: 'No trips booked in for you yet.',
  history: 'No finished trips yet.',
};

/** `'2026-12-25'` → a readable Manila date. Display only, no arithmetic. */
const dateFormatter = new Intl.DateTimeFormat('en-PH', {
  timeZone: 'Asia/Manila',
  weekday: 'short',
  day: 'numeric',
  month: 'short',
});

function readableDate(civilDate: string): string {
  return dateFormatter.format(new Date(`${civilDate}T00:00:00Z`));
}

function TripCard({ trip }: { trip: DriverTripRow }) {
  return (
    <li>
      <Link
        to={`/driver/trip/${trip.bookingId}`}
        className="tap-target press border-brand-blue-200 bg-background focus-visible:ring-brand-blue-600 flex items-center gap-3 rounded-xl border p-4 transition-colors focus-visible:outline-none focus-visible:ring-2"
      >
        <span className="min-w-0 flex-1">
          <span className="text-brand-blue-900 block text-base font-bold">{trip.tourTitle}</span>
          <span className="text-brand-blue-900 mt-1 block text-base">
            {readableDate(trip.tourDate)}
            <span aria-hidden="true"> · </span>
            <Users className="inline size-4 align-[-2px]" aria-hidden="true" />{' '}
            {trip.pax === 1 ? '1 guest' : `${trip.pax} guests`}
            {trip.vanPlate === null ? null : (
              <>
                <span aria-hidden="true"> · </span>
                {trip.vanPlate}
              </>
            )}
          </span>
          <span className="text-brand-blue-900 mt-1 block text-sm font-semibold">
            {trip.ref}
            <span aria-hidden="true"> · </span>
            {STATUS_LABEL[trip.status]}
          </span>
        </span>
        <ChevronRight className="text-brand-blue-700 size-6 shrink-0" aria-hidden="true" />
      </Link>
    </li>
  );
}

export default function DriverTripsPage() {
  const [active, setActive] = useState<DriverTripBucket>('today');
  const trips = trpc.driver.trips.useQuery();

  const rows = trips.data ?? [];
  const shown = rows.filter((trip) => trip.bucket === active);

  return (
    <div className="pb-driver-tabs-safe">
      <h1 className="text-brand-blue-900 text-2xl font-bold">My trips</h1>

      {trips.isPending ? (
        <p className="text-brand-blue-900 mt-4 text-base" role="status">
          Loading your trips…
        </p>
      ) : trips.isError && trips.data === undefined ? (
        <p
          role="alert"
          className="border-brand-error text-brand-error bg-background mt-4 rounded-lg border-l-4 p-3 text-base font-medium"
        >
          Your trips could not be loaded. Check your signal, or sign in again.
        </p>
      ) : (
        TABS.map((tab) =>
          tab.bucket !== active ? null : (
            <div
              key={tab.bucket}
              id={`driver-tabpanel-${tab.bucket}`}
              role="tabpanel"
              aria-labelledby={`driver-tab-${tab.bucket}`}
              tabIndex={-1}
            >
              <h2 className="sr-only">{tab.label}</h2>
              {shown.length === 0 ? (
                <p className="text-brand-blue-900 mt-4 text-base">{EMPTY_COPY[tab.bucket]}</p>
              ) : (
                <ol className="mt-4 space-y-2">
                  {shown.map((trip) => (
                    <TripCard key={trip.bookingId} trip={trip} />
                  ))}
                </ol>
              )}
            </div>
          ),
        )
      )}

      {/*
       * Bottom-anchored, `fixed`, and padded for the home indicator. The
       * reservation above (`.pb-driver-tabs-safe`) is what keeps this bar
       * off the last trip in the list.
       */}
      <nav
        aria-label="Trips"
        className="border-border bg-background driver-tabs-safe fixed inset-x-0 bottom-0 z-40 border-t pt-2"
      >
        <div role="tablist" aria-label="Trips" className="mx-auto flex w-full max-w-2xl px-2">
          {TABS.map((tab) => {
            const selected = tab.bucket === active;
            const Icon = tab.icon;
            const count = rows.filter((trip) => trip.bucket === tab.bucket).length;
            return (
              <button
                key={tab.bucket}
                type="button"
                role="tab"
                id={`driver-tab-${tab.bucket}`}
                aria-selected={selected}
                aria-controls={`driver-tabpanel-${tab.bucket}`}
                onClick={() => setActive(tab.bucket)}
                className={`tap-target focus-visible:ring-brand-blue-600 flex h-14 flex-1 flex-col items-center justify-center gap-0.5 rounded-lg border-t-4 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 ${
                  selected
                    ? 'border-brand-blue-700 text-brand-blue-900 font-bold'
                    : 'text-brand-blue-700 border-transparent font-medium'
                }`}
              >
                <Icon className="size-5" aria-hidden="true" />
                <span>
                  {tab.label}
                  {trips.isPending ? '' : ` (${count})`}
                </span>
              </button>
            );
          })}
        </div>
      </nav>
    </div>
  );
}
