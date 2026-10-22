/**
 * Week 4 plan, Task 1: the session foundation.
 *
 * **Why this did not exist until now, and what that means for everything
 * above it.** `app.ts` mounted the tRPC middleware with no `createContext`,
 * so `ctx` was `{}` and `ctx.session` was always `undefined` — which means
 * every `adminProcedure` in the tree has been refusing everything since it
 * was written. That failed CLOSED, so nothing was broken by it, but it also
 * means no admin procedure has ever run with a real session. Treat each one
 * as unexercised until Task 5's role tests drive it.
 *
 * The token is the credential and only its SHA-256 is stored. Every test
 * below takes `now` as an explicit instant rather than reading the clock,
 * the same discipline `validateCoupon()` and `expireHolds()` follow: the
 * expiry boundary is then assertable to the millisecond instead of being
 * at the mercy of when the suite runs.
 *
 * Fixtures are committed and deleted by id in `afterEach` — the rows are
 * read back through the pool on a different connection in places, so an
 * uncommitted transaction would hide them.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash, randomBytes } from 'node:crypto';
import { eq, inArray } from 'drizzle-orm';
import { getDb, getPool } from '../db/client';
import { sessions, users } from '../db/schema';
import {
  createSession,
  deleteExpiredSessions,
  readSession,
  revokeSession,
} from '../services/sessions';
import { pruneSessions } from '../jobs/prune-sessions';
import { describeWithDb } from './helpers/db';

/** A fixed instant, so the expiry assertions are exact. */
const NOW = new Date('2026-10-13T04:00:00Z');

/** Subject ids this file invents. No `users`/`bookings` row needs to exist:
 * `sessions.subject_id` is polymorphic and carries no foreign key. */
const SUBJECT = { customer: 920_001, staff: 920_002, driver: 920_003 };

/** Well before `NOW` plus any session lifetime, so a session minted here is lapsed. */
const LONG_AGO = new Date(NOW.getTime() - 30 * 24 * 60 * 60 * 1000);

const SUBJECT_ID_BY_TYPE = {
  user: SUBJECT.staff,
  customer: SUBJECT.customer,
  driver: SUBJECT.driver,
} as const;

/**
 * Inserts a session that expires at exactly `expiresAt` and returns its id.
 * `createSession` cannot do this — the lifetime comes from the subject map
 * and there is deliberately no override — so the sweep's boundary is set up
 * with a direct row. The subject ids are this file's invented ones, so
 * `cleanup` removes these rows too.
 */
async function sessionExpiringAt(
  expiresAt: Date,
  subject: 'user' | 'customer' | 'driver' = 'driver',
): Promise<number> {
  const [row] = await getDb()
    .insert(sessions)
    .values({
      subjectType: subject,
      subjectId: SUBJECT_ID_BY_TYPE[subject],
      tokenHash: createHash('sha256').update(randomBytes(32)).digest('hex'),
      expiresAt,
      createdAt: LONG_AGO,
    });
  return row.insertId;
}

async function sessionRowById(id: number) {
  const [row] = await getDb().select().from(sessions).where(eq(sessions.id, id));
  return row;
}

async function sessionRowByToken(token: string) {
  const [row] = await getDb()
    .select()
    .from(sessions)
    .where(eq(sessions.tokenHash, createHash('sha256').update(token).digest('hex')));
  return row;
}

const staffIds: number[] = [];

/** A real `users` row, which a `user` session now requires to resolve. */
async function makeStaff(role: 'owner' | 'dispatcher' | 'finance') {
  const unique = `${Math.floor(Math.random() * 1e9)}_${Date.now()}`;
  const [row] = await getDb()
    .insert(users)
    .values({
      name: `Session Fixture ${unique}`,
      email: `session_${unique}@example.test`,
      // Not a real hash and not a real password: nothing here signs in.
      passwordHash: '__session_fixture_not_a_hash__',
      role,
      isActive: true,
    });
  staffIds.push(row.insertId);
  return row.insertId;
}

async function cleanup() {
  for (const id of staffIds) {
    await getPool().query('DELETE FROM sessions WHERE subject_type = ? AND subject_id = ?', [
      'user',
      id,
    ]);
    await getPool().query('DELETE FROM users WHERE id = ?', [id]);
  }
  staffIds.length = 0;
  await getPool().query('DELETE FROM sessions WHERE subject_id IN (?, ?, ?)', [
    SUBJECT.customer,
    SUBJECT.staff,
    SUBJECT.driver,
  ]);
}

describeWithDb('sessions', () => {
  afterEach(cleanup);

  /**
   * The property that makes a leaked database dump survivable: the stored
   * value cannot be replayed as a cookie. Asserted by computing the hash
   * here rather than by checking "it looks different" — a test that only
   * asserted inequality would pass against a reversible encoding.
   */
  it('stores only a SHA-256 of the token, never the token itself', async () => {
    const { token } = await createSession('customer', SUBJECT.customer, NOW);

    const [row] = await getDb()
      .select({ tokenHash: sessions.tokenHash })
      .from(sessions)
      .where(eq(sessions.subjectId, SUBJECT.customer));

    expect(row!.tokenHash).toBe(createHash('sha256').update(token).digest('hex'));
    expect(row!.tokenHash).not.toBe(token);
    expect(row!.tokenHash).toHaveLength(64);
  });

  it('resolves a live token to its subject type and id', async () => {
    const { token } = await createSession('customer', SUBJECT.customer, NOW);
    expect(await readSession(token, NOW)).toEqual({
      subjectType: 'customer',
      subjectId: SUBJECT.customer,
    });
  });

  /**
   * A `driver` or `customer` session resolves on the session row alone. A
   * `user` session does NOT — it is held to the extra conditions below, so
   * it needs a real `users` row to resolve at all.
   */
  it('keeps the three subject types apart', async () => {
    const driver = await createSession('driver', SUBJECT.driver, NOW);
    expect(await readSession(driver.token, NOW)).toEqual({
      subjectType: 'driver',
      subjectId: SUBJECT.driver,
    });

    const staffId = await makeStaff('owner');
    const staff = await createSession('user', staffId, NOW);
    expect(await readSession(staff.token, NOW)).toEqual({
      subjectType: 'user',
      subjectId: staffId,
      role: 'owner',
      mustChangePassword: false,
    });
  });

  /**
   * **A staff session carries the role, read LIVE from the row.** This is
   * what `requireRole` gates on, and resolving it here rather than copying
   * it into the session at login is what makes a demotion take effect on
   * the next request instead of at the end of a 24-hour session.
   */
  it('reflects a role CHANGE immediately, without a new login', async () => {
    const staffId = await makeStaff('dispatcher');
    const { token } = await createSession('user', staffId, NOW);
    expect((await readSession(token, NOW))?.role).toBe('dispatcher');

    await getDb().update(users).set({ role: 'finance' }).where(eq(users.id, staffId));

    expect(
      (await readSession(token, NOW))?.role,
      'the role was cached in the session — a demotion would not take effect',
    ).toBe('finance');
  });

  /**
   * **Deactivation signs a staff member out everywhere, at once.** The flag
   * exists so an account can be switched off without deleting history; if a
   * live session survived it, a dismissed employee would keep admin access
   * for up to a day. Fails closed, and silently — the caller gets the same
   * `null` as an expired token, because it cannot act on the difference.
   */
  it('REFUSES a staff session whose user has been deactivated', async () => {
    const staffId = await makeStaff('owner');
    const { token } = await createSession('user', staffId, NOW);
    expect(await readSession(token, NOW)).not.toBeNull();

    await getDb().update(users).set({ isActive: false }).where(eq(users.id, staffId));

    expect(
      await readSession(token, NOW),
      'a deactivated staff member kept a live admin session',
    ).toBeNull();
  });

  it('REFUSES a staff session whose user row no longer exists', async () => {
    const { token } = await createSession('user', 999_999_001, NOW);
    expect(await readSession(token, NOW)).toBeNull();
  });

  /**
   * Fails CLOSED at the boundary. One millisecond past `expires_at` is
   * expired — `>` and not `>=` — because a session that is valid *at* its
   * own expiry instant is a session whose stated lifetime is a lie, and
   * every other reader of a deadline in this codebase (`expireHolds`,
   * `startPayment`) treats the instant itself as lapsed.
   */
  it('REFUSES a token AT its expiry instant, and one millisecond past it', async () => {
    const { token, expiresAt } = await createSession('customer', SUBJECT.customer, NOW);

    expect(await readSession(token, new Date(expiresAt.getTime() - 1))).not.toBeNull();
    /*
     * The boundary instant ITSELF, which is the assertion that distinguishes
     * `gt` from `gte` — and the one this test was missing when it was first
     * written: a millisecond either side of the deadline passes against both
     * operators, so it pinned nothing. Caught by the mutation that swapped
     * them and stayed green.
     */
    expect(await readSession(token, expiresAt), 'valid AT its own expiry').toBeNull();
    expect(await readSession(token, new Date(expiresAt.getTime() + 1))).toBeNull();
  });

  /**
   * A live session has to exist for this to mean anything. Against an empty
   * table every implementation returns null, including one that ignores the
   * token entirely and hands back whatever row it finds first — which is
   * exactly the bug worth catching here, and the version of this test that
   * created no session could not see it. (Found by the mutation that
   * dropped the token filter and left this test green.)
   */
  it('REFUSES an unknown token, and never hands back someone else’s session', async () => {
    await createSession('customer', SUBJECT.customer, NOW);
    expect(await readSession('not-a-real-token', NOW)).toBeNull();
  });

  it('REFUSES a revoked token, and revoking is idempotent', async () => {
    const { token } = await createSession('customer', SUBJECT.customer, NOW);
    await revokeSession(token);
    expect(await readSession(token, NOW)).toBeNull();
    // Logging out twice is a thing browsers do. It must not throw.
    await expect(revokeSession(token)).resolves.toBeUndefined();
  });

  it('revokes exactly one session, never a sibling', async () => {
    const first = await createSession('customer', SUBJECT.customer, NOW);
    const second = await createSession('customer', SUBJECT.customer, NOW);
    await revokeSession(first.token);
    expect(await readSession(first.token, NOW)).toBeNull();
    expect(
      await readSession(second.token, NOW),
      'the other session was revoked too',
    ).not.toBeNull();
  });

  /**
   * 32 random bytes, base64url, so a token is unguessable and collision is
   * not a thing to reason about. The length assertion is what would catch
   * someone "simplifying" this to a timestamp or a counter — a guessable
   * session token is a login bypass.
   */
  it('mints 256 bits of entropy, and never the same token twice', async () => {
    const minted = new Set<string>();
    for (let i = 0; i < 20; i += 1) {
      const { token } = await createSession('customer', SUBJECT.customer, NOW);
      expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
      minted.add(token);
    }
    expect(minted.size).toBe(20);
  });

  it('expires a day out, counted from the instant it was given', async () => {
    const { expiresAt } = await createSession('customer', SUBJECT.customer, NOW);
    expect(expiresAt.getTime() - NOW.getTime()).toBe(24 * 60 * 60 * 1000);
  });

  it('writes nothing but the row it was asked for', async () => {
    await createSession('customer', SUBJECT.customer, NOW);
    const rows = await getDb()
      .select({ id: sessions.id })
      .from(sessions)
      .where(inArray(sessions.subjectId, [SUBJECT.customer, SUBJECT.staff, SUBJECT.driver]));
    expect(rows).toHaveLength(1);
  });

  /**
   * Task 10 (C3): the sweep. The table holds whatever earlier files left in
   * it, and these tests assert exact counts, so each starts from an empty
   * `sessions` table. That is safe here and only here: this is the test
   * database, files run serially (`fileParallelism: false`), and the
   * teardown empties the table at the end of every run anyway.
   */
  describe('the expiry sweep', () => {
    beforeEach(async () => {
      await getPool().query('DELETE FROM sessions');
    });

    it('deletes expired sessions and keeps live ones', async () => {
      const live = await createSession('driver', SUBJECT.driver, NOW);
      const expired = await createSession('driver', SUBJECT.driver, LONG_AGO);

      expect(await deleteExpiredSessions(NOW)).toBe(1);
      expect(await readSession(live.token, NOW)).not.toBeNull();
      expect(await sessionRowByToken(expired.token)).toBeUndefined();
    });

    it('is exact at the boundary: a session expiring at `now` is gone, one expiring a second later stays', async () => {
      // `readSession` refuses a session AT its expiry, so the sweep must agree
      // — a row the reader calls dead and the sweep calls live is a row that
      // lives forever.
      //
      // A SECOND later, not a millisecond: `expires_at` is a `DATETIME` with no
      // fractional seconds, so MySQL rounds `NOW + 1ms` back down to `NOW` and
      // that row would be (correctly) swept. One second is the smallest step the
      // column can tell apart.
      const atNow = await sessionExpiringAt(NOW);
      const aSecondLater = await sessionExpiringAt(new Date(NOW.getTime() + 1000));

      await deleteExpiredSessions(NOW);
      expect(await sessionRowById(atNow)).toBeUndefined();
      expect(await sessionRowById(aSecondLater)).toBeDefined();
    });

    it('sweeps every subject type, not only drivers', async () => {
      for (const subject of ['user', 'customer', 'driver'] as const) {
        await sessionExpiringAt(LONG_AGO, subject);
      }
      expect(await deleteExpiredSessions(NOW)).toBe(3);
    });

    it('is a no-op on a clean table and says nothing', async () => {
      const logged = vi.spyOn(console, 'log').mockImplementation(() => {});
      try {
        expect(await pruneSessions(NOW)).toEqual({ deleted: 0 });
        expect(logged).not.toHaveBeenCalled();
      } finally {
        logged.mockRestore();
      }
    });

    it('logs one line when it deleted something', async () => {
      await sessionExpiringAt(LONG_AGO);
      const logged = vi.spyOn(console, 'log').mockImplementation(() => {});
      try {
        expect(await pruneSessions(NOW)).toEqual({ deleted: 1 });
        expect(logged).toHaveBeenCalledTimes(1);
      } finally {
        logged.mockRestore();
      }
    });
  });
});
