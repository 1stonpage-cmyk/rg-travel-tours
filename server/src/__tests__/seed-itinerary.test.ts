/**
 * Week 6.5, Task 11 (C4): the itinerary-stop writer.
 *
 * ## Why the test database must stay stop-free
 *
 * Stops are seeded into `rg_travel` only. `tripProgress` and `checkins.ts`
 * count a booking's checkpoints against its tour's stops to decide how far a
 * trip has got and whether the van is freed, so seed stops those suites did
 * not create would change their answers. This file therefore BORROWS the
 * table for one tour and gives it back in a `finally`, and its second test
 * holds the app-only rule from the other side: the test-context seed writes
 * nothing.
 *
 * ## Isolation
 *
 * Test files run one at a time (`fileParallelism: false`), and `seed('test')`
 * only upserts the baseline that `globalSetup` already laid down, so the
 * mid-suite re-seed disturbs nothing that runs after. Like
 * `public-queries.test.ts`, the file ends by restoring the canonical baseline
 * through `resetTestDb()`.
 */
import { afterAll, describe, expect, it } from 'vitest';
import type { RowDataPacket } from 'mysql2';
import { getDb, getPool } from '../db/client';
import { seed, upsertItineraryStops } from '../db/seed';
import { SEED_TOURS } from '../db/seed-data';

const SLUG = 'kawasan-falls-canyoneering';

async function tourIdForSlug(slug: string): Promise<number> {
  const [rows] = await getPool().query<RowDataPacket[]>('SELECT id FROM tours WHERE slug = ?', [
    slug,
  ]);
  if (!rows[0]) throw new Error(`test database has no tour "${slug}"`);
  return Number(rows[0].id);
}

async function stopsFor(tourId: number) {
  const [rows] = await getPool().query<RowDataPacket[]>(
    'SELECT sort_order AS sortOrder, name, description FROM tour_itinerary_stops WHERE tour_id = ? ORDER BY sort_order',
    [tourId],
  );
  return rows.map((r) => ({
    sortOrder: Number(r.sortOrder),
    name: String(r.name),
    description: r.description === null ? null : String(r.description),
  }));
}

async function totalStops(): Promise<number> {
  const [rows] = await getPool().query<RowDataPacket[]>(
    'SELECT COUNT(*) AS n FROM tour_itinerary_stops',
  );
  return Number(rows[0]!.n);
}

afterAll(async () => {
  const { resetTestDb } = await import('./helpers/test-db');
  await resetTestDb();
});

describe('upsertItineraryStops', () => {
  it('writes the stops, in order, and is idempotent across re-runs', async () => {
    const tourId = await tourIdForSlug(SLUG);
    const declared = SEED_TOURS.find((t) => t.slug === SLUG)!.stops;
    try {
      await upsertItineraryStops(getDb(), new Map([[SLUG, tourId]]));
      const first = await stopsFor(tourId);
      expect(first.map((s) => s.sortOrder)).toEqual(declared.map((s) => s.sortOrder));
      expect(first.map((s) => s.name)).toEqual(declared.map((s) => s.name));
      expect(first.length).toBeGreaterThanOrEqual(3);

      // A second run replaces rather than duplicating — the discipline
      // `upsertTour` already keeps for price tiers and images.
      await upsertItineraryStops(getDb(), new Map([[SLUG, tourId]]));
      expect(await stopsFor(tourId)).toEqual(first);
    } finally {
      // The test database keeps no stops: this suite borrows the table and
      // gives it back, or the suites that count rows start counting rows
      // they did not create.
      await getPool().query('DELETE FROM tour_itinerary_stops WHERE tour_id = ?', [tourId]);
    }
  });

  it('refuses a slug that is not a seeded tour, writing nothing', async () => {
    // Fails closed: `tour_id` carries no foreign key, so a stop written for a
    // tour nobody declared would be an orphan that nothing would ever catch.
    const before = await totalStops();
    await expect(upsertItineraryStops(getDb(), new Map([['no-such-tour', 1]]))).rejects.toThrow(
      /unknown tour/,
    );
    expect(await totalStops()).toBe(before);
  });
});

describe('the test-context seed', () => {
  it('writes NO stops', async () => {
    try {
      await seed('test');
      expect(await totalStops()).toBe(0);
    } finally {
      await getPool().query('DELETE FROM tour_itinerary_stops');
    }
  });
});
