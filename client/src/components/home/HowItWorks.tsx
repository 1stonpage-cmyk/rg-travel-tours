import QueryBoundary from '@/components/common/QueryBoundary';
import SectionHeading from '@/components/common/SectionHeading';
import { Skeleton } from '@/components/common/Skeleton';
import { trpc } from '@/lib/trpc';

const SKELETON_STEP_COUNT = 4;

/** The grid classes live here and on the real list below — the skeleton owns its own `<ol>` so the boundary can sit outside both (see the component comment). */
const STEP_LIST_CLASSES = 'mt-10 grid gap-6 sm:grid-cols-2 lg:grid-cols-4';

/** Mirrors the real card's box (icon circle + title bar + body bar) so no layout shift occurs once settings resolve. */
function HowItWorksSkeleton() {
  return (
    <ol className={STEP_LIST_CLASSES}>
      {Array.from({ length: SKELETON_STEP_COUNT }, (_, i) => (
        <li key={i} className="bg-background rounded-xl p-6 shadow-sm">
          <Skeleton className="size-10 rounded-full" />
          <Skeleton className="mt-4 h-4 w-2/3" />
          <Skeleton className="mt-2 h-3.5 w-full" />
        </li>
      ))}
    </ol>
  );
}

/**
 * Settings-driven (spec task 6H, first half). `settings.howItWorks` is an
 * ordered `Array<{ step, title, body }>` — rendered in API order, not
 * re-sorted, matching every other content list converted this phase.
 *
 * `QueryBoundary` sits OUTSIDE the `<ol>`, not inside it — the same shape
 * ReviewsSection/PackagesSection already use. Inside the list, the error
 * state's `<div role="alert">` would be a direct child of `<ol>`: invalid
 * markup, a zero-item list, and a grid cell one column wide. Each state
 * therefore owns its own list element (the skeleton included).
 */
export default function HowItWorks() {
  const query = trpc.settings.get.useQuery();

  return (
    <section id="how" className="bg-brand-blue-50 border-y">
      <div className="mx-auto max-w-7xl px-4 py-16 sm:px-6 lg:px-8">
        <SectionHeading
          eyebrow="How it works"
          title="Booking takes about two minutes"
          subtitle="No waiting for a quote. Reserve online and we take it from there."
        />
        <QueryBoundary
          query={query}
          skeleton={<HowItWorksSkeleton />}
          errorTitle="Content could not load"
        >
          {({ howItWorks }) => (
            <ol className={STEP_LIST_CLASSES}>
              {howItWorks.map((item) => (
                <li key={item.step} className="bg-background rounded-xl p-6 shadow-sm">
                  <span className="bg-brand-blue-600 text-brand-gold-300 flex size-10 items-center justify-center rounded-full text-base font-bold">
                    {item.step}
                  </span>
                  <h3 className="text-brand-blue-900 mt-4 text-base font-semibold">{item.title}</h3>
                  <p className="text-muted-foreground mt-2 text-base sm:text-sm">{item.body}</p>
                </li>
              ))}
            </ol>
          )}
        </QueryBoundary>
      </div>
    </section>
  );
}
