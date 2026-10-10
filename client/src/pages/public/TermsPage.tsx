import Markdown from '@/components/common/Markdown';
import QueryBoundary from '@/components/common/QueryBoundary';
import { Skeleton } from '@/components/common/Skeleton';
import { trpc } from '@/lib/trpc';

/**
 * Task 3.6. `settings.legal.terms` ({ markdown, updatedAt }) comes from
 * `settings.get` — see PrivacyPage.tsx for the shared reasoning (same
 * query, same formatter shape, same one-`<h1>` guarantee).
 */
const lastUpdatedFormatter = new Intl.DateTimeFormat('en-PH', {
  timeZone: 'Asia/Manila',
  year: 'numeric',
  month: 'long',
  day: 'numeric',
});

function LegalSkeleton() {
  return (
    <div role="status" aria-label="Loading" className="mt-6 space-y-3">
      <Skeleton className="h-4 w-48" />
      <Skeleton className="h-16 w-full" />
      <Skeleton className="h-4 w-full" />
      <Skeleton className="h-4 w-full" />
      <Skeleton className="h-4 w-2/3" />
    </div>
  );
}

export default function TermsPage() {
  const query = trpc.settings.get.useQuery();

  return (
    <article className="mx-auto w-full max-w-[65ch] px-4 py-12 text-base leading-relaxed sm:px-6">
      <h1 className="text-brand-blue-900 text-3xl font-bold tracking-tight">Terms of Service</h1>
      <QueryBoundary
        query={query}
        skeleton={<LegalSkeleton />}
        errorTitle="Could not load the terms of service"
      >
        {(settings) => (
          <>
            <p className="text-muted-foreground mt-2 text-sm">
              Last updated {lastUpdatedFormatter.format(new Date(settings.legal.terms.updatedAt))}
            </p>
            <Markdown source={settings.legal.terms.markdown} />
          </>
        )}
      </QueryBoundary>
    </article>
  );
}
