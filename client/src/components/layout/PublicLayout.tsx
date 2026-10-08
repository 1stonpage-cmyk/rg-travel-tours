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
      <main id="main" className="flex-1">
        <Outlet />
      </main>
      <SiteFooter />
      <FloatingWhatsApp />
    </div>
  );
}
