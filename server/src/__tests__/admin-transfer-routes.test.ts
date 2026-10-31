/**
 * Transfers-launch plan, Task T3 — `admin.transferRoutes.*` (Architecture §1
 * and §5).
 *
 * §9 gives the "Tours, pricing, coupons" row to the OWNER alone, and this
 * router reuses it rather than adding a thirteenth area: these mutations write
 * the price a guest is charged for a van or an SUV, which is the narrowest
 * permission in the matrix for a reason. So every procedure is exercised
 * against all three roles here, the way `admin-vans.test.ts` does it — the
 * shared gate plus `procedure-role-metadata.test.ts` cover the role list
 * structurally, but CLAUDE.md asks for a test per role per area and one
 * procedure accidentally built on the wrong area is exactly the defect that
 * catches.
 *
 * **The load-bearing tests in this file are the two price-preservation ones.**
 * `transfer_route_vehicle_prices` is replaced WHOLESALE on every save
 * (`services/transfers/upsert-route.ts` explains why that is safe), and the
 * failure mode of a wholesale replacement driven by a PATCH is specific and
 * expensive: delete both rows, re-insert only the vehicle type the patch
 * happened to mention, and the other vehicle type's price is gone — a product
 * that silently stops being quotable. Both halves are pinned: a patch that
 * mentions no prices at all, and a patch that reprices one vehicle type.
 */
import { afterAll, beforeAll, expect, it } from 'vitest';
import { and, asc, eq, inArray } from 'drizzle-orm';
import type { TransferRouteCreateInput } from '@rg/shared';
import { appRouter } from '../routers/_app';
import { getDb, getPool } from '../db/client';
import {
  auditLog,
  destinations,
  transferRouteVehiclePrices,
  transferRoutes,
  users,
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

const created = {
  userIds: [] as number[],
  routeIds: [] as number[],
  destIds: [] as number[],
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

/** A destination with nothing else attached — what a route anchors on. */
async function makeDestination() {
  const slug = `__adtrdest__${unique()}`;
  const [row] = await getDb().insert(destinations).values({ name: slug, slug });
  created.destIds.push(row.insertId);
  return row.insertId;
}

function routeInput(
  destinationId: number,
  overrides: Partial<TransferRouteCreateInput> = {},
): TransferRouteCreateInput {
  return {
    destinationId,
    slug: uniqueSlug(),
    estimatedDurationMinutes: 180,
    freeCancelHours: 24,
    inclusionsText: 'Fuel, driver, tolls',
    exclusionsText: 'Meals',
    prices: { van: { ...VALID_PRICES.van }, suv: { ...VALID_PRICES.suv } },
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
      vehicleType: transferRouteVehiclePrices.vehicleType,
      oneWayPriceCentavos: transferRouteVehiclePrices.oneWayPriceCentavos,
      dayUsePriceCentavos: transferRouteVehiclePrices.dayUsePriceCentavos,
    })
    .from(transferRouteVehiclePrices)
    .where(eq(transferRouteVehiclePrices.routeId, routeId))
    .orderBy(asc(transferRouteVehiclePrices.vehicleType));
}

let ownerId = 0;
let dispatcherId = 0;
let financeId = 0;

const ownerApi = () => appRouter.createCaller(staffContext(ownerId, 'owner') as never);

/** Creates a route through the real router and tracks it for teardown. */
async function createRoute(overrides: Partial<TransferRouteCreateInput> = {}) {
  const destinationId = overrides.destinationId ?? (await makeDestination());
  const input = routeInput(destinationId, overrides);
  const { id } = await ownerApi().admin.transferRoutes.create(input);
  created.routeIds.push(id);
  return { id, input };
}

beforeAll(async () => {
  ownerId = await makeStaff('owner');
  dispatcherId = await makeStaff('dispatcher');
  financeId = await makeStaff('finance');
}, 60_000);

afterAll(async () => {
  const db = getDb();
  const pool = getPool();

  /*
   * Users FIRST, before the route and destination deletes that can fail on a
   * foreign key. `users` is one of `global-setup.ts`'s LEAK_TABLES — a stray
   * row there fails the whole run by name — and nothing on `users` depends on
   * anything else this suite created, so taking it out of the blast radius of
   * a later failing statement costs nothing. (Measured during this file's own
   * mutation proving: an earlier delete threw, and the three staff rows were
   * still sitting in `rg_travel_test` afterwards.)
   */
  for (const id of created.userIds) {
    await pool.query('DELETE FROM sessions WHERE subject_type = ? AND subject_id = ?', [
      'user',
      id,
    ]);
    await pool.query('DELETE FROM users WHERE id = ?', [id]);
  }

  /*
   * Every route anchored on one of this suite's destinations, not only the ids
   * `createRoute` pushed. A REFUSAL test that unexpectedly SUCCEEDS leaves a
   * route nothing tracked — which is precisely what happens while
   * mutation-proving one of them (dropping the slug regex let
   * `"Mactan Airport"` through, and the untracked row then blocked the
   * destination delete on its foreign key and aborted the rest of this
   * teardown). Asking the database which routes exist makes the cleanup
   * independent of the tests having behaved.
   */
  const strays =
    created.destIds.length === 0
      ? []
      : await db
          .select({ id: transferRoutes.id })
          .from(transferRoutes)
          .where(inArray(transferRoutes.destinationId, created.destIds));
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
  if (created.destIds.length > 0) {
    await db.delete(destinations).where(inArray(destinations.id, created.destIds));
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
      await expect(api.create(routeInput(1))).rejects.toMatchObject({ code: 'FORBIDDEN' });
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
    const destinationId = await makeDestination();
    const input = routeInput(destinationId);
    const { id } = await ownerApi().admin.transferRoutes.create(input);
    created.routeIds.push(id);

    const row = (await ownerApi().admin.transferRoutes.list()).find((r) => r.id === id);
    expect(row).toBeDefined();
    expect(row).toMatchObject({
      destinationId,
      slug: input.slug,
      estimatedDurationMinutes: 180,
      freeCancelHours: 24,
      inclusionsText: 'Fuel, driver, tolls',
      exclusionsText: 'Meals',
      isActive: true,
    });
    // The whole point of the table: four distinct figures, each in its place.
    expect(row?.prices.van).toEqual(VALID_PRICES.van);
    expect(row?.prices.suv).toEqual(VALID_PRICES.suv);
    // And the destination's name, denormalised so the list needs no second read.
    expect(row?.destinationName).toMatch(/^__adtrdest__/);
  });

  /**
   * T4's M3 addition: `sortOrder` was a column `list` already ordered by,
   * but nothing on `create`/`update` could set it, so every route sorted at
   * the same value. This proves the field actually reaches the column and
   * that `list`'s own `ORDER BY sort_order` honours it against ANOTHER
   * route, not just that the number round-trips in isolation.
   */
  it("round-trips sortOrder through list, honouring it against another route's", async () => {
    const earlierDestination = await makeDestination();
    const laterDestination = await makeDestination();
    const { id: laterId } = await createRoute({ destinationId: laterDestination, sortOrder: 50 });
    const { id: earlierId } = await createRoute({
      destinationId: earlierDestination,
      sortOrder: 5,
    });

    const rows = await ownerApi().admin.transferRoutes.list();
    const earlierRow = rows.find((r) => r.id === earlierId);
    const laterRow = rows.find((r) => r.id === laterId);
    expect(earlierRow?.sortOrder).toBe(5);
    expect(laterRow?.sortOrder).toBe(50);
    expect(rows.indexOf(earlierRow!)).toBeLessThan(rows.indexOf(laterRow!));
  });

  it('refuses a create that prices only one vehicle type', async () => {
    const destinationId = await makeDestination();
    const input = routeInput(destinationId);
    await expect(
      ownerApi().admin.transferRoutes.create({
        ...input,
        prices: { van: VALID_PRICES.van },
      } as never),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });

  it('refuses a price of zero, a negative price and a fractional price', async () => {
    const api = ownerApi().admin.transferRoutes;
    const base = routeInput(await makeDestination());
    const bad: unknown[] = [
      { van: { oneWayPriceCentavos: 0, dayUsePriceCentavos: 450_000 }, suv: VALID_PRICES.suv },
      { van: VALID_PRICES.van, suv: { oneWayPriceCentavos: -1, dayUsePriceCentavos: 560_000 } },
      {
        van: { oneWayPriceCentavos: 1_999.5, dayUsePriceCentavos: 450_000 },
        suv: VALID_PRICES.suv,
      },
    ];
    for (const prices of bad) {
      await expect(api.create({ ...base, prices } as never)).rejects.toMatchObject({
        code: 'BAD_REQUEST',
      });
    }
  });

  it('refuses an unknown destination with BAD_REQUEST, not a foreign-key 500', async () => {
    await expect(
      ownerApi().admin.transferRoutes.create(routeInput(999_999_999)),
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
    const destinationId = await makeDestination();
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
        api.create({ ...routeInput(destinationId), slug }),
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
   *
   * What it buys is that `transfer_routes.slug`'s UNIQUE never has to rely on
   * the `_ci` collation to tell `Moalboal` from `moalboal`: both reach the
   * column as the same bytes. CLAUDE.md names leaning on the collation twice
   * as a thing not to repeat (BUG-108 on `bookings.ref`, BUG-107 on
   * `coupons.code`) — this is the third place it could have happened.
   */
  it('lowercases and trims a slug BEFORE checking its shape, and stores that form', async () => {
    const destinationId = await makeDestination();
    const slug = uniqueSlug();
    const { id } = await ownerApi().admin.transferRoutes.create({
      ...routeInput(destinationId),
      slug: `  ${slug.toUpperCase()}  `,
    });
    created.routeIds.push(id);

    const row = (await ownerApi().admin.transferRoutes.list()).find((r) => r.id === id);
    expect(row?.slug).toBe(slug);
    // Spelled out rather than left to the equality above: the failure this
    // guards against is the stored value keeping the case it was typed in.
    expect(row?.slug).not.toBe(slug.toUpperCase());
    expect(row?.slug.trim()).toBe(row?.slug);
  });

  it('refuses a second route for the same destination with CONFLICT', async () => {
    const destinationId = await makeDestination();
    const { id } = await ownerApi().admin.transferRoutes.create(routeInput(destinationId));
    created.routeIds.push(id);
    await expect(
      ownerApi().admin.transferRoutes.create(routeInput(destinationId)),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('refuses a duplicate slug with CONFLICT, not a raw database error', async () => {
    const firstDestination = await makeDestination();
    const input = routeInput(firstDestination);
    const { id } = await ownerApi().admin.transferRoutes.create(input);
    created.routeIds.push(id);

    const secondDestination = await makeDestination();
    const clash = ownerApi().admin.transferRoutes.create(
      routeInput(secondDestination, { slug: input.slug }),
    );
    await expect(clash).rejects.toMatchObject({ code: 'CONFLICT' });
    // The guest/owner-facing sentence, not mysql2's own.
    await expect(clash).rejects.toThrow(/already/i);
  });

  it('rejects an unknown field instead of ignoring it', async () => {
    const destinationId = await makeDestination();
    await expect(
      ownerApi().admin.transferRoutes.create({
        ...routeInput(destinationId),
        isActive: false,
      } as never),
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
   * delete-then-reinsert of both price rows. A naive implementation that
   * handed the upsert `input.patch.prices` directly would delete both rows and
   * re-insert nothing (or, worse, invent zeroes), so a route whose DURATION
   * was edited would come back unpriced.
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
    expect(row?.prices.van).toEqual(VALID_PRICES.van);
    expect(row?.prices.suv).toEqual(VALID_PRICES.suv);
    // Read straight from the table too: `list` reshapes, and a reshaping bug
    // could hide a missing row behind a card built from the other one.
    expect(await priceRowsFor(id)).toEqual(before);
  });

  /**
   * The other half of the same rule: a patch that DOES carry a price card
   * carries both halves, and the half that did not change must come back
   * unchanged rather than re-derived, defaulted or dropped.
   */
  it("reprices the van and leaves the SUV's two prices untouched", async () => {
    const { id } = await createRoute();
    const repricedVan = { oneWayPriceCentavos: 275_000, dayUsePriceCentavos: 480_000 };

    await ownerApi().admin.transferRoutes.update({
      id,
      patch: { prices: { van: repricedVan, suv: { ...VALID_PRICES.suv } } },
    });

    const row = (await ownerApi().admin.transferRoutes.list()).find((r) => r.id === id);
    expect(row?.prices.van).toEqual(repricedVan);
    expect(row?.prices.suv).toEqual(VALID_PRICES.suv);
  });

  /**
   * **The fail-closed path** (fix round, review finding I1).
   *
   * `update`'s `missing.length > 0 → CONFLICT` is the one money-safety control
   * this task invented, and it is unreachable through the router API — every
   * save writes both price rows — so nothing exercised it. CLAUDE.md is
   * explicit that a control which fails closed needs a test FOR the failure
   * path; without one, a later "simplification" to
   * `card[vt] ?? { oneWayPriceCentavos: 0, … }` removes the refusal with the
   * whole suite staying green, and the consequence is a route silently priced
   * at ₱0 after an edit to its DURATION — which every quote then refuses by
   * the gateway-minimum rule, with nothing anywhere naming the cause.
   *
   * Raw SQL to set it up, because that is the only way the state can arise:
   * someone repairing a row by hand, or a later `seedDemo` addition that
   * inserts a route without its prices. The suite already reaches for
   * `getPool().query(...)` in `afterAll`.
   */
  it('refuses an update that would have to invent a missing price, and writes nothing', async () => {
    const { id } = await createRoute();
    await getPool().query(
      "DELETE FROM transfer_route_vehicle_prices WHERE route_id = ? AND vehicle_type = 'suv'",
      [id],
    );

    await expect(
      ownerApi().admin.transferRoutes.update({ id, patch: { estimatedDurationMinutes: 210 } }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });

    // The van row it refused to touch is still exactly as it was — the refusal
    // is raised before the upsert's delete, so there is no partial write.
    expect(await priceRowsFor(id)).toEqual([{ vehicleType: 'van', ...VALID_PRICES.van }]);

    const refused = (await ownerApi().admin.transferRoutes.list()).find((r) => r.id === id);
    // The route's own column did not move either, and the gap is REPORTED
    // rather than papered over with a zero.
    expect(refused?.estimatedDurationMinutes).toBe(180);
    expect(refused?.prices.suv).toBeNull();
    expect(refused?.prices.van).toEqual(VALID_PRICES.van);

    // And the refusal is not a dead end: the way out is the one its message
    // names — state both prices in the save.
    await ownerApi().admin.transferRoutes.update({
      id,
      patch: {
        estimatedDurationMinutes: 210,
        prices: { van: { ...VALID_PRICES.van }, suv: { ...VALID_PRICES.suv } },
      },
    });
    const repaired = (await ownerApi().admin.transferRoutes.list()).find((r) => r.id === id);
    expect(repaired?.estimatedDurationMinutes).toBe(210);
    expect(repaired?.prices.suv).toEqual(VALID_PRICES.suv);
    expect(await priceRowsFor(id)).toHaveLength(2);
  });

  it('keeps exactly two price rows per route, however many times it is saved', async () => {
    const { id } = await createRoute();
    for (const minutes of [120, 150, 200]) {
      await ownerApi().admin.transferRoutes.update({
        id,
        patch: { estimatedDurationMinutes: minutes },
      });
    }
    const rows = await priceRowsFor(id);
    expect(rows).toHaveLength(2);
    // Sorted here rather than relying on the query's own order: MySQL orders an
    // ENUM by its DECLARATION order (`van`, `suv`), not alphabetically, and the
    // claim under test is "one row per vehicle type", not which comes first.
    expect([...rows.map((r) => r.vehicleType)].sort()).toEqual(['suv', 'van']);
  });

  it('clears a nullable text field when the patch sends null', async () => {
    const { id } = await createRoute();
    await ownerApi().admin.transferRoutes.update({ id, patch: { exclusionsText: null } });
    const row = (await ownerApi().admin.transferRoutes.list()).find((r) => r.id === id);
    expect(row?.exclusionsText).toBeNull();
    // And the prices are still there — a null-clearing edit is still a save.
    expect(row?.prices.van).toEqual(VALID_PRICES.van);
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

  it('retires a route without deleting it, and its destination stays taken', async () => {
    const destinationId = await makeDestination();
    const { id } = await createRoute({ destinationId });

    await ownerApi().admin.transferRoutes.setActive({ id, isActive: false });

    const row = (await ownerApi().admin.transferRoutes.list()).find((r) => r.id === id);
    expect(
      row,
      'a retired route must stay on the admin list — it is the only place to revive it',
    ).toBeDefined();
    expect(row?.isActive).toBe(false);
    // Its prices stand: a retired route is not a repriced one.
    expect(row?.prices.van).toEqual(VALID_PRICES.van);

    // The UNIQUE on `destination_id` holds for an inactive route too, so the
    // way back is `setActive(true)` and never a second create.
    await expect(
      ownerApi().admin.transferRoutes.create(routeInput(destinationId)),
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

  it('records the prices in the create audit row — this table is money', async () => {
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
      destinationId: input.destinationId,
      slug: input.slug,
      prices: VALID_PRICES,
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
