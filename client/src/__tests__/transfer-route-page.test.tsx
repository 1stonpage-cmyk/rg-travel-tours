/**
 * Task 9 (SEO fixes, 2026-11-24) — `/transfers/:slug`, the direction-specific
 * transfer route landing page. `matchRouteDirection` (inside
 * `TransferRoutePage.tsx`) must try a FORWARD match first, then a REVERSE
 * one (restricted to `reverseEnabled` routes) — the exact two-step order
 * `loadTransferRouteSeo` (Task 8, server-side) uses, so a slug this page
 * accepts is never one the server's resolver would have 404'd, and vice
 * versa.
 */
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { reverseTransferRouteSlug, type TransferRoutePublicRow } from '@rg/shared';
import TransferRoutePage from '@/pages/public/TransferRoutePage';
import { TrpcProviders } from '@/lib/trpc';
import { mockTrpc, resetTrpcMock } from './helpers/mock-trpc';

// Task 12 (SEO fixes, 2026-11-24) — `view_route` analytics. Mocked wholesale
// rather than stubbing `window.gtag`: this page imports nothing else from
// `@/lib/consent/scripts`, so replacing the module is safe here, and
// asserting on the mock itself (not a DOM side effect) is the only way to
// pin exactly what `trackEvent` was called with and how many times.
vi.mock('@/lib/consent/scripts', () => ({
  trackEvent: vi.fn(),
}));

import { trackEvent } from '@/lib/consent/scripts';

const REVERSIBLE: TransferRoutePublicRow = {
  id: 1,
  fromPlace: { id: 10, name: 'Mactan-Cebu International Airport', placeType: 'airport' },
  toPlace: { id: 11, name: 'Moalboal', placeType: 'destination' },
  reverseEnabled: true,
  slug: 'mactan-airport-to-moalboal',
  estimatedDurationMinutes: 150,
  freeCancelHours: 24,
  inclusionsText: null,
  exclusionsText: null,
  pricingMode: 'per_vehicle',
  minPayingPax: 1,
  pageTitle: 'Mactan-Cebu International Airport to Moalboal Private Transfer — from ₱2,500',
  reversePageTitle: 'Moalboal to Mactan-Cebu International Airport Private Transfer — from ₱2,500',
  vehiclePrices: [
    {
      vehicleTypeId: 1,
      vehicleTypeName: 'Van',
      slug: 'van',
      oneWayPriceCentavos: 250_000,
      dayUsePriceCentavos: 500_000,
      defaultSeats: 10,
    },
  ],
};

const NON_REVERSIBLE: TransferRoutePublicRow = {
  id: 2,
  fromPlace: { id: 10, name: 'Mactan-Cebu International Airport', placeType: 'airport' },
  toPlace: { id: 12, name: 'Oslob', placeType: 'destination' },
  reverseEnabled: false,
  slug: 'mactan-airport-to-oslob',
  estimatedDurationMinutes: 180,
  freeCancelHours: 24,
  inclusionsText: null,
  exclusionsText: null,
  pricingMode: 'per_vehicle',
  minPayingPax: 1,
  pageTitle: 'Mactan-Cebu International Airport to Oslob Private Transfer — from ₱3,200',
  reversePageTitle: null,
  vehiclePrices: [
    {
      vehicleTypeId: 1,
      vehicleTypeName: 'Van',
      slug: 'van',
      oneWayPriceCentavos: 320_000,
      dayUsePriceCentavos: 600_000,
      defaultSeats: 10,
    },
  ],
};

/** Shares `fromPlace` (Mactan Airport) with both routes above — a related route. */
const RELATED: TransferRoutePublicRow = {
  id: 3,
  fromPlace: { id: 10, name: 'Mactan-Cebu International Airport', placeType: 'airport' },
  toPlace: { id: 13, name: 'Cebu City', placeType: 'destination' },
  reverseEnabled: false,
  slug: 'mactan-airport-to-cebu-city',
  estimatedDurationMinutes: 40,
  freeCancelHours: 24,
  inclusionsText: null,
  exclusionsText: null,
  pricingMode: 'per_vehicle',
  minPayingPax: 1,
  pageTitle: 'Mactan-Cebu International Airport to Cebu City Private Transfer',
  reversePageTitle: null,
  vehiclePrices: [],
};

/**
 * Shares ONLY `dropoffPlace` (Moalboal, id 11) with the REVERSIBLE route's
 * forward view — nothing in common with `pickupPlace` (Mactan Airport,
 * id 10). Final review fix 1: the related-routes filter used to match a
 * route sharing EITHER endpoint with EITHER of the page's two places, which
 * would list this route under the heading "Other transfers from
 * Mactan-Cebu International Airport" — a false claim, since this route
 * never touches the airport at all.
 */
const UNRELATED_SHARES_DROPOFF_ONLY: TransferRoutePublicRow = {
  id: 4,
  fromPlace: { id: 11, name: 'Moalboal', placeType: 'destination' },
  toPlace: { id: 14, name: 'Badian', placeType: 'destination' },
  reverseEnabled: false,
  slug: 'moalboal-to-badian',
  estimatedDurationMinutes: 30,
  freeCancelHours: 24,
  inclusionsText: null,
  exclusionsText: null,
  pricingMode: 'per_vehicle',
  minPayingPax: 1,
  pageTitle: 'Moalboal to Badian Private Transfer',
  reversePageTitle: null,
  vehiclePrices: [],
};

const ROUTES = [REVERSIBLE, NON_REVERSIBLE, RELATED, UNRELATED_SHARES_DROPOFF_ONLY];

function renderAt(entry: string) {
  return render(
    <TrpcProviders>
      <MemoryRouter initialEntries={[entry]}>
        <Routes>
          <Route path="/transfers/:slug" element={<TransferRoutePage />} />
        </Routes>
      </MemoryRouter>
    </TrpcProviders>,
  );
}

afterEach(() => {
  resetTrpcMock();
  vi.mocked(trackEvent).mockClear();
});

describe('TransferRoutePage — forward direction', () => {
  it("renders the forward route's own H1 and content", async () => {
    mockTrpc({ 'transferRoutes.list': ROUTES });
    renderAt('/transfers/mactan-airport-to-moalboal');

    await screen.findByRole('heading', {
      name: /private transfer from mactan-cebu international airport to moalboal/i,
    });
  });

  it("sets document.title to the route's own pageTitle, verbatim", async () => {
    mockTrpc({ 'transferRoutes.list': ROUTES });
    renderAt('/transfers/mactan-airport-to-moalboal');

    await screen.findByRole('heading', { name: /private transfer from/i });
    expect(document.title).toBe(REVERSIBLE.pageTitle);
  });

  it('"Book this transfer" preselects routeId and direction=forward', async () => {
    mockTrpc({ 'transferRoutes.list': ROUTES });
    renderAt('/transfers/mactan-airport-to-moalboal');

    const bookLink = await screen.findByRole('link', { name: /book this transfer/i });
    expect(bookLink).toHaveAttribute(
      'href',
      '/transfer?productType=transfer_one_way&routeId=1&direction=forward',
    );
  });

  it('shows a cross-link to the reverse direction page when reverseEnabled', async () => {
    mockTrpc({ 'transferRoutes.list': ROUTES });
    renderAt('/transfers/mactan-airport-to-moalboal');

    const reverseLink = await screen.findByRole('link', {
      name: /moalboal to mactan-cebu international airport transfer page/i,
    });
    expect(reverseLink).toHaveAttribute('href', '/transfers/moalboal-to-mactan-airport');
  });

  it('lists related routes sharing the same pickup/dropoff place id', async () => {
    mockTrpc({ 'transferRoutes.list': ROUTES });
    renderAt('/transfers/mactan-airport-to-moalboal');

    const relatedLink = await screen.findByRole('link', {
      name: /mactan-cebu international airport to cebu city/i,
    });
    expect(relatedLink).toHaveAttribute('href', '/transfers/mactan-airport-to-cebu-city');
  });

  /**
   * Final review fix 1. The heading reads "Other transfers from
   * Mactan-Cebu International Airport" (pickupPlace.name) — a route that
   * only shares the DROPOFF place (Moalboal) and never touches the airport
   * must not be listed under it, or the heading states a false relationship.
   */
  it('does not list a route that shares only the dropoff place, with nothing in common with the pickup place', async () => {
    mockTrpc({ 'transferRoutes.list': ROUTES });
    renderAt('/transfers/mactan-airport-to-moalboal');

    await screen.findByRole('heading', {
      name: /private transfer from mactan-cebu international airport to moalboal/i,
    });
    expect(screen.queryByRole('link', { name: /moalboal to badian/i })).not.toBeInTheDocument();
  });
});

describe('TransferRoutePage — reverse direction', () => {
  it('a derived reverse slug renders the SAME route with pickup/dropoff swapped', async () => {
    mockTrpc({ 'transferRoutes.list': ROUTES });
    const reverseSlug = reverseTransferRouteSlug(REVERSIBLE.slug);
    renderAt(`/transfers/${reverseSlug}`);

    await screen.findByRole('heading', {
      name: /private transfer from moalboal to mactan-cebu international airport/i,
    });
  });

  it("sets document.title to the route's reversePageTitle, verbatim — never the forward title", async () => {
    mockTrpc({ 'transferRoutes.list': ROUTES });
    const reverseSlug = reverseTransferRouteSlug(REVERSIBLE.slug);
    renderAt(`/transfers/${reverseSlug}`);

    await screen.findByRole('heading', { name: /private transfer from/i });
    expect(document.title).toBe(REVERSIBLE.reversePageTitle);
    expect(document.title).not.toBe(REVERSIBLE.pageTitle);
  });

  it('"Book this transfer" preselects the SAME routeId with direction=reverse', async () => {
    mockTrpc({ 'transferRoutes.list': ROUTES });
    const reverseSlug = reverseTransferRouteSlug(REVERSIBLE.slug);
    renderAt(`/transfers/${reverseSlug}`);

    const bookLink = await screen.findByRole('link', { name: /book this transfer/i });
    expect(bookLink).toHaveAttribute(
      'href',
      '/transfer?productType=transfer_one_way&routeId=1&direction=reverse',
    );
  });

  it('cross-links back to the forward direction page', async () => {
    mockTrpc({ 'transferRoutes.list': ROUTES });
    const reverseSlug = reverseTransferRouteSlug(REVERSIBLE.slug);
    renderAt(`/transfers/${reverseSlug}`);

    const forwardLink = await screen.findByRole('link', {
      name: /mactan-cebu international airport to moalboal transfer page/i,
    });
    expect(forwardLink).toHaveAttribute('href', '/transfers/mactan-airport-to-moalboal');
  });
});

describe('TransferRoutePage — not-available states', () => {
  it('an unknown slug renders the "not available" empty state', async () => {
    mockTrpc({ 'transferRoutes.list': ROUTES });
    renderAt('/transfers/does-not-exist');

    await screen.findByText(/this route isn't available/i);
    const link = screen.getByRole('link', { name: /see all transfers/i });
    expect(link).toHaveAttribute('href', '/transfer');
  });

  it("a reverseEnabled:false route's reverse slug ALSO renders the not-available state, never the forward content", async () => {
    mockTrpc({ 'transferRoutes.list': ROUTES });
    const reverseSlug = reverseTransferRouteSlug(NON_REVERSIBLE.slug);
    renderAt(`/transfers/${reverseSlug}`);

    await screen.findByText(/this route isn't available/i);
    expect(
      screen.queryByRole('heading', { name: /private transfer from/i }),
    ).not.toBeInTheDocument();
  });

  it('the not-available state has no cross-link to any direction', async () => {
    mockTrpc({ 'transferRoutes.list': ROUTES });
    renderAt('/transfers/does-not-exist');

    await screen.findByText(/this route isn't available/i);
    expect(screen.queryByRole('link', { name: /book this transfer/i })).not.toBeInTheDocument();
  });
});

describe('TransferRoutePage — view_route analytics (Task 12, review fix)', () => {
  it('fires view_route exactly once on mount, with the direction-resolved routeId/places, and not again on an unrelated re-render', async () => {
    mockTrpc({ 'transferRoutes.list': ROUTES });
    function Tree() {
      return (
        <TrpcProviders>
          <MemoryRouter initialEntries={['/transfers/mactan-airport-to-moalboal']}>
            <Routes>
              <Route path="/transfers/:slug" element={<TransferRoutePage />} />
            </Routes>
          </MemoryRouter>
        </TrpcProviders>
      );
    }
    const { rerender } = render(<Tree />);

    await screen.findByRole('heading', {
      name: /private transfer from mactan-cebu international airport to moalboal/i,
    });

    expect(trackEvent).toHaveBeenCalledTimes(1);
    expect(trackEvent).toHaveBeenCalledWith('view_route', {
      routeId: 1,
      fromPlace: 'Mactan-Cebu International Airport',
      toPlace: 'Moalboal',
      direction: 'forward',
    });

    /*
     * `view` (inside `TransferRoutePage.tsx`) is recomputed fresh on every
     * render — `matchRouteDirection` always returns a new object literal,
     * never memoized — so ANY re-render, including a background refetch of
     * `transferRoutes.list` that resolves to data the guest already has,
     * produces a new `view` reference and re-runs the `useEffect`. Forcing
     * a plain re-render here (same route, same data) reproduces exactly
     * that object-identity instability without needing to wire a real
     * network refetch through the test's own QueryClient. The fire-once
     * guard is keyed on the PRIMITIVE `view.slug`, not on `view` itself —
     * this is what must suppress the second real `trackEvent` call despite
     * the effect body running again.
     */
    rerender(<Tree />);

    expect(trackEvent).toHaveBeenCalledTimes(1);
  });

  it("keys the fire-once guard on the direction-specific slug — in-app navigation from a route's forward page to its reverse page (same route.id) fires a SECOND time, with the swapped places", async () => {
    mockTrpc({ 'transferRoutes.list': ROUTES });
    const user = userEvent.setup();
    renderAt('/transfers/mactan-airport-to-moalboal');

    await screen.findByRole('heading', { name: /private transfer from/i });
    expect(trackEvent).toHaveBeenCalledTimes(1);

    // Real in-app navigation (a click on the page's own cross-link),
    // within the SAME router/query-client instance — not a fresh render
    // with a different `initialEntries`, which `MemoryRouter` would ignore
    // after its first mount. Same `route.id` (1) both times; only the
    // REQUESTED slug differs, which is exactly what the fire-once guard
    // must key on rather than `route.id`.
    const reverseLink = await screen.findByRole('link', {
      name: /moalboal to mactan-cebu international airport transfer page/i,
    });
    await user.click(reverseLink);

    await screen.findByRole('heading', {
      name: /private transfer from moalboal to mactan-cebu international airport/i,
    });

    expect(trackEvent).toHaveBeenCalledTimes(2);
    expect(trackEvent).toHaveBeenLastCalledWith('view_route', {
      routeId: 1,
      fromPlace: 'Moalboal',
      toPlace: 'Mactan-Cebu International Airport',
      direction: 'reverse',
    });
  });
});

/** Shares `REVERSIBLE`'s shape but with a SECOND vehicle type offered. */
const MULTI_VEHICLE: TransferRoutePublicRow = {
  ...REVERSIBLE,
  id: 5,
  slug: 'mactan-airport-to-multi',
  reverseEnabled: false,
  reversePageTitle: null,
  pageTitle: 'Mactan-Cebu International Airport to Multi Private Transfer',
  vehiclePrices: [
    {
      vehicleTypeId: 1,
      vehicleTypeName: 'Van',
      slug: 'van',
      oneWayPriceCentavos: 250_000,
      dayUsePriceCentavos: 500_000,
      defaultSeats: 10,
    },
    {
      vehicleTypeId: 2,
      vehicleTypeName: 'Sedan',
      slug: 'sedan',
      oneWayPriceCentavos: 180_000,
      dayUsePriceCentavos: 400_000,
      defaultSeats: 4,
    },
  ],
};

/**
 * Final review fix 3 (cheap Minor). The "How much does this transfer cost?"
 * FAQ answer used to append ", depending on which vehicle you choose." even
 * for a route with exactly one offered vehicle type — mildly redundant/
 * misleading copy. The clause must appear only when `vehiclePrices.length`
 * is more than one.
 */
describe('TransferRoutePage — FAQ cost copy (final review fix 3)', () => {
  it('states the price with no "depending on which vehicle" clause when only one vehicle type is offered', async () => {
    mockTrpc({ 'transferRoutes.list': ROUTES });
    renderAt('/transfers/mactan-airport-to-moalboal');

    const answer = await screen.findByText(/^from ₱2,500 for the vehicle\.$/i);
    expect(answer.textContent).not.toMatch(/depending on which vehicle/i);
  });

  it('appends the "depending on which vehicle you choose" clause when more than one vehicle type is offered', async () => {
    mockTrpc({ 'transferRoutes.list': [MULTI_VEHICLE] });
    renderAt('/transfers/mactan-airport-to-multi');

    const answer = await screen.findByText(/depending on which vehicle you choose/i);
    expect(answer.textContent).toMatch(
      /^From ₱1,800 for the vehicle, depending on which vehicle you choose\.$/i,
    );
  });
});
