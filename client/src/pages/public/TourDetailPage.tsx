import { Check, Clock, MapPin, X } from 'lucide-react';
import { useParams } from 'react-router-dom';
import QueryBoundary from '@/components/common/QueryBoundary';
import { Skeleton } from '@/components/common/Skeleton';
import StarRating from '@/components/common/StarRating';
import { Badge } from '@/components/ui/badge';
import BookingPicker from '@/components/tour/BookingPicker';
import Gallery from '@/components/tour/Gallery';
import PriceTierTable from '@/components/tour/PriceTierTable';
import { trpc } from '@/lib/trpc';

/**
 * `/tours/:slug` — the public tour detail page (Week 7 plan, Task 2).
 *
 * Reads `tours.bySlug` and renders it; `BookingPicker` is the only part of
 * this page that talks to `checkout.*`, and does so through two separate,
 * ordered questions (availability, then quote) rather than one conflated
 * call — see that component's own note.
 *
 * The reviews block is explicitly OUT OF SCOPE here (plan Task 9/10, 7A):
 * this page shows only the heading and, when `tour.rating` is already
 * present on the `tours.bySlug` payload (the same display aggregate the
 * catalog card shows, R1's threshold already applied), that average —
 * nothing else. No moderation, no votes, no write-a-review form.
 */

/** `unknown` from the database's `json` column, narrowed to a plain string list, or empty. */
function asStringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

function DetailSkeleton() {
  return (
    <div className="mx-auto max-w-5xl px-4 py-10 sm:px-6 lg:px-8">
      <Skeleton className="h-8 w-2/3" />
      <Skeleton className="mt-4 h-64 w-full rounded-xl" />
      <Skeleton className="mt-8 h-40 w-full" />
    </div>
  );
}

export default function TourDetailPage() {
  const { slug } = useParams<{ slug: string }>();
  const query = trpc.tours.bySlug.useQuery({ slug: slug ?? '' }, { enabled: Boolean(slug) });

  return (
    <QueryBoundary
      query={query}
      skeleton={<DetailSkeleton />}
      errorTitle="This tour could not load"
    >
      {/*
       * `tour`'s type is left to infer structurally from `query` rather than
       * annotated as the server's own `TourDetail` interface. That interface
       * describes what the SERVER produces; `inclusions`/`exclusions` are
       * typed `unknown` there, and `unknown` admits `undefined`, so tRPC's
       * client-side output type makes both fields OPTIONAL after the JSON
       * round trip (no transformer configured — see helpers/fixtures.ts's
       * own note on this exact trap). Annotating the callback as `TourDetail`
       * would then fail to typecheck: "optional in the inferred type but
       * required in TourDetail" — a real mismatch between the server's
       * declared shape and what the client actually receives, not a type
       * worth silencing.
       */}
      {(tour) => {
        const inclusions = asStringList(tour.inclusions);
        const exclusions = asStringList(tour.exclusions);

        return (
          <div className="mx-auto max-w-5xl px-4 py-8 sm:px-6 sm:py-10 lg:px-8">
            <header className="max-w-3xl">
              <p className="text-muted-foreground flex items-center gap-1.5 text-sm font-medium">
                <MapPin className="size-4" aria-hidden="true" />
                {tour.destination.name}
                {tour.durationHours != null && (
                  <>
                    <span aria-hidden="true">·</span>
                    <Clock className="size-4" aria-hidden="true" />
                    {tour.durationHours}h
                  </>
                )}
              </p>
              <h1 className="text-brand-blue-900 mt-2 text-2xl font-bold tracking-tight sm:text-3xl">
                {tour.title}
              </h1>
              {tour.rating && (
                <div className="mt-2">
                  <StarRating value={tour.rating.average} count={tour.rating.count} />
                </div>
              )}
              {tour.freeCancellation && (
                <Badge className="bg-brand-gold-500 text-brand-blue-950 mt-3 w-fit border-0">
                  Free cancellation
                </Badge>
              )}
            </header>

            <div className="mt-6">
              <Gallery images={tour.images} title={tour.title} />
            </div>

            <div className="mt-10 grid gap-10 lg:grid-cols-[1fr_360px] lg:items-start">
              <div className="order-2 space-y-10 lg:order-1">
                {tour.about && (
                  <section aria-labelledby="about-heading">
                    <h2 id="about-heading" className="text-brand-blue-900 text-xl font-bold">
                      About this tour
                    </h2>
                    <p className="text-muted-foreground mt-3 whitespace-pre-line leading-relaxed">
                      {tour.about}
                    </p>
                  </section>
                )}

                {tour.itinerary.length > 0 && (
                  <section aria-labelledby="itinerary-heading">
                    <h2 id="itinerary-heading" className="text-brand-blue-900 text-xl font-bold">
                      Itinerary
                    </h2>
                    <ol aria-label="Itinerary" className="mt-4 space-y-4">
                      {tour.itinerary.map((stop, index) => (
                        <li key={`${stop.sortOrder}-${stop.name}`} className="flex gap-3">
                          <span
                            aria-hidden="true"
                            className="bg-brand-blue-100 text-brand-blue-900 flex size-7 shrink-0 items-center justify-center rounded-full text-sm font-semibold"
                          >
                            {index + 1}
                          </span>
                          <div>
                            <p className="text-brand-blue-900 font-semibold">{stop.name}</p>
                            {stop.description && (
                              <p className="text-muted-foreground mt-0.5 text-sm">
                                {stop.description}
                              </p>
                            )}
                          </div>
                        </li>
                      ))}
                    </ol>
                  </section>
                )}

                {(inclusions.length > 0 || exclusions.length > 0) && (
                  <section
                    aria-labelledby="inclusions-heading"
                    className="grid gap-6 sm:grid-cols-2"
                  >
                    {inclusions.length > 0 && (
                      <div>
                        <h2
                          id="inclusions-heading"
                          className="text-brand-blue-900 text-lg font-bold"
                        >
                          Included
                        </h2>
                        <ul className="mt-3 space-y-2">
                          {inclusions.map((item) => (
                            <li key={item} className="flex items-start gap-2 text-sm">
                              <Check
                                className="text-brand-blue-600 mt-0.5 size-4 shrink-0"
                                aria-hidden="true"
                              />
                              {item}
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}
                    {exclusions.length > 0 && (
                      <div>
                        <h2 className="text-brand-blue-900 text-lg font-bold">Not included</h2>
                        <ul className="mt-3 space-y-2">
                          {exclusions.map((item) => (
                            <li key={item} className="flex items-start gap-2 text-sm">
                              <X
                                className="text-muted-foreground mt-0.5 size-4 shrink-0"
                                aria-hidden="true"
                              />
                              {item}
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}
                  </section>
                )}

                {tour.priceTiers.length > 0 && (
                  <section aria-labelledby="pricing-heading">
                    <h2 id="pricing-heading" className="text-brand-blue-900 text-xl font-bold">
                      Pricing
                    </h2>
                    <div className="mt-4">
                      <PriceTierTable tiers={tour.priceTiers} />
                    </div>
                  </section>
                )}

                {/*
                 * Reviews: explicitly out of scope here (plan Task 9/10).
                 * `tour.rating` is the same display aggregate the catalog
                 * card already shows (R1's threshold applied), so showing
                 * it here costs no extra query — nothing else belongs in
                 * this section yet.
                 */}
                <section id="reviews" aria-labelledby="reviews-heading">
                  <h2 id="reviews-heading" className="text-brand-blue-900 text-xl font-bold">
                    Guest reviews
                  </h2>
                  {tour.rating ? (
                    <div className="mt-3">
                      <StarRating value={tour.rating.average} count={tour.rating.count} size="md" />
                    </div>
                  ) : (
                    <p className="text-muted-foreground mt-3 text-sm">
                      Not enough published reviews yet.
                    </p>
                  )}
                </section>
              </div>

              <div className="order-1 lg:sticky lg:top-24 lg:order-2">
                <BookingPicker tour={tour} />
              </div>
            </div>
          </div>
        );
      }}
    </QueryBoundary>
  );
}
