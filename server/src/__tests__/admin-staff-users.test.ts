/**
 * Staff accounts, task 1G: `admin.staffUsers` — who may call it, and the
 * safety rules that hold even for the person who may.
 *
 * Two halves. The first is the role matrix: for EACH of the five procedures,
 * the owner is let in and finance, dispatcher, a driver, a portal guest and a
 * logged-out caller are each refused — and the refusal is checked by what did
 * NOT change, not only by the error. The second is the rules from the owner's
 * brief (2026-10-23): always an active owner, no self-lock-out, a unique
 * email, a deactivated account indistinguishable from a wrong password at the
 * login, sessions ended with the deactivation or reset, and an audit row that
 * never carries the password.
 *
 * A fixture can stand in for the owner because the guard under test reads the
 * caller's session and the rows, not how the session came to exist.
 */
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from 'vitest';
import { and, eq, inArray, notInArray, sql } from 'drizzle-orm';
import type { AdminRole } from '@rg/shared';
import { getDb, getPool } from '../db/client';
import { auditLog, sessions, users } from '../db/schema';
import { hashPassword } from '../services/password';
import { createSession, readSession } from '../services/sessions';
import { resetEmailThrottleForTests } from '../services/staff-auth';
import { appRouter } from '../routers/_app';
import { adminStaffUsersRouter } from '../routers/admin/staff-users';
import { customerContext, driverContext, staffContext, testContext } from './helpers/ctx';
import { describeWithDb } from './helpers/db';

const PASSWORD = 'fixture-password-0001';
const TEMP = 'temporary-pass-12345';
const suffix = `${Math.floor(Math.random() * 1e9)}`;
const emailOf = (label: string) => `${label}_${suffix}@example.test`;
const NEW_EMAIL = emailOf('newcomer');

type FixtureKey = 'ownerA' | 'ownerB' | 'finance' | 'dispatcher' | 'target';
const FIXTURES: Record<FixtureKey, { role: AdminRole; email: string }> = {
  ownerA: { role: 'owner', email: emailOf('owner_a') },
  ownerB: { role: 'owner', email: emailOf('owner_b') },
  finance: { role: 'finance', email: emailOf('finance') },
  dispatcher: { role: 'dispatcher', email: emailOf('dispatcher') },
  target: { role: 'dispatcher', email: emailOf('target') },
};
const ids = {} as Record<FixtureKey, number>;
let baselineHash = '';

const api = (ctx: ReturnType<typeof testContext>) => appRouter.createCaller(ctx as never);
const asOwnerA = () => api(staffContext(ids.ownerA, 'owner'));
const asOwnerB = () => api(staffContext(ids.ownerB, 'owner'));

beforeAll(async () => {
  baselineHash = await hashPassword(PASSWORD);
  const db = getDb();
  for (const key of Object.keys(FIXTURES) as FixtureKey[]) {
    const [row] = await db.insert(users).values({
      name: `Fixture ${key}`,
      email: FIXTURES[key].email,
      passwordHash: baselineHash,
      role: FIXTURES[key].role,
    });
    ids[key] = row.insertId;
  }
}, 60_000);

/** Every test starts from the same rows, whatever the one before did. */
beforeEach(async () => {
  resetEmailThrottleForTests();
  const db = getDb();
  for (const key of Object.keys(FIXTURES) as FixtureKey[]) {
    await db
      .update(users)
      .set({
        name: `Fixture ${key}`,
        role: FIXTURES[key].role,
        isActive: true,
        mustChangePassword: false,
        passwordHash: baselineHash,
      })
      .where(eq(users.id, ids[key]));
  }
  await db.delete(users).where(eq(users.email, NEW_EMAIL));
});

async function scrub() {
  const pool = getPool();
  const [rows] = await pool.query('SELECT id FROM users WHERE email LIKE ?', [
    `%\\_${suffix}@example.test`,
  ]);
  const all = (rows as { id: number }[]).map((r) => r.id);
  if (all.length > 0) {
    await pool.query(
      "DELETE FROM sessions WHERE subject_id IN (?) AND subject_type IN ('user','driver')",
      [all],
    );
    await pool.query("DELETE FROM audit_log WHERE entity = 'users' AND entity_id IN (?)", [all]);
    await pool.query('DELETE FROM audit_log WHERE actor_type = ? AND actor_id IN (?)', [
      'user',
      all,
    ]);
    await pool.query('DELETE FROM users WHERE id IN (?)', [all]);
  }
}

afterEach(async () => {
  const pool = getPool();
  const all = Object.values(ids);
  await pool.query(
    "DELETE FROM sessions WHERE subject_id IN (?) AND subject_type IN ('user','driver')",
    [all],
  );
  await pool.query("DELETE FROM audit_log WHERE entity = 'users' AND entity_id IN (?)", [all]);
  await pool.query("DELETE FROM audit_log WHERE action LIKE 'auth.%' AND actor_id IN (?)", [all]);
  await getDb().delete(users).where(eq(users.email, NEW_EMAIL));
});

afterAll(async () => {
  await scrub();
  const [rows] = await getPool().query('SELECT COUNT(*) AS n FROM users WHERE email LIKE ?', [
    `%\\_${suffix}@example.test`,
  ]);
  const left = (rows as { n: number }[])[0]!.n;
  if (left !== 0) throw new Error(`staff-users fixtures left ${left} user rows behind`);
});

async function row(id: number) {
  const [r] = await getDb().select().from(users).where(eq(users.id, id));
  return r!;
}

async function sessionCount(subjectType: 'user' | 'driver', subjectId: number) {
  const [r] = await getDb()
    .select({ n: sql<number>`COUNT(*)` })
    .from(sessions)
    .where(and(eq(sessions.subjectType, subjectType), eq(sessions.subjectId, subjectId)));
  return Number(r!.n);
}

async function auditFor(action: string, entityId: number) {
  return getDb()
    .select({ actorId: auditLog.actorId, actorType: auditLog.actorType, data: auditLog.data })
    .from(auditLog)
    .where(and(eq(auditLog.action, action), eq(auditLog.entityId, entityId)));
}

function expectNoSecrets(value: unknown) {
  const text = JSON.stringify(value);
  expect(text).not.toContain(TEMP);
  expect(text).not.toContain(PASSWORD);
  expect(text).not.toMatch(/scrypt/i);
  expect(text).not.toMatch(/passwordHash|password_hash/);
}

// ---------------------------------------------------------------------------
// The role matrix
// ---------------------------------------------------------------------------

type Api = ReturnType<typeof asOwnerA>;
const ACTIONS: Record<string, (a: Api) => Promise<unknown>> = {
  list: (a) => a.admin.staffUsers.list(),
  create: (a) =>
    a.admin.staffUsers.create({
      email: NEW_EMAIL,
      name: 'New Person',
      role: 'dispatcher',
      tempPassword: TEMP,
    }),
  update: (a) => a.admin.staffUsers.update({ id: ids.target, name: 'Renamed', role: 'finance' }),
  setActive: (a) => a.admin.staffUsers.setActive({ id: ids.target, isActive: false }),
  resetPassword: (a) => a.admin.staffUsers.resetPassword({ id: ids.target, tempPassword: TEMP }),
};

const REFUSED: Record<string, { ctx: () => ReturnType<typeof testContext>; code: string }> = {
  finance: { ctx: () => staffContext(ids.finance, 'finance'), code: 'FORBIDDEN' },
  dispatcher: { ctx: () => staffContext(ids.dispatcher, 'dispatcher'), code: 'FORBIDDEN' },
  driver: { ctx: () => driverContext(ids.target), code: 'UNAUTHORIZED' },
  guest: { ctx: () => customerContext(1), code: 'UNAUTHORIZED' },
  'logged-out': { ctx: () => testContext(null), code: 'UNAUTHORIZED' },
};

describeWithDb('admin.staffUsers: who may call it', () => {
  it('has exactly the five procedures, and none of them deletes', () => {
    const names = Object.keys(
      (adminStaffUsersRouter as unknown as { _def: { procedures: Record<string, unknown> } })._def
        .procedures,
    ).sort();
    expect(names).toEqual(['create', 'list', 'resetPassword', 'setActive', 'update']);
  });

  it.each(Object.keys(ACTIONS))('lets the owner call %s', async (action) => {
    await expect(ACTIONS[action]!(asOwnerA())).resolves.toBeDefined();
  });

  const cases = Object.keys(REFUSED).flatMap((who) =>
    Object.keys(ACTIONS).map((action) => [who, action] as const),
  );

  it.each(cases)('refuses %s calling %s, and changes nothing', async (who, action) => {
    await createSession('user', ids.target, new Date());
    const before = await row(ids.target);

    await expect(ACTIONS[action]!(api(REFUSED[who]!.ctx()))).rejects.toMatchObject({
      code: REFUSED[who]!.code,
    });

    const after = await row(ids.target);
    expect(after).toEqual(before);
    expect(await sessionCount('user', ids.target)).toBe(1);
    const [made] = await getDb().select().from(users).where(eq(users.email, NEW_EMAIL));
    expect(made).toBeUndefined();
    expect(await auditFor('staff.deactivated', ids.target)).toHaveLength(0);
    expect(await auditFor('staff.password_reset', ids.target)).toHaveLength(0);
    expect(await auditFor('staff.role_changed', ids.target)).toHaveLength(0);
  });

  it('does not list password hashes to the owner either', async () => {
    const list = await asOwnerA().admin.staffUsers.list();
    expect(list.map((u) => u.email)).toEqual(expect.arrayContaining([FIXTURES.target.email]));
    expectNoSecrets(list);
  });
});

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

describeWithDb('admin.staffUsers.create', () => {
  it('stores a trimmed lowercase email, a hash, and an owed password change', async () => {
    const { id } = await asOwnerA().admin.staffUsers.create({
      email: `  ${NEW_EMAIL.toUpperCase().replace('@EXAMPLE.TEST', '@example.test')}  `,
      name: '  New Person ',
      role: 'finance',
      tempPassword: TEMP,
    });
    const made = await row(id);
    expect(made.email).toBe(NEW_EMAIL.toLowerCase());
    expect(made.name).toBe('New Person');
    expect(made.role).toBe('finance');
    expect(made.isActive).toBe(true);
    expect(made.mustChangePassword).toBe(true);
    expect(made.passwordHash).not.toBe(TEMP);
    expect(made.passwordHash.length).toBeGreaterThan(40);
  });

  it('lets the new account sign in with the temporary password, and says a change is owed', async () => {
    await asOwnerA().admin.staffUsers.create({
      email: NEW_EMAIL,
      name: 'New Person',
      role: 'dispatcher',
      tempPassword: TEMP,
    });
    const result = await api(testContext(null)).staffAuth.login({
      email: NEW_EMAIL,
      password: TEMP,
    });
    expect(result).toEqual({ role: 'dispatcher', mustChangePassword: true });
  });

  it.each([
    ['the same address', () => FIXTURES.finance.email],
    ['upper case', () => FIXTURES.finance.email.toUpperCase()],
    ['padded with spaces', () => `  ${FIXTURES.finance.email}  `],
  ])('refuses a duplicate email (%s) with the one sentence', async (_label, email) => {
    const before = await getDb().select({ id: users.id }).from(users);
    await expect(
      asOwnerA().admin.staffUsers.create({
        email: email(),
        name: 'Dup',
        role: 'dispatcher',
        tempPassword: TEMP,
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT', message: 'That email is already used.' });
    expect(await getDb().select({ id: users.id }).from(users)).toHaveLength(before.length);
  });

  it('refuses a short temporary password, an unknown role and extra fields, creating nothing', async () => {
    const base = { email: NEW_EMAIL, name: 'New Person', role: 'dispatcher', tempPassword: TEMP };
    const create = (extra: Record<string, unknown>) =>
      asOwnerA().admin.staffUsers.create({ ...base, ...extra } as never);

    await expect(create({ tempPassword: 'short' })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(create({ role: 'superuser' })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(create({ mustChangePassword: false })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
    await expect(create({ isActive: false })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    const [made] = await getDb().select().from(users).where(eq(users.email, NEW_EMAIL));
    expect(made).toBeUndefined();
  });

  it('audits staff.created with the role and email, never the password', async () => {
    const { id } = await asOwnerA().admin.staffUsers.create({
      email: NEW_EMAIL,
      name: 'New Person',
      role: 'finance',
      tempPassword: TEMP,
    });
    const rows = await auditFor('staff.created', id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ actorType: 'user', actorId: ids.ownerA });
    expect(rows[0]!.data).toMatchObject({ role: 'finance', email: NEW_EMAIL });
    expectNoSecrets(rows);
  });
});

// ---------------------------------------------------------------------------
// There is always an active owner
// ---------------------------------------------------------------------------

describeWithDb('admin.staffUsers: the last active owner', () => {
  // These tests count active owners, so an owner this file did not create (the
  // one globalSetup seeds when OWNER_* is set on the machine) must not count.
  let setAside: number[] = [];
  beforeEach(async () => {
    const strangers = await getDb()
      .select({ id: users.id })
      .from(users)
      .where(
        and(
          eq(users.role, 'owner'),
          eq(users.isActive, true),
          notInArray(users.id, [ids.ownerA, ids.ownerB]),
        ),
      );
    setAside = strangers.map((r) => r.id);
    if (setAside.length > 0) {
      await getDb().update(users).set({ isActive: false }).where(inArray(users.id, setAside));
    }
  });
  afterEach(async () => {
    if (setAside.length > 0) {
      await getDb().update(users).set({ isActive: true }).where(inArray(users.id, setAside));
    }
    setAside = [];
  });

  /** B has been switched off, so A is the only active owner. */
  async function onlyOwnerA() {
    await getDb().update(users).set({ isActive: false }).where(eq(users.id, ids.ownerB));
  }

  it('refuses to deactivate the only active owner', async () => {
    await onlyOwnerA();
    // B's session is still in flight; the rule must not rely on it being dead.
    await expect(
      asOwnerB().admin.staffUsers.setActive({ id: ids.ownerA, isActive: false }),
    ).rejects.toMatchObject({
      code: 'CONFLICT',
      message: 'There must always be at least one active owner.',
    });
    expect((await row(ids.ownerA)).isActive).toBe(true);
    expect(await auditFor('staff.deactivated', ids.ownerA)).toHaveLength(0);
  });

  it('refuses to demote the only active owner', async () => {
    await onlyOwnerA();
    await expect(
      asOwnerB().admin.staffUsers.update({
        id: ids.ownerA,
        name: 'Fixture ownerA',
        role: 'finance',
      }),
    ).rejects.toMatchObject({
      code: 'CONFLICT',
      message: 'There must always be at least one active owner.',
    });
    expect((await row(ids.ownerA)).role).toBe('owner');
  });

  /**
   * The case the lock exists for, and the only way the rule can be broken by
   * two genuinely signed-in owners: each switches the other off at the same
   * moment. Without the row lock both transactions read the other as the
   * remaining owner and both commit, leaving nobody able to sign in. Repeated
   * because a race is a probability, not a certainty, on any one attempt.
   */
  it('two owners deactivating each other at once leave exactly one active owner', async () => {
    for (let attempt = 0; attempt < 6; attempt++) {
      const outcomes = await Promise.allSettled([
        asOwnerA().admin.staffUsers.setActive({ id: ids.ownerB, isActive: false }),
        asOwnerB().admin.staffUsers.setActive({ id: ids.ownerA, isActive: false }),
      ]);
      expect(
        outcomes.filter((o) => o.status === 'fulfilled'),
        `attempt ${attempt}`,
      ).toHaveLength(1);
      const [refused] = outcomes.filter((o) => o.status === 'rejected');
      expect((refused as PromiseRejectedResult).reason).toMatchObject({
        code: 'CONFLICT',
        message: 'There must always be at least one active owner.',
      });
      const [{ active }] = (await getDb()
        .select({ active: sql<number>`COUNT(*)` })
        .from(users)
        .where(
          and(
            eq(users.role, 'owner'),
            eq(users.isActive, true),
            sql`${users.id} IN (${ids.ownerA}, ${ids.ownerB})`,
          ),
        )) as [{ active: number }];
      expect(Number(active), `attempt ${attempt}`).toBe(1);
      await getDb()
        .update(users)
        .set({ isActive: true })
        .where(sql`${users.id} IN (${ids.ownerA}, ${ids.ownerB})`);
    }
  }, 60_000);

  it('is not a blanket ban: with two active owners one may be deactivated or demoted', async () => {
    await asOwnerA().admin.staffUsers.update({
      id: ids.ownerB,
      name: 'Fixture ownerB',
      role: 'dispatcher',
    });
    expect((await row(ids.ownerB)).role).toBe('dispatcher');

    await getDb().update(users).set({ role: 'owner' }).where(eq(users.id, ids.ownerB));
    await asOwnerA().admin.staffUsers.setActive({ id: ids.ownerB, isActive: false });
    expect((await row(ids.ownerB)).isActive).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Not on yourself
// ---------------------------------------------------------------------------

describeWithDb('admin.staffUsers: the owner acting on their own account', () => {
  it('cannot deactivate themselves, even with another owner standing by', async () => {
    await expect(
      asOwnerA().admin.staffUsers.setActive({ id: ids.ownerA, isActive: false }),
    ).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: 'You cannot deactivate your own account.',
    });
    expect((await row(ids.ownerA)).isActive).toBe(true);
  });

  it('cannot change their own role, even with another owner standing by', async () => {
    await expect(
      asOwnerA().admin.staffUsers.update({
        id: ids.ownerA,
        name: 'Fixture ownerA',
        role: 'finance',
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN', message: 'You cannot change your own role.' });
    expect((await row(ids.ownerA)).role).toBe('owner');
  });

  it('cannot reset their own password through the staff screen', async () => {
    await expect(
      asOwnerA().admin.staffUsers.resetPassword({ id: ids.ownerA, tempPassword: TEMP }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const after = await row(ids.ownerA);
    expect(after.passwordHash).toBe(baselineHash);
    expect(after.mustChangePassword).toBe(false);
  });

  it('may still rename themselves', async () => {
    await asOwnerA().admin.staffUsers.update({ id: ids.ownerA, name: 'New Name', role: 'owner' });
    expect((await row(ids.ownerA)).name).toBe('New Name');
    expect(await auditFor('staff.updated', ids.ownerA)).toHaveLength(1);
  });

  it('answers NOT_FOUND for an id that does not exist', async () => {
    await expect(
      asOwnerA().admin.staffUsers.setActive({ id: 2_000_000_000, isActive: false }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

// ---------------------------------------------------------------------------
// Deactivate and reset end sessions; a deactivated account cannot sign in
// ---------------------------------------------------------------------------

describeWithDb('admin.staffUsers: deactivating and resetting', () => {
  it('ends every session of the deactivated user, and only theirs', async () => {
    const first = await createSession('user', ids.target, new Date());
    await createSession('user', ids.target, new Date());
    await createSession('user', ids.dispatcher, new Date());
    // A driver whose id happens to equal the staff id is a different subject.
    await createSession('driver', ids.target, new Date());

    await asOwnerA().admin.staffUsers.setActive({ id: ids.target, isActive: false });

    expect(await readSession(first.token, new Date())).toBeNull();
    expect(await sessionCount('user', ids.target)).toBe(0);
    expect(await sessionCount('user', ids.dispatcher)).toBe(1);
    expect(await sessionCount('driver', ids.target)).toBe(1);

    const audit = await auditFor('staff.deactivated', ids.target);
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ actorId: ids.ownerA });
    expect(audit[0]!.data).toMatchObject({ sessionsRevoked: 2 });
  });

  it('signs a deactivated account out of the very next request', async () => {
    const { token } = await createSession('user', ids.target, new Date());
    expect(await readSession(token, new Date())).toMatchObject({ role: 'dispatcher' });
    await asOwnerA().admin.staffUsers.setActive({ id: ids.target, isActive: false });
    expect(await readSession(token, new Date())).toBeNull();
  });

  it('gives a deactivated account the same refusal as a wrong password or an unknown email', async () => {
    await asOwnerA().admin.staffUsers.setActive({ id: ids.target, isActive: false });
    const login = (email: string, password: string) =>
      api(testContext(null)).staffAuth.login({ email, password });

    const inactive = await login(FIXTURES.target.email, PASSWORD).catch((e) => e);
    resetEmailThrottleForTests();
    const wrong = await login(FIXTURES.dispatcher.email, 'not-the-password-0000').catch((e) => e);
    resetEmailThrottleForTests();
    const unknown = await login(emailOf('nobody'), PASSWORD).catch((e) => e);

    for (const refusal of [inactive, wrong, unknown]) {
      expect(refusal).toMatchObject({
        code: 'UNAUTHORIZED',
        message: 'That email and password do not match.',
      });
    }
    expect(await sessionCount('user', ids.target)).toBe(0);
  });

  it('lets a reactivated account sign in again, with a fresh session', async () => {
    await asOwnerA().admin.staffUsers.setActive({ id: ids.target, isActive: false });
    await asOwnerA().admin.staffUsers.setActive({ id: ids.target, isActive: true });
    await expect(
      api(testContext(null)).staffAuth.login({ email: FIXTURES.target.email, password: PASSWORD }),
    ).resolves.toMatchObject({ role: 'dispatcher' });
    expect(await auditFor('staff.reactivated', ids.target)).toHaveLength(1);
  });

  /**
   * 7N item 6. The `UPDATE` and the audit row were both unconditional, so
   * `setActive(id, true)` on an already-active account wrote a
   * `staff.reactivated` row claiming a change that did not happen —
   * `sessionsRevoked: 0`, nothing altered, and an audit trail that says a
   * dormant account was brought back on a day nobody touched it. CLAUDE.md:
   * "every payment, refund, status change, and assignment writes to
   * `audit_log`" — a non-change is not a status change, and a log that
   * records non-events is a log a reader stops believing.
   *
   * The guard is inside the transaction and AFTER `lockTarget`, so a
   * concurrent pair cannot both read "it differs" and both write.
   */
  it('writes NO audit row and changes nothing when the account is ALREADY active', async () => {
    expect((await row(ids.target)).isActive).toBe(true);
    const { token } = await createSession('user', ids.target, new Date());

    await asOwnerA().admin.staffUsers.setActive({ id: ids.target, isActive: true });

    expect(await auditFor('staff.reactivated', ids.target)).toHaveLength(0);
    expect(await auditFor('staff.deactivated', ids.target)).toHaveLength(0);
    // Nothing happened, so nothing was revoked either.
    expect(await readSession(token, new Date())).not.toBeNull();
    expect((await row(ids.target)).isActive).toBe(true);
  });

  it('writes NO second audit row when the account is ALREADY inactive', async () => {
    await asOwnerA().admin.staffUsers.setActive({ id: ids.target, isActive: false });
    expect(await auditFor('staff.deactivated', ids.target)).toHaveLength(1);

    /*
     * A session ROW against an already-inactive account — the only way to
     * see that the no-op revokes nothing, since the first call took the real
     * ones. Counted rather than read: `readSession` resolves an inactive
     * user's session to null regardless, so it could not tell a surviving
     * row from a deleted one here.
     */
    await createSession('user', ids.target, new Date());
    await asOwnerA().admin.staffUsers.setActive({ id: ids.target, isActive: false });

    expect(await auditFor('staff.deactivated', ids.target)).toHaveLength(1);
    expect(await sessionCount('user', ids.target)).toBe(1);
  });

  /** The refusals still come FIRST: a no-op is not a way around them. */
  it('still refuses to deactivate your own account, even though nothing would change', async () => {
    await expect(
      asOwnerA().admin.staffUsers.setActive({ id: ids.ownerA, isActive: false }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('still answers NOT_FOUND for an unknown id rather than succeeding as a no-op', async () => {
    await expect(
      asOwnerA().admin.staffUsers.setActive({ id: 2_000_000_000, isActive: true }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('keeps the other sessions when someone is reactivated', async () => {
    await getDb().update(users).set({ isActive: false }).where(eq(users.id, ids.target));
    await createSession('user', ids.target, new Date());
    await asOwnerA().admin.staffUsers.setActive({ id: ids.target, isActive: true });
    expect(await sessionCount('user', ids.target)).toBe(1);
  });

  it('on reset: replaces the password, owes a change, ends their sessions, audits without the password', async () => {
    const { token } = await createSession('user', ids.target, new Date());
    await createSession('user', ids.dispatcher, new Date());

    await asOwnerA().admin.staffUsers.resetPassword({ id: ids.target, tempPassword: TEMP });

    const after = await row(ids.target);
    expect(after.passwordHash).not.toBe(baselineHash);
    expect(after.mustChangePassword).toBe(true);
    expect(after.isActive).toBe(true);
    expect(await readSession(token, new Date())).toBeNull();
    expect(await sessionCount('user', ids.target)).toBe(0);
    expect(await sessionCount('user', ids.dispatcher)).toBe(1);

    const audit = await auditFor('staff.password_reset', ids.target);
    expect(audit).toHaveLength(1);
    expect(audit[0]!.data).toMatchObject({ sessionsRevoked: 1 });
    expectNoSecrets(audit);
  });

  it('on reset: the old password stops working and the temporary one signs in owing a change', async () => {
    await asOwnerA().admin.staffUsers.resetPassword({ id: ids.target, tempPassword: TEMP });
    const login = (password: string) =>
      api(testContext(null)).staffAuth.login({ email: FIXTURES.target.email, password });

    await expect(login(PASSWORD)).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    resetEmailThrottleForTests();
    await expect(login(TEMP)).resolves.toEqual({ role: 'dispatcher', mustChangePassword: true });
  });

  it('on a role change: audits from and to, and leaves the sessions alone', async () => {
    await createSession('user', ids.target, new Date());
    await asOwnerA().admin.staffUsers.update({
      id: ids.target,
      name: 'Fixture target',
      role: 'finance',
    });
    expect((await row(ids.target)).role).toBe('finance');
    expect(await sessionCount('user', ids.target)).toBe(1);
    const audit = await auditFor('staff.role_changed', ids.target);
    expect(audit).toHaveLength(1);
    expect(audit[0]!.data).toEqual({ from: 'dispatcher', to: 'finance' });
  });
});
