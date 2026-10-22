/**
 * The admin role gate (BUILD_SPEC §9, task 17 of the core-schema plan).
 *
 * CLAUDE.md: "Role middleware on every admin procedure, plus a test per role
 * per area", and "DO NOT let one role reach another role's endpoints. Hiding
 * a button is not access control." This module is the server-side half of
 * that sentence; `role-isolation.test.ts` is the test half.
 *
 * Two exports, and the split is deliberate:
 *
 *  - `ROLE_MATRIX` transcribes §9's table ONCE. Every admin procedure spells
 *    its area, never its own role list, so "who may cancel a booking?" has
 *    exactly one answer in the codebase and a spec change is a one-line edit.
 *  - `requireRole(...roles)` decides. It is given the role list rather than
 *    the area so it stays a pure gate with no opinion about the matrix, which
 *    is what lets the test harness drive it area by area.
 *
 * **It fails closed in every direction.** The only way through is an
 * authenticated `user` (staff) session whose role parses as one of the three
 * in `ADMIN_ROLES` and appears in the allow-list handed to `requireRole`.
 * Absent session, `null` session, a driver or customer session, an
 * unrecognised role string, `'__proto__'`, and an EMPTY allow-list all deny.
 * An empty allow-list denying matters: `requireRole(...ROLE_MATRIX[area])`
 * with a mistyped area would otherwise spread nothing and open the door.
 *
 * It deliberately decides nothing about authentication. Resolving a cookie to
 * a session row, and refusing an expired one or an `is_active = 0` user, is
 * the session service's job in Week 5; by the time a context reaches here the
 * session either exists or it does not. There are no admin procedures yet
 * (Weeks 5–7), so nothing in production calls this today — it is defined and
 * tested first so the procedures that arrive later have a gate to use rather
 * than each inventing one.
 */
import { TRPCError } from '@trpc/server';
import { adminRoleSchema, type AdminRole } from '@rg/shared';

/** BUILD_SPEC section 9 "Roles & permissions", transcribed verbatim. */
export const ROLE_MATRIX = {
  /** Dashboard                        ✅ ✅ ✅ */
  dashboard: ['owner', 'dispatcher', 'finance'],
  /** Bookings: view, notes            ✅ ✅ ✅ */
  bookingsView: ['owner', 'dispatcher', 'finance'],
  /** Assign van/driver                ✅ ✅ ❌ */
  assignVanDriver: ['owner', 'dispatcher'],
  /** Verify payments, record payments ✅ ❌ ✅ */
  verifyPayments: ['owner', 'finance'],
  /** Cancel / refund                  ✅ ❌ ✅ */
  cancelRefund: ['owner', 'finance'],
  /** Vans, drivers                    ✅ ✅ ❌ */
  vansDrivers: ['owner', 'dispatcher'],
  /** Tours, pricing, coupons          ✅ ❌ ❌ */
  toursPricing: ['owner'],
  /** Reviews moderation               ✅ ✅ ❌ */
  reviewsModeration: ['owner', 'dispatcher'],
  /** Reports, CSV export              ✅ ❌ ✅ */
  reports: ['owner', 'finance'],
  /** Users, settings                  ✅ ❌ ❌ */
  usersSettings: ['owner'],
  /**
   * Staff accounts                   ✅ ❌ ❌
   * Owner decision 2026-10-23: only the owner lists, creates, edits,
   * deactivates or resets staff logins. A separate area from `usersSettings`
   * so that row keeps meaning "settings"; finance and dispatcher get no
   * access here, not even to read.
   */
  staffAccounts: ['owner'],
} as const satisfies Record<string, readonly AdminRole[]>;

/** The gated areas of §9's table. */
export type AdminArea = keyof typeof ROLE_MATRIX;

/**
 * What the gate needs to see on the request context.
 *
 * `subjectType` is here because `sessions` is polymorphic (task 7): one table
 * holds staff, driver and customer sessions, and `subject_id` means a
 * different table for each. A driver session carrying a `role` field — by a
 * context-building bug, or by a driver-portal payload being trusted — must
 * not reach an admin procedure, so the gate checks the subject type as well
 * as the role.
 */
export interface StaffSession {
  /** `'user'` for staff. `'driver'` and `'customer'` are refused here. */
  subjectType: string;
  /** `users.id` when `subjectType` is `'user'`. */
  subjectId: number;
  /** `users.role` — validated against `ADMIN_ROLES`, never trusted as typed. */
  role: AdminRole;
}

/** The session-bearing slice of a tRPC context, as admin procedures will have it. */
export interface RoleContext {
  session?: StaffSession | null;
}

/** The one `subject_type` that can hold an admin role. */
const STAFF_SUBJECT = 'user';

/**
 * Builds a gate that admits only `allowed` roles.
 *
 * Takes the context as `unknown` on purpose: the gate is the boundary where a
 * context stops being assumed and starts being checked, so it re-validates
 * the role against `ADMIN_ROLES` instead of believing a `StaffSession` type
 * annotation that nothing at runtime enforces.
 *
 * Returns the validated session so a procedure can attribute an audit row to
 * `session.subjectId` without re-reading the context.
 *
 * @throws TRPCError `UNAUTHORIZED` when there is no staff session at all,
 *         `FORBIDDEN` when there is one and its role is not in `allowed`.
 *         Neither message names a role, an area or the allow-list.
 */
export function requireRole(...allowed: AdminRole[]) {
  return function gate(ctx: unknown): StaffSession {
    const session = (ctx as RoleContext | null | undefined)?.session;

    /*
     * No session, or one that is not staff. UNAUTHORIZED rather than
     * FORBIDDEN: there is no admin identity here to refuse, and a driver or
     * customer session is not an admin identity either.
     *
     * Two clauses, not three: a `typeof session === 'object'` check was tried
     * and removed, because nothing can get past it that the subject-type
     * check does not already refuse — a string, a number or an array has no
     * `subjectType` — and an unfalsifiable branch is worse than no branch.
     */
    if (!session || session.subjectType !== STAFF_SUBJECT) {
      throw new TRPCError({ code: 'UNAUTHORIZED', message: 'Admin sign-in required.' });
    }

    /*
     * The role is re-parsed, so an unknown string ('admin', 'superuser'), a
     * missing role and `'__proto__'` all land here rather than being compared
     * with `includes` against a list they might coincidentally satisfy.
     */
    const role = adminRoleSchema.safeParse(session.role);
    if (!role.success || !allowed.includes(role.data)) {
      throw new TRPCError({ code: 'FORBIDDEN', message: 'Not permitted for this account.' });
    }

    return { ...session, role: role.data };
  };
}
