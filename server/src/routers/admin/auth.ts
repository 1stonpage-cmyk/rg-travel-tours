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
 * Narrow by owner approval: a login, a logout, a `me`, and the role gate.
 * No password reset, no invitations, no user management.
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
import { z } from 'zod';
import { getDb } from '../../db/client';
import {
  clearSessionCookie,
  setSessionCookie,
  SESSION_COOKIE,
} from '../../middleware/session-cookie';
import { writeAudit } from '../../services/audit';
import { createSession, revokeSession } from '../../services/sessions';
import { markStaffLogin, verifyStaffPassword } from '../../services/staff-auth';
import { adminProcedure, publicProcedure, router } from '../../trpc';

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
    setSessionCookie(ctx.res, token, expiresAt);

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

    return { role: identity.role };
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
    const token = cookies?.[SESSION_COOKIE];

    if (token) {
      const session = ctx.session;
      await revokeSession(token);
      if (session && session.subjectType === 'user') {
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

    clearSessionCookie(ctx.res);
    return { ok: true as const };
  }),

  /**
   * Who am I? Behind `adminProcedure`, so it is also the smallest possible
   * proof that the whole chain works end to end: cookie → context →
   * `requireRole` → a resolver that only an authenticated staff session can
   * reach. Every other admin procedure in the tree depends on that chain
   * and, until Task 1, none of it had ever run.
   */
  me: adminProcedure('dashboard').query(({ ctx }) => ({
    userId: ctx.session.subjectId,
    role: ctx.session.role,
  })),
});
