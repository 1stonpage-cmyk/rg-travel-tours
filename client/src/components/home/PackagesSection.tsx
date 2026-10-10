import { formatPeso } from '@rg/shared';
import { Check } from 'lucide-react';
import { useRef, useState } from 'react';
import QueryBoundary, { EmptyState } from '@/components/common/QueryBoundary';
import { Skeleton } from '@/components/common/Skeleton';
import SectionHeading from '@/components/common/SectionHeading';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { trpc } from '@/lib/trpc';
import { useCardStagger } from '@/lib/use-scroll-reveal';

const SKELETON_CARD_COUNT = 3;

/** JSON `highlights` column comes back typed `unknown` — narrow defensively at the render boundary. */
function asStringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

/** Mirrors the real package card's box (image, eyebrow, title, description, highlights, price row, CTA). */
function PackageCardSkeleton() {
  return (
    <li
      className="border-brand-blue-100 flex flex-col overflow-hidden rounded-xl border"
      role="status"
      aria-label="Loading package"
    >
      <Skeleton className="aspect-[3/2] w-full rounded-none" />
      <div className="flex flex-1 flex-col gap-3 p-5">
        <Skeleton className="h-3.5 w-1/3" />
        <Skeleton className="h-5 w-2/3" />
        <Skeleton className="h-3.5 w-full" />
        <Skeleton className="h-3.5 w-5/6" />
        <div className="space-y-1.5 pt-1">
          <Skeleton className="h-3.5 w-full" />
          <Skeleton className="h-3.5 w-full" />
          <Skeleton className="h-3.5 w-4/5" />
        </div>
        <Skeleton className="mt-2 h-7 w-1/2" />
        <div className="mt-2 flex min-h-11 items-center">
          <Skeleton className="h-10 w-full" />
        </div>
      </div>
    </li>
  );
}

function PackagesGridSkeleton() {
  return (
    <ul className="mt-10 grid gap-6 lg:grid-cols-3">
      {Array.from({ length: SKELETON_CARD_COUNT }, (_, i) => (
        <PackageCardSkeleton key={i} />
      ))}
    </ul>
  );
}

export default function PackagesSection() {
  const packagesQuery = trpc.packages.list.useQuery();
  const [selected, setSelected] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState(false);

  const gridRef = useRef<HTMLUListElement>(null);
  // Re-runs once packages.list resolves and the real <li>s replace the
  // skeleton — see useCardStagger's own comment in use-scroll-reveal.ts.
  useCardStagger(gridRef, 'li', packagesQuery.data?.length ?? 0);

  return (
    <section id="packages" className="mx-auto max-w-7xl px-4 py-16 sm:px-6 lg:px-8">
      <SectionHeading
        eyebrow="Multi-day"
        title="Packages"
        subtitle="Three to five days across Cebu and Bohol, with transfers and accommodation handled."
      />

      <QueryBoundary
        query={packagesQuery}
        skeleton={<PackagesGridSkeleton />}
        empty={
          <EmptyState
            title="No packages yet"
            body="Multi-day packages will appear here once published."
          />
        }
        errorTitle="Packages could not load"
      >
        {(packages) => {
          // `packages` is never empty here — the `empty` slot above already
          // handled that case — so `packages[0]!` is safe.
          const selectedSlug = selected ?? packages[0]!.slug;

          return (
            <>
              <ul ref={gridRef} className="mt-10 grid gap-6 lg:grid-cols-3">
                {packages.map((pkg) => (
                  <li
                    key={pkg.id}
                    className="border-brand-blue-100 press group flex flex-col overflow-hidden rounded-xl border hover:-translate-y-1 hover:shadow-lg"
                  >
                    <div className="bg-brand-blue-100 overflow-hidden">
                      {pkg.image && (
                        <img
                          src={pkg.image.path}
                          alt={pkg.image.alt}
                          loading="lazy"
                          className="aspect-[3/2] w-full object-cover transition-transform duration-500 ease-out group-hover:scale-105 motion-reduce:group-hover:scale-100"
                        />
                      )}
                    </div>
                    <div className="flex flex-1 flex-col p-5">
                      <p className="text-brand-gold-700 text-xs font-semibold uppercase tracking-wider">
                        {pkg.days} days / {pkg.days - 1} nights
                      </p>
                      <h3 className="text-brand-blue-900 mt-1.5 text-lg font-bold">{pkg.title}</h3>
                      {pkg.description && (
                        <p className="text-muted-foreground mt-2 text-base sm:text-sm">
                          {pkg.description}
                        </p>
                      )}

                      <ul className="mt-4 space-y-1.5 text-base sm:text-sm">
                        {asStringList(pkg.highlights).map((h) => (
                          <li key={h} className="text-brand-ink flex items-center gap-2">
                            <Check
                              className="text-brand-gold-600 size-4 shrink-0"
                              aria-hidden="true"
                            />
                            {h}
                          </li>
                        ))}
                      </ul>

                      <div className="mt-5 flex items-baseline gap-2">
                        {pkg.oldPriceCentavos != null && (
                          <s className="text-muted-foreground text-sm">
                            {formatPeso(pkg.oldPriceCentavos)}
                          </s>
                        )}
                        <span className="text-brand-blue-900 text-2xl font-bold">
                          {formatPeso(pkg.newPriceCentavos)}
                        </span>
                        <span className="text-muted-foreground text-xs">per group</span>
                      </div>

                      <Button
                        className="tap-target mt-4 w-full"
                        onClick={() => {
                          setSelected(pkg.slug);
                          document.getElementById('package-inquiry-name')?.focus();
                        }}
                      >
                        Enquire about this package
                      </Button>
                    </div>
                  </li>
                ))}
              </ul>

              <form
                aria-label="Package inquiry"
                onSubmit={(e) => {
                  e.preventDefault();
                  setSubmitted(true);
                }}
                className="bg-brand-blue-50 mt-10 grid gap-4 rounded-2xl p-6 sm:grid-cols-2"
              >
                <h3 className="text-brand-blue-900 text-lg font-semibold sm:col-span-2">
                  Ask about a package
                </h3>

                <div className="space-y-1.5">
                  <Label htmlFor="package-inquiry-name">Your name</Label>
                  <Input id="package-inquiry-name" name="name" required className="tap-target" />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="package-inquiry-email">Email</Label>
                  <Input
                    id="package-inquiry-email"
                    name="email"
                    type="email"
                    required
                    className="tap-target"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="package-inquiry-package">Package</Label>
                  <select
                    id="package-inquiry-package"
                    name="package"
                    value={selectedSlug}
                    onChange={(e) => setSelected(e.target.value)}
                    className="border-input bg-background tap-target w-full rounded-md border px-3 text-base md:text-sm"
                  >
                    {packages.map((p) => (
                      <option key={p.slug} value={p.slug}>
                        {p.title}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="package-inquiry-dates">Preferred dates</Label>
                  <Input
                    id="package-inquiry-dates"
                    name="dates"
                    type="date"
                    className="tap-target"
                  />
                </div>

                <div className="sm:col-span-2">
                  <Button type="submit" size="lg" className="tap-target w-full sm:w-auto">
                    Send inquiry
                  </Button>
                  {submitted && (
                    <p role="status" className="text-brand-warning mt-3 text-sm font-medium">
                      Form validated. Inquiry delivery is not connected yet (spec task 7C) — nothing
                      has been sent. Please message us on WhatsApp in the meantime.
                    </p>
                  )}
                </div>
              </form>
            </>
          );
        }}
      </QueryBoundary>
    </section>
  );
}
