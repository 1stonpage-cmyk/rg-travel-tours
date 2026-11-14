import { formatPeso, manilaCivilDate } from '@rg/shared';
import { eq, inArray } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, expect, it } from 'vitest';
import { getDb } from '../db/client';
import {
  destinations,
  packages as packagesTable,
  reviews as reviewsTable,
  settings as settingsTable,
  tours as toursTable,
  transferPlaces,
  transferRouteVehiclePrices,
  transferRoutes,
  vans,
  vehicleTypes,
} from '../db/schema';
import { testContext } from './helpers/ctx';
import { describeWithDb } from './helpers/db';
import { appRouter } from '../routers/_app';

const caller = appRouter.createCaller(testContext());

describeWithDb('public queries', () => {
  it('settings.get returns a complete, typed payload', async () => {
    const s = await caller.settings.get();
    expect(s.trust.depositPercent).toBe(30);
    expect(s.faqs.length).toBeGreaterThan(0);
    expect(s.permits).toEqual({ dot: null, dti: null, bir: null });
    expect(s.paymentMethods.every((m) => typeof m.label === 'string')).toBe(true);
    expect(typeof s.openState.isOpen).toBe('boolean');
  });

  /**
   * The bookable window reaches the browser RESOLVED — two civil dates — and
   * the raw policy does not. This is what lets the date picker disable a
   * closed date by string comparison while computing nothing: a browser clock
   * in the wrong time zone must never evaluate a Manila rule, the same reason
   * the announcement's schedule fields never ship either.
   *
   * Asserted against the live seed rather than a fixture, so it also proves
   * the `booking` settings row actually exists — `readSettings()` throws on a
   * missing key, so a seed that forgot it would take the whole payload down.
   */
  it('settings.get resolves the booking window, and never ships the raw policy', async () => {
    const s = await caller.settings.get();

    for (const date of [s.bookingWindow.earliest, s.bookingWindow.latest]) {
      expect(date, `${date} is not a YYYY-MM-DD civil date`).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
    // A window that runs forwards, and one the seeded 180 days can fit in.
    expect(s.bookingWindow.earliest < s.bookingWindow.latest).toBe(true);
    // Today is outside it (`minLeadDays: 1`), which is the whole policy.
    expect(manilaCivilDate(new Date()) < s.bookingWindow.earliest).toBe(true);
    // The knobs stay on the server.
    expect(s).not.toHaveProperty('booking');
    expect(JSON.stringify(s)).not.toContain('minLeadDays');
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

  /**
   * The `show_tours` gate (transfers-launch plan, Task T15) — the public
   * catalog's half of it.
   *
   * `list` answers an EMPTY ARRAY rather than throwing: a hidden catalog is
   * a catalog with nothing in it. `bySlug` answers `NOT_FOUND` with the
   * same message an unknown slug gets, so the refusal cannot be used to
   * confirm that a tour exists behind the switch.
   *
   * Restored through `resetTestDb()`, the same way the inactive-destination
   * test above restores its flag — which also puts the harness's
   * `show_tours: true` baseline back (`seedTestBaseline`).
   */
  it('tours.list and tours.bySlug are gated by show_tours', async () => {
    const db = getDb();
    const tourSlug = 'cebu-city-heritage-tour';

    // The premise, asserted rather than assumed.
    const before = await caller.tours.list({});
    expect(before.length).toBe(6);
    await expect(caller.tours.bySlug({ slug: tourSlug })).resolves.toBeDefined();

    await db.update(settingsTable).set({ value: false }).where(eq(settingsTable.key, 'show_tours'));

    try {
      expect(await caller.tours.list({})).toEqual([]);
      // Same filter, too: a destination filter does not get past the gate.
      expect(await caller.tours.list({ destination: 'cebu-city' })).toEqual([]);
      await expect(caller.tours.bySlug({ slug: tourSlug })).rejects.toThrow(/NOT_FOUND/);
      // Byte-identical to an unknown slug's refusal — the gate must not be
      // distinguishable from "no such tour".
      const hidden = await caller.tours
        .bySlug({ slug: tourSlug })
        .catch((e: unknown) => (e as Error).message);
      const unknown = await caller.tours
        .bySlug({ slug: '__no_such_tour__' })
        .catch((e: unknown) => (e as Error).message);
      expect(hidden).toBe(`NOT_FOUND: no tour found for slug "${tourSlug}"`);
      expect(unknown).toBe('NOT_FOUND: no tour found for slug "__no_such_tour__"');
    } finally {
      const { resetTestDb } = await import('./helpers/test-db');
      await resetTestDb();
    }

    // Baseline restored — the catalog is visible again.
    expect((await caller.tours.list({})).length).toBe(6);
  });

  it('packages.list and packages.bySlug are gated by show_tours, same pattern as tours (Decision 2)', async () => {
    const db = getDb();
    const packageSlug = 'cebu-highlights-3d2n';

    // The premise, asserted rather than assumed.
    const before = await caller.packages.list();
    expect(before.length).toBe(3);
    await expect(caller.packages.bySlug({ slug: packageSlug })).resolves.toBeDefined();

    await db.update(settingsTable).set({ value: false }).where(eq(settingsTable.key, 'show_tours'));

    try {
      expect(await caller.packages.list()).toEqual([]);
      await expect(caller.packages.bySlug({ slug: packageSlug })).rejects.toThrow(/NOT_FOUND/);
      // Byte-identical to an unknown slug's refusal — same BUG-122 shape tours.bySlug already has.
      const hidden = await caller.packages
        .bySlug({ slug: packageSlug })
        .catch((e: unknown) => (e as Error).message);
      const unknown = await caller.packages
        .bySlug({ slug: '__no_such_package__' })
        .catch((e: unknown) => (e as Error).message);
      expect(hidden).toBe(`NOT_FOUND: no package found for slug "${packageSlug}"`);
      expect(unknown).toBe(`NOT_FOUND: no package found for slug "__no_such_package__"`);
    } finally {
      const { resetTestDb } = await import('./helpers/test-db');
      await resetTestDb();
    }

    // Baseline restored — packages are visible again.
    expect((await caller.packages.list()).length).toBe(3);
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

  /**
   * Task 4 (1D): `pageTitle` must be the SAME formula `tourTitle()`
   * (`seo/resolvers.ts`) computes for the server-injected `<title>` on a
   * cold load — not a re-derivation, and not the bare row title. The seed
   * ships no `seo_title` override, so this is the common, no-override path:
   * the generated fallback string, built from this exact row's own
   * `title`/`destination.name`/`fromPriceCentavos`.
   */
  it('tours.bySlug publishes pageTitle computed via the tourTitle() formula (no override)', async () => {
    const slug = 'oslob-whale-shark-tumalog-falls';
    const detail = await caller.tours.bySlug({ slug });

    expect(detail.seoTitle).toBeNull();
    expect(detail.fromPriceCentavos).not.toBeNull();
    expect(detail.pageTitle).toBe(
      `${detail.title} — ${detail.destination.name} day tour from ${formatPeso(detail.fromPriceCentavos!)} | TravelSugbo`,
    );
  });

  /** The other branch of the same formula: an admin `seo_title` override wins outright. */
  it('tours.bySlug publishes pageTitle from the admin seo_title override when one is set', async () => {
    const db = getDb();
    const slug = 'oslob-whale-shark-tumalog-falls';
    await db
      .update(toursTable)
      .set({ seoTitle: 'Fixture Override Tour Title' })
      .where(eq(toursTable.slug, slug));

    try {
      const detail = await caller.tours.bySlug({ slug });
      expect(detail.pageTitle).toBe('Fixture Override Tour Title');
    } finally {
      await db.update(toursTable).set({ seoTitle: null }).where(eq(toursTable.slug, slug));
    }
  });

  /**
   * The commit's own claim is byte-IDENTITY with what the server injects
   * into `<title>` on a cold load, not merely "the same formula FUNCTION" —
   * `resolvePage()`'s `resolveTour` builds its `TourSeoRow` via
   * `loadTourSeo()` (a `MIN()` SQL aggregate for `fromPriceCentavos`), while
   * `tours.bySlug` derives the same number via `Math.min()` over its own
   * `priceTiers` read. Both land on the identical value today, but nothing
   * before this test actually compared the two call paths' OUTPUT strings
   * against each other rather than against a hand-written expectation.
   */
  it("tours.bySlug.pageTitle is byte-identical to resolvePage()'s cold-load <title> for the same route", async () => {
    const slug = 'kawasan-falls-canyoneering';
    const { resolvePage } = await import('../seo/resolvers');

    const detail = await caller.tours.bySlug({ slug });
    const coldLoad = await resolvePage(`/tours/${slug}`);

    expect(detail.pageTitle).toBe(coldLoad.title);
  });

  it('reviews.published separates the display and real aggregates', async () => {
    const r = await caller.reviews.published({});
    expect(r.items.length).toBeGreaterThan(0);
    expect(r.items.every((i) => i.isSample)).toBe(true);
    expect(r.displayAggregate).not.toBeNull(); // samples count for display (D1)
    expect(r.realAggregate).toBeNull(); // and never for structured data
  });

  // Round 1 fix on Task 2.5 (F1): the review card lost its tour name when
  // converted off placeholder data, because the API didn't expose it.
  // `tourTitle` is now joined in — asserted against the real seeded tour
  // titles, not just "is a string", so a join to the wrong table/column
  // would actually fail this.
  it('reviews.published joins each review to its tour title', async () => {
    const db = getDb();
    const tourTitles = new Map(
      (await db.select({ id: toursTable.id, title: toursTable.title }).from(toursTable)).map(
        (t) => [t.id, t.title],
      ),
    );

    const r = await caller.reviews.published({});
    expect(r.items.length).toBeGreaterThan(0);
    for (const item of r.items) {
      expect(item.tourId).not.toBeNull();
      expect(item.tourTitle).toBe(tourTitles.get(item.tourId!));
    }
  });

  it('reviews.published returns tourTitle: null for a review with no tourId', async () => {
    const db = getDb();
    const [result] = await db.insert(reviewsTable).values({
      tourId: null,
      name: 'Fixture Reviewer — no tour',
      rating: 5,
      body: 'Fixture review with no associated tour.',
      status: 'published',
      isSample: false,
    });
    const fixtureId = result.insertId;

    try {
      const r = await caller.reviews.published({});
      const fixture = r.items.find((i) => i.id === fixtureId);
      expect(fixture).toBeDefined();
      expect(fixture!.tourId).toBeNull();
      expect(fixture!.tourTitle).toBeNull();
    } finally {
      await db.delete(reviewsTable).where(eq(reviewsTable.id, fixtureId));
    }
  });

  it('reviews.published issues a constant number of queries, not one per review (no N+1)', async () => {
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
      const r = await caller.reviews.published({});
      expect(r.items.length).toBeGreaterThan(0);
      // The show_tours read (BUG-124), the joined items query, plus
      // displayAggregate() and realAggregate() (run in parallel via
      // Promise.all) — fixed regardless of how many reviews exist, never
      // one query per review.
      expect(calls).toBe(4);
    } finally {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (pool as any).query = originalQuery;
    }
  });

  /**
   * BUG-124 (owner decision 3): while `show_tours` is off, a review card
   * must carry NO tour-identifying data — not just render none. `tourId` is
   * a sequential integer, so leaving it on the wire while only hiding
   * `tourTitle` in the UI would still let the catalog be enumerated from the
   * network response alone. Asserted on the PROCEDURE'S OWN OUTPUT, the same
   * way BUG-122's `forTour` fix is pinned — a DOM assertion could pass while
   * the field still leaked.
   */
  it('reviews.published nulls tourId and tourTitle while show_tours is off (BUG-124)', async () => {
    const db = getDb();
    await db.update(settingsTable).set({ value: false }).where(eq(settingsTable.key, 'show_tours'));
    try {
      const r = await caller.reviews.published({});
      expect(r.items.length).toBeGreaterThan(0);
      for (const item of r.items) {
        expect(item.tourId).toBeNull();
        expect(item.tourTitle).toBeNull();
      }
      // Nothing tour-identifying anywhere in the serialized payload either —
      // guards against a future field that also names the tour.
      expect(JSON.stringify(r.items)).not.toMatch(/"tourId":\d/);
    } finally {
      await db
        .update(settingsTable)
        .set({ value: true })
        .where(eq(settingsTable.key, 'show_tours'));
    }
  });

  /**
   * BUG-124, the input half (found by the dedicated reviewer of the fix
   * above). Nulling the row fields is not sufficient on its own: the
   * procedure's `tourId` INPUT also drove the `WHERE` and both aggregates,
   * so `{tourId: N}` while tours were hidden still answered that tour's real
   * average and review count — a non-null aggregate for an id is an
   * existence-and-popularity oracle over a sequential integer, which is the
   * whole of what BUG-124 is about, and the items being anonymized does not
   * undo it.
   *
   * While off, the filter is INERT: the tour-filtered call must be
   * indistinguishable from the unfiltered one, items and aggregates alike.
   * The ON premise is asserted rather than assumed — without it the whole
   * test could pass vacuously on a seed where one tour's aggregate happens
   * to equal the site's.
   */
  it('reviews.published ignores the tourId filter entirely while show_tours is off (BUG-124, input half)', async () => {
    const db = getDb();

    // The premise, ON: the filter really does narrow both the items and the
    // aggregate, so "identical while off" below is a real difference erased.
    const onAll = await caller.reviews.published({ limit: 50 });
    const firstWithTour = onAll.items.find((i) => i.tourId !== null);
    expect(firstWithTour).toBeDefined();
    const someTourId = firstWithTour!.tourId!;
    const onFiltered = await caller.reviews.published({ tourId: someTourId, limit: 50 });
    expect(onFiltered.items.length).toBeGreaterThan(0);
    expect(onFiltered.items.length).toBeLessThan(onAll.items.length);
    expect(onFiltered.displayAggregate!.count).toBeLessThan(onAll.displayAggregate!.count);

    await db.update(settingsTable).set({ value: false }).where(eq(settingsTable.key, 'show_tours'));
    try {
      const offFiltered = await caller.reviews.published({ tourId: someTourId, limit: 50 });
      const offAll = await caller.reviews.published({ limit: 50 });

      // Same rows, in the same order — the filter selected nothing.
      expect(offFiltered.items.map((i) => i.id)).toEqual(offAll.items.map((i) => i.id));
      // And the aggregates are the site-wide pair, never the tour's own.
      expect(offFiltered.displayAggregate).toEqual(offAll.displayAggregate);
      expect(offFiltered.realAggregate).toEqual(offAll.realAggregate);
      // Stated absolutely too, so a future refactor that merely made the two
      // calls agree on some OTHER tour-scoped number still goes red here.
      expect(offFiltered.displayAggregate!.count).toBe(onAll.displayAggregate!.count);
    } finally {
      await db
        .update(settingsTable)
        .set({ value: true })
        .where(eq(settingsTable.key, 'show_tours'));
    }
  });

  /**
   * ON leaves `published` exactly as it already was (owner decision 3's own
   * "ON -> unchanged" clause) — same real `tourId`/`tourTitle` as the
   * existing "joins each review to its tour title" test above, just also
   * pinned explicitly against the flag so a regression that always nulls
   * the fields (rather than only while off) goes red here.
   */
  it('reviews.published returns the real tourId and tourTitle while show_tours is on (unchanged)', async () => {
    const db = getDb();
    const tourTitles = new Map(
      (await db.select({ id: toursTable.id, title: toursTable.title }).from(toursTable)).map(
        (t) => [t.id, t.title],
      ),
    );

    const r = await caller.reviews.published({});
    const withTour = r.items.filter((i) => i.tourId !== null);
    expect(withTour.length).toBeGreaterThan(0);
    for (const item of withTour) {
      expect(item.tourTitle).toBe(tourTitles.get(item.tourId!));
    }
  });

  // Week 7 plan, Task 3: `packages.bySlug` backs `/packages/:slug`. Same
  // row shape as one entry of `packages.list` — no joins, because the
  // `packages` table has no child tables.
  it('packages.bySlug returns the package by slug, same shape as one row of list plus pageTitle', async () => {
    const [fromList] = await caller.packages.list();
    const detail = await caller.packages.bySlug({ slug: fromList!.slug });
    // `pageTitle` (Task 4, 1D) is `bySlug`'s own addition — carved out before
    // the equality check below, rather than widening `list`'s shape to match.
    const { pageTitle, ...detailWithoutPageTitle } = detail;
    expect(detailWithoutPageTitle).toEqual(fromList);
    expect(typeof pageTitle).toBe('string');
  });

  it('packages.bySlug throws NOT_FOUND for an unknown slug', async () => {
    await expect(caller.packages.bySlug({ slug: 'no-such-package' })).rejects.toThrow(/NOT_FOUND/);
  });

  /** Task 4 (1D) — same proof as tours.bySlug's: pageTitle is the formula's own output, not a re-derivation. */
  it('packages.bySlug publishes pageTitle computed via the packageTitle() formula (no override)', async () => {
    const slug = 'cebu-highlights-3d2n';
    const detail = await caller.packages.bySlug({ slug });

    expect(detail.seoTitle).toBeNull();
    expect(detail.pageTitle).toBe(
      `${detail.title} — ${detail.days}-day Cebu package from ${formatPeso(detail.newPriceCentavos)} | TravelSugbo`,
    );
  });

  /** The other branch of the same formula: an admin seo_title override wins outright. */
  it('packages.bySlug publishes pageTitle from the admin seo_title override when one is set', async () => {
    const db = getDb();
    const slug = 'cebu-highlights-3d2n';
    await db
      .update(packagesTable)
      .set({ seoTitle: 'Fixture Override Package Title' })
      .where(eq(packagesTable.slug, slug));

    try {
      const detail = await caller.packages.bySlug({ slug });
      expect(detail.pageTitle).toBe('Fixture Override Package Title');
    } finally {
      await db.update(packagesTable).set({ seoTitle: null }).where(eq(packagesTable.slug, slug));
    }
  });

  /** Packages' half of the same byte-identity proof as tours.bySlug's above. */
  it("packages.bySlug.pageTitle is byte-identical to resolvePage()'s cold-load <title> for the same route", async () => {
    const slug = 'cebu-bohol-5d4n';
    const { resolvePage } = await import('../seo/resolvers');

    const detail = await caller.packages.bySlug({ slug });
    const coldLoad = await resolvePage(`/packages/${slug}`);

    expect(detail.pageTitle).toBe(coldLoad.title);
  });

  it('packages.bySlug throws NOT_FOUND for a soft-deleted package', async () => {
    const db = getDb();
    const slug = 'cebu-highlights-3d2n';
    await db.update(packagesTable).set({ isActive: false }).where(eq(packagesTable.slug, slug));

    try {
      await expect(caller.packages.bySlug({ slug })).rejects.toThrow(/NOT_FOUND/);
    } finally {
      await db.update(packagesTable).set({ isActive: true }).where(eq(packagesTable.slug, slug));
    }
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
      // Exactly 5, proven by counting real pool.query() calls rather than
      // trusting a comment: the `show_tours` settings row (Task T15, read
      // first so a hidden catalog costs nothing more), the grouped
      // tours+destinations+min-price query, the batched first-image lookup,
      // the batched rating aggregates, and (Task 1.9, R1) the single
      // `trust` settings row for minReviewsForRating. Fixed regardless of
      // how many tours exist — never one per tour, which is the claim.
      expect(calls).toBe(5);
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

/**
 * `transferRoutes.featured` (owner decision 2026-11-13, Task 7 / 1D) —
 * "Popular transfers" home cards. Fixtures are inserted directly against
 * the tables rather than through `admin.transferRoutes.*` (admin-transfer-
 * routes.test.ts already proves that router writes these same columns
 * correctly) — this suite is about what the PUBLIC query does with rows
 * that already have them set, including the price-resolution rule
 * (CLAUDE.md: the server computes all money) that is unique to this
 * procedure.
 *
 * CLAUDE.md's dispatch section: "The test database keeps an EMPTY fleet" —
 * so every "offered" assertion here inserts its own `vans` row and cleans
 * it up, exactly like `transfer-capacity.test.ts` does, rather than relying
 * on any ambient fleet.
 */
describeWithDb('transferRoutes.featured (public, Task 7 / 1D)', () => {
  // Reuses the module-level `caller` (same `testContext()`) — a public
  // query needs no role, so there is nothing a second caller would add.
  const unique = () => `${Math.floor(Math.random() * 1e9)}_${Date.now()}`;

  const created = {
    placeIds: [] as number[],
    routeIds: [] as number[],
    vanIds: [] as number[],
  };

  let VAN_ID = 0;
  let SUV_ID = 0;

  async function vehicleTypeIdBySlug(slug: string): Promise<number> {
    const [row] = await getDb()
      .select({ id: vehicleTypes.id })
      .from(vehicleTypes)
      .where(eq(vehicleTypes.slug, slug))
      .limit(1);
    if (!row) throw new Error(`No vehicle_types row for slug "${slug}" — expected from seedBase.`);
    return row.id;
  }

  async function makePlace(opts: { isActive?: boolean } = {}) {
    const slug = `__pqtplace__${unique()}`;
    const [row] = await getDb()
      .insert(transferPlaces)
      .values({
        name: slug,
        nameKey: slug.toLowerCase(),
        isActive: opts.isActive ?? true,
        placeType: 'destination',
      });
    created.placeIds.push(row.insertId);
    return row.insertId;
  }

  /** A route inserted directly, with every home-page column named explicitly. */
  async function makeRoute(opts: {
    fromPlaceId?: number;
    toPlaceId?: number;
    isActive?: boolean;
    showOnHomePage?: boolean;
    homePageOrder?: number;
    homePageBadge?: string | null;
    homePageShortDescription?: string | null;
  }) {
    const fromPlaceId = opts.fromPlaceId ?? (await makePlace());
    const toPlaceId = opts.toPlaceId ?? (await makePlace());
    const [row] = await getDb()
      .insert(transferRoutes)
      .values({
        fromPlaceId,
        toPlaceId,
        slug: `pqt-${unique().replace('_', '-')}`,
        isActive: opts.isActive ?? true,
        estimatedDurationMinutes: 120,
        showOnHomePage: opts.showOnHomePage ?? false,
        homePageOrder: opts.homePageOrder ?? 0,
        homePageBadge: opts.homePageBadge ?? null,
        homePageShortDescription: opts.homePageShortDescription ?? null,
      });
    created.routeIds.push(row.insertId);
    return row.insertId;
  }

  async function makePrice(routeId: number, vehicleTypeId: number, oneWayPriceCentavos: number) {
    await getDb()
      .insert(transferRouteVehiclePrices)
      .values({
        routeId,
        vehicleTypeId,
        oneWayPriceCentavos,
        dayUsePriceCentavos: oneWayPriceCentavos * 2,
      });
  }

  async function makeVan(vehicleTypeId: number) {
    const suffix = unique();
    const [row] = await getDb()
      .insert(vans)
      .values({
        plate: `PQ${suffix}`.slice(0, 20),
        model: 'Featured Query Fixture',
        capacity: 10,
        vehicleTypeId,
        status: 'available',
        isActive: true,
      });
    created.vanIds.push(row.insertId);
    return row.insertId;
  }

  beforeAll(async () => {
    VAN_ID = await vehicleTypeIdBySlug('van');
    SUV_ID = await vehicleTypeIdBySlug('suv');
  }, 60_000);

  /*
   * Vans are cleaned up after EVERY test, not only at the end of the suite
   * — `sellableVehiclesByType()` counts the WHOLE fleet, with no per-route
   * scoping, so a van left behind by one test (e.g. "prefers the VAN
   * price...") would make every vehicle type of that id look sellable to
   * every later test in this file, including the one that specifically
   * asserts "not sellable right now". Measured directly: without this,
   * "omits a vehicle type priced but not sellable..." failed once a VAN_ID
   * van from an earlier test was still standing. CLAUDE.md: "The test
   * database keeps an EMPTY fleet" — restored here after each test, exactly
   * as `transfer-capacity.test.ts`'s own `afterEach(cleanup)` does.
   */
  afterEach(async () => {
    if (created.vanIds.length > 0) {
      await getDb().delete(vans).where(inArray(vans.id, created.vanIds));
      created.vanIds.length = 0;
    }
  });

  afterAll(async () => {
    const db = getDb();
    if (created.routeIds.length > 0) {
      await db
        .delete(transferRouteVehiclePrices)
        .where(inArray(transferRouteVehiclePrices.routeId, created.routeIds));
      await db.delete(transferRoutes).where(inArray(transferRoutes.id, created.routeIds));
    }
    if (created.placeIds.length > 0) {
      await db.delete(transferPlaces).where(inArray(transferPlaces.id, created.placeIds));
    }
  });

  it('returns an empty array when nothing is featured', async () => {
    // Every route this suite creates defaults to showOnHomePage: false, and
    // nothing else in this describe block has run yet at this point in
    // file order — but asserted directly against a route made and
    // confirmed NOT featured, rather than assumed from suite ordering.
    const routeId = await makeRoute({ showOnHomePage: false });
    const result = await caller.transferRoutes.featured();
    expect(result.find((r) => r.id === routeId)).toBeUndefined();
  });

  it('returns only active, show-on-home-page routes, ordered by homePageOrder', async () => {
    const notFeatured = await makeRoute({ showOnHomePage: false });
    const inactiveButFeatured = await makeRoute({ showOnHomePage: true, isActive: false });
    const second = await makeRoute({ showOnHomePage: true, homePageOrder: 5 });
    const first = await makeRoute({ showOnHomePage: true, homePageOrder: 1 });

    const result = await caller.transferRoutes.featured();
    const ids = result.map((r) => r.id);

    expect(ids).not.toContain(notFeatured);
    expect(ids).not.toContain(inactiveButFeatured);
    expect(ids.indexOf(first)).toBeLessThan(ids.indexOf(second));
  });

  it('picks the genuine lowest price across every offered type, not the van specifically', async () => {
    const routeId = await makeRoute({ showOnHomePage: true, homePageBadge: 'Most booked' });
    // Van priced HIGHER than SUV — the server must pick the SUV's lower price,
    // not prefer the van just because a van is offered (owner QA, 2026-11-14).
    await makePrice(routeId, VAN_ID, 620_000);
    await makePrice(routeId, SUV_ID, 570_000);
    await makeVan(VAN_ID);
    await makeVan(SUV_ID);

    const result = await caller.transferRoutes.featured();
    const card = result.find((r) => r.id === routeId);
    expect(card).toBeDefined();
    expect(card!.badge).toBe('Most booked');
    expect(card!.cheapestOneWay).toEqual({ vehicleTypeName: 'SUV', priceCentavos: 570_000 });
  });

  it("returns the one offered type's price when only one vehicle type is priced", async () => {
    const routeId = await makeRoute({ showOnHomePage: true });
    // No van price row at all on this route — only SUV.
    await makePrice(routeId, SUV_ID, 320_000);
    await makeVan(SUV_ID);

    const result = await caller.transferRoutes.featured();
    const card = result.find((r) => r.id === routeId);
    expect(card).toBeDefined();
    expect(card!.cheapestOneWay).toEqual({ vehicleTypeName: 'SUV', priceCentavos: 320_000 });
  });

  it('omits a vehicle type priced but not sellable, and reports "no vehicle" (null) when nothing is sellable at all', async () => {
    const routeId = await makeRoute({ showOnHomePage: true });
    // Priced, but no van row inserted — not sellable right now.
    await makePrice(routeId, VAN_ID, 250_000);

    const result = await caller.transferRoutes.featured();
    const card = result.find((r) => r.id === routeId);
    expect(card).toBeDefined();
    expect(card!.offeredVehicles).toEqual([]);
    expect(card!.cheapestOneWay).toBeNull();
  });
});
