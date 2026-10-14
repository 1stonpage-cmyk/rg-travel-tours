import { LogOut } from 'lucide-react';
import { Link, NavLink, Outlet, useNavigate } from 'react-router-dom';
import { trpc } from '@/lib/trpc';

/**
 * The shell every admin/dispatch screen (Week 5, Tasks 5/7/9/14) and the
 * two existing Week 4 bookings screens hang off. Follows `PublicLayout.tsx`
 * for the house conventions: a skip link first in the DOM, a `<header>`
 * carrying the nav, and a `<main>` holding `<Outlet/>` — but this header is
 * NOT sticky (see the comment on the `<header>` below for why) and there is
 * no footer or WhatsApp bubble: this is a staff workspace, never a page a
 * guest sees.
 *
 * `admin/login` (Week 4 Task 5) stays OUTSIDE this layout — see `App.tsx`
 * — because a sign-in screen must not render a nav that assumes a session
 * already exists.
 */

/**
 * Five destinations, which is also the bottom-nav ceiling the UX guidance
 * names ("bottom nav limit") — so the same five links can become a mobile
 * bottom bar later without needing a "more" menu. `/admin` is the
 * dashboard (Task 14, not yet built — see the index route in `App.tsx`);
 * `/admin/bookings` exists today (Week 4); `/admin/calendar`, `/admin/vans`
 * and `/admin/drivers` belong to Tasks 9, 5 and 7 and do not exist yet.
 * These links point at them anyway — a 404 on one of those three before
 * its task lands is the router's ordinary, existing behaviour, not
 * something this layout works around.
 */
const NAV = [
  { to: '/admin', label: 'Dashboard', end: true },
  { to: '/admin/bookings', label: 'Bookings', end: false },
  { to: '/admin/calendar', label: 'Calendar', end: false },
  { to: '/admin/vans', label: 'Vans', end: false },
  { to: '/admin/drivers', label: 'Drivers', end: false },
] as const;

/** `role` as `staffAuth.me` returns it (`ADMIN_ROLES`) — title-cased for display. */
function roleLabel(role: string): string {
  return role.charAt(0).toUpperCase() + role.slice(1);
}

/**
 * The signed-in operator's role, and the control that ends their session.
 *
 * `trpc.staffAuth.me` needs a tRPC Provider above it in the tree — `main.tsx`
 * always supplies one, so this is never conditional in the real app. It IS
 * conditional in a test, and in a real session that has gone stale (an
 * expired cookie, a 500, a network blip): the query can be pending or can
 * fail. Neither state is allowed to take the sign-out button down with it —
 * an operator on a shared office machine who cannot sign out because a
 * `me` lookup failed is a security problem, not a cosmetic one. So the
 * button below is unconditional; only the identity slot above it (a
 * skeleton while loading, a short notice on failure, the role once it
 * resolves) changes with the query state.
 */
function StaffIdentity() {
  const navigate = useNavigate();
  const me = trpc.staffAuth.me.useQuery(undefined, { retry: false });
  const logout = trpc.staffAuth.logout.useMutation({
    onSuccess: () => navigate('/admin/login', { replace: true }),
  });

  return (
    <div className="flex items-center gap-3">
      {me.isPending ? (
        <span
          aria-hidden="true"
          className="bg-muted hidden h-4 w-14 animate-pulse rounded sm:inline-block"
        />
      ) : me.isError ? (
        // Dark blue/grey, never red (CLAUDE.md) — and the sign-out button
        // below stays reachable regardless, which is the point.
        <span role="alert" className="text-brand-error text-xs font-medium">
          Could not confirm your session.
        </span>
      ) : me.data ? (
        // Always visible, down to 360px (fix round 2, N1) — on a shared
        // office machine, which role is signed in is the one piece of
        // identity that matters, so it cannot be a desktop-only extra.
        <span className="text-muted-foreground text-xs sm:text-sm">{roleLabel(me.data.role)}</span>
      ) : null}
      <button
        type="button"
        onClick={() => logout.mutate()}
        disabled={logout.isPending}
        className="tap-target text-brand-ink/80 hover:text-brand-blue-700 flex items-center gap-1.5 rounded-md px-3 text-sm font-medium transition-colors disabled:opacity-50"
      >
        <LogOut className="size-4" aria-hidden="true" />
        Sign out
      </button>
    </div>
  );
}

export default function AdminLayout() {
  return (
    <div className="flex min-h-dvh flex-col">
      <a
        href="#admin-main"
        className="bg-brand-blue-700 focus:ring-brand-gold-400 sr-only inline-flex min-h-11 items-center rounded-md px-4 py-2 text-white focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-50 focus:ring-2"
      >
        Skip to main content
      </a>

      {/*
       * Two rows, not one — five text labels plus the brand mark and the
       * sign-out control do not fit a single `h-14` row at 360px without
       * either shrinking the tap targets below 44px or introducing a
       * horizontal scrollbar (both ruled out: the former breaks the tap
       * target floor, the latter is the `ui-ux-pro-max` "avoid horizontal
       * scrolling" guidance this task ran). Splitting the identity row from
       * the nav row, with the nav items sharing the full width evenly
       * (`flex-1` below `sm`), fits all five comfortably at 360px with room
       * to spare — and is also plainly why this header is NOT `sticky`
       * (unlike `SiteHeader`): a sticky two-row header of unpredictable
       * total height would need `main` below to carry matching top padding
       * (the "sticky nav overlap content" guidance this task also ran), and
       * nothing here needs to be pinned yet.
       */}
      <header className="border-border bg-background border-b">
        <div className="mx-auto max-w-6xl px-4">
          <div className="flex h-14 items-center justify-between gap-4">
            <Link
              to="/admin"
              className="tap-target text-brand-blue-900 flex items-center text-sm font-bold"
            >
              Dispatch
            </Link>

            <StaffIdentity />
          </div>

          <nav
            aria-label="Admin"
            className="border-border flex items-center gap-1 border-t py-1 sm:justify-start sm:gap-2"
          >
            {NAV.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                end={item.end}
                className={({ isActive }) =>
                  [
                    // `border-b-2` is reserved on EVERY item (not just the
                    // active one) so the border's own width never shifts
                    // the layout when the active item changes — only its
                    // colour toggles between transparent and visible.
                    'tap-target flex flex-1 items-center justify-center rounded-md border-b-2 px-2 text-center text-xs transition-colors sm:flex-none sm:px-3 sm:text-sm',
                    'hover:bg-brand-blue-50 hover:text-brand-blue-700',
                    // `NavLink` sets `aria-current="page"` on the active
                    // link by itself (and nothing on every other one) —
                    // that is the signal assistive tech reads. For a
                    // sighted dispatcher, including anyone with a colour
                    // vision deficiency, the PRIMARY visible signal is the
                    // border and the weight change: a visible edge and a
                    // heavier glyph are shape differences that survive
                    // greyscale, unlike a colour swap. Fix round 2 (F1):
                    // the colour change below is reinforcement on top of
                    // that, never the only signal.
                    isActive
                      ? 'border-brand-blue-700 text-brand-blue-700 font-semibold'
                      : 'text-brand-ink/80 border-transparent font-medium',
                  ].join(' ')
                }
              >
                {item.label}
              </NavLink>
            ))}
          </nav>
        </div>
      </header>

      <main id="admin-main" className="flex-1">
        <Outlet />
      </main>
    </div>
  );
}
