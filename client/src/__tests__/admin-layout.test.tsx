import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it } from 'vitest';
import AdminLayout from '@/components/layout/AdminLayout';
import { TrpcProviders } from '@/lib/trpc';
import { mockTrpc, mockTrpcError } from './helpers/mock-trpc';

/**
 * `AdminLayout` calls `trpc.staffAuth.me`/`.logout` directly (fix round 1:
 * an earlier version of this file omitted the `TrpcProviders` wrapper,
 * which does not match how every other trpc-using component is rendered
 * in this suite — see `admin-bookings.test.tsx`'s `renderList`/`renderDetail`
 * — and pushed the resulting "no Provider" crash into production-code
 * workarounds instead of being fixed here, where the gap actually was).
 */
beforeEach(() => {
  mockTrpc({ 'staffAuth.me': { userId: 1, role: 'owner' } });
});

function renderAt(path: string) {
  return render(
    <TrpcProviders>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="admin" element={<AdminLayout />}>
            <Route index element={<p>dashboard body</p>} />
            <Route path="vans" element={<p>vans body</p>} />
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

    it('draws Vans, Drivers and Staff for an owner', async () => {
      renderAt('/admin');
      await screen.findByRole('link', { name: 'Staff' });
      expect(names()).toEqual(['Dashboard', 'Bookings', 'Dispatch', 'Vans', 'Drivers', 'Staff']);
    });

    it('does not draw Staff for a dispatcher, who keeps Vans and Drivers', async () => {
      mockTrpc({ 'staffAuth.me': { userId: 2, role: 'dispatcher', mustChangePassword: false } });
      renderAt('/admin');
      await screen.findByRole('link', { name: 'Vans' });
      expect(names()).toEqual(['Dashboard', 'Bookings', 'Dispatch', 'Vans', 'Drivers']);
    });

    it('draws neither Vans, Drivers nor Staff for finance', async () => {
      mockTrpc({ 'staffAuth.me': { userId: 3, role: 'finance', mustChangePassword: false } });
      renderAt('/admin');
      await screen.findByText('Finance');
      expect(names()).toEqual(['Dashboard', 'Bookings', 'Dispatch']);
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
});
