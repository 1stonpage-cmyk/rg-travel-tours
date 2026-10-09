import { eq } from 'drizzle-orm';
import { afterEach, beforeAll, expect, it } from 'vitest';
import { getDb } from '../db/client';
import {
  destinations,
  reviews as reviewsTable,
  settings as settingsTable,
  tours as toursTable,
} from '../db/schema';
import { describeWithDb } from './helpers/db';
import { appRouter } from '../routers/_app';

const caller = appRouter.createCaller({});

describeWithDb('public queries', () => {
  it('settings.get returns a complete, typed payload', async () => {
    const s = await caller.settings.get();
    expect(s.trust.depositPercent).toBe(30);
    expect(s.faqs.length).toBeGreaterThan(0);
    expect(s.permits).toEqual({ dot: null, dti: null, bir: null });
    expect(s.paymentMethods.every((m) => typeof m.label === 'string')).toBe(true);
    expect(typeof s.openState.isOpen).toBe('boolean');
  });

  it('tours.list returns a lowest-tier price', async () => {
    const tours = await caller.tours.list({});
    expect(tours.length).toBe(6);
    for (const t of tours) {
      expect(Number.isInteger(t.fromPriceCentavos)).toBe(true);
      expect(t.bookedThisWeek).toBe(0); // no bookings table yet (D8)
      expect(t.tripsRun).toBeNull(); // historical count seeded NULL
    }
  });

  // Fix round 3 (review I2): the original version of this test re-sorted the
  // API's own output with a comparator that returns 0 for every pair,
  // because all six seeded tours are isFeatured: true — Array.prototype.sort
  // is stable, so that "expected" array was always byte-identical to the
  // input regardless of what ORDER BY the SQL used. This version inserts a
  // real mixed fixture: an unfeatured tour with a sort_order low enough to
  // sort first under `sort_order` alone, and asserts it still lands after
  // every featured tour — a claim that actually depends on `is_featured
  // DESC` being in the query. Verified both ways by hand (see report):
  // temporarily removing `desc(tours.isFeatured)` from listRows' orderBy
  // makes this test fail; restoring it makes it pass again.
  it('tours.list orders featured tours first even when a non-featured tour has the lowest sort_order', async () => {
    const db = getDb();
    const [anyDestination] = await db.select({ id: destinations.id }).from(destinations).limit(1);
    expect(anyDestination).toBeDefined();

    const [inserted] = await db.insert(toursTable).values({
      slug: 'fixture-unfeatured-lowest-sort-order',
      title: 'Fixture — unfeatured, lowest sort_order',
      destinationId: anyDestination!.id,
      isFeatured: false,
      sortOrder: -1, // would sort first under `sort_order ASC` alone
      isActive: true,
    });
    const fixtureId = inserted.insertId;

    try {
      const list = await caller.tours.list({});
      const fixtureIndex = list.findIndex((t) => t.id === fixtureId);
      expect(fixtureIndex).toBeGreaterThan(-1);

      const featuredIndices = list
        .map((t, index) => (t.isFeatured ? index : -1))
        .filter((index) => index !== -1);
      expect(featuredIndices.length).toBeGreaterThan(0);
      // Every featured tour must appear before the unfeatured fixture, no
      // matter how low its sort_order is.
      expect(Math.max(...featuredIndices)).toBeLessThan(fixtureIndex);
    } finally {
      await db.delete(toursTable).where(eq(toursTable.id, fixtureId));
    }
  });

  // Fix round 3 (review I1): soft-deleting a destination must hide its
  // tours too, or "is_active" is decorative. Deactivates a real seeded
  // destination (cebu-city, chosen because no earlier test in this file
  // filters on it), asserts its tour disappears from the catalog and that
  // bySlug on that tour now throws NOT_FOUND, then restores the baseline
  // with resetTestDb() rather than hand-flipping the flag back — cheaper to
  // get right and proven correct by every other test file that already
  // relies on it.
  it('tours.list and tours.bySlug hide tours whose destination is inactive', async () => {
    const db = getDb();
    const destinationSlug = 'cebu-city';
    const tourSlug = 'cebu-city-heritage-tour';

    const before = await caller.tours.list({});
    expect(before.some((t) => t.slug === tourSlug)).toBe(true);
    await expect(caller.tours.bySlug({ slug: tourSlug })).resolves.toBeDefined();

    await db
      .update(destinations)
      .set({ isActive: false })
      .where(eq(destinations.slug, destinationSlug));

    try {
      const after = await caller.tours.list({});
      expect(after.some((t) => t.slug === tourSlug)).toBe(false);
      expect(after.length).toBe(before.length - 1);

      await expect(caller.tours.bySlug({ slug: tourSlug })).rejects.toThrow(/NOT_FOUND/);
    } finally {
      const { resetTestDb } = await import('./helpers/test-db');
      await resetTestDb();
    }

    // Baseline restored — the untouched seed is back to its usual 6 tours.
    const restored = await caller.tours.list({});
    expect(restored.length).toBe(6);
    expect(restored.some((t) => t.slug === tourSlug)).toBe(true);
  });

  // Fix round 2 (review F1): placeholder-data.ts renders a "Free
  // cancellation" badge from an explicit per-tour boolean on five of the
  // six tours today. seed-data.ts left `free_cancel_hours` NULL on every
  // tour, so the derived boolean was false everywhere — all five badges
  // silently vanished. Pins the exact set so a future seed edit that drops
  // this again fails here instead of only being visible on the live page.
  it('tours.list reports freeCancellation on five tours, matching today’s page — mactan-island-hopping stays false', async () => {
    const tours = await caller.tours.list({});
    const bySlug = new Map(tours.map((t) => [t.slug, t.freeCancellation]));

    expect(tours.filter((t) => t.freeCancellation)).toHaveLength(5);
    expect(bySlug.get('mactan-island-hopping')).toBe(false);
    expect(bySlug.get('oslob-whale-shark-tumalog-falls')).toBe(true);
    expect(bySlug.get('kawasan-falls-canyoneering')).toBe(true);
    expect(bySlug.get('moalboal-sardine-run-turtles')).toBe(true);
    expect(bySlug.get('cebu-city-heritage-tour')).toBe(true);
    expect(bySlug.get('bohol-countryside-chocolate-hills')).toBe(true);
  });

  it('tours.list filters by destination slug', async () => {
    const oslob = await caller.tours.list({ destination: 'oslob' });
    expect(oslob.length).toBeGreaterThan(0);
    expect(oslob.every((t) => t.destination.slug === 'oslob')).toBe(true);
  });

  it('tours.bySlug throws NOT_FOUND for an unknown slug', async () => {
    await expect(caller.tours.bySlug({ slug: 'no-such-tour' })).rejects.toThrow(/NOT_FOUND/);
  });

  it('reviews.published separates the display and real aggregates', async () => {
    const r = await caller.reviews.published({});
    expect(r.items.length).toBeGreaterThan(0);
    expect(r.items.every((i) => i.isSample)).toBe(true);
    expect(r.displayAggregate).not.toBeNull(); // samples count for display (D1)
    expect(r.realAggregate).toBeNull(); // and never for structured data
  });

  it('packages.list returns active packages with integer centavos', async () => {
    const p = await caller.packages.list();
    expect(p.length).toBe(3);
    expect(p.every((x) => Number.isInteger(x.newPriceCentavos))).toBe(true);
  });

  it('destinations.list exposes both sortOrder and featuredSortOrder, with displayName only on badian-kawasan', async () => {
    const list = await caller.destinations.list();
    expect(list.length).toBe(6);
    const kawasan = list.find((d) => d.slug === 'badian-kawasan');
    expect(kawasan?.displayName).toBe('Kawasan Falls');
    expect(list.filter((d) => d.displayName !== null)).toHaveLength(1);
    expect(list.every((d) => typeof d.sortOrder === 'number')).toBe(true);
    expect(
      list.every((d) => d.featuredSortOrder === null || typeof d.featuredSortOrder === 'number'),
    ).toBe(true);
  });

  it('tours.list issues a constant number of queries, not one per tour (no N+1)', async () => {
    const pool = (await import('../db/client')).getPool();
    let calls = 0;
    const originalQuery = pool.query.bind(pool);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (pool as any).query = (...args: unknown[]) => {
      calls += 1;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (originalQuery as any)(...args);
    };

    try {
      const tours = await caller.tours.list({});
      expect(tours.length).toBe(6);
      // Exactly 4, proven by counting real pool.query() calls rather than
      // trusting a comment: the grouped tours+destinations+min-price query,
      // the batched first-image lookup, the batched rating aggregates, and
      // (Task 1.9, R1) the single `trust` settings row for
      // minReviewsForRating. Fixed regardless of how many tours exist —
      // never one per tour.
      expect(calls).toBe(4);
    } finally {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (pool as any).query = originalQuery;
    }
  });
});

// Task 1.9 (R1): a tour's displayed `rating` is withheld below
// `trust.minReviewsForRating` published reviews (sample or real — the same
// population displayAggregate() counts). Uses a seeded tour that starts
// with exactly one published sample review, so adding fixture reviews moves
// it across the (seeded) threshold of 3 deterministically.
describeWithDb('tours.list / tours.bySlug rating display threshold (Task 1.9, R1)', () => {
  const TOUR_SLUG = 'oslob-whale-shark-tumalog-falls';
  let tourId: number;
  const insertedReviewIds: number[] = [];

  beforeAll(async () => {
    const db = getDb();
    const [row] = await db
      .select({ id: toursTable.id })
      .from(toursTable)
      .where(eq(toursTable.slug, TOUR_SLUG));
    expect(row).toBeDefined();
    tourId = row!.id;
  });

  afterEach(async () => {
    const db = getDb();
    for (const id of insertedReviewIds.splice(0)) {
      await db.delete(reviewsTable).where(eq(reviewsTable.id, id));
    }
  });

  async function addPublishedReview(): Promise<void> {
    const db = getDb();
    const [result] = await db.insert(reviewsTable).values({
      tourId,
      name: 'Fixture Reviewer',
      rating: 5,
      body: 'Fixture review body.',
      status: 'published',
      isSample: false,
    });
    insertedReviewIds.push(result.insertId);
  }

  it('reports rating: null for a tour with 2 published reviews (below the seeded threshold of 3)', async () => {
    await addPublishedReview(); // seed's 1 sample review + 1 fixture = 2

    const list = await caller.tours.list({});
    expect(list.find((t) => t.id === tourId)?.rating).toBeNull();

    const detail = await caller.tours.bySlug({ slug: TOUR_SLUG });
    expect(detail.rating).toBeNull();
  });

  it('reports the aggregate once the tour reaches 3 published reviews', async () => {
    await addPublishedReview();
    await addPublishedReview(); // seed's 1 + 2 fixtures = 3

    const list = await caller.tours.list({});
    const listRating = list.find((t) => t.id === tourId)?.rating;
    expect(listRating).not.toBeNull();
    expect(listRating?.count).toBe(3);

    const detail = await caller.tours.bySlug({ slug: TOUR_SLUG });
    expect(detail.rating).toEqual(listRating);
  });

  it('reads the threshold from settings rather than a hardcoded 3 — raising it to 4 pushes a 3-review tour back to null', async () => {
    await addPublishedReview();
    await addPublishedReview(); // 3 total — would display at the seeded threshold of 3

    const db = getDb();
    const [trustRow] = await db.select().from(settingsTable).where(eq(settingsTable.key, 'trust'));
    expect(trustRow).toBeDefined();
    const originalValue = trustRow!.value;

    await db
      .update(settingsTable)
      .set({ value: { ...(originalValue as Record<string, unknown>), minReviewsForRating: 4 } })
      .where(eq(settingsTable.key, 'trust'));

    try {
      const list = await caller.tours.list({});
      expect(list.find((t) => t.id === tourId)?.rating).toBeNull();

      const detail = await caller.tours.bySlug({ slug: TOUR_SLUG });
      expect(detail.rating).toBeNull();
    } finally {
      await db
        .update(settingsTable)
        .set({ value: originalValue })
        .where(eq(settingsTable.key, 'trust'));
    }
  });

  it('leaves realAggregate untouched by the display threshold — it stays published AND is_sample=0, with no review-count floor', async () => {
    await addPublishedReview();
    await addPublishedReview(); // 2 real fixtures, below the seeded display threshold of 3

    const r = await caller.reviews.published({ tourId });
    // The two real fixtures count; the seeded is_sample review does not.
    expect(r.realAggregate).toEqual({ average: 5, count: 2 });
  });
});
