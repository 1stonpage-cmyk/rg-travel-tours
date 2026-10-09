import { drizzle, type MySql2Database } from 'drizzle-orm/mysql2';
import mysql, { type Pool } from 'mysql2/promise';
import { env } from '../env';

/**
 * Lazy singleton pool + drizzle instance. Importing this module must never
 * open a connection — only getDb()/getPool() do, on first call. This keeps
 * the guard in ./guard.ts (which runs before anything is allowed to query)
 * meaningful: nothing here connects behind its back at import time.
 *
 * Task 1.2 adds server/src/db/schema.ts. Until then this stays untyped
 * (drizzle(pool) with no schema generic) rather than stubbing a fake schema
 * file just to satisfy the type parameter.
 */
let pool: Pool | undefined;
let db: MySql2Database | undefined;

export function getPool(): Pool {
  if (!pool) {
    pool = mysql.createPool({
      uri: env.DATABASE_URL,
      timezone: 'Z',
      connectionLimit: 10,
      supportBigNumbers: true,
    });
  }
  return pool;
}

export function getDb(): MySql2Database {
  if (!db) {
    db = drizzle(getPool(), { mode: 'default' });
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
