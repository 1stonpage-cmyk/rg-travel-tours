/**
 * `document.title` after a client-side navigation (Task 17, item 4).
 *
 * The gap these pin: per-route head content is injected SERVER-side, once,
 * for the path the SPA was first loaded at. Nothing re-asserted it, so the
 * tab kept the entry route's title for the rest of the session — a driver
 * read "Driver portal" all shift (right by luck) and a guest who clicked
 * from `/privacy` to `/terms` kept reading "Privacy Notice" (not right).
 *
 * The null case is tested too, and it is the load-bearing half for
 * `PublicLayout`'s OWN hook call: `/` and the two detail routes resolve
 * their titles from the database, so `PublicLayout` — which only ever
 * carries a bare `STATIC_PUBLIC_TITLES`/`APP_SURFACE_TITLES` name — has
 * nothing to offer those routes and must leave the injected title alone
 * rather than overwrite it with a guess. This is still true after Task 4
 * (1D): `PublicLayout` did not gain those formulas. What changed is that the
 * real page components for those three routes now call their OWN title hook
 * (`useRawDocumentTitle`) directly, with the server's own already-complete
 * string — see `tour-detail-page.test.tsx` / `package-detail-page.test.tsx`
 * / `home.test.tsx`'s own "document title" tests for that half. The two
 * tests below render stub children in place of the real pages specifically
 * so they keep pinning `PublicLayout`'s contract in isolation, undisturbed
 * by what the real pages do.
 */
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it } from 'vitest';
import { APP_SURFACE_TITLES, STATIC_PUBLIC_TITLES } from '@rg/shared';
import AdminLayout from '@/components/layout/AdminLayout';
import DriverLayout from '@/components/layout/DriverLayout';
import PublicLayout from '@/components/layout/PublicLayout';
import PortalBookingPage from '@/pages/portal/PortalBookingPage';
import { SITE } from '@/lib/site';
import { TrpcProviders } from '@/lib/trpc';
import { SETTINGS_FIXTURE } from './helpers/fixtures';
import { mockTrpc } from './helpers/mock-trpc';

/** What the server injects on a cold load — the value a `null` title must not touch. */
const INJECTED = 'Something the server put here | TravelSugbo';

beforeEach(() => {
  document.title = INJECTED;
  mockTrpc({
    'settings.get': SETTINGS_FIXTURE,
    'staffAuth.me': { userId: 1, role: 'owner' },
  });
});

function renderAt(path: string, element: React.ReactNode, routePath: string) {
  return render(
    <TrpcProviders>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path={routePath} element={element}>
            <Route index element={<p>body</p>} />
          </Route>
        </Routes>
      </MemoryRouter>
    </TrpcProviders>,
  );
}

/** `App.tsx`'s own shape for the public tree: the layout at `/`, pages beneath it. */
function renderPublicAt(path: string) {
  return render(
    <TrpcProviders>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route element={<PublicLayout />}>
            <Route index element={<p>home body</p>} />
            <Route path="terms" element={<p>terms body</p>} />
            <Route path="tours/:slug" element={<p>tour body</p>} />
          </Route>
        </Routes>
      </MemoryRouter>
    </TrpcProviders>,
  );
}

describe('document.title', () => {
  it('names the staff console on an admin route', () => {
    renderAt('/admin', <AdminLayout />, 'admin');
    expect(document.title).toBe(`${APP_SURFACE_TITLES['/admin']} | ${SITE.name}`);
    expect(document.title).toBe('Staff console | TravelSugbo');
  });

  it('names the driver portal on a driver route', () => {
    renderAt('/driver', <DriverLayout />, 'driver');
    expect(document.title).toBe(`${APP_SURFACE_TITLES['/driver']} | ${SITE.name}`);
  });

  /*
   * The portal has no shared layout component, so the call lives on each
   * page. One of the three is enough to prove the wiring; `App.tsx` mounts
   * all three directly and the other two carry the identical call.
   */
  it('names the booking portal from the page itself, with no layout above it', () => {
    render(
      <TrpcProviders>
        <MemoryRouter initialEntries={['/portal/booking']}>
          <PortalBookingPage />
        </MemoryRouter>
      </TrpcProviders>,
    );
    expect(document.title).toBe(`${APP_SURFACE_TITLES['/portal']} | ${SITE.name}`);
  });

  it('names a static public page, from the same words the resolver uses', () => {
    renderPublicAt('/terms');
    expect(document.title).toBe(`${STATIC_PUBLIC_TITLES['/terms']} | ${SITE.name}`);
    expect(document.title).toBe('Terms of Service | TravelSugbo');
  });

  it('PublicLayout claims no title on a route whose page owns it: home', () => {
    renderPublicAt('/');
    // `/`'s real title is `settings.site_seo.title` — a full database string
    // `PublicLayout` has no access to — so it passes `null` and leaves
    // whatever is already showing untouched. (The stub index route here
    // renders no title itself; the REAL HomePage's own call is pinned
    // separately in home.test.tsx's "document title" tests.)
    expect(document.title).toBe(INJECTED);
  });

  it('PublicLayout claims no title on a route whose page owns it: tour detail too', () => {
    renderPublicAt('/tours/kawasan-falls');
    expect(document.title).toBe(INJECTED);
    // Not to be confused with the catalog index, which IS named.
    expect(STATIC_PUBLIC_TITLES['/tours']).toBe('Cebu Day Tours');
    // (Same caveat as above: the REAL TourDetailPage's own call is pinned
    // separately in tour-detail-page.test.tsx's "document title" tests.)
  });

  it('still renders the page it titled', () => {
    renderPublicAt('/terms');
    expect(screen.getByRole('main')).toBeInTheDocument();
  });
});
