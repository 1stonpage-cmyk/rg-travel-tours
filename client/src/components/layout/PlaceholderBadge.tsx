/**
 * Dev-only marker that the page is rendering placeholder content, not real
 * business data (spec section 0: do not fake social proof). Stripped from
 * production builds by the import.meta.env.DEV guard.
 */
export default function PlaceholderBadge() {
  if (!import.meta.env.DEV) return null;

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
