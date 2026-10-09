/**
 * Resets the test database (rg_travel_test — never rg_travel, enforced at
 * the connection layer by server/src/db/client.ts + guard.ts) back to the
 * canonical seeded baseline. Call this from a suite that needs a clean
 * slate between tests or files.
 *
 * Clears every content table, then re-applies the seed (task 1.4b).
 *
 * Asserts the live connection is `rg_travel_test` BEFORE issuing a single
 * delete (fix round 1, C1). `seed('test')`'s own assertion runs too late to
 * protect the deletes above it: in any process where `process.env.VITEST`
 * is unset, `getDb()` resolves DATABASE_URL (the live `rg_travel`), and the
 * twelve deletes below would already have emptied it by the time `seed()`
 * got a chance to object. This check queries `SELECT DATABASE()` — unlike
 * the env-var fallback in client.ts, it cannot be fooled by a merely
 * correctly-spelled but misresolving TEST_DATABASE_URL.
 *
 * Deletion order, not TRUNCATE + FOREIGN_KEY_CHECKS: `tours.destination_id`
 * is the only real FK constraint in this schema (every "tourId" column on
 * the other tables is a plain int with no DB-level FK). MySQL/InnoDB
 * refuses to TRUNCATE a table referenced by a FOREIGN KEY constraint from
 * another table — `destinations` specifically — regardless of whether the
 * referencing rows are already gone, so TRUNCATE would still fail here even
 * truncating `tours` first. Toggling `SET FOREIGN_KEY_CHECKS` would work
 * around that, but plain `DELETE FROM` in dependency order (children and
 * unrelated tables first, `tours` before `destinations`) satisfies the FK
 * with no session-level state to remember to restore — so that's what this
 * uses.
 */
import { assertConnectedDatabase } from '../../db/guard';
import { getDb } from '../../db/client';
import * as schema from '../../db/schema';
import { seed } from '../../db/seed';

const TABLES_IN_DELETE_ORDER = [
  schema.tourImages,
  schema.tourPriceTiers,
  schema.tourItineraryStops,
  schema.tourAddons,
  schema.tourBlockedDates,
  schema.reviews,
  schema.inquiries,
  schema.newsletterSubscribers,
  schema.packages,
  schema.tours,
  schema.destinations,
  schema.settings,
] as const;

export async function resetTestDb(): Promise<void> {
  await assertConnectedDatabase('test');

  const db = getDb();
  for (const table of TABLES_IN_DELETE_ORDER) {
    await db.delete(table);
  }
  await seed('test');
}
