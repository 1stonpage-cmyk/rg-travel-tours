import { Compass } from 'lucide-react';
import { Link } from 'react-router-dom';
import { Button } from '@/components/ui/button';

/**
 * B3 (DEMO POLISH batch, 2026-11-09, owner decision 1) — "Unknown /admin/*
 * paths render a 404 inside the admin layout (sidebar kept)." Before this,
 * `/admin/*`'s catch-all was the PUBLIC `<Route path="*">` in `App.tsx`
 * (React Router matches the whole tree, not block-by-block), so an operator
 * who mistyped an admin URL landed on the guest-facing 404 with the public
 * header/footer and a "Book a transfer" link — the admin shell was never
 * mounted at all. This component is routed as the LAST child inside
 * `<Route path="admin" element={<AdminLayout/>}>`, so it renders through
 * `<Outlet/>` with the sidebar, phone top bar and quick-links bar standing,
 * matching `NotFoundPage.tsx`'s "branded 404 inside the normal layout"
 * pattern for the staff console instead of the public site.
 *
 * Links back to `/admin` (the dashboard) only — there is no admin
 * equivalent of "Book a transfer" to offer a staff member.
 */
export default function AdminNotFoundPage() {
  return (
    <div className="flex flex-col items-center px-4 py-16 text-center">
      <span className="bg-brand-blue-50 text-brand-blue-700 flex size-16 items-center justify-center rounded-full">
        <Compass className="size-8" aria-hidden="true" />
      </span>

      <p className="text-brand-gold-700 mt-6 text-sm font-semibold uppercase tracking-wide">
        Error 404
      </p>
      <h1 className="text-brand-ink mt-2 text-2xl font-bold tracking-tight sm:text-3xl">
        Page not found
      </h1>
      <p className="text-muted-foreground mt-3 max-w-md text-sm sm:text-base">
        There's no admin screen at this address. It may have been moved, or the link might be
        mistyped.
      </p>

      <Button asChild variant="primary-pill" className="mt-8">
        <Link to="/admin">Back to dashboard</Link>
      </Button>
    </div>
  );
}
