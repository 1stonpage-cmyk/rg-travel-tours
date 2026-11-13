import { useRef } from 'react';
import { Link } from 'react-router-dom';
import { ArrowRight } from 'lucide-react';
import { formatPeso } from '@rg/shared';
import QueryBoundary from '@/components/common/QueryBoundary';
import SectionHeading from '@/components/common/SectionHeading';
import { Button } from '@/components/ui/button';
import { friendlyDuration } from '@/lib/duration-words';
import { PLACE_TYPE_ICON } from '@/lib/place-types';
import { trpc } from '@/lib/trpc';
import { useCardStagger } from '@/lib/use-scroll-reveal';

/**
 * "Popular transfers" (owner decision 2026-11-13, Task 1D). Server-decided
 * membership (`show_on_home_page`), server-computed price (CLAUDE.md: the
 * server computes all money) — this component only renders what it is
 * given. Hidden entirely when no route is featured, per the spec's "hide
 * the whole section if none."
 *
 * **The "request a custom trip" link below uses `/?type=transfer_custom#contact`,
 * never `/#contact?type=transfer_custom`** (confirmed directly, Task 7 Step
 * 6: a browser's own URL parser puts everything after `#` into the hash —
 * `new URL('http://x/#contact?type=transfer_custom').search` is `''` and
 * `.hash` is `'#contact?type=transfer_custom'` — so with the query string
 * AFTER the hash, `useSearchParams()` sees no `type` param at all, and
 * `PublicLayout.tsx`'s own `document.getElementById(hash.slice(1))` scroll
 * looks for an element literally id'd `contact?type=transfer_custom`, which
 * does not exist, so neither the preselect nor the scroll-to-contact would
 * fire. Putting the query string BEFORE the hash keeps `search` and `hash`
 * clean and independent, which is what both `ContactSection.tsx` and
 * `PublicLayout.tsx` actually read.
 */
export default function PopularTransfers() {
  const query = trpc.transferRoutes.featured.useQuery();
  const gridRef = useRef<HTMLUListElement>(null);
  useCardStagger(gridRef, 'li', query.data?.length ?? 0);

  if (query.data && query.data.length === 0) return null;

  return (
    <section id="popular-transfers" className="bg-background">
      <div className="mx-auto max-w-7xl px-4 py-16 sm:px-6 lg:px-8">
        <SectionHeading
          eyebrow="Popular transfers"
          title="Private van transfers across Cebu"
          subtitle="Fixed price per vehicle, door to door. Book online in a minute."
        />

        <QueryBoundary
          query={query}
          skeleton={<PopularTransfersSkeleton />}
          errorTitle="Transfers could not load"
        >
          {(routes) => (
            <ul ref={gridRef} className="mt-10 grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
              {routes.map((route) => {
                const Icon = PLACE_TYPE_ICON[route.fromPlace.placeType];
                return (
                  <li
                    key={route.id}
                    className="border-brand-blue-100 overflow-hidden rounded-xl border bg-white"
                  >
                    <div className="bg-brand-blue-50 relative h-36 w-full">
                      {route.imagePath ? (
                        <img src={route.imagePath} alt="" className="size-full object-cover" />
                      ) : null}
                      {route.badge ? (
                        <span className="absolute left-3 top-3 rounded-full bg-amber-100 px-2.5 py-1 text-xs font-semibold text-amber-900">
                          {route.badge}
                        </span>
                      ) : null}
                      <span className="absolute bottom-3 left-3 rounded-full bg-black/60 px-2.5 py-1 text-xs font-semibold text-white">
                        About {friendlyDuration(route.estimatedDurationMinutes)}
                      </span>
                    </div>
                    <div className="p-4">
                      <p className="text-brand-blue-900 flex items-center gap-1.5 text-base font-semibold">
                        <Icon className="size-4 shrink-0" aria-hidden="true" />
                        {route.fromPlace.name}
                        <ArrowRight className="size-3.5 shrink-0" aria-hidden="true" />
                        {route.toPlace.name}
                      </p>
                      {route.shortDescription ? (
                        <p className="text-muted-foreground mt-1.5 text-sm">
                          {route.shortDescription}
                        </p>
                      ) : null}
                      {route.offeredVehicles.length > 0 ? (
                        <div className="mt-3 flex flex-wrap gap-1.5">
                          {route.offeredVehicles.map((v) => (
                            <span
                              key={v.slug}
                              className="bg-brand-blue-50 text-brand-blue-800 rounded-full px-2 py-0.5 text-xs font-medium"
                            >
                              {v.name}
                            </span>
                          ))}
                        </div>
                      ) : null}
                      <div className="mt-3 flex items-center justify-between border-t pt-3">
                        <span className="text-sm">
                          {route.cheapestOneWay ? (
                            <>
                              <span className="text-muted-foreground">One-way from </span>
                              <span className="text-brand-blue-900 font-bold">
                                {formatPeso(route.cheapestOneWay.priceCentavos)}
                              </span>
                              <span className="text-muted-foreground"> per van</span>
                            </>
                          ) : (
                            <span className="text-muted-foreground">Price unavailable</span>
                          )}
                        </span>
                      </div>
                      <Button asChild size="lg" className="tap-target mt-3 w-full">
                        <Link
                          to={`/transfer?productType=transfer_one_way&routeId=${route.id}&direction=forward`}
                        >
                          Book this transfer{' '}
                          <ArrowRight className="ml-1 size-4" aria-hidden="true" />
                        </Link>
                      </Button>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </QueryBoundary>

        <p className="text-muted-foreground mt-8 text-center text-sm">
          Going somewhere else?{' '}
          <Link
            to="/transfer"
            className="text-brand-blue-700 underline underline-offset-4 hover:no-underline"
          >
            See all routes
          </Link>{' '}
          or{' '}
          <Link
            to="/?type=transfer_custom#contact"
            className="text-brand-blue-700 underline underline-offset-4 hover:no-underline"
          >
            request a custom trip
          </Link>
          .
        </p>
      </div>
    </section>
  );
}

function PopularTransfersSkeleton() {
  return (
    <ul className="mt-10 grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
      {Array.from({ length: 3 }, (_, i) => (
        <li key={i} className="bg-brand-blue-50 h-80 animate-pulse rounded-xl" />
      ))}
    </ul>
  );
}
