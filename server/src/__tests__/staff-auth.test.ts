/**
 * Week 4 plan, Task 5 — staff credential verification.
 *
 * Every test here is a security property from the owner's own list, and
 * each one fails in a way that would be a real vulnerability rather than a
 * wrong message: no user enumeration by text OR by timing, deactivated
 * accounts refused, non-admin roles refused, and a per-email throttle so an
 * attacker cannot spread guesses for one account across many addresses.
 *
 * Hashing costs ~250ms, so fixtures are hashed once in `beforeAll` and
 * every test reuses them.
 */
import { afterAll, afterEach, beforeAll, expect, it } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import { getDb, getPool } from '../db/client';
import { users } from '../db/schema';
import { hashPassword } from '../services/password';
import {
  STAFF_LOGIN_MAX_PER_EMAIL,
  STAFF_LOGIN_WINDOW_MS,
  resetEmailThrottleForTests,
  verifyStaffPassword,
} from '../services/staff-auth';
import { describeWithDb } from './helpers/db';

const NOW = new Date('2026-10-14T04:00:00Z');
const PASSWORD = 'a-strong-owner-password';
const WRONG = 'not-the-password';

const suffix = `${Math.floor(Math.random() * 1e9)}`;
const EMAIL = {
  owner: `owner_${suffix}@example.test`,
  finance: `finance_${suffix}@example.test`,
  inactive: `inactive_${suffix}@example.test`,
  mixedCase: `Mixed_${suffix}@Example.test`,
};

const createdIds: number[] = [];
let hashed: string;

beforeAll(async () => {
  hashed = await hashPassword(PASSWORD);
  const db = getDb();
  for (const [key, email] of Object.entries(EMAIL)) {
    const [row] = await db.insert(users).values({
      name: `Staff ${key}`,
      email,
      passwordHash: hashed,
      role: key === 'finance' ? 'finance' : 'owner',
      isActive: key !== 'inactive',
    });
    createdIds.push(row.insertId);
  }
}, 60_000);

afterEach(() => resetEmailThrottleForTests());

describeWithDb('verifyStaffPassword', () => {
  it('accepts the right password and reports the role', async () => {
    expect(await verifyStaffPassword(EMAIL.owner, PASSWORD, NOW)).toEqual({
      userId: createdIds[0],
      role: 'owner',
    });
    expect((await verifyStaffPassword(EMAIL.finance, PASSWORD, NOW))?.role).toBe('finance');
  });

  it('matches the email case-insensitively', async () => {
    expect(await verifyStaffPassword(EMAIL.mixedCase.toLowerCase(), PASSWORD, NOW)).not.toBeNull();
    expect(await verifyStaffPassword(EMAIL.mixedCase.toUpperCase(), PASSWORD, NOW)).not.toBeNull();
  });

  /**
   * No enumeration by TEXT: both wrongs are the same `null`, with no reason
   * attached that a caller could forward.
   */
  it('returns the same null for an unknown email and a wrong password', async () => {
    expect(await verifyStaffPassword(EMAIL.owner, WRONG, NOW)).toBeNull();
    expect(await verifyStaffPassword(`nobody_${suffix}@example.test`, PASSWORD, NOW)).toBeNull();
  });

  /**
   * **No enumeration by TIME**, which is the half a generic message does not
   * fix. An unknown email must do the same scrypt work as a real one.
   *
   * A ratio, not an absolute bound: the machine's speed is irrelevant, and
   * an absolute threshold would be flaky on a loaded CI box. What matters is
   * that the two paths are comparable — a skipped hash is ~1ms against
   * ~250ms, which this catches by a wide margin.
   */
  it('takes a comparable amount of time for an unknown email', async () => {
    const realStart = Date.now();
    await verifyStaffPassword(EMAIL.owner, WRONG, NOW);
    const real = Date.now() - realStart;
    resetEmailThrottleForTests();

    const unknownStart = Date.now();
    await verifyStaffPassword(`ghost_${suffix}@example.test`, WRONG, NOW);
    const unknown = Date.now() - unknownStart;

    expect(
      unknown,
      'the unknown-email path skipped the hash — it leaks which accounts exist',
    ).toBeGreaterThan(real / 4);
  });

  /** A former employee must not even be able to confirm their password still works. */
  it('REFUSES a deactivated user, however right the password', async () => {
    expect(await verifyStaffPassword(EMAIL.inactive, PASSWORD, NOW)).toBeNull();
  });

  /**
   * **The role cannot be a non-admin role, and the DATABASE is what
   * guarantees it.** `users.role` is a MySQL `ENUM` of `ADMIN_ROLES` only,
   * so a raw `UPDATE users SET role = 'customer'` is refused by the server
   * itself with "Data truncated" — which is what this test asserts, because
   * it is the protection that actually exists.
   *
   * `verifyStaffPassword` also re-checks the role against `ADMIN_ROLES`.
   * That check is belt-and-braces and, as of today, **unreachable** — no
   * row can reach it with a bad role. It stays because the enum is a schema
   * fact rather than a contract (a future migration widening the column
   * would silently remove the only guarantee), and because `requireRole`
   * applies the same "never trusted as typed" rule one layer up. But it
   * cannot be proven load-bearing, and claiming otherwise would be the kind
   * of test this project keeps catching.
   *
   * Written with raw SQL on purpose: the application types cannot express
   * this row, so only a seed script, a migration or a hand-written UPDATE
   * could ever attempt it — and this is what happens when they do.
   */
  it('cannot be given a non-admin role: the enum refuses the row', async () => {
    const [row] = await getDb()
      .insert(users)
      .values({
        name: 'Not staff',
        email: `rogue_${suffix}@example.test`,
        passwordHash: hashed,
        role: 'owner',
        isActive: true,
      });
    createdIds.push(row.insertId);

    await expect(
      getPool().query('UPDATE users SET role = ? WHERE id = ?', ['customer', row.insertId]),
    ).rejects.toThrow(/truncated|invalid/i);

    // And the row is untouched, so the account is still exactly what it was.
    const [after] = await getDb()
      .select({ role: users.role })
      .from(users)
      .where(eq(users.id, row.insertId));
    expect(after!.role).toBe('owner');
  });

  it('never returns or echoes the password', async () => {
    const result = await verifyStaffPassword(EMAIL.owner, PASSWORD, NOW);
    expect(JSON.stringify(result)).not.toContain(PASSWORD);
    expect(Object.keys(result!)).toEqual(['userId', 'role']);
  });

  it('stores a hash, never the password', async () => {
    const [row] = await getDb()
      .select({ hash: users.passwordHash })
      .from(users)
      .where(eq(users.id, createdIds[0]!));
    expect(row!.hash).not.toContain(PASSWORD);
    expect(row!.hash.startsWith('scrypt$')).toBe(true);
  });
});

describeWithDb('the per-email throttle', () => {
  it('refuses after five failures for that email, even with the right password', async () => {
    for (let i = 0; i < STAFF_LOGIN_MAX_PER_EMAIL; i += 1) {
      expect(await verifyStaffPassword(EMAIL.owner, WRONG, NOW)).toBeNull();
    }
    expect(
      await verifyStaffPassword(EMAIL.owner, PASSWORD, NOW),
      'the throttle did not hold — a sixth guess was allowed',
    ).toBeNull();
  });

  /**
   * The throttle is per EMAIL, so it is the thing that stops an attacker
   * spreading guesses for one account across many IPs — which the per-IP
   * limiter cannot see. The converse also matters: one account being
   * throttled must not lock out a colleague.
   */
  it('throttles one email without touching another', async () => {
    for (let i = 0; i < STAFF_LOGIN_MAX_PER_EMAIL; i += 1) {
      await verifyStaffPassword(EMAIL.owner, WRONG, NOW);
    }
    expect(await verifyStaffPassword(EMAIL.owner, PASSWORD, NOW)).toBeNull();
    expect(
      await verifyStaffPassword(EMAIL.finance, PASSWORD, NOW),
      'throttling one account locked out another',
    ).not.toBeNull();
  });

  it('counts a case-different email as the same email', async () => {
    for (let i = 0; i < STAFF_LOGIN_MAX_PER_EMAIL; i += 1) {
      await verifyStaffPassword(EMAIL.owner.toUpperCase(), WRONG, NOW);
    }
    expect(
      await verifyStaffPassword(EMAIL.owner, PASSWORD, NOW),
      'the throttle was dodged by changing the case of the email',
    ).toBeNull();
  });

  it('forgives once the window has passed', async () => {
    for (let i = 0; i < STAFF_LOGIN_MAX_PER_EMAIL; i += 1) {
      await verifyStaffPassword(EMAIL.owner, WRONG, NOW);
    }
    const later = new Date(NOW.getTime() + STAFF_LOGIN_WINDOW_MS + 1);
    expect(await verifyStaffPassword(EMAIL.owner, PASSWORD, later)).not.toBeNull();
  });

  it('clears the count on a success, so a typo is not held against you', async () => {
    await verifyStaffPassword(EMAIL.owner, WRONG, NOW);
    await verifyStaffPassword(EMAIL.owner, WRONG, NOW);
    expect(await verifyStaffPassword(EMAIL.owner, PASSWORD, NOW)).not.toBeNull();

    // Five more failures should now be needed, not three.
    for (let i = 0; i < STAFF_LOGIN_MAX_PER_EMAIL - 1; i += 1) {
      await verifyStaffPassword(EMAIL.owner, WRONG, NOW);
    }
    expect(await verifyStaffPassword(EMAIL.owner, PASSWORD, NOW)).not.toBeNull();
  });
});

// Fixtures are committed, so they are removed by id.
afterAll(async () => {
  if (createdIds.length > 0) {
    await getDb().delete(users).where(inArray(users.id, createdIds));
  }
});
