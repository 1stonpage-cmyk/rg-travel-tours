import { useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { Link } from 'react-router-dom';
import QueryBoundary from '@/components/common/QueryBoundary';
import { Skeleton, TourCardSkeleton } from '@/components/common/Skeleton';
import SectionHeading from '@/components/common/SectionHeading';
import TourCard from '@/components/common/TourCard';
import { Button } from '@/components/ui/button';
import { trpc } from '@/lib/trpc';
import { useCardStagger } from '@/lib/use-scroll-reveal';
import { cn } from '@/lib/utils';
import type { TourListItem } from '../../../../server/src/routers/public/tours';

const ALL = 'all';
const SKELETON_CHIP_COUNT = 6;
const SKELETON_CARD_COUNT = 6;

/**
 * Mobile (<768px): a horizontal swipe row using native CSS scroll-snap —
 * `snap-x snap-mandatory` on the row, `snap-start` on each card. Each card
 * is narrower than the row so the next one visibly peeks in, which is the
 * swipe affordance (spec task 2.9A).
 *
 * At `md` (768px) this becomes exactly the previous desktop grid. The
 * switch point moves from the old `sm:grid-cols-2` (640px) to `md:` (768px)
 * on purpose — the task's carousel range is "<768px", so the 640-767 slice
 * that used to be a 2-column grid is now carousel too, while every class
 * that actually paints anything at >=768px (`grid`, `gap-6`, `grid-cols-2`,
 * `lg:grid-cols-3`) is unchanged, so the desktop grid is byte-identical.
 *
 * Both constants are shared with CatalogGridSkeleton below so the skeleton
 * is the same shape as the loaded carousel — otherwise the page would jump
 * from a tall multi-row skeleton grid to a single-row carousel the instant
 * tours.list resolves, exactly the layout shift this task forbids.
 */
const CAROUSEL_LIST_CLASSES =
  'mt-8 flex gap-4 overflow-x-auto snap-x snap-mandatory md:grid md:gap-6 md:overflow-visible md:snap-none md:grid-cols-2 lg:grid-cols-3';
const CAROUSEL_ITEM_CLASSES = 'w-[84%] shrink-0 snap-start md:w-auto';

/**
 * Mirrors the guard `useHeroParallax` uses: jsdom (this project's test
 * environment) implements no `window.matchMedia` at all and throws if it is
 * called unstubbed, so this checks the function exists before ever calling it.
 */
function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/**
 * Tracks which card is most visible in the mobile carousel row, for the dot
 * indicator. Local to CatalogPreview — the only carousel in the app right
 * now, so this stays a small component-local hook (per the task's "small
 * local hooks only" constraint) rather than a shared lib addition.
 *
 * Same existence guard, same order, as useCardStagger/useCountUp: jsdom has
 * no IntersectionObserver, so every existing test that renders this
 * component without stubbing one exits here and simply reports index 0 —
 * no crash, and the first dot reads as current until a real browser runs
 * the observer.
 *
 * Re-runs on `itemsKey` (the active destination filter) changing: a filter
 * swap replaces which tours are rendered, so both the tracked index and the
 * row's own scroll position reset to the first card rather than leaving the
 * dots pointing at a position within the *new* list that happens to match
 * the old scrollLeft of the *previous* one.
 */
function useActiveCarouselCard(
  containerRef: RefObject<HTMLUListElement | null>,
  itemSelector: string,
  itemsKey: unknown,
) {
  const [active, setActive] = useState(0);

  useEffect(() => {
    const container = containerRef.current;
    setActive(0);
    if (!container) return;
    // Plain property, not `scrollTo()` — this project's jsdom (no test
    // polyfills it, unlike the targeted scrollIntoView polyfills elsewhere)
    // implements `scrollLeft` but not `Element.prototype.scrollTo`, and an
    // instant jump to the start needs no animation anyway.
    container.scrollLeft = 0;
    if (typeof IntersectionObserver === 'undefined') return;

    const items = Array.from(container.querySelectorAll<HTMLElement>(itemSelector));
    if (items.length === 0) return;

    const ratios = new Map<Element, number>();
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) ratios.set(entry.target, entry.intersectionRatio);
        let bestIndex = 0;
        let bestRatio = -1;
        for (const [i, item] of items.entries()) {
          const ratio = ratios.get(item) ?? 0;
          if (ratio > bestRatio) {
            bestRatio = ratio;
            bestIndex = i;
          }
        }
        setActive(bestIndex);
      },
      { root: container, threshold: [0, 0.25, 0.5, 0.75, 1] },
    );
    for (const item of items) observer.observe(item);

    return () => observer.disconnect();
  }, [itemsKey]);

  return active;
}

/**
 * Real, keyboard-reachable pagination controls for the mobile carousel —
 * not decorative dots. Each button has its own accessible name ("Go to
 * tour N of total") and `aria-current` on the one matching the row's
 * current scroll position, mirroring the destination chip row's own
 * role="group" + labelled-button pattern elsewhere in this file.
 *
 * Hidden at `md` and up: there is no carousel to paginate on the desktop
 * grid, so the controls are removed from the a11y tree there too, not just
 * visually.
 *
 * The visible dot is a tiny 8-10px circle, but the clickable button around
 * it is a full 44px tap target (`tap-target`), per the brief's explicit
 * callout that small indicators still need a real touch target.
 *
 * The container itself is ALWAYS rendered and carries its own `min-h-11` —
 * it reserves the row's height unconditionally; only the dot *buttons*
 * inside are conditional on `count > 1` (fix round 1, F1). Every one of
 * TOURS_FIXTURE's destinations resolves to exactly one tour today, so
 * `count` is 1 on the overwhelmingly common path — every destination chip
 * except "All tours" — not just in some rare skeleton edge case. Omitting
 * the whole container in that state collapsed the row and shifted
 * everything below it up, then back down the moment the filter cleared.
 * Hiding meaningless dots for a single card is still correct; collapsing
 * the space they occupied is not — so the container stays, and only its
 * contents are conditional.
 */
function CarouselDots({
  containerRef,
  count,
  active,
}: {
  containerRef: RefObject<HTMLUListElement | null>;
  count: number;
  active: number;
}) {
  const goTo = (index: number) => {
    const item = containerRef.current?.children[index] as HTMLElement | undefined;
    item?.scrollIntoView({
      behavior: prefersReducedMotion() ? 'auto' : 'smooth',
      inline: 'start',
      block: 'nearest',
    });
  };

  return (
    <div
      role="group"
      aria-label="Tour carousel pagination"
      className="mt-4 flex min-h-11 items-center justify-center gap-1 md:hidden"
    >
      {count > 1 &&
        Array.from({ length: count }, (_, i) => (
          <button
            key={i}
            type="button"
            aria-label={`Go to tour ${i + 1} of ${count}`}
            aria-current={active === i ? 'true' : undefined}
            onClick={() => goTo(i)}
            className="press tap-target flex items-center justify-center"
          >
            <span
              aria-hidden="true"
              className={cn(
                'block rounded-full',
                active === i ? 'bg-brand-blue-600 size-2.5' : 'bg-brand-blue-200 size-2',
              )}
            />
          </button>
        ))}
    </div>
  );
}

/** Same `min-h-11` height as the real chips, so the row below never shifts when data arrives. */
function ChipRowSkeleton() {
  return (
    <>
      {Array.from({ length: SKELETON_CHIP_COUNT }, (_, i) => (
        <Skeleton key={i} className="h-11 w-24 shrink-0 rounded-full" />
      ))}
    </>
  );
}

/**
 * Mirrors the real grid/carousel's own classes so swapping in the loaded
 * cards causes no layout shift — on mobile this means being the same
 * single-row carousel shape, not the old multi-row grid, with a matching
 * (non-interactive) dot row reserving the same space the real pagination
 * controls will occupy once tours.list resolves.
 */
function CatalogGridSkeleton() {
  return (
    <>
      <ul className={CAROUSEL_LIST_CLASSES}>
        {Array.from({ length: SKELETON_CARD_COUNT }, (_, i) => (
          <li key={i} className={CAROUSEL_ITEM_CLASSES}>
            <TourCardSkeleton />
          </li>
        ))}
      </ul>
      <div aria-hidden="true" className="mt-4 flex items-center justify-center gap-1 md:hidden">
        {Array.from({ length: SKELETON_CARD_COUNT }, (_, i) => (
          <span key={i} className="tap-target flex items-center justify-center">
            <Skeleton className="size-2 rounded-full" />
          </span>
        ))}
      </div>
    </>
  );
}

export default function CatalogPreview() {
  const [active, setActive] = useState<string>(ALL);
  const chipRow = useRef<HTMLDivElement>(null);

  const destinationsQuery = trpc.destinations.list.useQuery();
  const toursQuery = trpc.tours.list.useQuery({});

  /*
   * Edge fades that show a phone user the chip row scrolls (see .scroll-fade-x
   * in index.css). The two booleans are written straight onto the element as
   * data attributes rather than kept in React state: this runs on every scroll
   * frame, and re-rendering the whole tour grid to move a gradient would be
   * pure waste.
   *
   * Nothing here is required for the row to work — without a ResizeObserver,
   * or before this ever runs, both attributes are absent and the row is the
   * plain scrolling row it was before.
   *
   * The wrapper div below is always mounted — only its *contents* switch
   * between the chip skeleton and the real chips — so `chipRow.current` is
   * stable across the loading → loaded transition. The effect still depends
   * on the destinations payload so it re-measures once the real chips (which
   * can occupy very different total width than the skeleton bars) replace
   * the skeleton; a bare mount-only effect would freeze the fade state at
   * whatever the skeleton happened to need.
   */
  useEffect(() => {
    const row = chipRow.current;
    if (!row) return;
    if (typeof ResizeObserver === 'undefined') return;

    // Arrow consts, not function declarations: a hoisted declaration could in
    // principle run before the null check above, so TypeScript will not carry
    // the narrowing of `row` into one.
    const update = () => {
      const overflow = row.scrollWidth - row.clientWidth;
      // Sub-pixel layout and elastic overscroll leave scrollLeft a hair off 0
      // and off the maximum, so both ends need a tolerance or a fade flickers
      // while the row is sitting still.
      const fits = overflow <= 1;
      row.dataset.fadeStart = String(!fits && row.scrollLeft > 1);
      row.dataset.fadeEnd = String(!fits && row.scrollLeft < overflow - 1);
    };

    let frame = 0;
    const onScroll = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        update();
      });
    };

    // Catches the viewport resizing, an orientation flip, and the web font
    // landing — any of which changes whether the row overflows at all.
    const observer = new ResizeObserver(update);
    observer.observe(row);
    row.addEventListener('scroll', onScroll, { passive: true });
    update();

    return () => {
      observer.disconnect();
      row.removeEventListener('scroll', onScroll);
      if (frame) cancelAnimationFrame(frame);
      delete row.dataset.fadeStart;
      delete row.dataset.fadeEnd;
    };
  }, [destinationsQuery.data]);

  return (
    <section id="tours" className="mx-auto max-w-7xl px-4 py-16 sm:px-6 lg:px-8">
      <SectionHeading
        eyebrow="Day tours"
        title="Popular Cebu day tours"
        subtitle="Private van, licensed driver and a local guide on every trip. Prices drop as your group grows."
      />

      <div
        ref={chipRow}
        role="group"
        aria-label="Filter tours by destination"
        className="scroll-fade-x mt-6 flex gap-2 overflow-x-auto py-2"
      >
        <QueryBoundary
          query={destinationsQuery}
          skeleton={<ChipRowSkeleton />}
          errorTitle="Destinations could not load"
        >
          {(destinations) => (
            <>
              {[{ slug: ALL, name: 'All tours' }, ...destinations].map((f) => (
                <button
                  key={f.slug}
                  type="button"
                  aria-pressed={active === f.slug}
                  onClick={() => setActive(f.slug)}
                  className={cn(
                    'press min-h-11 shrink-0 rounded-full border px-4 text-sm font-medium transition-colors',
                    active === f.slug
                      ? 'bg-brand-blue-600 border-brand-blue-600 text-white'
                      : 'border-brand-blue-200 text-brand-blue-800 hover:bg-brand-blue-50',
                  )}
                >
                  {f.name}
                </button>
              ))}
            </>
          )}
        </QueryBoundary>
      </div>

      <QueryBoundary
        query={toursQuery}
        skeleton={<CatalogGridSkeleton />}
        errorTitle="Tours could not load"
      >
        {(tours) => <CatalogGrid tours={tours} active={active} />}
      </QueryBoundary>

      <div className="mt-10 text-center">
        <Button asChild size="lg" variant="outline" className="tap-target">
          <Link to="/tours">See all tours</Link>
        </Button>
      </div>
    </section>
  );
}

function CatalogGrid({ tours, active }: { tours: TourListItem[]; active: string }) {
  // Filters the already-fetched list client-side — one request, instant
  // chips. `tours.list` already orders by `is_featured DESC, sort_order ASC,
  // id ASC` (6D); that ordering is preserved exactly by using `.filter()`
  // only, never `.sort()`.
  const filtered = useMemo(
    () => (active === ALL ? tours : tours.filter((t) => t.destination.slug === active)),
    [tours, active],
  );

  const gridRef = useRef<HTMLUListElement>(null);
  // Cards mount here only once `tours.list` resolves (this component is
  // itself only rendered from inside QueryBoundary's loaded-data branch), so
  // keying on `filtered.length` lets the stagger fire the first time real
  // cards exist and are scrolled into view — see use-scroll-reveal.ts. The
  // selector ('li') and flex/grid toggle below are independent of each
  // other: the stagger only cares that its items match `li`, not how the
  // container lays them out.
  useCardStagger(gridRef, 'li', filtered.length);
  // Dot indicator for the mobile carousel (spec task 2.9A) — keyed on
  // `active` (the destination filter), not `filtered.length`, so a filter
  // swap that happens to produce the same card count still resets the
  // tracked position and the row's own scroll offset to the first card.
  const activeCard = useActiveCarouselCard(gridRef, 'li', active);

  if (filtered.length === 0) {
    return (
      <p className="text-muted-foreground mt-8 text-center text-base sm:text-sm">
        No tours listed for this destination yet.
      </p>
    );
  }

  return (
    <>
      <ul ref={gridRef} className={CAROUSEL_LIST_CLASSES}>
        {filtered.map((tour) => (
          <li key={tour.id} className={CAROUSEL_ITEM_CLASSES}>
            <TourCard tour={tour} />
          </li>
        ))}
      </ul>
      <CarouselDots containerRef={gridRef} count={filtered.length} active={activeCard} />
    </>
  );
}
