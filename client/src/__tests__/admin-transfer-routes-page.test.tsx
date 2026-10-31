/**
 * The transfer-routes admin screen (transfers-launch plan, Task T4).
 * `admin.transferRoutes.*` is `adminProcedure('toursPricing')` server-side —
 * owner only; what is pinned here is what the SCREEN itself promises: both
 * vehicle types' prices rendered in pesos for every route (active and
 * inactive alike), a price typed in pesos reaching the `create` mutation as
 * integer CENTAVOS — the one conversion this screen exists to get right —
 * and the server's own ambiguous duplicate-destination/slug `CONFLICT`
 * sentence shown as a friendly banner rather than raw JSON.
 */
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import AdminTransferRoutesPage from '@/pages/admin/AdminTransferRoutesPage';
import { TrpcProviders } from '@/lib/trpc';
import { pesosToCentavos } from '@/lib/money-input';
import { mockTrpc, mockTrpcError, resetTrpcMock } from './helpers/mock-trpc';

const user = userEvent.setup();

afterEach(() => {
  resetTrpcMock();
});

/*
 * Radix's `Select` (the Destination field) needs three DOM APIs jsdom does
 * not implement — see `assign-panel.test.tsx`'s identical shim, copied per
 * that file's own note rather than centralized (also used by
 * `admin-tours-page.test.tsx` and `admin-vans-page.test.tsx` for the same
 * reason).
 */
beforeAll(() => {
  const proto = window.Element.prototype as unknown as Record<string, unknown>;
  proto.hasPointerCapture = () => false;
  proto.setPointerCapture = () => {};
  proto.releasePointerCapture = () => {};
  proto.scrollIntoView = () => {};
});

const DESTINATIONS = [
  { id: 10, name: 'Mactan Airport', slug: 'mactan-airport' },
  { id: 20, name: 'Oslob', slug: 'oslob' },
];

const AIRPORT_ROUTE = {
  id: 1,
  destinationId: 10,
  destinationName: 'Mactan Airport',
  slug: 'mactan-airport',
  isActive: true,
  sortOrder: 0,
  estimatedDurationMinutes: 45,
  freeCancelHours: 24,
  inclusionsText: 'Fuel, driver, tolls',
  exclusionsText: 'Meals',
  prices: {
    van: { oneWayPriceCentavos: 150_000, dayUsePriceCentavos: 350_000 },
    suv: { oneWayPriceCentavos: 180_000, dayUsePriceCentavos: 400_000 },
  },
};

const OSLOB_ROUTE = {
  id: 2,
  destinationId: 20,
  destinationName: 'Oslob',
  slug: 'oslob-whale-sharks',
  isActive: false,
  sortOrder: 1,
  estimatedDurationMinutes: 150,
  freeCancelHours: 48,
  inclusionsText: null,
  exclusionsText: null,
  prices: {
    van: { oneWayPriceCentavos: 250_000, dayUsePriceCentavos: 500_000 },
    suv: { oneWayPriceCentavos: 300_000, dayUsePriceCentavos: 600_000 },
  },
};

function renderPage(extra: Record<string, unknown> = {}) {
  mockTrpc({
    'staffAuth.me': { userId: 1, role: 'owner', mustChangePassword: false },
    'destinations.list': DESTINATIONS,
    'admin.transferRoutes.list': [AIRPORT_ROUTE, OSLOB_ROUTE],
    ...extra,
  });
  return render(
    <TrpcProviders>
      <MemoryRouter>
        <AdminTransferRoutesPage />
      </MemoryRouter>
    </TrpcProviders>,
  );
}

describe('AdminTransferRoutesPage', () => {
  it('renders every route, active and inactive, with both vehicle types’ prices formatted in pesos', async () => {
    renderPage();
    await screen.findAllByText('Mactan Airport');
    expect(screen.getAllByText('Oslob').length).toBeGreaterThan(0);

    const states = screen.getAllByText(/^(Active|Inactive)$/).map((node) => node.textContent);
    expect(states).toContain('Active');
    expect(states).toContain('Inactive');

    // Formatted in pesos via `formatPeso` — never the raw centavos figures
    // (`150000`, `350000`, ...) the server actually stores.
    expect(screen.getAllByText('Van: ₱1,500 one-way · ₱3,500 day-use').length).toBeGreaterThan(0);
    expect(screen.getAllByText('SUV: ₱1,800 one-way · ₱4,000 day-use').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Van: ₱2,500 one-way · ₱5,000 day-use').length).toBeGreaterThan(0);
    expect(screen.getAllByText('SUV: ₱3,000 one-way · ₱6,000 day-use').length).toBeGreaterThan(0);

    expect(screen.queryByText('150000')).toBeNull();
    expect(screen.queryByText('350000')).toBeNull();
  });

  /**
   * **The most important test in this file.** A peso-to-centavos conversion
   * bug here is a real money bug — a route could silently charge 100x (or
   * 1/100th) what the owner typed. This asserts on the actual object handed
   * to `admin.transferRoutes.create`, not on anything the screen merely
   * displays back.
   */
  it('submits all four prices typed in pesos as integer centavos, not pesos', async () => {
    const sent: unknown[] = [];
    renderPage({
      'admin.transferRoutes.create': (input: unknown) => {
        sent.push(input);
        return { id: 99 };
      },
    });
    await screen.findAllByText('Mactan Airport');

    await user.click(screen.getByRole('button', { name: /add a transfer route/i }));

    await user.click(screen.getByLabelText('Destination'));
    await user.click(await screen.findByRole('option', { name: 'Oslob' }));
    await user.type(screen.getByLabelText('Slug'), 'oslob-pier');
    await user.type(screen.getByLabelText('Estimated duration (minutes)'), '150');
    await user.type(screen.getByLabelText('Free cancellation window (hours)'), '48');
    await user.type(screen.getByLabelText('Van — one-way price (pesos)'), '1,500.00');
    await user.type(screen.getByLabelText('Van — day-use price (pesos)'), '3,500.00');
    await user.type(screen.getByLabelText('SUV — one-way price (pesos)'), '1,800.50');
    await user.type(screen.getByLabelText('SUV — day-use price (pesos)'), '4,000.00');

    await user.click(screen.getByRole('button', { name: /^add route$/i }));

    await waitFor(() => expect(sent).toHaveLength(1));
    const payload = sent[0] as {
      destinationId: number;
      slug: string;
      prices: {
        van: { oneWayPriceCentavos: number; dayUsePriceCentavos: number };
        suv: { oneWayPriceCentavos: number; dayUsePriceCentavos: number };
      };
    };

    expect(payload.destinationId).toBe(20);
    expect(payload.slug).toBe('oslob-pier');
    expect(payload.prices.van.oneWayPriceCentavos).toBe(pesosToCentavos('1,500.00'));
    expect(payload.prices.van.oneWayPriceCentavos).toBe(150_000);
    expect(payload.prices.van.dayUsePriceCentavos).toBe(350_000);
    expect(payload.prices.suv.oneWayPriceCentavos).toBe(180_050);
    expect(payload.prices.suv.dayUsePriceCentavos).toBe(400_000);

    // The bug this test exists to catch: sending the typed PESO number
    // (1500) rather than the converted CENTAVOS number (150000).
    expect(payload.prices.van.oneWayPriceCentavos).not.toBe(1_500);
    for (const value of Object.values(payload.prices.van).concat(
      Object.values(payload.prices.suv),
    )) {
      expect(Number.isInteger(value)).toBe(true);
    }
  });

  it('shows the server’s own ambiguous duplicate-destination/slug CONFLICT as a friendly banner, not raw JSON', async () => {
    renderPage();
    await screen.findAllByText('Mactan Airport');

    const duplicateMessage =
      'A transfer route already exists for that destination, or that slug is already taken. ' +
      'A retired route still holds both — reactivate it instead of creating a second one.';
    mockTrpcError('admin.transferRoutes.create', 'CONFLICT', duplicateMessage);

    await user.click(screen.getByRole('button', { name: /add a transfer route/i }));
    await user.click(screen.getByLabelText('Destination'));
    await user.click(await screen.findByRole('option', { name: 'Oslob' }));
    await user.type(screen.getByLabelText('Slug'), 'oslob-pier');
    await user.type(screen.getByLabelText('Estimated duration (minutes)'), '150');
    await user.type(screen.getByLabelText('Free cancellation window (hours)'), '48');
    await user.type(screen.getByLabelText('Van — one-way price (pesos)'), '1,500.00');
    await user.type(screen.getByLabelText('Van — day-use price (pesos)'), '3,500.00');
    await user.type(screen.getByLabelText('SUV — one-way price (pesos)'), '1,800.00');
    await user.type(screen.getByLabelText('SUV — day-use price (pesos)'), '4,000.00');

    await user.click(screen.getByRole('button', { name: /^add route$/i }));

    expect(await screen.findByText(duplicateMessage)).toBeInTheDocument();
    // The bug this guards against: tRPC's own default `ZodError` rendering
    // is `JSON.stringify(issues, null, 2)`, which reads like `[{"code":`.
    expect(screen.queryByText(/"code":/)).toBeNull();
  });

  it('shows the denied state, not a blank screen, when the role is refused', async () => {
    renderPage({ 'staffAuth.me': { userId: 2, role: 'dispatcher', mustChangePassword: false } });
    expect(
      await screen.findByText(/only the owner can manage transfer routes/i),
    ).toBeInTheDocument();
    expect(screen.queryByText('Mactan Airport')).toBeNull();
  });
});
