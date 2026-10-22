/**
 * Staff accounts, task 1G: the forced password change.
 *
 * A staff member who signs in with a temporary password (a new account, or
 * one the owner reset) owes a new password before they may do anything else.
 * The control is on the server, in the one builder every admin procedure comes
 * from; the client's redirect is only a convenience.
 *
 * What is pinned here:
 *  - EVERY admin procedure on the mounted router refuses a session that owes a
 *    change, with the one code the client reads (`password_change_required`),
 *    except the two that are the way out. The set of exceptions is pinned too,
 *    so a third cannot be added by a one-line edit.
 *  - The refusal comes before input parsing and before any effect: an owed
 *    owner cannot create an account.
 *  - A caller the ROLE gate refuses is told that, not that they owe a change.
 *  - `staffAuth.changePassword`: wrong current password, same password, short
 *    password; the throttle; the flag cleared; this session kept and the
 *    others ended; the audit row without secrets.
 *  - The two Express routes that read a session themselves
 *    (`/api/receipts/:name`, `/api/payment-qr`) are pinned in
 *    `receipts-route.test.ts` and `portal-manual-payment.test.ts`.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { PASSWORD_CHANGE_REQUIRED } from '@rg/shared';
import { getDb, getPool } from '../db/client';
import { auditLog, sessions, users } from '../db/schema';
import { SESSION_COOKIE } from '../middleware/session-cookie';
import * as passwordModule from '../services/password';
import { hashPassword, verifyPassword } from '../services/password';
import { createSession, readSession } from '../services/sessions';
import { clearChangePasswordFailures, resetEmailThrottleForTests } from '../services/staff-auth';
import { appRouter } from '../routers/_app';
import { captureResponse, testContext } from './helpers/ctx';
import { describeWithDb } from './helpers/db';

type ProcedureLike = { _def?: { meta?: unknown } };
type AdminMeta = { access?: string; roles?: readonly string[]; allowsPasswordChange?: boolean };

const procedures = (appRouter as unknown as { _def: { procedures: Record<string, ProcedureLike> } })
  ._def.procedures;
const metaOf = (path: string) => (procedures[path]?._def?.meta ?? {}) as AdminMeta;
const adminPaths = Object.keys(procedures)
  .filter((path) => metaOf(path).access === 'admin')
  .sort();

/** A caller on the real router, walking the dotted path the way a client does. */
function callPath(ctx: unknown, path: string): Promise<unknown> {
  let node: unknown = appRouter.createCaller(ctx as never);
  for (const part of path.split('.')) node = (node as Record<string, unknown>)[part];
  return (node as (input?: unknown) => Promise<unknown>)();
}

describe('the must-change gate on every admin procedure', () => {
  it('walks a non-empty set of admin procedures', () => {
    // Guards the guard: an empty enumeration would pass everything below.
    expect(adminPaths.length).toBeGreaterThan(20);
    expect(adminPaths).toContain('admin.staffUsers.create');
  });

  it('lets exactly two procedures through: me and changePassword', () => {
    expect(adminPaths.filter((path) => metaOf(path).allowsPasswordChange === true)).toEqual([
      'staffAuth.changePassword',
      'staffAuth.me',
    ]);
  });

  it.each(adminPaths.filter((path) => metaOf(path).allowsPasswordChange !== true))(
    'refuses %s while a new password is owed',
    async (path) => {
      // A role the procedure admits, so only the must-change gate is left to refuse.
      const role = metaOf(path).roles![0] as 'owner' | 'finance' | 'dispatcher';
      const ctx = testContext({
        subjectType: 'user',
        subjectId: 1,
        role,
        mustChangePassword: true,
      });
      await expect(callPath(ctx, path)).rejects.toMatchObject({
        code: 'FORBIDDEN',
        message: PASSWORD_CHANGE_REQUIRED,
      });
    },
  );

  it('uses the one string the client reads', () => {
    expect(PASSWORD_CHANGE_REQUIRED).toBe('password_change_required');
  });
});

describeWithDb('the forced change, against real accounts', () => {
  const suffix = `${Math.floor(Math.random() * 1e9)}`;
  const emailOf = (label: string) => `${label}_${suffix}@example.test`;
  const CURRENT = 'the-temporary-pass-1';
  const NEXT = 'brand-new-password-9';
  let baselineHash = '';
  let ownerId = 0;
  let personId = 0;
  let financeId = 0;

  const ctxFor = (userId: number, role: 'owner' | 'dispatcher' | 'finance', token?: string) =>
    testContext(
      { subjectType: 'user', subjectId: userId, role, mustChangePassword: true },
      token ? { [SESSION_COOKIE]: token } : {},
    );

  beforeAll(async () => {
    baselineHash = await hashPassword(CURRENT);
    const db = getDb();
    const make = async (label: string, role: 'owner' | 'dispatcher' | 'finance') => {
      const [row] = await db
        .insert(users)
        .values({ name: `Gate ${label}`, email: emailOf(label), passwordHash: baselineHash, role });
      return row.insertId;
    };
    ownerId = await make('owner', 'owner');
    personId = await make('person', 'dispatcher');
    financeId = await make('finance', 'finance');
  }, 60_000);

  beforeEach(async () => {
    resetEmailThrottleForTests();
    for (const id of [ownerId, personId, financeId]) clearChangePasswordFailures(id);
    await getDb()
      .update(users)
      .set({ passwordHash: baselineHash, mustChangePassword: true, isActive: true })
      .where(sql`${users.id} IN (${ownerId}, ${personId}, ${financeId})`);
  });

  const everyId = () => [ownerId, personId, financeId];

  afterEach(async () => {
    const pool = getPool();
    await pool.query("DELETE FROM sessions WHERE subject_type = 'user' AND subject_id IN (?)", [
      everyId(),
    ]);
    await pool.query("DELETE FROM audit_log WHERE entity = 'users' AND entity_id IN (?)", [
      everyId(),
    ]);
    await pool.query("DELETE FROM audit_log WHERE actor_type = 'user' AND actor_id IN (?)", [
      everyId(),
    ]);
    await pool.query('DELETE FROM users WHERE email = ?', [emailOf('newcomer')]);
  });

  afterAll(async () => {
    const pool = getPool();
    await pool.query('DELETE FROM users WHERE email LIKE ?', [`%\\_${suffix}@example.test`]);
    const [rows] = await pool.query('SELECT COUNT(*) AS n FROM users WHERE email LIKE ?', [
      `%\\_${suffix}@example.test`,
    ]);
    const left = (rows as { n: number }[])[0]!.n;
    if (left !== 0) throw new Error(`staff-must-change fixtures left ${left} user rows behind`);
  });

  async function userRow(id: number) {
    const [r] = await getDb().select().from(users).where(eq(users.id, id));
    return r!;
  }

  async function sessionCount(id: number) {
    const [r] = await getDb()
      .select({ n: sql<number>`COUNT(*)` })
      .from(sessions)
      .where(and(eq(sessions.subjectType, 'user'), eq(sessions.subjectId, id)));
    return Number(r!.n);
  }

  async function newSession(id: number) {
    return (await createSession('user', id, new Date())).token;
  }

  // -------------------------------------------------------------------------
  // The gate, with real rows
  // -------------------------------------------------------------------------

  it('refuses an owner who owes a change BEFORE any effect: nothing is created', async () => {
    const api = appRouter.createCaller(ctxFor(ownerId, 'owner') as never);
    await expect(
      api.admin.staffUsers.create({
        email: emailOf('newcomer'),
        name: 'Should Not Exist',
        role: 'dispatcher',
        tempPassword: 'temporary-pass-12345',
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN', message: PASSWORD_CHANGE_REQUIRED });
    const [made] = await getDb()
      .select()
      .from(users)
      .where(eq(users.email, emailOf('newcomer')));
    expect(made, 'an account was created by a session that owes a password change').toBeUndefined();
  });

  it('refuses before reading the input, so a malformed call gets the same answer', async () => {
    const api = appRouter.createCaller(ctxFor(ownerId, 'owner') as never);
    await expect(
      api.admin.staffUsers.create({ email: 'not-an-email' } as never),
    ).rejects.toMatchObject({ code: 'FORBIDDEN', message: PASSWORD_CHANGE_REQUIRED });
  });

  it('tells a caller the ROLE gate refuses that, not that a change is owed', async () => {
    const api = appRouter.createCaller(ctxFor(financeId, 'finance') as never);
    const error = await api.admin.staffUsers.list().then(
      () => null,
      (e: { code: string; message: string }) => e,
    );
    expect(error?.code).toBe('FORBIDDEN');
    expect(error?.message).not.toBe(PASSWORD_CHANGE_REQUIRED);
  });

  it('lets a person with nothing owed use the same procedure', async () => {
    await getDb().update(users).set({ mustChangePassword: false }).where(eq(users.id, personId));
    const token = await newSession(personId);
    const session = await readSession(token, new Date());
    expect(session?.mustChangePassword).toBe(false);
    const api = appRouter.createCaller(testContext(session, { [SESSION_COOKIE]: token }) as never);
    await expect(api.admin.dashboard.alerts()).resolves.toBeDefined();
  });

  it('reads the flag LIVE: setting it refuses the very next call on an existing session', async () => {
    await getDb().update(users).set({ mustChangePassword: false }).where(eq(users.id, personId));
    const token = await newSession(personId);
    const call = async () => {
      const session = await readSession(token, new Date());
      return appRouter
        .createCaller(testContext(session, { [SESSION_COOKIE]: token }) as never)
        .admin.dashboard.alerts();
    };
    await expect(call()).resolves.toBeDefined();
    await getDb().update(users).set({ mustChangePassword: true }).where(eq(users.id, personId));
    await expect(call()).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: PASSWORD_CHANGE_REQUIRED,
    });
  });

  it('walks the whole path: owner creates, person signs in, is held, changes it, then works', async () => {
    const owner = appRouter.createCaller(
      testContext({ subjectType: 'user', subjectId: ownerId, role: 'owner' }) as never,
    );
    await owner.admin.staffUsers.create({
      email: emailOf('newcomer'),
      name: 'Newcomer',
      role: 'dispatcher',
      tempPassword: CURRENT,
    });

    // Sign in with the temporary password: the real login, a captured cookie.
    const cap = captureResponse();
    const login = await appRouter
      .createCaller({ req: { cookies: {} }, res: cap.res, session: null } as never)
      .staffAuth.login({ email: emailOf('newcomer'), password: CURRENT });
    expect(login).toEqual({ role: 'dispatcher', mustChangePassword: true });
    const token = cap.set.find((c) => c.name === SESSION_COOKIE)!.value;

    const as = async () =>
      appRouter.createCaller(
        testContext(await readSession(token, new Date()), { [SESSION_COOKIE]: token }) as never,
      );

    await expect((await as()).admin.dashboard.alerts()).rejects.toMatchObject({
      message: PASSWORD_CHANGE_REQUIRED,
    });
    await expect((await as()).staffAuth.me()).resolves.toMatchObject({
      role: 'dispatcher',
      mustChangePassword: true,
    });

    await (await as()).staffAuth.changePassword({ currentPassword: CURRENT, newPassword: NEXT });

    await expect((await as()).staffAuth.me()).resolves.toMatchObject({ mustChangePassword: false });
    await expect((await as()).admin.dashboard.alerts()).resolves.toBeDefined();
  });

  // -------------------------------------------------------------------------
  // staffAuth.me
  // -------------------------------------------------------------------------

  it('answers staffAuth.me to a session that owes a change, and says so', async () => {
    const api = appRouter.createCaller(ctxFor(personId, 'dispatcher') as never);
    await expect(api.staffAuth.me()).resolves.toEqual({
      userId: personId,
      role: 'dispatcher',
      mustChangePassword: true,
    });
  });

  // -------------------------------------------------------------------------
  // staffAuth.changePassword
  // -------------------------------------------------------------------------

  describe('staffAuth.changePassword', () => {
    it('refuses a wrong current password, changes nothing, and keeps every session', async () => {
      const token = await newSession(personId);
      await newSession(personId);
      const api = appRouter.createCaller(ctxFor(personId, 'dispatcher', token) as never);

      await expect(
        api.staffAuth.changePassword({ currentPassword: 'definitely-not-it-1', newPassword: NEXT }),
      ).rejects.toMatchObject({
        code: 'UNAUTHORIZED',
        message: 'Your current password is not right.',
      });

      const after = await userRow(personId);
      expect(after.passwordHash).toBe(baselineHash);
      expect(after.mustChangePassword).toBe(true);
      expect(await sessionCount(personId)).toBe(2);
    });

    it('throttles wrong guesses per user, and the throttle holds against the RIGHT password too', async () => {
      const api = appRouter.createCaller(ctxFor(personId, 'dispatcher') as never);
      for (let i = 0; i < 5; i += 1) {
        await expect(
          api.staffAuth.changePassword({
            currentPassword: `wrong-guess-${i}-xx`,
            newPassword: NEXT,
          }),
        ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
      }
      await expect(
        api.staffAuth.changePassword({ currentPassword: CURRENT, newPassword: NEXT }),
      ).rejects.toMatchObject({ code: 'TOO_MANY_REQUESTS' });
      expect((await userRow(personId)).passwordHash).toBe(baselineHash);
    });

    it('does not let one person’s wrong guesses lock another out', async () => {
      const person = appRouter.createCaller(ctxFor(personId, 'dispatcher') as never);
      for (let i = 0; i < 5; i += 1) {
        await person.staffAuth
          .changePassword({ currentPassword: `wrong-guess-${i}-xx`, newPassword: NEXT })
          .catch(() => undefined);
      }
      const finance = appRouter.createCaller(ctxFor(financeId, 'finance') as never);
      await expect(
        finance.staffAuth.changePassword({ currentPassword: CURRENT, newPassword: NEXT }),
      ).resolves.toEqual({ ok: true });
    });

    it('refuses a new password equal to the current one', async () => {
      const api = appRouter.createCaller(ctxFor(personId, 'dispatcher') as never);
      await expect(
        api.staffAuth.changePassword({ currentPassword: CURRENT, newPassword: CURRENT }),
      ).rejects.toMatchObject({
        code: 'BAD_REQUEST',
        message: 'Choose a password you are not using now.',
      });
      const after = await userRow(personId);
      expect(after.passwordHash).toBe(baselineHash);
      expect(after.mustChangePassword).toBe(true);
    });

    it('refuses a new password under twelve characters', async () => {
      const api = appRouter.createCaller(ctxFor(personId, 'dispatcher') as never);
      await expect(
        api.staffAuth.changePassword({ currentPassword: CURRENT, newPassword: 'elevenchars' }),
      ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
      expect((await userRow(personId)).mustChangePassword).toBe(true);
    });

    it('refuses extra fields, so a role or flag cannot ride along', async () => {
      const api = appRouter.createCaller(ctxFor(personId, 'dispatcher') as never);
      await expect(
        api.staffAuth.changePassword({
          currentPassword: CURRENT,
          newPassword: NEXT,
          role: 'owner',
          mustChangePassword: false,
        } as never),
      ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
      expect((await userRow(personId)).role).toBe('dispatcher');
    });

    it('stores a hash of the new password and clears the flag', async () => {
      const api = appRouter.createCaller(ctxFor(personId, 'dispatcher') as never);
      await expect(
        api.staffAuth.changePassword({ currentPassword: CURRENT, newPassword: NEXT }),
      ).resolves.toEqual({ ok: true });

      const after = await userRow(personId);
      expect(after.mustChangePassword).toBe(false);
      expect(after.passwordHash).not.toBe(baselineHash);
      expect(after.passwordHash).not.toContain(NEXT);
      expect(await verifyPassword(NEXT, after.passwordHash)).toBe(true);
      expect(await verifyPassword(CURRENT, after.passwordHash)).toBe(false);
    });

    it('keeps THIS session and ends the same person’s others', async () => {
      const mine = await newSession(personId);
      const elsewhere = await newSession(personId);
      const bystander = await newSession(financeId);
      const api = appRouter.createCaller(ctxFor(personId, 'dispatcher', mine) as never);

      await api.staffAuth.changePassword({ currentPassword: CURRENT, newPassword: NEXT });

      expect(await readSession(mine, new Date())).not.toBeNull();
      expect(await readSession(elsewhere, new Date())).toBeNull();
      expect(
        await readSession(bystander, new Date()),
        'another person was signed out',
      ).not.toBeNull();
    });

    it('fails closed with no cookie token: every session of the person ends', async () => {
      const a = await newSession(personId);
      const b = await newSession(personId);
      const api = appRouter.createCaller(ctxFor(personId, 'dispatcher') as never);

      await api.staffAuth.changePassword({ currentPassword: CURRENT, newPassword: NEXT });

      expect(await readSession(a, new Date())).toBeNull();
      expect(await readSession(b, new Date())).toBeNull();
    });

    it('does not touch a driver session that shares the numeric id', async () => {
      await createSession('driver', personId, new Date());
      const mine = await newSession(personId);
      const api = appRouter.createCaller(ctxFor(personId, 'dispatcher', mine) as never);

      await api.staffAuth.changePassword({ currentPassword: CURRENT, newPassword: NEXT });

      const [rows] = await getPool().query(
        "SELECT COUNT(*) AS n FROM sessions WHERE subject_type = 'driver' AND subject_id = ?",
        [personId],
      );
      expect((rows as { n: number }[])[0]!.n).toBe(1);
      await getPool().query(
        "DELETE FROM sessions WHERE subject_type = 'driver' AND subject_id = ?",
        [personId],
      );
    });

    it('audits staff.password_changed with forced and sessionsRevoked, and no secrets', async () => {
      const mine = await newSession(personId);
      await newSession(personId);
      await newSession(personId);
      const api = appRouter.createCaller(ctxFor(personId, 'dispatcher', mine) as never);

      await api.staffAuth.changePassword({ currentPassword: CURRENT, newPassword: NEXT });

      const rows = await getDb()
        .select({ actorId: auditLog.actorId, actorType: auditLog.actorType, data: auditLog.data })
        .from(auditLog)
        .where(and(eq(auditLog.action, 'staff.password_changed'), eq(auditLog.entityId, personId)));
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ actorType: 'user', actorId: personId });
      expect(rows[0]!.data).toEqual({ forced: true, sessionsRevoked: 2 });
      const text = JSON.stringify(rows);
      expect(text).not.toContain(CURRENT);
      expect(text).not.toContain(NEXT);
      expect(text).not.toMatch(/scrypt|passwordHash|password_hash/i);
    });

    it('records forced=false for a voluntary change', async () => {
      await getDb().update(users).set({ mustChangePassword: false }).where(eq(users.id, personId));
      const mine = await newSession(personId);
      const api = appRouter.createCaller(
        testContext(
          { subjectType: 'user', subjectId: personId, role: 'dispatcher' },
          { [SESSION_COOKIE]: mine },
        ) as never,
      );

      await api.staffAuth.changePassword({ currentPassword: CURRENT, newPassword: NEXT });

      const [row] = await getDb()
        .select({ data: auditLog.data })
        .from(auditLog)
        .where(and(eq(auditLog.action, 'staff.password_changed'), eq(auditLog.entityId, personId)));
      expect(row!.data).toMatchObject({ forced: false });
    });

    it('lets the new password sign in and refuses the old one', async () => {
      const api = appRouter.createCaller(ctxFor(personId, 'dispatcher') as never);
      await api.staffAuth.changePassword({ currentPassword: CURRENT, newPassword: NEXT });

      const login = (password: string) =>
        appRouter
          .createCaller({
            req: { cookies: {} },
            res: captureResponse().res,
            session: null,
          } as never)
          .staffAuth.login({ email: emailOf('person'), password });
      await expect(login(NEXT)).resolves.toEqual({ role: 'dispatcher', mustChangePassword: false });
      await expect(login(CURRENT)).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    });

    it('refuses with CONFLICT, and never overwrites, when the owner reset it mid-request', async () => {
      // The owner's reset lands AFTER this request verified the current
      // password and BEFORE it writes: the hash check is wrapped so the reset
      // is issued at exactly that point, rather than hoping a race lines up.
      const resetHash = await hashPassword('owner-reset-temp-77');
      const real = passwordModule.verifyPassword;
      const spy = vi.spyOn(passwordModule, 'verifyPassword').mockImplementation(async (...args) => {
        const ok = await real(...args);
        await getDb().update(users).set({ passwordHash: resetHash }).where(eq(users.id, personId));
        return ok;
      });
      try {
        const api = appRouter.createCaller(ctxFor(personId, 'dispatcher') as never);
        await expect(
          api.staffAuth.changePassword({ currentPassword: CURRENT, newPassword: NEXT }),
        ).rejects.toMatchObject({
          code: 'CONFLICT',
          message: 'Your password was changed by someone else. Sign in again.',
        });
      } finally {
        spy.mockRestore();
      }
      const after = await userRow(personId);
      expect(after.passwordHash, "the owner's reset was overwritten").toBe(resetHash);
      expect(after.mustChangePassword).toBe(true);
    });
  });
});
