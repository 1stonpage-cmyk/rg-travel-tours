import { trpc } from '@/lib/trpc';

/**
 * Marker that the page is rendering content the client has not yet verified
 * (spec section 0: do not fake social proof).
 *
 * Driven entirely by settings.contentUnverified (task 3.7) — the database
 * is now the single source of truth for this flag, not a build-time
 * constant. There is deliberately no import.meta.env.DEV fallback: a demo
 * build made with ALLOW_PLACEHOLDER_BUILD=1 is a production build someone
 * will actually look at, and DEV is not a meaningful proxy for whether its
 * content has been verified — only the database flag is. An admin clears
 * content_unverified once real content replaces the seed, and the banner
 * disappears everywhere, dev included.
 *
 * Hides while the settings query is still pending, not just while it is
 * false — a banner that flashes on every page load before data arrives is
 * worse than one that appears a moment late.
 */
export default function PlaceholderBadge() {
  const { data, isPending } = trpc.settings.get.useQuery();
  if (isPending || !data?.contentUnverified) return null;

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
