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
 * Deletion order, not TRUNCATE + FOREIGN_KEY_CHECKS: these tables are tied
 * together by real FK constraints — `tours.destination_id`, and since task
 * 11b-4 `reviews.tour_id` too, which is why `reviews` is deleted before
 * `tours` and `tours` before `destinations`. MySQL/InnoDB
 * refuses to TRUNCATE a table referenced by a FOREIGN KEY constraint from
 * another table — `destinations` specifically — regardless of whether the
 * referencing rows are already gone, so TRUNCATE would still fail here even
 * truncating `tours` first. Toggling `SET FOREIGN_KEY_CHECKS` would work
 * around that, but plain `DELETE FROM` in dependency order (children and
 * unrelated tables first, `tours` before `destinations`) satisfies the FK
 * with no session-level state to remember to restore — so that's what this
 * uses.
 */
import { eq } from 'drizzle-orm';
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

/**
 * Seeds the test database, then flips `show_tours` to `true` — the test
 * harness's own baseline, deliberately different from the real product
 * default (`false`, Task T15). `SEED_SETTINGS` is shared verbatim between
 * the app and test databases, so without this every pre-existing
 * tours/checkout/SEO/sitemap test would need its own override just to see
 * the tour catalog it was written against. Mirrors the
 * `ALLOW_DEMO_SEED ??= '1'` split documented in CLAUDE.md for the same
 * reason: a restrictive, honest product default with a permissive test
 * baseline layered on top of it, never the other way round.
 *
 * It must be ONE shared function rather than two one-off flips:
 * `resetTestDb()` DELETEs the whole `settings` table before reseeding, so a
 * single flip in `global-setup.ts` would be silently undone by the first
 * mid-run reset — and four of the files that reset mid-run
 * (`public-queries`, `seo-resolvers`, `sitemap-robots`, `settings`) are
 * exactly the ones that need the catalog visible.
 */
export async function seedTestBaseline(): Promise<void> {
  await seed('test');
  await getDb()
    .update(schema.settings)
    .set({ value: true })
    .where(eq(schema.settings.key, 'show_tours'));
}

export async function resetTestDb(): Promise<void> {
  await assertConnectedDatabase('test');

  const db = getDb();
  for (const table of TABLES_IN_DELETE_ORDER) {
    await db.delete(table);
  }
  await seedTestBaseline();
}
