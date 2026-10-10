import { BadgeCheck, CreditCard, Headset, Users, type LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import CountUpStat from '@/components/common/CountUpStat';
import QueryBoundary from '@/components/common/QueryBoundary';
import { Skeleton } from '@/components/common/Skeleton';
import { trpc } from '@/lib/trpc';

const SKELETON_ITEM_COUNT = 4;

/**
 * Mirrors the real grid's classes and one icon+label bar per slot, so
 * swapping in the loaded items causes no layout shift.
 *
 * BUG-071: only the first `<li>` carries `role="status"`/`aria-label` — one
 * accessible name is enough to announce the loading state, and putting it on
 * every item would announce it four times. The other three stay
 * `aria-hidden` so their skeleton bars are not read as empty list items.
 * Splitting it this way (rather than one wrapping element around all four)
 * keeps the four-`<li>` grid exactly as wide as the real, loaded grid - the
 * same no-layout-shift goal the classes above already serve.
 */
function TrustBarSkeleton() {
  return (
    <>
      {Array.from({ length: SKELETON_ITEM_COUNT }, (_, i) =>
        i === 0 ? (
          <li
            key={i}
            role="status"
            aria-label="Loading trust information"
            className="flex items-center gap-2.5"
          >
            <Skeleton className="size-5 shrink-0 rounded-full" />
            <Skeleton className="h-4 w-full max-w-40" />
          </li>
        ) : (
          <li key={i} aria-hidden="true" className="flex items-center gap-2.5">
            <Skeleton className="size-5 shrink-0 rounded-full" />
            <Skeleton className="h-4 w-full max-w-40" />
          </li>
        ),
      )}
    </>
  );
}

export default function TrustBar() {
  const settingsQuery = trpc.settings.get.useQuery();

  return (
    <section aria-label="Why guests trust us" className="bg-brand-blue-50 border-y">
      <ul className="mx-auto grid max-w-7xl grid-cols-2 gap-4 px-4 py-6 sm:px-6 lg:grid-cols-4 lg:px-8">
        <QueryBoundary
          query={settingsQuery}
          skeleton={<TrustBarSkeleton />}
          errorTitle="Content could not load"
        >
          {({ trust }) => {
            // guestsServed is nullable: omit the item entirely rather than
            // showing a blank or zero (no fabricated social proof).
            // `label` is a ReactNode (not just a string) so the guests-served
            // item can carry a <CountUpStat>, so each item also gets its own
            // stable string `key` — a JSX label can't double as a map key.
            const items: { key: string; icon: LucideIcon; label: ReactNode }[] = [];
            if (trust.dotAccredited) {
              items.push({ key: 'dot', icon: BadgeCheck, label: 'DOT accredited operator' });
            }
            if (trust.guestsServed !== null) {
              items.push({
                key: 'guests',
                icon: Users,
                // Count-up for this trust stat only (spec 2.9E) — never for
                // a price. See CountUpStat.tsx / use-count-up.ts.
                label: (
                  <>
                    <CountUpStat value={trust.guestsServed} /> guests served
                  </>
                ),
              });
            }
            items.push({
              key: 'deposit',
              icon: CreditCard,
              label: `${trust.depositPercent}% deposit to reserve`,
            });
            items.push({ key: 'whatsapp', icon: Headset, label: 'Local team on WhatsApp daily' });

            return (
              <>
                {items.map(({ key, icon: Icon, label }) => (
                  <li
                    key={key}
                    className="text-brand-blue-900 flex items-center gap-2.5 text-base font-medium sm:text-sm"
                  >
                    <Icon className="text-brand-gold-600 size-5 shrink-0" aria-hidden="true" />
                    {label}
                  </li>
                ))}
              </>
            );
          }}
        </QueryBoundary>
      </ul>
    </section>
  );
}
