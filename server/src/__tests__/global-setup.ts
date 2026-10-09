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
 *
 * Never logs DATABASE_URL, TEST_DATABASE_URL, or any password.
 */
import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/mysql2/migrator';
import { assertConnectedDatabase, assertDatabaseName, databaseNameFromUrl } from '../db/guard';
import { closeDb, getDb } from '../db/client';
import { env } from '../env';
import { seed } from '../db/seed';

const MIGRATIONS_FOLDER = fileURLToPath(new URL('../db/migrations', import.meta.url));

export default async function setup(): Promise<void> {
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

  await closeDb();
}
