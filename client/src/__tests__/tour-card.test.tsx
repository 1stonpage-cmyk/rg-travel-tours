import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import TourCard from '@/components/common/TourCard';
import { TOURS_FIXTURE } from './helpers/fixtures';

const tour = TOURS_FIXTURE[0]!;
const show = (t = tour) =>
  render(
    <MemoryRouter>
      <TourCard tour={t} />
    </MemoryRouter>,
  );

describe('TourCard', () => {
  it('shows the from-price formatted from centavos', () => {
    show();
    expect(screen.getByText(/₱1,890/)).toBeInTheDocument();
  });

  it('hides "booked this week" at zero', () => {
    show({ ...tour, bookedThisWeek: 0 });
    expect(screen.queryByText(/booked/i)).not.toBeInTheDocument();
  });

  it('hides the trips-run line when the count is null', () => {
    show({ ...tour, tripsRun: null });
    expect(screen.queryByText(/trips run/i)).not.toBeInTheDocument();
  });

  it('shows both counters once they carry real numbers', () => {
    show({ ...tour, bookedThisWeek: 7, tripsRun: 412 });
    expect(screen.getByText(/booked 7/i)).toBeInTheDocument();
    expect(screen.getByText(/412 trips run/i)).toBeInTheDocument();
  });

  it('omits the rating block entirely when a tour has no reviews', () => {
    show({ ...tour, rating: null });
    expect(screen.queryByText(/\(\d+\)/)).not.toBeInTheDocument();
  });

  it('shows a "New" badge in place of the star rating when rating is null', () => {
    show({ ...tour, rating: null });
    expect(screen.getByText('New')).toBeInTheDocument();
  });

  it('shows the star rating and count instead of "New" once rating is populated', () => {
    show(); // tour fixture carries a populated rating (average 4.9, count 68)
    expect(screen.getByText(/\(68\)/)).toBeInTheDocument();
    expect(screen.queryByText('New')).not.toBeInTheDocument();
  });

  it('renders the per-tour alert note and badge when set', () => {
    show({ ...tour, badge: 'best_seller', alertNote: 'Sea conditions permitting.' });
    expect(screen.getByText(/best seller/i)).toBeInTheDocument();
    expect(screen.getByText(/sea conditions permitting/i)).toBeInTheDocument();
  });

  // Task 2C: ToursPage forwards the hero search's date/guests onto each
  // card as `searchParams` (renamed `date`/`pax`), appended to BOTH of
  // TourCard's internal links. Omitting the prop (every other `show()` in
  // this file) must stay byte-identical to the plain `/tours/<slug>` href —
  // that is what the rest of this suite already proves without asserting
  // on `href` directly, so this is the one case that needs to.
  it('appends searchParams to both links when given, and leaves them bare when omitted', () => {
    const withParams = render(
      <MemoryRouter>
        <TourCard tour={tour} searchParams="date=2026-11-02&pax=4" />
      </MemoryRouter>,
    );
    const expectedHref = `/tours/${tour.slug}?date=2026-11-02&pax=4`;
    expect(screen.getByRole('heading', { level: 3 }).querySelector('a')).toHaveAttribute(
      'href',
      expectedHref,
    );
    expect(screen.getByRole('link', { name: /view tour/i })).toHaveAttribute('href', expectedHref);
    withParams.unmount();

    show(); // no searchParams — both links must stay the bare slug URL.
    const bareLinks = screen.getAllByRole('link');
    expect(bareLinks).toHaveLength(2);
    for (const link of bareLinks) {
      expect(link.getAttribute('href')).toBe(`/tours/${tour.slug}`);
    }
  });
});
