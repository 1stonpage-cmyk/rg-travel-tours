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

/**
 * **`affectedRows` from this pool is the MATCHED count, not the changed
 * count.** mysql2 sets `CLIENT_FOUND_ROWS` in its default client flags, and
 * nothing below turns it off — so an `UPDATE` that writes a column the value
 * it already holds comes back as `affectedRows 1, changedRows 0`.
 *
 * MEASURED against `rg_travel_test` (Task 6 review, F4):
 *
 * ```
 * same-value UPDATE   affectedRows = 1   changedRows = 0
 * changing   UPDATE   affectedRows = 1   changedRows = 1
 * clientFlags & FOUND_ROWS = true
 * ```
 *
 * Two consequences, and the first has already been got wrong twice in this
 * codebase (Task 5's re-review stated the opposite as fact, and Task 6's
 * first pass believed it):
 *
 *  - **A conditional `UPDATE` CANNOT detect "the value was already what I
 *    was setting."** `affectedRows === 0` means the `WHERE` matched no row
 *    at all. If that distinction matters, read `changedRows` — or do not
 *    build the decision on it.
 *  - `affectedRows === 0` after `UPDATE … WHERE id = ? AND status = ?` is
 *    therefore an exact, race-free "the row is gone or its status moved",
 *    which is what makes the conditional status writes in
 *    `services/trips/checkins.ts` and `jobs/expire-holds.ts` sound.
 *
 * Drizzle passes the header through untouched, so this holds for every
 * `[header] = await tx.update(...)` in the tree.
 */
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

/**
 * A Drizzle transaction handle — the thing `db.transaction(async (tx) => …)`
 * hands its callback.
 *
 * Derived from `getDb()` rather than written out as `MySql2Transaction<…>`
 * so it cannot drift from the real database type when the schema or the
 * driver changes. A service that must write inside the caller's transaction
 * (see `services/audit.ts`) takes this type, never `getDb()`'s return value:
 * the difference is whether its row can survive a rollback.
 */
export type Transaction = Parameters<Parameters<ReturnType<typeof getDb>['transaction']>[0]>[0];

/**
 * The pool-backed Drizzle instance `getDb()` returns.
 *
 * Exists so a read-only service can accept **either** handle —
 * `db: Database | Transaction = getDb()` — and be callable both from a
 * router (on the pool) and from inside a transaction that already holds a
 * connection. That second case is not a nicety: the pool is
 * `connectionLimit: 10` with mysql2's default unbounded, untimed queue, so a
 * function that grabs its own connection while its caller's transaction
 * holds one deadlocks the POOL once enough requests do it at the same time —
 * nothing releases and nothing times out. See `validateCoupon` in
 * `services/coupons.ts`, the first service to take this.
 */
export type Database = ReturnType<typeof getDb>;

export async function closeDb(): Promise<void> {
  if (!pool) return;
  const current = pool;
  pool = undefined;
  db = undefined;
  await current.end();
}
