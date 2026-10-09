import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import SectionHeading from '@/components/common/SectionHeading';
import TourCard from '@/components/common/TourCard';
import { Button } from '@/components/ui/button';
import { DESTINATIONS, TOURS } from '@/lib/placeholder-data';
import { cn } from '@/lib/utils';

const ALL = 'all';

export default function CatalogPreview() {
  const [active, setActive] = useState<string>(ALL);
  const chipRow = useRef<HTMLDivElement>(null);

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
  }, []);

  const filtered = useMemo(
    () =>
      active === ALL
        ? TOURS
        : TOURS.filter((t) => t.destination === DESTINATIONS.find((d) => d.slug === active)?.name),
    [active],
  );

  const filters = [{ slug: ALL, name: 'All tours' }, ...DESTINATIONS];

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
        className="scroll-fade-x mt-8 flex gap-2 overflow-x-auto pb-2"
      >
        {filters.map((f) => (
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
      </div>

      {filtered.length > 0 ? (
        <ul className="mt-8 grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
          {filtered.map((tour) => (
            <li key={tour.id}>
              <TourCard tour={tour} />
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-muted-foreground mt-8 text-center text-base sm:text-sm">
          No tours listed for this destination yet.
        </p>
      )}

      <div className="mt-10 text-center">
        <Button asChild size="lg" variant="outline" className="tap-target">
          <Link to="/tours">See all tours</Link>
        </Button>
      </div>
    </section>
  );
}
