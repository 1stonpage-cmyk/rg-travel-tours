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
import { afterAll, beforeAll, expect, it } from 'vitest';
import { and, asc, eq, inArray, like } from 'drizzle-orm';
import { appRouter } from '../routers/_app';
import { getDb, getPool } from '../db/client';
import {
  auditLog,
  destinations,
  tourAddons,
  tourImages,
  tourItineraryStops,
  tourPriceTiers,
  tours,
  users,
} from '../db/schema';
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
   * Update — children replaced wholesale, inside one transaction
   * ------------------------------------------------------------------ */

  it('REPLACES the children wholesale rather than appending to them', async () => {
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
    expect(detail.itinerary.map((s) => s.name)).toEqual(['Only stop']);
    expect(detail.addons).toEqual([]);
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
});
