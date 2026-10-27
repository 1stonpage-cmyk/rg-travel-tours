import { useQueryClient } from '@tanstack/react-query';
import { LogOut, Menu, X } from 'lucide-react';
import { useState } from 'react';
import { Link, Navigate, NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { APP_SURFACE_TITLES } from '@rg/shared';
import { useDocumentTitle } from '@/hooks/useDocumentTitle';
import { trpc } from '@/lib/trpc';
import { navFor } from './admin-nav';

/**
 * The shell every admin/dispatch screen hangs off: a dark sidebar from `lg`
 * up, and on a phone a dark top bar with a menu button plus a bottom bar of
 * quick links. Follows `PublicLayout.tsx` for the house conventions - a skip
 * link first in the DOM and ONE `<main>` holding `<Outlet/>` - but there is
 * no footer or WhatsApp bubble: this is a staff workspace, never a page a
 * guest sees.
 *
 * `admin/login` stays OUTSIDE this layout (see `App.tsx`) because a sign-in
 * screen must not render a nav that assumes a session already exists.
 *
 * Which links are drawn depends on the signed-in role (`admin-nav.ts`). That
 * is cosmetic: the server refuses every procedure a role may not call.
 */

/** Where an account with a temporary password is held until it has chosen its own. */
const CHANGE_PASSWORD_PATH = '/admin/change-password';

/** `role` as `staffAuth.me` returns it (`ADMIN_ROLES`) - title-cased for display. */
function roleLabel(role: string): string {
  return role.charAt(0).toUpperCase() + role.slice(1);
}

const SIDE_LINK =
  'tap-target flex items-center justify-between gap-2 rounded-lg px-3 text-sm transition-colors';

/**
 * The signed-in operator's role, the control that ends their session, and
 * the change-password link.
 *
 * `trpc.staffAuth.me` needs a tRPC Provider above it in the tree - `main.tsx`
 * always supplies one. The query can be pending or can fail (an expired
 * cookie, a 500, a network blip); neither state is allowed to take the
 * sign-out button down with it. An operator on a shared office machine who
 * cannot sign out because a `me` lookup failed is a security problem, not a
 * cosmetic one. So the button is unconditional; only the identity slot above
 * it (a skeleton while loading, a short notice on failure, the role once it
 * resolves) changes with the query state.
 */
function SidebarFooter({ showAccountLink }: { showAccountLink: boolean }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const me = trpc.staffAuth.me.useQuery(undefined, { retry: false });
  const logout = trpc.staffAuth.logout.useMutation({
    onSuccess: () => {
      // The next person at this screen must not see this person's cached identity.
      queryClient.clear();
      navigate('/admin/login', { replace: true });
    },
  });

  return (
    <div className="border-brand-blue-800 mt-auto flex flex-col gap-1 border-t px-2 pt-4">
      {me.isPending ? (
        <span aria-hidden="true" className="bg-brand-blue-800 h-4 w-16 animate-pulse rounded" />
      ) : me.isError ? (
        // Dark blue/grey, never red (CLAUDE.md) - and the sign-out button
        // below stays reachable regardless, which is the point.
        <span role="alert" className="text-brand-blue-100 text-xs font-medium">
          Could not confirm your session.
        </span>
      ) : me.data ? (
        <span className="flex flex-col">
          <span className="truncate text-sm font-semibold text-white">{me.data.name}</span>
          <span className="text-brand-blue-100 text-xs">{roleLabel(me.data.role)}</span>
        </span>
      ) : null}

      {showAccountLink ? (
        <nav aria-label="Account">
          <NavLink
            to={CHANGE_PASSWORD_PATH}
            className={({ isActive }) =>
              [
                'tap-target text-brand-gold-200 hover:text-brand-gold-50 -mx-1 flex items-center rounded-md px-1 text-[13px] underline-offset-4 transition-colors hover:underline',
                isActive ? 'font-semibold underline' : '',
              ].join(' ')
            }
          >
            Change password
          </NavLink>
        </nav>
      ) : null}

      <button
        type="button"
        onClick={() => logout.mutate()}
        disabled={logout.isPending}
        className="tap-target text-brand-blue-100 hover:bg-brand-blue-900 -mx-1 flex items-center gap-2 rounded-md px-1 text-[13px] font-medium transition-colors hover:text-white disabled:opacity-50"
      >
        <LogOut className="size-4" aria-hidden="true" />
        Sign out
      </button>
    </div>
  );
}

export default function AdminLayout() {
  const location = useLocation();
  /*
   * The same words the server injects for `/admin` (`APP_SURFACE_TITLES`,
   * `@rg/shared`), re-asserted so a staff member who arrives here from a
   * public page by a client-side navigation does not keep that page's tab
   * title. One name for the whole console on purpose: a screen title would
   * have to be decided per route, and every one of them is "Staff console".
   */
  useDocumentTitle(APP_SURFACE_TITLES['/admin']);
  const me = trpc.staffAuth.me.useQuery(undefined, { retry: false });
  const mustChange = me.data?.mustChangePassword === true;
  const role = me.data?.role;
  const nav = navFor(role);

  // The payment-checks count beside its link. It is the dashboard's own alert
  // (no new data), asked for only by the roles who can open that screen, and
  // drawn only when above zero: an unknown count is left out, never guessed.
  const showsPaymentBadge = nav.some((item) => item.badge === 'payments_to_verify');
  const alerts = trpc.admin.dashboard.alerts.useQuery(undefined, {
    retry: false,
    enabled: showsPaymentBadge && !mustChange,
  });
  const paymentsWaiting =
    alerts.data?.find((alert) => alert.kind === 'payments_to_verify')?.count ?? 0;

  // The phone menu is open for the page it was opened on and closes when the
  // route changes, with no effect needed to reset it.
  const [menuPath, setMenuPath] = useState<string | null>(null);
  const menuOpen = menuPath === location.pathname;
  // Held open while a password change is owed or the identity lookup failed,
  // so a phone user can always reach Sign out.
  const drawerOpen = menuOpen || mustChange || me.isError;

  // A convenience, not the control: the server already refuses every admin
  // procedure while a password change is owed. This just stops the screens
  // from filling with refusals by sending the person where they can act.
  if (mustChange && location.pathname !== CHANGE_PASSWORD_PATH) {
    return <Navigate to={CHANGE_PASSWORD_PATH} replace />;
  }

  const quick = nav.filter((item) => item.quick);

  return (
    <div className="bg-brand-blue-50 text-brand-ink min-h-dvh lg:flex">
      <a
        href="#admin-main"
        className="bg-brand-blue-700 focus:ring-brand-gold-400 sr-only inline-flex min-h-11 items-center rounded-md px-4 py-2 text-white focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-50 focus:ring-2"
      >
        Skip to main content
      </a>

      {/* Phone top bar. From `lg` the sidebar's own brand block takes over. */}
      <header className="bg-brand-ink sticky top-0 z-40 flex items-center justify-between px-4 py-3 text-white lg:hidden">
        <Link to="/admin" className="tap-target flex items-center gap-2.5 rounded-md">
          <img
            src="/brand/icon-192.png"
            alt=""
            aria-hidden="true"
            width={192}
            height={192}
            className="size-9 rounded-full"
          />
          <span className="text-base font-bold">Staff console</span>
        </Link>
        <button
          type="button"
          aria-label={drawerOpen ? 'Close menu' : 'Open menu'}
          aria-expanded={drawerOpen}
          aria-controls="admin-sidebar"
          onClick={() => setMenuPath(menuOpen ? null : location.pathname)}
          className="border-brand-blue-800 hover:bg-brand-blue-900 flex size-11 items-center justify-center rounded-[10px] border transition-colors"
        >
          {drawerOpen ? (
            <X className="size-5" aria-hidden="true" />
          ) : (
            <Menu className="size-5" aria-hidden="true" />
          )}
        </button>
      </header>

      <aside
        id="admin-sidebar"
        className={[
          'bg-brand-ink flex-col gap-6 px-4 py-6 text-white',
          'lg:sticky lg:top-0 lg:flex lg:h-dvh lg:w-60 lg:shrink-0 lg:overflow-y-auto',
          drawerOpen ? 'flex' : 'hidden',
        ].join(' ')}
      >
        <Link
          to="/admin"
          className="tap-target hidden flex-col items-start gap-1 rounded-md px-2 lg:flex"
          aria-label="TravelSugbo staff console, dashboard"
        >
          <img
            src="/brand/travelsugbo-logo-horizontal-white.png"
            srcSet="/brand/travelsugbo-logo-horizontal-white.png 1x, /brand/travelsugbo-logo-horizontal-white@2x.png 2x"
            width={225}
            height={64}
            alt=""
            aria-hidden="true"
            className="h-8 w-auto"
          />
          <span className="text-brand-blue-200 text-xs">Staff console</span>
        </Link>

        {mustChange ? null : (
          <nav aria-label="Admin" className="flex flex-col gap-1">
            {nav.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                end={item.end}
                className={({ isActive }) =>
                  [
                    SIDE_LINK,
                    // `NavLink` sets `aria-current="page"` on the active link
                    // by itself. For a sighted operator, including anyone with
                    // a colour vision deficiency, the weight change and the
                    // filled bar are shape differences that survive greyscale.
                    isActive
                      ? 'bg-brand-blue-700 font-semibold text-white'
                      : 'text-brand-blue-100 hover:bg-brand-blue-900 font-medium hover:text-white',
                  ].join(' ')
                }
              >
                {item.label}
                {item.badge === 'payments_to_verify' && paymentsWaiting > 0 ? (
                  <span className="bg-brand-gold-500 text-brand-ink rounded-full px-2 py-0.5 text-xs font-bold tabular-nums">
                    {paymentsWaiting}
                    <span className="sr-only"> waiting</span>
                  </span>
                ) : null}
              </NavLink>
            ))}
          </nav>
        )}

        <SidebarFooter showAccountLink={!mustChange} />
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <main id="admin-main" className="flex-1 pb-24 lg:pb-0">
          <div className="mx-auto w-full max-w-6xl px-4 py-6 sm:px-6 lg:px-8 lg:py-8">
            <Outlet />
          </div>
        </main>

        {mustChange || quick.length === 0 ? null : (
          <nav
            aria-label="Quick links"
            style={{ gridTemplateColumns: `repeat(${quick.length}, minmax(0, 1fr))` }}
            className="border-brand-blue-100 fixed inset-x-0 bottom-0 z-30 grid border-t bg-white pb-[env(safe-area-inset-bottom)] lg:hidden"
          >
            {quick.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                end={item.end}
                className={({ isActive }) =>
                  [
                    'tap-target flex min-h-[60px] items-center justify-center px-1 text-xs transition-colors',
                    isActive
                      ? 'text-brand-blue-700 border-brand-gold-500 border-t-2 font-bold'
                      : 'text-brand-ink/80 hover:text-brand-blue-700 border-t-2 border-transparent',
                  ].join(' ')
                }
              >
                {item.quick?.label}
              </NavLink>
            ))}
          </nav>
        )}
      </div>
    </div>
  );
}
