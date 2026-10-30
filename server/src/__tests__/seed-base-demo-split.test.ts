/**
 * Week 7, Task B2 — BUG-118: `db:seed` split into a BASE half
 * (`seedBase`, insert-only forever) and a DEMO half (`seedDemo`, dev-only,
 * unchanged overwrite behaviour).
 *
 * These three cases pin the three guarantees the split exists to make true:
 *
 *  1. `seedBase` alone never reverts an admin-edited `tour_price_tiers` row
 *     — proving the money-affecting half of BUG-118 (a reverted tier
 *     silently undercharges every later booking) cannot happen through the
 *     command that is now safe to re-run against production.
 *  2. `seedBase` alone never reactivates a deactivated driver — the other
 *     half of BUG-118 this task closes (the fleet moved to `seedDemo`,
 *     which `seedBase` must never reach).
 *  3. `seedDemo` refuses to run against any database name other than
 *     `rg_travel`/`rg_travel_test`, on its OWN guard call, independent of
 *     whatever `seedBase` already checked — the thing that makes
 *     `db:seed:demo` safe to leave dev-only rather than merely documented
 *     as dev-only.
 *
 * Each of the three is proven able to fail — see `task-B2-report.md` for the
 * exact break-it-and-watch-it-go-red steps.
 */
import { afterAll, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { getDb } from '../db/client';
import { drivers, tourPriceTiers, tours } from '../db/schema';
import { env } from '../env';
import type { DatabaseFailure } from '../db/guard';
import { seedBase, seedDemo } from '../db/seed';
import { SEED_TOURS } from '../db/seed-data';
import { hashPassword } from '../services/password';
import { describeWithDb } from './helpers/db';
import { resetTestDb } from './helpers/test-db';

const TOUR_SLUG = SEED_TOURS[0]!.slug;

afterAll(async () => {
  await resetTestDb();
});

describeWithDb('seedBase never touches a tour price tier', () => {
  it('leaves an admin-edited tour_price_tiers row alone', async () => {
    // Make sure the tour (and its tiers) genuinely exist before editing one.
    await seedDemo('test');

    const [tour] = await getDb()
      .select({ id: tours.id })
      .from(tours)
      .where(eq(tours.slug, TOUR_SLUG));
    expect(tour, `seed tour "${TOUR_SLUG}" is missing`).toBeDefined();

    const [tier] = await getDb()
      .select({ id: tourPriceTiers.id, price: tourPriceTiers.pricePerPersonCentavos })
      .from(tourPriceTiers)
      .where(eq(tourPriceTiers.tourId, tour!.id))
      .limit(1);
    expect(tier, `tour "${TOUR_SLUG}" has no price tiers`).toBeDefined();

    // The "admin edit": a price nothing in SEED_TOURS would ever produce.
    const edited = tier!.price + 999_900;
    await getDb()
      .update(tourPriceTiers)
      .set({ pricePerPersonCentavos: edited })
      .where(eq(tourPriceTiers.id, tier!.id));

    await seedBase('test');

    const [after] = await getDb()
      .select({ price: tourPriceTiers.pricePerPersonCentavos })
      .from(tourPriceTiers)
      .where(eq(tourPriceTiers.id, tier!.id));
    expect(
      after!.price,
      'seedBase reverted an admin-edited tour price tier — this is the money-affecting half of BUG-118',
    ).toBe(edited);
  }, 60_000);
});

describeWithDb('seedBase never touches the fleet', () => {
  it('does not reactivate a driver inserted directly with is_active = false', async () => {
    const suffix = `${Date.now()}_${Math.floor(Math.random() * 1e9)}`;
    const code = `B2${suffix}`.slice(0, 20);
    const [row] = await getDb()
      .insert(drivers)
      .values({
        name: `Base Split Fixture ${suffix}`,
        code,
        phone: '09170000002',
        pinHash: await hashPassword('000000'),
        isActive: false,
      });
    const driverId = row.insertId;

    try {
      await seedBase('test');

      const [after] = await getDb()
        .select({ isActive: drivers.isActive })
        .from(drivers)
        .where(eq(drivers.id, driverId));
      expect(
        after!.isActive,
        'seedBase reactivated a deactivated driver — the fleet is seedDemo-only and app-database-only',
      ).toBe(false);
    } finally {
      await getDb().delete(drivers).where(eq(drivers.id, driverId));
    }
  }, 60_000);
});

describeWithDb('seedDemo refuses a non-dev database name', () => {
  it('throws DB_WRONG_DATABASE and writes nothing when TEST_DATABASE_URL names a foreign database', async () => {
    const [before] = await getDb()
      .select({ updatedAt: tours.updatedAt })
      .from(tours)
      .where(eq(tours.slug, TOUR_SLUG));
    expect(before, `seed tour "${TOUR_SLUG}" is missing`).toBeDefined();

    const original = env.TEST_DATABASE_URL;
    (env as { TEST_DATABASE_URL?: string }).TEST_DATABASE_URL =
      'mysql://u:p@localhost:3306/kong_pms';
    try {
      const error = await seedDemo('test').catch((e: unknown) => e);
      expect(
        error,
        'seedDemo resolved instead of refusing a database name that is neither rg_travel nor ' +
          'rg_travel_test',
      ).toBeInstanceOf(Error);
      expect((error as DatabaseFailure).code).toBe('DB_WRONG_DATABASE');
    } finally {
      (env as { TEST_DATABASE_URL?: string }).TEST_DATABASE_URL = original;
    }

    // Nothing was written: the guard throws before any query runs, so the
    // tour this refusal would otherwise have touched is untouched down to
    // its own updated_at timestamp.
    const [after] = await getDb()
      .select({ updatedAt: tours.updatedAt })
      .from(tours)
      .where(eq(tours.slug, TOUR_SLUG));
    expect(after!.updatedAt).toEqual(before!.updatedAt);
  }, 30_000);
});

/**
 * Task C2 — the real guard behind `seedDemo()`/`db:seed:demo`. The
 * database-name guard above does NOT protect production (production's own
 * database is also named `rg_travel`), so these two checks are the actual
 * technical barrier. `env` is the parsed, frozen snapshot `env.ts` exports —
 * like `owner-seed.test.ts` and the database-name test above, these tests
 * write to it directly (never `process.env`, which is already read and has
 * no further effect) and restore it in a `finally`.
 *
 * Each check is proven independent: mutating ONLY `ALLOW_DEMO_SEED` away
 * from `'1'` refuses on its own message even with a correct, non-production
 * `NODE_ENV`; mutating ONLY `NODE_ENV` to `'production'` refuses on its own
 * message even with `ALLOW_DEMO_SEED` correctly set to `'1'`.
 */
describeWithDb('seedDemo refuses without ALLOW_DEMO_SEED and outside dev (Task C2)', () => {
  it('refuses when ALLOW_DEMO_SEED is not exactly "1", even against the correct test database', async () => {
    const [before] = await getDb()
      .select({ updatedAt: tours.updatedAt })
      .from(tours)
      .where(eq(tours.slug, TOUR_SLUG));
    expect(before, `seed tour "${TOUR_SLUG}" is missing`).toBeDefined();

    const originalAllow = env.ALLOW_DEMO_SEED;
    (env as { ALLOW_DEMO_SEED?: string }).ALLOW_DEMO_SEED = undefined;
    try {
      const error = await seedDemo('test').catch((e: unknown) => e);
      expect(
        error,
        'seedDemo resolved instead of refusing with ALLOW_DEMO_SEED unset',
      ).toBeInstanceOf(Error);
      expect((error as Error).message).toMatch(/ALLOW_DEMO_SEED/);
    } finally {
      (env as { ALLOW_DEMO_SEED?: string }).ALLOW_DEMO_SEED = originalAllow;
    }

    // Also refused with a non-"1" value, not merely an unset one.
    (env as { ALLOW_DEMO_SEED?: string }).ALLOW_DEMO_SEED = 'true';
    try {
      const error = await seedDemo('test').catch((e: unknown) => e);
      expect((error as Error).message).toMatch(/ALLOW_DEMO_SEED/);
    } finally {
      (env as { ALLOW_DEMO_SEED?: string }).ALLOW_DEMO_SEED = originalAllow;
    }

    // Nothing was written: the guard throws before any query runs.
    const [after] = await getDb()
      .select({ updatedAt: tours.updatedAt })
      .from(tours)
      .where(eq(tours.slug, TOUR_SLUG));
    expect(after!.updatedAt).toEqual(before!.updatedAt);
  }, 30_000);

  it('refuses when NODE_ENV is "production", even with ALLOW_DEMO_SEED=1 and the correct test database', async () => {
    const [before] = await getDb()
      .select({ updatedAt: tours.updatedAt })
      .from(tours)
      .where(eq(tours.slug, TOUR_SLUG));
    expect(before, `seed tour "${TOUR_SLUG}" is missing`).toBeDefined();

    expect(env.ALLOW_DEMO_SEED, 'the test environment must already set ALLOW_DEMO_SEED=1').toBe(
      '1',
    );

    const originalNodeEnv = env.NODE_ENV;
    (env as { NODE_ENV?: string }).NODE_ENV = 'production';
    try {
      const error = await seedDemo('test').catch((e: unknown) => e);
      expect(
        error,
        'seedDemo resolved instead of refusing with NODE_ENV=production',
      ).toBeInstanceOf(Error);
      expect((error as Error).message).toMatch(/NODE_ENV/);
      expect((error as Error).message).toMatch(/production/);
    } finally {
      (env as { NODE_ENV?: string }).NODE_ENV = originalNodeEnv;
    }

    // Nothing was written: the guard throws before any query runs.
    const [after] = await getDb()
      .select({ updatedAt: tours.updatedAt })
      .from(tours)
      .where(eq(tours.slug, TOUR_SLUG));
    expect(after!.updatedAt).toEqual(before!.updatedAt);
  }, 30_000);
});
