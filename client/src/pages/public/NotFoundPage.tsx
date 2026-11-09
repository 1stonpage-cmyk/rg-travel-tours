import { Compass } from 'lucide-react';
import { Link } from 'react-router-dom';
import { Button } from '@/components/ui/button';

/**
 * Demo polish, task 1C — owner decision 2: "Unknown URLs get a branded 404
 * page (inside the normal layout) with links to Home and 'Book a transfer'.
 * The server's 404 status/title behaviour stays as it is."
 *
 * Before this page existed, `App.tsx` had no `path="*"` route at all, so a
 * guest landing on any unmatched URL saw a blank white page — React Router
 * logged "No routes matched location" and rendered nothing. The server-side
 * SEO injector (`server/src/seo/resolvers.ts`'s `notFoundMeta`) already sends
 * the right HTTP status and `<title>Page not found | TravelSugbo</title>`
 * for any unmatched path; this component is purely the client-side body that
 * was missing. It is mounted via a catch-all `<Route path="*">` **inside**
 * `PublicLayout` in `App.tsx`, so it renders with the normal header, footer
 * and WhatsApp bar — "inside the normal layout" per the decision — rather
 * than as a bare standalone screen.
 *
 * This heading intentionally echoes the server's own title text ("Page not
 * found") rather than inventing separate wording, so the tab title and the
 * page body agree. `PublicLayout`'s `publicTitle()` has no entry for an
 * arbitrary unmatched path, so it resolves to `null` and leaves the server
 * -injected `document.title` standing — this component does not touch it.
 */
export default function NotFoundPage() {
  return (
    <div className="mx-auto flex max-w-2xl flex-col items-center px-4 py-16 text-center sm:px-6 sm:py-24">
      <span className="bg-brand-blue-50 text-brand-blue-700 flex size-16 items-center justify-center rounded-full">
        <Compass className="size-8" aria-hidden="true" />
      </span>

      <p className="text-brand-gold-700 mt-6 text-sm font-semibold uppercase tracking-wide">
        Error 404
      </p>
      <h1 className="text-brand-blue-900 mt-2 text-2xl font-bold tracking-tight sm:text-3xl">
        Page not found
      </h1>
      <p className="text-muted-foreground mt-3 max-w-md text-sm sm:text-base">
        We couldn't find the page you were looking for. It may have been moved, or the link might be
        mistyped.
      </p>

      <div className="mt-8 flex w-full flex-col gap-3 sm:w-auto sm:flex-row">
        <Button asChild size="lg" className="tap-target w-full sm:w-auto">
          <Link to="/">Home</Link>
        </Button>
        <Button asChild variant="outline" size="lg" className="tap-target w-full sm:w-auto">
          <Link to="/transfer">Book a transfer</Link>
        </Button>
      </div>
    </div>
  );
}
