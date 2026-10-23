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

export interface AdminNavItem {
  to: string;
  label: string;
  /** Match the path exactly (the dashboard) rather than as a prefix. */
  end: boolean;
  /** Roles the link is drawn for. */
  roles: readonly AdminNavRole[];
  /** Also shown in the phone's bottom quick-link bar. */
  quick?: { label: string };
}

const ALL: readonly AdminNavRole[] = ['owner', 'dispatcher', 'finance'];

export const ADMIN_NAV: readonly AdminNavItem[] = [
  { to: '/admin', label: 'Dashboard', end: true, roles: ALL, quick: { label: 'Home' } },
  {
    to: '/admin/bookings',
    label: 'Bookings',
    end: false,
    roles: ALL,
    quick: { label: 'Bookings' },
  },
  {
    to: '/admin/calendar',
    label: 'Dispatch',
    end: false,
    roles: ALL,
    quick: { label: 'Dispatch' },
  },
  { to: '/admin/vans', label: 'Vans', end: false, roles: ['owner', 'dispatcher'] },
  { to: '/admin/drivers', label: 'Drivers', end: false, roles: ['owner', 'dispatcher'] },
  { to: '/admin/staff', label: 'Staff', end: false, roles: ['owner'] },
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
