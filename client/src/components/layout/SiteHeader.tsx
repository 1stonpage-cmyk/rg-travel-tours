import { Menu, Phone, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { SITE, telLink } from '@/lib/site';
import { cn } from '@/lib/utils';

/**
 * How far past the top the page must scroll before the header solidifies
 * (spec task 2.9F). Small and deliberate: the effect should read as "the
 * header noticed you started scrolling", not trigger on a stray wheel tick.
 */
const SCROLL_SOLIDIFY_PX = 24;

/**
 * A nav item is "active" only when it is the genuinely-current location.
 * `NavLink`'s default matching compares pathname only, so every "/#..."
 * same-page anchor (pathname "/") would light up at once while on the home
 * page. Hash-aware links must also match the current hash.
 */
function isNavItemActive(href: string, pathname: string, hash: string) {
  const [path, anchor] = href.split('#');
  if (anchor) {
    return pathname === (path || '/') && hash === `#${anchor}`;
  }
  return pathname === href;
}

export default function SiteHeader() {
  const [open, setOpen] = useState(false);
  const [scrolled, setScrolled] = useState(false);
  const { pathname, hash } = useLocation();

  // Header shrink/solidify (spec task 2.9F). Deliberately does not animate
  // `height`, or change it at all, in either direction: the box below is
  // always `h-16` regardless of `scrolled`, so the header's real resting
  // height never changes, and `section[id] { scroll-margin-top: 5rem }`
  // (index.css, tuned to this exact h-16/64px header) stays correct in both
  // states — there is only ever one height to tune it against. "Shrinking"
  // is purely a `scale` transform on the inner content, which — like every
  // transform — never affects layout or this header's own box size, so
  // there is nothing here that could cause layout shift. No reduced-motion
  // CSS override is needed beyond the existing blanket
  // `prefers-reduced-motion` clamp in index.css: that already collapses
  // this transition to instant, and both the scrolled and unscrolled states
  // are correct, legible markup on their own.
  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > SCROLL_SOLIDIFY_PX);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  return (
    <header
      className={cn(
        'sticky top-0 z-40 w-full border-b backdrop-blur transition-all duration-300 ease-[cubic-bezier(0.2,0.6,0.2,1)]',
        scrolled
          ? 'bg-background shadow-md'
          : 'bg-background/95 supports-[backdrop-filter]:bg-background/80',
      )}
    >
      <div
        className={cn(
          'mx-auto flex h-16 max-w-7xl items-center justify-between gap-4 px-4 transition-transform duration-300 ease-[cubic-bezier(0.2,0.6,0.2,1)] sm:px-6 lg:px-8',
          scrolled && 'scale-[0.95]',
        )}
      >
        <Link
          to="/"
          className="tap-target flex items-center gap-2 rounded-md"
          aria-label={`${SITE.name} — home`}
        >
          <span className="bg-brand-blue-600 flex size-9 items-center justify-center rounded-lg">
            <span className="text-brand-gold-300 text-sm font-bold">{SITE.shortMark}</span>
          </span>
          <span className="hidden flex-col leading-tight sm:flex">
            <span className="text-brand-blue-900 text-sm font-bold">{SITE.name}</span>
            <span className="text-muted-foreground text-xs">Cebu, Philippines</span>
            {/* Operator credit — desktop only; the header is h-16 and a third
                line is too tight below lg. The footer carries it at every width. */}
            <span className="text-muted-foreground hidden text-[11px] lg:block">
              by {SITE.legalOperator}
            </span>
          </span>
        </Link>

        <nav aria-label="Main" className="hidden items-center gap-1 md:flex">
          {SITE.nav.map((item) => {
            const active = isNavItemActive(item.href, pathname, hash);
            return (
              <Link
                key={item.href}
                to={item.href}
                aria-current={active ? 'page' : undefined}
                className={cn(
                  'rounded-md px-3 py-2 text-sm font-medium transition-colors',
                  'hover:bg-brand-blue-50 hover:text-brand-blue-700',
                  active ? 'text-brand-blue-700' : 'text-brand-ink/80',
                )}
              >
                {item.label}
              </Link>
            );
          })}
        </nav>

        <div className="flex items-center gap-2">
          <a
            href={telLink(SITE.contact.phone.tel)}
            className="text-brand-blue-700 tap-target hidden items-center gap-2 rounded-md px-3 text-sm font-semibold lg:flex"
          >
            <Phone className="size-4" aria-hidden="true" />
            {SITE.contact.phone.display}
          </a>
          <Button asChild className="tap-target hidden sm:inline-flex">
            <Link to="/tours">Book a tour</Link>
          </Button>
          <Button
            variant="outline"
            size="icon"
            className="tap-target md:hidden"
            aria-expanded={open}
            aria-controls="mobile-nav"
            aria-label={open ? 'Close menu' : 'Open menu'}
            onClick={() => setOpen((v) => !v)}
          >
            {open ? <X className="size-5" /> : <Menu className="size-5" />}
          </Button>
        </div>
      </div>

      {open && (
        <nav id="mobile-nav" aria-label="Mobile" className="border-t md:hidden">
          <ul className="mx-auto max-w-7xl px-4 py-2 sm:px-6">
            {SITE.nav.map((item) => (
              <li key={item.href}>
                <Link
                  to={item.href}
                  onClick={() => setOpen(false)}
                  className="text-brand-ink hover:bg-brand-blue-50 flex min-h-11 items-center rounded-md px-3 text-base font-medium"
                >
                  {item.label}
                </Link>
              </li>
            ))}
            <li className="py-2">
              <Button asChild className="tap-target w-full">
                <Link to="/tours" onClick={() => setOpen(false)}>
                  Book a tour
                </Link>
              </Button>
            </li>
          </ul>
        </nav>
      )}
    </header>
  );
}
