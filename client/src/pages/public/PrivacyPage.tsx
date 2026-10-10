import Markdown from '@/components/common/Markdown';
import QueryBoundary from '@/components/common/QueryBoundary';
import { Skeleton } from '@/components/common/Skeleton';
import { trpc } from '@/lib/trpc';

/**
 * Task 3.6. `settings.legal.privacy` ({ markdown, updatedAt }) comes from
 * `settings.get` — the same query every other content-driven public page
 * already uses, so no new router/endpoint is needed.
 *
 * `updatedAt` is stored UTC; displayed in Asia/Manila per the project-wide
 * time convention (same formatter shape as ReviewsSection's `createdAt`).
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

/**
 * Reading-measure layout: `max-w-[65ch]` caps the line length at a legible
 * measure rather than a fixed pixel width, and `leading-relaxed` (1.625)
 * sits in the 1.5–1.75 range ui-ux-pro-max's long-form-reading guidance
 * calls for — both taken from querying
 * `"article reading line height paragraph spacing" --domain ux`.
 *
 * Exactly one `<h1>` on this page: this component's own heading. The
 * markdown body can contain `#`/`##`/`###`, but `Markdown` demotes all of
 * them to `<h2>`/`<h3>` — it can never mint a second `<h1>` (see
 * markdown.test.tsx).
 */
export default function PrivacyPage() {
  const query = trpc.settings.get.useQuery();

  return (
    <article className="mx-auto w-full max-w-[65ch] px-4 py-12 text-base leading-relaxed sm:px-6">
      <h1 className="text-brand-blue-900 text-3xl font-bold tracking-tight">Privacy Policy</h1>
      <QueryBoundary
        query={query}
        skeleton={<LegalSkeleton />}
        errorTitle="Could not load the privacy policy"
      >
        {(settings) => (
          <>
            <p className="text-muted-foreground mt-2 text-sm">
              Last updated {lastUpdatedFormatter.format(new Date(settings.legal.privacy.updatedAt))}
            </p>
            <Markdown source={settings.legal.privacy.markdown} />
          </>
        )}
      </QueryBoundary>
    </article>
  );
}
