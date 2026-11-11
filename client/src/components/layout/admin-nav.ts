/**
 * Which admin links to DRAW for each role.
 *
 * This is cosmetic only. The server's `ROLE_MATRIX`
 * (`server/src/middleware/require-role.ts`) is the guard and answers every
 * request regardless of what is drawn here; a link missing from this list
 * does not stop anyone reaching the URL, and a link present here does not
 * let anyone through. The lists mirror the matrix so a person is not shown
 * a door that will only refuse them.
 */
export type AdminNavRole = 'owner' | 'dispatcher' | 'finance';

/**
 * The fixed sidebar grouping (owner decision 2026-11-10, Direction B
 * "Control Room" — `.design-preview/admin-dashboard.html`, git-excluded).
 * `GROUP_ORDER` below is the on-screen order; a group with no visible item
 * for the signed-in role draws nothing (`groupedNavFor`).
 */
export type AdminNavGroup =
  | 'Overview'
  | 'Bookings'
  | 'Operations'
  | 'Transfers setup'
  | 'Tours setup'
  | 'Marketing'
  | 'Admin';

export const GROUP_ORDER: readonly AdminNavGroup[] = [
  'Overview',
  'Bookings',
  'Operations',
  'Transfers setup',
  'Tours setup',
  'Marketing',
  'Admin',
];

export interface AdminNavItem {
  to: string;
  label: string;
  /** Match the path exactly (the dashboard) rather than as a prefix. */
  end: boolean;
  /** Roles the link is drawn for. */
  roles: readonly AdminNavRole[];
  /** Also shown in the phone's bottom quick-link bar. */
  quick?: { label: string };
  /** Draw the dashboard's count for this alert kind beside the label (when it is above zero). */
  badge?: 'payments_to_verify';
  group: AdminNavGroup;
  /**
   * Faded, with a "Hidden" tag, while `settings.show_tours` is off — still
   * a real, clickable link (owner decision 2026-11-10, group 2).
   *
   * **Tours and Packages both** — Decision 2's own sidebar spec named both,
   * and Decision 2 ("packages follow the same show_tours gate as tours",
   * 2026-11-10) made that true: Tasks 2-3 put Packages behind the same
   * `show_tours` gate as Tours on every surface (server router, SEO
   * resolver, sitemap, client nav/footer, home page section), so the
   * deviation this comment used to document (Packages ungated while Tours
   * was tagged "Hidden") no longer exists. Tagging only Tours here would now
   * tell staff something false about what a guest can see.
   */
  hiddenWhileToursOff?: boolean;
}

const ALL: readonly AdminNavRole[] = ['owner', 'dispatcher', 'finance'];

export const ADMIN_NAV: readonly AdminNavItem[] = [
  {
    to: '/admin',
    label: 'Dashboard',
    end: true,
    roles: ALL,
    quick: { label: 'Home' },
    group: 'Overview',
  },
  // Owner + finance (Week 7 Task 12): `admin.reports.*` is §9's `reports`
  // row — the same pair as payment checks below, and never a dispatcher.
  {
    to: '/admin/reports',
    label: 'Reports',
    end: false,
    roles: ['owner', 'finance'],
    group: 'Overview',
  },
  {
    to: '/admin/bookings',
    label: 'Bookings',
    end: false,
    roles: ALL,
    quick: { label: 'Bookings' },
    group: 'Bookings',
  },
  {
    to: '/admin/payments',
    label: 'Payment checks',
    end: false,
    roles: ['owner', 'finance'],
    quick: { label: 'Payments' },
    badge: 'payments_to_verify',
    group: 'Bookings',
  },
  {
    to: '/admin/calendar',
    label: 'Dispatch',
    end: false,
    roles: ALL,
    quick: { label: 'Dispatch' },
    group: 'Operations',
  },
  { to: '/admin/departures', label: 'Departures', end: false, roles: ALL, group: 'Operations' },
  {
    to: '/admin/vans',
    label: 'Vans',
    end: false,
    roles: ['owner', 'dispatcher'],
    group: 'Operations',
  },
  {
    to: '/admin/drivers',
    label: 'Drivers',
    end: false,
    roles: ['owner', 'dispatcher'],
    group: 'Operations',
  },
  // Owner decision 2026-11-10, group 2: "Transfer routes, Places, Vehicle
  // types" is the stated on-screen order — the data-dependency rationale
  // the old flat list carried (route form reads Places/Vehicle types) still
  // holds for WHICH screen an admin fills out first, not for sidebar order.
  {
    to: '/admin/transfer-routes',
    label: 'Transfer routes',
    end: false,
    roles: ['owner'],
    group: 'Transfers setup',
  },
  {
    to: '/admin/transfer-places',
    label: 'Places',
    end: false,
    roles: ['owner'],
    group: 'Transfers setup',
  },
  {
    to: '/admin/vehicle-types',
    label: 'Vehicle types',
    end: false,
    roles: ['owner'],
    group: 'Transfers setup',
  },
  {
    to: '/admin/tours',
    label: 'Tours',
    end: false,
    roles: ['owner'],
    group: 'Tours setup',
    hiddenWhileToursOff: true,
  },
  // Owner + dispatcher (Week 7 Task 13): `admin.packages.*` and
  // `admin.inquiries.*` are §9's `packagesInquiries` row. The newsletter
  // export on that same screen is owner-only (`usersSettings`) and has no
  // nav entry of its own — it is a card the page draws for an owner.
  {
    to: '/admin/packages',
    label: 'Packages',
    end: false,
    roles: ['owner', 'dispatcher'],
    group: 'Tours setup',
    hiddenWhileToursOff: true,
  },
  { to: '/admin/coupons', label: 'Coupons', end: false, roles: ['owner'], group: 'Marketing' },
  // Owner + dispatcher (Week 7 Task 11): `admin.reviews.*` is §9's
  // `reviewsModeration` row — the same gate `admin.vans`/`admin.drivers` use.
  {
    to: '/admin/reviews',
    label: 'Reviews',
    end: false,
    roles: ['owner', 'dispatcher'],
    group: 'Marketing',
  },
  { to: '/admin/staff', label: 'Staff', end: false, roles: ['owner'], group: 'Admin' },
  // Owner-only too (Week 7 Task 9): `admin.settings.*` is §9's `usersSettings`
  // row, which holds the deposit percentage and the payment QR account.
  { to: '/admin/settings', label: 'Settings', end: false, roles: ['owner'], group: 'Admin' },
];

function isAdminNavRole(role: string | undefined): role is AdminNavRole {
  return role === 'owner' || role === 'dispatcher' || role === 'finance';
}

/**
 * The links to draw for `role`. An unknown or not-yet-loaded role gets the
 * dashboard alone: drawing too little is harmless, drawing too much is the
 * thing this list exists to avoid.
 */
export function navFor(role: string | undefined): AdminNavItem[] {
  if (!isAdminNavRole(role)) return ADMIN_NAV.filter((item) => item.to === '/admin');
  return ADMIN_NAV.filter((item) => item.roles.includes(role));
}

export interface AdminNavGroupEntry {
  group: AdminNavGroup;
  items: readonly AdminNavItem[];
}

/**
 * `navFor(role)`, bucketed by `GROUP_ORDER` — the sidebar's actual shape
 * (Direction B, owner decision 2026-11-10, group 2). A group with nothing
 * visible for `role` is left out of the result entirely, which is what
 * makes it disappear from the sidebar rather than draw an empty heading.
 *
 * **The item SET is identical to `navFor(role)`'s** — this only regroups
 * and reorders what that function already returns; it adds nothing and
 * drops nothing. `admin-nav.test.ts` asserts that equivalence directly.
 */
export function groupedNavFor(role: string | undefined): AdminNavGroupEntry[] {
  const flat = navFor(role);
  return GROUP_ORDER.map((group) => ({
    group,
    items: flat.filter((item) => item.group === group),
  })).filter((entry) => entry.items.length > 0);
}
