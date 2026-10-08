import { MessageCircle } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { SITE, whatsappLink } from '@/lib/site';

/**
 * The hero's search form is the page's primary CTA. The button is fixed in the
 * viewport's bottom-right corner, so as the page scrolls that corner sweeps the
 * whole document and lands on the form's right edge — measured at 360px and
 * 390px, where it covered ~40px of the "Search tours" button (and at 390px it
 * did so at first paint, before any scrolling).
 *
 * Raising the offset or padding the page does not fix that: a fixed element
 * still passes over everything on the way down. So the button is hidden while
 * the search form is on screen and returns once it scrolls away.
 *
 * Scoped deliberately to the hero form rather than the whole hero section, so
 * the button comes back as soon as the CTA it was covering is gone. Pages
 * without that form (e.g. /tours) are unaffected — it shows throughout.
 */
const HERO_SEARCH_FORM = 'form[aria-label="Search tours"]';

export default function FloatingWhatsApp() {
  const { pathname } = useLocation();
  const [coversHeroSearch, setCoversHeroSearch] = useState(false);

  useEffect(() => {
    // jsdom has no IntersectionObserver; degrade to always-visible rather than
    // throwing. Real behaviour is verified in a browser.
    if (typeof IntersectionObserver === 'undefined') return;

    const target = document.querySelector(HERO_SEARCH_FORM);
    if (!target) {
      setCoversHeroSearch(false);
      return;
    }

    const observer = new IntersectionObserver(([entry]) =>
      setCoversHeroSearch(entry?.isIntersecting ?? false),
    );
    observer.observe(target);
    return () => observer.disconnect();
  }, [pathname]);

  if (coversHeroSearch) return null;

  return (
    <a
      href={whatsappLink(`Hi ${SITE.name}! I'd like to ask about a Cebu tour.`)}
      target="_blank"
      rel="noreferrer noopener"
      aria-label="Chat with us on WhatsApp"
      className="bg-brand-blue-600 hover:bg-brand-blue-700 focus-visible:ring-brand-gold-400 attention-pulse fixed bottom-4 right-4 z-50 flex min-h-14 min-w-14 items-center justify-center gap-2 rounded-full px-4 text-white shadow-lg transition-transform hover:scale-105 sm:bottom-6 sm:right-6"
    >
      <MessageCircle className="size-6" aria-hidden="true" />
      <span className="hidden text-sm font-semibold sm:inline">WhatsApp</span>
    </a>
  );
}
