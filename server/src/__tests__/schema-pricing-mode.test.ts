/**
 * Task 1 (brief label 2A) of the per-person-pricing plan: two new, purely
 * additive pricing-mode columns — `transfer_routes.pricing_mode` /
 * `transfer_routes.min_paying_pax`, and `packages.pricing_mode` — each with
 * a safe default so no existing row's behaviour changes. This task builds
 * only the schema; the pricing math and the admin UI are later tasks and are
 * deliberately not under test here.
 *
 * Two layers, the split `schema-fleet.test.ts` / `schema-trips.test.ts` use:
 *
 *  1. **Shape assertions read the Drizzle table object** through
 *     `getTableConfig()` — the very object drizzle-kit emits DDL from. These
 *     fail before migration 0029 exists (the column is simply absent from
 *     the config) and fail again if a later change drops the column, widens
 *     the enum, or changes a default.
 *
 *  2. **A real insert/read-back against the migrated database**, proving
 *     the default a brand-new, hand-written-style row gets is the SAFE one —
 *     `per_vehicle`/`1` for a route, `per_group` for a package — exactly the
 *     behaviour every row that predates this task already has.
 */
import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { getTableConfig } from 'drizzle-orm/mysql-core';
import { getDb, type Transaction } from '../db/client';
import { packages, transferPlaces, transferRoutes } from '../db/schema';

function inspect(table: Parameters<typeof getTableConfig>[0]) {
  const config = getTableConfig(table);
  return {
    config,
    column: (name: string) => config.columns.find((c) => c.name === name),
    columnNames: config.columns.map((c) => c.name),
  };
}

describe('transfer_routes pricing-mode columns (declaration)', () => {
  const { column, columnNames } = inspect(transferRoutes);

  it('adds pricing_mode as a NOT NULL enum defaulting to per_vehicle', () => {
    expect(columnNames).toContain('pricing_mode');
    const pricingMode = column('pricing_mode');
    expect(pricingMode?.enumValues).toEqual(['per_vehicle', 'per_person']);
    expect(pricingMode?.notNull).toBe(true);
    expect(pricingMode?.default).toBe('per_vehicle');
  });

  it('adds min_paying_pax as a NOT NULL int defaulting to 1', () => {
    expect(columnNames).toContain('min_paying_pax');
    const minPayingPax = column('min_paying_pax');
    expect(minPayingPax?.getSQLType()).toBe('int');
    expect(minPayingPax?.notNull).toBe(true);
    expect(minPayingPax?.default).toBe(1);
  });
});

describe('packages pricing-mode column (declaration)', () => {
  const { column, columnNames } = inspect(packages);

  it('adds pricing_mode as a NOT NULL enum defaulting to per_group', () => {
    expect(columnNames).toContain('pricing_mode');
    const pricingMode = column('pricing_mode');
    expect(pricingMode?.enumValues).toEqual(['per_person', 'per_group']);
    expect(pricingMode?.notNull).toBe(true);
    expect(pricingMode?.default).toBe('per_group');
  });
});

/** Thrown to roll the fixture transaction back; never escapes `inRollback`. */
const ROLLBACK = new Error('__rollback__');

async function inRollback(fn: (tx: Transaction) => Promise<void>): Promise<void> {
  try {
    await getDb().transaction(async (tx) => {
      await fn(tx);
      throw ROLLBACK;
    });
  } catch (error) {
    if (error !== ROLLBACK) throw error;
  }
}

function unique(): string {
  return `__pricing_mode__${Date.now()}_${Math.floor(Math.random() * 1e9)}`.replace(/_/g, '-');
}

/** A transfer route and its two places, for the route insert below. */
async function makeRoute(tx: Transaction): Promise<number> {
  const slug = unique();
  const [fromPlace] = await tx
    .insert(transferPlaces)
    .values({ name: `${slug}-from`, nameKey: `${slug}-from`.toLowerCase() });
  const [toPlace] = await tx
    .insert(transferPlaces)
    .values({ name: `${slug}-to`, nameKey: `${slug}-to`.toLowerCase() });
  const [route] = await tx.insert(transferRoutes).values({
    fromPlaceId: fromPlace.insertId,
    toPlaceId: toPlace.insertId,
    slug,
    estimatedDurationMinutes: 120,
    // pricing_mode / min_paying_pax deliberately omitted — the whole point
    // of this test is what a route gets when nobody sets them.
  });
  return route.insertId;
}

describe('transfer_routes pricing-mode columns (DB round trip)', () => {
  it('defaults a brand-new route to per_vehicle pricing with min_paying_pax = 1', async () => {
    await inRollback(async (tx) => {
      const routeId = await makeRoute(tx);
      const [row] = await tx.select().from(transferRoutes).where(eq(transferRoutes.id, routeId));
      expect(row?.pricingMode).toBe('per_vehicle');
      expect(row?.minPayingPax).toBe(1);
    });
  });
});

describe('packages pricing-mode column (DB round trip)', () => {
  it('defaults a brand-new package to per_group pricing', async () => {
    await inRollback(async (tx) => {
      const slug = unique();
      const [pkg] = await tx.insert(packages).values({
        slug,
        title: slug,
        days: 3,
        newPriceCentavos: 500000,
        // pricing_mode deliberately omitted.
      });
      const [row] = await tx.select().from(packages).where(eq(packages.id, pkg.insertId));
      expect(row?.pricingMode).toBe('per_group');
    });
  });
});
