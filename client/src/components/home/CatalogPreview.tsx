import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import QueryBoundary from '@/components/common/QueryBoundary';
import { Skeleton, TourCardSkeleton } from '@/components/common/Skeleton';
import SectionHeading from '@/components/common/SectionHeading';
import TourCard from '@/components/common/TourCard';
import { Button } from '@/components/ui/button';
import { trpc } from '@/lib/trpc';
import { cn } from '@/lib/utils';
import type { TourListItem } from '../../../../server/src/routers/public/tours';

const ALL = 'all';
const SKELETON_CHIP_COUNT = 6;
const SKELETON_CARD_COUNT = 6;

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

/** Mirrors the real grid's own classes so swapping in the loaded cards causes no layout shift. */
function CatalogGridSkeleton() {
  return (
    <ul className="mt-8 grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
      {Array.from({ length: SKELETON_CARD_COUNT }, (_, i) => (
        <li key={i}>
          <TourCardSkeleton />
        </li>
      ))}
    </ul>
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
                    'min-h-11 shrink-0 rounded-full border px-4 text-sm font-medium transition-colors',
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

  if (filtered.length === 0) {
    return (
      <p className="text-muted-foreground mt-8 text-center text-base sm:text-sm">
        No tours listed for this destination yet.
      </p>
    );
  }

  return (
    <ul className="mt-8 grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
      {filtered.map((tour) => (
        <li key={tour.id}>
          <TourCard tour={tour} />
        </li>
      ))}
    </ul>
  );
}
