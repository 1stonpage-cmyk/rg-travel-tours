/**
 * `document.title` after a client-side navigation (Task 17, item 4).
 *
 * The gap these pin: per-route head content is injected SERVER-side, once,
 * for the path the SPA was first loaded at. Nothing re-asserted it, so the
 * tab kept the entry route's title for the rest of the session — a driver
 * read "Driver portal" all shift (right by luck) and a guest who clicked
 * from `/privacy` to `/terms` kept reading "Privacy Notice" (not right).
 *
 * The null case is tested too, and it is the load-bearing half: `/` and the
 * two detail routes resolve their titles from the database, which the
 * browser cannot read, so the hook must leave the injected title ALONE
 * there rather than overwrite a correct title with a guess.
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

  it('LEAVES the injected title alone on a route whose title the database owns', () => {
    renderPublicAt('/');
    // `/` is `settings.site_seo.title`, which the browser cannot read.
    expect(document.title).toBe(INJECTED);
  });

  it('leaves the injected title alone on a tour detail route too', () => {
    renderPublicAt('/tours/kawasan-falls');
    expect(document.title).toBe(INJECTED);
    // Not to be confused with the catalog index, which IS named.
    expect(STATIC_PUBLIC_TITLES['/tours']).toBe('Cebu Day Tours');
  });

  it('still renders the page it titled', () => {
    renderPublicAt('/terms');
    expect(screen.getByRole('main')).toBeInTheDocument();
  });
});
