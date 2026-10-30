/**
 * Week 6 plan, Task 1 — the driver session.
 *
 * Three things are under test here, and only the first is new logic:
 *
 *  1. `attemptDriverLogin` — the database, the transaction and the LOCK
 *     that Week 4's pure `evaluatePinAttempt()` was written to wait for.
 *     Every test below is a security property rather than a shape: no
 *     enumeration by text, no enumeration by timing, a boundary at five and
 *     not four, a terminal flag only an admin clears, and a counter two
 *     simultaneous attempts cannot make stand still.
 *  2. `SESSION_TTL_MS_BY_SUBJECT` — §8's 12-hour driver session, asserted
 *     at the boundary instant, alongside proof that staff still get 24.
 *  3. `driverProcedure` — that it refuses a staff session and a customer
 *     session, not merely "no session".
 *
 * **The carry-forward from Week 5 is `'signs in immediately after an admin
 * PIN reset'`.** Week 5 could not write it: `admin.drivers.resetPin` existed
 * and `evaluatePinAttempt` existed, but there was no login endpoint between
 * them, so that week proved the policy and the credential separately and
 * said so. This is the composition — the thing a dispatcher actually needs
 * at 5am when a driver has locked themselves out in the car park.
 *
 * Hashing costs ~250ms and 128MB (scrypt, N=2^17), so every test here is
 * given an explicit timeout and fixtures are not shared where a test
 * mutates the row's counters — a driver per test, deleted in teardown,
 * because `global-setup.ts` fails the whole run by name if `drivers` ends
 * with rows nobody cleaned up.
 *
 * No PIN, hash, token or cookie value is printed, logged, or put in a test
 * name anywhere in this file; `'never puts a PIN in an audit row'` asserts
 * the same of `audit_log`.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import request from 'supertest';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { and, asc, eq, inArray } from 'drizzle-orm';
import { DRIVER_SESSION_HOURS } from '@rg/shared';
import { createApp } from '../app';
import { appRouter } from '../routers/_app';
import { getDb, getPool } from '../db/client';
import { auditLog, drivers, sessions, users } from '../db/schema';
import * as driverAuthService from '../services/driver-auth';
import { attemptDriverLogin } from '../services/driver-auth';
import { LOCKOUT_SCHEDULE_MINUTES, MAX_FAILED_ATTEMPTS } from '../services/driver-lockout';
import { hashPassword } from '../services/password';
import { SESSION_TTL_MS_BY_SUBJECT, createSession, readSession } from '../services/sessions';
import { SESSION_COOKIE_BY_SUBJECT } from '../middleware/session-cookie';
import { driverProcedure, router } from '../trpc';
import { captureResponse, customerContext, staffContext, testContext } from './helpers/ctx';
import { describeWithDb } from './helpers/db';

/** Every decision in this file is made against this instant, never the clock. */
const NOW = new Date('2026-10-15T04:00:00Z');
const HOUR_MS = 3_600_000;
/** Measured scrypt cost here is ~230-250ms; the old early return was ~5ms. */
const MIN_HASH_MS = 80;

const unique = () => `${Math.floor(Math.random() * 1e9)}_${Date.now()}`;

/** Every id this file committed, so teardown removes exactly those rows. */
const created = {
  driverIds: [] as number[],
  userIds: [] as number[],
};

let ownerId = 0;

/**
 * A driver who can actually sign in: a unique code and a random six-digit
 * PIN, hashed through the same helper `admin.drivers.resetPin` uses.
 *
 * The PIN is RANDOM rather than a constant, so no test can accidentally
 * pass by matching a literal that also appears in the source.
 */
async function makeDriverWithPin() {
  const suffix = unique();
  const code = `DA${suffix}`.slice(0, 20);
  const pin = String(Math.floor(Math.random() * 1_000_000)).padStart(6, '0');
  const [row] = await getDb()
    .insert(drivers)
    .values({
      name: `Driver Auth Fixture ${suffix}`,
      code,
      phone: '09170000000',
      pinHash: await hashPassword(pin),
      isActive: true,
    });
  created.driverIds.push(row.insertId);
  return { code, pin, driverId: row.insertId };
}

/**
 * A deactivated driver who still has a real PIN hash. The hash is the point:
 * the inactive path must pay a REAL verification, so a fixture with a
 * placeholder hash would make the timing test pass for the wrong reason.
 */
async function makeInactiveDriverWithPin() {
  const made = await makeDriverWithPin();
  await getDb().update(drivers).set({ isActive: false }).where(eq(drivers.id, made.driverId));
  return made;
}

async function makeStaff(role: 'owner' = 'owner') {
  const suffix = unique();
  const [row] = await getDb()
    .insert(users)
    .values({
      name: `Driver Auth Admin ${suffix}`,
      email: `drvauth_${suffix}@example.test`,
      passwordHash: '__driver_auth_fixture_not_a_hash__',
      role,
      isActive: true,
    });
  created.userIds.push(row.insertId);
  return row.insertId;
}

/**
 * The lockout columns, as the policy sees them.
 *
 * `requires_admin_unlock` is no longer among them (owner decision 2026-10-23):
 * the column still exists, and nothing — this file included — reads it to
 * decide anything.
 */
async function driverRow(driverId: number) {
  const [row] = await getDb()
    .select({
      failedAttempts: drivers.failedAttempts,
      lockedUntil: drivers.lockedUntil,
      lockoutCount: drivers.lockoutCount,
      lockoutWindowStartedAt: drivers.lockoutWindowStartedAt,
    })
    .from(drivers)
    .where(eq(drivers.id, driverId));
  if (!row) throw new Error(`no driver ${driverId}`);
  return row;
}

/** The first tier of the backoff schedule — a FIRST lockout's length. */
const FIRST_LOCKOUT_MINUTES = LOCKOUT_SCHEDULE_MINUTES[0];

/** Puts a driver into a live FIRST lockout (15 minutes), counted from `now`. */
async function lockOut(driverId: number, now: Date) {
  await getDb()
    .update(drivers)
    .set({
      failedAttempts: MAX_FAILED_ATTEMPTS,
      lockedUntil: new Date(now.getTime() + FIRST_LOCKOUT_MINUTES * 60_000),
      lockoutCount: 1,
      lockoutWindowStartedAt: now,
    })
    .where(eq(drivers.id, driverId));
}

/**
 * Every audit row against one driver, oldest first — `data` included,
 * because the whole point of the PIN test is that the column is clean and a
 * test that never fetched it could never see it fail.
 */
async function auditRowsFor(entity: string, entityId: number) {
  return getDb()
    .select({
      action: auditLog.action,
      actorType: auditLog.actorType,
      actorId: auditLog.actorId,
      data: auditLog.data,
    })
    .from(auditLog)
    .where(and(eq(auditLog.entity, entity), eq(auditLog.entityId, entityId)))
    .orderBy(asc(auditLog.id));
}

beforeAll(async () => {
  ownerId = await makeStaff('owner');
}, 60_000);

afterAll(async () => {
  const db = getDb();
  const pool = getPool();
  if (created.driverIds.length > 0) {
    await db
      .delete(auditLog)
      .where(and(eq(auditLog.entity, 'driver'), inArray(auditLog.entityId, created.driverIds)));
    await db
      .delete(sessions)
      .where(
        and(eq(sessions.subjectType, 'driver'), inArray(sessions.subjectId, created.driverIds)),
      );
    await db.delete(drivers).where(inArray(drivers.id, created.driverIds));
  }
  for (const id of created.userIds) {
    await pool.query('DELETE FROM sessions WHERE subject_type = ? AND subject_id = ?', [
      'user',
      id,
    ]);
    await pool.query('DELETE FROM users WHERE id = ?', [id]);
  }
});

describeWithDb('attemptDriverLogin', () => {
  it('signs in with the right code and PIN, and mints a driver session', async () => {
    const { code, pin, driverId } = await makeDriverWithPin();
    const result = await attemptDriverLogin({ code, pin, now: NOW });
    expect(result).toMatchObject({ ok: true, driver: { id: driverId, code } });

    const [session] = await getDb()
      .select({ subjectType: sessions.subjectType, subjectId: sessions.subjectId })
      .from(sessions)
      .where(and(eq(sessions.subjectType, 'driver'), eq(sessions.subjectId, driverId)));
    expect(session).toEqual({ subjectType: 'driver', subjectId: driverId });
  }, 30_000);

  it('answers IDENTICALLY for a wrong code and a wrong PIN', async () => {
    const { code, pin } = await makeDriverWithPin();
    // A wrong PIN that cannot collide with the random right one.
    const wrongPinValue = pin === '000000' ? '111111' : '000000';
    const wrongPin = await attemptDriverLogin({ code, pin: wrongPinValue, now: NOW });
    const wrongCode = await attemptDriverLogin({
      code: `NOPE${unique()}`.slice(0, 20),
      pin: '123456',
      now: NOW,
    });
    // Deeply equal, like §7's booking lookup: a difference here tells an
    // attacker which half they got right.
    expect(wrongPin).toEqual(wrongCode);
    expect(wrongPin).toEqual({ ok: false, reason: 'wrong_credentials' });
  }, 30_000);

  /**
   * **No enumeration by TIME either**, which is the half a generic refusal
   * does not fix. A locked account must do the same scrypt work as an
   * unlocked one, or it answers in ~1ms where the other takes ~250ms and
   * the response time alone says "this code is real and currently locked".
   *
   * A RATIO, not an absolute bound: the machine's speed is irrelevant and
   * an absolute threshold would be flaky on a loaded box. The gap a skipped
   * hash opens is ~250x, so `/4` catches it by a wide margin — the same
   * shape as `staff-auth.test.ts`'s unknown-email timing test.
   */
  it('takes a comparable amount of time when the driver is LOCKED', async () => {
    const live = await makeDriverWithPin();
    const locked = await makeDriverWithPin();
    await lockOut(locked.driverId, NOW);

    // Warm up: the first scrypt call in a process pays for the dummy
    // hash's own construction, which would otherwise skew the first
    // measurement upward and make this test pass for the wrong reason.
    await attemptDriverLogin({ code: live.code, pin: '000000', now: NOW });

    const unlockedStart = Date.now();
    await attemptDriverLogin({ code: live.code, pin: '000000', now: NOW });
    const unlocked = Date.now() - unlockedStart;

    const lockedStart = Date.now();
    await attemptDriverLogin({ code: locked.code, pin: locked.pin, now: NOW });
    const lockedMs = Date.now() - lockedStart;

    expect(
      lockedMs,
      'the locked path skipped the PIN hash — response time now says which codes are locked',
    ).toBeGreaterThan(unlocked / 4);
  }, 60_000);

  it('locks the driver out after exactly five consecutive failures, not four', async () => {
    const { code, driverId } = await makeDriverWithPin();
    for (let i = 0; i < MAX_FAILED_ATTEMPTS - 1; i += 1) {
      expect(await attemptDriverLogin({ code, pin: '000000', now: NOW })).toMatchObject({
        reason: 'wrong_credentials',
      });
    }
    // The FOURTH failure must not lock: the boundary is the point.
    expect((await driverRow(driverId)).lockedUntil).toBeNull();
    expect((await driverRow(driverId)).failedAttempts).toBe(MAX_FAILED_ATTEMPTS - 1);

    expect(await attemptDriverLogin({ code, pin: '000000', now: NOW })).toMatchObject({
      reason: 'locked',
    });
    expect((await driverRow(driverId)).lockedUntil).not.toBeNull();
  }, 60_000);

  it('refuses a CORRECT PIN while the lockout is live', async () => {
    const { code, pin, driverId } = await makeDriverWithPin();
    await lockOut(driverId, NOW);
    expect(await attemptDriverLogin({ code, pin, now: NOW })).toMatchObject({
      reason: 'locked',
    });
  }, 30_000);

  it('lets a correct PIN in once the fifteen minutes have passed', async () => {
    const { code, pin, driverId } = await makeDriverWithPin();
    await lockOut(driverId, NOW);
    const after = new Date(NOW.getTime() + FIRST_LOCKOUT_MINUTES * 60_000 + 1_000);
    expect(await attemptDriverLogin({ code, pin, now: after })).toMatchObject({ ok: true });
  }, 30_000);

  /**
   * REPLACES `'needs an admin after three lockouts in twenty-four hours, and a
   * correct PIN does NOT clear it'` (owner decision 2026-10-23, Q1). That test
   * staged `requires_admin_unlock = true` with three banked lockouts and
   * asserted a correct PIN was still refused with `'needs_admin_unlock'`.
   * There is no such refusal any more, and a correct PIN after the lockout
   * lapses is now exactly what gets a driver in — whatever their count says.
   *
   * Staged the same way (counters written directly), so this still proves the
   * login path reads the row rather than only the policy: three lockouts
   * banked today, and a dead `requires_admin_unlock = 1` left behind by a
   * login from before the deploy. The flag must change nothing.
   */
  it('lets a driver with three banked lockouts in, once the lockout has lapsed', async () => {
    const { code, pin, driverId } = await makeDriverWithPin();
    await getDb()
      .update(drivers)
      .set({
        failedAttempts: MAX_FAILED_ATTEMPTS,
        lockedUntil: new Date(NOW.getTime() + 60 * 60_000),
        lockoutCount: 3,
        lockoutWindowStartedAt: NOW,
        // The retired column, deliberately left SET: a row written by the old
        // policy must not be able to refuse anyone.
        requiresAdminUnlock: true,
      })
      .where(eq(drivers.id, driverId));

    // Still inside the hour: refused, and refused as an ordinary lockout.
    expect(await attemptDriverLogin({ code, pin, now: NOW })).toEqual({
      ok: false,
      reason: 'locked',
    });

    // The hour passes. No admin, no new PIN.
    const after = new Date(NOW.getTime() + 60 * 60_000 + 1_000);
    expect(await attemptDriverLogin({ code, pin, now: after })).toMatchObject({ ok: true });

    const row = await driverRow(driverId);
    expect(row.lockedUntil).toBeNull();
    expect(row.failedAttempts).toBe(0);
    // Three lockouts in a day are still three lockouts in a day.
    expect(row.lockoutCount).toBe(3);
  }, 60_000);

  /**
   * THE CARRY-FORWARD from Week 5, which could not be written then because
   * there was no login endpoint: a driver locked out of the portal can sign
   * in IMMEDIATELY after an admin resets their PIN. Week 5 proved the policy
   * function and the credential; this proves the thing a dispatcher actually
   * needs at 5am.
   *
   * CHANGED 2026-10-23: the staged state no longer sets the retired
   * `requires_admin_unlock` flag or reaches for a now-deleted escalation
   * constant. What it proves is unchanged.
   */
  it('signs in immediately after an admin PIN reset, with no waiting', async () => {
    const { code, driverId } = await makeDriverWithPin();
    await getDb()
      .update(drivers)
      .set({
        failedAttempts: MAX_FAILED_ATTEMPTS,
        lockedUntil: new Date(NOW.getTime() + FIRST_LOCKOUT_MINUTES * 60_000),
        lockoutCount: 3,
      })
      .where(eq(drivers.id, driverId));

    const api = appRouter.createCaller(staffContext(ownerId, 'owner') as never);
    const { pin: newPin } = await api.admin.drivers.resetPin({ id: driverId });

    // Same instant — no timer, no window, no second attempt.
    expect(await attemptDriverLogin({ code, pin: newPin, now: NOW })).toMatchObject({
      ok: true,
    });
  }, 60_000);

  /**
   * The new cure (owner decision 2026-10-23, Q1): the office lifts the lockout
   * and the driver signs in with **the PIN they already know**. The whole
   * point of `unlock` existing beside `resetPin` is that nobody has to read a
   * new six-digit number down a phone line at 5am, so the assertion that
   * matters is that the ORIGINAL pin works immediately afterwards.
   */
  it('signs in immediately after an admin UNLOCK, with the SAME PIN', async () => {
    const { code, pin, driverId } = await makeDriverWithPin();
    /*
     * The REAL clock, uniquely in this file. `admin.drivers.unlock` reads
     * `new Date()` at the request boundary — as `admin.dashboard.alerts` does,
     * and as it must, since its input is `{ id }` and a client that could send
     * a time could ask for a lockout to be judged against yesterday. So the
     * lockout this stages has to be live NOW rather than live at this file's
     * fixed `NOW`, which is nine days in the past.
     */
    const realNow = new Date();
    await lockOut(driverId, realNow);
    expect(await attemptDriverLogin({ code, pin, now: realNow })).toMatchObject({
      reason: 'locked',
    });

    const api = appRouter.createCaller(staffContext(ownerId, 'owner') as never);
    await api.admin.drivers.unlock({ id: driverId });

    // Same instant, same PIN, no waiting.
    expect(await attemptDriverLogin({ code, pin, now: realNow })).toMatchObject({ ok: true });
  }, 60_000);

  it('counts two simultaneous wrong PINs as TWO failures', async () => {
    // Without FOR UPDATE both read 0, both write 1, and the fifth and sixth
    // failures count as one — so the lockout never fires.
    const { code, driverId } = await makeDriverWithPin();
    const settled = await Promise.allSettled([
      attemptDriverLogin({ code, pin: '000000', now: NOW }),
      attemptDriverLogin({ code, pin: '111111', now: NOW }),
    ]);
    // Both calls must have actually resolved to an answer — a lock-wait
    // timeout on either one would otherwise look identical to a missing
    // lock: the counter would read something other than 2 either way, and
    // the failure would point at the counter instead of at the wait.
    expect(settled[0]!.status, 'the first concurrent attempt did not settle').toBe('fulfilled');
    expect(settled[1]!.status, 'the second concurrent attempt did not settle').toBe('fulfilled');
    expect((await driverRow(driverId)).failedAttempts).toBe(2);
  }, 60_000);

  /*
   * REWRITTEN (owner decision D3, 2026-10-16). This test used to be 'refuses
   * a soft-deleted driver' and asserted `reason: 'driver_inactive'`: a
   * distinct, early refusal. That is the decision the owner reversed, so it
   * now asserts the opposite: an inactive driver is answered exactly as a
   * wrong PIN is, and still costs the (departed) driver's counters nothing.
   */
  it('answers an inactive driver EXACTLY as it answers a wrong PIN', async () => {
    const active = await makeDriverWithPin();
    const inactive = await makeInactiveDriverWithPin();
    const wrong = await attemptDriverLogin({ code: active.code, pin: '000000', now: NOW });
    const gone = await attemptDriverLogin({ code: inactive.code, pin: inactive.pin, now: NOW });

    // Deep equality on the whole object, not just the reason: a field present
    // in one and absent in the other is the same oracle in another shape.
    expect(gone).toEqual(wrong);
    expect(gone).toEqual({ ok: false, reason: 'wrong_credentials' });
  }, 30_000);

  it('answers an inactive driver with the CORRECT pin the same way as with a wrong one', async () => {
    // The case that matters: an attacker who knows the PIN must not be able
    // to tell "deactivated" from "wrong PIN".
    const { code, pin } = await makeInactiveDriverWithPin();
    const wrongPin = pin === '000000' ? '111111' : '000000';
    const wrongPinOnInactive = await attemptDriverLogin({ code, pin: wrongPin, now: NOW });
    const rightPinOnInactive = await attemptDriverLogin({ code, pin, now: NOW });
    expect(rightPinOnInactive).toEqual(wrongPinOnInactive);
    expect(rightPinOnInactive).toEqual({ ok: false, reason: 'wrong_credentials' });
  }, 30_000);

  it('never mints a session for an inactive driver, however right the PIN', async () => {
    const { code, pin, driverId } = await makeInactiveDriverWithPin();
    await attemptDriverLogin({ code, pin, now: NOW });
    const rows = await getDb()
      .select({ id: sessions.id })
      .from(sessions)
      .where(and(eq(sessions.subjectType, 'driver'), eq(sessions.subjectId, driverId)));
    expect(rows, 'an inactive driver was handed a session').toHaveLength(0);
  }, 30_000);

  /**
   * The oracle in TIME. Before D3 an inactive code answered in ~5ms and a
   * wrong PIN in ~250ms. Both must now actually hash. The floor is well under
   * the measured cost (so a slow box cannot fail it for being slow) and far
   * above the ~5ms early return this exists to forbid.
   */
  it('pays the hash on the inactive path, so the timing does not answer either', async () => {
    const active = await makeDriverWithPin();
    const inactive = await makeInactiveDriverWithPin();
    const time = async (code: string, pin: string) => {
      const started = performance.now();
      await attemptDriverLogin({ code, pin, now: NOW });
      return performance.now() - started;
    };
    // Warm-up: the first scrypt call in a process pays one-off costs that
    // would otherwise land on whichever path is measured first.
    await time(active.code, '000000');

    const wrong = await time(active.code, '000000');
    const gone = await time(inactive.code, inactive.pin);

    expect(wrong, 'a wrong PIN did not pay for a hash').toBeGreaterThan(MIN_HASH_MS);
    expect(
      gone,
      'the inactive path skipped the hash: its response time says it is inactive',
    ).toBeGreaterThan(MIN_HASH_MS);
    // Comparable. A generous band: scrypt dominates both, so what differs is
    // one UPDATE (active) against one audit INSERT (inactive).
    expect(Math.abs(gone - wrong)).toBeLessThan(wrong);
  }, 60_000);

  it('records the REAL reason in audit_log, where only staff can read it', async () => {
    const { code, pin, driverId } = await makeInactiveDriverWithPin();
    await attemptDriverLogin({ code, pin, now: NOW });

    const rows = await auditRowsFor('driver', driverId);
    const row = rows.find((r) => r.action === 'driver.login_inactive');
    expect(row, 'the inactive attempt left no audit row').toBeDefined();
    expect(row!.actorType).toBe('driver');
    expect(row!.actorId).toBe(driverId);
    expect(row!.data).toEqual({ code, pinCorrect: true });
    // Never the PIN. (Asserted on the PIN's own value rather than on "six
    // digits": a driver code can itself contain a run of digits.)
    expect(JSON.stringify(row!.data)).not.toContain(pin);
  }, 30_000);

  it('records pinCorrect: false when the departed driver guessed wrong', async () => {
    const { code, pin, driverId } = await makeInactiveDriverWithPin();
    await attemptDriverLogin({ code, pin: pin === '000000' ? '111111' : '000000', now: NOW });
    const row = (await auditRowsFor('driver', driverId)).find(
      (r) => r.action === 'driver.login_inactive',
    );
    expect(row!.data).toEqual({ code, pinCorrect: false });
  }, 30_000);

  it('does not touch the inactive driver lockout counters', async () => {
    const { code, driverId } = await makeInactiveDriverWithPin();
    const before = await driverRow(driverId);
    for (let i = 0; i < MAX_FAILED_ATTEMPTS + 1; i += 1) {
      const result = await attemptDriverLogin({ code, pin: '000000', now: NOW });
      // Still the wrong-credentials answer on the sixth: never `locked`.
      expect(result).toEqual({ ok: false, reason: 'wrong_credentials' });
    }
    const after = await driverRow(driverId);
    // A driver who left the company must not be able to lock out the code a
    // new hire might later be given.
    expect(after).toEqual(before);
  }, 60_000);

  it('leaves no way to send driver_inactive over the wire', () => {
    // The type-level half of this is `pnpm typecheck`; this is the runtime
    // half, over the whole module's source.
    const source = readFileSync(resolve(__dirname, '../services/driver-auth.ts'), 'utf8');
    expect(source).not.toMatch(/reason:\s*'driver_inactive'/);
  });

  it('writes an audit row for a lockout, naming the driver as the actor', async () => {
    const { code, driverId } = await makeDriverWithPin();
    for (let i = 0; i < MAX_FAILED_ATTEMPTS; i += 1) {
      await attemptDriverLogin({ code, pin: '000000', now: NOW });
    }
    const rows = await auditRowsFor('driver', driverId);
    const lockout = rows.find((r) => r.action === 'driver.locked_out');
    expect(lockout).toBeDefined();
    expect(lockout!.actorType).toBe('driver');
    expect(lockout!.actorId).toBe(driverId);
    // The four ordinary wrong PINs are NOT audit events — one fat-fingered
    // digit buried in the log is how a real lockout becomes unreadable.
    expect(rows).toHaveLength(1);
  }, 60_000);

  it('never puts a PIN in an audit row', async () => {
    const { code, pin, driverId } = await makeDriverWithPin();
    // A PIN that cannot collide with the random right one, and that is
    // distinctive enough for a substring search to mean something.
    const attempted = pin === '424242' ? '353535' : '424242';
    for (let i = 0; i < MAX_FAILED_ATTEMPTS; i += 1) {
      await attemptDriverLogin({ code, pin: attempted, now: NOW });
    }
    const after = new Date(NOW.getTime() + FIRST_LOCKOUT_MINUTES * 60_000 + 1_000);
    expect(await attemptDriverLogin({ code, pin, now: after })).toMatchObject({ ok: true });

    const rows = await auditRowsFor('driver', driverId);
    // Not vacuous: there IS something in the log to inspect.
    expect(rows.length).toBeGreaterThan(0);
    const json = JSON.stringify(rows);
    expect(json).not.toContain(attempted);
    expect(json).not.toContain(pin);
  }, 60_000);
});

/* ------------------------------------------------------------------ *
 * `driver.login` / `driver.logout` — the resolvers, not the service
 * (follow-up to Task 1's review, finding 1). `attemptDriverLogin` above is
 * proven on its own; what is missing is proof that the resolver DOES
 * something sane with the answer — mirrors `admin-auth.test.ts`'s
 * `staffAuth.login` / `staffAuth.logout` tests, same helpers.
 * ------------------------------------------------------------------ */

describeWithDb('driver.login / driver.logout (resolvers)', () => {
  it('sets the session cookie on success, expiring at the exact instant the service minted', async () => {
    const { code, pin, driverId } = await makeDriverWithPin();
    const { res, set } = captureResponse();
    const api = appRouter.createCaller({
      req: { cookies: {} },
      res,
      driverSession: null,
    } as never);

    /*
     * A spy, not a mock — `attemptDriverLogin` runs for real, and this just
     * observes its return value so the comparison is against the actual
     * in-memory `expiresAt` the resolver had in hand, not a value re-read
     * from `sessions.expires_at`. That column is `datetime` with no
     * fractional seconds, so MySQL rounds a stored value to the nearest
     * whole second on write — fine for the TTL itself, but it would make a
     * same-MILLISECOND assertion pass or fail on rounding noise rather than
     * on what the resolver actually did with the value.
     */
    const spy = vi.spyOn(driverAuthService, 'attemptDriverLogin');

    await expect(api.driver.login({ code, pin })).resolves.toMatchObject({
      driver: { id: driverId, code },
    });

    expect(set).toHaveLength(1);
    expect(set[0]!.name).toBe(SESSION_COOKIE_BY_SUBJECT.driver);
    expect(set[0]!.options.httpOnly).toBe(true);

    expect(spy).toHaveBeenCalledTimes(1);
    const serviceResult = await spy.mock.results[0]!.value;
    expect(serviceResult.ok).toBe(true);

    // THE regression this guards: the cookie's expiry must be the EXACT
    // `expiresAt` the service minted, not a second instant separately
    // computed by the resolver (e.g. `new Date(Date.now() + 12h)`) —
    // same millisecond, not merely "close".
    const cookieExpires = set[0]!.options.expires as Date;
    expect(cookieExpires.getTime()).toBe(
      (serviceResult as { expiresAt: Date }).expiresAt.getTime(),
    );

    spy.mockRestore();
  }, 30_000);

  it('sets no cookie when the login is refused', async () => {
    const { code } = await makeDriverWithPin();
    const { res, set } = captureResponse();
    const api = appRouter.createCaller({
      req: { cookies: {} },
      res,
      driverSession: null,
    } as never);

    await expect(api.driver.login({ code, pin: '000000' })).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    });

    expect(set, 'a refused driver login handed out a cookie').toHaveLength(0);
  }, 30_000);

  /**
   * The HTTP layer, through `createApp()`: status AND the serialised body,
   * character for character, between a wrong PIN on a live code and the
   * RIGHT PIN on a deactivated one. This is the wire-level proof; the
   * service-level tests above prove only the returned object.
   */
  it('is byte-identical on the wire: inactive driver with the right PIN vs a wrong PIN', async () => {
    const active = await makeDriverWithPin();
    const inactive = await makeInactiveDriverWithPin();
    const app = createApp();
    const post = (code: string, pin: string) =>
      request(app)
        .post('/trpc/driver.login')
        // A browser's Origin: the CSRF check runs ahead of the router.
        .set('Origin', 'http://localhost:5180')
        .send({ code, pin });

    const wrong = await post(active.code, active.pin === '000000' ? '111111' : '000000');
    const gone = await post(inactive.code, inactive.pin);

    expect(wrong.status).toBe(401);
    expect(gone.status).toBe(wrong.status);
    // Same bytes, not merely the same parsed object.
    expect(gone.text).toBe(wrong.text);
    expect(gone.text).toContain('wrong_credentials');
    expect(gone.headers['set-cookie']).toBeUndefined();
    expect(wrong.headers['set-cookie']).toBeUndefined();
  }, 30_000);

  it('logout revokes the session ROW, so a later readSession on that token is null', async () => {
    const { driverId } = await makeDriverWithPin();
    const { token } = await createSession('driver', driverId, NOW);
    const { res } = captureResponse();
    const api = appRouter.createCaller({
      req: { cookies: { [SESSION_COOKIE_BY_SUBJECT.driver]: token } },
      res,
      driverSession: { subjectType: 'driver', subjectId: driverId },
    } as never);

    await expect(api.driver.logout()).resolves.toEqual({ ok: true });
    expect(await readSession(token, NOW)).toBeNull();
  }, 30_000);
});

/* ------------------------------------------------------------------ *
 * §8's 12-hour session (owner decision 2026-10-15, Q1)
 * ------------------------------------------------------------------ */

describeWithDb('the per-subject session TTL', () => {
  it('expires a DRIVER session at exactly twelve hours', async () => {
    const { driverId } = await makeDriverWithPin();
    const { token } = await createSession('driver', driverId, NOW);
    const justInside = new Date(NOW.getTime() + 12 * HOUR_MS - 1_000);
    const justOutside = new Date(NOW.getTime() + 12 * HOUR_MS + 1_000);
    expect(await readSession(token, justInside)).not.toBeNull();
    expect(await readSession(token, justOutside)).toBeNull();
  }, 30_000);

  it('expires a STAFF session at exactly twenty-four hours, unchanged', async () => {
    const userId = await makeStaff('owner');
    const { token } = await createSession('user', userId, NOW);
    const justInside = new Date(NOW.getTime() + 24 * HOUR_MS - 1_000);
    const justOutside = new Date(NOW.getTime() + 24 * HOUR_MS + 1_000);
    expect(await readSession(token, justInside)).not.toBeNull();
    expect(await readSession(token, justOutside)).toBeNull();
  }, 30_000);

  it('keeps the three TTLs independent', () => {
    // A single shared constant reintroduced later fails here, which is the
    // only thing standing between "drivers get 12 hours" and "everyone does".
    expect(SESSION_TTL_MS_BY_SUBJECT.driver).toBe(12 * HOUR_MS);
    expect(SESSION_TTL_MS_BY_SUBJECT.user).toBe(24 * HOUR_MS);
    expect(SESSION_TTL_MS_BY_SUBJECT.customer).toBe(24 * HOUR_MS);
    expect(SESSION_TTL_MS_BY_SUBJECT.user).not.toBe(SESSION_TTL_MS_BY_SUBJECT.driver);
  });

  /**
   * The client says "12 hours" in its own copy from `DRIVER_SESSION_HOURS`
   * (it cannot import from `server/`), so the two have to agree or the
   * portal promises a window it does not give.
   */
  it('agrees with the number the client is allowed to say out loud', () => {
    expect(SESSION_TTL_MS_BY_SUBJECT.driver).toBe(DRIVER_SESSION_HOURS * HOUR_MS);
  });
});

/* ------------------------------------------------------------------ *
 * `driverProcedure` — the gate, not the label
 * ------------------------------------------------------------------ */

/**
 * A test-local router, exactly as `procedure-role-metadata.test.ts` uses
 * `weekFiveShaped`: nothing is mounted, and Task 1 deliberately ships no
 * driver-GATED procedure on `appRouter` (see `driverProcedure`'s note in
 * `../trpc.ts`). The gate is still a real gate, and this is what proves it.
 */
const driverShaped = router({
  mine: driverProcedure.query(({ ctx }) => ({ driverId: ctx.driver.driverId })),
});

const callMine = (ctx: unknown) => driverShaped.createCaller(ctx as never).mine();

it('admits a driver session and hands the resolver that driver id', async () => {
  await expect(callMine(testContext({ subjectType: 'driver', subjectId: 42 }))).resolves.toEqual({
    driverId: 42,
  });
});

it('refuses a caller with no session at all', async () => {
  await expect(callMine({})).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  await expect(callMine(testContext(null))).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
});

/**
 * **The assertion that makes `driverProcedure` more than "some session
 * exists".** A driver's day sheet carries other guests' names and phone
 * numbers; a signed-in dispatcher or a signed-in guest reaching it would be
 * an RA 10173 disclosure with a 200 status code.
 */
it('refuses a STAFF session, however senior', async () => {
  await expect(callMine(staffContext(7, 'owner'))).rejects.toMatchObject({
    code: 'UNAUTHORIZED',
  });
  await expect(callMine(staffContext(7, 'dispatcher'))).rejects.toMatchObject({
    code: 'UNAUTHORIZED',
  });
});

it('refuses a CUSTOMER session', async () => {
  await expect(callMine(customerContext(99))).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
});

/**
 * A `driver` subject type is not enough on its own: the id has to be a real
 * integer. It cannot happen today (`subject_id` is NOT NULL and
 * `readSession` only returns a number) and it fails closed if either ever
 * stops being true, rather than letting a `NaN` reach a `WHERE driver_id = ?`.
 */
it('refuses a driver session with no usable id', async () => {
  await expect(
    callMine({ driverSession: { subjectType: 'driver', subjectId: 'seven' } }),
  ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  await expect(
    callMine({ driverSession: { subjectType: 'driver', subjectId: 1.5 } }),
  ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
});

it('stamps the driver access kind into the procedure metadata', () => {
  const procedures = (
    driverShaped as unknown as {
      _def: { procedures: Record<string, { _def: { meta?: unknown } }> };
    }
  )._def.procedures;
  expect(procedures['mine']?._def.meta).toEqual({ access: 'driver' });
});
