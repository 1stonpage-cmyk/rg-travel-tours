/**
 * Week 7 plan, Task 6 — `admin.tours.*`: the tour, its price tiers, images,
 * itinerary stops and add-ons (BUILD_SPEC §9 "Tours & pricing", server half).
 *
 * **This suite writes money.** `tour_price_tiers.price_per_person_centavos` is
 * the number `checkout.quote` multiplies by a party size, so three of the
 * blocks below are about nothing else: that a price arrives as integer
 * centavos or not at all, that two tiers can never both match one party size,
 * and that a refused save leaves the tour's existing prices exactly where they
 * were.
 *
 * Role refusals are asserted on `code`, never on the message (the pattern
 * `admin-drivers.test.ts` and `admin-vans.test.ts` already follow):
 * `requireRole()` throws messages that name neither UNAUTHORIZED nor
 * FORBIDDEN, so a regex on the message can pass against broken code.
 *
 * **Teardown.** Every tour this file creates is tracked by id AND swept by
 * slug prefix, because the two catch different failures: the ids catch the
 * tours the tests meant to make, and the prefix sweep catches the ones a
 * BROKEN build made — a role gate that let a refused `create` through writes a
 * tour nothing tracked, and `public-queries.test.ts` asserts the catalog holds
 * exactly six tours.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, asc, eq, inArray, like } from 'drizzle-orm';
import type { PriceSnapshot } from '@rg/shared';
import { appRouter } from '../routers/_app';
import { getDb, getPool } from '../db/client';
import {
  auditLog,
  bookingAddons,
  bookings,
  destinations,
  tourAddons,
  tourImages,
  tourItineraryStops,
  tourPriceTiers,
  tours,
  tripCheckpoints,
  users,
} from '../db/schema';
import { generateBookingRef } from '../services/booking-ref';
import { upsertTourContent } from '../services/tours/upsert';
import { staffContext, testContext } from './helpers/ctx';
import { describeWithDb } from './helpers/db';

/**
 * Every tour this file creates carries it, so the sweep in `afterAll` finds
 * them. Hyphens and lowercase only: a slug is a URL segment and
 * `tourCreateInput` enforces that shape, so an underscore-prefixed fixture
 * would be refused at the Zod boundary and every test below would pass or fail
 * for the wrong reason.
 */
const SLUG_PREFIX = 'adm-tour-';

const created = {
  userIds: [] as number[],
  tourIds: [] as number[],
  destinationIds: [] as number[],
  /** Bookings the history block below makes, so its FK rows can be unwound. */
  bookingIds: [] as number[],
};

/** Slug-safe: digits and hyphens, so it can be pasted into a tour slug. */
const unique = () => `${Math.floor(Math.random() * 1e9)}-${Date.now()}`;

async function makeStaff(role: 'owner' | 'dispatcher' | 'finance') {
  const suffix = unique();
  const [row] = await getDb()
    .insert(users)
    .values({
      name: `Admin ${role} ${suffix}`,
      email: `admtour_${role}_${suffix}@example.test`,
      passwordHash: '__admtour_fixture_not_a_hash__',
      role,
      isActive: true,
    });
  created.userIds.push(row.insertId);
  return row.insertId;
}

let ownerId = 0;
let dispatcherId = 0;
let financeId = 0;
let destinationId = 0;

const ownerApi = () => appRouter.createCaller(staffContext(ownerId, 'owner') as never);
const publicApi = () => appRouter.createCaller(testContext(null) as never);

/** Every field `tourCreateInput` requires, with two non-overlapping tiers. */
function tourInput(overrides: Record<string, unknown> = {}) {
  const suffix = unique();
  return {
    slug: `${SLUG_PREFIX}${suffix}`,
    title: `Admin Tour ${suffix}`,
    destinationId,
    summary: 'A fixture tour for the admin editing surface.',
    about: null,
    inclusions: ['Van transfer', 'Driver'],
    exclusions: null,
    durationHours: 10,
    groupsPerDay: 1,
    maxGuests: 12,
    freeCancelHours: 48,
    isFeatured: false,
    sortOrder: 0,
    badge: 'none' as const,
    alertNote: null,
    seoTitle: null,
    seoDescription: null,
    ogImage: null,
    priceTiers: [
      { minPax: 1, maxPax: 2, pricePerPersonCentavos: 350_000 },
      { minPax: 3, maxPax: 6, pricePerPersonCentavos: 250_000 },
    ],
    images: [
      {
        path: '/placeholders/tour-fixture.svg',
        alt: 'Placeholder image for a fixture tour',
        width: 1200,
        height: 800,
        sortOrder: 0,
      },
    ],
    itinerary: [
      { sortOrder: 0, name: 'Hotel pickup', description: 'Cebu City hotels.' },
      { sortOrder: 1, name: 'Tumalog Falls', description: null },
    ],
    addons: [{ name: 'Packed lunch', priceCentavos: 50_000, perPerson: true, isActive: true }],
    ...overrides,
  };
}

/** Creates a tour through the real mutation and tracks it for teardown. */
async function createTour(overrides: Record<string, unknown> = {}) {
  const input = tourInput(overrides);
  const { id } = await ownerApi().admin.tours.create(input as never);
  created.tourIds.push(id);
  return { id, input };
}

async function tourIdBySlug(slug: string): Promise<number | undefined> {
  const [row] = await getDb().select({ id: tours.id }).from(tours).where(eq(tours.slug, slug));
  return row?.id;
}

async function tierRowsFor(tourId: number) {
  return getDb()
    .select({
      minPax: tourPriceTiers.minPax,
      maxPax: tourPriceTiers.maxPax,
      pricePerPersonCentavos: tourPriceTiers.pricePerPersonCentavos,
    })
    .from(tourPriceTiers)
    .where(eq(tourPriceTiers.tourId, tourId))
    .orderBy(asc(tourPriceTiers.minPax));
}

async function auditRowsForTour(tourId: number) {
  return getDb()
    .select({
      action: auditLog.action,
      actorType: auditLog.actorType,
      actorId: auditLog.actorId,
      data: auditLog.data,
    })
    .from(auditLog)
    .where(and(eq(auditLog.entity, 'tour'), eq(auditLog.entityId, tourId)))
    .orderBy(asc(auditLog.id));
}

async function addonRowsFor(tourId: number) {
  return getDb()
    .select({
      id: tourAddons.id,
      name: tourAddons.name,
      priceCentavos: tourAddons.priceCentavos,
      isActive: tourAddons.isActive,
    })
    .from(tourAddons)
    .where(eq(tourAddons.tourId, tourId))
    .orderBy(asc(tourAddons.id));
}

async function stopRowsFor(tourId: number) {
  return getDb()
    .select({
      id: tourItineraryStops.id,
      sortOrder: tourItineraryStops.sortOrder,
      name: tourItineraryStops.name,
    })
    .from(tourItineraryStops)
    .where(eq(tourItineraryStops.tourId, tourId))
    .orderBy(asc(tourItineraryStops.sortOrder), asc(tourItineraryStops.id));
}

/** The minimum snapshot `bookings.price_snapshot` accepts. No test reads it. */
const SNAPSHOT: PriceSnapshot = {
  tier: { tierId: 1, minPax: 1, maxPax: 12, pricePerPersonCentavos: 100_000 },
  addons: [],
  coupon: null,
  depositPercent: 30,
  freeCancelHours: 48,
  subtotalCentavos: 100_000,
  discountCentavos: 0,
  totalCentavos: 100_000,
};

/** A committed booking on `tourId`, so its FK rows have something to hang on. */
async function makeBooking(tourId: number) {
  const [row] = await getDb()
    .insert(bookings)
    .values({
      ref: generateBookingRef(),
      tourId,
      tourDate: new Date('2026-12-05T00:00:00Z'),
      pax: 2,
      leadName: 'Tours Fixture',
      leadEmail: 'fixture@example.test',
      leadPhone: '09170000000',
      status: 'confirmed',
      payMode: 'full',
      priceSnapshot: SNAPSHOT,
      subtotalCentavos: 100_000,
      totalCentavos: 100_000,
    });
  created.bookingIds.push(row.insertId);
  return row.insertId;
}

beforeAll(async () => {
  ownerId = await makeStaff('owner');
  dispatcherId = await makeStaff('dispatcher');
  financeId = await makeStaff('finance');

  const slug = `adm-dest-${unique()}`;
  const [row] = await getDb().insert(destinations).values({ name: slug, slug, isActive: true });
  destinationId = row.insertId;
  created.destinationIds.push(destinationId);
}, 60_000);

afterAll(async () => {
  const db = getDb();

  /*
   * The prefix sweep comes FIRST and is the authority: it finds every tour
   * this file's slug convention owns, including one a broken build created
   * through a refusal that should have blocked it. The tracked ids are
   * unioned in so a test that renamed its own slug is still cleaned up.
   */
  const swept = await db
    .select({ id: tours.id })
    .from(tours)
    .where(like(tours.slug, `${SLUG_PREFIX}%`));
  const tourIds = [...new Set([...created.tourIds, ...swept.map((row) => row.id)])];

  /*
   * The FK rows FIRST, and in this order: `booking_addons.addon_id` and
   * `trip_checkpoints.stop_id` are the very RESTRICT constraints this suite
   * exists to exercise, so the tour's add-ons and stops cannot be removed while
   * they stand — and `bookings` cannot go until both are gone either.
   *
   * `bookings` and `trip_checkpoints` are both in the leak detector's
   * `LEAK_TABLES`, so a miss here fails the run by name rather than quietly.
   */
  if (created.bookingIds.length > 0) {
    await db.delete(bookingAddons).where(inArray(bookingAddons.bookingId, created.bookingIds));
    await db.delete(tripCheckpoints).where(inArray(tripCheckpoints.bookingId, created.bookingIds));
    const pool = getPool();
    for (const id of created.bookingIds) {
      // Raw parameterized SQL, not `db.delete(bookings)` — `schema-conventions
      // .test.ts` scans the whole server tree for the Drizzle form of a
      // bookings hard-delete and exempts only the raw form in a test file.
      await pool.query('DELETE FROM bookings WHERE id = ?', [id]);
    }
  }

  if (tourIds.length > 0) {
    await db.delete(tourPriceTiers).where(inArray(tourPriceTiers.tourId, tourIds));
    await db.delete(tourImages).where(inArray(tourImages.tourId, tourIds));
    await db.delete(tourItineraryStops).where(inArray(tourItineraryStops.tourId, tourIds));
    await db.delete(tourAddons).where(inArray(tourAddons.tourId, tourIds));
    await db
      .delete(auditLog)
      .where(and(eq(auditLog.entity, 'tour'), inArray(auditLog.entityId, tourIds)));
    await db.delete(tours).where(inArray(tours.id, tourIds));
  }
  if (created.destinationIds.length > 0) {
    await db.delete(destinations).where(inArray(destinations.id, created.destinationIds));
  }

  const pool = getPool();
  for (const id of created.userIds) {
    await pool.query('DELETE FROM sessions WHERE subject_type = ? AND subject_id = ?', [
      'user',
      id,
    ]);
    await pool.query('DELETE FROM users WHERE id = ?', [id]);
  }
});

describeWithDb('admin.tours', () => {
  /* ------------------------------------------------------------------ *
   * Create and read back
   * ------------------------------------------------------------------ */

  it('creates a tour with every child row and reads it all back', async () => {
    const { id, input } = await createTour();
    const detail = await ownerApi().admin.tours.detail({ id });

    expect(detail).toMatchObject({
      id,
      slug: input.slug,
      title: input.title,
      destinationId,
      summary: input.summary,
      durationHours: 10,
      groupsPerDay: 1,
      maxGuests: 12,
      freeCancelHours: 48,
      badge: 'none',
      isFeatured: false,
      // Not in the input — a new tour is live unless `setActive` says otherwise.
      isActive: true,
    });
    expect(detail.inclusions).toEqual(['Van transfer', 'Driver']);
    expect(detail.exclusions).toBeNull();

    // Tiers come back minPax-ascending, the order `checkout.quote` reads them in.
    expect(detail.priceTiers.map((t) => [t.minPax, t.maxPax, t.pricePerPersonCentavos])).toEqual([
      [1, 2, 350_000],
      [3, 6, 250_000],
    ]);
    expect(detail.images.map((i) => [i.path, i.alt, i.width, i.height])).toEqual([
      ['/placeholders/tour-fixture.svg', 'Placeholder image for a fixture tour', 1200, 800],
    ]);
    expect(detail.itinerary.map((s) => [s.sortOrder, s.name, s.description])).toEqual([
      [0, 'Hotel pickup', 'Cebu City hotels.'],
      [1, 'Tumalog Falls', null],
    ]);
    expect(detail.addons.map((a) => [a.name, a.priceCentavos, a.perPerson, a.isActive])).toEqual([
      ['Packed lunch', 50_000, true, true],
    ]);

    // Every child row carries a real id: Task 7's screen keys and edits rows
    // by it, and `removeLeave`'s missing-id lesson (Week 5) is why this is
    // asserted rather than assumed.
    for (const row of [
      ...detail.priceTiers,
      ...detail.images,
      ...detail.itinerary,
      ...detail.addons,
    ]) {
      expect(row.id).toBeGreaterThan(0);
    }
  });

  it('lists the tour it just created, with its lowest tier as the from-price', async () => {
    const { id, input } = await createTour();
    const listed = await ownerApi().admin.tours.list();
    const mine = listed.find((row) => row.id === id);
    expect(mine, 'the tour just created must be listed').toBeDefined();
    expect(mine).toMatchObject({
      slug: input.slug,
      title: input.title,
      isActive: true,
      // MIN across the two tiers, not the first one.
      fromPriceCentavos: 250_000,
      priceTierCount: 2,
    });
    expect(mine!.destination).toMatchObject({ id: destinationId });
  });

  /* ------------------------------------------------------------------ *
   * The role gate — §9's `toursPricing` row is OWNER ONLY
   * ------------------------------------------------------------------ */

  for (const role of ['dispatcher', 'finance'] as const) {
    it(`REFUSES a ${role} on every tours procedure, and writes nothing`, async () => {
      const id = role === 'dispatcher' ? dispatcherId : financeId;
      const api = appRouter.createCaller(staffContext(id, role) as never);
      const input = tourInput();

      const refusals = await Promise.all([
        api.admin.tours.list().catch((e: unknown) => e),
        api.admin.tours.detail({ id: 1 }).catch((e: unknown) => e),
        api.admin.tours.create(input as never).catch((e: unknown) => e),
        api.admin.tours.update({ ...input, id: 1 } as never).catch((e: unknown) => e),
        api.admin.tours.setActive({ id: 1, isActive: false }).catch((e: unknown) => e),
      ]);

      expect(refusals).toHaveLength(5);
      for (const refusal of refusals) {
        expect(refusal).toMatchObject({ code: 'FORBIDDEN' });
      }
      // Hiding a button is not access control: the refused `create` must have
      // written no tour at all.
      expect(await tourIdBySlug(input.slug)).toBeUndefined();
    });
  }

  it('REFUSES an anonymous caller with UNAUTHORIZED', async () => {
    await expect(publicApi().admin.tours.list()).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  });

  /* ------------------------------------------------------------------ *
   * Money: the tiers
   * ------------------------------------------------------------------ */

  it('REFUSES overlapping price tiers and writes NOTHING', async () => {
    // 4 is in both ranges, so `checkout.quote`'s "the tier where
    // min_pax <= pax <= max_pax" would have two answers for a party of four.
    const input = tourInput({
      priceTiers: [
        { minPax: 1, maxPax: 4, pricePerPersonCentavos: 350_000 },
        { minPax: 4, maxPax: 8, pricePerPersonCentavos: 250_000 },
      ],
    });

    await expect(ownerApi().admin.tours.create(input as never)).rejects.toMatchObject({
      code: 'CONFLICT',
    });

    // Nothing at all: not the tour, so not its tiers either.
    expect(await tourIdBySlug(input.slug)).toBeUndefined();
  });

  it('REFUSES a tier range fully contained in another', async () => {
    const input = tourInput({
      priceTiers: [
        { minPax: 1, maxPax: 12, pricePerPersonCentavos: 350_000 },
        { minPax: 3, maxPax: 6, pricePerPersonCentavos: 250_000 },
      ],
    });
    await expect(ownerApi().admin.tours.create(input as never)).rejects.toMatchObject({
      code: 'CONFLICT',
    });
    expect(await tourIdBySlug(input.slug)).toBeUndefined();
  });

  it('accepts adjacent tiers that only touch at the boundary', async () => {
    // [1,3] and [4,6] do NOT overlap — the refusal must not be so eager that
    // a normal three-tier price card becomes unsavable.
    const { id } = await createTour({
      priceTiers: [
        { minPax: 1, maxPax: 3, pricePerPersonCentavos: 400_000 },
        { minPax: 4, maxPax: 6, pricePerPersonCentavos: 300_000 },
        { minPax: 7, maxPax: 12, pricePerPersonCentavos: 200_000 },
      ],
    });
    expect(await tierRowsFor(id)).toHaveLength(3);
  });

  it('leaves an existing tour PRICES untouched when an update is refused', async () => {
    const { id } = await createTour();
    const before = await tierRowsFor(id);

    await expect(
      ownerApi().admin.tours.update({
        ...tourInput({
          priceTiers: [
            { minPax: 1, maxPax: 6, pricePerPersonCentavos: 1 },
            { minPax: 2, maxPax: 9, pricePerPersonCentavos: 2 },
          ],
        }),
        id,
      } as never),
    ).rejects.toMatchObject({ code: 'CONFLICT' });

    // The delete-then-reinsert must not have run its delete: a tour left with
    // no tiers cannot be quoted at all, which is worse than a refused edit.
    expect(await tierRowsFor(id)).toEqual(before);
  });

  it('REFUSES a tier price that is not an integer number of centavos', async () => {
    for (const price of [1999.5, '1999.5', -1, null]) {
      const input = tourInput({
        priceTiers: [{ minPax: 1, maxPax: 12, pricePerPersonCentavos: price }],
      });
      await expect(
        ownerApi().admin.tours.create(input as never),
        `pricePerPersonCentavos ${String(price)} was accepted`,
      ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
      expect(await tourIdBySlug(input.slug)).toBeUndefined();
    }
  });

  it('REFUSES a tier whose minPax is above its maxPax', async () => {
    const input = tourInput({
      priceTiers: [{ minPax: 8, maxPax: 4, pricePerPersonCentavos: 250_000 }],
    });
    await expect(ownerApi().admin.tours.create(input as never)).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
    expect(await tourIdBySlug(input.slug)).toBeUndefined();
  });

  it('REFUSES an addon price that is not an integer number of centavos', async () => {
    const input = tourInput({
      addons: [{ name: 'Lunch', priceCentavos: 499.99, perPerson: true, isActive: true }],
    });
    await expect(ownerApi().admin.tours.create(input as never)).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
    expect(await tourIdBySlug(input.slug)).toBeUndefined();
  });

  /* ------------------------------------------------------------------ *
   * Update — a save states the whole set, inside one transaction
   * ------------------------------------------------------------------ */

  /**
   * A save states the whole set rather than patching it, and **how that set is
   * applied differs per table** (review fix, 2026-10-24). This test owns the
   * two tables nothing references, which really are replaced wholesale; the
   * `with bookings and check-ins already attached` block below owns the two
   * that cannot be.
   *
   * An earlier version of this test also asserted `detail.addons` became `[]`,
   * which is no longer the contract: a dropped add-on is DEACTIVATED, because a
   * guest may already have bought it. That half moved to the block below, which
   * asserts the stronger thing — the row survives, switched off, with the id
   * `booking_addons` points at.
   */
  it('REPLACES tiers and images wholesale rather than appending to them', async () => {
    const { id, input } = await createTour();

    await expect(
      ownerApi().admin.tours.update({
        ...input,
        id,
        title: 'Renamed by the update',
        priceTiers: [{ minPax: 1, maxPax: 12, pricePerPersonCentavos: 199_900 }],
        images: [],
        itinerary: [{ sortOrder: 0, name: 'Only stop', description: null }],
        addons: [],
      } as never),
    ).resolves.toEqual({ ok: true });

    const detail = await ownerApi().admin.tours.detail({ id });
    expect(detail.title).toBe('Renamed by the update');
    expect(detail.priceTiers.map((t) => t.pricePerPersonCentavos)).toEqual([199_900]);
    expect(detail.images).toEqual([]);
    // Both original stops were dropped and neither had a check-in, so they are
    // really gone and the one new stop is all that is left.
    expect(detail.itinerary.map((s) => s.name)).toEqual(['Only stop']);
    // The add-on is off, not gone — and `detail` still returns it, which is
    // what lets the screen switch it back on.
    expect(detail.addons.map((a) => a.isActive)).toEqual([false]);
    // Which is what the PUBLIC route cares about: nothing left to sell.
    const published = await publicApi().tours.bySlug({ slug: input.slug });
    expect(published.addons).toEqual([]);
  });

  /**
   * BUG-045's shape, which this task was told not to repeat: the seed's
   * `upsertTour` does its delete-then-reinsert of tiers and images with no
   * transaction at all, so a failure between the two leaves a tour with no
   * prices.
   *
   * `upsertTourContent` takes the transaction its caller already opened and
   * must use THAT handle for every write, parent and children alike. The proof
   * is to roll the caller's transaction back and find nothing: a child insert
   * that reached for `getDb()` instead of `tx` would survive this, and so
   * would a parent insert in its own nested transaction.
   */
  it('writes the tour and every child row inside the CALLER transaction', async () => {
    const input = tourInput();
    let seenId = 0;

    await expect(
      getDb().transaction(async (tx) => {
        const result = await upsertTourContent(tx, input as never);
        seenId = result.id;
        /*
         * Tracked even though this id is about to be rolled back: if the
         * boundary is ever broken, the child rows survive while the `tours`
         * row does not, so the slug sweep cannot find them and only this id
         * can. (Measured — breaking the boundary on purpose left exactly
         * those orphans behind.)
         */
        created.tourIds.push(seenId);
        // Inside the transaction the rows exist...
        expect(seenId).toBeGreaterThan(0);
        throw new Error('forced rollback');
      }),
    ).rejects.toThrow('forced rollback');

    // ...and after the rollback none of them do.
    expect(await tourIdBySlug(input.slug)).toBeUndefined();
    expect(await tierRowsFor(seenId)).toEqual([]);
    expect(await getDb().select().from(tourImages).where(eq(tourImages.tourId, seenId))).toEqual(
      [],
    );
    expect(
      await getDb().select().from(tourItineraryStops).where(eq(tourItineraryStops.tourId, seenId)),
    ).toEqual([]);
    expect(await getDb().select().from(tourAddons).where(eq(tourAddons.tourId, seenId))).toEqual(
      [],
    );
  });

  /* ------------------------------------------------------------------ *
   * Soft delete
   * ------------------------------------------------------------------ */

  it('setActive(false) hides the tour from the public catalog but not from admin.tours.list', async () => {
    const { id, input } = await createTour();

    const before = await publicApi().tours.list({});
    expect(
      before.some((t) => t.slug === input.slug),
      'a live tour is in the catalog',
    ).toBe(true);

    await expect(ownerApi().admin.tours.setActive({ id, isActive: false })).resolves.toEqual({
      ok: true,
    });

    const after = await publicApi().tours.list({});
    expect(after.some((t) => t.slug === input.slug)).toBe(false);
    await expect(publicApi().tours.bySlug({ slug: input.slug })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });

    // The admin screen still has to see it in order to switch it back on.
    const listed = await ownerApi().admin.tours.list();
    expect(listed.find((row) => row.id === id)).toMatchObject({ isActive: false });

    // Soft delete, never a delete: the row and its prices are all still there.
    expect(await tierRowsFor(id)).toHaveLength(2);

    // And back on again.
    await ownerApi().admin.tours.setActive({ id, isActive: true });
    const restored = await publicApi().tours.list({});
    expect(restored.some((t) => t.slug === input.slug)).toBe(true);
  });

  /* ------------------------------------------------------------------ *
   * Audit
   * ------------------------------------------------------------------ */

  it('writes exactly ONE audit row per mutation, naming the actor and the prices', async () => {
    const { id, input } = await createTour();
    expect(await auditRowsForTour(id)).toHaveLength(1);

    await ownerApi().admin.tours.update({
      ...input,
      id,
      priceTiers: [{ minPax: 1, maxPax: 12, pricePerPersonCentavos: 111_100 }],
    } as never);
    await ownerApi().admin.tours.setActive({ id, isActive: false });
    await ownerApi().admin.tours.setActive({ id, isActive: true });

    const rows = await auditRowsForTour(id);
    expect(rows.map((row) => row.action)).toEqual([
      'tour.created',
      'tour.updated',
      'tour.deactivated',
      'tour.reactivated',
    ]);
    for (const row of rows) {
      expect(row).toMatchObject({ actorType: 'user', actorId: ownerId });
    }
    // The money that changed is in the row — a price edit nobody can trace is
    // the one kind of change this log exists for.
    expect(rows[1]!.data).toMatchObject({
      slug: input.slug,
      priceTiers: [{ minPax: 1, maxPax: 12, pricePerPersonCentavos: 111_100 }],
    });
    // Identifiers and what changed, not a dump of the tour's prose.
    expect(JSON.stringify(rows)).not.toContain('A fixture tour for the admin editing surface.');
  });

  it('audits NOTHING when a mutation is refused', async () => {
    const { id } = await createTour();
    const before = await auditRowsForTour(id);

    await expect(
      ownerApi().admin.tours.update({
        ...tourInput(),
        id,
        priceTiers: [
          { minPax: 1, maxPax: 6, pricePerPersonCentavos: 1 },
          { minPax: 5, maxPax: 9, pricePerPersonCentavos: 2 },
        ],
      } as never),
    ).rejects.toMatchObject({ code: 'CONFLICT' });

    expect(await auditRowsForTour(id)).toEqual(before);
  });

  /* ------------------------------------------------------------------ *
   * Refusals that are not about money
   * ------------------------------------------------------------------ */

  it('REFUSES a duplicate slug with CONFLICT and leaves the first tour alone', async () => {
    const { id, input } = await createTour();
    await expect(
      ownerApi().admin.tours.create(tourInput({ slug: input.slug }) as never),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(await tourIdBySlug(input.slug)).toBe(id);
  });

  it('answers NOT_FOUND for a tour that does not exist', async () => {
    const api = ownerApi();
    await expect(api.admin.tours.detail({ id: 2_000_000_000 })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    await expect(
      api.admin.tours.update({ ...tourInput(), id: 2_000_000_000 } as never),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(
      api.admin.tours.setActive({ id: 2_000_000_000, isActive: false }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('REFUSES a destination that does not exist, rather than a 500 from the foreign key', async () => {
    const input = tourInput({ destinationId: 2_000_000_000 });
    await expect(ownerApi().admin.tours.create(input as never)).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
    expect(await tourIdBySlug(input.slug)).toBeUndefined();
  });

  it('REFUSES an unexpected key at the Zod boundary, so no column can be smuggled in', async () => {
    const input = tourInput({ isActive: false });
    await expect(ownerApi().admin.tours.create(input as never)).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
    expect(await tourIdBySlug(input.slug)).toBeUndefined();
  });

  /* ------------------------------------------------------------------ *
   * A tour that has HISTORY — the RESTRICT foreign keys
   * (review finding, 2026-10-24)
   * ------------------------------------------------------------------ */

  /**
   * Every test above builds a brand-new tour, and the test database ships no
   * itinerary stops and no bookings — so every one of them exercised a tour
   * with **no history**, and all of them passed while
   * `admin.tours.update` was a permanent 500 for any tour a guest or a driver
   * had actually touched.
   *
   * Two rows elsewhere in the schema reference the tour's children, both
   * `ON DELETE RESTRICT` (verified against the live schema):
   *
   * ```
   * booking_addons.addon_id  -> tour_addons.id
   * trip_checkpoints.stop_id -> tour_itinerary_stops.id
   * ```
   *
   * So the wholesale `DELETE FROM tour_addons WHERE tour_id = ?` failed with
   * `ER_ROW_IS_REFERENCED_2` (errno 1451) the first time anyone bought an
   * add-on, and the stops delete failed the first time a driver checked in.
   * Neither is an `ER_DUP_ENTRY`, so it was rethrown raw as an
   * `INTERNAL_SERVER_ERROR`.
   *
   * This block is the fixture that was missing. The first two tests fail
   * against the pre-fix code with that exact MySQL error, which is what makes
   * them a proof rather than a restatement.
   */
  describe('with bookings and check-ins already attached', () => {
    /** A tour with one add-on a guest has bought, and no itinerary stops. */
    async function tourWithSoldAddon() {
      const { id } = await createTour({ itinerary: [] });
      const detail = await ownerApi().admin.tours.detail({ id });
      const addonId = detail.addons[0]!.id;
      const bookingId = await makeBooking(id);
      await getDb().insert(bookingAddons).values({
        bookingId,
        addonId,
        // The snapshot columns §5 requires: the add-on may be renamed later.
        name: 'Packed lunch',
        priceCentavos: 50_000,
        perPerson: true,
        qty: 2,
      });
      return { id, detail, addonId, bookingId };
    }

    /** A tour whose FIRST stop a driver has checked in at. */
    async function tourWithCheckIn() {
      const { id } = await createTour();
      const detail = await ownerApi().admin.tours.detail({ id });
      const stopId = detail.itinerary[0]!.id;
      const bookingId = await makeBooking(id);
      await getDb()
        .insert(tripCheckpoints)
        .values({ bookingId, stopId, checkedAt: new Date('2026-12-05T01:00:00Z') });
      return { id, detail, stopId, bookingId };
    }

    /** The input shape that keeps every stop `detail` returned, ids and all. */
    const keepStops = (detail: { itinerary: { id: number; sortOrder: number; name: string }[] }) =>
      detail.itinerary.map((stop) => ({
        id: stop.id,
        sortOrder: stop.sortOrder,
        name: stop.name,
        description: null,
      }));

    it('DEACTIVATES an add-on a guest already bought, instead of failing on the foreign key', async () => {
      const { id, detail, addonId, bookingId } = await tourWithSoldAddon();

      // Dropping the add-on from the save. Before the fix this was
      // `DELETE FROM tour_addons WHERE tour_id = ?` → ER_ROW_IS_REFERENCED_2.
      await expect(
        ownerApi().admin.tours.update({
          ...tourInput({ slug: detail.slug, itinerary: [], addons: [] }),
          id,
        } as never),
      ).resolves.toEqual({ ok: true });

      // The row is still there, same id, switched off — never deleted.
      const rows = await addonRowsFor(id);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ id: addonId, isActive: false });

      // And the guest's line still resolves to it: that is what the FK was for.
      const lines = await getDb()
        .select({ addonId: bookingAddons.addonId, name: bookingAddons.name })
        .from(bookingAddons)
        .where(eq(bookingAddons.bookingId, bookingId));
      expect(lines).toEqual([{ addonId, name: 'Packed lunch' }]);

      // It is off the public tour too — `tours.bySlug` filters on `is_active`,
      // so "deactivated" really does mean "no longer sold".
      const published = await publicApi().tours.bySlug({ slug: detail.slug });
      expect(published.addons).toEqual([]);

      // The save says what it did to history, in the audit row.
      const audit = await auditRowsForTour(id);
      expect(audit.at(-1)).toMatchObject({
        action: 'tour.updated',
        data: { addonsDeactivated: 1, stopsRemoved: 0 },
      });
    });

    it('REVIVES a deactivated add-on when it is posted back by id', async () => {
      const { id, detail, addonId } = await tourWithSoldAddon();
      await ownerApi().admin.tours.update({
        ...tourInput({ slug: detail.slug, itinerary: [], addons: [] }),
        id,
      } as never);
      expect((await addonRowsFor(id))[0]).toMatchObject({ isActive: false });

      await ownerApi().admin.tours.update({
        ...tourInput({
          slug: detail.slug,
          itinerary: [],
          addons: [
            {
              id: addonId,
              name: 'Packed lunch',
              priceCentavos: 60_000,
              perPerson: true,
              isActive: true,
            },
          ],
        }),
        id,
      } as never);

      // The SAME row, revived and repriced — not a second one beside it.
      const rows = await addonRowsFor(id);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ id: addonId, isActive: true, priceCentavos: 60_000 });
    });

    it('REFUSES to remove a stop a trip has checked in at, and writes NOTHING', async () => {
      const { id, detail, stopId } = await tourWithCheckIn();
      const stopsBefore = await stopRowsFor(id);
      const tiersBefore = await tierRowsFor(id);
      const auditBefore = await auditRowsForTour(id);

      // `itinerary: []` drops every stop, including the checked-in one. Before
      // the fix this was ER_ROW_IS_REFERENCED_2 on
      // `DELETE FROM tour_itinerary_stops WHERE tour_id = ?` — a raw 500.
      const refused = (await ownerApi()
        .admin.tours.update({
          ...tourInput({ slug: detail.slug, itinerary: [] }),
          id,
        } as never)
        .catch((error: unknown) => error)) as { code?: string; message?: string };

      expect(refused.code, 'a foreign-key 500 is not a refusal').toBe('CONFLICT');
      // Named, so the owner knows which row to keep rather than guessing.
      expect(refused.message).toContain('Hotel pickup');
      expect(refused.message).toMatch(/checked in/i);

      // Nothing at all: not the stops, not the tiers the save would have
      // replaced first, not the title, and not an audit row.
      expect(await stopRowsFor(id)).toEqual(stopsBefore);
      expect(await tierRowsFor(id)).toEqual(tiersBefore);
      expect(await auditRowsForTour(id)).toEqual(auditBefore);
      expect((await ownerApi().admin.tours.detail({ id })).title).toBe(detail.title);

      // And the check-in itself is untouched — the driver's record stands.
      const checkpoints = await getDb()
        .select({ stopId: tripCheckpoints.stopId })
        .from(tripCheckpoints)
        .where(eq(tripCheckpoints.stopId, stopId));
      expect(checkpoints).toHaveLength(1);
    });

    /**
     * The half that must keep working. A refusal that fired for every dropped
     * stop would make the itinerary editor unusable, and nothing else in this
     * file would notice.
     */
    it('still DELETES a stop no trip has checked in at', async () => {
      const { id, detail } = await tourWithCheckIn();
      // Keep the checked-in stop (by id), drop the second one.
      const keep = keepStops(detail).filter((stop) => stop.name === 'Hotel pickup');
      expect(keep).toHaveLength(1);

      await expect(
        ownerApi().admin.tours.update({
          ...tourInput({ slug: detail.slug, itinerary: keep }),
          id,
        } as never),
      ).resolves.toEqual({ ok: true });

      expect((await stopRowsFor(id)).map((row) => row.name)).toEqual(['Hotel pickup']);
      expect((await auditRowsForTour(id)).at(-1)).toMatchObject({
        data: { stopsRemoved: 1 },
      });
    });

    it('EDITS a checked-in stop in place, keeping the id the checkpoint points at', async () => {
      const { id, detail, stopId } = await tourWithCheckIn();

      await expect(
        ownerApi().admin.tours.update({
          ...tourInput({
            slug: detail.slug,
            itinerary: [
              { id: stopId, sortOrder: 0, name: 'Hotel pickup (renamed)', description: 'Lobby.' },
            ],
          }),
          id,
        } as never),
      ).resolves.toEqual({ ok: true });

      // Renamed, same row — so the driver's existing checkpoint still refers to
      // the stop it was taken at rather than dangling or pointing somewhere new.
      const rows = await stopRowsFor(id);
      expect(rows).toEqual([{ id: stopId, sortOrder: 0, name: 'Hotel pickup (renamed)' }]);
    });

    /**
     * An id belonging to ANOTHER tour must not be reachable through this tour's
     * save: `planChildUpsert` only matches ids the tour already owns, and the
     * writes are scoped by `tour_id` as well. The worst a caller achieves is
     * adding a row to their own tour.
     */
    it('treats another tour add-on id as a NEW row, never updating across tours', async () => {
      const victim = await createTour();
      const victimAddonId = (await ownerApi().admin.tours.detail({ id: victim.id })).addons[0]!.id;
      const { id, input } = await createTour();

      await ownerApi().admin.tours.update({
        ...input,
        id,
        addons: [
          {
            id: victimAddonId,
            name: 'Smuggled rename',
            priceCentavos: 1,
            perPerson: false,
            isActive: true,
          },
        ],
      } as never);

      // The other tour's add-on is exactly as it was.
      const victimRows = await addonRowsFor(victim.id);
      expect(victimRows).toHaveLength(1);
      expect(victimRows[0]).toMatchObject({
        id: victimAddonId,
        name: 'Packed lunch',
        priceCentavos: 50_000,
        isActive: true,
      });

      // And this tour got a NEW row, with an id of its own.
      const mine = await addonRowsFor(id);
      expect(mine.filter((row) => row.isActive)).toHaveLength(1);
      expect(mine.find((row) => row.name === 'Smuggled rename')?.id).not.toBe(victimAddonId);
    });
  });
});
