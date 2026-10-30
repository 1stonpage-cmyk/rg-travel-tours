/**
 * `staffAuth.login`, `.logout`, `.me` — staff sign-in (Week 4 plan, Task 5).
 *
 * **Not under the `admin.*` namespace, and the reason is a guard test.**
 * `procedure-role-metadata.test.ts` requires every procedure whose path
 * contains `admin` to be built with `adminProcedure` — and `login` and
 * `logout` cannot be: a login that required a session could never create
 * one. Mounting them at `admin.auth.*` broke that invariant, which is a
 * real property worth keeping rather than an inconvenience to exempt: it
 * is what stops a public procedure hiding in the admin surface. So the
 * three live here, where `login` and `logout` are honestly public and `me`
 * is honestly gated.
 *
 * A login, a logout, a `me` and a `changePassword` live here. Creating and
 * resetting accounts is the owner's `admin.staffUsers` router (2026-10-23).
 *
 * ## Everything security-shaped here is somewhere else
 *
 * This file is thin on purpose. `verifyStaffPassword` (services/staff-auth)
 * owns the generic refusal, the timing-equalising dummy hash and the
 * per-email throttle; `createSession` owns the token; `setSessionCookie`
 * owns the flags; the per-IP limiter is mounted in `app.ts`; the origin
 * check is middleware. What is left here is the sequencing and the audit
 * trail — which is exactly what a resolver should be.
 *
 * ## A NEW session on every login
 *
 * `createSession` mints a fresh 32-byte token and a new row, and nothing
 * here reuses or upgrades an existing one. That is the session-fixation
 * defence: an attacker who plants a known cookie in a victim's browser
 * cannot have it become an authenticated session, because authentication
 * always produces a token the attacker has never seen.
 *
 * ## Every attempt is audited, and the password never is
 *
 * Success, failure and logout all write an `audit_log` row. A failure has
 * no authenticated actor, so it is recorded as `system` with the attempted
 * email in `data` — the email is what makes the row useful when reading
 * back a guessing run, and `audit_log` is already admin-only. **The
 * password is never in the row, the message, or a log line**, and there is
 * no code path here that could put it there.
 */
import { TRPCError } from '@trpc/server';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { changePasswordInputSchema } from '@rg/shared';
import { getDb } from '../../db/client';
import { users } from '../../db/schema';
import {
  clearSessionCookie,
  setSessionCookie,
  SESSION_COOKIE_BY_SUBJECT,
} from '../../middleware/session-cookie';
import { writeAudit } from '../../services/audit';
import { hashPassword, verifyPassword } from '../../services/password';
import {
  createSession,
  revokeOtherSessionsForSubject,
  revokeSession,
  revokeSessionsForSubject,
} from '../../services/sessions';
import {
  clearChangePasswordFailures,
  isChangePasswordThrottled,
  markStaffLogin,
  recordChangePasswordFailure,
  verifyStaffPassword,
} from '../../services/staff-auth';
import { adminProcedureAllowingPasswordChange, publicProcedure, router } from '../../trpc';

/**
 * `.strict()`, so a request carrying anything else — a `role`, a `userId`,
 * an `isActive` — is refused by the input stage rather than ignored. A
 * login that quietly dropped an unexpected `role` field would be a login
 * that looks like it might honour one.
 */
const loginInput = z
  .object({ email: z.email().max(200), password: z.string().min(1).max(200) })
  .strict();

/**
 * ONE refusal for every reason: unknown email, wrong password, deactivated
 * account, throttled. The service cannot tell this resolver which it was,
 * so there is nothing here to leak even by accident.
 */
const refused = () =>
  new TRPCError({ code: 'UNAUTHORIZED', message: 'That email and password do not match.' });

/** `entity_id` is NOT NULL, and a failed login for an unknown email has no
 * user to point at. Zero is the explicit "no row" rather than a real id. */
const NO_USER = 0;

export const staffAuthRouter = router({
  login: publicProcedure.input(loginInput).mutation(async ({ input, ctx }) => {
    const now = new Date();
    const identity = await verifyStaffPassword(input.email, input.password, now);

    if (!identity) {
      await getDb().transaction((tx) =>
        writeAudit(tx, {
          actorType: 'system',
          actorId: null,
          action: 'auth.login_failed',
          entity: 'users',
          entityId: NO_USER,
          // The attempted email, never the password. This is what makes a
          // guessing run legible when read back.
          data: { email: input.email.trim().toLowerCase() },
        }),
      );
      throw refused();
    }

    const { token, expiresAt } = await createSession('user', identity.userId, now);
    setSessionCookie(ctx.res, 'user', token, expiresAt);

    await getDb().transaction(async (tx) => {
      await writeAudit(tx, {
        actorType: 'user',
        actorId: identity.userId,
        action: 'auth.login',
        entity: 'users',
        entityId: identity.userId,
        data: { role: identity.role },
      });
    });
    await markStaffLogin(identity.userId, now);

    return { role: identity.role, mustChangePassword: identity.mustChangePassword };
  }),

  /**
   * Revokes the session row AND clears the cookie — both, always. Clearing
   * only the cookie leaves a live session that any copy of the token still
   * opens; revoking only the row leaves a browser sending a dead token.
   *
   * `publicProcedure` rather than `adminProcedure`: logging out with an
   * expired or already-revoked session must succeed quietly rather than
   * answer 401, or a staff member whose session lapsed can never clear the
   * cookie.
   */
  logout: publicProcedure.mutation(async ({ ctx }) => {
    const cookies = ctx.req.cookies as Record<string, string | undefined> | undefined;
    const token = cookies?.[SESSION_COOKIE_BY_SUBJECT.user];

    if (token) {
      const session = ctx.adminSession;
      await revokeSession(token);
      if (session) {
        await getDb().transaction((tx) =>
          writeAudit(tx, {
            actorType: 'user',
            actorId: session.subjectId,
            action: 'auth.logout',
            entity: 'users',
            entityId: session.subjectId,
          }),
        );
      }
    }

    clearSessionCookie(ctx.res, 'user');
    return { ok: true as const };
  }),

  /**
   * Who am I? Behind `adminProcedure`, so it is also the smallest possible
   * proof that the whole chain works end to end: cookie → context →
   * `requireRole` → a resolver that only an authenticated staff session can
   * reach. Every other admin procedure in the tree depends on that chain
   * and, until Task 1, none of it had ever run.
   */
  me: adminProcedureAllowingPasswordChange('dashboard').query(({ ctx }) => ({
    userId: ctx.adminSession.subjectId,
    role: ctx.adminSession.role,
    // Tells the client to send this person to "Set a new password" first.
    mustChangePassword: ctx.adminSession.mustChangePassword === true,
    // Read live off the `users` row by `readSession` (Task 16, 7M), same as
    // `role` above: a rename mid-session shows up on the very next request.
    name: ctx.adminSession.name,
  })),

  /**
   * Replace your own password: the forced change after a temporary one, and
   * the voluntary one from the menu. `dashboard` is every role's area, and the
   * builder is the one allowed through the must-change gate.
   *
   *  - The CURRENT password is verified, so a borrowed session cannot set a
   *    new one. Wrong guesses are throttled per user, on top of the per-IP
   *    limiter on `/trpc` (`STAFF_LOGIN_PROCEDURES`).
   *  - The new one must differ from the current one and meet the same length
   *    rule as everywhere else (`staffPasswordSchema`).
   *  - The write is conditional on the hash that was verified, so a reset the
   *    owner makes while this request is hashing is not silently overwritten.
   *  - Clears the flag, keeps THIS session, ends the user's others: one
   *    transaction, then one audit row. No password or hash in the row.
   */
  changePassword: adminProcedureAllowingPasswordChange('dashboard')
    .input(changePasswordInputSchema)
    .mutation(async ({ input, ctx }) => {
      const now = new Date();
      const userId = ctx.adminSession.subjectId;

      if (isChangePasswordThrottled(userId, now)) {
        throw new TRPCError({
          code: 'TOO_MANY_REQUESTS',
          message: 'Too many attempts. Wait a few minutes and try again.',
        });
      }

      const [user] = await getDb()
        .select({ passwordHash: users.passwordHash, mustChangePassword: users.mustChangePassword })
        .from(users)
        .where(eq(users.id, userId))
        .limit(1);
      if (!user) throw new TRPCError({ code: 'UNAUTHORIZED', message: 'Admin sign-in required.' });

      if (!(await verifyPassword(input.currentPassword, user.passwordHash))) {
        recordChangePasswordFailure(userId, now);
        throw new TRPCError({
          code: 'UNAUTHORIZED',
          message: 'Your current password is not right.',
        });
      }
      clearChangePasswordFailures(userId);

      if (input.newPassword === input.currentPassword) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'Choose a password you are not using now.',
        });
      }

      const newHash = await hashPassword(input.newPassword);
      const cookies = ctx.req.cookies as Record<string, string | undefined> | undefined;
      const token = cookies?.[SESSION_COOKIE_BY_SUBJECT.user];

      await getDb().transaction(async (tx) => {
        const [updated] = await tx
          .update(users)
          .set({ passwordHash: newHash, mustChangePassword: false })
          .where(and(eq(users.id, userId), eq(users.passwordHash, user.passwordHash)));
        if (updated.affectedRows !== 1) {
          throw new TRPCError({
            code: 'CONFLICT',
            message: 'Your password was changed by someone else. Sign in again.',
          });
        }

        // No token (a context that never came from a cookie) keeps nothing:
        // fail closed rather than leave every other session standing.
        const sessionsRevoked = token
          ? await revokeOtherSessionsForSubject(tx, 'user', userId, token)
          : await revokeSessionsForSubject(tx, 'user', userId);

        await writeAudit(tx, {
          actorType: 'user',
          actorId: userId,
          action: 'staff.password_changed',
          entity: 'users',
          entityId: userId,
          data: { forced: user.mustChangePassword, sessionsRevoked },
        });
      });

      return { ok: true as const };
    }),
});
