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
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { assertNoPreExistingUsers } from './global-setup';
import { getDb } from '../db/client';
import { env } from '../env';
import { passwordResetTokens, sessions, users } from '../db/schema';
import { hashPassword } from '../services/password';
import { describeWithDb } from './helpers/db';

const MARKER_EMAIL = `global-setup-guard-fixture-${Date.now()}@example.test`;
const OWNER_EXCEPTION_EMAIL = `global-setup-guard-owner-exception-${Date.now()}@example.test`;
/** Mimics password-reset.test.ts's own `suffix` — digits only. */
const DEBRIS_SUFFIX = `${Date.now()}`;

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

  /**
   * 0A (2026-11-09, second recurrence of the "Reset Fixture"/"Reset
   * Inactive Fixture" leak — see HANDOVER-7). `password-reset.test.ts`'s own
   * `afterAll` is the only thing that ever cleans these two rows up; if that
   * file's worker is killed before its `afterAll` runs (the observed
   * failure shape — every OTHER suite's cleanup ran fine in both
   * incidents), the rows sit in `rg_travel_test.users` and fail every
   * subsequent run at this exact check, requiring a human to find and
   * delete them by hand. These tests prove the self-heal added for that
   * shape — and only that shape.
   */
  describe('password-reset.test.ts fixture debris self-heal', () => {
    let warnSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    });

    afterEach(() => {
      warnSpy.mockRestore();
    });

    it('deletes an exact "Reset Fixture" row (and its dependent reset token), logs a warning, and does not throw', async () => {
      const email = `reset_active_${DEBRIS_SUFFIX}@example.test`;
      const hash = await hashPassword('throwaway-fixture-password-123456');
      const [inserted] = await getDb().insert(users).values({
        name: 'Reset Fixture',
        email,
        passwordHash: hash,
        role: 'owner',
      });
      const insertedId = inserted.insertId;
      // A dependent row, same as a real interrupted run would leave behind —
      // proves the delete order is FK-safe (password_reset_tokens.user_id
      // is a real, RESTRICT foreign key; deleting the user first would fail).
      await getDb()
        .insert(passwordResetTokens)
        .values({
          userId: insertedId,
          tokenHash: `a${DEBRIS_SUFFIX}${'a'.repeat(64 - 1 - DEBRIS_SUFFIX.length)}`,
          expiresAt: new Date(Date.now() + 60_000),
        });

      try {
        // The function under test IS the cleanup here — that's what is being
        // proven. The `finally` below is a safety net only, so a regression
        // in the self-heal fails this assertion without also leaking the
        // fixture row into the shared test database for the leak detector
        // to catch on a DIFFERENT file's run.
        await expect(assertNoPreExistingUsers()).resolves.toBeUndefined();

        const remainingUser = await getDb()
          .select({ id: users.id })
          .from(users)
          .where(eq(users.id, insertedId));
        expect(remainingUser).toHaveLength(0);

        const remainingToken = await getDb()
          .select({ id: passwordResetTokens.id })
          .from(passwordResetTokens)
          .where(eq(passwordResetTokens.userId, insertedId));
        expect(remainingToken).toHaveLength(0);

        expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('deleting 1 row(s)'));
        expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining(email));
      } finally {
        await getDb().delete(passwordResetTokens).where(eq(passwordResetTokens.userId, insertedId));
        await getDb().delete(users).where(eq(users.id, insertedId));
      }
    });

    it('self-heals the "Reset Inactive Fixture" / finance-role row too, without deleting an unrelated session of the same subject id', async () => {
      const email = `reset_gone_${DEBRIS_SUFFIX}@example.test`;
      const hash = await hashPassword('throwaway-fixture-password-123456');
      const [inserted] = await getDb().insert(users).values({
        name: 'Reset Inactive Fixture',
        email,
        passwordHash: hash,
        role: 'finance',
        isActive: false,
      });
      const insertedId = inserted.insertId;
      // A session for a DIFFERENT subject type that happens to share this
      // numeric id — proves the delete filters on subjectType, not id alone.
      await getDb()
        .insert(sessions)
        .values({
          subjectType: 'driver',
          subjectId: insertedId,
          tokenHash: `b${DEBRIS_SUFFIX}${'b'.repeat(64 - 1 - DEBRIS_SUFFIX.length)}`,
          expiresAt: new Date(Date.now() + 60_000),
        });

      try {
        await expect(assertNoPreExistingUsers()).resolves.toBeUndefined();

        const remainingUser = await getDb()
          .select({ id: users.id })
          .from(users)
          .where(eq(users.id, insertedId));
        expect(remainingUser).toHaveLength(0);

        const driverSessionSurvived = await getDb()
          .select({ id: sessions.id })
          .from(sessions)
          .where(and(eq(sessions.subjectType, 'driver'), eq(sessions.subjectId, insertedId)));
        expect(driverSessionSurvived).toHaveLength(1);
      } finally {
        await getDb()
          .delete(sessions)
          .where(and(eq(sessions.subjectType, 'driver'), eq(sessions.subjectId, insertedId)));
        await getDb().delete(users).where(eq(users.id, insertedId));
      }
    });

    it('does NOT self-heal a near-miss — right name and role, email does not match the fixture pattern', async () => {
      const email = `not-a-reset-fixture-email-${DEBRIS_SUFFIX}@example.test`;
      const hash = await hashPassword('throwaway-fixture-password-123456');
      const [inserted] = await getDb().insert(users).values({
        name: 'Reset Fixture',
        email,
        passwordHash: hash,
        role: 'owner',
      });
      const insertedId = inserted.insertId;

      try {
        await expect(assertNoPreExistingUsers()).rejects.toThrow(
          /users has \d+ row\(s\) before this run/,
        );
      } finally {
        await getDb().delete(users).where(eq(users.id, insertedId));
      }
    });

    it('does NOT self-heal a near-miss — right name and email pattern, role is not owner or finance', async () => {
      const email = `reset_active_${DEBRIS_SUFFIX}9@example.test`;
      const hash = await hashPassword('throwaway-fixture-password-123456');
      const [inserted] = await getDb().insert(users).values({
        name: 'Reset Fixture',
        email,
        passwordHash: hash,
        role: 'dispatcher',
      });
      const insertedId = inserted.insertId;

      try {
        await expect(assertNoPreExistingUsers()).rejects.toThrow(
          /users has \d+ row\(s\) before this run/,
        );
      } finally {
        await getDb().delete(users).where(eq(users.id, insertedId));
      }
    });
  });
});
