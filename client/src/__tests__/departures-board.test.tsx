/**
 * Week 6, Task 12 (6D) — the departures board on the admin dashboard
 * (BUILD_SPEC §9 "Dashboard: today's departures with stop-by-stop progress
 * bars").
 *
 * What is asserted here, and what cannot be:
 *
 *  - **The numbers are words.** `3 of 7 stops`, read out of the DOM. The
 *    bar beside it is `aria-hidden` and carries only a class — jsdom does
 *    no layout, so its WIDTH is unverifiable here and this file never
 *    claims one. What it can check is that the fill exists, is painted with
 *    a brand token, and is hidden from assistive technology because the
 *    sentence already said it.
 *  - **It really polls.** Asserted by COUNTING fetches against a short
 *    `pollMs`, not by reading `DEPARTURES_POLL_MS` off the module and
 *    congratulating it. The constant is checked separately, since a test
 *    cannot wait fifteen real seconds and faking React Query's own
 *    scheduler proves less than this does.
 *  - **A refresh does not replace the board.** The busy state is
 *    `aria-busy` on the region; the rows stay. Asserted in both directions
 *    — busy while a fetch is in flight, not busy once it has landed.
 *  - **Tap targets and contrast** are class assertions only. jsdom
 *    computes no sizes and no colours, so "44px" here means "the
 *    `tap-target` utility is applied", and the palette is enforced for
 *    real by `no-red.test.ts` and `contrast.test.ts`, which read source.
 *
 * Colour assertions are POSITIVE (`bg-brand-blue-600` is present) rather
 * than negative: shadcn's vendored tokens carry `destructive`, so a
 * negative regex over `className` reports on the vendor rather than on this
 * panel. The project-wide prohibition lives in the guard that reads real
 * source — including this file's own test names.
 */
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it } from 'vitest';
import type { TodayDeparture, TripProgress, TripProgressStop } from '@rg/shared';
import DeparturesBoard, { DEPARTURES_POLL_MS } from '@/components/admin/DeparturesBoard';
import { TrpcProviders } from '@/lib/trpc';
import { mockTrpc, mockTrpcError, resetTrpcMock } from './helpers/mock-trpc';

const PROCEDURE = 'admin.departures.today';

function stop(
  name: string,
  stopId: number | null,
  checkedAt: string | null,
  undone = false,
): TripProgressStop {
  return { stopId, name, sortOrder: stopId ?? 0, checkedAt, undone };
}

/** `done` is derived, exactly as the server derives it: checked and not retracted. */
function progressOf(stops: TripProgressStop[]): TripProgress {
  return {
    bookingId: 1,
    status: 'in_progress',
    stops,
    done: stops.filter((s) => s.checkedAt !== null && !s.undone).length,
    total: stops.length,
  };
}

/** Trip start plus `count` named stops, the first `reached` of them ticked. */
function itinerary(count: number, reached: number): TripProgressStop[] {
  const stops: TripProgressStop[] = [
    stop('Start trip', null, reached > 0 ? '2026-10-16T01:45:00.000Z' : null),
  ];
  for (let i = 1; i <= count; i += 1) {
    stops.push(stop(`Stop ${i}`, i, i < reached ? '2026-10-16T02:00:00.000Z' : null));
  }
  return stops;
}

function departure(overrides: Partial<TodayDeparture> = {}): TodayDeparture {
  const stops = overrides.progress?.stops ?? itinerary(6, 3);
  return {
    bookingId: 101,
    ref: 'RG-7KQ4M9',
    tourTitle: 'Kawasan Falls Canyoneering',
    driverName: 'Maria Santos',
    vanPlate: 'ABC 123',
    status: 'in_progress',
    ...overrides,
    progress: overrides.progress ?? progressOf(stops),
  };
}

function renderBoard(departures: TodayDeparture[] | (() => unknown), pollMs?: number) {
  mockTrpc({ [PROCEDURE]: departures });
  return render(
    <TrpcProviders>
      <MemoryRouter>
        <DeparturesBoard pollMs={pollMs} />
      </MemoryRouter>
    </TrpcProviders>,
  );
}

afterEach(resetTrpcMock);

describe('DeparturesBoard', () => {
  it('states the progress in words, not only as a bar', async () => {
    // Trip start plus six stops, three of them standing — so the sentence
    // is unambiguous and could not be produced by an off-by-one.
    renderBoard([departure()]);
    expect(await screen.findByText('3 of 7 stops')).toBeTruthy();
  });

  it('counts the trip-start pseudo-stop, so a three-stop tour reads 0 of 4', async () => {
    renderBoard([departure({ progress: progressOf(itinerary(3, 0)), status: 'assigned' })]);
    // Deliberately NOT 0 of 3: the driver's own checklist reads the same
    // four, and a board that subtracted one would disagree with the van.
    expect(await screen.findByText('0 of 4 stops')).toBeTruthy();
    expect(screen.getByText(/the van has not left yet/i)).toBeTruthy();
  });

  it('reads full once every stop is ticked', async () => {
    const stops = itinerary(3, 4);
    renderBoard([departure({ progress: progressOf(stops), status: 'completed' })]);
    expect(await screen.findByText('4 of 4 stops')).toBeTruthy();
    expect(screen.getByText('Completed')).toBeTruthy();
  });

  it('does not count a retracted check-in', async () => {
    // Trip start stands; the one stop that was tapped was retracted. The
    // `undone` column exists for exactly this, so the board must read 1.
    const stops = [
      stop('Start trip', null, '2026-10-16T01:45:00.000Z'),
      stop('Stop 1', 1, '2026-10-16T02:00:00.000Z', true),
      stop('Stop 2', 2, null),
    ];
    renderBoard([departure({ progress: progressOf(stops) })]);
    expect(await screen.findByText('1 of 3 stops')).toBeTruthy();
    // And the van is reported as still at the departure, not at Stop 1.
    expect(screen.getByText(/left for the pickup at/i)).toBeTruthy();
  });

  it('names the trip, the driver, the van and the status', async () => {
    renderBoard([departure()]);
    expect(await screen.findByText('RG-7KQ4M9')).toBeTruthy();
    expect(screen.getByText('Kawasan Falls Canyoneering')).toBeTruthy();
    expect(screen.getByText(/Maria Santos · ABC 123/)).toBeTruthy();
    expect(screen.getByText('On tour')).toBeTruthy();
  });

  it('reports the last stop reached, at its Manila time', async () => {
    renderBoard([departure()]);
    // `02:00:00Z` is 10:00 in Manila (UTC+8). The ISO instant is the
    // server's; formatting it for Manila is this layer's job.
    expect(await screen.findByText('Stop 2 at 10:00')).toBeTruthy();
  });

  it('marks a departure with no van and no driver in amber', async () => {
    renderBoard([
      departure({ ref: 'RG-NOFLEET', driverName: null, vanPlate: null, status: 'confirmed' }),
    ]);
    const row = await screen.findByTestId('departure-RG-NOFLEET');
    expect(screen.getByText(/no van and no driver assigned/i)).toBeTruthy();
    expect(row.innerHTML).toMatch(/border-amber-200/);
    expect(row.innerHTML).toMatch(/bg-amber-50/);
    expect(screen.getByText(/No driver yet · No van yet/)).toBeTruthy();
  });

  it('names only the half that is missing when one is assigned', async () => {
    renderBoard([departure({ driverName: null })]);
    expect(await screen.findByText(/Departing today with no driver assigned\./i)).toBeTruthy();
  });

  it('paints the bar fill with a brand blue token and hides it from screen readers', async () => {
    renderBoard([departure()]);
    const row = await screen.findByTestId('departure-RG-7KQ4M9');
    const fill = row.querySelector('[aria-hidden="true"] > div');
    expect(fill, 'the bar has no fill element').not.toBeNull();
    expect(fill!.className).toMatch(/bg-brand-blue-600/);
    // The bar repeats the sentence, so it says nothing to a screen reader
    // and is hidden rather than announced twice.
    expect(row.querySelector('[aria-hidden="true"]')).not.toBeNull();
    // jsdom does no layout: the inline width is the only thing readable
    // here, and it is asserted as a value, not as a rendered size.
    expect((fill as HTMLElement).style.width).toBe('43%');
  });

  it('eases the bar with a Tailwind transition and nothing heavier', async () => {
    /*
     * `emilkowalski-motion` is not installed and `CLAUDE.md` says motion is
     * Tailwind-only here. Reduced motion is handled site-wide by the
     * unconditional `prefers-reduced-motion` block in `index.css` (it
     * clamps every `transition-duration` to 0.01ms), which jsdom applies no
     * media queries to — so that clamp is `motion.test.tsx`'s subject,
     * asserted against the stylesheet itself, not something this file can
     * see.
     */
    renderBoard([departure()]);
    const row = await screen.findByTestId('departure-RG-7KQ4M9');
    const fill = row.querySelector('[aria-hidden="true"] > div') as HTMLElement;
    expect(fill.className).toMatch(/transition-\[width\]/);
    expect(fill.className).toMatch(/duration-500/);
  });

  it('links each departure to its own booking, with a full-size tap target', async () => {
    renderBoard([departure()]);
    const link = await screen.findByRole('link', { name: /open this booking/i });
    expect(link.getAttribute('href')).toBe('/admin/bookings/RG-7KQ4M9');
    // jsdom measures nothing — this asserts the 44px utility is applied,
    // not that 44 pixels were painted.
    expect(link.className).toMatch(/tap-target/);
  });

  /* ---------------------------------------------------------------- *
   * Polling, and the busy state that is not a spinner
   * ---------------------------------------------------------------- */

  it('polls, so a check-in reaches the board without a reload', async () => {
    let calls = 0;
    renderBoard(() => {
      calls += 1;
      // One more stop standing on every answer.
      return [departure({ progress: progressOf(itinerary(6, calls)) })];
    }, 25);

    expect(await screen.findByText('1 of 7 stops')).toBeTruthy();
    // The second answer arrives because the component asked again, not
    // because anything re-rendered it.
    expect(await screen.findByText('2 of 7 stops', undefined, { timeout: 2000 })).toBeTruthy();
    expect(calls).toBeGreaterThan(1);
  });

  it("asks again on §9's fifteen seconds by default", async () => {
    // The interval itself cannot be exercised in a test that must finish:
    // this pins the number the component uses when nobody overrides it,
    // and the test above proves the mechanism it is fed to.
    expect(DEPARTURES_POLL_MS).toBe(15_000);
  });

  it('reports a fetch in flight on the region, not with a spinner', async () => {
    // A handler that never settles, so the query stays fetching for as
    // long as the assertion needs.
    renderBoard(() => new Promise(() => {}));
    const board = await screen.findByTestId('departures-board');
    await waitFor(() => expect(board.getAttribute('aria-busy')).toBe('true'));
    // A first load may say so in words; what it must not do is spin.
    expect(screen.getByText(/loading today's departures/i)).toBeTruthy();
  });

  it('is settled, with its rows in place, once an answer has landed', async () => {
    renderBoard([departure()]);
    await screen.findByText('3 of 7 stops');
    const board = screen.getByTestId('departures-board');
    await waitFor(() => expect(board.getAttribute('aria-busy')).toBe('false'));
    // Still there — the refresh does not replace the content it refreshes.
    expect(screen.getByTestId('departure-RG-7KQ4M9')).toBeTruthy();
  });

  it('adds no live region of its own to the dashboard', async () => {
    renderBoard([departure()]);
    await screen.findByText('3 of 7 stops');
    // The dashboard already owns ONE `role="status"` for the alert set.
    // Five competing live regions is the named anti-pattern, and a board
    // that announced itself every fifteen seconds would be worse than
    // four of them.
    expect(screen.queryAllByRole('status')).toEqual([]);
  });

  /* ---------------------------------------------------------------- *
   * Nothing to show, and nothing available
   * ---------------------------------------------------------------- */

  it('says there is nothing departing today rather than showing a blank panel', async () => {
    renderBoard([]);
    expect(await screen.findByText(/no departures today/i)).toBeTruthy();
  });

  it('says so when the board cannot load', async () => {
    mockTrpcError(PROCEDURE, 'INTERNAL_SERVER_ERROR');
    render(
      <TrpcProviders>
        <MemoryRouter>
          <DeparturesBoard />
        </MemoryRouter>
      </TrpcProviders>,
    );
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(/could not load/i);
    // Dark blue-grey, the project's error ink — amber is for warnings.
    expect(alert.className).toMatch(/text-brand-error/);
  });
});
