import { useEffect } from 'react';
import { Outlet, useLocation } from 'react-router-dom';
import AnnouncementBar from './AnnouncementBar';
import FloatingWhatsApp from './FloatingWhatsApp';
import PlaceholderBadge from './PlaceholderBadge';
import SiteFooter from './SiteFooter';
import SiteHeader from './SiteHeader';

export default function PublicLayout() {
  const { pathname, hash } = useLocation();

  // React Router does not perform the browser's native fragment scroll on
  // client-side navigation (pushState never triggers it). Do it ourselves:
  // when the hash changes (including arriving from a different route in the
  // same navigation), find the target section and scroll to it. The
  // requestAnimationFrame gives the destination route's DOM a tick to
  // render before we look up the id — e.g. navigating from /tours to /#faq
  // mounts the home page's sections in the same transition.
  useEffect(() => {
    if (!hash) return;

    const frame = requestAnimationFrame(() => {
      const target = document.getElementById(hash.slice(1));
      if (!target) return;
      const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      target.scrollIntoView({ behavior: prefersReducedMotion ? 'auto' : 'smooth', block: 'start' });
    });

    return () => cancelAnimationFrame(frame);
  }, [pathname, hash]);

  return (
    <div className="flex min-h-dvh flex-col">
      <a
        href="#main"
        className="bg-brand-blue-700 focus:ring-brand-gold-400 sr-only inline-flex min-h-11 items-center rounded-md px-4 py-2 text-white focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-50 focus:ring-2"
      >
        Skip to main content
      </a>
      <PlaceholderBadge />
      {/*
       * Deliberately in normal document flow, not sticky/fixed — same
       * mechanism as PlaceholderBadge just above it. SiteHeader is the only
       * sticky element (`sticky top-0`); this bar scrolls away with the
       * page, so once scrolled past it the header is still the sole element
       * pinned at the viewport top. `section[id] { scroll-margin-top: 5rem
       * }` (index.css) is tuned to the header's own h-16 box and stays
       * correct regardless of whether this bar is mounted, its height, or
       * its presence — there is nothing here for a hash link (#tours, #faq,
       * etc.) to land wrong against. Do not make this sticky: a sticky bar
       * would add its own height to the real top offset and require
       * re-tuning scroll-margin-top (task 2.9F deliberately kept the header
       * at one fixed height so there would only ever be one number to tune).
       */}
      <AnnouncementBar />
      <SiteHeader />
      {/*
       * Bottom padding reserved for the mobile sticky bar in FloatingWhatsApp
       * (spec task 2.9B; fix round 1, F2 / BUG-078). The bar is `position:
       * fixed`, so it occupies no layout space of its own — nothing pushes
       * the last element of whatever page is in <Outlet/> clear of it. This
       * padding does that unconditionally (not toggled with the bar's own
       * show/hide state, matching the existing precedent in SiteFooter's own
       * pb-20/sm:pb-24, reserved the same way for the floating bubble), so
       * the very last interactive element on ANY page — not just the ones
       * this task happened to check by hand — can always be scrolled clear
       * of the bar, independent of the bar's own "hide near the footer"
       * timing.
       *
       * ~128px comfortably covers the bar's real worst-case height: a 56px
       * icon button + 12px top padding + max(12px, the safe-area inset on a
       * notched phone, up to ~34px) bottom padding + a 1px border ≈ 81–103px.
       *
       * BUG-079: that 128px (8rem) is a flat number, but the bar's own
       * bottom padding is `max(0.75rem, env(safe-area-inset-bottom))` — on
       * a notched phone the inset can exceed the 0.75rem already folded
       * into the 103px estimate above, making the flat reservation short
       * and letting the bar sit over whatever the page scrolls up against
       * it. `.pb-mobile-bar-safe` (index.css) adds the same
       * `env(safe-area-inset-bottom)` on top of the flat 8rem so the
       * reservation grows with the inset instead of assuming a fixed worst
       * case. This is reasoned, not measured — there was no notched device
       * to confirm it against; see the task report.
       *
       * The class also cancels to 0 at the exact breakpoint where the bar
       * itself stops existing (`md:hidden` in FloatingWhatsApp) — desktop
       * gains nothing.
       */}
      <main id="main" className="pb-mobile-bar-safe flex-1">
        <Outlet />
      </main>
      <SiteFooter />
      <FloatingWhatsApp />
    </div>
  );
}
