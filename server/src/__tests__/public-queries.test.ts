import { expect, it } from 'vitest';
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

  it('tours.list returns a lowest-tier price and orders featured first', async () => {
    const tours = await caller.tours.list({});
    expect(tours.length).toBe(6);
    for (const t of tours) {
      expect(Number.isInteger(t.fromPriceCentavos)).toBe(true);
      expect(t.bookedThisWeek).toBe(0); // no bookings table yet (D8)
      expect(t.tripsRun).toBeNull(); // historical count seeded NULL
    }
    const featuredFirst = [...tours].sort((a, b) => Number(b.isFeatured) - Number(a.isFeatured));
    expect(tours.map((t) => t.id)).toEqual(featuredFirst.map((t) => t.id));
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
      // Exactly 3, proven by counting real pool.query() calls rather than
      // trusting a comment: the grouped tours+destinations+min-price query,
      // the batched first-image lookup, and the batched rating aggregates.
      // Fixed regardless of how many tours exist — never one per tour.
      expect(calls).toBe(3);
    } finally {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (pool as any).query = originalQuery;
    }
  });
});
