import { Menu, Phone, X } from 'lucide-react';
import { useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { SITE } from '@/lib/site';
import { cn } from '@/lib/utils';

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
  const { pathname, hash } = useLocation();

  return (
    <header className="bg-background/95 supports-[backdrop-filter]:bg-background/80 sticky top-0 z-40 w-full border-b backdrop-blur">
      <div className="mx-auto flex h-16 max-w-7xl items-center justify-between gap-4 px-4 sm:px-6 lg:px-8">
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
            href={`tel:${SITE.contact.phone.replace(/\s/g, '')}`}
            className="text-brand-blue-700 tap-target hidden items-center gap-2 rounded-md px-3 text-sm font-semibold lg:flex"
          >
            <Phone className="size-4" aria-hidden="true" />
            {SITE.contact.phone}
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
