/**
 * The shell every driver screen hangs off (Week 6 plan, Task 9 — BUILD_SPEC
 * §8). Follows `AdminLayout.tsx` for the house conventions: a skip link
 * first in the DOM, a `<header>`, a `<main>` holding `<Outlet/>`, no
 * footer and no WhatsApp bubble — a driver portal is a work surface, never
 * a page a guest sees.
 *
 * `driver/login` stays OUTSIDE this layout (see `App.tsx`), because a
 * sign-in screen must not render chrome that assumes a session exists.
 *
 * ## Deliberately almost empty
 *
 * There is no nav here yet. §8 gives the driver three tabs — Today /
 * Upcoming / History — and the design doc puts them **bottom-anchored with
 * `env(safe-area-inset-bottom)` padding**; that is Task 10's trip list,
 * which owns the tabs because it owns the three buckets they switch
 * between. Putting a nav here now would be a second place that decides
 * what "today" means.
 *
 * What the shell does owe a driver is the way out, and that is here rather
 * than on a screen: a driver hands a phone back at the end of a shift, and
 * `clearSessionCookie` has to be reachable from wherever they are standing.
 *
 * ## The header is not sticky
 *
 * Same reason `AdminLayout`'s is not: nothing in it needs pinning, and a
 * sticky bar on a 360px screen eats the vertical space the trip screen
 * spends on stops. The bottom tabs Task 10 adds are the fixed element.
 */
import { LogOut } from 'lucide-react';
import { Outlet, useNavigate } from 'react-router-dom';
import { SITE } from '@/lib/site';
import { trpc } from '@/lib/trpc';

/**
 * Ends the session — the row and the cookie both, which is what
 * `driver.logout` does server-side.
 *
 * Unconditional, exactly as `AdminLayout`'s is: there is no `driver.me`
 * query to gate it on, and gating it on one would be wrong anyway. A
 * driver who cannot sign out because a lookup failed is a security
 * problem, not a cosmetic one. `driver.logout` is a `publicProcedure` for
 * the same reason, so it succeeds quietly even on a session that has
 * already lapsed — and the navigation below happens regardless, because a
 * driver pressing Sign out must end up at the sign-in screen whatever the
 * server said.
 */
function DriverSignOut() {
  const navigate = useNavigate();
  const toLogin = () => navigate('/driver/login', { replace: true });
  const logout = trpc.driver.logout.useMutation({ onSuccess: toLogin, onError: toLogin });

  return (
    <button
      type="button"
      onClick={() => logout.mutate()}
      disabled={logout.isPending}
      className="tap-target press text-brand-blue-900 focus-visible:ring-brand-blue-600 flex items-center gap-1.5 rounded-md px-3 text-base font-semibold focus-visible:outline-none focus-visible:ring-2 disabled:opacity-50"
    >
      <LogOut className="size-5" aria-hidden="true" />
      Sign out
    </button>
  );
}

export default function DriverLayout() {
  return (
    <div className="bg-brand-blue-50 flex min-h-dvh flex-col">
      <a
        href="#driver-main"
        className="bg-brand-blue-700 focus:ring-brand-gold-400 sr-only inline-flex min-h-11 items-center rounded-md px-4 py-2 text-white focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-50 focus:ring-2"
      >
        Skip to main content
      </a>

      <header className="border-border bg-background border-b">
        <div className="mx-auto flex h-16 w-full max-w-2xl items-center justify-between gap-3 px-4">
          {/*
           * The BRAND, not the legal operator: this is a working screen,
           * not a receipt (CLAUDE.md "Brand vs legal entity"). Plain text
           * rather than a link — there is nowhere else to go from here
           * until Task 10, and a logo that navigates is a mis-tap.
           */}
          <span className="text-brand-blue-900 text-base font-bold">{SITE.name} drivers</span>
          <DriverSignOut />
        </div>
      </header>

      <main id="driver-main" className="mx-auto w-full max-w-2xl flex-1 px-4 py-4">
        <Outlet />
      </main>
    </div>
  );
}
