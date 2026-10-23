import { useMemo } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import QueryBoundary, { EmptyState } from '@/components/common/QueryBoundary';
import { Skeleton, TourCardSkeleton } from '@/components/common/Skeleton';
import TourCard from '@/components/common/TourCard';
import { Button } from '@/components/ui/button';
import { trpc } from '@/lib/trpc';
import { cn } from '@/lib/utils';
import type { Destination } from '../../../../server/src/routers/public/destinations';

const SKELETON_CHIP_COUNT = 6;
const SKELETON_CARD_COUNT = 6;

/** `displayName ?? name` — the same fallback MostVisited.tsx already uses. */
function labelFor(destination: Pick<Destination, 'name' | 'displayName'>): string {
  return destination.displayName ?? destination.name;
}

function ChipRowSkeleton() {
  return (
    <>
      {Array.from({ length: SKELETON_CHIP_COUNT }, (_, i) => (
        <Skeleton key={i} className="h-11 w-24 shrink-0 rounded-full" />
      ))}
    </>
  );
}

function GridSkeleton() {
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

const chipClasses = (active: boolean) =>
  cn(
    'press min-h-11 shrink-0 rounded-full border px-4 text-sm font-medium transition-colors',
    active
      ? 'bg-brand-blue-600 border-brand-blue-600 text-white'
      : 'border-brand-blue-200 text-brand-blue-800 hover:bg-brand-blue-50',
  );

export default function ToursPage() {
  const [params] = useSearchParams();
  const destination = params.get('destination') ?? undefined;
  const date = params.get('date');
  const guests = params.get('guests');

  const destinationsQuery = trpc.destinations.list.useQuery();
  const toursQuery = trpc.tours.list.useQuery({ destination });

  // The hero search's `date`/`guests` forwarded onto every card's links,
  // renamed `date`/`pax` — the contract CheckoutPage and the (task 2)
  // detail page already read. Built once per date/guests pair, not per
  // card, so every TourCard in the grid shares the identical string.
  const forwardedSearchParams = useMemo(() => {
    if (!date && !guests) return undefined;
    const forwarded = new URLSearchParams();
    if (date) forwarded.set('date', date);
    if (guests) forwarded.set('pax', guests);
    return forwarded.toString();
  }, [date, guests]);

  // Preserves date/guests when switching destinations — only the
  // `destination` key changes.
  function filterHref(slug?: string): string {
    const next = new URLSearchParams(params);
    if (slug) next.set('destination', slug);
    else next.delete('destination');
    const qs = next.toString();
    return qs ? `/tours?${qs}` : '/tours';
  }

  return (
    <section className="mx-auto max-w-7xl px-4 py-12 sm:px-6 sm:py-16 lg:px-8">
      <header className="max-w-2xl">
        {/*
         * Deliberately a single, static h1 — "which filter is on" is said
         * by the active destination chip below (`aria-current="page"` plus
         * its own distinct styling) and by the results themselves, not by
         * repeating the destination's name here too. The chip row and the
         * grid already both name the destination once each; a third
         * "Tours in Oslob"-style restatement here would be the same text
         * on screen three times over for no added information.
         */}
        <h1 className="text-brand-blue-900 text-3xl font-bold tracking-tight sm:text-4xl">
          All Cebu day tours
        </h1>
        <p className="text-muted-foreground mt-3 text-base">
          Private van, licensed driver and a local guide on every trip.
        </p>
      </header>

      <nav
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
              <Link
                to={filterHref(undefined)}
                aria-current={!destination ? 'page' : undefined}
                className={chipClasses(!destination)}
              >
                All tours
              </Link>
              {destinations.map((d) => (
                <Link
                  key={d.slug}
                  to={filterHref(d.slug)}
                  aria-current={destination === d.slug ? 'page' : undefined}
                  className={chipClasses(destination === d.slug)}
                >
                  {labelFor(d)}
                </Link>
              ))}
            </>
          )}
        </QueryBoundary>
      </nav>

      <QueryBoundary
        query={toursQuery}
        skeleton={<GridSkeleton />}
        errorTitle="Tours could not load"
        empty={
          destination ? (
            <EmptyState
              title="No tours match this destination yet"
              body="Try another destination, or browse everything we run."
              action={
                <Button asChild variant="outline" className="tap-target">
                  <Link to="/tours">See all tours</Link>
                </Button>
              }
            />
          ) : (
            <EmptyState
              title="No tours available yet"
              body="Please check back soon — we're adding tours to the catalog."
            />
          )
        }
      >
        {(tours) => (
          <ul className="mt-8 grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
            {tours.map((tour) => (
              <li key={tour.id} role="article">
                <TourCard tour={tour} searchParams={forwardedSearchParams} />
              </li>
            ))}
          </ul>
        )}
      </QueryBoundary>
    </section>
  );
}
