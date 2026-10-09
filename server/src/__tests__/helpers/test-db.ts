/**
 * Resets the test database (rg_travel_test — never rg_travel, enforced at
 * the connection layer by server/src/db/client.ts + guard.ts) back to the
 * canonical seeded baseline. Call this from a suite that needs a clean
 * slate between tests or files.
 *
 * Clears every content table, then re-applies the seed (task 1.4b).
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
  const db = getDb();
  for (const table of TABLES_IN_DELETE_ORDER) {
    await db.delete(table);
  }
  await seed('test');
}
