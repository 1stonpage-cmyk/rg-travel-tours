/**
 * Week 5 plan, Task 7 — the drivers admin screen (BUILD_SPEC §9 "Drivers" /
 * §5B, client half).
 *
 * The PIN reveal is the whole design problem on this screen: a new PIN
 * (from `resetPin` or `create`) arrives once, in the mutation's response,
 * and is never retrievable again. This file proves the panel that shows it
 * is cleared on dismiss and on any other mutation (the third trigger, a
 * route change, cannot be proven inside a single rendered route the way
 * these two can — see the module note on `AdminDriversPage.tsx` for why it
 * is still wired), and that the confirm step actually gates the mutation
 * rather than only looking like it does.
 *
 * **A fixed brief defect (reported in the task report, not silently
 * patched):** the brief's own `'spells out both ends of a leave range'`
 * test was written as a SYNC `it(() => {...})` using `screen.getByText`
 * directly after `renderPage()`, with no `await`. `admin.drivers.list` is
 * an async query — nothing in a sync test body can observe its resolution,
 * so the test as literally given would fail (or pass vacuously on a stale
 * render) regardless of whether the date formatting is correct. This is
 * exactly the "sync test that could not observe an async fetch" defect
 * class the task's own brief warns about. Fixed here by making the test
 * `async` and using `findByText`, which is the only change from the
 * brief's literal body.
 *
 * **Fix round 1 (2026-10-14):** `DriverRow.leaves` is now real — the
 * controller added it to `admin.drivers.list`'s response server-side, so
 * `DRIVER.leaves` below is the actual wire shape, not a stand-in. There is
 * no more test-only seam: `overrides.leaves` rides on the same `leaves`
 * field the real server sends. A new test proves `removeLeave` is wired
 * with the real id the server assigned, which the first version of this
 * page could never obtain.
 */
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it } from 'vitest';
import AdminDriversPage from '@/pages/admin/AdminDriversPage';
import { TrpcProviders } from '@/lib/trpc';
import { mockTrpc, resetTrpcMock } from './helpers/mock-trpc';

const user = userEvent.setup();

afterEach(() => {
  resetTrpcMock();
});

const DRIVER = {
  id: 1,
  name: 'Maria Santos',
  code: 'MS01',
  phone: '09171234567',
  licenseNo: 'N01-23-456789',
  licenseExpiry: '2027-06-01',
  languages: ['English', 'Cebuano'],
  emergencyContact: 'Juan Santos 09179876543',
  status: 'available',
  isActive: true,
  rating: null as { average: number; count: number } | null,
  // The real shape `admin.drivers.list` now sends (fix round 1,
  // 2026-10-14) — a driver with no leaves gets `[]`, never `undefined`.
  leaves: [] as Array<{ id: number; startDate: string; endDate: string; reason: string | null }>,
};

interface RenderOverrides {
  /** Soft-delete flag — an inactive driver must look different. */
  isActive?: boolean;
  /** The derived guide rating, or null below the threshold. */
  rating?: { average: number; count: number } | null;
  onResetPin?: (input: unknown) => void;
  onRemoveLeave?: (input: unknown) => void;
  leaves?: Array<{ id: number; startDate: string; endDate: string; reason: string | null }>;
  addLeaveError?: string;
}

/**
 * The house pattern (controller note, 2026-10-14): `TrpcProviders` because
 * the page queries `admin.drivers.list`, and a `MemoryRouter` because the
 * page reads `useLocation()` to clear the PIN panel on a route change.
 *
 * `overrides.leaves`, when given, replaces the mocked `list` row's own
 * `leaves` field with the exact rows a test wants to assert against — the
 * real shape `admin.drivers.list` sends, not a seam. `overrides.onResetPin`
 * and `overrides.onRemoveLeave` record what each mutation was called with;
 * `overrides.addLeaveError` makes `addLeave` reject.
 */
function renderPage(overrides: RenderOverrides = {}) {
  const driver = {
    ...DRIVER,
    ...(overrides.leaves ? { leaves: overrides.leaves } : {}),
    ...(overrides.isActive === undefined ? {} : { isActive: overrides.isActive }),
    ...(overrides.rating === undefined ? {} : { rating: overrides.rating }),
  };
  mockTrpc({
    'admin.drivers.list': [driver],
    'admin.drivers.create': () => ({ id: 2, pin: '654321' }),
    'admin.drivers.update': () => ({ ok: true }),
    'admin.drivers.addLeave': overrides.addLeaveError
      ? () => {
          throw new Error(overrides.addLeaveError);
        }
      : () => ({ id: 99 }),
    'admin.drivers.removeLeave': (input: unknown) => {
      overrides.onRemoveLeave?.(input);
      return { ok: true };
    },
    'admin.drivers.resetPin': (input: unknown) => {
      overrides.onResetPin?.(input);
      return { pin: '123456' };
    },
  });
  return render(
    <TrpcProviders>
      <MemoryRouter initialEntries={['/admin/drivers']}>
        <Routes>
          <Route path="/admin/drivers" element={<AdminDriversPage />} />
        </Routes>
      </MemoryRouter>
    </TrpcProviders>,
  );
}

describe('AdminDriversPage', () => {
  /*
   * §9's "average rating", derived and shown only above the threshold
   * (owner-decided 2026-10-15).
   */

  it('says a new driver has no ratings yet, in words, with no number', async () => {
    renderPage({ rating: null });
    expect(await screen.findByText(/new driver — no ratings yet/i)).toBeTruthy();
    // And NO numeral anywhere near it: a zero or a dash would be read as a
    // measurement of a driver nobody has rated.
    expect(screen.queryByText(/★/)).toBeNull();
  });

  it('shows the average WITH its count once there are enough ratings', async () => {
    renderPage({ rating: { average: 4.3, count: 7 } });
    const badge = await screen.findByText(/4\.3★ guide · from 7 ratings/i);
    expect(badge).toBeTruthy();
    expect(screen.queryByText(/new driver/i)).toBeNull();
  });

  it('keeps one decimal place on a whole average', async () => {
    // "4" reads as rounded-from-anything; "4.0" reads as measured.
    renderPage({ rating: { average: 4, count: 3 } });
    expect(await screen.findByText(/4\.0★ guide · from 3 ratings/i)).toBeTruthy();
  });

  /**
   * `isActive` was fetched from the server and never rendered, so a
   * soft-deleted driver looked identical to a working one — and soft-delete
   * is the ONLY way a driver is ever removed (`CLAUDE.md`: never
   * hard-delete), which made the one state that matters invisible. Found by
   * the Task 7 review.
   *
   * Text, not colour: the assertion is on words a dispatcher can read.
   */
  it('shows an inactive driver as off the roster, in words', async () => {
    renderPage({ isActive: false });
    expect(await screen.findByText(/inactive — not on the roster/i)).toBeTruthy();
  });

  it('shows an active driver with no current leave as active', async () => {
    renderPage();
    expect(await screen.findByText(/^active$/i)).toBeTruthy();
    expect(screen.queryByText(/inactive/i)).toBeNull();
  });

  /**
   * The panel is local state cleared on THREE triggers — dismiss, a
   * subsequent mutation, and a route change. This test covers the first two;
   * the route change is covered by the next test. An earlier draft was named
   * "...and not after a refetch" while its body only clicked Dismiss, which
   * is the name-claims-more-than-the-body defect that has appeared seven
   * times in this plan.
   */
  it('reveals a reset PIN once, in a status region, and clears it on dismiss', async () => {
    renderPage();
    await user.click(await screen.findByRole('button', { name: /reset pin/i }));
    await user.click(screen.getByRole('button', { name: /^reset pin for/i }));
    const status = await screen.findByRole('status');
    expect(status.textContent).toMatch(/[0-9]{6}/);
    expect(status.textContent).toMatch(/not be shown again/i);

    await user.click(screen.getByRole('button', { name: /dismiss/i }));
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('clears a revealed PIN when any other mutation runs', async () => {
    // A PIN left on screen while the dispatcher does something else is a
    // credential sitting in a shared office. Any subsequent mutation —
    // adding a leave here — must take it down.
    renderPage();
    await user.click(await screen.findByRole('button', { name: /reset pin/i }));
    await user.click(screen.getByRole('button', { name: /^reset pin for/i }));
    expect(await screen.findByRole('status')).toBeTruthy();

    await user.click(screen.getByRole('button', { name: /add leave/i }));
    await waitFor(() => expect(screen.queryByRole('status')).toBeNull());
  });

  it('asks before resetting, and cancelling resets nothing', async () => {
    const calls: unknown[] = [];
    renderPage({ onResetPin: (v: unknown) => calls.push(v) });
    await user.click(await screen.findByRole('button', { name: /reset pin/i }));
    await user.click(screen.getByRole('button', { name: /cancel/i }));
    expect(calls).toEqual([]);
  });

  /**
   * Fixed from the brief's literal (sync) version — see the file header.
   * `admin.drivers.list` is an async query; a sync `it(() => ...)` body
   * using `getByText` cannot observe its resolution.
   */
  it('spells out both ends of a leave range', async () => {
    renderPage({
      leaves: [{ id: 1, startDate: '2026-11-10', endDate: '2026-11-12', reason: null }],
    });
    expect(await screen.findByText(/10 Nov 2026 to 12 Nov 2026/i)).toBeTruthy();
  });

  it('shows the server error beside the leave form when ranges overlap', async () => {
    renderPage({ addLeaveError: 'That overlaps an existing leave.' });
    await user.click(await screen.findByRole('button', { name: /add leave/i }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/overlaps/i);
  });

  /**
   * Fix round 1 (2026-10-14): before `DriverRow.leaves` existed, this
   * button called `removeLeave` with an id the client had no way to have
   * obtained — unreachable from the only UI that calls it. Now the id
   * comes straight off the server-sent row.
   */
  it('removes a leave using the real id the server sent, not a guess', async () => {
    const calls: unknown[] = [];
    renderPage({
      onRemoveLeave: (v: unknown) => calls.push(v),
      leaves: [{ id: 42, startDate: '2026-11-10', endDate: '2026-11-12', reason: null }],
    });
    await user.click(await screen.findByRole('button', { name: /remove/i }));
    expect(calls).toEqual([{ id: 42 }]);
  });
});
