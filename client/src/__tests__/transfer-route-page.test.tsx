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
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it } from 'vitest';
import { reverseTransferRouteSlug, type TransferRoutePublicRow } from '@rg/shared';
import TransferRoutePage from '@/pages/public/TransferRoutePage';
import { TrpcProviders } from '@/lib/trpc';
import { mockTrpc, resetTrpcMock } from './helpers/mock-trpc';

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

const ROUTES = [REVERSIBLE, NON_REVERSIBLE, RELATED];

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
    expect(bookLink).toHaveAttribute('href', '/transfer?routeId=1&direction=forward');
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
    expect(bookLink).toHaveAttribute('href', '/transfer?routeId=1&direction=reverse');
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
