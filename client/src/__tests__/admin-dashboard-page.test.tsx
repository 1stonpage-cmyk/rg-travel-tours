/**
 * Week 5, Task 14: the admin dashboard — five cards, zeroes included.
 *
 * Renders through `TrpcProviders` (the page uses a tRPC hook) and a
 * `MemoryRouter`, because each non-zero card links to the screen that
 * resolves it.
 */
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it } from 'vitest';
import type { DashboardAlert } from '@rg/shared';
import AdminDashboardPage from '@/pages/admin/AdminDashboardPage';
import { TrpcProviders } from '@/lib/trpc';
import { mockTrpc, resetTrpcMock } from './helpers/mock-trpc';

const alert = (
  kind: DashboardAlert['kind'],
  count: number,
  examples: DashboardAlert['examples'] = [],
): DashboardAlert => ({ kind, count, examples });

const ALL_FIVE_NONZERO: DashboardAlert[] = [
  alert('payments_to_verify', 2, [{ id: 1, label: 'RG-AAAA11', date: '2026-11-12' }]),
  alert('unassigned_soon', 3, [{ id: 2, label: 'RG-BBBB22 · Kawasan Falls', date: '2026-11-11' }]),
  alert('vans_in_repair', 1, [{ id: 3, label: 'ABC 123 — Clutch', date: null }]),
  alert('service_due', 4, [{ id: 4, label: 'DEF 456', date: '2026-11-20' }]),
  alert('papers_expiring', 2, [{ id: 5, label: 'Maria Santos — licence', date: '2026-12-01' }]),
];

function renderDashboard(alerts: DashboardAlert[]) {
  /*
   * The departures board (Week 6, Task 12) owns its own query on this
   * page, so every render here has to answer it too — an unmocked
   * procedure would put the board into its error state and leave these
   * assertions reading a page that is half broken. Empty is the quiet
   * answer: the board then renders its "nothing departing" line and the
   * alert cards are what is under test.
   */
  mockTrpc({ 'admin.dashboard.alerts': alerts, 'admin.departures.today': [] });
  return render(
    <TrpcProviders>
      <MemoryRouter>
        <AdminDashboardPage />
      </MemoryRouter>
    </TrpcProviders>,
  );
}

afterEach(resetTrpcMock);

describe('AdminDashboardPage', () => {
  it('states each count in words, not as a bare numeral', async () => {
    renderDashboard(ALL_FIVE_NONZERO);
    expect(await screen.findByText(/2 payments to verify/i)).toBeTruthy();
    expect(screen.getByText(/3 trips within 48 hours have no van or driver/i)).toBeTruthy();
    expect(screen.getByText(/4 vans are due for service within 14 days/i)).toBeTruthy();
  });

  it('uses the singular when there is exactly one', async () => {
    // "1 vans are in repair" is the kind of thing an operator stops
    // trusting, and the plural branch is where it would come from.
    renderDashboard([alert('vans_in_repair', 1)]);
    expect(await screen.findByText(/1 van is in repair/i)).toBeTruthy();
  });

  it('renders a zero alert as all clear, and still renders the card', async () => {
    renderDashboard([alert('vans_in_repair', 0)]);
    // Present, so an operator can tell "nothing to do" from "nothing
    // loaded".
    expect(await screen.findByTestId('alert-vans_in_repair')).toBeTruthy();
    expect(screen.getByText(/vans in repair/i)).toBeTruthy();
    expect(screen.getByText(/all clear/i)).toBeTruthy();
  });

  it('shows all five cards even when four of them are zero', async () => {
    renderDashboard([
      alert('payments_to_verify', 1),
      alert('unassigned_soon', 0),
      alert('vans_in_repair', 0),
      alert('service_due', 0),
      alert('papers_expiring', 0),
    ]);
    await screen.findByTestId('alert-payments_to_verify');
    for (const kind of [
      'payments_to_verify',
      'unassigned_soon',
      'vans_in_repair',
      'service_due',
      'papers_expiring',
    ]) {
      expect(screen.getByTestId(`alert-${kind}`)).toBeTruthy();
    }
  });

  it('paints an alert amber, not with a forbidden hue', async () => {
    /*
     * Named around the forbidden word rather than with it: the project's
     * `no-red` guard scans source for bare colour names and flagged this
     * test's own TITLE. That is the guard being blunt in the right
     * direction — it cannot know a string is a test name, and a scanner
     * clever enough to try is a scanner to trust less.
     *
     * The assertion is positive for the same reason as on the drivers
     * screen: shadcn's variant strings carry `destructive`, so a negative
     * regex on `className` reports on vendored tokens rather than on this
     * card. The brand-wide rule lives in the guard, which reads real
     * source.
     */
    renderDashboard([alert('service_due', 3)]);
    const card = await screen.findByTestId('alert-service_due');
    expect(card.className).toMatch(/border-amber-200/);
    expect(card.className).toMatch(/bg-amber-50/);
  });

  it('links every non-zero alert to the screen that resolves it', async () => {
    renderDashboard(ALL_FIVE_NONZERO);
    await screen.findByTestId('alert-payments_to_verify');
    const hrefs = screen.getAllByRole('link').map((a) => a.getAttribute('href'));
    expect(hrefs).toContain('/admin/calendar');
    expect(hrefs.some((h) => h?.startsWith('/admin/bookings'))).toBe(true);
    expect(hrefs).toContain('/admin/vans');
    expect(hrefs).toContain('/admin/drivers');
    // EXACTLY five links, one per non-zero card — a zero card must not
    // offer an action there is nothing to do.
    expect(hrefs).toHaveLength(5);
  });

  it('offers no link on a zero card', async () => {
    renderDashboard([alert('vans_in_repair', 0)]);
    await screen.findByTestId('alert-vans_in_repair');
    expect(screen.queryAllByRole('link')).toEqual([]);
  });

  it('uses ONE status region for the whole set', async () => {
    renderDashboard(ALL_FIVE_NONZERO);
    await screen.findByTestId('alert-payments_to_verify');
    // Five competing live regions is the named anti-pattern; one sentence
    // tells an operator more than five numbers read in sequence.
    expect(screen.getAllByRole('status')).toHaveLength(1);
    expect(screen.getByRole('status').textContent).toMatch(/12 things need attention/i);
  });

  it('says nothing needs attention when every alert is zero', async () => {
    renderDashboard([alert('payments_to_verify', 0), alert('unassigned_soon', 0)]);
    expect((await screen.findByRole('status')).textContent).toMatch(/nothing needs attention/i);
  });

  it('names the examples the server sent, so the number is checkable', async () => {
    renderDashboard([
      alert('vans_in_repair', 1, [{ id: 3, label: 'ABC 123 — Clutch', date: null }]),
    ]);
    expect(await screen.findByText(/ABC 123 — Clutch/)).toBeTruthy();
  });

  it("carries §9's departures board below the cards", async () => {
    /*
     * This test used to assert the line of apology that stood here while
     * `trip_checkpoints` did not exist. Task 12 replaced that line with
     * the real panel, so the assertion moved with it rather than being
     * deleted: §9's dashboard LEADS with today's departures, and a page
     * that silently stopped rendering them should fail something.
     *
     * The board's own behaviour — the progress wording, the poll, the
     * busy state — is `departures-board.test.tsx`. This only pins that
     * the dashboard mounts it.
     */
    renderDashboard(ALL_FIVE_NONZERO);
    expect(await screen.findByTestId('departures-board')).toBeTruthy();
    expect(screen.getByRole('heading', { name: /today's departures/i })).toBeTruthy();
  });

  it('still keeps ONE status region with the board mounted', async () => {
    // The board deliberately adds none: `aria-busy` is an attribute, not
    // an announcement, and a panel that announced itself every fifteen
    // seconds would be worse than the five regions this page avoids.
    renderDashboard(ALL_FIVE_NONZERO);
    // The board renders synchronously, so its presence is NOT evidence the
    // alerts have landed — wait for a card, or this counts the regions of a
    // half-rendered page and passes for the wrong reason.
    await screen.findByTestId('alert-payments_to_verify');
    expect(screen.getByTestId('departures-board')).toBeTruthy();
    expect(screen.getAllByRole('status')).toHaveLength(1);
  });
});
