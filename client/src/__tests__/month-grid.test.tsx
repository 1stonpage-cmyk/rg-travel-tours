/**
 * `MonthGrid` (Week 5 "Dispatch" plan, Task 9; BUILD_SPEC §5C / §9
 * "Calendar", client half).
 *
 * ## Why this file renders `MonthGrid` directly, with no `TrpcProviders`
 * and no `MemoryRouter`
 *
 * The task brief's test-rendering note asks every test file to wrap its
 * subject in `TrpcProviders` (and a router, if the component links)
 * following `admin-bookings.test.tsx` — but that note exists because MOST
 * admin screens call `trpc.*` hooks themselves. `MonthGrid` deliberately
 * does neither: its props are `{ days, selected, onSelect }` (plain data in,
 * a callback out), with no `trpc.useQuery` and no `<Link>`/`<NavLink>`/router
 * hook anywhere in it — `AdminCalendarPage` owns the query and hands this
 * component already-resolved data, exactly so the grid can be tested
 * without a query client (the brief's own interface note). Wrapping a
 * Provider-free, router-free component in either would add nothing a test
 * here could observe; per the brief's own rule, the decision is made per
 * component rather than copied by default, and is recorded here rather than
 * assumed silently.
 */
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import type { CalendarDay, CalendarTrip } from '@rg/shared';
import MonthGrid from '@/components/admin/MonthGrid';

const user = userEvent.setup();
const noop = () => {};

function trip(
  overrides: Partial<CalendarTrip> & Pick<CalendarTrip, 'bookingId' | 'ref'>,
): CalendarTrip {
  return {
    tourTitle: 'Oslob Whale Shark Watching',
    pax: 2,
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

/** Staffed: `needsAssignment: false` — a van AND a driver are already on it. */
const TRIP_STAFFED: CalendarTrip = trip({
  bookingId: 30,
  ref: 'RG-STAFF01',
  status: 'assigned',
  vanId: 1,
  vanPlate: 'ABC1234',
  driverId: 1,
  driverName: 'Jun Reyes',
  needsAssignment: false,
});

function emptyDay(day: number): CalendarDay {
  return { date: `2026-11-${String(day).padStart(2, '0')}`, trips: [], needsAssignmentCount: 0 };
}

/**
 * Every civil day of November 2026 (30 days — the server's own contract:
 * "every day of the requested month", never only the days with trips), with
 * day 10 carrying 3 trips, 2 of which need assignment. November 2026 starts
 * on a Sunday, which is why the padding test below always has leading pads
 * once the week starts Monday.
 */
const DAYS: CalendarDay[] = Array.from({ length: 30 }, (_, i) => emptyDay(i + 1));
DAYS[9] = {
  date: '2026-11-10',
  trips: [
    trip({ bookingId: 20, ref: 'RG-NEED0001', needsAssignment: true }),
    trip({ bookingId: 21, ref: 'RG-NEED0002', needsAssignment: true }),
    trip({
      bookingId: 22,
      ref: 'RG-OK00001',
      status: 'assigned',
      vanId: 2,
      vanPlate: 'XYZ5678',
      driverId: 2,
      driverName: 'Ana Cruz',
      needsAssignment: false,
    }),
  ],
  needsAssignmentCount: 2,
};

describe('MonthGrid', () => {
  it('names each day cell in text, not by colour', () => {
    render(<MonthGrid days={DAYS} selected={null} onSelect={noop} />);
    const cell = screen.getByRole('gridcell', { name: /10 November, 3 trips, 2 need assignment/i });
    expect(cell).toBeTruthy();
  });

  it('shows the needs-assignment count as a numeral beside the dot', () => {
    render(<MonthGrid days={DAYS} selected={null} onSelect={noop} />);
    const cell = screen.getByRole('gridcell', { name: /10 November/i });
    expect(cell.textContent).toMatch(/\b2\b/);
  });

  it('marks a day with no unstaffed trips without any dot at all', () => {
    render(
      <MonthGrid
        days={[{ date: '2026-11-04', trips: [TRIP_STAFFED], needsAssignmentCount: 0 }]}
        selected={null}
        onSelect={noop}
      />,
    );
    expect(document.querySelector('[data-testid="needs-assignment-dot"]')).toBeNull();
  });

  it('keeps exactly one tab stop in the grid', () => {
    render(<MonthGrid days={DAYS} selected="2026-11-10" onSelect={noop} />);
    const focusable = screen
      .getAllByRole('gridcell')
      .filter((c) => c.getAttribute('tabindex') === '0');
    expect(focusable).toHaveLength(1);
    expect(focusable[0]!.getAttribute('aria-selected')).toBe('true');
  });

  it('moves selection with the arrow keys', async () => {
    const picked: string[] = [];
    render(<MonthGrid days={DAYS} selected="2026-11-10" onSelect={(d) => picked.push(d)} />);
    const cell = screen.getByRole('gridcell', { name: /10 November/i });
    cell.focus();
    await user.keyboard('{ArrowRight}');
    expect(picked).toEqual(['2026-11-11']);
  });

  it('does not make adjacent-month padding cells reachable', () => {
    render(<MonthGrid days={DAYS} selected={null} onSelect={noop} />);
    const pads = document.querySelectorAll('[data-testid="pad-cell"]');

    // VACUITY GUARD, and it is load-bearing here. A `for` loop over an empty
    // NodeList asserts nothing and passes — so if the component ever stopped
    // emitting pad cells (or renamed the testid), this test would go green
    // while checking zero elements. November 2026 starts on a Sunday and the
    // week starts Monday, so there are always leading pads; the exact count
    // depends on whether the grid renders five week rows or six, which is the
    // component's choice and not something this test should pin.
    expect(pads.length).toBeGreaterThan(0);

    for (const pad of pads) {
      expect(pad.getAttribute('aria-hidden')).toBe('true');
      expect(pad.getAttribute('tabindex')).toBeNull();
      // A pad cell with a date in it is a cell a dispatcher will try to click.
      expect(pad.textContent?.trim()).toBe('');
    }
  });
});
