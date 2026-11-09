/**
 * Demo polish, task 1C (owner decision 2) — "Unknown URLs get a branded 404
 * page (inside the normal layout) with links to Home and 'Book a transfer'.
 * The server's 404 status/title behaviour stays as it is."
 *
 * Before `App.tsx` grew a `path="*"` catch-all, navigating to any unmatched
 * URL rendered nothing at all — React Router matched no `<Route>` and
 * `#root` stayed blank, console-warning "No routes matched location". This
 * file renders the real `<App/>` (not a standalone `<NotFoundPage/>`) at an
 * unmatched path, the same way `booking-status.test.tsx` proves its own
 * route actually mounts — so a regression that removes or misplaces the
 * catch-all shows up here, not just a unit render of the component in
 * isolation.
 */
import { render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import App from '@/App';
import { TrpcProviders } from '@/lib/trpc';
import { SETTINGS_FIXTURE } from './helpers/fixtures';
import { mockTrpc, resetTrpcMock } from './helpers/mock-trpc';

afterEach(() => {
  resetTrpcMock();
});

function renderAppAt(path: string) {
  mockTrpc({ 'settings.get': SETTINGS_FIXTURE });
  return render(
    <TrpcProviders>
      <MemoryRouter initialEntries={[path]}>
        <App />
      </MemoryRouter>
    </TrpcProviders>,
  );
}

describe('NotFoundPage — catch-all for an unmatched public URL', () => {
  it('renders the branded 404 body, not a blank page, for a nonsense path', async () => {
    renderAppAt('/this-page-does-not-exist');

    expect(await screen.findByRole('heading', { name: /page not found/i })).toBeInTheDocument();
  });

  it('renders inside the normal public layout (header + footer chrome present)', async () => {
    renderAppAt('/this-page-does-not-exist');

    await screen.findByRole('heading', { name: /page not found/i });
    // PublicLayout's own chrome — proves the 404 body is mounted INSIDE the
    // normal layout (owner decision 2), not as a bare standalone page.
    expect(screen.getByRole('banner')).toBeInTheDocument();
    expect(screen.getByRole('contentinfo')).toBeInTheDocument();
  });

  it('links to Home and to "Book a transfer"', async () => {
    renderAppAt('/this-page-does-not-exist');

    await screen.findByRole('heading', { name: /page not found/i });
    // Scoped to <main> — SiteHeader also carries its own "Book a transfer"
    // nav button, so an unscoped query would match two elements.
    const main = screen.getByRole('main');
    expect(within(main).getByRole('link', { name: /^home$/i })).toHaveAttribute('href', '/');
    expect(within(main).getByRole('link', { name: /book a transfer/i })).toHaveAttribute(
      'href',
      '/transfer',
    );
  });

  /**
   * INVERTED by B3 (DEMO POLISH batch, 2026-11-09, owner decision 1):
   * "Unknown /admin/* paths render a 404 inside the admin layout (sidebar
   * kept)." Before B3, `/admin` had no `path="*"` child of its own, so an
   * unmatched admin subpath fell all the way through to this file's PUBLIC
   * catch-all and rendered with public chrome — the assertion this test
   * used to make, on purpose, as an observed (not assumed) fact. B3 added
   * `AdminNotFoundPage` as the last child inside
   * `<Route path="admin" element={<AdminLayout/>}>`, which now matches
   * first, so the admin shell mounts (sidebar nav `aria-label="Admin"`)
   * instead of `PublicLayout`'s header/footer. This is a deliberate
   * behaviour change, not a weakened assertion — the test now pins the
   * NEW, correct fall-through target.
   *
   * `AdminLayout` also renders its own `<header>` (the phone top bar), so
   * a bare "no banner" assertion is wrong — both layouts have one. The
   * distinguishing check is which one: the admin bar's own "Staff
   * console" text, not `PublicLayout`'s brand header, and no `<footer>`
   * at all (`AdminLayout` renders none).
   */
  it('an unmatched ADMIN subpath renders the ADMIN 404 inside the admin shell, not the public catch-all', async () => {
    renderAppAt('/admin/this-does-not-exist');

    expect(await screen.findByRole('heading', { name: /page not found/i })).toBeInTheDocument();
    // The admin shell's sidebar nav is mounted (sidebar kept, per the
    // decision).
    expect(screen.getByRole('navigation', { name: 'Admin' })).toBeInTheDocument();
    // The banner present is the ADMIN phone top bar, not PublicLayout's.
    expect(within(screen.getByRole('banner')).getByText('Staff console')).toBeInTheDocument();
    // AdminLayout renders no footer at all.
    expect(screen.queryByRole('contentinfo')).not.toBeInTheDocument();
  });
});
