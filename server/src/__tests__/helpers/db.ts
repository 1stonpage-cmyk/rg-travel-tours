import { describe } from 'vitest';
import { type AnyColumn, inArray } from 'drizzle-orm';
import type { MySqlTable } from 'drizzle-orm/mysql-core';
import { getDb, getPool } from '../../db/client';

let reachable: boolean | null = null;

async function probe(): Promise<boolean> {
  if (reachable !== null) return reachable;
  try {
    await getPool().query('SELECT 1');
    reachable = true;
  } catch {
    console.warn(
      '\n[tests] MySQL is unreachable — skipping DB-backed suites. ' +
        'Start MySQL and re-run to exercise them.\n',
    );
    reachable = false;
  }
  return reachable;
}

export function describeWithDb(name: string, fn: () => void) {
  describe(name, async () => {
    if (!(await probe())) {
      describe.skip(name, fn);
      return;
    }
    fn();
  });
}

/**
 * Snapshot-and-restore for DB-backed tests whose fixtures share a primary
 * key namespace with real data — this repo has no separate test database,
 * so a fixture keyed e.g. `settings.key = 'trust'` collides with a seeded
 * row of the same key once one exists (tasks 1.4+).
 *
 * Call before inserting fixtures for `pkValues`: it reads back whatever
 * rows already exist for those keys and deletes them, so the table starts
 * empty for those keys regardless of whether it was seeded. Call the
 * returned `restore()` in `afterEach` (unconditionally, so it still runs on
 * a failed assertion): it deletes the fixtures and puts the original rows
 * back verbatim — or leaves the keys absent if there was nothing there to
 * begin with. Never truncates; touches only the rows named by `pkValues`,
 * on the same connection `getDb()` hands to production code, so fixtures
 * written here are visible to whatever is under test.
 */
export async function snapshotRows<Row extends Record<string, unknown>>(
  table: MySqlTable,
  pkColumn: AnyColumn,
  pkValues: ReadonlyArray<string | number>,
): Promise<{ restore: () => Promise<void> }> {
  const db = getDb();
  if (pkValues.length === 0) {
    return { restore: async () => {} };
  }

  const existing = (await db
    .select()
    .from(table)
    .where(inArray(pkColumn, pkValues as (string | number)[]))) as Row[];

  await db.delete(table).where(inArray(pkColumn, pkValues as (string | number)[]));

  return {
    async restore() {
      await db.delete(table).where(inArray(pkColumn, pkValues as (string | number)[]));
      if (existing.length > 0) {
        await db.insert(table).values(existing as never[]);
      }
    },
  };
}
