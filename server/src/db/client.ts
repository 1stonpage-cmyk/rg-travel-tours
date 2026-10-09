import { drizzle, type MySql2Database } from 'drizzle-orm/mysql2';
import mysql, { type Pool } from 'mysql2/promise';
import { env } from '../env';
import * as schema from './schema';

/**
 * Lazy singleton pool + drizzle instance. Importing this module must never
 * open a connection — only getDb()/getPool() do, on first call. This keeps
 * the guard in ./guard.ts (which runs before anything is allowed to query)
 * meaningful: nothing here connects behind its back at import time.
 */
let pool: Pool | undefined;
let db: MySql2Database<typeof schema> | undefined;

/**
 * Task 1.4b: under Vitest (`process.env.VITEST`, set by Vitest itself for
 * every process it runs, including globalSetup) every connection goes to
 * TEST_DATABASE_URL (`rg_travel_test`) instead of DATABASE_URL (`rg_travel`).
 * This is the only place that branches on VITEST — guard.ts separately
 * verifies whichever database this resolves to is actually the right one
 * for the caller's context ('app' | 'test'), so a misconfigured env var
 * still aborts loudly instead of silently connecting to the wrong database.
 */
function resolveDatabaseUrl(): string {
  if (process.env.VITEST) {
    if (!env.TEST_DATABASE_URL) {
      throw new Error('TEST_DATABASE_URL is not set — required to run tests.');
    }
    return env.TEST_DATABASE_URL;
  }
  return env.DATABASE_URL;
}

export function getPool(): Pool {
  if (!pool) {
    pool = mysql.createPool({
      uri: resolveDatabaseUrl(),
      timezone: 'Z',
      connectionLimit: 10,
      supportBigNumbers: true,
    });
  }
  return pool;
}

export function getDb(): MySql2Database<typeof schema> {
  if (!db) {
    db = drizzle(getPool(), { schema, mode: 'default' });
  }
  return db;
}

export async function closeDb(): Promise<void> {
  if (!pool) return;
  const current = pool;
  pool = undefined;
  db = undefined;
  await current.end();
}
