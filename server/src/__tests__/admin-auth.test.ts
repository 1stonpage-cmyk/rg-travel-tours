/**
 * Week 4 plan, Task 5 — `staffAuth.login` / `.logout` / `.me`.
 *
 * `staff-auth.test.ts` proves the credential check. This file proves what
 * the resolver does with the answer: the session it mints, the cookie it
 * sets, the audit row it writes, and — through `me` — that the whole chain
 * from cookie to `requireRole` actually works. Until Task 1 there was no
 * context factory at all, so **no `adminProcedure` in this codebase had
 * ever executed**; `me` is the first.
 *
 * Every item here is from the owner's security list, and each failure would
 * be a real vulnerability: session fixation, an unaudited login, a cookie
 * handed out on a refusal, a deactivated account signing in, or `me`
 * reachable by a guest's portal session.
 */
import { afterAll, afterEach, beforeAll, expect, it } from 'vitest';
import request from 'supertest';
import { eq, inArray, sql } from 'drizzle-orm';
import { PASSWORD_RESET_REQUESTED_MESSAGE } from '@rg/shared';
import { createApp } from '../app';
import { getDb, getPool } from '../db/client';
import { auditLog, passwordResetTokens, users } from '../db/schema';
import { env } from '../env';
import { SESSION_COOKIE_BY_SUBJECT } from '../middleware/session-cookie';
import { STAFF_LOGIN_MAX_PER_IP } from '../middleware/rate-limit';
import { hashPassword } from '../services/password';
import {
  RESET_MAX_PER_EMAIL,
  resetPasswordResetThrottleForTests,
} from '../services/password-reset';
import { resetEmailThrottleForTests } from '../services/staff-auth';
import { createSession, readSession } from '../services/sessions';
import { appRouter } from '../routers/_app';
import { captureResponse, staffContext, testContext } from './helpers/ctx';
import { describeWithDb } from './helpers/db';

const PASSWORD = 'a-strong-owner-password';
const suffix = `${Math.floor(Math.random() * 1e9)}`;
const EMAIL = { owner: `admin_${suffix}@example.test`, gone: `gone_${suffix}@example.test` };

const createdIds: number[] = [];
let ownerId: number;
let inactiveId: number;

beforeAll(async () => {
  const hash = await hashPassword(PASSWORD);
  const db = getDb();
  const [owner] = await db
    .insert(users)
    .values({ name: 'Admin Fixture', email: EMAIL.owner, passwordHash: hash, role: 'owner' });
  ownerId = owner.insertId;
  const [gone] = await db.insert(users).values({
    name: 'Deactivated Fixture',
    email: EMAIL.gone,
    passwordHash: hash,
    role: 'finance',
    isActive: false,
  });
  inactiveId = gone.insertId;
  createdIds.push(ownerId, inactiveId);
}, 60_000);

afterEach(async () => {
  resetEmailThrottleForTests();
  resetPasswordResetThrottleForTests();
  const pool = getPool();
  for (const id of createdIds) {
    await pool.query('DELETE FROM sessions WHERE subject_type = ? AND subject_id = ?', [
      'user',
      id,
    ]);
    // Task 11's Turnstile test exercises `requestPasswordReset`, which can
    // insert a real token row — clean it up here (as `password-reset.test.ts`
    // already does for its own suite) rather than at `afterAll`, which only
    // deletes `users` and would otherwise die on the FK this table holds.
    await pool.query('DELETE FROM password_reset_tokens WHERE user_id = ?', [id]);
  }
  await pool.query(
    "DELETE FROM audit_log WHERE action LIKE 'auth.%' AND (actor_id IN (?, ?) OR actor_id IS NULL)",
    [createdIds[0] ?? 0, createdIds[1] ?? 0],
  );
});

afterAll(async () => {
  if (createdIds.length > 0) await getDb().delete(users).where(inArray(users.id, createdIds));
});

/** The audit rows this suite's logins wrote, newest first. */
async function authAudit() {
  return getDb()
    .select({
      action: auditLog.action,
      actorType: auditLog.actorType,
      actorId: auditLog.actorId,
      data: auditLog.data,
    })
    .from(auditLog)
    .where(sql`${auditLog.action} LIKE 'auth.%'`)
    .orderBy(sql`${auditLog.id} DESC`)
    .limit(5);
}

function callerWithCookies(session: Parameters<typeof testContext>[0] = null) {
  const { res, set, cleared } = captureResponse();
  return {
    set,
    cleared,
    api: appRouter.createCaller({
      req: { cookies: {} },
      res,
      adminSession: session,
      driverSession: null,
      customerSession: null,
    } as never),
  };
}

describeWithDb('staffAuth.login', () => {
  it('signs a staff member in, sets the cookie, and reports the role', async () => {
    const { api, set } = callerWithCookies();

    await expect(api.staffAuth.login({ email: EMAIL.owner, password: PASSWORD })).resolves.toEqual({
      role: 'owner',
      mustChangePassword: false,
    });

    expect(set).toHaveLength(1);
    expect(set[0]!.name).toBe(SESSION_COOKIE_BY_SUBJECT.user);
    expect(set[0]!.options.httpOnly).toBe(true);
    expect(await readSession(set[0]!.value, new Date())).toEqual({
      subjectType: 'user',
      subjectId: ownerId,
      role: 'owner',
      mustChangePassword: false,
      name: 'Admin Fixture',
    });
  });

  /**
   * **Session fixation.** An attacker who plants a cookie they know in a
   * victim's browser must not have it become an authenticated session. The
   * defence is that login always MINTS, never upgrades — so the token after
   * login is one the attacker has never seen, and the planted one is still
   * worthless.
   */
  it('mints a NEW session rather than adopting the one in the request', async () => {
    const planted = await createSession('user', ownerId, new Date());
    const { res, set } = captureResponse();
    const api = appRouter.createCaller({
      req: { cookies: { [SESSION_COOKIE_BY_SUBJECT.user]: planted.token } },
      res,
      adminSession: null,
      driverSession: null,
      customerSession: null,
    } as never);

    await api.staffAuth.login({ email: EMAIL.owner, password: PASSWORD });

    expect(set[0]!.value, 'login adopted the token from the request').not.toBe(planted.token);
  });

  it('writes an audit row naming the user and the role, never the password', async () => {
    const { api } = callerWithCookies();
    await api.staffAuth.login({ email: EMAIL.owner, password: PASSWORD });

    const [row] = await authAudit();
    expect(row!.action).toBe('auth.login');
    expect(row!.actorType).toBe('user');
    expect(Number(row!.actorId)).toBe(ownerId);
    expect(JSON.stringify(row!.data)).toContain('owner');
    expect(JSON.stringify(row!.data), 'the password reached the audit log').not.toContain(PASSWORD);
  });

  it('audits a FAILED attempt with the email and no password, and sets no cookie', async () => {
    const { api, set } = callerWithCookies();
    await api.staffAuth
      .login({ email: EMAIL.owner, password: 'wrong-password' })
      .catch(() => undefined);

    expect(set, 'a refused login handed out a cookie').toHaveLength(0);

    const [row] = await authAudit();
    expect(row!.action).toBe('auth.login_failed');
    expect(row!.actorType).toBe('system');
    expect(JSON.stringify(row!.data)).toContain(EMAIL.owner.toLowerCase());
    expect(JSON.stringify(row!.data)).not.toContain('wrong-password');
  });

  /** No enumeration: the two wrongs are byte-identical, code and message. */
  it('refuses an unknown email and a wrong password identically', async () => {
    const unknown = await callerWithCookies()
      .api.staffAuth.login({ email: `nobody_${suffix}@example.test`, password: PASSWORD })
      .catch((e: unknown) => e);
    const wrong = await callerWithCookies()
      .api.staffAuth.login({ email: EMAIL.owner, password: 'nope' })
      .catch((e: unknown) => e);

    expect((unknown as Error).message).toBe((wrong as Error).message);
    expect((unknown as { code?: string }).code).toBe((wrong as { code?: string }).code);
  });

  /**
   * **Task 11 — Turnstile.** The property that matters is not the literal
   * sentence, it is that a missing-token refusal and a wrong-password
   * refusal are the SAME refusal, exactly as the test above pins "unknown
   * email" and "wrong password" as the same refusal. A new/different
   * message here would let an attacker tell "forgot to solve the widget"
   * apart from "wrong credentials" — nothing by itself, but exactly the
   * oracle this file's other anti-enumeration tests exist to rule out. Also
   * proves the ordering matters: Turnstile is enabled with the CORRECT
   * password and still refused, which only holds if the check runs before
   * `verifyStaffPassword` ever looks at the password.
   */
  it('refuses a correct password with a missing Turnstile token, identically to a wrong password', async () => {
    const original = env.TURNSTILE_ENABLED;
    (env as { TURNSTILE_ENABLED?: string }).TURNSTILE_ENABLED = '1';
    let turnstileRefusal: unknown;
    try {
      turnstileRefusal = await callerWithCookies()
        .api.staffAuth.login({ email: EMAIL.owner, password: PASSWORD })
        .catch((e: unknown) => e);
    } finally {
      (env as { TURNSTILE_ENABLED?: string }).TURNSTILE_ENABLED = original;
    }

    // The control case, with Turnstile back off (as it was before this
    // test): a genuinely wrong password, going through `verifyStaffPassword`.
    const wrongPasswordRefusal = await callerWithCookies()
      .api.staffAuth.login({ email: EMAIL.owner, password: 'nope' })
      .catch((e: unknown) => e);

    expect((turnstileRefusal as Error).message).toBe((wrongPasswordRefusal as Error).message);
    expect((turnstileRefusal as { code?: string }).code).toBe(
      (wrongPasswordRefusal as { code?: string }).code,
    );
  });

  it('REFUSES a deactivated account and sets no cookie', async () => {
    const { api, set } = callerWithCookies();
    await expect(
      api.staffAuth.login({ email: EMAIL.gone, password: PASSWORD }),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    expect(set).toHaveLength(0);
  });

  it('stamps last_login_at on success and not on failure', async () => {
    /*
     * Establishes its own premise rather than assuming a clean row: earlier
     * tests in this file log in successfully, so `last_login_at` is already
     * set by the time this runs. The first version asserted it was null and
     * failed on test ORDER rather than on behaviour — which would have been
     * a flake the day someone reordered the file.
     */
    await getDb().update(users).set({ lastLoginAt: null }).where(eq(users.id, ownerId));

    const before = await getDb()
      .select({ at: users.lastLoginAt })
      .from(users)
      .where(eq(users.id, ownerId));
    expect(before[0]!.at).toBeNull();

    await callerWithCookies()
      .api.staffAuth.login({ email: EMAIL.owner, password: 'wrong' })
      .catch(() => undefined);
    const afterFailure = await getDb()
      .select({ at: users.lastLoginAt })
      .from(users)
      .where(eq(users.id, ownerId));
    expect(afterFailure[0]!.at, 'a failed login stamped last_login_at').toBeNull();

    resetEmailThrottleForTests();
    await callerWithCookies().api.staffAuth.login({ email: EMAIL.owner, password: PASSWORD });
    const afterSuccess = await getDb()
      .select({ at: users.lastLoginAt })
      .from(users)
      .where(eq(users.id, ownerId));
    expect(afterSuccess[0]!.at).not.toBeNull();

    // Reset for the other tests in this file.
    await getDb().update(users).set({ lastLoginAt: null }).where(eq(users.id, ownerId));
  });

  /**
   * The per-IP limiter, driven through `createApp()` so it also proves the
   * mount. Ten failed attempts, then refused — and a real BATCH, because a
   * single-call test passes against both the per-request and the per-call
   * version of the limiter (Week 3's final review, F1).
   */
  it('limits failed logins per IP, counting batched calls individually', async () => {
    const app = createApp();
    const body = { email: EMAIL.owner, password: 'wrong-password' };

    const batch = Array(STAFF_LOGIN_MAX_PER_IP + 1)
      .fill('staffAuth.login')
      .join(',');
    const res = await request(app)
      .post(`/trpc/${batch}?batch=1`)
      // A browser's Origin, because the CSRF check now runs ahead of the
      // limiter: without it this is a 403 and the limiter never sees it.
      .set('Origin', 'http://localhost:5180')
      .send(
        Object.fromEntries(Array.from({ length: STAFF_LOGIN_MAX_PER_IP + 1 }, (_, i) => [i, body])),
      );

    expect(res.status, 'a batch of eleven failed logins was not refused').toBe(429);
  });
});

/**
 * **Task 11 — Turnstile on `requestPasswordReset`.** The full behavioural
 * suite for this procedure (unknown email, throttle, expiry, deactivated
 * account…) lives in `password-reset.test.ts`; this block adds only the
 * Turnstile-specific property, reusing this file's own fixtures
 * (`EMAIL.owner` / `ownerId`) rather than duplicating that suite.
 */
describeWithDb('staffAuth.requestPasswordReset — Turnstile', () => {
  /**
   * Answers the SAME `REQUESTED` shape every other refusal this procedure
   * gives (unknown email, throttled, deactivated), and — the property that
   * actually matters — is checked BEFORE the per-email throttle read, so a
   * refused attempt costs nothing.
   *
   * A test that merely asserted "no row after one Turnstile-refused call"
   * could not tell a correctly-ordered check from one sitting right after
   * Turnstile but still ahead of the real throttle, nor from one planted
   * AFTER `isResetThrottled`/`recordResetRequest` — the first real request
   * (Turnstile off) would still return `REQUESTED` either way. So instead
   * this spends the WHOLE per-email budget (`RESET_MAX_PER_EMAIL`) on
   * Turnstile-refused calls, then — Turnstile off again — fires one more,
   * real request and requires it to actually succeed and write a token. If
   * the Turnstile check were misordered to run after the throttle, those
   * `RESET_MAX_PER_EMAIL` refused calls would have consumed the budget
   * themselves, the final real request would come back throttled instead,
   * and this assertion goes red.
   */
  it('answers REQUESTED and writes nothing while Turnstile refuses, spending none of the throttle budget', async () => {
    resetPasswordResetThrottleForTests();
    const original = env.TURNSTILE_ENABLED;
    (env as { TURNSTILE_ENABLED?: string }).TURNSTILE_ENABLED = '1';
    try {
      for (let i = 0; i < RESET_MAX_PER_EMAIL; i += 1) {
        const result = await callerWithCookies().api.staffAuth.requestPasswordReset({
          email: EMAIL.owner,
        });
        expect(result).toEqual({ ok: true, message: PASSWORD_RESET_REQUESTED_MESSAGE });
      }

      const whileRefusing = await getDb()
        .select()
        .from(passwordResetTokens)
        .where(eq(passwordResetTokens.userId, ownerId));
      expect(whileRefusing, 'a token was written despite a missing Turnstile token').toHaveLength(
        0,
      );
    } finally {
      (env as { TURNSTILE_ENABLED?: string }).TURNSTILE_ENABLED = original;
    }

    // Turnstile is off again. A real request now must succeed AND find the
    // per-email budget untouched by the refused attempts above.
    const real = await callerWithCookies().api.staffAuth.requestPasswordReset({
      email: EMAIL.owner,
    });
    expect(real).toEqual({ ok: true, message: PASSWORD_RESET_REQUESTED_MESSAGE });

    const rows = await getDb()
      .select()
      .from(passwordResetTokens)
      .where(eq(passwordResetTokens.userId, ownerId));
    expect(
      rows,
      'the per-email throttle budget was spent by Turnstile-refused attempts — the ' +
        'Turnstile check is running after the throttle read, not before it',
    ).toHaveLength(1);
  });
});

describeWithDb('staffAuth.logout', () => {
  it('revokes the session server-side, clears the cookie, and audits it', async () => {
    const { token } = await createSession('user', ownerId, new Date());
    const { res, cleared } = captureResponse();
    const api = appRouter.createCaller({
      req: { cookies: { [SESSION_COOKIE_BY_SUBJECT.user]: token } },
      res,
      adminSession: { subjectType: 'user', subjectId: ownerId, role: 'owner' },
      driverSession: null,
      customerSession: null,
    } as never);

    await expect(api.staffAuth.logout()).resolves.toEqual({ ok: true });

    expect(await readSession(token, new Date()), 'the session survived logout').toBeNull();
    expect(cleared.some((c) => c.name === SESSION_COOKIE_BY_SUBJECT.user)).toBe(true);

    const [row] = await authAudit();
    expect(row!.action).toBe('auth.logout');
    expect(Number(row!.actorId)).toBe(ownerId);
  });

  it('is harmless with no session, so a lapsed cookie can still be cleared', async () => {
    const { api, cleared } = callerWithCookies();
    await expect(api.staffAuth.logout()).resolves.toEqual({ ok: true });
    expect(cleared.some((c) => c.name === SESSION_COOKIE_BY_SUBJECT.user)).toBe(true);
  });
});

describeWithDb('staffAuth.me', () => {
  /**
   * The first `adminProcedure` in this codebase ever to run with a real
   * session. It is the end-to-end proof of the chain Task 1 built.
   */
  it('reports the signed-in staff member', async () => {
    const api = appRouter.createCaller(staffContext(ownerId, 'owner', 'Admin Fixture') as never);
    await expect(api.staffAuth.me()).resolves.toEqual({
      userId: ownerId,
      role: 'owner',
      mustChangePassword: false,
      name: 'Admin Fixture',
    });
  });

  /**
   * **The live-read proof** (Task 16, 7M): `name` comes from the SAME join
   * `readSession` already does for `role` (see `sessions.ts`'s "reflects a
   * role CHANGE immediately" test for that half). Driven end to end through
   * `createApp()` rather than a fixture context, so this proves the whole
   * chain — cookie → `createContext` → `readSession` → `me` — re-reads the
   * `users` row on every request rather than copying the name in at login.
   */
  it('returns a renamed user’s NEW name on the very next call, with no new login', async () => {
    const app = createApp();
    const login = await request(app)
      .post('/trpc/staffAuth.login')
      .set('Origin', 'http://localhost:5180')
      .send({ email: EMAIL.owner, password: PASSWORD });
    expect(login.status).toBe(200);
    const cookie = login.headers['set-cookie'] as unknown as string[];

    const before = await request(app).get('/trpc/staffAuth.me').set('Cookie', cookie);
    expect(before.body.result.data.name).toBe('Admin Fixture');

    await getDb().update(users).set({ name: 'Renamed Fixture' }).where(eq(users.id, ownerId));

    const after = await request(app).get('/trpc/staffAuth.me').set('Cookie', cookie);
    expect(
      after.body.result.data.name,
      'the name was cached somewhere in the session — a rename did not take effect',
    ).toBe('Renamed Fixture');

    // Restore, so other tests in this file see the fixture name they expect.
    await getDb().update(users).set({ name: 'Admin Fixture' }).where(eq(users.id, ownerId));
  });

  it('REFUSES no session at all', async () => {
    const api = appRouter.createCaller(testContext() as never);
    await expect(api.staffAuth.me()).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  });

  /**
   * **A portal session must never reach an admin procedure.** BUG-119 split
   * the two onto separate cookies (`rg_admin_session` / `rg_customer_session`),
   * so a customer cookie no longer even reaches `ctx.adminSession` — this
   * asserts that `requireRole` still refuses the session passed here as a
   * context fixture, which is what a misrouted or forged context would look
   * like.
   */
  it('REFUSES a customer session', async () => {
    const api = appRouter.createCaller(
      testContext({ subjectType: 'customer', subjectId: 1 }) as never,
    );
    await expect(api.staffAuth.me()).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  });

  it('REFUSES a staff session whose role is not a real role', async () => {
    const api = appRouter.createCaller(
      testContext({ subjectType: 'user', subjectId: ownerId, role: 'superuser' }) as never,
    );
    await expect(api.staffAuth.me()).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});
