/**
 * Week 7 plan, Task 2: the public tour detail page (`/tours/:slug`).
 *
 * Three rules this page exists to keep straight:
 *  - `checkout.availability` and `checkout.quote` are two different
 *    questions. `BookingPicker` asks availability FIRST, and only calls
 *    `checkout.quote` once that answers `{ ok: true }` — never the reverse,
 *    and never both at once on a refused date (see the "refuses to show a
 *    total" test below).
 *  - The tier table is information (admin-set per-person prices), never a
 *    quote — nothing on this page multiplies a tier price by a head count.
 *  - "Book this tour" is a plain `<Link>` to `/checkout/:slug`, never a
 *    mutation — browsing this page must not create a hold.
 */
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import TourDetailPage from '@/pages/public/TourDetailPage';
import { TrpcProviders } from '@/lib/trpc';
import type { TourDetail } from '../../../server/src/routers/public/tours';
import { SETTINGS_FIXTURE } from './helpers/fixtures';
import { mockTrpc } from './helpers/mock-trpc';

const TOUR_DETAIL_FIXTURE: TourDetail = {
  id: 6,
  slug: 'oslob-whale-sharks',
  title: 'Oslob Whale Sharks + Tumalog Falls',
  destination: { id: 6, name: 'Oslob', slug: 'oslob' },
  image: {
    path: '/placeholders/oslob.svg',
    alt: 'A whale shark gliding beneath the boat at sunrise',
    width: 1200,
    height: 800,
  },
  fromPriceCentavos: 160_000,
  durationHours: 14,
  rating: null,
  bookedThisWeek: 0,
  tripsRun: null,
  freeCancellation: true,
  badge: 'none',
  alertNote: null,
  isFeatured: true,
  about: 'Swim beside gentle whale sharks at sunrise, then cool off under Tumalog Falls.',
  inclusions: ['Hotel pickup and drop-off', 'Snorkel gear', 'Breakfast'],
  exclusions: ['Personal expenses', 'Underwater camera rental'],
  images: [
    {
      path: '/placeholders/oslob-1.svg',
      alt: 'A whale shark gliding beneath the boat at sunrise',
      width: 1200,
      height: 800,
    },
    {
      path: '/placeholders/oslob-2.svg',
      alt: 'Guests snorkelling beside a whale shark in Oslob',
      width: 1200,
      height: 800,
    },
    {
      path: '/placeholders/oslob-3.svg',
      alt: 'Tumalog Falls cascading into a turquoise pool',
      width: 1200,
      height: 800,
    },
  ],
  priceTiers: [
    { minPax: 1, maxPax: 3, pricePerPersonCentavos: 200_000 },
    { minPax: 4, maxPax: 6, pricePerPersonCentavos: 180_000 },
    { minPax: 7, maxPax: 10, pricePerPersonCentavos: 160_000 },
  ],
  itinerary: [
    {
      name: 'Hotel pickup',
      description: 'We collect you from your Cebu City hotel.',
      sortOrder: 0,
    },
    {
      name: 'Oslob whale shark swim',
      description: 'Snorkel beside whale sharks at sunrise.',
      sortOrder: 1,
    },
    { name: 'Tumalog Falls', description: 'Cool off under a limestone waterfall.', sortOrder: 2 },
  ],
  addons: [{ id: 4, name: 'GoPro rental', priceCentavos: 50_000, perPerson: false }],
  // Deliberately below the server's own 12-guest ceiling, so a clamp that
  // forgot `tour.maxGuests` and just used 12 would still pass by accident.
  maxGuests: 10,
  freeCancelHours: 24,
  seoTitle: null,
  seoDescription: null,
  ogImage: null,
};

function detail(overrides: Partial<TourDetail> = {}): TourDetail {
  return { ...TOUR_DETAIL_FIXTURE, ...overrides };
}

function renderDetail(entry = '/tours/oslob-whale-sharks') {
  return render(
    <TrpcProviders>
      <MemoryRouter initialEntries={[entry]}>
        <Routes>
          <Route path="/tours/:slug" element={<TourDetailPage />} />
        </Routes>
      </MemoryRouter>
    </TrpcProviders>,
  );
}

describe('TourDetailPage — itinerary', () => {
  it('shows the itinerary stops in the server order', async () => {
    mockTrpc({ 'tours.bySlug': () => detail(), 'settings.get': SETTINGS_FIXTURE });
    renderDetail();

    await screen.findByText('Hotel pickup');
    // Scoped to the itinerary list itself: the page's own title ends in
    // "Tumalog Falls" and the About paragraph repeats it too, so a
    // whole-page text search would find the LAST stop's name before the
    // itinerary even renders it — this is a test of the itinerary's own
    // order, not of where "Tumalog Falls" first appears on the page.
    const list = screen.getByRole('list', { name: /itinerary/i });
    const text = list.textContent ?? '';
    const pickupIndex = text.indexOf('Hotel pickup');
    const whaleIndex = text.indexOf('Oslob whale shark swim');
    const fallsIndex = text.indexOf('Tumalog Falls');

    expect(pickupIndex).toBeGreaterThan(-1);
    expect(pickupIndex).toBeLessThan(whaleIndex);
    expect(whaleIndex).toBeLessThan(fallsIndex);
  });
});

describe('TourDetailPage — price tier table', () => {
  it('shows the tier table as information, not as a quote', async () => {
    mockTrpc({ 'tours.bySlug': () => detail(), 'settings.get': SETTINGS_FIXTURE });
    renderDetail();

    // Every tier's own per-person price, rendered verbatim.
    expect(await screen.findByText('₱2,000')).toBeInTheDocument();
    expect(screen.getByText('₱1,800')).toBeInTheDocument();
    expect(screen.getByText('₱1,600')).toBeInTheDocument();

    // No date or party size was chosen (no ?date=&pax= in the URL), so
    // nothing asked the server for a quote, and no total appears anywhere.
    expect(screen.queryByText(/total/i)).not.toBeInTheDocument();
  });
});

describe('TourDetailPage — booking picker asks the server for a price', () => {
  it('asks the SERVER for the price once a date and party size are chosen', async () => {
    let quoteCalls = 0;
    mockTrpc({
      'tours.bySlug': () => detail(),
      'settings.get': SETTINGS_FIXTURE,
      'checkout.availability': () => ({ ok: true }),
      'checkout.quote': () => {
        quoteCalls += 1;
        return { totalCentavos: 540_000, depositCentavos: 162_000 };
      },
    });
    renderDetail('/tours/oslob-whale-sharks?date=2026-11-02&pax=3');

    expect(await screen.findByText('₱5,400')).toBeInTheDocument();
    expect(quoteCalls).toBeGreaterThan(0);
  });

  /**
   * The load-bearing negative case: a refused date must never let
   * `checkout.quote` run at all — the two are separate questions with
   * separate jobs (see `checkout.ts`'s own module note), and conflating
   * them would mean the picker could show a price for a date `createHold`
   * is about to refuse.
   */
  it('refuses to show a total when the server could not quote one', async () => {
    let quoteCalls = 0;
    mockTrpc({
      'tours.bySlug': () => detail(),
      'settings.get': SETTINGS_FIXTURE,
      'checkout.availability': () => ({ ok: false, reason: 'date_blocked' }),
      'checkout.quote': () => {
        quoteCalls += 1;
        return { totalCentavos: 999_999 };
      },
    });
    renderDetail('/tours/oslob-whale-sharks?date=2026-11-02&pax=3');

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/not running on this date/i);

    // No booking TOTAL anywhere — scoped to the total summary block
    // specifically, not the whole picker: the tier table elsewhere on the
    // page, and this tour's own add-on checkbox, both legitimately show
    // "₱" figures of their own (informational, never a quote — see the
    // tier-table test above), and this test is about the live booking
    // total, not either of those.
    expect(screen.queryByTestId('booking-total')).not.toBeInTheDocument();

    // A grace period for a wrongly-fired query to reach the mock before
    // asserting its absence — same pattern checkout-page.test.tsx uses.
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(quoteCalls).toBe(0);
  });
});

describe('TourDetailPage — books through to checkout', () => {
  it('books through to the checkout with the chosen date, party size and add-ons', async () => {
    mockTrpc({
      'tours.bySlug': () => detail(),
      'settings.get': SETTINGS_FIXTURE,
      'checkout.availability': () => ({ ok: true }),
      'checkout.quote': () => ({ totalCentavos: 540_000 }),
    });
    const user = userEvent.setup();
    renderDetail('/tours/oslob-whale-sharks?date=2026-11-02&pax=3');

    const checkbox = await screen.findByRole('checkbox', { name: /gopro/i });
    await user.click(checkbox);

    await waitFor(() => {
      expect(screen.getByRole('link', { name: /book this tour/i })).toHaveAttribute(
        'href',
        '/checkout/oslob-whale-sharks?date=2026-11-02&pax=3&addons=4',
      );
    });
  });
});

describe('TourDetailPage — booking window and guest cap (corrections 2 & 3)', () => {
  it("bounds the date input by the server's booking window, and the guest input by min(maxGuests, 12)", async () => {
    mockTrpc({ 'tours.bySlug': () => detail(), 'settings.get': SETTINGS_FIXTURE });
    renderDetail();

    // Exact-text matches, not /date/i or /guests/i — a gallery thumbnail's
    // own aria-label ("View photo 2 of 3: Guests snorkelling beside a
    // whale shark...") also contains the substring "Guests" and would
    // otherwise match too.
    const dateInput = await screen.findByLabelText('Date');
    // `settings.get` resolves asynchronously, same as the real app — the
    // input exists before that, with no min/max yet.
    await waitFor(() =>
      expect(dateInput).toHaveAttribute('min', SETTINGS_FIXTURE.bookingWindow.earliest),
    );
    expect(dateInput).toHaveAttribute('max', SETTINGS_FIXTURE.bookingWindow.latest);

    // TOUR_DETAIL_FIXTURE.maxGuests is 10 — below the server's outer
    // ceiling of 12 — so a clamp that only checked the fixed 12 would make
    // this fail.
    const guestsInput = screen.getByLabelText('Guests');
    expect(guestsInput).toHaveAttribute('max', '10');
  });
});

describe('TourDetailPage — gallery accessibility', () => {
  it('gives every gallery image alt text', async () => {
    mockTrpc({ 'tours.bySlug': () => detail(), 'settings.get': SETTINGS_FIXTURE });
    const { container } = renderDetail();

    await screen.findByText('Hotel pickup');
    const images = within(container).getAllByRole('img', { hidden: true }) as HTMLImageElement[];
    const imgTags = container.querySelectorAll('img');
    expect(imgTags.length).toBeGreaterThan(0);
    imgTags.forEach((img) => {
      expect(img.getAttribute('alt')).toBeTruthy();
    });
    // getAllByRole above is unused for the assertion itself (an <img> with
    // alt="" would not appear in it at all) — kept only to document that
    // these really are accessible images, not decorative ones with an
    // intentionally empty alt.
    expect(images.length).toBeGreaterThan(0);
  });
});
