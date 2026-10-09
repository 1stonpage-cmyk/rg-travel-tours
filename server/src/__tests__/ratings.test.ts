import { eq } from 'drizzle-orm';
import { afterEach, expect, it } from 'vitest';
import { getDb } from '../db/client';
import { reviews, tours } from '../db/schema';
import { displayAggregate, realAggregate } from '../services/ratings';
import { describeWithDb } from './helpers/db';

describeWithDb('rating aggregates — seeded baseline (D1)', () => {
  it('displayAggregate() counts all six seeded sample reviews; realAggregate() excludes every one of them', async () => {
    const display = await displayAggregate();
    const real = await realAggregate();

    // SEED_REVIEWS ratings, in server/src/db/seed-data.ts: 5, 5, 4, 5, 5, 4.
    expect(display).not.toBeNull();
    expect(display?.count).toBe(6);
    expect(display?.average).toBeCloseTo((5 + 5 + 4 + 5 + 5 + 4) / 6, 5);

    // All six seeded reviews are is_sample: true — never reach structured data.
    expect(real).toBeNull();
  });

  it('scopes to a single real tour and still excludes it from realAggregate()', async () => {
    const db = getDb();
    const [oslob] = await db
      .select({ id: tours.id })
      .from(tours)
      .where(eq(tours.slug, 'oslob-whale-shark-tumalog-falls'));
    expect(oslob).toBeDefined();

    expect(await displayAggregate(oslob!.id)).toEqual({ average: 5, count: 1 });
    expect(await realAggregate(oslob!.id)).toBeNull();
  });
});

describeWithDb('rating aggregates — fixtures', () => {
  // Fake tour ids well outside the seeded range (seeded tours are low
  // auto-increment ints) so these rows never overlap real tours and never
  // need resetTestDb() — plain per-test cleanup by id is enough.
  const TOUR_A = 900_001;
  const TOUR_B = 900_002;
  const insertedIds: number[] = [];

  afterEach(async () => {
    const db = getDb();
    for (const id of insertedIds.splice(0)) {
      await db.delete(reviews).where(eq(reviews.id, id));
    }
  });

  async function insertReview(row: {
    tourId: number;
    rating: number;
    status: 'pending' | 'published' | 'hidden';
    isSample: boolean;
  }): Promise<void> {
    const db = getDb();
    const [result] = await db.insert(reviews).values({
      tourId: row.tourId,
      name: 'Fixture Reviewer',
      rating: row.rating,
      body: 'Fixture review body.',
      status: row.status,
      isSample: row.isSample,
    });
    insertedIds.push(result.insertId);
  }

  it('returns null, never a zero average, when a tour has no published reviews', async () => {
    expect(await displayAggregate(TOUR_A)).toBeNull();
    expect(await realAggregate(TOUR_A)).toBeNull();
  });

  it('filters the per-tour aggregate to only that tour, excluding pending/hidden rows', async () => {
    await insertReview({ tourId: TOUR_A, rating: 5, status: 'published', isSample: false });
    await insertReview({ tourId: TOUR_A, rating: 3, status: 'published', isSample: false });
    await insertReview({ tourId: TOUR_A, rating: 1, status: 'pending', isSample: false }); // excluded
    await insertReview({ tourId: TOUR_B, rating: 2, status: 'hidden', isSample: false }); // excluded

    expect(await displayAggregate(TOUR_A)).toEqual({ average: 4, count: 2 });
    expect(await displayAggregate(TOUR_B)).toBeNull();
  });

  it("merges every tour's group into one overall aggregate when tourId is omitted", async () => {
    await insertReview({ tourId: TOUR_A, rating: 5, status: 'published', isSample: false });
    await insertReview({ tourId: TOUR_A, rating: 3, status: 'published', isSample: false });
    await insertReview({ tourId: TOUR_B, rating: 4, status: 'published', isSample: false });

    // Overall must include these fixture rows plus the six seeded ones:
    // seeded sum 28 (6 rows) + fixture sum 12 (3 rows) = 40 over 9 rows.
    const overall = await displayAggregate();
    expect(overall?.count).toBe(9);
    expect(overall?.average).toBeCloseTo(40 / 9, 5);
  });

  it('realAggregate() excludes is_sample rows that displayAggregate() still counts', async () => {
    await insertReview({ tourId: TOUR_A, rating: 5, status: 'published', isSample: true });

    expect(await displayAggregate(TOUR_A)).toEqual({ average: 5, count: 1 });
    expect(await realAggregate(TOUR_A)).toBeNull();
  });

  // Fix round 1, I1: every other realAggregate() assertion in this suite
  // expects null, which a regression that made realAggregate() always
  // return null (a stray early return, an inverted filter) would also
  // satisfy. This case mixes real and sample rows for the same tour so
  // realAggregate() is proven to both include the real rows AND exclude
  // the sample ones — displayAggregate() over the same tour proves the
  // full set is still there for display.
  it('realAggregate() includes real rows and excludes samples when both exist for the same tour', async () => {
    await insertReview({ tourId: TOUR_A, rating: 5, status: 'published', isSample: false });
    await insertReview({ tourId: TOUR_A, rating: 3, status: 'published', isSample: false });
    await insertReview({ tourId: TOUR_A, rating: 1, status: 'published', isSample: true });

    // Real-only: average of 5 and 3 -> 4, count 2. Samples excluded.
    expect(await realAggregate(TOUR_A)).toEqual({ average: 4, count: 2 });
    // Display: all three rows -> average 3, count 3.
    expect(await displayAggregate(TOUR_A)).toEqual({ average: 3, count: 3 });
  });
});
