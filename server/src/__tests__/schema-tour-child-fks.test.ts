/**
 * The three tour child tables' foreign keys (7N item 3, migration `0014`).
 *
 * `tour_images`, `tour_price_tiers` and `tour_itinerary_stops` each held a
 * `tour_id` that NOTHING in the database checked. `tour_date_slots` has
 * referenced `tours.id` since `0000`; these three were simply missed. The
 * consequence is quiet rather than loud: a mistyped id writes a row
 * belonging to no tour, every reader joins it away, and the gallery image or
 * price band a dispatcher swears they entered is in the table and invisible.
 * `tour_itinerary_stops` is the worst of the three, because `trip_checkpoints`
 * counts a tour's stops to decide how far along a trip is.
 *
 * ## Asserted at three levels, because each catches a different mistake
 *
 *  1. **The Drizzle schema** declares the reference (`getTableConfig`) — the
 *     object drizzle-kit emits DDL from, so a future `db:generate` keeps it.
 *  2. **The live database** carries the constraint
 *     (`information_schema.KEY_COLUMN_USAGE`) — which is what proves the
 *     MIGRATION ran, not merely that the schema file says so. A schema-only
 *     assertion would pass on a database where `0014` was never applied,
 *     which is exactly the server the owner still has to migrate.
 *  3. **An orphan INSERT is refused.** The other two describe the plumbing;
 *     this one is the behaviour the foreign key exists for, and it is the
 *     assertion that cannot be satisfied by a constraint that is defined but
 *     disabled.
 *
 * Plain RESTRICT, which is the house style — there is no `onDelete` anywhere
 * in `schema.ts`, and nothing hard-deletes a tour (CLAUDE.md "Soft deletes":
 * `is_active`).
 *
 * **Teardown:** nothing is left behind. Every INSERT here is expected to be
 * REFUSED, so the only rows this file could leave are ones a broken build
 * created — and the sweep at the end removes those by their sentinel
 * `tour_id` rather than trusting that.
 */
import { afterAll, expect, it } from 'vitest';
import { getTableConfig } from 'drizzle-orm/mysql-core';
import { sql } from 'drizzle-orm';
import { getDb, getPool } from '../db/client';
import { tourImages, tourItineraryStops, tourPriceTiers } from '../db/schema';
import { describeWithDb } from './helpers/db';

/** A `tour_id` no `tours` row can ever have. */
const ORPHAN_TOUR_ID = 2_000_000_001;

const TABLES = [
  ['tour_images', tourImages],
  ['tour_price_tiers', tourPriceTiers],
  ['tour_itinerary_stops', tourItineraryStops],
] as const;

afterAll(async () => {
  const pool = getPool();
  for (const [name] of TABLES) {
    // The table names are the three literals above, never assembled from
    // anything a test or a row could influence.
    await pool.query(`DELETE FROM \`${name}\` WHERE tour_id = ?`, [ORPHAN_TOUR_ID]);
  }
});

describeWithDb('the tour child tables reference tours.id', () => {
  for (const [name, table] of TABLES) {
    it(`${name}: the Drizzle schema declares the reference`, () => {
      const fks = getTableConfig(table).foreignKeys.map((fk) => {
        const ref = fk.reference();
        return {
          from: ref.columns.map((c) => c.name),
          toTable: getTableConfig(ref.foreignTable).name,
          to: ref.foreignColumns.map((c) => c.name),
        };
      });
      expect(fks).toEqual([{ from: ['tour_id'], toTable: 'tours', to: ['id'] }]);
    });

    it(`${name}: the LIVE database carries the constraint, so 0014 really ran`, async () => {
      const rows = await getDb().execute(sql`
        SELECT CONSTRAINT_NAME AS name, REFERENCED_TABLE_NAME AS parent
        FROM information_schema.KEY_COLUMN_USAGE
        WHERE TABLE_SCHEMA = DATABASE()
          AND TABLE_NAME = ${name}
          AND COLUMN_NAME = 'tour_id'
          AND REFERENCED_TABLE_NAME IS NOT NULL
      `);
      // `.execute()` returns [rows, fields] for mysql2.
      const found = (rows as unknown as [{ name: string; parent: string }[], unknown])[0];
      expect(found.map((r) => r.parent)).toEqual(['tours']);
    });
  }

  it('REFUSES a tour_images row whose tour does not exist', async () => {
    await expect(
      getDb().insert(tourImages).values({
        tourId: ORPHAN_TOUR_ID,
        path: '/placeholders/orphan.svg',
        alt: 'An image belonging to no tour',
      }),
    ).rejects.toThrow();
  });

  it('REFUSES a tour_price_tiers row whose tour does not exist', async () => {
    await expect(
      getDb().insert(tourPriceTiers).values({
        tourId: ORPHAN_TOUR_ID,
        minPax: 1,
        maxPax: 4,
        pricePerPersonCentavos: 250_000,
      }),
    ).rejects.toThrow();
  });

  it('REFUSES a tour_itinerary_stops row whose tour does not exist', async () => {
    await expect(
      getDb().insert(tourItineraryStops).values({
        tourId: ORPHAN_TOUR_ID,
        sortOrder: 1,
        name: 'A stop on no tour',
      }),
    ).rejects.toThrow();
  });

  /**
   * The refusal must be the FOREIGN KEY's, not some other error that would
   * also make the three tests above pass — a column-length violation or a
   * missing NOT NULL would read identically through `.rejects.toThrow()`.
   *
   * The `.cause` walk is the pattern `db/duplicate-key.ts` already uses, and
   * for its stated reason: Drizzle wraps the mysql2 error, and the wrapping
   * depth has changed once in this codebase's lifetime already.
   */
  it('refuses it as a foreign-key violation specifically, not just any error', async () => {
    const error = await getDb()
      .insert(tourItineraryStops)
      .values({ tourId: ORPHAN_TOUR_ID, sortOrder: 2, name: 'Another stop on no tour' })
      .catch((e: unknown) => e);

    let current: unknown = error;
    const codes: unknown[] = [];
    for (let depth = 0; depth < 5 && current != null && typeof current === 'object'; depth += 1) {
      codes.push((current as { code?: unknown }).code);
      current = (current as { cause?: unknown }).cause;
    }
    expect(codes, `no ER_NO_REFERENCED_ROW_2 in the cause chain: ${String(error)}`).toContain(
      'ER_NO_REFERENCED_ROW_2',
    );
  });
});
