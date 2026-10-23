import { formatPeso } from '@rg/shared';
import { Check } from 'lucide-react';
import { useParams } from 'react-router-dom';
import QueryBoundary from '@/components/common/QueryBoundary';
import { Skeleton } from '@/components/common/Skeleton';
import PackageInquiryForm from '@/components/package/PackageInquiryForm';
import { trpc } from '@/lib/trpc';

/**
 * `/packages/:slug` — the public package detail page (Week 7 plan, Task 3).
 *
 * Reads `packages.bySlug`, which returns the same shape as one row of
 * `packages.list` — the `packages` table has no child tables (no tiers, no
 * images table, no itinerary), so there is nothing else to show here.
 * `oldPriceCentavos`/`newPriceCentavos` are both server values, formatted
 * only by `formatPeso` — never recomputed on the client (CLAUDE.md: the
 * server computes all money). The field is called `highlights` in the
 * data, not "inclusions" — rendered here as "What's included".
 *
 * A slug that does not resolve falls through to `QueryBoundary`'s own
 * generic error state (the same pattern `TourDetailPage` uses for an
 * unknown tour slug) — there is no package-specific 404 copy.
 */

/** `unknown` from the database's `json` column, narrowed to a plain string list. */
function asStringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

function DetailSkeleton() {
  return (
    <div className="mx-auto max-w-3xl px-4 py-10 sm:px-6 lg:px-8">
      <Skeleton className="h-8 w-2/3" />
      <Skeleton className="mt-4 h-64 w-full rounded-xl" />
      <Skeleton className="mt-8 h-40 w-full" />
    </div>
  );
}

export default function PackageDetailPage() {
  const { slug } = useParams<{ slug: string }>();
  const query = trpc.packages.bySlug.useQuery({ slug: slug ?? '' }, { enabled: Boolean(slug) });

  return (
    <QueryBoundary
      query={query}
      skeleton={<DetailSkeleton />}
      errorTitle="This package could not load"
    >
      {(pkg) => {
        const highlights = asStringList(pkg.highlights);

        return (
          <div className="mx-auto max-w-3xl px-4 py-8 sm:px-6 sm:py-10 lg:px-8">
            {pkg.image && (
              <img
                src={pkg.image.path}
                alt={pkg.image.alt}
                className="aspect-[3/2] w-full rounded-xl object-cover"
              />
            )}

            <header className="mt-6">
              <p className="text-brand-gold-700 text-xs font-semibold uppercase tracking-wider">
                {pkg.days} days / {pkg.days - 1} nights
              </p>
              <h1 className="text-brand-blue-900 mt-1.5 text-2xl font-bold tracking-tight sm:text-3xl">
                {pkg.title}
              </h1>

              <div className="mt-3 flex items-baseline gap-2">
                {pkg.oldPriceCentavos != null && (
                  <s className="text-muted-foreground text-base">
                    {formatPeso(pkg.oldPriceCentavos)}
                  </s>
                )}
                <span className="text-brand-blue-900 text-3xl font-bold">
                  {formatPeso(pkg.newPriceCentavos)}
                </span>
                <span className="text-muted-foreground text-sm">per group</span>
              </div>
            </header>

            {pkg.description && (
              <section aria-labelledby="about-heading" className="mt-8">
                <h2 id="about-heading" className="text-brand-blue-900 text-xl font-bold">
                  About this package
                </h2>
                <p className="text-muted-foreground mt-3 whitespace-pre-line leading-relaxed">
                  {pkg.description}
                </p>
              </section>
            )}

            {highlights.length > 0 && (
              <section aria-labelledby="included-heading" className="mt-8">
                <h2 id="included-heading" className="text-brand-blue-900 text-xl font-bold">
                  What's included
                </h2>
                <ul className="mt-4 space-y-2">
                  {highlights.map((item) => (
                    <li key={item} className="flex items-start gap-2 text-sm">
                      <Check
                        className="text-brand-gold-700 mt-0.5 size-4 shrink-0"
                        aria-hidden="true"
                      />
                      {item}
                    </li>
                  ))}
                </ul>
              </section>
            )}

            <div className="mt-10">
              <PackageInquiryForm packageId={pkg.id} packageTitle={pkg.title} />
            </div>
          </div>
        );
      }}
    </QueryBoundary>
  );
}
