/**
 * Transfers-launch plan, Task T3 — `admin.transferRoutes.*` (Architecture §1
 * and §5). Restructured 2026-11-08 (owner decision: flexible
 * places/routes/vehicle types — see
 * `docs/superpowers/plans/2026-11-08-flexible-routes.md`). A route used to
 * be anchored on a single `destinations` row; it now runs BETWEEN two
 * admin-managed `transfer_places`, and its price card is keyed by a runtime
 * `vehicle_types.id` rather than a fixed `van`/`suv` enum.
 *
 * §9 gives the "Tours, pricing, coupons" row to the OWNER alone, and this
 * router reuses it rather than adding a thirteenth area: these mutations write
 * the price a guest is charged for a vehicle, which is the narrowest
 * permission in the matrix for a reason. So every procedure is exercised
 * against all three roles here, the way `admin-vans.test.ts` does it — the
 * shared gate plus `procedure-role-metadata.test.ts` cover the role list
 * structurally, but CLAUDE.md asks for a test per role per area and one
 * procedure accidentally built on the wrong area is exactly the defect that
 * catches.
 *
 * **The load-bearing tests in this file are the price-preservation ones.**
 * `transfer_route_vehicle_prices` is replaced WHOLESALE on every save
 * (`services/transfers/upsert-route.ts` explains why that is safe), and the
 * failure mode of a wholesale replacement driven by a PATCH is specific and
 * expensive: delete every row, re-insert only what the patch happened to
 * mention, and an unmentioned type's price is gone. Owner decision
 * 2026-11-08 REVERSED the old "exactly two rows, never more, never fewer"
 * rule to "zero or more rows, one per offered type — no row means not
 * offered" — so what is pinned here changed shape too: a patch that restates
 * one type's price while repeating another's unchanged leaves the second
 * exactly as it was, and a patch whose price card omits a type that used to
 * be priced genuinely drops it (that is the new contract, not a bug).
 */
import { afterAll, beforeAll, expect, it } from 'vitest';
import { and, asc, eq, inArray, or } from 'drizzle-orm';
import type { TransferRouteCreateInput } from '@rg/shared';
import { appRouter } from '../routers/_app';
import { getDb, getPool } from '../db/client';
import {
  auditLog,
  transferPlaces,
  transferRouteVehiclePrices,
  transferRoutes,
  users,
  vehicleTypes,
} from '../db/schema';
import { customerContext, staffContext, testContext } from './helpers/ctx';
import { describeWithDb } from './helpers/db';

/** Distinct enough to survive a suite run sharing the database with others. */
const unique = () => `${Math.floor(Math.random() * 1e9)}_${Date.now()}`;

/**
 * A unique, URL-shaped route slug.
 *
 * `unique()` joins its two halves with an underscore, which
 * `transferRouteSlugSchema`'s regex does not allow (fix round, review finding
 * I2), so the separator is swapped for the hyphen the pattern does allow.
 */
const uniqueSlug = () => `adtr-${unique().replace('_', '-')}`;

const created = {
  userIds: [] as number[],
  routeIds: [] as number[],
  placeIds: [] as number[],
  vehicleTypeIds: [] as number[],
};

async function makeStaff(role: 'owner' | 'dispatcher' | 'finance') {
  const suffix = unique();
  const [row] = await getDb()
    .insert(users)
    .values({
      name: `Admin ${role} ${suffix}`,
      email: `adtr_${role}_${suffix}@example.test`,
      passwordHash: '__adtr_fixture_not_a_hash__',
      role,
      isActive: true,
    });
  created.userIds.push(row.insertId);
  return row.insertId;
}

/** A pickup/drop-off place with nothing else attached — what a route runs between. */
async function makePlace(opts: { isActive?: boolean; isAirport?: boolean } = {}) {
  const slug = `__adtrplace__${unique()}`;
  const [row] = await getDb()
    .insert(transferPlaces)
    .values({
      name: slug,
      nameKey: slug.toLowerCase(),
      isActive: opts.isActive ?? true,
      isAirport: opts.isAirport ?? false,
    });
  created.placeIds.push(row.insertId);
  return row.insertId;
}

/**
 * The real, global `vehicle_types.id` for `'van'`/`'suv'` — seeded by
 * `seedBase` (migration 0023), never a literal id (CLAUDE.md).
 */
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

/**
 * Both vehicle types, both products, all four figures different.
 *
 * Four distinct numbers on purpose: a bug that copied one vehicle type's card
 * over the other's, or one-way over day-use, would pass a fixture built from
 * repeated values.
 */
const VALID_PRICES = {
  van: { oneWayPriceCentavos: 250_000, dayUsePriceCentavos: 450_000 },
  suv: { oneWayPriceCentavos: 320_000, dayUsePriceCentavos: 560_000 },
} as const;

/** The whole, legitimate price card: both seeded types, keyed by stringified id. */
function fullPrices() {
  return {
    [String(VAN_ID)]: { ...VALID_PRICES.van },
    [String(SUV_ID)]: { ...VALID_PRICES.suv },
  };
}

function routeInput(
  fromPlaceId: number,
  toPlaceId: number,
  overrides: Partial<TransferRouteCreateInput> = {},
): TransferRouteCreateInput {
  return {
    fromPlaceId,
    toPlaceId,
    reverseEnabled: true,
    slug: uniqueSlug(),
    estimatedDurationMinutes: 180,
    freeCancelHours: 24,
    inclusionsText: 'Fuel, driver, tolls',
    exclusionsText: 'Meals',
    prices: fullPrices(),
    ...overrides,
  };
}

/** Every audit row written against one route, oldest first. */
async function auditRowsFor(entityId: number) {
  return getDb()
    .select({ action: auditLog.action, actorType: auditLog.actorType, actorId: auditLog.actorId })
    .from(auditLog)
    .where(and(eq(auditLog.entity, 'transfer_route'), eq(auditLog.entityId, entityId)))
    .orderBy(asc(auditLog.id));
}

/** The price rows as the DATABASE holds them, not as `list` reshapes them. */
async function priceRowsFor(routeId: number) {
  return getDb()
    .select({
      vehicleTypeId: transferRouteVehiclePrices.vehicleTypeId,
      oneWayPriceCentavos: transferRouteVehiclePrices.oneWayPriceCentavos,
      dayUsePriceCentavos: transferRouteVehiclePrices.dayUsePriceCentavos,
    })
    .from(transferRouteVehiclePrices)
    .where(eq(transferRouteVehiclePrices.routeId, routeId))
    .orderBy(asc(transferRouteVehiclePrices.vehicleTypeId));
}

let ownerId = 0;
let dispatcherId = 0;
let financeId = 0;

const ownerApi = () => appRouter.createCaller(staffContext(ownerId, 'owner') as never);

/** Creates a route through the real router and tracks it for teardown. */
async function createRoute(
  overrides: Partial<TransferRouteCreateInput> & { fromPlaceId?: number; toPlaceId?: number } = {},
) {
  const fromPlaceId = overrides.fromPlaceId ?? (await makePlace());
  const toPlaceId = overrides.toPlaceId ?? (await makePlace());
  const input = routeInput(fromPlaceId, toPlaceId, overrides);
  const { id } = await ownerApi().admin.transferRoutes.create(input);
  created.routeIds.push(id);
  return { id, input };
}

beforeAll(async () => {
  ownerId = await makeStaff('owner');
  dispatcherId = await makeStaff('dispatcher');
  financeId = await makeStaff('finance');
  VAN_ID = await vehicleTypeIdBySlug('van');
  SUV_ID = await vehicleTypeIdBySlug('suv');
}, 60_000);

afterAll(async () => {
  const db = getDb();
  const pool = getPool();

  /*
   * Users FIRST, before the route and place deletes that can fail on a
   * foreign key. `users` is one of `global-setup.ts`'s LEAK_TABLES — a stray
   * row there fails the whole run by name — and nothing on `users` depends on
   * anything else this suite created, so taking it out of the blast radius of
   * a later failing statement costs nothing.
   */
  for (const id of created.userIds) {
    await pool.query('DELETE FROM sessions WHERE subject_type = ? AND subject_id = ?', [
      'user',
      id,
    ]);
    await pool.query('DELETE FROM users WHERE id = ?', [id]);
  }

  /*
   * Every route touching one of this suite's places, not only the ids
   * `createRoute` pushed — a refusal test that unexpectedly SUCCEEDS leaves a
   * route nothing tracked. Asking the database which routes exist makes the
   * cleanup independent of the tests having behaved.
   */
  const strays =
    created.placeIds.length === 0
      ? []
      : await db
          .select({ id: transferRoutes.id })
          .from(transferRoutes)
          .where(
            or(
              inArray(transferRoutes.fromPlaceId, created.placeIds),
              inArray(transferRoutes.toPlaceId, created.placeIds),
            ),
          );
  const routeIds = [...new Set([...created.routeIds, ...strays.map((row) => row.id)])];

  if (routeIds.length > 0) {
    // `audit_log.entity_id` is polymorphic — a booking and a route can share
    // the same numeric id, so the entity column is part of the filter too.
    await db
      .delete(auditLog)
      .where(and(eq(auditLog.entity, 'transfer_route'), inArray(auditLog.entityId, routeIds)));
    // Children before parents: the FK is RESTRICT, like every other in this schema.
    await db
      .delete(transferRouteVehiclePrices)
      .where(inArray(transferRouteVehiclePrices.routeId, routeIds));
    await db.delete(transferRoutes).where(inArray(transferRoutes.id, routeIds));
  }
  if (created.placeIds.length > 0) {
    await db.delete(transferPlaces).where(inArray(transferPlaces.id, created.placeIds));
  }
  // Not a LEAK_TABLES table (global-setup.ts), but cleaned up anyway — every
  // price row referencing one was already removed above, by routeId.
  if (created.vehicleTypeIds.length > 0) {
    await db.delete(vehicleTypes).where(inArray(vehicleTypes.id, created.vehicleTypeIds));
  }
});

describeWithDb('admin.transferRoutes', () => {
  /* ------------------------------------------------------------------ *
   * The gate, per role, per procedure.
   * ------------------------------------------------------------------ */

  it('REFUSES a caller with no session', async () => {
    const api = appRouter.createCaller(testContext() as never);
    await expect(api.admin.transferRoutes.list()).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  });

  it('REFUSES a customer session', async () => {
    const api = appRouter.createCaller(customerContext(1) as never);
    await expect(api.admin.transferRoutes.list()).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  });

  /*
   * Both non-owner roles, against all FOUR procedures rather than just the
   * two a happy-path test would reach. The ids never have to resolve to a
   * real route: `requireRole` runs before the resolver, so a refused session
   * is turned away before either procedure reads the database.
   */
  for (const role of ['dispatcher', 'finance'] as const) {
    it(`REFUSES ${role} on every procedure — §9 gives tours/pricing to the owner alone`, async () => {
      const api = appRouter.createCaller(
        staffContext(role === 'dispatcher' ? dispatcherId : financeId, role) as never,
      ).admin.transferRoutes;
      await expect(api.list()).rejects.toMatchObject({ code: 'FORBIDDEN' });
      await expect(api.create(routeInput(1, 2))).rejects.toMatchObject({ code: 'FORBIDDEN' });
      await expect(
        api.update({ id: 1, patch: { estimatedDurationMinutes: 90 } }),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
      await expect(api.setActive({ id: 1, isActive: false })).rejects.toMatchObject({
        code: 'FORBIDDEN',
      });
    });
  }

  it('ALLOWS the owner', async () => {
    await expect(ownerApi().admin.transferRoutes.list()).resolves.toBeInstanceOf(Array);
  });

  /* ------------------------------------------------------------------ *
   * Create.
   * ------------------------------------------------------------------ */

  it("round-trips both vehicle types' prices through create and list", async () => {
    const fromPlaceId = await makePlace();
    const toPlaceId = await makePlace();
    const input = routeInput(fromPlaceId, toPlaceId);
    const { id } = await ownerApi().admin.transferRoutes.create(input);
    created.routeIds.push(id);

    const row = (await ownerApi().admin.transferRoutes.list()).find((r) => r.id === id);
    expect(row).toBeDefined();
    expect(row).toMatchObject({
      slug: input.slug,
      estimatedDurationMinutes: 180,
      freeCancelHours: 24,
      inclusionsText: 'Fuel, driver, tolls',
      exclusionsText: 'Meals',
      isActive: true,
      reverseEnabled: true,
    });
    // The whole point of the table: four distinct figures, each in its place.
    expect(row?.prices.find((p) => p.vehicleTypeId === VAN_ID)?.price).toEqual(VALID_PRICES.van);
    expect(row?.prices.find((p) => p.vehicleTypeId === SUV_ID)?.price).toEqual(VALID_PRICES.suv);
    // And both places' names, denormalised so the list needs no second read.
    expect(row?.fromPlace.id).toBe(fromPlaceId);
    expect(row?.toPlace.id).toBe(toPlaceId);
    expect(row?.fromPlace.name).toMatch(/^__adtrplace__/);
  });

  /**
   * Owner decision 2026-11-08, decision 4's second half: zero or more price
   * rows is legitimate — "no row = not offered." This directly reverses the
   * old "exactly two rows, never more, never fewer" rule the pre-2026-11-08
   * version of this test pinned.
   */
  it('accepts a create pricing only one vehicle type, leaving the other unoffered', async () => {
    const { id } = await createRoute({ prices: { [String(VAN_ID)]: { ...VALID_PRICES.van } } });

    const row = (await ownerApi().admin.transferRoutes.list()).find((r) => r.id === id);
    expect(row?.prices.find((p) => p.vehicleTypeId === VAN_ID)?.price).toEqual(VALID_PRICES.van);
    expect(row?.prices.find((p) => p.vehicleTypeId === SUV_ID)?.price).toBeNull();
    expect(await priceRowsFor(id)).toEqual([{ vehicleTypeId: VAN_ID, ...VALID_PRICES.van }]);
  });

  /** And the zero-prices end of the same new rule — a route may be created unpriced at all. */
  it('accepts a create with no prices at all', async () => {
    const { id } = await createRoute({ prices: {} });
    const row = (await ownerApi().admin.transferRoutes.list()).find((r) => r.id === id);
    expect(row?.prices.every((p) => p.price === null)).toBe(true);
    expect(await priceRowsFor(id)).toEqual([]);
  });

  /**
   * Task 0D (owner decision 2026-11-06 #1, retargeted 2026-11-08 from
   * `destinations` to `transfer_places`): the admin list already shows a
   * route touching an inactive place (it never filtered on either place's
   * `is_active` — only `setActive` touches a route's OWN flag), but until now
   * the query did not select either place's `is_active` at all, so the
   * client had no way to tell that case apart from a plain Active route.
   * This pins both halves: a normal route reads `true` on both places, and a
   * route whose TO place was retired AFTER the route was created reads
   * `false` there — independent of the route's own `isActive`, which stays
   * `true` throughout.
   */
  it('surfaces each place’s isActive on the row, false only once that place is retired', async () => {
    const { id: stillActiveRouteId } = await createRoute();

    const retiredToPlace = await makePlace();
    const { id: retiredPlaceRouteId } = await createRoute({ toPlaceId: retiredToPlace });
    await getDb()
      .update(transferPlaces)
      .set({ isActive: false })
      .where(eq(transferPlaces.id, retiredToPlace));

    const rows = await ownerApi().admin.transferRoutes.list();
    const stillActiveRow = rows.find((r) => r.id === stillActiveRouteId);
    const retiredPlaceRow = rows.find((r) => r.id === retiredPlaceRouteId);
    expect(stillActiveRow?.isActive).toBe(true);
    expect(stillActiveRow?.fromPlace.isActive).toBe(true);
    expect(stillActiveRow?.toPlace.isActive).toBe(true);
    expect(retiredPlaceRow?.isActive).toBe(true);
    expect(retiredPlaceRow?.toPlace.isActive).toBe(false);
  });

  /**
   * T4's M3 addition: `sortOrder` was a column `list` already ordered by,
   * but nothing on `create`/`update` could set it, so every route sorted at
   * the same value. This proves the field actually reaches the column and
   * that `list`'s own `ORDER BY sort_order` honours it against ANOTHER
   * route, not just that the number round-trips in isolation.
   */
  it("round-trips sortOrder through list, honouring it against another route's", async () => {
    const { id: laterId } = await createRoute({ sortOrder: 50 });
    const { id: earlierId } = await createRoute({ sortOrder: 5 });

    const rows = await ownerApi().admin.transferRoutes.list();
    const earlierRow = rows.find((r) => r.id === earlierId);
    const laterRow = rows.find((r) => r.id === laterId);
    expect(earlierRow?.sortOrder).toBe(5);
    expect(laterRow?.sortOrder).toBe(50);
    expect(rows.indexOf(earlierRow!)).toBeLessThan(rows.indexOf(laterRow!));
  });

  it('refuses a price of zero, a negative price and a fractional price', async () => {
    const api = ownerApi().admin.transferRoutes;
    const fromPlaceId = await makePlace();
    const toPlaceId = await makePlace();
    const bad: unknown[] = [
      {
        [String(VAN_ID)]: { oneWayPriceCentavos: 0, dayUsePriceCentavos: 450_000 },
        [String(SUV_ID)]: { ...VALID_PRICES.suv },
      },
      {
        [String(VAN_ID)]: { ...VALID_PRICES.van },
        [String(SUV_ID)]: { oneWayPriceCentavos: -1, dayUsePriceCentavos: 560_000 },
      },
      {
        [String(VAN_ID)]: { oneWayPriceCentavos: 1_999.5, dayUsePriceCentavos: 450_000 },
        [String(SUV_ID)]: { ...VALID_PRICES.suv },
      },
    ];
    for (const prices of bad) {
      await expect(
        api.create(routeInput(fromPlaceId, toPlaceId, { prices: prices as never })),
      ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    }
  });

  it('refuses an unknown place id with BAD_REQUEST, not a foreign-key 500', async () => {
    const toPlaceId = await makePlace();
    await expect(
      ownerApi().admin.transferRoutes.create(routeInput(999_999_999, toPlaceId)),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });

  it('refuses an unknown vehicle-type id in the price card with BAD_REQUEST', async () => {
    const fromPlaceId = await makePlace();
    const toPlaceId = await makePlace();
    await expect(
      ownerApi().admin.transferRoutes.create(
        routeInput(fromPlaceId, toPlaceId, { prices: { '999999999': { ...VALID_PRICES.van } } }),
      ),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });

  it('refuses a route that starts and ends at the same place', async () => {
    const placeId = await makePlace();
    await expect(
      ownerApi().admin.transferRoutes.create(routeInput(placeId, placeId)),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });

  /**
   * Fix round, review finding I2. This slug keys a public URL in a later task
   * (`/transfers/:slug`, its canonical and its `/sitemap.xml` entry), so a
   * string that cannot BE a URL segment has to be refused where an owner can
   * see why — not discovered later as a canonical full of `%20` or a path the
   * SPA router 404s on.
   */
  it('refuses a slug that could not go in a URL', async () => {
    const fromPlaceId = await makePlace();
    const toPlaceId = await makePlace();
    const api = ownerApi().admin.transferRoutes;
    const malformed = [
      'Mactan Airport', // a space
      'Oslob/Sumilon', // a path separator
      'mactan_airport', // an underscore — allowed in a filename, not here
      'mactan--airport', // a doubled hyphen
      '-mactan-airport', // a leading hyphen
      'mactan-airport-', // a trailing hyphen
      'mactan.airport', // a dot
      'cebu—airport', // an em dash, which reads as a hyphen and is not one
    ];
    for (const slug of malformed) {
      await expect(
        api.create(routeInput(fromPlaceId, toPlaceId, { slug })),
        `"${slug}" was accepted as a route slug`,
      ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    }
  });

  /**
   * Fix round, review finding I2 — and the ORDER is the whole point.
   *
   * The slug below is submitted in upper case with surrounding whitespace. The
   * schema's regex accepts lowercase only, so this can succeed at all **only
   * because `.transform()` runs BEFORE `.pipe()`'s shape check** — the
   * `bookingRefSchema` ordering (CLAUDE.md, BUG-108). Move the normalisation
   * after the check, or drop it, and this call becomes a `BAD_REQUEST`.
   */
  it('lowercases and trims a slug BEFORE checking its shape, and stores that form', async () => {
    const fromPlaceId = await makePlace();
    const toPlaceId = await makePlace();
    const slug = uniqueSlug();
    const { id } = await ownerApi().admin.transferRoutes.create(
      routeInput(fromPlaceId, toPlaceId, { slug: `  ${slug.toUpperCase()}  ` }),
    );
    created.routeIds.push(id);

    const row = (await ownerApi().admin.transferRoutes.list()).find((r) => r.id === id);
    expect(row?.slug).toBe(slug);
    expect(row?.slug).not.toBe(slug.toUpperCase());
    expect(row?.slug.trim()).toBe(row?.slug);
  });

  it('refuses a second route for the same from/to pair with CONFLICT', async () => {
    const fromPlaceId = await makePlace();
    const toPlaceId = await makePlace();
    const { id } = await ownerApi().admin.transferRoutes.create(routeInput(fromPlaceId, toPlaceId));
    created.routeIds.push(id);
    await expect(
      ownerApi().admin.transferRoutes.create(routeInput(fromPlaceId, toPlaceId)),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('refuses a duplicate slug with CONFLICT, not a raw database error', async () => {
    const input = routeInput(await makePlace(), await makePlace());
    const { id } = await ownerApi().admin.transferRoutes.create(input);
    created.routeIds.push(id);

    const clash = ownerApi().admin.transferRoutes.create(
      routeInput(await makePlace(), await makePlace(), { slug: input.slug }),
    );
    await expect(clash).rejects.toMatchObject({ code: 'CONFLICT' });
    // The guest/owner-facing sentence, not mysql2's own.
    await expect(clash).rejects.toThrow(/already/i);
  });

  it('rejects an unknown field instead of ignoring it', async () => {
    const input = routeInput(await makePlace(), await makePlace());
    await expect(
      ownerApi().admin.transferRoutes.create({ ...input, isActive: false } as never),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });

  /* ------------------------------------------------------------------ *
   * Update — the money tests.
   * ------------------------------------------------------------------ */

  /**
   * **The single most important test in this task.**
   *
   * `update`'s patch is shallow, so `prices` is either a complete card or
   * absent — and an absent one still has to survive the wholesale
   * delete-then-reinsert of every price row. A naive implementation that
   * handed the upsert `input.patch.prices` directly would delete every row and
   * re-insert nothing, so a route whose DURATION was edited would come back
   * unpriced.
   */
  it('leaves BOTH vehicle types’ prices exactly as they were when the patch names no prices', async () => {
    const { id } = await createRoute();
    const before = await priceRowsFor(id);

    await ownerApi().admin.transferRoutes.update({
      id,
      patch: { estimatedDurationMinutes: 240, inclusionsText: 'Fuel, driver, tolls, water' },
    });

    const row = (await ownerApi().admin.transferRoutes.list()).find((r) => r.id === id);
    expect(row?.estimatedDurationMinutes).toBe(240);
    expect(row?.inclusionsText).toBe('Fuel, driver, tolls, water');
    // Neither vehicle type lost its price, and neither gained an invented one.
    expect(row?.prices.find((p) => p.vehicleTypeId === VAN_ID)?.price).toEqual(VALID_PRICES.van);
    expect(row?.prices.find((p) => p.vehicleTypeId === SUV_ID)?.price).toEqual(VALID_PRICES.suv);
    // Read straight from the table too: `list` reshapes, and a reshaping bug
    // could hide a missing row behind a card built from the other one.
    expect(await priceRowsFor(id)).toEqual(before);
  });

  /**
   * The other half of the same rule: a patch that DOES carry a price card
   * carries both halves, and the half that did not change must come back
   * unchanged rather than re-derived, defaulted or dropped — "a patch naming
   * one type's price does not remove any other type's existing row" when
   * that other type's price is restated, unchanged, in the same card.
   */
  it("reprices the van and leaves the SUV's two prices untouched", async () => {
    const { id } = await createRoute();
    const repricedVan = { oneWayPriceCentavos: 275_000, dayUsePriceCentavos: 480_000 };

    await ownerApi().admin.transferRoutes.update({
      id,
      patch: {
        prices: { [String(VAN_ID)]: repricedVan, [String(SUV_ID)]: { ...VALID_PRICES.suv } },
      },
    });

    const row = (await ownerApi().admin.transferRoutes.list()).find((r) => r.id === id);
    expect(row?.prices.find((p) => p.vehicleTypeId === VAN_ID)?.price).toEqual(repricedVan);
    expect(row?.prices.find((p) => p.vehicleTypeId === SUV_ID)?.price).toEqual(VALID_PRICES.suv);
  });

  /**
   * The new rule's other edge, reversed from the pre-2026-11-08 behaviour: a
   * `prices` card that is PRESENT but omits a type the route used to carry a
   * price for genuinely drops that type — "no row = not offered" (owner
   * decision 2026-11-08). This is not a bug; it is why `prices` is
   * documented as "either omit the whole key, or send the complete card".
   */
  it('a prices card that omits a previously-priced type removes that type’s row', async () => {
    const { id } = await createRoute();

    await ownerApi().admin.transferRoutes.update({
      id,
      patch: { prices: { [String(VAN_ID)]: { ...VALID_PRICES.van } } },
    });

    const row = (await ownerApi().admin.transferRoutes.list()).find((r) => r.id === id);
    expect(row?.prices.find((p) => p.vehicleTypeId === VAN_ID)?.price).toEqual(VALID_PRICES.van);
    expect(row?.prices.find((p) => p.vehicleTypeId === SUV_ID)?.price).toBeNull();
    expect(await priceRowsFor(id)).toEqual([{ vehicleTypeId: VAN_ID, ...VALID_PRICES.van }]);
  });

  /**
   * The gap the 1D/1E review round found: the admin route-price screen can
   * only ever show ACTIVE vehicle types (it builds its `prices` card from
   * `admin.vehicleTypes.list` filtered to `isActive`), so it can never send
   * a key for a type that has since been retired — not even an explicit
   * `null`. Before the fix, the wholesale delete matched on `routeId` alone,
   * so ANY save made through that screen (even one only touching duration)
   * would silently wipe a price row for a since-deactivated type, with no
   * error and no way for the screen that did it to notice. Fixed in
   * `upsertTransferRoute`: the delete only touches rows for a vehicle type
   * that is either currently active or explicitly named as a key in the
   * posted card — the retired type's row is in neither set here, so it
   * survives.
   */
  it('a since-deactivated vehicle type’s stray price survives a save that never mentions it', async () => {
    const thirdTypeSlug = `vt_${unique()}`;
    const [typeRow] = await getDb()
      .insert(vehicleTypes)
      .values({ name: thirdTypeSlug, slug: thirdTypeSlug, isActive: true, sortOrder: 999 });
    const thirdTypeId = typeRow.insertId;
    created.vehicleTypeIds.push(thirdTypeId);
    const thirdTypePrice = { oneWayPriceCentavos: 111_100, dayUsePriceCentavos: 222_200 };

    const { id } = await createRoute({
      prices: { ...fullPrices(), [String(thirdTypeId)]: thirdTypePrice },
    });

    // Retire the type — exactly what makes it invisible to the route form.
    await ownerApi().admin.vehicleTypes.setActive({ id: thirdTypeId, isActive: false });

    // The screen can only ever see active types, so it posts a card naming
    // VAN_ID/SUV_ID only — never the now-invisible third type.
    await ownerApi().admin.transferRoutes.update({ id, patch: { prices: fullPrices() } });

    const rows = await priceRowsFor(id);
    expect(rows.map((r) => r.vehicleTypeId).sort((a, b) => a - b)).toEqual(
      [VAN_ID, SUV_ID, thirdTypeId].sort((a, b) => a - b),
    );
    expect(rows.find((r) => r.vehicleTypeId === thirdTypeId)).toEqual({
      vehicleTypeId: thirdTypeId,
      ...thirdTypePrice,
    });
  });

  /**
   * And the reverse direction: a route created with only one type priced can
   * be repriced later to add the second, without disturbing the first.
   */
  it('a prices card can ADD a previously-unoffered type without disturbing the existing one', async () => {
    const { id } = await createRoute({ prices: { [String(VAN_ID)]: { ...VALID_PRICES.van } } });

    await ownerApi().admin.transferRoutes.update({
      id,
      patch: {
        prices: {
          [String(VAN_ID)]: { ...VALID_PRICES.van },
          [String(SUV_ID)]: { ...VALID_PRICES.suv },
        },
      },
    });

    const row = (await ownerApi().admin.transferRoutes.list()).find((r) => r.id === id);
    expect(row?.prices.find((p) => p.vehicleTypeId === VAN_ID)?.price).toEqual(VALID_PRICES.van);
    expect(row?.prices.find((p) => p.vehicleTypeId === SUV_ID)?.price).toEqual(VALID_PRICES.suv);
  });

  it('keeps its price rows exactly as they are across saves that never mention prices', async () => {
    const { id } = await createRoute();
    for (const minutes of [120, 150, 200]) {
      await ownerApi().admin.transferRoutes.update({
        id,
        patch: { estimatedDurationMinutes: minutes },
      });
    }
    const rows = await priceRowsFor(id);
    expect(rows).toHaveLength(2);
    // `priceRowsFor` already orders ascending by `vehicle_type_id`.
    expect(rows.map((r) => r.vehicleTypeId)).toEqual([VAN_ID, SUV_ID].sort((a, b) => a - b));
  });

  it('clears a nullable text field when the patch sends null', async () => {
    const { id } = await createRoute();
    await ownerApi().admin.transferRoutes.update({ id, patch: { exclusionsText: null } });
    const row = (await ownerApi().admin.transferRoutes.list()).find((r) => r.id === id);
    expect(row?.exclusionsText).toBeNull();
    // And the prices are still there — a null-clearing edit is still a save.
    expect(row?.prices.find((p) => p.vehicleTypeId === VAN_ID)?.price).toEqual(VALID_PRICES.van);
  });

  it('refuses an empty patch instead of writing an audit row for nothing', async () => {
    const { id } = await createRoute();
    await expect(ownerApi().admin.transferRoutes.update({ id, patch: {} })).rejects.toThrow(
      /at least one/i,
    );
    await expect(
      ownerApi().admin.transferRoutes.update({ id: 999_999_999, patch: {} }),
    ).rejects.toThrow(/at least one/i);
    expect((await auditRowsFor(id)).map((r) => r.action)).toEqual(['transfer_route_created']);
  });

  it("rejects an unknown field in update's patch instead of silently stripping it", async () => {
    const { id } = await createRoute();
    await expect(
      ownerApi().admin.transferRoutes.update({
        id,
        patch: { estimatedDurationMinutes: 90, isActive: false } as never,
      }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });

  it('refuses an update that would make the route self-referencing', async () => {
    const placeA = await makePlace();
    const placeB = await makePlace();
    const { id } = await createRoute({ fromPlaceId: placeA, toPlaceId: placeB });
    await expect(
      ownerApi().admin.transferRoutes.update({ id, patch: { toPlaceId: placeA } }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });

  it('answers NOT_FOUND for an id no route holds', async () => {
    await expect(
      ownerApi().admin.transferRoutes.update({
        id: 999_999_999,
        patch: { estimatedDurationMinutes: 90 },
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(
      ownerApi().admin.transferRoutes.setActive({ id: 999_999_999, isActive: false }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  /* ------------------------------------------------------------------ *
   * setActive — the soft delete.
   * ------------------------------------------------------------------ */

  it('retires a route without deleting it, and its from/to pair stays taken', async () => {
    const fromPlaceId = await makePlace();
    const toPlaceId = await makePlace();
    const { id } = await createRoute({ fromPlaceId, toPlaceId });

    await ownerApi().admin.transferRoutes.setActive({ id, isActive: false });

    const row = (await ownerApi().admin.transferRoutes.list()).find((r) => r.id === id);
    expect(
      row,
      'a retired route must stay on the admin list — it is the only place to revive it',
    ).toBeDefined();
    expect(row?.isActive).toBe(false);
    // Its prices stand: a retired route is not a repriced one.
    expect(row?.prices.find((p) => p.vehicleTypeId === VAN_ID)?.price).toEqual(VALID_PRICES.van);

    // The UNIQUE on `(from_place_id, to_place_id)` holds for an inactive
    // route too, so the way back is `setActive(true)` and never a second create.
    await expect(
      ownerApi().admin.transferRoutes.create(routeInput(fromPlaceId, toPlaceId)),
    ).rejects.toMatchObject({ code: 'CONFLICT' });

    await ownerApi().admin.transferRoutes.setActive({ id, isActive: true });
    expect((await ownerApi().admin.transferRoutes.list()).find((r) => r.id === id)?.isActive).toBe(
      true,
    );
  });

  /* ------------------------------------------------------------------ *
   * The audit trail and the procedure list.
   * ------------------------------------------------------------------ */

  it('writes an audit row naming the actor on every change', async () => {
    const { id } = await createRoute();
    await ownerApi().admin.transferRoutes.update({ id, patch: { freeCancelHours: 48 } });
    await ownerApi().admin.transferRoutes.setActive({ id, isActive: false });

    const rows = await auditRowsFor(id);
    expect(rows.map((r) => r.action)).toEqual([
      'transfer_route_created',
      'transfer_route_updated',
      'transfer_route_active_changed',
    ]);
    expect(new Set(rows.map((r) => r.actorId))).toEqual(new Set([ownerId]));
    expect(new Set(rows.map((r) => r.actorType))).toEqual(new Set(['user']));
  });

  it('records the places, reverseEnabled and prices in the create audit row — this table is money', async () => {
    const { id, input } = await createRoute();
    const [row] = await getDb()
      .select({ data: auditLog.data })
      .from(auditLog)
      .where(
        and(
          eq(auditLog.entity, 'transfer_route'),
          eq(auditLog.entityId, id),
          eq(auditLog.action, 'transfer_route_created'),
        ),
      );
    expect(row?.data).toMatchObject({
      fromPlaceId: input.fromPlaceId,
      toPlaceId: input.toPlaceId,
      reverseEnabled: input.reverseEnabled,
      slug: input.slug,
      prices: input.prices,
    });
  });

  it('has no delete mutation — routes are soft-deleted through is_active', () => {
    // `_def.procedures` is not in tRPC v11's public types, so it needs the
    // cast the rest of this suite already uses — see `admin-vans.test.ts`.
    const procedures = (appRouter as unknown as { _def: { procedures: Record<string, unknown> } })
      ._def.procedures;
    const paths = Object.keys(procedures)
      .filter((key) => /^admin\.transferRoutes\./.test(key))
      .sort();
    // Vacuity guard: a typo in the filter would make the comparison below
    // empty-vs-empty, which passes while proving nothing.
    expect(paths.length).toBe(4);
    expect(paths).toEqual([
      'admin.transferRoutes.create',
      'admin.transferRoutes.list',
      'admin.transferRoutes.setActive',
      'admin.transferRoutes.update',
    ]);
  });
});
