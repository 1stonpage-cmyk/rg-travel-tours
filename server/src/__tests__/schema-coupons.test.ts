/**
 * Task 5 of the core-schema plan: `coupons`, and the CHECK constraint that
 * makes a malformed discount impossible rather than merely unlikely.
 *
 * The discount is three columns (owner decision 2026-10-11, Q6):
 * `discount_type` plus a nullable `percent_bp` (BASIS POINTS) and a nullable
 * `amount_centavos`. Exactly one of the two is set and it must match
 * `discount_type` — enforced twice, once in Zod at the API boundary and once
 * in the database for everything that never passes through it.
 *
 * Four layers, for one reason each:
 *
 *  1. **Zod assertions** pin `couponDiscountSchema`, the discriminated union
 *     that mirrors the CHECK. Pure; no database.
 *
 *  2. **Schema assertions** read the Drizzle table object through
 *     `getTableConfig()`, not `information_schema` — Wave 1's migration is
 *     generated once, in Task 6, so `coupons` does not exist in
 *     `rg_travel_test` yet. Same reasoning as `schema-users.test.ts` and
 *     `schema-fleet.test.ts`. This layer includes the CHECK's *clause*, so a
 *     constraint quietly gutted to `1 = 1` goes red with no database at all.
 *
 *  3. **The live-constraint assertion** reads
 *     `information_schema.check_constraints`. It matters because on MySQL
 *     8.0.15 and earlier a CHECK is *parsed and silently ignored*; one row
 *     here is the difference between an enforced constraint and a decorative
 *     one. (This server is 8.0.46, where it is enforced.)
 *
 *  4. **The four rejection tests** issue raw `INSERT`s — deliberately NOT a
 *     Drizzle insert through a Zod-validated helper. The whole point is that
 *     the *database* refuses the row, so they must bypass every
 *     application-level check; a version going through Zod would prove
 *     nothing about the CHECK and would stay green if it were dropped.
 *
 * Layers 3 and 4 need the migrated table, so they are gated on `coupons`
 * actually existing and report as SKIPPED until Task 6 applies Wave 1 — not
 * as passing, which is the failure mode to avoid. The gate is a runtime
 * probe, so they enable themselves the moment the table appears.
 *
 * Their ability to fail was proven by hand (see the Task 5 report): with
 * `coupons` provisioned in `rg_travel_test` from the generated DDL,
 * `ALTER TABLE coupons DROP CHECK coupons_discount_shape` turned all four
 * rejection tests and the live-constraint test red; restoring the constraint
 * turned them green; the table was then dropped again.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { MySqlDialect, getTableConfig } from 'drizzle-orm/mysql-core';
import { DISCOUNT_TYPES, couponDiscountSchema } from '@rg/shared';
import { getPool } from '../db/client';
import { coupons } from '../db/schema';

const config = getTableConfig(coupons);
const column = (name: string) => config.columns.find((c) => c.name === name);
const columnNames = config.columns.map((c) => c.name);
const indexes = Object.fromEntries(
  config.indexes.map((i) => [
    i.config.name,
    i.config.columns.map((c) => ('name' in c ? c.name : String(c))),
  ]),
) as Record<string, string[]>;

describe('couponDiscountSchema', () => {
  it('names exactly the two discount types the schema enumerates', () => {
    expect([...DISCOUNT_TYPES]).toEqual(['percent', 'fixed']);
  });

  it('accepts a well-formed percent discount in basis points', () => {
    // 250 bp = 2.5%, the case a whole-percent int could not express.
    for (const percentBp of [1, 250, 1000, 10000]) {
      const result = couponDiscountSchema.safeParse({
        discountType: 'percent',
        percentBp,
        amountCentavos: null,
      });
      expect(result.success, `${percentBp} bp should be valid`).toBe(true);
    }
  });

  it('accepts a well-formed fixed discount in centavos', () => {
    expect(
      couponDiscountSchema.safeParse({
        discountType: 'fixed',
        percentBp: null,
        amountCentavos: 10000,
      }).success,
    ).toBe(true);
  });

  /**
   * The same four malformed shapes the CHECK refuses. Zod is the first line;
   * the database is the one that holds when a seed script or a 2am UPDATE
   * skips the API entirely.
   */
  it('rejects all four malformed discount shapes', () => {
    const malformed = [
      {
        label: 'percent with centavos instead',
        discountType: 'percent',
        percentBp: null,
        amountCentavos: 10000,
      },
      {
        label: 'fixed with basis points instead',
        discountType: 'fixed',
        percentBp: 1000,
        amountCentavos: null,
      },
      {
        label: 'both columns set',
        discountType: 'percent',
        percentBp: 1000,
        amountCentavos: 10000,
      },
      {
        label: 'neither column set',
        discountType: 'percent',
        percentBp: null,
        amountCentavos: null,
      },
    ];
    for (const { label, ...input } of malformed) {
      expect(couponDiscountSchema.safeParse(input).success, `${label} was accepted`).toBe(false);
    }
  });

  it('rejects a percentage outside 1..10000 basis points, and a fractional one', () => {
    for (const percentBp of [0, -100, 10001, 250.5]) {
      expect(
        couponDiscountSchema.safeParse({ discountType: 'percent', percentBp, amountCentavos: null })
          .success,
        `${percentBp} bp should be rejected`,
      ).toBe(false);
    }
  });

  it('rejects a zero or fractional fixed discount — centavos are whole, and 0 is not a coupon', () => {
    for (const amountCentavos of [0, -1, 1000.5]) {
      expect(
        couponDiscountSchema.safeParse({ discountType: 'fixed', percentBp: null, amountCentavos })
          .success,
        `${amountCentavos} centavos should be rejected`,
      ).toBe(false);
    }
  });

  it('rejects a discount type outside the enum', () => {
    expect(
      couponDiscountSchema.safeParse({
        discountType: 'bogo',
        percentBp: 1000,
        amountCentavos: null,
      }).success,
    ).toBe(false);
  });
});

describe('coupons table', () => {
  it('declares the discount-shape CHECK and both range CHECKs', () => {
    expect(config.checks.map((c) => c.name).sort()).toEqual([
      'coupons_amount_positive',
      'coupons_discount_shape',
      'coupons_percent_bp_range',
    ]);
  });

  /**
   * Task 11b-1. The shape CHECK asks only WHICH column is set, never what
   * is in it — so `percent_bp = 999999` and `amount_centavos = -5000` both
   * satisfied it, and the second is a surcharge wearing a coupon's name.
   *
   * The clauses, not just the names: a range CHECK gutted to `1 = 1` exists,
   * migrates cleanly, and enforces nothing. Both bounds must appear.
   */
  it('bounds percent_bp to 1..10000 basis points in the CHECK clause itself', () => {
    const check = config.checks.find((c) => c.name === 'coupons_percent_bp_range');
    const clause = new MySqlDialect().sqlToQuery(check!.value).sql;
    for (const fragment of ['`percent_bp` >= 1', '`percent_bp` <= 10000']) {
      expect(clause, `the range CHECK no longer bounds ${fragment}`).toContain(fragment);
    }
  });

  it('requires a fixed discount to be strictly positive in the CHECK clause itself', () => {
    const check = config.checks.find((c) => c.name === 'coupons_amount_positive');
    const clause = new MySqlDialect().sqlToQuery(check!.value).sql;
    // `> 0`, not `>= 0`: a zero discount shows as applied and takes nothing off.
    expect(clause).toContain('`amount_centavos` > 0');
  });

  /**
   * The clause itself, not just its name. A CHECK can be renamed-and-kept or
   * kept-and-gutted, and only the second is dangerous: `CHECK (1 = 1)` is a
   * constraint that exists, migrates cleanly, and enforces nothing. Both
   * enum literals and both discount columns must appear, plus the two
   * `IS NOT NULL` / `IS NULL` pairs that make "exactly one" exactly one.
   */
  it('checks both directions of the shape, not a clause that always passes', () => {
    const clause = new MySqlDialect().sqlToQuery(config.checks[0]!.value).sql;
    for (const fragment of [
      "`discount_type` = 'percent'",
      "`discount_type` = 'fixed'",
      '`percent_bp` IS NOT NULL',
      '`percent_bp` IS NULL',
      '`amount_centavos` IS NOT NULL',
      '`amount_centavos` IS NULL',
    ]) {
      expect(clause, `the CHECK clause no longer mentions ${fragment}`).toContain(fragment);
    }
    expect(clause).toContain(' OR ');
  });

  it('constrains discount_type to the shared DISCOUNT_TYPES, so there is one source of truth', () => {
    expect(column('discount_type')?.enumValues).toEqual([...DISCOUNT_TYPES]);
    expect(column('discount_type')?.notNull).toBe(true);
  });

  /**
   * Both discount columns are nullable ints and the CHECK decides which one
   * is populated. Making either NOT NULL would force a sentinel zero into
   * the unused one — and a zero discount that looks set is precisely the bug
   * this design prevents.
   */
  it('stores the discount as nullable integer basis points or centavos, never a float', () => {
    for (const name of ['percent_bp', 'amount_centavos']) {
      expect(column(name)?.getSQLType(), `${name} is not an int`).toBe('int');
      expect(column(name)?.notNull, `${name} should be nullable`).toBe(false);
    }
  });

  it('names every money column *_centavos, and percent_bp is not one of them', () => {
    expect(columnNames.filter((n) => /amount|spend|price|cost|fee/i.test(n)).sort()).toEqual([
      'amount_centavos',
      'min_spend_centavos',
    ]);
    for (const name of ['amount_centavos', 'min_spend_centavos']) {
      expect(column(name)?.getSQLType()).toBe('int');
    }
    // Basis points are a ratio, not money — the suffix would be a lie.
    expect(columnNames).toContain('percent_bp');
    expect(columnNames).not.toContain('percent_centavos');
  });

  it('makes the code unique, so one coupon code cannot mean two discounts', () => {
    expect(column('code')?.isUnique).toBe(true);
    expect(column('code')?.notNull).toBe(true);
  });

  /**
   * The usage cap. `used_count` must never be null: a null counter compared
   * against `usage_limit` yields NULL, which is not "over the limit", so an
   * unlimited coupon is exactly what a nullable counter would silently
   * produce.
   */
  it('starts used_count at zero and never lets it be null', () => {
    expect(column('used_count')?.getSQLType()).toBe('int');
    expect(column('used_count')?.notNull).toBe(true);
    expect(column('used_count')?.default).toBe(0);
    // Null `usage_limit` is the deliberate "unlimited" state.
    expect(column('usage_limit')?.notNull).toBe(false);
  });

  it('soft-deletes through is_active rather than removing the row', () => {
    expect(column('is_active')?.notNull).toBe(true);
    expect(column('is_active')?.default).toBe(true);
  });

  /**
   * The window is UTC instants, not civil dates: a coupon that expires "at
   * midnight Manila" is a specific moment, and `timestamp` would shift it
   * with the session time zone.
   */
  it('times the window with datetime, never MySQL timestamp (which shifts per session)', () => {
    for (const name of ['starts_at', 'ends_at', 'created_at', 'updated_at']) {
      expect(column(name)?.getSQLType(), `${name} is not a datetime`).toBe('datetime');
    }
    // An open-ended window is both ends null, not a sentinel date.
    expect(column('starts_at')?.notNull).toBe(false);
    expect(column('ends_at')?.notNull).toBe(false);
  });

  it('indexes (is_active, starts_at, ends_at) for the checkout validity lookup', () => {
    expect(indexes['coupons_active_window_idx']).toEqual(['is_active', 'starts_at', 'ends_at']);
  });

  it('references nothing — coupons is a Wave 1 table with no foreign keys', () => {
    expect(config.foreignKeys).toHaveLength(0);
  });
});

/**
 * True once Wave 1 (Task 6) has created the table in `rg_travel_test`. Also
 * false when MySQL is unreachable, which is how the rest of the suite behaves
 * (see `helpers/db.ts`).
 */
async function tableExists(name: string): Promise<boolean> {
  try {
    const [rows] = (await getPool().query(
      'SELECT 1 FROM information_schema.tables WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?',
      [name],
    )) as [unknown[], unknown];
    return rows.length > 0;
  } catch {
    return false;
  }
}

const couponsExists = await tableExists('coupons');
const dbIt = couponsExists ? it : it.skip;

/** A test-only code, so cleanup can delete exactly what these tests wrote. */
const CODE_PREFIX = '__COUPON_TEST__';

/**
 * A RAW insert. No Drizzle model, no Zod, no service helper — the rejection
 * tests below have to reach the database with a malformed row, the way a
 * seed script or a hand-written UPDATE would, or they prove nothing about
 * the CHECK.
 */
async function insertCoupon(values: {
  code?: string;
  discountType: string;
  percentBp: number | null;
  amountCentavos: number | null;
}) {
  const code = values.code ?? `${CODE_PREFIX}${Math.random().toString(36).slice(2, 10)}`;
  return getPool().query(
    'INSERT INTO coupons (code, discount_type, percent_bp, amount_centavos, used_count, is_active, created_at, updated_at) ' +
      'VALUES (?, ?, ?, ?, 0, 1, UTC_TIMESTAMP(), UTC_TIMESTAMP())',
    [code, values.discountType, values.percentBp, values.amountCentavos],
  );
}

describe('coupons, against the real database', () => {
  afterAll(async () => {
    if (!couponsExists) return;
    await getPool().query('DELETE FROM coupons WHERE code LIKE ?', [`${CODE_PREFIX}%`]);
  });

  /**
   * The plan's Step 5, as a test rather than a one-off query. MySQL 8.0.15
   * and earlier PARSE a CHECK and silently ignore it; zero rows here means
   * the constraint is decorative and every rejection test below is lying.
   */
  dbIt('has the CHECK live in information_schema, not merely written in the DDL', async () => {
    const [rows] = (await getPool().query(
      'SELECT CONSTRAINT_NAME FROM information_schema.check_constraints ' +
        'WHERE CONSTRAINT_SCHEMA = DATABASE() AND CONSTRAINT_NAME = ?',
      ['coupons_discount_shape'],
    )) as [Array<{ CONSTRAINT_NAME: string }>, unknown];
    expect(rows, 'coupons_discount_shape is not an enforced constraint').toHaveLength(1);
  });

  /** The same question for the two range CHECKs added in task 11b-1. */
  dbIt('has both range CHECKs live in information_schema', async () => {
    const [rows] = (await getPool().query(
      'SELECT CONSTRAINT_NAME FROM information_schema.check_constraints ' +
        'WHERE CONSTRAINT_SCHEMA = DATABASE() AND CONSTRAINT_NAME IN (?) ORDER BY CONSTRAINT_NAME',
      [['coupons_amount_positive', 'coupons_percent_bp_range']],
    )) as [Array<{ CONSTRAINT_NAME: string }>, unknown];
    expect(rows.map((r) => r.CONSTRAINT_NAME)).toEqual([
      'coupons_amount_positive',
      'coupons_percent_bp_range',
    ]);
  });

  dbIt('stores the discount as basis points or centavos, never a float', async () => {
    const [cols] = (await getPool().query(
      'SELECT COLUMN_NAME, DATA_TYPE, IS_NULLABLE FROM information_schema.columns ' +
        "WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'coupons' " +
        "AND COLUMN_NAME IN ('discount_type','percent_bp','amount_centavos') ORDER BY COLUMN_NAME",
    )) as [Array<{ COLUMN_NAME: string; DATA_TYPE: string; IS_NULLABLE: string }>, unknown];

    expect(cols.map((c) => c.COLUMN_NAME)).toEqual([
      'amount_centavos',
      'discount_type',
      'percent_bp',
    ]);
    expect(cols.find((c) => c.COLUMN_NAME === 'percent_bp')?.DATA_TYPE).toBe('int');
    expect(cols.find((c) => c.COLUMN_NAME === 'amount_centavos')?.DATA_TYPE).toBe('int');
    // Both nullable: exactly one is set per row, and the CHECK decides which.
    expect(cols.find((c) => c.COLUMN_NAME === 'percent_bp')?.IS_NULLABLE).toBe('YES');
    expect(cols.find((c) => c.COLUMN_NAME === 'amount_centavos')?.IS_NULLABLE).toBe('YES');
    expect(cols.find((c) => c.COLUMN_NAME === 'discount_type')?.IS_NULLABLE).toBe('NO');
  });

  dbIt('accepts a well-formed percent coupon', async () => {
    await expect(
      insertCoupon({ discountType: 'percent', percentBp: 1000, amountCentavos: null }),
    ).resolves.toBeDefined();
  });

  dbIt('accepts a well-formed fixed coupon', async () => {
    await expect(
      insertCoupon({ discountType: 'fixed', percentBp: null, amountCentavos: 10000 }),
    ).resolves.toBeDefined();
  });

  // The four ways a row can be malformed. Each must be refused BY THE DATABASE,
  // so a bad row cannot arrive through a path that skipped Zod — a seed script,
  // a migration, a manual fix in a SQL client at 2am.
  dbIt('REFUSES percent with the centavos column set instead', async () => {
    await expect(
      insertCoupon({ discountType: 'percent', percentBp: null, amountCentavos: 10000 }),
    ).rejects.toThrow(/check constraint/i);
  });

  dbIt('REFUSES fixed with the basis-points column set instead', async () => {
    await expect(
      insertCoupon({ discountType: 'fixed', percentBp: 1000, amountCentavos: null }),
    ).rejects.toThrow(/check constraint/i);
  });

  dbIt('REFUSES both columns set at once', async () => {
    await expect(
      insertCoupon({ discountType: 'percent', percentBp: 1000, amountCentavos: 10000 }),
    ).rejects.toThrow(/check constraint/i);
  });

  /**
   * The one that justifies the CHECK existing at all: a row with neither
   * column set looks perfectly valid in the admin list and makes every
   * discount it is applied to silently zero.
   */
  dbIt('REFUSES neither column set', async () => {
    await expect(
      insertCoupon({ discountType: 'percent', percentBp: null, amountCentavos: null }),
    ).rejects.toThrow(/check constraint/i);
  });

  /**
   * Task 11b-1, the range. Every one of these rows satisfies
   * `coupons_discount_shape` — the right column is set and it matches
   * `discount_type` — so before the range CHECKs existed the database took
   * all five without complaint.
   *
   * Raw `INSERT`s, bypassing Zod entirely: the point is that the DATABASE
   * refuses them, the way it must when a seed script, a migration or a hand
   * -written UPDATE skips the API.
   */
  dbIt('REFUSES a percentage above 100% (10000 bp), the 9999.99% coupon', async () => {
    await expect(
      insertCoupon({ discountType: 'percent', percentBp: 999999, amountCentavos: null }),
    ).rejects.toThrow(/check constraint/i);
  });

  dbIt('REFUSES a zero or negative percentage, which is not a discount', async () => {
    for (const percentBp of [0, -100]) {
      await expect(
        insertCoupon({ discountType: 'percent', percentBp, amountCentavos: null }),
        `${percentBp} bp was accepted`,
      ).rejects.toThrow(/check constraint/i);
    }
  });

  /** A negative "discount" ADDS ₱50 to the bill. */
  dbIt('REFUSES a negative fixed discount, which is a surcharge', async () => {
    await expect(
      insertCoupon({ discountType: 'fixed', percentBp: null, amountCentavos: -5000 }),
    ).rejects.toThrow(/check constraint/i);
  });

  dbIt('REFUSES a zero fixed discount, which applies and takes nothing off', async () => {
    await expect(
      insertCoupon({ discountType: 'fixed', percentBp: null, amountCentavos: 0 }),
    ).rejects.toThrow(/check constraint/i);
  });

  /**
   * The bounds themselves are INCLUSIVE: 1 bp (0.01%) and 10000 bp (100%)
   * are both real coupons, and a range CHECK written with `>` instead of
   * `>=` would quietly refuse a 100%-off comp the owner meant to issue.
   */
  dbIt('ACCEPTS both ends of the range — 1 bp and 10000 bp, and 1 centavo', async () => {
    for (const percentBp of [1, 10000]) {
      await expect(
        insertCoupon({ discountType: 'percent', percentBp, amountCentavos: null }),
        `${percentBp} bp was refused`,
      ).resolves.toBeDefined();
    }
    await expect(
      insertCoupon({ discountType: 'fixed', percentBp: null, amountCentavos: 1 }),
    ).resolves.toBeDefined();
  });

  dbIt('refuses a duplicate code', async () => {
    const code = `${CODE_PREFIX}DUP${Date.now() % 100000}`;
    await insertCoupon({ code, discountType: 'percent', percentBp: 1000, amountCentavos: null });
    await expect(
      insertCoupon({ code, discountType: 'fixed', percentBp: null, amountCentavos: 10000 }),
    ).rejects.toThrow(/duplicate/i);
  });
});
