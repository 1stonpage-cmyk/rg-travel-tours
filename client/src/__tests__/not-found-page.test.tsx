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
   * The verification step the task asked for, made concrete rather than
   * reasoned from the route tree alone: `/admin` lives in its own top-level
   * `<Route path="admin" element={<AdminLayout/>}>` block, entirely separate
   * from the `<Route element={<PublicLayout/>}>` block the catch-all sits
   * inside. React Router matches a pathname against the WHOLE route tree,
   * not tree-by-tree, so `/admin/this-does-not-exist` matches neither
   * `AdminLayout`'s own children (none of which is `this-does-not-exist`)
   * nor any literal public route — it falls through to the public
   * catch-all and renders with PUBLIC chrome (this suite's banner/footer),
   * not `AdminLayout`'s nav. That is stated here as an observed fact from
   * actually rendering `<App/>` at that path, not assumed from reading the
   * JSX.
   */
  it('an unmatched ADMIN subpath also falls through to the PUBLIC catch-all (observed, not assumed)', async () => {
    renderAppAt('/admin/this-does-not-exist');

    expect(await screen.findByRole('heading', { name: /page not found/i })).toBeInTheDocument();
    // Public chrome, not AdminLayout's nav — the admin shell is never mounted.
    expect(screen.getByRole('banner')).toBeInTheDocument();
    expect(screen.getByRole('contentinfo')).toBeInTheDocument();
  });
});
