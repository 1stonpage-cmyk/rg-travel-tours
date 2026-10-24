/**
 * The tour editing screens (Week 7 plan, Task 7). `admin.tours.*` (Task 6)
 * is `adminProcedure('toursPricing')` server-side — owner only; what is
 * pinned here is what the SCREEN itself promises: active/inactive state in
 * words, a price typed in pesos reaching the mutation as integer centavos,
 * a two-step confirm for deactivating that never says "Delete", a denied
 * state rather than a blank screen for a refused role, and the server's own
 * sentence for a CONFLICT (a stop a trip has already reached).
 */
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import AdminToursPage from '@/pages/admin/AdminToursPage';
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
 * that file's own note rather than centralized.
 */
beforeAll(() => {
  const proto = window.Element.prototype as unknown as Record<string, unknown>;
  proto.hasPointerCapture = () => false;
  proto.setPointerCapture = () => {};
  proto.releasePointerCapture = () => {};
  proto.scrollIntoView = () => {};
});

const DESTINATIONS = [
  {
    id: 1,
    name: 'Moalboal',
    slug: 'moalboal',
    displayName: null,
    blurb: null,
    image: null,
    sortOrder: 0,
    featuredSortOrder: null,
    isFeatured: true,
  },
  {
    id: 2,
    name: 'Oslob',
    slug: 'oslob',
    displayName: null,
    blurb: null,
    image: null,
    sortOrder: 1,
    featuredSortOrder: null,
    isFeatured: true,
  },
];

const TOUR_ROW = {
  id: 1,
  slug: 'moalboal-island-hopping',
  title: 'Moalboal Island Hopping',
  destination: { id: 1, name: 'Moalboal' },
  isActive: true,
  isFeatured: false,
  sortOrder: 0,
  badge: 'none',
  durationHours: 8,
  groupsPerDay: 2,
  maxGuests: 12,
  fromPriceCentavos: 199900,
  priceTierCount: 1,
};

const RETIRED_ROW = {
  ...TOUR_ROW,
  id: 2,
  slug: 'retired-tour',
  title: 'Retired Tour',
  isActive: false,
  fromPriceCentavos: null,
  priceTierCount: 0,
};

const TOUR_DETAIL = {
  id: 1,
  slug: 'moalboal-island-hopping',
  title: 'Moalboal Island Hopping',
  destinationId: 1,
  summary: 'A day of island hopping.',
  about: 'Full details here.',
  inclusions: null,
  exclusions: null,
  durationHours: 8,
  groupsPerDay: 2,
  maxGuests: 12,
  freeCancelHours: 24,
  isFeatured: false,
  sortOrder: 0,
  badge: 'none',
  alertNote: null,
  seoTitle: null,
  seoDescription: null,
  ogImage: null,
  isActive: true,
  priceTiers: [{ id: 10, minPax: 1, maxPax: 4, pricePerPersonCentavos: 199900 }],
  images: [],
  itinerary: [
    { id: 20, sortOrder: 0, name: 'City pickup', description: null },
    { id: 21, sortOrder: 1, name: 'Island stop', description: null },
  ],
  addons: [],
};

/**
 * The page renders BOTH the phone card list and the laptop table at once
 * (CSS media queries do nothing in jsdom — `AdminVansPage.tsx` has the same
 * shape), so a tour's title appears twice. This picks the first match's row
 * ancestor, which works for either the `<li>` or the `<tr>`.
 */
async function firstRowFor(title: string): Promise<HTMLElement> {
  const matches = await screen.findAllByText(title);
  return matches[0]!.closest('li, tr') as HTMLElement;
}

function renderPage(extra: Record<string, unknown> = {}) {
  mockTrpc({
    'staffAuth.me': { userId: 1, role: 'owner', mustChangePassword: false },
    'destinations.list': DESTINATIONS,
    'admin.tours.list': [TOUR_ROW, RETIRED_ROW],
    ...extra,
  });
  return render(
    <TrpcProviders>
      <MemoryRouter>
        <AdminToursPage />
      </MemoryRouter>
    </TrpcProviders>,
  );
}

describe('pesosToCentavos', () => {
  it('converts a comma-formatted peso string to integer centavos', () => {
    expect(pesosToCentavos('1,999.00')).toBe(199900);
  });

  it('rejects a third decimal digit rather than guessing a rounding', () => {
    expect(pesosToCentavos('199.555')).toBeNull();
  });
});

describe('AdminToursPage', () => {
  it('shows active and inactive tours with the state in words', async () => {
    renderPage();
    await screen.findAllByText('Moalboal Island Hopping');
    expect(screen.getAllByText('Retired Tour').length).toBeGreaterThan(0);

    const rows = screen.getAllByText(/^(Active|Inactive)$/);
    const texts = rows.map((node) => node.textContent);
    expect(texts).toContain('Active');
    expect(texts).toContain('Inactive');
  });

  it('submits a price typed in pesos as integer centavos', async () => {
    const sent: unknown[] = [];
    renderPage({
      'admin.tours.create': (input: unknown) => {
        sent.push(input);
        return { id: 99 };
      },
    });
    await screen.findAllByText('Moalboal Island Hopping');

    await user.click(screen.getByRole('button', { name: /add a tour/i }));

    await user.type(screen.getByLabelText('Title'), 'Sunset Cruise');
    await user.type(screen.getByLabelText('Slug'), 'sunset-cruise');
    await user.click(screen.getByLabelText('Destination'));
    await user.click(await screen.findByRole('option', { name: 'Moalboal' }));
    const groups = screen.getByLabelText('Groups per day') as HTMLInputElement;
    await user.clear(groups);
    await user.type(groups, '2');
    const guests = screen.getByLabelText('Max guests per group') as HTMLInputElement;
    await user.clear(guests);
    await user.type(guests, '12');

    await user.click(screen.getByRole('button', { name: /add a price tier/i }));
    await user.type(screen.getByLabelText(/minimum guests/i), '1');
    await user.type(screen.getByLabelText(/maximum guests/i), '4');
    await user.type(screen.getByLabelText(/price per person/i), '1,999.00');

    await user.click(screen.getByRole('button', { name: /^add tour$/i }));

    await waitFor(() => expect(sent).toHaveLength(1));
    const payload = sent[0] as { priceTiers: Array<{ pricePerPersonCentavos: number }> };
    expect(payload.priceTiers[0]!.pricePerPersonCentavos).toBe(199900);
    expect(Number.isInteger(payload.priceTiers[0]!.pricePerPersonCentavos)).toBe(true);
  });

  it('asks before deactivating, and says "Deactivate", never "Delete"', async () => {
    const calls: unknown[] = [];
    renderPage({
      'admin.tours.setActive': (input: unknown) => {
        calls.push(input);
        return { ok: true };
      },
    });
    const row = await firstRowFor('Moalboal Island Hopping');

    expect(screen.queryByText(/delete/i)).toBeNull();
    await user.click(within(row).getByRole('button', { name: /deactivate/i }));
    expect(calls).toHaveLength(0);
    expect(screen.queryByText(/delete/i)).toBeNull();

    await user.click(screen.getByRole('button', { name: /yes, deactivate/i }));
    await waitFor(() => expect(calls).toEqual([{ id: 1, isActive: false }]));
    expect(screen.queryByText(/delete/i)).toBeNull();
  });

  it('shows the denied state, not a blank screen, when the role is refused', async () => {
    renderPage({ 'staffAuth.me': { userId: 2, role: 'dispatcher', mustChangePassword: false } });
    expect(
      await screen.findByText(/only the owner can manage tours and pricing/i),
    ).toBeInTheDocument();
    expect(screen.queryByText('Moalboal Island Hopping')).toBeNull();
  });

  it('shows the denied state when the list call itself is refused with FORBIDDEN', async () => {
    mockTrpcError('admin.tours.list', 'FORBIDDEN', 'Not allowed for your role.');
    mockTrpc({
      'staffAuth.me': { userId: 1, role: 'owner', mustChangePassword: false },
      'destinations.list': DESTINATIONS,
    });
    render(
      <TrpcProviders>
        <MemoryRouter>
          <AdminToursPage />
        </MemoryRouter>
      </TrpcProviders>,
    );
    expect(
      await screen.findByText(/only the owner can manage tours and pricing/i),
    ).toBeInTheDocument();
    expect(screen.queryByText('Not allowed for your role.')).toBeNull();
  });

  it("shows the server's own CONFLICT message when a stop removal is refused", async () => {
    renderPage({ 'admin.tours.detail': TOUR_DETAIL });
    mockTrpcError(
      'admin.tours.update',
      'CONFLICT',
      'Cannot remove "City pickup" — a trip has already checked in there.',
    );
    const row = await firstRowFor('Moalboal Island Hopping');
    await user.click(within(row).getByRole('button', { name: 'Edit' }));

    await screen.findByDisplayValue('Moalboal Island Hopping');
    const removeButtons = await screen.findAllByRole('button', { name: /remove stop/i });
    await user.click(removeButtons[0]!);

    await user.click(screen.getByRole('button', { name: /^save changes$/i }));

    expect(
      await screen.findByText('Cannot remove "City pickup" — a trip has already checked in there.'),
    ).toBeInTheDocument();
  });
});
