import { DATE_BLOCKED, DATE_NOT_BOOKABLE, formatPeso } from '@rg/shared';
import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { trpc } from '@/lib/trpc';
import type { TourDetail } from '../../../../server/src/routers/public/tours';

/**
 * Only the three fields this component actually reads, via `Pick` rather
 * than the full `TourDetail` — `inclusions`/`exclusions` are typed
 * `unknown` there and arrive OPTIONAL on the client after the JSON round
 * trip (no transformer; see `helpers/fixtures.ts`'s note on this), so a
 * prop typed as the whole interface would reject the real inferred value
 * `TourDetailPage` hands it even though this component never looks at
 * either field.
 */
type Props = { tour: Pick<TourDetail, 'slug' | 'maxGuests' | 'addons'> };

/**
 * `checkout.availability`'s advisory verdicts, worded for a guest — never a
 * raw wire reason code. The two date reasons are keyed off the shared
 * constants (`@rg/shared`) so a future rename of either fails this file at
 * compile time rather than silently falling through to the generic
 * fallback; the four capacity reasons have no shared-constant vocabulary on
 * the client today, so they are literal strings here, each with its own
 * sentence (distinct from CheckoutPage.tsx's later, authoritative banner,
 * which collapses all four capacity reasons into one fallback sentence —
 * this is an earlier, browse-time hint and can afford to be more specific).
 */
const AVAILABILITY_MESSAGES: Record<string, string> = {
  tour_unavailable: 'Not bookable right now.',
  tour_sold_out: 'Fully booked for this date.',
  no_van_available: 'No vehicle or driver free that day.',
  no_driver_available: 'No vehicle or driver free that day.',
  [DATE_NOT_BOOKABLE]: 'Outside the booking window.',
  [DATE_BLOCKED]: 'Not running on this date.',
};
const FALLBACK_MESSAGE = 'Not available for that date.';

function describeAvailability(reason: string): string {
  return AVAILABILITY_MESSAGES[reason] ?? FALLBACK_MESSAGE;
}

/** Clamps to [1, max], tolerating a blank or non-numeric field while typing. */
function clampPax(raw: number, max: number): number {
  if (!Number.isFinite(raw) || raw < 1) return 1;
  return Math.min(Math.trunc(raw), max);
}

/**
 * Date + party size + add-ons, and the live price summary — Week 7 plan,
 * Task 2. **This component computes no money.** It asks the server two
 * separate questions in order: `checkout.availability` first (can this date
 * even be booked), and only once that answers `{ ok: true }` does it ask
 * `checkout.quote` for a price. A refused date shows its own amber sentence
 * and never reaches `checkout.quote` at all — conflating the two would let
 * this page show a price for a date `createHold` is about to refuse.
 *
 * "Book this tour" is a plain `<Link>` to `/checkout/:slug`, never a
 * mutation (owner decision, Q8) — browsing this page must not create a
 * hold. The checkout page re-asks both questions itself before it ever
 * holds anything.
 */
export default function BookingPicker({ tour }: Props) {
  const [searchParams] = useSearchParams();
  // §5's outer ceiling (`quoteInput.pax` is `.max(12)`) is a hard server
  // limit no tour may exceed; `tour.maxGuests` can be lower than that, and
  // the smaller of the two is this tour's real cap.
  const maxPax = Math.min(tour.maxGuests, 12);

  const [date, setDate] = useState(searchParams.get('date') ?? '');
  const [pax, setPax] = useState(() => clampPax(Number(searchParams.get('pax') ?? '1'), maxPax));
  const [addonIds, setAddonIds] = useState<number[]>([]);

  const settingsQuery = trpc.settings.get.useQuery();
  const hasSelection = date !== '' && pax >= 1;

  const availabilityQuery = trpc.checkout.availability.useQuery(
    { tourSlug: tour.slug, date, pax },
    { enabled: hasSelection, retry: false },
  );
  const available = availabilityQuery.data?.ok === true;

  // Enabled ONLY once availability has answered ok — never alongside it,
  // and never at all while it is pending or refused.
  const quoteQuery = trpc.checkout.quote.useQuery(
    { tourSlug: tour.slug, date, pax, addonIds },
    { enabled: hasSelection && available, retry: false },
  );

  function toggleAddon(id: number) {
    setAddonIds((current) =>
      current.includes(id) ? current.filter((existing) => existing !== id) : [...current, id],
    );
  }

  const bookHref = `/checkout/${tour.slug}?date=${date}&pax=${pax}&addons=${addonIds.join(',')}`;

  return (
    <div
      role="region"
      aria-labelledby="booking-picker-heading"
      className="border-brand-blue-200 bg-background space-y-5 rounded-2xl border p-4 sm:p-6"
    >
      <h2 id="booking-picker-heading" className="text-brand-blue-900 text-lg font-bold">
        Book this tour
      </h2>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="booking-date">Date</Label>
          <Input
            id="booking-date"
            type="date"
            min={settingsQuery.data?.bookingWindow.earliest}
            max={settingsQuery.data?.bookingWindow.latest}
            value={date}
            onChange={(event) => setDate(event.target.value)}
            className="tap-target"
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="booking-pax">Guests</Label>
          <Input
            id="booking-pax"
            type="number"
            inputMode="numeric"
            min={1}
            max={maxPax}
            value={pax}
            onChange={(event) => setPax(clampPax(Number(event.target.value), maxPax))}
            className="tap-target"
          />
        </div>
      </div>

      {tour.addons.length > 0 && (
        <fieldset className="space-y-2">
          <legend className="text-brand-blue-900 text-sm font-semibold">Add-ons</legend>
          {tour.addons.map((addon) => (
            <label key={addon.id} className="tap-target flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={addonIds.includes(addon.id)}
                onChange={() => toggleAddon(addon.id)}
                className="border-brand-blue-300 size-4 rounded"
              />
              <span>
                {addon.name} — {formatPeso(addon.priceCentavos)}
                {addon.perPerson ? ' / person' : ''}
              </span>
            </label>
          ))}
        </fieldset>
      )}

      {hasSelection && availabilityQuery.data && !availabilityQuery.data.ok && (
        <p
          role="alert"
          className="border-brand-warning/30 bg-brand-gold-100 text-brand-gold-800 rounded-xl border p-3 text-sm font-medium"
        >
          {describeAvailability(availabilityQuery.data.reason)}
        </p>
      )}

      {hasSelection && available && quoteQuery.data && (
        <div data-testid="booking-total" className="bg-brand-blue-50 rounded-xl p-4">
          <p className="text-muted-foreground text-sm">
            Total for {pax} guest{pax === 1 ? '' : 's'}
          </p>
          <p className="text-brand-blue-900 text-2xl font-bold">
            {formatPeso(quoteQuery.data.totalCentavos)}
          </p>
        </div>
      )}

      {hasSelection ? (
        <Button asChild size="lg" className="tap-target w-full">
          <Link to={bookHref}>Book this tour</Link>
        </Button>
      ) : (
        <Button type="button" size="lg" className="tap-target w-full" disabled>
          Choose a date to continue
        </Button>
      )}
    </div>
  );
}
