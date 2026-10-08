import { USING_PLACEHOLDER_DATA } from '@/lib/placeholder-data';

/**
 * Marker that the page is rendering placeholder content, not real business
 * data (spec section 0: do not fake social proof).
 *
 * Gated on USING_PLACEHOLDER_DATA, not import.meta.env.DEV: a demo build
 * made with ALLOW_PLACEHOLDER_BUILD=1 is a production build that still
 * renders the invented tour ratings/booking counts from placeholder-data.ts,
 * and that is exactly the build someone will actually look at. DEV is kept
 * as a belt-and-braces OR so the badge still shows during local development
 * even in the (currently impossible) case placeholder-data.ts reports false.
 * Once tasks 2C/2D delete placeholder-data.ts and replace it with real API
 * data, this component (and its import) should be deleted too.
 */
export default function PlaceholderBadge() {
  if (!import.meta.env.DEV && !USING_PLACEHOLDER_DATA) return null;

  return (
    <div
      role="status"
      className="border-brand-warning/30 bg-brand-gold-100 text-brand-warning border-b px-4 py-1.5 text-center text-xs font-semibold"
    >
      PLACEHOLDER DATA — tour details, prices and photos are placeholders; permit numbers are
      pending. Rating and guest counts are client-supplied, pending verification.
    </div>
  );
}
