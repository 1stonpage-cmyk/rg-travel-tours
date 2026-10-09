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
    // A client-filtered-to-zero array, not a literal `tours.list -> []` —
    // deliberately: the server is never asked to pre-filter by destination
    // (see the brief's "do not pass the destination through to the server"),
    // so this is the actually-reachable empty case. It collapses to the same
    // `filtered.length === 0` branch a literal `[]` would hit in CatalogGrid.
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

// I1 (review round 1): the chip row sits above the grid, so if its skeleton's
// height ever drifts from the real chip's, everything below it shifts on
// load — the exact BUG-055 failure mode, in the one place nothing was
// watching. Anchored against the real chip's own class (like
// query-boundary.test.tsx's TourCardSkeleton suite), not a hardcoded string,
// so this fails if either side changes, not just the skeleton.
describe('ChipRowSkeleton — no layout shift', () => {
  it('renders skeleton bars while destinations are pending', () => {
    mockTrpc({
      'destinations.list': () => new Promise<never>(() => {}),
      'tours.list': TOURS_FIXTURE,
    });

    renderCatalog();

    const group = screen.getByRole('group', { name: /filter tours by destination/i });
    const bars = group.querySelectorAll('.animate-pulse');
    expect(
      bars.length,
      'expected at least one skeleton bar in the pending chip row',
    ).toBeGreaterThan(0);
    expect(within(group).queryByRole('button')).not.toBeInTheDocument();
  });

  it("the skeleton bar's height matches the real chip's min-height, both read from their own classes", async () => {
    // Probe 1: pending — read the skeleton bar's own height class.
    mockTrpc({
      'destinations.list': () => new Promise<never>(() => {}),
      'tours.list': TOURS_FIXTURE,
    });
    const pending = renderCatalog();
    const pendingGroup = screen.getByRole('group', { name: /filter tours by destination/i });
    const bar = pendingGroup.querySelector('.animate-pulse');
    expect(bar, 'expected a skeleton bar in the pending chip row').toBeTruthy();
    const barHeight = Array.from(bar!.classList).find((c) => /^h-\d+$/.test(c));
    expect(barHeight, 'skeleton bar has no h-<n> height class').toBeTruthy();
    pending.unmount();

    // Probe 2: resolved — read the real chip's own min-height class.
    mockTrpc({ 'destinations.list': DESTINATIONS_FIXTURE, 'tours.list': TOURS_FIXTURE });
    renderCatalog();
    const loadedGroup = await screen.findByRole('group', { name: /filter tours by destination/i });
    const realChip = await within(loadedGroup).findByRole('button', { name: 'All tours' });
    const chipMinHeight = Array.from(realChip.classList).find((c) => /^min-h-\d+$/.test(c));
    expect(chipMinHeight, 'real chip has no min-h-<n> class').toBeTruthy();

    // Anchored comparison: both numbers must match, whichever they are.
    expect(barHeight!.replace(/^h-/, '')).toBe(chipMinHeight!.replace(/^min-h-/, ''));
  });
});

// I2 (review round 1): two independent QueryBoundarys in one component is
// exactly the structure a future refactor could accidentally hoist into one,
// letting a single failure blank the whole section. Both directions are
// covered, and each asserts the *other* half is still fully present and
// usable — not just that its own error text appeared.
describe('the two QueryBoundarys fail independently', () => {
  it('keeps the destination chips rendered and clickable when tours.list fails', async () => {
    const user = userEvent.setup();
    mockTrpc({ 'destinations.list': DESTINATIONS_FIXTURE });
    mockTrpcError('tours.list');

    renderCatalog();

    // The grid shows its own error...
    expect(
      await screen.findByText(/tours could not load/i, {}, { timeout: 3000 }),
    ).toBeInTheDocument();

    // ...while the destination chips are fully present and interactive.
    const group = screen.getByRole('group', { name: /filter tours by destination/i });
    const mactanChip = within(group).getByRole('button', { name: 'Mactan' });
    expect(mactanChip).toHaveAttribute('aria-pressed', 'false');
    await user.click(mactanChip);
    expect(mactanChip).toHaveAttribute('aria-pressed', 'true');
  });

  it('keeps the full tour grid rendered when destinations.list fails', async () => {
    mockTrpc({ 'tours.list': TOURS_FIXTURE });
    mockTrpcError('destinations.list');

    renderCatalog();

    // The chip row shows its own error...
    expect(
      await screen.findByText(/destinations could not load/i, {}, { timeout: 3000 }),
    ).toBeInTheDocument();

    // ...while the grid rendered every tour from the (successful) tours.list call.
    const headings = await screen.findAllByRole('heading', { level: 3 });
    expect(headings).toHaveLength(TOURS_FIXTURE.length);
  });
});
