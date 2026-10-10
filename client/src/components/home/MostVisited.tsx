import { ArrowRight } from 'lucide-react';
import { Link } from 'react-router-dom';
import QueryBoundary from '@/components/common/QueryBoundary';
import SectionHeading from '@/components/common/SectionHeading';
import { Skeleton } from '@/components/common/Skeleton';
import { trpc } from '@/lib/trpc';
import type { Destination } from '../../../../server/src/routers/public/destinations';

const SKELETON_ITEM_COUNT = 6;

/** The grid classes live here and on the real list below — the skeleton owns its own `<ul>` so the boundary can sit outside both (see `MostVisited`). */
const PLACE_LIST_CLASSES = 'mt-10 grid gap-5 sm:grid-cols-2 lg:grid-cols-3';

/** One image-shaped bar per card, same aspect ratio as the real photo, so no layout shift occurs once destinations.list resolves. */
function MostVisitedSkeleton() {
  return (
    <ul className={PLACE_LIST_CLASSES}>
      {Array.from({ length: SKELETON_ITEM_COUNT }, (_, i) => (
        <li key={i}>
          <Skeleton className="aspect-[3/2] w-full rounded-xl" />
        </li>
      ))}
    </ul>
  );
}

/**
 * Most Visited and the destination chip row (CatalogPreview) render the
 * same six destinations in different orders under different labels — task
 * 1.4's `displayName`/`featuredSortOrder` columns exist for exactly that
 * reason (see fixtures.ts). This section sorts by `featuredSortOrder`,
 * never `sortOrder` (that one drives the chip row).
 *
 * Both halves of the API's documented contract are required, not just
 * `isFeatured`: "Null omits the destination from Most Visited"
 * (server/src/routers/public/destinations.ts). `featured_sort_order` is a
 * nullable column with nothing in the schema tying it to `is_featured`, so
 * a half-configured destination — flagged featured, never given an order —
 * is possible. Requiring a non-null order makes that case fail closed
 * (omitted) instead of sorting to the FRONT of the section, which is what
 * the old `?? 0` fallback did.
 */
function selectFeatured(destinations: Destination[]): Destination[] {
  return destinations
    .filter((d) => d.isFeatured && d.featuredSortOrder !== null)
    .sort((a, b) => a.featuredSortOrder! - b.featuredSortOrder!);
}

/**
 * Settings/API-driven (spec task 6H, first half). Reads
 * `destinations.list`, not settings — see `selectFeatured` above.
 *
 * `QueryBoundary` sits OUTSIDE the `<ul>` (the ReviewsSection/
 * PackagesSection shape): inside it, the error state's `<div role="alert">`
 * would be a direct child of `<ul>` — invalid markup, a zero-item list, and
 * a single cramped grid cell.
 */
export default function MostVisited() {
  const query = trpc.destinations.list.useQuery();

  return (
    <section id="places" className="bg-brand-blue-950">
      <div className="mx-auto max-w-7xl px-4 py-16 sm:px-6 lg:px-8">
        <SectionHeading
          eyebrow="Where guests go"
          title="Most visited places"
          subtitle="The six destinations our vans run to most often."
          className="[&_p:first-child]:text-brand-gold-300 [&_p:last-child]:text-brand-blue-200 [&_h2]:text-white"
        />
        <QueryBoundary
          query={query}
          skeleton={<MostVisitedSkeleton />}
          errorTitle="Places could not load"
        >
          {(destinations) => (
            <ul className={PLACE_LIST_CLASSES}>
              {selectFeatured(destinations).map((place) => (
                <li key={place.slug}>
                  <Link
                    to={`/tours?destination=${place.slug}`}
                    className="focus-visible:ring-brand-gold-400 group relative block overflow-hidden rounded-xl"
                  >
                    <img
                      src={place.image?.path}
                      alt={place.image?.alt ?? ''}
                      loading="lazy"
                      className="aspect-[3/2] w-full object-cover transition-transform duration-300 group-hover:scale-105"
                    />
                    <div className="from-brand-blue-950 absolute inset-0 bg-gradient-to-t via-transparent to-transparent" />
                    <div className="absolute inset-x-0 bottom-0 p-4">
                      <h3 className="flex items-center gap-1.5 text-lg font-bold text-white">
                        {place.displayName ?? place.name}
                        <ArrowRight
                          className="size-4 transition-transform group-hover:translate-x-1"
                          aria-hidden="true"
                        />
                      </h3>
                      <p className="text-brand-blue-100 mt-1 text-base sm:text-sm">{place.blurb}</p>
                    </div>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </QueryBoundary>
      </div>
    </section>
  );
}
