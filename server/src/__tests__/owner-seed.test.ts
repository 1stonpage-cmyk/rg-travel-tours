/**
 * Week 4 plan, Task 5 — the owner account the seed creates.
 *
 * The thing being protected against is a password in the repository: it
 * would be the real credential on the live site the day somebody forgot to
 * change it. So there is no default, no fallback, no "changeme", and these
 * tests assert the refusals rather than the happy path only.
 *
 * `upsertOwner` is not exported — it is a step inside `seed()` — so these
 * tests drive the same validation through the exported seed by setting the
 * environment the way a deployer would, which is also the only way to prove
 * the wiring is real rather than the helper being correct in isolation.
 */
import { afterEach, beforeEach, expect, it } from 'vitest';
import { eq, like } from 'drizzle-orm';
import { getDb } from '../db/client';
import { users } from '../db/schema';
import { env } from '../env';
import { seed } from '../db/seed';
import { verifyPassword } from '../services/password';
import { describeWithDb } from './helpers/db';

const EMAIL = `seeded_owner_${Math.floor(Math.random() * 1e9)}@example.test`;
const STRONG = 'a-long-enough-owner-password';

/**
 * `env` is a parsed object, so these tests write to it directly rather than
 * to `process.env` — which is already read and frozen into `env` by the
 * time any test runs. Restored after every test.
 */
const original = { email: env.OWNER_EMAIL, password: env.OWNER_PASSWORD };

beforeEach(() => {
  (env as { OWNER_EMAIL?: string }).OWNER_EMAIL = undefined;
  (env as { OWNER_PASSWORD?: string }).OWNER_PASSWORD = undefined;
});

afterEach(async () => {
  (env as { OWNER_EMAIL?: string }).OWNER_EMAIL = original.email;
  (env as { OWNER_PASSWORD?: string }).OWNER_PASSWORD = original.password;
  await getDb().delete(users).where(like(users.email, 'seeded_owner_%@example.test'));
});

describeWithDb('the owner seed', () => {
  it('creates an owner from OWNER_EMAIL and OWNER_PASSWORD', async () => {
    (env as { OWNER_EMAIL?: string }).OWNER_EMAIL = EMAIL;
    (env as { OWNER_PASSWORD?: string }).OWNER_PASSWORD = STRONG;

    await seed('test');

    const [row] = await getDb()
      .select({ role: users.role, isActive: users.isActive, hash: users.passwordHash })
      .from(users)
      .where(eq(users.email, EMAIL));

    expect(row, 'no owner row was created').toBeDefined();
    expect(row!.role).toBe('owner');
    expect(row!.isActive).toBe(true);
    // A hash of the configured password — and the password itself nowhere.
    expect(await verifyPassword(STRONG, row!.hash)).toBe(true);
    expect(row!.hash).not.toContain(STRONG);
  }, 60_000);

  /**
   * The step is SKIPPED when neither variable is set, rather than failing.
   * `pnpm test` seeds `rg_travel_test` on every run through `globalSetup`,
   * so a hard failure here would stop the entire suite instead of
   * protecting anything — and "no owner can sign in" is a loud, safe
   * failure that the launch checklist tells a deployer to fix.
   *
   * Proving this one able to fail is unusual: `globalSetup` seeds
   * `rg_travel_test` with `OWNER_*` unset on every run, so a mutation that
   * makes the skip path throw kills the seed and NO test in the suite runs
   * — which is how it was proved (the run dies with the seed's own error).
   * The assertion here is therefore a statement of the contract rather than
   * the only thing holding it.
   */
  it('skips quietly when NEITHER variable is set, so the suite can seed', async () => {
    await expect(seed('test')).resolves.toBeUndefined();
  }, 60_000);

  /**
   * But one without the other means the deployer is TRYING to seed an owner
   * and has got it half right — which must fail loudly rather than create
   * nothing and say it worked.
   */
  it('REFUSES an email with no password', async () => {
    (env as { OWNER_EMAIL?: string }).OWNER_EMAIL = EMAIL;
    await expect(seed('test')).rejects.toThrow(/OWNER_EMAIL and OWNER_PASSWORD must BOTH be set/);
  }, 60_000);

  it('REFUSES a password with no email', async () => {
    (env as { OWNER_PASSWORD?: string }).OWNER_PASSWORD = STRONG;
    await expect(seed('test')).rejects.toThrow(/OWNER_EMAIL and OWNER_PASSWORD must BOTH be set/);
  }, 60_000);

  /**
   * The length floor the owner specified. Eleven characters is refused and
   * twelve is accepted, so the boundary itself is pinned rather than
   * bracketed — the mistake this project keeps catching.
   */
  it('REFUSES a password under 12 characters, and accepts exactly 12', async () => {
    (env as { OWNER_EMAIL?: string }).OWNER_EMAIL = EMAIL;

    (env as { OWNER_PASSWORD?: string }).OWNER_PASSWORD = 'a'.repeat(11);
    await expect(seed('test')).rejects.toThrow(/at least 12 characters/);

    (env as { OWNER_PASSWORD?: string }).OWNER_PASSWORD = 'b'.repeat(12);
    await expect(seed('test')).resolves.toBeUndefined();
  }, 90_000);

  /** The refusal names the LENGTH, never the password. */
  it('never puts the password in the error it throws', async () => {
    // Five characters. The first version of this test used
    // 'short-secret', which is exactly TWELVE and therefore passed the
    // floor — the seed succeeded, nothing threw, and the assertion read a
    // property of `undefined`. A boundary fixture has to be on the right
    // side of the boundary.
    const secret = 'sh0rt';
    (env as { OWNER_EMAIL?: string }).OWNER_EMAIL = EMAIL;
    (env as { OWNER_PASSWORD?: string }).OWNER_PASSWORD = secret;

    const error = await seed('test').catch((e: unknown) => e);
    expect((error as Error).message).not.toContain(secret);
    expect((error as Error).message).toContain('12 characters');
  }, 60_000);

  /**
   * Re-running the seed resets the password from `.env` rather than
   * creating a second account or failing on the unique email. That is what
   * makes it a recovery path: an owner who has lost their password changes
   * `.env`, re-seeds, and signs in.
   */
  it('updates the existing owner on a second run, rather than duplicating', async () => {
    (env as { OWNER_EMAIL?: string }).OWNER_EMAIL = EMAIL;
    (env as { OWNER_PASSWORD?: string }).OWNER_PASSWORD = STRONG;
    await seed('test');

    const replacement = 'a-different-long-password';
    (env as { OWNER_PASSWORD?: string }).OWNER_PASSWORD = replacement;
    await seed('test');

    const rows = await getDb()
      .select({ hash: users.passwordHash })
      .from(users)
      .where(eq(users.email, EMAIL));

    expect(rows, 'a second owner row was created').toHaveLength(1);
    expect(await verifyPassword(replacement, rows[0]!.hash)).toBe(true);
    expect(await verifyPassword(STRONG, rows[0]!.hash), 'the old password still works').toBe(false);
  }, 120_000);
});
