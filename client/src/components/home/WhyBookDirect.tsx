import { Calendar, Headset, Map, Shield, Tag, Wallet, type LucideIcon } from 'lucide-react';
import QueryBoundary from '@/components/common/QueryBoundary';
import SectionHeading from '@/components/common/SectionHeading';
import { Skeleton } from '@/components/common/Skeleton';
import { trpc } from '@/lib/trpc';

/**
 * `why_book_direct[].icon` (spec task 6H) is a string key stored in the
 * settings table, becoming admin-editable in Weeks 5-7 — an admin typo in
 * that field must not blank this section or throw. Any key not in this map
 * falls back to `Tag`, the same neutral icon already used for one of
 * today's six reasons, rather than rendering nothing.
 */
const ICONS: Record<string, LucideIcon> = {
  tag: Tag,
  wallet: Wallet,
  shield: Shield,
  headset: Headset,
  calendar: Calendar,
  map: Map,
};

const SKELETON_ITEM_COUNT = 6;

/** Mirrors the real card's box (icon chip + title bar + body bar) so no layout shift occurs once settings resolve. */
function WhyBookDirectSkeleton() {
  return (
    <>
      {Array.from({ length: SKELETON_ITEM_COUNT }, (_, i) => (
        <li key={i} className="border-brand-blue-100 rounded-xl border p-6">
          <Skeleton className="size-11 rounded-lg" />
          <Skeleton className="mt-4 h-4 w-2/3" />
          <Skeleton className="mt-2 h-3.5 w-full" />
        </li>
      ))}
    </>
  );
}

/** Settings-driven (spec task 6H, first half). `settings.whyBookDirect` is `Array<{ icon, title, body }>`, rendered in API order. */
export default function WhyBookDirect() {
  const query = trpc.settings.get.useQuery();

  return (
    <section id="why" className="mx-auto max-w-7xl px-4 py-16 sm:px-6 lg:px-8">
      <SectionHeading
        eyebrow="Book direct"
        title="Six reasons to skip the booking platforms"
        subtitle="Editable from admin settings once the site is live."
      />
      <ul className="mt-10 grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
        <QueryBoundary
          query={query}
          skeleton={<WhyBookDirectSkeleton />}
          errorTitle="Content could not load"
        >
          {({ whyBookDirect }) =>
            whyBookDirect.map((reason) => {
              const Icon = ICONS[reason.icon] ?? Tag;
              return (
                <li key={reason.title} className="border-brand-blue-100 rounded-xl border p-6">
                  <span className="bg-brand-gold-100 flex size-11 items-center justify-center rounded-lg">
                    <Icon className="text-brand-gold-700 size-5" aria-hidden="true" />
                  </span>
                  <h3 className="text-brand-blue-900 mt-4 text-base font-semibold">
                    {reason.title}
                  </h3>
                  <p className="text-muted-foreground mt-2 text-base sm:text-sm">{reason.body}</p>
                </li>
              );
            })
          }
        </QueryBoundary>
      </ul>
    </section>
  );
}
