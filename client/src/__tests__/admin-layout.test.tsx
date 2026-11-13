import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { beforeEach, describe, expect, it } from 'vitest';
import AdminLayout from '@/components/layout/AdminLayout';
import AdminLoginPage from '@/pages/admin/AdminLoginPage';
import { TrpcProviders } from '@/lib/trpc';
import { mockTrpc, mockTrpcError } from './helpers/mock-trpc';
import { SETTINGS_FIXTURE } from './helpers/fixtures';

/**
 * Echoes `/admin/login`'s own pathname+search so the redirect test below can
 * assert the encoded `?redirect=` value actually lands in the URL, not just
 * that the login screen rendered.
 */
function LoginLocationEcho() {
  const location = useLocation();
  return <p data-testid="admin-login-location">{location.pathname + location.search}</p>;
}

/**
 * `AdminLayout` calls `trpc.staffAuth.me`/`.logout` directly (fix round 1:
 * an earlier version of this file omitted the `TrpcProviders` wrapper,
 * which does not match how every other trpc-using component is rendered
 * in this suite — see `admin-bookings.test.tsx`'s `renderList`/`renderDetail`
 * — and pushed the resulting "no Provider" crash into production-code
 * workarounds instead of being fixed here, where the gap actually was).
 */
beforeEach(() => {
  // `settings.get` defaults to `SETTINGS_FIXTURE` (showTours: true) so the
  // "which links are drawn" tests below see the UNFADED "Tours" label by
  // default — the Hidden-tag describe block below overrides this per test.
  mockTrpc({
    'staffAuth.me': { userId: 1, role: 'owner' },
    'settings.get': SETTINGS_FIXTURE,
  });
});

function renderAt(path: string) {
  return render(
    <TrpcProviders>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route
            path="admin/login"
            element={
              <>
                <LoginLocationEcho />
                <AdminLoginPage />
              </>
            }
          />
          <Route path="admin" element={<AdminLayout />}>
            <Route index element={<p>dashboard body</p>} />
            <Route path="vans" element={<p>vans body</p>} />
            {/* Catch-all so a deep path (e.g. /admin/bookings/42) still
                matches this branch and mounts AdminLayout — the redirect
                guard below runs inside AdminLayout itself, before the
                Outlet ever renders this placeholder. */}
            <Route path="*" element={<p>admin child body</p>} />
          </Route>
        </Routes>
      </MemoryRouter>
    </TrpcProviders>,
  );
}

describe('AdminLayout', () => {
  it('renders a skip link that targets the main region', () => {
    renderAt('/admin');
    const skip = screen.getByRole('link', { name: /skip to main content/i });
    expect(skip.getAttribute('href')).toBe('#admin-main');
    expect(document.getElementById('admin-main')).not.toBeNull();
  });

  it('renders the child route inside the main region', () => {
    renderAt('/admin/vans');
    const main = document.getElementById('admin-main');
    expect(main?.textContent).toContain('vans body');
  });

  /**
   * Fix round 2 (F1): the first version of this test was named for a
   * non-colour marker but its body checked only `aria-current` — a claim
   * the assertions never backed up, so a colour-only active state (exactly
   * what shipped) passed it anyway. This version checks both: the
   * assistive-tech signal (`aria-current`) AND the sighted, non-colour one
   * (`font-semibold`, a weight change that survives greyscale) — on the
   * active link, and their absence on every other one.
   */
  it('marks the current section with aria-current AND a non-colour marker, not colour alone', async () => {
    renderAt('/admin/vans');
    const nav = screen.getByRole('navigation', { name: /admin/i });
    const current = await within(nav).findByRole('link', { name: /vans/i });
    expect(current.getAttribute('aria-current')).toBe('page');
    expect(current.className).toMatch(/font-semibold/);

    const others = within(nav)
      .getAllByRole('link')
      .filter((a) => a !== current);
    expect(others.length).toBeGreaterThan(0);
    for (const link of others) {
      expect(link.getAttribute('aria-current')).toBeNull();
      expect(link.className).not.toMatch(/font-semibold/);
    }
  });

  it('gives every nav link a 44px tap target', async () => {
    renderAt('/admin');
    await screen.findByRole('link', { name: 'Vans' });
    for (const link of screen.getAllByRole('link')) {
      if (/skip to main/i.test(link.textContent ?? '')) continue;
      expect(link.className).toMatch(/tap-target/);
    }
  });

  /**
   * Fix round 1's required addition: a failed `staffAuth.me` must never
   * take the sign-out control down with it. An operator on a shared office
   * machine who cannot sign out because an identity lookup failed is a
   * security problem, not a cosmetic one — this is the test that stops a
   * future "just show nothing on error" boundary from creeping back in.
   */
  it('keeps the sign-out button reachable when staffAuth.me errors', async () => {
    mockTrpcError('staffAuth.me', 'INTERNAL_SERVER_ERROR', 'Could not confirm your session.');
    renderAt('/admin');
    // Wait for the query to actually SETTLE into its error state (not just
    // its initial pending render, which also shows the button and would
    // let this assertion pass vacuously before the error ever resolved).
    await screen.findByRole('alert');
    expect(screen.getByRole('button', { name: /sign out/i })).toBeInTheDocument();
  });

  /**
   * Task 2 (owner item 1B): an expired/missing session (401/`UNAUTHORIZED`)
   * must send the operator to sign in again, with the path they were on so
   * they land back there afterward — not leave them stuck on the dead-end
   * "Could not confirm your session" sidebar notice above.
   */
  it('redirects to /admin/login with the intended path when staffAuth.me is UNAUTHORIZED', async () => {
    mockTrpcError('staffAuth.me', 'UNAUTHORIZED', 'Admin sign-in required.');
    renderAt('/admin/bookings/42');
    await waitFor(() => {
      expect(screen.getByRole('heading', { name: /staff sign-in/i })).toBeInTheDocument();
    });
    expect(screen.getByTestId('admin-login-location').textContent).toBe(
      '/admin/login?redirect=%2Fadmin%2Fbookings%2F42',
    );
  });

  /**
   * Pins the existing "no redirect on a 500" behavior (the test right above
   * this one, unchanged) so this task provably does not widen the redirect
   * to every failure — only a real 401 sends the operator away.
   */
  it('does not redirect when staffAuth.me fails with a non-auth error', async () => {
    mockTrpcError('staffAuth.me', 'INTERNAL_SERVER_ERROR', 'boom');
    renderAt('/admin/bookings');
    expect(await screen.findByText(/could not confirm your session/i)).toBeInTheDocument();
  });

  /**
   * The sharpest boundary this task has to keep: a valid session with the
   * wrong role (403/`FORBIDDEN`) is a DIFFERENT, already-handled state, and
   * must never be sent to the login screen — that would tell a correctly
   * signed-in operator their session died when it did not. Only a real
   * 401/`UNAUTHORIZED` redirects; this pins the 403 side of that line.
   */
  it('does not redirect when staffAuth.me fails with FORBIDDEN (valid session, wrong role)', async () => {
    mockTrpcError('staffAuth.me', 'FORBIDDEN', 'Not allowed.');
    renderAt('/admin/bookings');
    expect(await screen.findByText(/could not confirm your session/i)).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: /staff sign-in/i })).not.toBeInTheDocument();
  });

  /**
   * Task 16 (7M): the signed-in staff member's name, carried through
   * `readSession` → `staffAuth.me` and shown above the role it already drew.
   */
  describe('the sidebar identity block', () => {
    it('shows the name above the role', async () => {
      mockTrpc({
        'staffAuth.me': {
          userId: 1,
          role: 'owner',
          mustChangePassword: false,
          name: 'Maria Santos',
        },
      });
      renderAt('/admin');
      const name = await screen.findByText('Maria Santos');
      const role = screen.getByText('Owner');
      // DOM order, not just presence: the brief is explicit that the name
      // sits ABOVE the role, and a sibling span reordered beneath it would
      // still pass a presence-only assertion.
      expect(name.compareDocumentPosition(role) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    });
  });

  /**
   * Restyle 2B: the nav is drawn per role. This is cosmetic - the server is
   * the guard - so the test pins only what is DRAWN, and that the owner-only
   * and finance-only links appear for the right people.
   */
  describe('links drawn per role', () => {
    function names(): string[] {
      const nav = screen.getByRole('navigation', { name: /^admin$/i });
      return within(nav)
        .getAllByRole('link')
        .map((a) => a.textContent ?? '');
    }

    it('draws Vans, Drivers and Staff for an owner, grouped per Direction B (owner decision 2026-11-10, group 2)', async () => {
      renderAt('/admin');
      await screen.findByRole('link', { name: 'Staff' });
      // Same 17 destinations as before the 1A regroup (admin-nav.test.ts
      // pins the exact set); this test pins the GROUPED on-screen order,
      // which did change: Reports moved up beside Dashboard (Overview),
      // and Transfer routes/Places/Vehicle types now read in the owner's
      // own stated order instead of the old data-dependency order.
      expect(names()).toEqual([
        'Dashboard',
        'Reports',
        'Bookings',
        'Trip requests',
        'Payment checks',
        'Dispatch',
        'Departures',
        'Vans',
        'Drivers',
        'Transfer routes',
        'Places',
        'Vehicle types',
        'Tours',
        'Packages',
        'Coupons',
        'Reviews',
        'Staff',
        'Settings',
      ]);
    });

    it('does not draw Staff for a dispatcher, who keeps Vans and Drivers', async () => {
      mockTrpc({ 'staffAuth.me': { userId: 2, role: 'dispatcher', mustChangePassword: false } });
      renderAt('/admin');
      await screen.findByRole('link', { name: 'Vans' });
      expect(names()).toEqual([
        'Dashboard',
        'Bookings',
        'Trip requests',
        'Dispatch',
        'Departures',
        'Vans',
        'Drivers',
        // Packages is owner + dispatcher too (Week 7 Task 13) — the enquiry
        // queue is operational work. The newsletter export on that screen is
        // owner-only and is not a nav link.
        'Packages',
        // Reviews is owner + dispatcher too (Week 7 Task 11).
        'Reviews',
      ]);
    });

    it('draws neither Vans, Drivers nor Staff for finance, and no empty groups', async () => {
      mockTrpc({ 'staffAuth.me': { userId: 3, role: 'finance', mustChangePassword: false } });
      renderAt('/admin');
      await screen.findByText('Finance');
      expect(names()).toEqual([
        // Reports is owner + finance (Week 7 Task 12) and sits in Overview
        // (Direction B grouping) beside Dashboard — not at the end.
        'Dashboard',
        'Reports',
        'Bookings',
        'Payment checks',
        'Dispatch',
        'Departures',
        // Vans, Drivers, Staff, and every Transfers setup/Tours setup/
        // Marketing/Admin item stay out of reach — those four groups are
        // entirely empty for finance and draw no heading at all.
      ]);
    });

    /**
     * **The hard rule (Task 16, 7M):** the nav is drawn from the ROLE alone
     * — `navFor(role)` in `AdminLayout` — and must never key off the name,
     * however the two sessions differ. A regression that swapped the
     * argument for `me.data?.name` would draw the dispatcher-only
     * fall-through (an unrecognised "role" string draws the dashboard
     * alone, per `navFor`'s own doc comment), so this would fail loudly
     * rather than merely drift.
     */
    it('draws the identical nav for a role no matter what name comes with the session', async () => {
      mockTrpc({
        'staffAuth.me': {
          userId: 2,
          role: 'dispatcher',
          mustChangePassword: false,
          name: 'Alice First',
        },
      });
      const first = renderAt('/admin');
      await screen.findByRole('link', { name: 'Vans' });
      const withAlice = names();
      first.unmount();

      mockTrpc({
        'staffAuth.me': {
          userId: 2,
          role: 'dispatcher',
          mustChangePassword: false,
          name: 'Bob Second',
        },
      });
      renderAt('/admin');
      await screen.findByRole('link', { name: 'Vans' });
      expect(names()).toEqual(withAlice);
      expect(withAlice).toEqual([
        'Dashboard',
        'Bookings',
        'Trip requests',
        'Dispatch',
        'Departures',
        'Vans',
        'Drivers',
        'Packages',
        'Reviews',
      ]);
    });
  });

  describe('sidebar group headings (Direction B, owner decision 2026-11-10, group 2)', () => {
    function headingNames(nav: HTMLElement): string[] {
      return within(nav)
        .getAllByTestId('nav-group-heading')
        .map((el) => el.textContent ?? '');
    }

    it('shows all seven group headings for an owner, in GROUP_ORDER', async () => {
      renderAt('/admin');
      await screen.findByRole('link', { name: 'Staff' });
      const nav = screen.getByRole('navigation', { name: /^admin$/i });
      expect(headingNames(nav)).toEqual([
        'Overview',
        'Bookings',
        'Operations',
        'Transfers setup',
        'Tours setup',
        'Marketing',
        'Admin',
      ]);
    });

    it('draws no heading for a group with nothing visible — finance sees none of Transfers setup, Tours setup, Marketing or Admin', async () => {
      mockTrpc({ 'staffAuth.me': { userId: 3, role: 'finance', mustChangePassword: false } });
      renderAt('/admin');
      await screen.findByText('Finance');
      const nav = screen.getByRole('navigation', { name: /^admin$/i });
      expect(headingNames(nav)).toEqual(['Overview', 'Bookings', 'Operations']);
    });
  });

  describe('the Tours and Packages "Hidden" tag (owner decision 2026-11-10, group 2; Decision 2 consequence, HANDOVER-19 fix wave)', () => {
    it('fades Tours and shows a Hidden tag while show_tours is off', async () => {
      mockTrpc({ 'settings.get': { ...SETTINGS_FIXTURE, showTours: false } });
      renderAt('/admin');
      const tours = await screen.findByRole('link', { name: /tours/i });
      expect(tours.textContent).toBe('ToursHidden');
      expect(tours.className).toMatch(/opacity-55/);
    });

    it('also fades Packages and shows a Hidden tag while show_tours is off — Decision 2 put Packages behind the same show_tours gate as Tours on every surface, so it is no longer a named deviation', async () => {
      mockTrpc({ 'settings.get': { ...SETTINGS_FIXTURE, showTours: false } });
      renderAt('/admin');
      const packages = await screen.findByRole('link', { name: /packages/i });
      expect(packages.textContent).toBe('PackagesHidden');
      expect(packages.className).toMatch(/opacity-55/);
    });

    it('draws Tours with no Hidden tag while show_tours is on', async () => {
      mockTrpc({ 'settings.get': { ...SETTINGS_FIXTURE, showTours: true } });
      renderAt('/admin');
      const tours = await screen.findByRole('link', { name: /^tours$/i });
      expect(tours.textContent).toBe('Tours');
      expect(tours.className).not.toMatch(/opacity-55/);
    });

    it('draws Packages with no Hidden tag while show_tours is on', async () => {
      mockTrpc({ 'settings.get': { ...SETTINGS_FIXTURE, showTours: true } });
      renderAt('/admin');
      const packages = await screen.findByRole('link', { name: /^packages$/i });
      expect(packages.textContent).toBe('Packages');
      expect(packages.className).not.toMatch(/opacity-55/);
    });
  });

  describe('the payment checks count', () => {
    const waiting = (count: number) => [{ kind: 'payments_to_verify', count, examples: [] }];

    it('shows how many payments are waiting beside the link, for finance', async () => {
      mockTrpc({
        'staffAuth.me': { userId: 3, role: 'finance', mustChangePassword: false },
        'admin.dashboard.alerts': waiting(4),
      });
      renderAt('/admin');
      const link = await screen.findByRole('link', { name: /payment checks/i });
      await waitFor(() => expect(link.textContent).toMatch(/4/));
      expect(link.textContent).toMatch(/4 waiting/);
    });

    it('draws no count at zero, and none when the alerts cannot load', async () => {
      mockTrpc({
        'staffAuth.me': { userId: 3, role: 'finance', mustChangePassword: false },
        'admin.dashboard.alerts': waiting(0),
      });
      const first = renderAt('/admin');
      const link = await screen.findByRole('link', { name: /payment checks/i });
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(link.textContent).toBe('Payment checks');
      first.unmount();

      mockTrpc({
        'staffAuth.me': { userId: 3, role: 'finance', mustChangePassword: false },
      });
      renderAt('/admin');
      const again = await screen.findByRole('link', { name: /payment checks/i });
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(again.textContent).toBe('Payment checks');
    });

    it('offers a dispatcher no payment link at all', async () => {
      mockTrpc({
        'staffAuth.me': { userId: 2, role: 'dispatcher', mustChangePassword: false },
        'admin.dashboard.alerts': waiting(4),
      });
      renderAt('/admin');
      await screen.findByRole('link', { name: 'Vans' });
      expect(screen.queryByRole('link', { name: /payment/i })).toBeNull();
    });
  });

  it('has exactly one main region, with the phone quick links outside it', async () => {
    renderAt('/admin');
    await screen.findByRole('link', { name: 'Vans' });
    expect(screen.getAllByRole('main')).toHaveLength(1);
    const quick = screen.getByRole('navigation', { name: /quick links/i });
    expect(screen.getByRole('main').contains(quick)).toBe(false);
    expect(within(quick).getByRole('link', { name: 'Home' })).toBeInTheDocument();
  });

  it('opens and closes the phone menu with a labelled, 44px button that reports its state', async () => {
    renderAt('/admin');
    const button = screen.getByRole('button', { name: /open menu/i });
    expect(button.getAttribute('aria-expanded')).toBe('false');
    expect(button.getAttribute('aria-controls')).toBe('admin-sidebar');
    expect(button.className).toMatch(/size-11/);
    await userEvent.click(button);
    expect(screen.getByRole('button', { name: /close menu/i }).getAttribute('aria-expanded')).toBe(
      'true',
    );
  });

  /**
   * "Powered by First On Page" footer credit is PUBLIC FOOTER ONLY.
   * Owner decision 2026-11-11: the credit link appears on the public
   * footer only — never on admin, driver, or portal surfaces.
   * This test guards that AdminLayout does not render it, even though
   * it may mount a footer of its own.
   */
  it('does not render the "Powered by First On Page" credit (public footer only)', () => {
    renderAt('/admin');
    expect(screen.queryByText(/first on page/i)).not.toBeInTheDocument();
  });
});
