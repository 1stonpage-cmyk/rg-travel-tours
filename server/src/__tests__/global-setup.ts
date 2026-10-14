/**
 * Vitest `globalSetup` (task 1.4b). Runs once, before any test file loads,
 * in the same process Vitest sets `process.env.VITEST` in — which is what
 * `server/src/db/client.ts` branches on to resolve TEST_DATABASE_URL
 * instead of DATABASE_URL. In order:
 *
 *  1. Assert the live connection is actually `rg_travel_test` ('test'
 *     context) — never assume the env var is right, prove it with a real
 *     `SELECT DATABASE()` query. Aborts the whole run otherwise: a test
 *     suite silently running against `rg_travel` is the exact failure this
 *     task exists to prevent.
 *  2. Run the Drizzle migrations against that same connection — explicitly
 *     against TEST_DATABASE_URL, never relying on drizzle.config.ts (which
 *     always reads DATABASE_URL and has no notion of a test database).
 *  3. Seed it once with the canonical seed data, so every suite starts from
 *     the same baseline (`resetTestDb()` re-applies this between suites
 *     that need a clean slate).
 *  4. Record that baseline's row counts, and return a TEARDOWN that fails
 *     the run if the suite ends with more rows than it started with — see
 *     `LEAK_TABLES` below.
 *
 * Never logs DATABASE_URL, TEST_DATABASE_URL, or any password.
 */
import { fileURLToPath } from 'node:url';
import { sql } from 'drizzle-orm';
import { bookings, drivers, payments, users, vans } from '../db/schema';
import { migrate } from 'drizzle-orm/mysql2/migrator';
import { assertConnectedDatabase, assertDatabaseName, databaseNameFromUrl } from '../db/guard';
import { closeDb, getDb } from '../db/client';
import { env } from '../env';
import { seed } from '../db/seed';

const MIGRATIONS_FOLDER = fileURLToPath(new URL('../db/migrations', import.meta.url));

/**
 * The tables a leaked fixture row does the most damage in (owner
 * instruction, 2026-10-14).
 *
 * These are the ones other suites COUNT rather than look up by id, so one
 * stray row changes another file's answer instead of merely sitting there.
 * It is not a hypothetical: mutation-proving a role gate on
 * `admin.drivers.create` let a refused call succeed, which wrote one
 * untracked driver row — and that single row cascaded into 32 failures
 * across `capacity.test.ts` and others, whose whole job is counting free
 * vans and drivers. The 32 looked like the mutation's doing and were not.
 *
 * `audit_log` is deliberately absent: it is append-only by design, dozens
 * of tests write to it legitimately, and nothing counts it to make a
 * decision.
 */
const LEAK_TABLES = [
  ['bookings', bookings],
  ['drivers', drivers],
  ['vans', vans],
  ['payments', payments],
  ['users', users],
] as const;

/**
 * Counted AFTER seeding, never assumed to be zero.
 *
 * `seed('test')` populates this database, and Task 15 adds vans and drivers
 * to that seed — so a check asserting these tables are EMPTY would be wrong
 * today for `users` and wrong next week for the rest. The baseline is
 * whatever the seed produced; the assertion is that the suite gave it back
 * unchanged.
 */
async function countRows(): Promise<Record<string, number>> {
  const db = getDb();
  const counts: Record<string, number> = {};
  for (const [name, table] of LEAK_TABLES) {
    // The typed query builder, not `sql.raw` with an interpolated
    // identifier: no table name is ever assembled as a string here.
    const [row] = await db.select({ n: sql<number>`COUNT(*)` }).from(table);
    counts[name] = Number(row?.n ?? 0);
  }
  return counts;
}

export default async function setup(): Promise<() => Promise<void>> {
  if (!env.TEST_DATABASE_URL) {
    throw new Error(
      'TEST_DATABASE_URL is not set. The test suite refuses to run with no dedicated ' +
        'test database configured (see .env.example).',
    );
  }

  assertDatabaseName(databaseNameFromUrl(env.TEST_DATABASE_URL), 'test');
  await assertConnectedDatabase('test');

  await migrate(getDb(), { migrationsFolder: MIGRATIONS_FOLDER });
  await seed('test');

  const baseline = await countRows();
  await closeDb();

  /**
   * Fails the run when the suite ends holding rows it did not start with.
   *
   * Loudly and BY NAME: the message says which table, how many were
   * expected, how many are there, and what the surplus is — because the
   * symptom of a leak is never the leak itself. It is 32 unrelated failures
   * in files that count rows, several suites later, which is how an hour
   * gets spent reading the wrong diff.
   *
   * It compares against the post-seed baseline rather than zero, so it
   * stays correct when Task 15 adds vans and drivers to the seed.
   *
   * FEWER rows than the baseline is not failed here: suites legitimately
   * truncate and re-seed through `resetTestDb()`, and a deficit is that
   * working, not a leak.
   */
  return async function teardown(): Promise<void> {
    await assertConnectedDatabase('test');
    const after = await countRows();
    const leaks = LEAK_TABLES.map(([name]) => name)
      .filter((name) => (after[name] ?? 0) > (baseline[name] ?? 0))
      .map(
        (name) =>
          `${name}: expected ${baseline[name] ?? 0}, found ${after[name] ?? 0} (+${(after[name] ?? 0) - (baseline[name] ?? 0)})`,
      );
    await closeDb();

    if (leaks.length > 0) {
      throw new Error(
        'rg_travel_test has rows no test cleaned up:\n  ' +
          leaks.join('\n  ') +
          '\n\nEvery suite must remove what it created. If this appeared while ' +
          'mutation-proving a refusal test, that is expected: the mutation let a ' +
          'call that should have been refused SUCCEED, so it wrote rows the test ' +
          'never tracked for teardown. Delete them before trusting the next run — ' +
          'a stray row in these tables changes what other suites count.',
      );
    }
  };
}
