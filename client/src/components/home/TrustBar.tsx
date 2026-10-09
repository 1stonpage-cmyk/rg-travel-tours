import { BadgeCheck, CreditCard, Headset, Users, type LucideIcon } from 'lucide-react';
import QueryBoundary from '@/components/common/QueryBoundary';
import { Skeleton } from '@/components/common/Skeleton';
import { trpc } from '@/lib/trpc';

const SKELETON_ITEM_COUNT = 4;

/** Mirrors the real grid's classes and one icon+label bar per slot, so swapping in the loaded items causes no layout shift. */
function TrustBarSkeleton() {
  return (
    <>
      {Array.from({ length: SKELETON_ITEM_COUNT }, (_, i) => (
        <li key={i} className="flex items-center gap-2.5">
          <Skeleton className="size-5 shrink-0 rounded-full" />
          <Skeleton className="h-4 w-full max-w-40" />
        </li>
      ))}
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
            const items: { icon: LucideIcon; label: string }[] = [];
            if (trust.dotAccredited) {
              items.push({ icon: BadgeCheck, label: 'DOT accredited operator' });
            }
            if (trust.guestsServed !== null) {
              items.push({
                icon: Users,
                label: `${trust.guestsServed.toLocaleString('en-PH')}+ guests served`,
              });
            }
            items.push({ icon: CreditCard, label: `${trust.depositPercent}% deposit to reserve` });
            items.push({ icon: Headset, label: 'Local team on WhatsApp daily' });

            return (
              <>
                {items.map(({ icon: Icon, label }) => (
                  <li
                    key={label}
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
