import { useEffect } from 'react';
import { Outlet, useLocation } from 'react-router-dom';
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
       * md:pb-0 cancels this at the exact breakpoint where the bar itself
       * stops existing (`md:hidden` in FloatingWhatsApp) — desktop gains
       * nothing.
       */}
      <main id="main" className="flex-1 pb-32 md:pb-0">
        <Outlet />
      </main>
      <SiteFooter />
      <FloatingWhatsApp />
    </div>
  );
}
