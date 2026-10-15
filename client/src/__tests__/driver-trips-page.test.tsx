/**
 * Week 6, Task 10 — the driver's trip list and its three tabs.
 *
 * `server/src/__tests__/driver-trips.test.ts` proves the buckets: that
 * "today" is the Manila civil date and not the UTC one, and that a driver
 * sees their own trips and nobody else's. This file proves the SCREEN:
 * that **one payload feeds three tabs**, that the tab a driver is on is
 * announced and not merely coloured, and that each row leads to its own
 * trip.
 *
 * ## There is no second "what is today" in this suite either
 *
 * The page groups by the `bucket` the SERVER resolved and sent with each
 * row — so the fixtures below carry buckets that deliberately do NOT agree
 * with the machine's clock (a `history` row dated in 2027). If the page
 * ever started computing buckets from the handset, the first test here goes
 * red, which is the only way to keep that honest in a suite that runs on
 * whatever date CI happens to be.
 *
 * ## What jsdom cannot see, and this file therefore does not claim
 *
 * jsdom performs no layout and loads no stylesheet. The tab bar's test
 * asserts that the `fixed`, `bottom-0` and `driver-tabs-safe` classes are
 * PRESENT and that the list reserves room with `pb-driver-tabs-safe` — not
 * that the bar is at the bottom of a 360px viewport, not that it is
 * 56px tall, and not that `env(safe-area-inset-bottom)` resolves to
 * anything. Those are Task 14's walkthrough in a real browser.
 */
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it } from 'vitest';
import DriverTripsPage from '@/pages/driver/DriverTripsPage';
import { TrpcProviders } from '@/lib/trpc';
import { mockTrpc, mockTrpcError, resetTrpcMock } from './helpers/mock-trpc';

afterEach(() => {
  resetTrpcMock();
});

const TRIPS = [
  {
    bookingId: 31,
    ref: 'RG-HIST01',
    tourTitle: 'Bantayan Island Hopping',
    tourDate: '2027-01-04',
    pax: 2,
    status: 'completed',
    vanPlate: 'XYZ 789',
    // Deliberately disagrees with any clock: the SERVER said history.
    bucket: 'history',
  },
  {
    bookingId: 7,
    ref: 'RG-7KQ4M9',
    tourTitle: 'Oslob Whale Shark Watching',
    tourDate: '2026-10-16',
    pax: 4,
    status: 'in_progress',
    vanPlate: 'ABC 123',
    bucket: 'today',
  },
  {
    bookingId: 12,
    ref: 'RG-SOON12',
    tourTitle: 'Kawasan Falls Canyoneering',
    tourDate: '2026-10-19',
    pax: 1,
    status: 'assigned',
    vanPlate: null,
    bucket: 'upcoming',
  },
];

function renderTrips() {
  return render(
    <TrpcProviders>
      <MemoryRouter initialEntries={['/driver']}>
        <Routes>
          <Route path="/driver" element={<DriverTripsPage />} />
          <Route path="/driver/trip/:bookingId" element={<p>one trip</p>} />
        </Routes>
      </MemoryRouter>
    </TrpcProviders>,
  );
}

describe('DriverTripsPage — three tabs from one payload', () => {
  it('shows only the bucket the server put each trip in, and switches on a tap', async () => {
    mockTrpc({ 'driver.trips': TRIPS });
    const user = userEvent.setup();
    renderTrips();

    // Today, by default.
    expect(await screen.findByText('Oslob Whale Shark Watching')).toBeInTheDocument();
    expect(screen.queryByText('Kawasan Falls Canyoneering')).not.toBeInTheDocument();
    expect(screen.queryByText('Bantayan Island Hopping')).not.toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /today/i })).toHaveAttribute('aria-selected', 'true');

    await user.click(screen.getByRole('tab', { name: /upcoming/i }));
    expect(screen.getByText('Kawasan Falls Canyoneering')).toBeInTheDocument();
    expect(screen.queryByText('Oslob Whale Shark Watching')).not.toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /upcoming/i })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tab', { name: /today/i })).toHaveAttribute('aria-selected', 'false');

    await user.click(screen.getByRole('tab', { name: /history/i }));
    expect(screen.getByText('Bantayan Island Hopping')).toBeInTheDocument();
    expect(screen.queryByText('Kawasan Falls Canyoneering')).not.toBeInTheDocument();
  });

  it('counts each bucket in its own tab label', async () => {
    mockTrpc({ 'driver.trips': TRIPS });
    renderTrips();

    expect(await screen.findByRole('tab', { name: 'Today (1)' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Upcoming (1)' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'History (1)' })).toBeInTheDocument();
  });

  it('says so when a tab has nothing in it, rather than showing an empty list', async () => {
    mockTrpc({ 'driver.trips': [TRIPS[1]] });
    const user = userEvent.setup();
    renderTrips();

    await screen.findByText('Oslob Whale Shark Watching');
    await user.click(screen.getByRole('tab', { name: /upcoming/i }));
    expect(screen.getByText(/no trips booked in for you yet/i)).toBeInTheDocument();

    await user.click(screen.getByRole('tab', { name: /today/i }));
    expect(screen.getByText('Oslob Whale Shark Watching')).toBeInTheDocument();
  });

  it('gives each trip its date, group size, plate, reference and state in words', async () => {
    mockTrpc({ 'driver.trips': TRIPS });
    renderTrips();

    const row = (await screen.findByText('Oslob Whale Shark Watching')).closest('a')!;
    expect(within(row).getByText(/4 guests/)).toBeInTheDocument();
    expect(within(row).getByText(/ABC 123/)).toBeInTheDocument();
    expect(within(row).getByText(/RG-7KQ4M9/)).toBeInTheDocument();
    // The status is WORDS, never a raw enum value.
    expect(within(row).getByText(/Under way/)).toBeInTheDocument();
    expect(row).toHaveAttribute('href', '/driver/trip/7');
  });

  it('opens one trip when its row is tapped', async () => {
    mockTrpc({ 'driver.trips': TRIPS });
    const user = userEvent.setup();
    renderTrips();

    await user.click(await screen.findByText('Oslob Whale Shark Watching'));
    expect(await screen.findByText('one trip')).toBeInTheDocument();
  });

  it('shows a calm sentence when the list cannot be loaded', async () => {
    mockTrpcError('driver.trips', 'UNAUTHORIZED', 'UNAUTHORIZED');
    renderTrips();

    // `retry: 1` in `makeQueryClient`, so the failure settles after a
    // backoff — the same 3s window the other query-error tests allow.
    expect(await screen.findByRole('alert', {}, { timeout: 3000 })).toHaveTextContent(
      /trips could not be loaded.*sign in again/i,
    );
  });
});

describe('DriverTripsPage — a bar one thumb can reach', () => {
  /**
   * Class presence only. jsdom cannot measure a box or resolve
   * `env(safe-area-inset-bottom)`; what it CAN prove is that the bar is
   * fixed to the bottom with the safe-area utility on it and that the list
   * reserves room for it, which is the pairing BUG-079 was about.
   */
  it('anchors the tabs to the bottom with the safe-area utilities on both halves', async () => {
    mockTrpc({ 'driver.trips': TRIPS });
    renderTrips();

    await screen.findByText('Oslob Whale Shark Watching');

    const bar = screen.getByRole('navigation', { name: /trips/i });
    const barClasses = bar.className.split(/\s+/);
    expect(barClasses).toContain('fixed');
    expect(barClasses).toContain('bottom-0');
    expect(barClasses).toContain('driver-tabs-safe');

    // The reservation, without which the bar sits over the last trip.
    const page = bar.parentElement!;
    expect(page.className.split(/\s+/)).toContain('pb-driver-tabs-safe');
  });

  it('puts the 44px floor utility and the 56px height on all three tabs', async () => {
    mockTrpc({ 'driver.trips': TRIPS });
    renderTrips();

    const tabs = await screen.findAllByRole('tab');
    expect(tabs).toHaveLength(3);
    for (const tab of tabs) {
      const classes = tab.className.split(/\s+/);
      expect(classes).toContain('tap-target');
      expect(classes).toContain('h-14');
    }
  });

  /**
   * The selected tab is announced (`aria-selected`) and set apart by weight
   * as well as by colour — colour alone is a WCAG 1.4.1 failure, and this
   * bar is the only navigation a driver has.
   */
  it('marks the selected tab by weight as well as by its colour', async () => {
    mockTrpc({ 'driver.trips': TRIPS });
    renderTrips();

    const today = await screen.findByRole('tab', { name: /today/i });
    const upcoming = screen.getByRole('tab', { name: /upcoming/i });
    expect(today.className).toMatch(/\bfont-bold\b/);
    expect(upcoming.className).not.toMatch(/\bfont-bold\b/);
  });
});
