/**
 * Proves `assertNoPreExistingUsers()` — the check `global-setup.ts`'s
 * `setup()` runs between `migrate()` and `seedTestBaseline()` to catch a
 * stray `users` row left by a previous run BEFORE it gets silently folded
 * into this run's leak-detector baseline (see that function's own comment
 * for the full story and the four "Reset Fixture"/"Reset Inactive Fixture"
 * rows that motivated it, found and deleted 2026-11-09).
 *
 * This test calls the exact function `setup()` calls — imported from
 * `global-setup.ts` itself, not a copy — so a change to one is a change to
 * both.
 *
 * It queries and writes the SHARED `rg_travel_test.users` table directly,
 * which other suites/processes may also be touching. It is therefore
 * surgical: it asserts the live row count is exactly what it expects before
 * drawing any conclusion, inserts and deletes by exact id, and cleans up in
 * a `finally` in the SAME test rather than relying on `afterAll` — this test
 * is specifically about what a stray row does, and must not itself become a
 * new instance of the problem it is testing.
 */
import { afterAll, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { assertNoPreExistingUsers } from './global-setup';
import { getDb } from '../db/client';
import { env } from '../env';
import { users } from '../db/schema';
import { hashPassword } from '../services/password';
import { describeWithDb } from './helpers/db';

const MARKER_EMAIL = `global-setup-guard-fixture-${Date.now()}@example.test`;
const OWNER_EXCEPTION_EMAIL = `global-setup-guard-owner-exception-${Date.now()}@example.test`;

describeWithDb('assertNoPreExistingUsers', () => {
  // Belt-and-suspenders: if a concurrent process leaves this row behind
  // despite the in-test cleanup (e.g. the test itself is killed), a later
  // run of this same file will still remove it by its unique marker email.
  afterAll(async () => {
    await getDb().delete(users).where(eq(users.email, MARKER_EMAIL));
  });

  it('does NOT throw when users is empty', async () => {
    const before = await getDb().select({ id: users.id }).from(users);
    expect(
      before,
      'users was not empty going into this assertion — a concurrent process may ' +
        'be seeding/leaking rows right now; re-run this file alone to confirm ' +
        'before treating this as a real failure',
    ).toHaveLength(0);

    await expect(assertNoPreExistingUsers()).resolves.toBeUndefined();
  });

  it('THROWS, naming the table and the row, when a stray user exists', async () => {
    const hash = await hashPassword('throwaway-fixture-password-123456');
    const [inserted] = await getDb().insert(users).values({
      name: 'Global Setup Guard Fixture',
      email: MARKER_EMAIL,
      passwordHash: hash,
      role: 'owner',
    });
    const insertedId = inserted.insertId;

    try {
      await expect(assertNoPreExistingUsers()).rejects.toThrow(
        /users has \d+ row\(s\) before this run/,
      );
      await expect(assertNoPreExistingUsers()).rejects.toThrow(MARKER_EMAIL);
    } finally {
      await getDb().delete(users).where(eq(users.id, insertedId));
    }

    // Proven gone, in this same test, rather than merely trusted.
    const remaining = await getDb()
      .select({ id: users.id })
      .from(users)
      .where(eq(users.id, insertedId));
    expect(remaining).toHaveLength(0);
  });

  /**
   * Review fix (2026-11-09): the OWNER_EMAIL exception must also require
   * `role === 'owner'` and `isActive === true` — matching on email alone
   * would let a stray row with that email and ANY shape through silently,
   * which is exactly the "Reset Fixture" shape (`role: 'owner'`, but an
   * unrelated test fixture, not a real owner) this whole check exists to
   * catch. These two tests mutate the shared `env` object directly (it is
   * a plain parsed object, not frozen) and restore it in `finally` —
   * nothing else in this process reads `env.OWNER_EMAIL` between the
   * mutation and the restore, since this test is synchronous end to end.
   */
  it('does NOT let a row through on email match alone when its role is not owner', async () => {
    const originalOwnerEmail = env.OWNER_EMAIL;
    const hash = await hashPassword('throwaway-fixture-password-123456');
    const [inserted] = await getDb().insert(users).values({
      name: 'Owner-Email Collision, Wrong Role',
      email: OWNER_EXCEPTION_EMAIL,
      passwordHash: hash,
      role: 'dispatcher',
    });
    const insertedId = inserted.insertId;

    try {
      env.OWNER_EMAIL = OWNER_EXCEPTION_EMAIL;
      await expect(assertNoPreExistingUsers()).rejects.toThrow(
        /users has \d+ row\(s\) before this run/,
      );
    } finally {
      env.OWNER_EMAIL = originalOwnerEmail;
      await getDb().delete(users).where(eq(users.id, insertedId));
    }
  });

  it('lets exactly one row through when it matches OWNER_EMAIL, role owner, and is active', async () => {
    const originalOwnerEmail = env.OWNER_EMAIL;
    const hash = await hashPassword('throwaway-fixture-password-123456');
    const [inserted] = await getDb().insert(users).values({
      name: 'Legitimate Re-seeded Owner',
      email: OWNER_EXCEPTION_EMAIL,
      passwordHash: hash,
      role: 'owner',
      isActive: true,
    });
    const insertedId = inserted.insertId;

    try {
      env.OWNER_EMAIL = OWNER_EXCEPTION_EMAIL;
      await expect(assertNoPreExistingUsers()).resolves.toBeUndefined();
    } finally {
      env.OWNER_EMAIL = originalOwnerEmail;
      await getDb().delete(users).where(eq(users.id, insertedId));
    }
  });
});
