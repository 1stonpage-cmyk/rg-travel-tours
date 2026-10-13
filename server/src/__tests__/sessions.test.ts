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
import { afterEach, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { eq, inArray } from 'drizzle-orm';
import { getDb, getPool } from '../db/client';
import { sessions } from '../db/schema';
import { createSession, readSession, revokeSession } from '../services/sessions';
import { describeWithDb } from './helpers/db';

/** A fixed instant, so the expiry assertions are exact. */
const NOW = new Date('2026-10-13T04:00:00Z');

/** Subject ids this file invents. No `users`/`bookings` row needs to exist:
 * `sessions.subject_id` is polymorphic and carries no foreign key. */
const SUBJECT = { customer: 920_001, staff: 920_002, driver: 920_003 };

async function cleanup() {
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

  it('keeps the three subject types apart', async () => {
    const staff = await createSession('user', SUBJECT.staff, NOW);
    const driver = await createSession('driver', SUBJECT.driver, NOW);
    expect(await readSession(staff.token, NOW)).toEqual({
      subjectType: 'user',
      subjectId: SUBJECT.staff,
    });
    expect(await readSession(driver.token, NOW)).toEqual({
      subjectType: 'driver',
      subjectId: SUBJECT.driver,
    });
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
});
