import { useEffect } from 'react';
import { Outlet, useLocation } from 'react-router-dom';
import { STATIC_PUBLIC_TITLES, type StaticPublicPath } from '@rg/shared';
import CookieConsentBanner from '@/components/common/CookieConsentBanner';
import CookieCustomizePanel from '@/components/common/CookieCustomizePanel';
import { ConsentProvider } from '@/lib/consent/ConsentContext';
import { useConsent } from '@/lib/consent/useConsent';
import { useDocumentTitle } from '@/hooks/useDocumentTitle';
import { cn } from '@/lib/utils';
import AnnouncementBar from './AnnouncementBar';
import FloatingWhatsApp from './FloatingWhatsApp';
import PlaceholderBadge from './PlaceholderBadge';
import SiteFooter from './SiteFooter';
import SiteHeader from './SiteHeader';

/**
 * Split out so it can read `bannerOpen` — `PublicLayout`'s own return is `ConsentProvider`'s
 * root, so it can't call `useConsent()` itself; a child a level down can.
 *
 * While the cookie banner is showing, its own `pb-mobile-bar-safe` reservation (sized for
 * `FloatingWhatsApp`'s bar, which hides whenever the banner does — see FloatingWhatsApp.tsx) is
 * swapped for a taller one sized for the banner itself: task 2D's "must not cover checkout
 * buttons at 360px" needs the LAST element of whatever page is in `<Outlet/>` to always be
 * scrollable clear of whichever fixed-bottom element is actually on screen, not just the one
 * that happened to be there when `.pb-mobile-bar-safe` was first tuned (BUG-078/079). `pb-48`
 * covers the banner's stacked mobile layout (text block + a 3-button row + padding); `sm:pb-28`
 * covers its shorter sm+ single-row layout.
 */
function MainContent() {
  const { bannerOpen } = useConsent();
  return (
    <main id="main" className={cn('flex-1', bannerOpen ? 'pb-48 sm:pb-28' : 'pb-mobile-bar-safe')}>
      <Outlet />
    </main>
  );
}

/**
 * The page name for a public route, or `null` to leave the server's injected
 * title alone.
 *
 * Only the routes whose title no database row owns are named here, and the
 * names come from `@rg/shared` rather than this file (see
 * `hooks/useDocumentTitle.ts`). `/`, `/tours/:slug` and `/packages/:slug`
 * resolve their titles from `settings.site_seo` and each row's own
 * `seo_title`; the browser cannot read either, so they get `null` and keep
 * exactly the behaviour they have today. `/checkout/:slug` and
 * `/booking/:ref` are noindex thin-content screens with no injected title of
 * their own to improve on.
 */
function publicTitle(pathname: string): string | null {
  const path = pathname.replace(/\/+$/, '') || '/';
  return STATIC_PUBLIC_TITLES[path as StaticPublicPath] ?? null;
}

export default function PublicLayout() {
  const { pathname, hash } = useLocation();

  useDocumentTitle(publicTitle(pathname));

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
    <ConsentProvider>
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
         * Bottom padding reserved for whichever fixed-bottom element is actually on screen —
         * FloatingWhatsApp's mobile bar (spec task 2.9B; fix round 1, F2 / BUG-078) normally, the
         * cookie consent banner while it's showing (task 2D). See MainContent above for why this
         * had to become conditional rather than the one flat class it used to be.
         *
         * ~128px (`.pb-mobile-bar-safe`, index.css) comfortably covers the WhatsApp bar's real
         * worst-case height: a 56px icon button + 12px top padding + max(12px, the safe-area
         * inset on a notched phone, up to ~34px) bottom padding + a 1px border ≈ 81–103px.
         *
         * BUG-079: that 128px (8rem) is a flat number, but the bar's own bottom padding is
         * `max(0.75rem, env(safe-area-inset-bottom))` — on a notched phone the inset can exceed
         * the 0.75rem already folded into the 103px estimate above, making the flat reservation
         * short and letting the bar sit over whatever the page scrolls up against it.
         * `.pb-mobile-bar-safe` adds the same `env(safe-area-inset-bottom)` on top of the flat
         * 8rem so the reservation grows with the inset instead of assuming a fixed worst case.
         * This is reasoned, not measured — there was no notched device to confirm it against;
         * see the task report. The class also cancels to 0 at the exact breakpoint where the bar
         * itself stops existing (`md:hidden` in FloatingWhatsApp) — desktop gains nothing.
         */}
        <MainContent />
        <SiteFooter />
        <FloatingWhatsApp />
        <CookieConsentBanner />
        <CookieCustomizePanel />
      </div>
    </ConsentProvider>
  );
}
