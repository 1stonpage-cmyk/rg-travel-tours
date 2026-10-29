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
import { eq } from 'drizzle-orm';
import { getDb, getPool } from '../db/client';
import { bookings, tourItineraryStops, tripCheckpoints } from '../db/schema';
import { seed, upsertItineraryStops } from '../db/seed';
import { SEED_TOURS } from '../db/seed-data';
import { generateBookingRef } from '../services/booking-ref';
import type { PriceSnapshot } from '@rg/shared';

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
    /*
     * Fails closed before it writes. `tour_id` is a real foreign key as of
     * migration `0014`, so an unknown tour id would now be refused by MySQL
     * too — but this throw names the SLUG, which is the thing a person
     * editing `seed-data.ts` mistyped, where a foreign-key error names a
     * number.
     */
    const before = await totalStops();
    await expect(upsertItineraryStops(getDb(), new Map([['no-such-tour', 1]]))).rejects.toThrow(
      /unknown tour/,
    );
    expect(await totalStops()).toBe(before);
  });
});

/**
 * The batch-3 carry-forward, fixed in 7N: this writer used to do the
 * wholesale `DELETE FROM tour_itinerary_stops WHERE tour_id = ?` that
 * `admin.tours.update` also did before Task 6 fixed it — and
 * `trip_checkpoints.stop_id` references this table with RESTRICT. So the
 * FIRST real driver check-in against any seeded stop broke `db:seed` for
 * every future re-seed, on the dev database, which is the only one that
 * ships stops. The symptom is a foreign-key error pointing at a table nobody
 * was thinking about, on a laptop that has merely been used to walk through
 * a trip once.
 *
 * These build the check-in history the real bug needed, which the tests above
 * never had: a booking, and a `trip_checkpoints` row against one stop.
 */
describe('upsertItineraryStops with real check-in history', () => {
  const SNAPSHOT: PriceSnapshot = {
    tier: { tierId: 1, minPax: 1, maxPax: 12, pricePerPersonCentavos: 100_000 },
    addons: [],
    coupon: null,
    depositPercent: 30,
    freeCancelHours: 48,
    subtotalCentavos: 400_000,
    discountCentavos: 0,
    totalCentavos: 400_000,
  };

  /** A booking on `tourId`, only so a checkpoint has something to hang off. */
  async function makeBooking(tourId: number): Promise<number> {
    const [row] = await getDb()
      .insert(bookings)
      .values({
        ref: generateBookingRef(),
        tourId,
        tourDate: new Date('2026-12-01T00:00:00Z'),
        pax: 2,
        leadName: 'Seed Itinerary Lead',
        leadEmail: `seeditin_${Date.now()}@example.test`,
        leadPhone: '09171234567',
        status: 'in_progress',
        payMode: 'deposit',
        priceSnapshot: SNAPSHOT,
        subtotalCentavos: 400_000,
        totalCentavos: 400_000,
        amountPaidCentavos: 0,
      });
    return row.insertId;
  }

  async function storedStops(tourId: number) {
    return getDb()
      .select({ id: tourItineraryStops.id, sortOrder: tourItineraryStops.sortOrder })
      .from(tourItineraryStops)
      .where(eq(tourItineraryStops.tourId, tourId))
      .orderBy(tourItineraryStops.sortOrder);
  }

  /**
   * THE load-bearing test. Before the fix this re-seed threw
   * `ER_ROW_IS_REFERENCED_2` and `db:seed` was broken for good on that
   * machine.
   */
  it('RE-SEEDS successfully after a driver has checked in, keeping the stop row', async () => {
    const tourId = await tourIdForSlug(SLUG);
    let bookingId: number | null = null;
    try {
      await upsertItineraryStops(getDb(), new Map([[SLUG, tourId]]));
      const before = await storedStops(tourId);
      const checkedInStop = before[1]!;

      bookingId = await makeBooking(tourId);
      await getDb()
        .insert(tripCheckpoints)
        .values({ bookingId, stopId: checkedInStop.id, checkedAt: new Date() });

      await expect(
        upsertItineraryStops(getDb(), new Map([[SLUG, tourId]])),
      ).resolves.toBeUndefined();

      /*
       * The id SURVIVES, which is more than "it did not throw": the
       * checkpoint still points at the stop the van actually reached. A fix
       * that deleted what it could and re-inserted the rest would pass a
       * "does not throw" assertion and leave the checkpoint attached to a
       * stop with a new id — or to nothing.
       */
      const after = await storedStops(tourId);
      expect(after.map((r) => r.id)).toEqual(before.map((r) => r.id));
      expect(after.map((r) => r.sortOrder)).toEqual(before.map((r) => r.sortOrder));
    } finally {
      if (bookingId !== null) {
        await getPool().query('DELETE FROM trip_checkpoints WHERE booking_id = ?', [bookingId]);
        await getPool().query('DELETE FROM bookings WHERE id = ?', [bookingId]);
      }
      await getPool().query('DELETE FROM tour_itinerary_stops WHERE tour_id = ?', [tourId]);
    }
  });

  it('DELETES a stop the seed dropped, but KEEPS one a trip has checked in at', async () => {
    const tourId = await tourIdForSlug(SLUG);
    let bookingId: number | null = null;
    try {
      await upsertItineraryStops(getDb(), new Map([[SLUG, tourId]]));

      // Two stops at positions the seed does not declare, so the next run
      // drops both — except that one of them has history.
      const [withHistory] = await getDb()
        .insert(tourItineraryStops)
        .values({ tourId, sortOrder: 98, name: 'Stop with history', description: null });
      await getDb()
        .insert(tourItineraryStops)
        .values({ tourId, sortOrder: 99, name: 'Stop with no history', description: null });

      bookingId = await makeBooking(tourId);
      await getDb()
        .insert(tripCheckpoints)
        .values({ bookingId, stopId: withHistory.insertId, checkedAt: new Date() });

      await upsertItineraryStops(getDb(), new Map([[SLUG, tourId]]));

      const orders = (await storedStops(tourId)).map((r) => r.sortOrder);
      expect(orders, 'the stop a trip reached must survive a re-seed').toContain(98);
      expect(orders, 'a stop with no history is the seed to remove').not.toContain(99);
    } finally {
      if (bookingId !== null) {
        await getPool().query('DELETE FROM trip_checkpoints WHERE booking_id = ?', [bookingId]);
        await getPool().query('DELETE FROM bookings WHERE id = ?', [bookingId]);
      }
      await getPool().query('DELETE FROM tour_itinerary_stops WHERE tour_id = ?', [tourId]);
    }
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
