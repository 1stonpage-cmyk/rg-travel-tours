/**
 * The client's mirror of §9's permission matrix — the COSMETIC half only.
 *
 * ## This is not access control
 *
 * CLAUDE.md: "DO NOT let one role reach another role's endpoints. Hiding a
 * button is not access control." The real gate is `ROLE_MATRIX` in
 * `server/src/middleware/require-role.ts`, re-checked on every admin
 * procedure, and the client cannot import it: it lives in the server
 * workspace and must never be shipped to a browser as policy a browser could
 * be believed about. Everything here decides only what the UI DRAWS, so a
 * person is not shown a control whose only possible outcome is a refusal.
 *
 * ## Why it is one module
 *
 * Four screens had each declared their own `['owner', 'finance']` array —
 * `AdminBookingDetailPage` (`MAY_VERIFY`), `AdminPaymentsPage`
 * (`MAY_VERIFY`), `AdminReportsPage` (`MAY_READ_REPORTS`) and
 * `CancelRefundPanel` (`MAY_CANCEL_REFUND`) — with no shared source
 * (owner decision 2026-10-23, batch-1 question; unified here in 7N). §9
 * gives `verifyPayments`, `cancelRefund` and `reports` the same two roles,
 * so a policy change that reached only three of four copies would leave one
 * screen drawing a control the server then refuses.
 *
 * `admin-nav.ts`'s per-route `roles` arrays are deliberately NOT folded in
 * here: those are declarative data about one nav entry each, several of them
 * different, and collapsing them would make the nav read from a constant
 * whose name could not say which rows it stood for.
 */
import { ADMIN_ROLES, type AdminRole } from '@rg/shared';

/**
 * §9's three money rows — "Verify payments, record payments", "Cancel /
 * refund" and "Reports, CSV export" — which are the same pair of roles.
 *
 * One constant for three rows because §9 gives them one answer, not because
 * they are the same area: the server keeps `verifyPayments`, `cancelRefund`
 * and `reports` as three separate areas, and if a future spec change splits
 * them this constant splits with it.
 */
export const MONEY_ROLES: readonly AdminRole[] = ['owner', 'finance'];

/** §9 "Bookings: view, notes" — every staff role that can open a booking. */
export const BOOKING_VIEW_ROLES: readonly AdminRole[] = ADMIN_ROLES;

/**
 * True when `role` — as `staffAuth.me` reports it, which may be `undefined`
 * while that query is pending or has failed — is in `allowed`.
 *
 * `undefined` is false, deliberately: a pending identity draws the smaller
 * screen rather than flashing a control it may have to take away. The server
 * refuses the call either way.
 */
export function roleMay(role: string | undefined, allowed: readonly AdminRole[]): boolean {
  return role === undefined ? false : allowed.includes(role as AdminRole);
}
