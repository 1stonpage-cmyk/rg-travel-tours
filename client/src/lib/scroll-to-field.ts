/**
 * Mirrors the `prefersReducedMotion()` guard already duplicated in
 * `TransferBookingPage.tsx`/`PublicLayout.tsx`/`use-scroll-reveal.ts` —
 * jsdom has no `window.matchMedia`, so this checks before calling it.
 */
function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/** Scrolls an invalid field into view and focuses it — "Book now" must never do nothing visible. */
export function scrollToAndFocus(id: string): void {
  const el = document.getElementById(id);
  if (!el) return;
  el.scrollIntoView({ behavior: prefersReducedMotion() ? 'auto' : 'smooth', block: 'center' });
  if (el instanceof HTMLElement) el.focus({ preventScroll: true });
}
