import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import CatalogPreview from '@/components/home/CatalogPreview';
import { TrpcProviders } from '@/lib/trpc';
import type { TourListItem } from '../../../server/src/routers/public/tours';
import { DESTINATIONS_FIXTURE, TOURS_FIXTURE } from './helpers/fixtures';
import { mockTrpc, mockTrpcError } from './helpers/mock-trpc';

function renderCatalog() {
  return render(
    <TrpcProviders>
      <MemoryRouter>
        <CatalogPreview />
      </MemoryRouter>
    </TrpcProviders>,
  );
}

describe('CatalogPreview — live data', () => {
  it('shows skeletons first, then the grid once tours.list resolves', async () => {
    let resolveTours!: (tours: TourListItem[]) => void;
    const deferred = new Promise<TourListItem[]>((resolve) => {
      resolveTours = resolve;
    });
    mockTrpc({
      'destinations.list': DESTINATIONS_FIXTURE,
      'tours.list': () => deferred,
    });

    renderCatalog();

    // Pending: the skeleton grid is up, no real card headings yet.
    expect(screen.getAllByRole('status', { name: /loading tour/i }).length).toBeGreaterThan(0);
    expect(screen.queryByRole('heading', { level: 3 })).not.toBeInTheDocument();

    resolveTours(TOURS_FIXTURE);

    // Resolved: the real grid replaces the skeleton.
    expect(
      await screen.findByRole('heading', { level: 3, name: /Oslob Whale Sharks/i }),
    ).toBeInTheDocument();
    expect(screen.queryAllByRole('status', { name: /loading tour/i })).toHaveLength(0);
  });

  it('shows a friendly error when tours fail to load, never the raw error text', async () => {
    mockTrpc({ 'destinations.list': DESTINATIONS_FIXTURE });
    mockTrpcError('tours.list');

    renderCatalog();

    expect(
      await screen.findByText(/tours could not load/i, {}, { timeout: 3000 }),
    ).toBeInTheDocument();
    expect(screen.queryByText(/mock failure/i)).not.toBeInTheDocument();
  });

  it('shows an empty state when the selected destination has no tours', async () => {
    const user = userEvent.setup();
    // Every tour in this list belongs to Oslob; Mactan (also in the
    // destination fixture) has none, so selecting it must empty the grid.
    const oslobOnly: TourListItem[] = [TOURS_FIXTURE[0]!];
    mockTrpc({
      'destinations.list': DESTINATIONS_FIXTURE,
      'tours.list': oslobOnly,
    });

    renderCatalog();

    const group = await screen.findByRole('group', { name: /filter tours by destination/i });
    const mactanChip = await within(group).findByRole('button', { name: 'Mactan' });
    await user.click(mactanChip);

    expect(
      await screen.findByText(/no tours listed for this destination yet/i),
    ).toBeInTheDocument();
    expect(screen.queryByRole('heading', { level: 3 })).not.toBeInTheDocument();
  });

  // The DOM order must equal the API's array order exactly — the catalog
  // must not re-sort. Proven non-tautological: this fixture's order is
  // deliberately NOT what sorting by id, by title, or by `isFeatured`
  // (descending) would produce, so any of those "obvious" client-side
  // sorts would move a card and fail this test.
  it('renders tours in exactly the order the API returned them, without re-sorting', async () => {
    const destination = { id: 6, name: 'Oslob', slug: 'oslob' };
    const base = TOURS_FIXTURE[0]!;
    const apiOrder: TourListItem[] = [
      { ...base, id: 30, slug: 'zebra-tour', title: 'Zebra Tour', destination, isFeatured: false },
      { ...base, id: 10, slug: 'apple-tour', title: 'Apple Tour', destination, isFeatured: true },
      { ...base, id: 20, slug: 'mango-tour', title: 'Mango Tour', destination, isFeatured: false },
    ];
    mockTrpc({ 'destinations.list': DESTINATIONS_FIXTURE, 'tours.list': apiOrder });

    renderCatalog();

    const headings = await screen.findAllByRole('heading', { level: 3 });
    expect(headings.map((h) => h.textContent)).toEqual(['Zebra Tour', 'Apple Tour', 'Mango Tour']);
  });
});
