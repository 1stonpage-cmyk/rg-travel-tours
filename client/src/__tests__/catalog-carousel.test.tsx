/**
 * Mobile tour-card carousel (spec task 2.9A) — the dot pagination controls,
 * and the "no layout shift between skeleton and loaded carousel" guarantee
 * that CatalogPreview's own long-standing comment calls out.
 *
 * Deliberately a separate file from catalog.test.tsx: that file is called
 * out by the task brief as the most contested file in the project (four
 * separate pieces of recent work land in CatalogPreview.tsx), so new
 * carousel-only assertions live here instead of growing that file further.
 */
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import CatalogPreview from '@/components/home/CatalogPreview';
import { TrpcProviders } from '@/lib/trpc';
import { DESTINATIONS_FIXTURE, TOURS_FIXTURE } from './helpers/fixtures';
import { mockTrpc } from './helpers/mock-trpc';

function renderCatalog() {
  return render(
    <TrpcProviders>
      <MemoryRouter>
        <CatalogPreview />
      </MemoryRouter>
    </TrpcProviders>,
  );
}

function stubMatchMedia(reduced: boolean) {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: reduced,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
}

describe('CatalogPreview — mobile carousel dot indicator', () => {
  beforeEach(() => {
    mockTrpc({ 'destinations.list': DESTINATIONS_FIXTURE, 'tours.list': TOURS_FIXTURE });
  });

  it('renders one real, keyboard-reachable button per card, each with its own accessible name', async () => {
    renderCatalog();

    const pagination = await screen.findByRole('group', { name: /tour carousel pagination/i });
    const dots = within(pagination).getAllByRole('button');
    expect(dots).toHaveLength(TOURS_FIXTURE.length);

    dots.forEach((dot, i) => {
      expect(dot).toHaveAccessibleName(`Go to tour ${i + 1} of ${TOURS_FIXTURE.length}`);
    });

    // Real controls, not decoration: tab order reaches every one of them.
    const user = userEvent.setup();
    dots[0]!.focus();
    expect(document.activeElement).toBe(dots[0]);
    for (let i = 1; i < dots.length; i++) {
      await user.tab();
      expect(document.activeElement).toBe(dots[i]);
    }
  });

  it('marks only the first dot current on initial load, via aria-current', async () => {
    renderCatalog();

    const pagination = await screen.findByRole('group', { name: /tour carousel pagination/i });
    const dots = within(pagination).getAllByRole('button');

    expect(dots[0]).toHaveAttribute('aria-current', 'true');
    for (const dot of dots.slice(1)) {
      expect(dot).not.toHaveAttribute('aria-current');
    }
  });

  it('gives every dot a 44px tap target even though the visible dot is small', async () => {
    renderCatalog();

    const pagination = await screen.findByRole('group', { name: /tour carousel pagination/i });
    for (const dot of within(pagination).getAllByRole('button')) {
      expect(dot).toHaveClass('tap-target');
    }
  });

  // Fix round 1 (F1): every destination in TOURS_FIXTURE resolves to exactly
  // one tour, so this single-result state is not a rare edge case — it's
  // what happens on every destination chip except "All tours". Omitting the
  // whole pagination container here used to collapse the row and shift
  // everything below it. The fix: no dot *buttons* for one card (nothing
  // to paginate), but the container itself stays mounted and keeps
  // reserving its height, so nothing jumps.
  it('renders no dot buttons for a single-result filter, but keeps the pagination row mounted and reserving its height', async () => {
    const user = userEvent.setup();
    renderCatalog();

    const group = await screen.findByRole('group', { name: /filter tours by destination/i });
    // Mactan has exactly one tour in TOURS_FIXTURE.
    const mactanChip = await within(group).findByRole('button', { name: 'Mactan' });
    await user.click(mactanChip);

    await screen.findByRole('heading', { level: 3, name: /Mactan Island Hopping/i });

    const pagination = screen.getByRole('group', { name: /tour carousel pagination/i });
    expect(pagination).toBeInTheDocument();
    expect(within(pagination).queryAllByRole('button')).toHaveLength(0);
    // Reserves the 44px row height on its own, not via a dot button child.
    expect(pagination).toHaveClass('min-h-11');
  });

  describe('clicking a dot', () => {
    let scrollIntoView: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      scrollIntoView = vi.fn();
      Element.prototype.scrollIntoView = scrollIntoView;
    });

    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it('scrolls the target card smoothly when motion is allowed', async () => {
      const user = userEvent.setup();
      renderCatalog();

      const pagination = await screen.findByRole('group', { name: /tour carousel pagination/i });
      const dots = within(pagination).getAllByRole('button');
      await user.click(dots[2]!);

      expect(scrollIntoView).toHaveBeenCalledTimes(1);
      expect(scrollIntoView).toHaveBeenCalledWith(expect.objectContaining({ behavior: 'smooth' }));
    });

    it('jumps instantly instead of smooth-scrolling under prefers-reduced-motion', async () => {
      stubMatchMedia(true);
      const user = userEvent.setup();
      renderCatalog();

      const pagination = await screen.findByRole('group', { name: /tour carousel pagination/i });
      const dots = within(pagination).getAllByRole('button');
      await user.click(dots[1]!);

      expect(scrollIntoView).toHaveBeenCalledTimes(1);
      expect(scrollIntoView).toHaveBeenCalledWith(expect.objectContaining({ behavior: 'auto' }));
    });
  });
});

describe('CatalogPreview — mobile carousel layout, no layout shift', () => {
  it('carries native CSS scroll-snap on mobile and the pre-existing grid classes at md and up', async () => {
    mockTrpc({ 'destinations.list': DESTINATIONS_FIXTURE, 'tours.list': TOURS_FIXTURE });
    renderCatalog();

    const heading = await screen.findByRole('heading', { level: 3, name: TOURS_FIXTURE[0]!.title });
    const grid = heading.closest('ul') as HTMLElement;

    // Mobile (<768px): a horizontal swipe row.
    expect(grid).toHaveClass('overflow-x-auto');
    expect(grid).toHaveClass('snap-x');
    expect(grid).toHaveClass('snap-mandatory');

    // >=768px: exactly the classes the pre-carousel grid used to carry
    // (gap-6 / grid-cols-2 / lg:grid-cols-3), so the desktop layout this
    // produces is unchanged.
    expect(grid).toHaveClass('md:grid');
    expect(grid).toHaveClass('md:gap-6');
    expect(grid).toHaveClass('md:grid-cols-2');
    expect(grid).toHaveClass('lg:grid-cols-3');

    // Every card is narrower than the row on mobile, so the next one peeks
    // in, and reverts to full grid-cell width at md and up.
    const card = heading.closest('li') as HTMLElement;
    expect(card).toHaveClass('shrink-0');
    expect(card).toHaveClass('snap-start');
    expect(card).toHaveClass('md:w-auto');
  });

  it('does not reorder cards — the carousel still renders in exact API order', async () => {
    const destination = { id: 6, name: 'Oslob', slug: 'oslob' };
    const base = TOURS_FIXTURE[0]!;
    const apiOrder = [
      { ...base, id: 30, slug: 'zebra-tour', title: 'Zebra Tour', destination, isFeatured: false },
      { ...base, id: 10, slug: 'apple-tour', title: 'Apple Tour', destination, isFeatured: true },
    ];
    mockTrpc({ 'destinations.list': DESTINATIONS_FIXTURE, 'tours.list': apiOrder });
    renderCatalog();

    const headings = await screen.findAllByRole('heading', { level: 3 });
    expect(headings.map((h) => h.textContent)).toEqual(['Zebra Tour', 'Apple Tour']);
  });

  // Anchored comparison, not a hardcoded belief about either side's shape —
  // the same pattern query-boundary.test.tsx uses for TourCardSkeleton vs
  // TourCard. If either side's carousel classes ever drift from the other,
  // the page would jump height the instant tours.list resolves.
  it("the loading skeleton's row carries the exact same classes as the loaded carousel row", async () => {
    mockTrpc({
      'destinations.list': DESTINATIONS_FIXTURE,
      'tours.list': () => new Promise<never>(() => {}),
    });
    const pending = renderCatalog();
    const skeletonRow = document.querySelector('ul[class*="snap-x"]') as HTMLElement;
    expect(skeletonRow, 'expected the skeleton to render a carousel-shaped row').toBeTruthy();
    const skeletonClasses = skeletonRow.className;
    pending.unmount();

    mockTrpc({ 'destinations.list': DESTINATIONS_FIXTURE, 'tours.list': TOURS_FIXTURE });
    renderCatalog();
    const heading = await screen.findByRole('heading', { level: 3, name: TOURS_FIXTURE[0]!.title });
    const loadedRow = heading.closest('ul') as HTMLElement;

    expect(loadedRow.className).toBe(skeletonClasses);
  });
});
