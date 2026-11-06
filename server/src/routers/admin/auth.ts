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
import { randomBytes } from 'node:crypto';
import { TRPCError } from '@trpc/server';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import {
  changePasswordInputSchema,
  PASSWORD_RESET_REFUSED_MESSAGE,
  PASSWORD_RESET_REQUESTED_MESSAGE,
  requestPasswordResetInputSchema,
  resetPasswordInputSchema,
} from '@rg/shared';
import { getDb } from '../../db/client';
import { passwordResetTokens, users } from '../../db/schema';
import {
  clearSessionCookie,
  setSessionCookie,
  SESSION_COOKIE_BY_SUBJECT,
} from '../../middleware/session-cookie';
import { writeAudit } from '../../services/audit';
import { sendStaffPasswordResetEmail } from '../../services/notify';
import { hashPassword, verifyPassword } from '../../services/password';
import {
  hashResetToken,
  isResetThrottled,
  passwordResetUrl,
  recordResetRequest,
  RESET_TOKEN_TTL_MS,
} from '../../services/password-reset';
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

/**
 * The ONE answer `requestPasswordReset` returns, for every outcome.
 *
 * A frozen module constant rather than an object literal built per branch:
 * five `return { ok: true, message: … }` statements are five chances for one
 * of them to acquire an extra field (`sent: false`, `exists: true`) that
 * says what the message deliberately does not. One value cannot diverge
 * from itself.
 */
const REQUESTED = Object.freeze({
  ok: true as const,
  message: PASSWORD_RESET_REQUESTED_MESSAGE,
});

/**
 * The ONE refusal `resetPassword` gives: unknown token, expired token, spent
 * token, deactivated account, and the loser of a race for the same link.
 * Same single-refusal reasoning as `refused()` above.
 */
const resetRefused = () =>
  new TRPCError({ code: 'UNAUTHORIZED', message: PASSWORD_RESET_REFUSED_MESSAGE });

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

  /**
   * "I forgot my password" — §12's third door, step one (owner decision
   * 2026-11-06, task 1C).
   *
   * `publicProcedure`, necessarily: a staff member who cannot sign in cannot
   * present a session. It is mounted HERE rather than under `admin.*` for
   * exactly the reason this file's header gives for `login` and `logout` —
   * `procedure-role-metadata.test.ts` holds every procedure whose path
   * contains `admin` to `adminProcedure`, and that invariant is worth more
   * than the tidiness of a namespace.
   *
   * ## The response is ALWAYS the same, and that is the whole procedure
   *
   * One shape, one message, one success code — for an address that belongs
   * to an active account, one that belongs to a deactivated account, one
   * that belongs to nobody, one the throttle just refused, and one whose
   * mail could not be sent. Any difference between those would make this
   * endpoint an enumeration oracle for the staff list, which is the same
   * reason `verifyStaffPassword` has exactly one refusal.
   *
   * There is deliberately no thrown error anywhere on this path. A
   * `NOT_FOUND` for an unknown address would be the oracle in its most
   * obvious form.
   *
   * ## Timing — the one way the two paths are NOT identical, reasoned
   * rather than ignored
   *
   * A real, active account does work an unknown address does not: 32 random
   * bytes, a SHA-256, an INSERT, and a `sendMail`. So the two differ in
   * **response time** however identical the body is, and a sufficiently
   * patient attacker could read the difference. This is a known, accepted
   * residual, and the reasoning is:
   *
   *  1. **The equaliser that works elsewhere does not fit here.**
   *     `verifyStaffPassword` solves its version with `dummyVerify()` —
   *     because its dominant cost is a *local, deterministic* 250ms scrypt
   *     derivation, which can be reproduced exactly. The dominant cost here
   *     is an **outbound SMTP call whose latency is not ours to control**
   *     and varies by tens of milliseconds between sends to the same
   *     server. There is no fixed amount of fake work that matches a number
   *     that is not stable even on the real path, so a `dummyVerify`-shaped
   *     equaliser would add cost and close nothing.
   *  2. **Sending a decoy mail is not on the table.** Equalising by doing
   *     the externally-visible work anyway would mean mail to an address
   *     nobody asked about — a worse outcome than the oracle.
   *  3. **The limits bound the measurement to uselessness.** Timing attacks
   *     over a network need many samples to see past jitter. An attacker
   *     gets THREE requests per address per 15 minutes
   *     (`RESET_MAX_PER_EMAIL`) and ten per IP per 15 minutes
   *     (`STAFF_PASSWORD_RESET_MAX_PER_IP`) — three samples, against an
   *     SMTP round trip whose own variance is larger than the signal.
   *  4. **The thing it would reveal is already cheap by other means.** Staff
   *     addresses at a small operator are `firstname@travelsugbo.com`; this
   *     endpoint is not what protects them. What it does protect is the
   *     ability to TAKE one over, and that rests on the token, not on the
   *     response time.
   *
   * If the limits above are ever loosened, this reasoning is void and the
   * cheap mitigation (do every step for an unknown address EXCEPT the
   * insert and the send, against a fixed dummy) becomes worth its
   * complexity.
   */
  requestPasswordReset: publicProcedure
    .input(requestPasswordResetInputSchema)
    .mutation(async ({ input }) => {
      // One clock read at the request boundary, passed down — so the
      // 30-minute window and the throttle window are both assertable.
      const now = new Date();
      const email = input.email;

      /*
       * The per-email half of the limit, BEFORE the lookup and before any
       * work. A throttled request gets the same answer as every other one —
       * see `isResetThrottled`'s note on why a different answer here would
       * be the oracle this procedure exists to avoid.
       */
      if (isResetThrottled(email, now)) return REQUESTED;
      // Counted whether or not an account turns out to exist, so an unknown
      // address is not an unlimited probe.
      recordResetRequest(email, now);

      const [user] = await getDb()
        .select({ id: users.id, email: users.email, isActive: users.isActive })
        .from(users)
        // Case-insensitively, as `verifyStaffPassword` looks a staff member
        // up: an address is not case-sensitive in practice.
        .where(sql`LOWER(${users.email}) = ${email}`)
        .limit(1);

      /*
       * No account, or a deactivated one: stop here, write nothing, send
       * nothing. A deactivated staff member must not be able to reset their
       * way back in — `readSession` already refuses their sessions and
       * `verifyStaffPassword` already refuses their password, so a live
       * reset link would be the one door left open.
       */
      if (!user || user.isActive !== true) return REQUESTED;

      /*
       * 32 bytes from the CSPRNG. The raw token exists in this variable, in
       * the URL built from it, and in the email — and nowhere else, ever:
       * only its SHA-256 is written, and nothing here logs either one.
       */
      const rawToken = randomBytes(32).toString('base64url');

      await getDb()
        .insert(passwordResetTokens)
        .values({
          userId: user.id,
          tokenHash: hashResetToken(rawToken),
          expiresAt: new Date(now.getTime() + RESET_TOKEN_TTL_MS),
          createdAt: now,
        });

      /*
       * After the insert, and `await`ed: the token is already usable, so a
       * mail failure must not undo it (the sender cannot throw — see
       * `services/notify/staff-password-reset.ts`) and a staff member must
       * not be told "sent" before the attempt was made.
       *
       * Addressed to the STORED address rather than the typed one. They are
       * the same address, but the row is the authority on its spelling.
       */
      await sendStaffPasswordResetEmail(user.email, passwordResetUrl(rawToken));

      return REQUESTED;
    }),

  /**
   * "Here is my new password" — §12's third door, step two.
   *
   * ## One refusal for four different wrongs
   *
   * Unknown token, expired token, already-spent token, token belonging to a
   * now-deactivated account: all `UNAUTHORIZED` with
   * `PASSWORD_RESET_REFUSED_MESSAGE`, exactly as the login gives one refusal
   * for four wrongs. Telling them apart would say whether a link was ever
   * real, whether it has been used (so: whether someone else got in first),
   * and whether an account is still active.
   *
   * ## Single use is arbitrated by the DATABASE, not by the read above it
   *
   * The pre-read exists to refuse cheaply, and it is **not** what makes the
   * token single-use: two simultaneous clicks of one link would both pass
   * it. The claim is a conditional `UPDATE … WHERE id = ? AND used_at IS
   * NULL` whose `affectedRows` is checked — the same technique
   * `changePassword` above uses for its conditional write. InnoDB
   * re-evaluates an UPDATE's `WHERE` against the latest committed row once
   * the lock is granted, so the loser matches nothing and is refused.
   *
   * ## What a success does, all in one transaction
   *
   * Spends this token; marks every OTHER outstanding token for the user
   * spent (a staff member who clicked "forgot password" three times must
   * not leave two live links in their inbox); writes the new hash; clears
   * `must_change_password`, because the person just chose this password
   * themselves at a form — unlike `admin.staffUsers.resetPassword`, which
   * issues a temporary one and correctly SETS the flag; and revokes **every**
   * session the user holds. All of them, not all-but-one: there is no
   * current session to preserve, and the premise of a reset is that the old
   * password may be in someone else's hands.
   *
   * The audit row names the counts and nothing else. **Never the token, the
   * token hash, the password or the password hash** (`services/audit.ts`).
   */
  resetPassword: publicProcedure.input(resetPasswordInputSchema).mutation(async ({ input }) => {
    const now = new Date();
    const tokenHash = hashResetToken(input.token);

    /*
     * One query for the token and the account behind it, so "the user is
     * deactivated" is the same refusal as "no such token" without a second
     * round trip that could answer differently. An INNER join: a token row
     * whose user vanished is not a usable token.
     */
    const [found] = await getDb()
      .select({
        tokenId: passwordResetTokens.id,
        userId: passwordResetTokens.userId,
        expiresAt: passwordResetTokens.expiresAt,
        usedAt: passwordResetTokens.usedAt,
        isActive: users.isActive,
      })
      .from(passwordResetTokens)
      .innerJoin(users, eq(users.id, passwordResetTokens.userId))
      .where(eq(passwordResetTokens.tokenHash, tokenHash))
      .limit(1);

    /*
     * Fails CLOSED on every condition, and `expiresAt <= now` makes the
     * expiry instant itself already past — the same strictness
     * `readSession` applies to a session's own expiry, so the two cannot
     * disagree about a boundary.
     */
    if (
      !found ||
      found.usedAt !== null ||
      found.expiresAt.getTime() <= now.getTime() ||
      found.isActive !== true
    ) {
      throw resetRefused();
    }

    // Hashed BEFORE the transaction: scrypt takes ~250ms, and holding a
    // row lock for a quarter of a second is how a lock queue becomes a
    // timeout.
    const passwordHash = await hashPassword(input.newPassword);

    const result = await getDb().transaction(async (tx) => {
      const [claimed] = await tx
        .update(passwordResetTokens)
        .set({ usedAt: now })
        .where(and(eq(passwordResetTokens.id, found.tokenId), isNull(passwordResetTokens.usedAt)));
      // The race, decided here and nowhere else. A loser matches no row.
      if (claimed.affectedRows !== 1) throw resetRefused();

      /*
       * Every OTHER live link for this user, spent in the same breath.
       * This token is already `used_at`-stamped by the statement above —
       * the transaction sees its own write — so it is not counted twice.
       */
      const [others] = await tx
        .update(passwordResetTokens)
        .set({ usedAt: now })
        .where(
          and(eq(passwordResetTokens.userId, found.userId), isNull(passwordResetTokens.usedAt)),
        );

      /*
       * Conditional on `is_active` as well as the id, so a deactivation
       * committed between the read above and this transaction refuses
       * rather than quietly setting a password on a switched-off account.
       */
      const [written] = await tx
        .update(users)
        .set({ passwordHash, mustChangePassword: false })
        .where(and(eq(users.id, found.userId), eq(users.isActive, true)));
      if (written.affectedRows !== 1) throw resetRefused();

      // ALL of them. See the resolver note.
      const sessionsRevoked = await revokeSessionsForSubject(tx, 'user', found.userId);

      await writeAudit(tx, {
        actorType: 'user',
        // They did act — they proved they hold the mailbox — they simply
        // had no session while doing it.
        actorId: found.userId,
        action: 'staff.password_reset_self',
        entity: 'users',
        entityId: found.userId,
        // Counts only. Never the token, the hash, or the password.
        data: { sessionsRevoked, tokensInvalidated: others.affectedRows },
      });

      return { ok: true as const };
    });

    return result;
  }),
});
