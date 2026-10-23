/**
 * The dispatch calendar page: a week strip, the selected day's trips and the
 * assign panel for the selected trip.
 *
 * Handlers in `mockTrpc` are keyed by procedure name and are not input-aware,
 * so every `admin.calendar.month` query (the week's month, the week's second
 * month if it crosses one, and the month grid's) answers the same days. The
 * fixture therefore builds the days for the real current Manila week, which
 * is the week the page opens on.
 */
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it } from 'vitest';
import { manilaParts, type CalendarDay, type CalendarTrip } from '@rg/shared';
import AdminCalendarPage from '@/pages/admin/AdminCalendarPage';
import { TrpcProviders } from '@/lib/trpc';
import { mockTrpc, mockTrpcError, resetTrpcMock } from './helpers/mock-trpc';

const user = userEvent;

function civil(offsetDays: number): string {
  const now = manilaParts(new Date());
  const d = new Date(Date.UTC(now.year, now.month - 1, now.day + offsetDays));
  return d.toISOString().slice(0, 10);
}

const TODAY = civil(0);
// The day after today, unless that is next week's Monday: then the day before.
const OTHER_DAY = new Date(`${TODAY}T00:00:00Z`).getUTCDay() === 0 ? civil(-1) : civil(1);

function trip(overrides: Partial<CalendarTrip> & { bookingId: number }): CalendarTrip {
  return {
    ref: `RG-TRIP0${overrides.bookingId}`,
    tourTitle: 'Kawasan Falls Day Trip',
    pax: 4,
    status: 'confirmed',
    vanId: null,
    vanPlate: null,
    driverId: null,
    driverName: null,
    needsAssignment: true,
    awaitingPaymentCheck: false,
    ...overrides,
  };
}

const NEEDS = trip({ bookingId: 1, ref: 'RG-NEEDS1', tourTitle: 'Oslob Whale Sharks' });
const DONE = trip({
  bookingId: 2,
  ref: 'RG-DONE22',
  tourTitle: 'Moalboal Sardines',
  pax: 1,
  status: 'assigned',
  vanId: 10,
  vanPlate: 'ABC 123',
  driverId: 7,
  driverName: 'Maria Santos',
  needsAssignment: false,
});

function day(date: string, trips: CalendarTrip[]): CalendarDay {
  return {
    date,
    trips,
    needsAssignmentCount: trips.filter((t) => t.needsAssignment).length,
  };
}

/** Today carries both trips; another day this week carries one assigned trip; the rest are empty. */
function week(): CalendarDay[] {
  return [day(TODAY, [DONE, NEEDS]), day(OTHER_DAY, [{ ...DONE, bookingId: 3, ref: 'RG-NEXT33' }])];
}

function renderPage(role: 'owner' | 'dispatcher' | 'finance' = 'dispatcher') {
  mockTrpc({
    'staffAuth.me': { role },
    'admin.calendar.month': { days: week() },
    'admin.calendar.dayOptions': { vans: [], drivers: [] },
  });
  return render(
    <TrpcProviders>
      <MemoryRouter>
        <AdminCalendarPage />
      </MemoryRouter>
    </TrpcProviders>,
  );
}

afterEach(resetTrpcMock);

describe('AdminCalendarPage', () => {
  it('opens on a seven-day strip and states each day in words', async () => {
    renderPage();
    const strip = await screen.findByRole('list', { name: /this week/i });
    expect(within(strip).getAllByRole('button')).toHaveLength(7);

    const todayButton = within(strip).getByRole('button', {
      name: /2 trips, 1 need a van or driver/i,
    });
    // The caption is in the button's text, not only its colour.
    expect(todayButton.textContent).toMatch(/1 need a van or driver/);
    expect(within(strip).getAllByText(/no trips/i).length).toBeGreaterThan(0);
    expect(within(strip).getByRole('button', { name: /1 trip$/i })).toBeTruthy();
  });

  it('marks the selected day with aria-pressed and starts on today', async () => {
    renderPage();
    const strip = await screen.findByRole('list', { name: /this week/i });
    const pressed = within(strip)
      .getAllByRole('button')
      .filter((button) => button.getAttribute('aria-pressed') === 'true');
    expect(pressed).toHaveLength(1);
    expect(pressed[0]?.getAttribute('aria-label')).toMatch(/2 trips/);
  });

  it('shows the chosen day’s trips, and switches when another day is chosen', async () => {
    renderPage();
    expect(await screen.findAllByTestId('calendar-trip')).toHaveLength(2);

    const strip = screen.getByRole('list', { name: /this week/i });
    await user.click(within(strip).getByRole('button', { name: /1 trip$/i }));

    const cards = await screen.findAllByTestId('calendar-trip');
    expect(cards).toHaveLength(1);
    expect(cards[0]?.textContent).toMatch(/RG-NEXT33/);
  });

  it('says what each trip still needs, in words', async () => {
    renderPage();
    const cards = await screen.findAllByTestId('calendar-trip');
    const needs = cards.find((card) => card.textContent?.includes('RG-NEEDS1'));
    const done = cards.find((card) => card.textContent?.includes('RG-DONE22'));
    expect(needs?.textContent).toMatch(/needs assignment/i);
    expect(done?.textContent).toMatch(/assigned/i);
    expect(done?.textContent).toMatch(/ABC 123/);
    expect(done?.textContent).toMatch(/Maria Santos/);
    expect(done?.textContent).toMatch(/1 guest\b/);
  });

  it('opens the assign panel on the first trip that needs one, and follows the selection', async () => {
    renderPage();
    const panel = await screen.findByTestId('assign-panel');
    expect(panel.parentElement?.textContent).toMatch(/RG-NEEDS1/);

    await user.click(
      within(
        (await screen.findAllByTestId('calendar-trip')).find((card) =>
          card.textContent?.includes('RG-DONE22'),
        ) as HTMLElement,
      ).getByRole('button'),
    );
    await waitFor(() =>
      expect(screen.getByTestId('assign-panel').parentElement?.textContent).toMatch(/RG-DONE22/),
    );
  });

  it('shows finance the calendar but no assign panel', async () => {
    renderPage('finance');
    expect(await screen.findAllByTestId('calendar-trip')).toHaveLength(2);
    await waitFor(() => expect(screen.queryByTestId('assign-panel')).toBeNull());
    // Nor the "For RG-… " heading that introduces it.
    expect(screen.queryByText(/^For\s/)).toBeNull();
  });

  it('moves the strip a week at a time', async () => {
    renderPage();
    await screen.findByRole('list', { name: /this week/i });
    await user.click(screen.getByRole('button', { name: /next week/i }));

    // The fixture has no days next week: every day reads "no trips", and no
    // day is selected until one is chosen.
    const strip = screen.getByRole('list', { name: /this week/i });
    expect(within(strip).getAllByText(/no trips/i)).toHaveLength(7);
    expect(screen.queryAllByTestId('calendar-trip')).toHaveLength(0);

    await user.click(screen.getByRole('button', { name: /previous week/i }));
    expect(
      within(screen.getByRole('list', { name: /this week/i })).getByRole('button', {
        name: /2 trips/i,
      }),
    ).toBeTruthy();
  });

  it('says so when the calendar cannot load', async () => {
    mockTrpc({ 'staffAuth.me': { role: 'dispatcher' } });
    mockTrpcError('admin.calendar.month', 'INTERNAL_SERVER_ERROR', 'down');
    render(
      <TrpcProviders>
        <MemoryRouter>
          <AdminCalendarPage />
        </MemoryRouter>
      </TrpcProviders>,
    );
    const alerts = await screen.findAllByRole('alert');
    expect(alerts[0]?.textContent).toMatch(/could not load the calendar/i);
    // A failed load must not draw a strip of seven empty "No trips" days.
    expect(screen.queryByRole('list', { name: /this week/i })).toBeNull();
  });

  it('keeps the whole month a disclosure away', async () => {
    renderPage();
    await screen.findByRole('list', { name: /this week/i });
    expect(screen.getByText(/show the whole month/i)).toBeTruthy();
    expect(screen.getByRole('button', { name: /previous month/i })).toBeTruthy();
  });
});
