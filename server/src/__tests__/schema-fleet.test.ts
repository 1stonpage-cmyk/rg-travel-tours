/**
 * Tasks 3 and 4 of the core-schema plan: the fleet — `vans`, `drivers` and
 * `driver_leaves`.
 *
 * These assertions run against the Drizzle schema objects through
 * `getTableConfig()`, NOT against `information_schema`. That is deliberate,
 * and the same reasoning as `schema-users.test.ts`: Wave 1's migration is
 * generated once, in Task 6, after Tasks 1-5 have all added their tables, so
 * none of these three tables exists in `rg_travel_test` yet. The plan's own
 * Task 3/4 snippets query `information_schema`; they were written assuming
 * the table was already migrated, and a literal transcription of them would
 * be red (or, worse, quietly skipped) until Task 6 and would prove nothing
 * about what Tasks 3 and 4 actually deliver.
 *
 * `getTableConfig()` reads the very object drizzle-kit will generate the DDL
 * from, so "the plate is unique" and "the index is in this order" are pinned
 * at their source rather than at a copy of it. Every test here fails today if
 * the column, constraint or index it names is changed or removed — none can
 * pass because a table is missing.
 */
import { describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { MySqlDialect, getTableConfig } from 'drizzle-orm/mysql-core';
import { getDb, getPool, type Transaction } from '../db/client';
import { DRIVER_STATUSES, VAN_STATUSES, driverLeaves, drivers, vans } from '../db/schema';

/** The columns, indexes and constraints drizzle-kit will emit for a table. */
function inspect(table: Parameters<typeof getTableConfig>[0]) {
  const config = getTableConfig(table);
  return {
    config,
    column: (name: string) => config.columns.find((c) => c.name === name),
    columnNames: config.columns.map((c) => c.name),
    /** Index name -> its columns, in the declared order. Order is load-bearing. */
    indexes: Object.fromEntries(
      config.indexes.map((i) => [
        i.config.name,
        i.config.columns.map((c) => ('name' in c ? c.name : String(c))),
      ]),
    ) as Record<string, string[]>,
  };
}

describe('vans table', () => {
  const { config, column, columnNames, indexes } = inspect(vans);

  it('stores capacity as a plain integer seat count, never a decimal', () => {
    const capacity = column('capacity');
    expect(capacity?.getSQLType()).toBe('int');
    expect(capacity?.notNull).toBe(true);
  });

  it('makes the plate unique, so one physical van cannot become two rows', () => {
    expect(column('plate')?.isUnique).toBe(true);
    expect(column('plate')?.notNull).toBe(true);
  });

  it('constrains status to the four fleet states from BUILD_SPEC §9, defaulting to available', () => {
    expect([...VAN_STATUSES]).toEqual(['available', 'on_trip', 'parked', 'for_repair']);
    expect(column('status')?.enumValues).toEqual([...VAN_STATUSES]);
    expect(column('status')?.default).toBe('available');
    expect(column('status')?.notNull).toBe(true);
  });

  it('soft-deletes through is_active rather than removing the row', () => {
    const isActive = column('is_active');
    expect(isActive?.notNull).toBe(true);
    expect(isActive?.default).toBe(true);
  });

  /**
   * The order matters, and is why this test exists rather than just checking
   * the index is present. The §5 capacity query filters active + status
   * equal to `VAN_STATUS_SELLABLE` (the Q1 allow-list, owner-decided
   * 2026-10-14 — it replaced a `<> 'for_repair'` deny-list) and only then
   * needs `capacity >= pax`, so the two equality
   * columns must precede the range column — put `capacity` first and MySQL
   * can no longer use the index for the equality filters at all.
   */
  it('orders the fleet index (is_active, status, capacity) for the capacity query', () => {
    expect(indexes['vans_active_status_idx']).toEqual(['is_active', 'status', 'capacity']);
  });

  it('times everything with datetime, never MySQL timestamp (which shifts per session)', () => {
    for (const name of ['last_service', 'created_at', 'updated_at'] as const) {
      expect(column(name)?.getSQLType(), `${name} is not a date/datetime`).toMatch(
        /^(date|datetime)$/,
      );
    }
    expect(column('created_at')?.getSQLType()).toBe('datetime');
    expect(column('updated_at')?.getSQLType()).toBe('datetime');
    // Service/compliance dates are civil dates, not instants — a van's OR/CR
    // expires on a day in Manila, not at an hour UTC.
    for (const name of ['last_service', 'next_service', 'orcr_expiry', 'franchise_expiry']) {
      expect(column(name)?.getSQLType(), `${name} should be a civil date`).toBe('date');
    }
  });

  it('holds no money column, so no centavos convention can be broken here', () => {
    expect(columnNames.filter((n) => /price|amount|centavos|cost|fee/i.test(n))).toEqual([]);
  });

  it('references nothing — the fleet is a Wave 1 table with no foreign keys', () => {
    expect(config.foreignKeys).toHaveLength(0);
  });
});

describe('drivers table', () => {
  const { config, column, columnNames, indexes } = inspect(drivers);

  /**
   * The security assertion. A driver signs in with a SIX-digit PIN (owner
   * decision 2026-10-11, Q9) — a six-digit secret is brute-forceable in a
   * million guesses, so the lockout policy below is what actually protects
   * it, and a plaintext copy of the PIN anywhere in this table would hand an
   * attacker with read access every driver account at once.
   *
   * The regex sweep, rather than a bare `not.toContain('pin')`, is what makes
   * this survive someone adding `pin_plain`, `pin_last4` or `pin_backup`
   * later: the ONLY column whose name begins with "pin" may be `pin_hash`.
   */
  it('never stores a PIN in plain text — pin_hash is the only pin column', () => {
    expect(columnNames).toContain('pin_hash');
    expect(columnNames).not.toContain('pin');
    expect(columnNames.filter((n) => /^pin/.test(n))).toEqual(['pin_hash']);
    expect(columnNames.filter((n) => /pin|secret|plain/i.test(n))).toEqual(['pin_hash']);
  });

  it('sizes pin_hash for an argon2id encoded hash, and requires one', () => {
    expect(column('pin_hash')?.getSQLType()).toBe('varchar(255)');
    expect(column('pin_hash')?.notNull).toBe(true);
  });

  it('makes the login code unique, so two drivers cannot share one identity', () => {
    expect(column('code')?.isUnique).toBe(true);
    expect(column('code')?.notNull).toBe(true);
  });

  /**
   * All five columns Task 21's lockout policy is implemented against:
   * 5 consecutive failures -> a 15-minute lock; 3 locks inside one 24h
   * window -> an admin must unlock. Task 21 cannot be written if any one of
   * them is missing, and a missing counter does not fail loudly — it makes
   * the policy silently weaker than the spec says it is, which is the worst
   * possible failure mode for a brute-force defence.
   */
  it('ships all five lockout columns the Task 21 policy needs', () => {
    for (const name of [
      'failed_attempts',
      'locked_until',
      'lockout_count',
      'lockout_window_started_at',
      'requires_admin_unlock',
    ]) {
      expect(columnNames, `the lockout policy needs ${name}`).toContain(name);
    }
  });

  it('starts both lockout counters at zero and never lets them be null', () => {
    for (const name of ['failed_attempts', 'lockout_count']) {
      const counter = column(name);
      expect(counter?.getSQLType(), `${name} is not an int`).toBe('int');
      expect(counter?.notNull, `${name} is nullable`).toBe(true);
      expect(counter?.default, `${name} does not start at 0`).toBe(0);
    }
  });

  it('times both lockout clocks as nullable UTC datetimes, never MySQL timestamp', () => {
    for (const name of ['locked_until', 'lockout_window_started_at']) {
      expect(column(name)?.getSQLType(), `${name} is not a datetime`).toBe('datetime');
      // Nullable is the "not locked" / "no window open" state. A NOT NULL
      // column would need a sentinel date, and a sentinel date in a lockout
      // check is how a lock accidentally never expires — or never applies.
      expect(column(name)?.notNull, `${name} should be nullable`).toBe(false);
    }
  });

  /**
   * Fails closed by construction: the flag is a non-null boolean, so a
   * driver is either locked out of self-service or not — there is no third,
   * unknown state a check could read as "probably fine". And there is
   * deliberately NO expiry column beside it: per the spec only an admin
   * clears it, never a timer, so no column exists for a timer to consult.
   */
  it('gates the hard lockout on an admin-only boolean with no expiry beside it', () => {
    const flag = column('requires_admin_unlock');
    expect(flag?.notNull).toBe(true);
    expect(flag?.default).toBe(false);
    expect(columnNames.filter((n) => /admin_unlock/.test(n))).toEqual(['requires_admin_unlock']);
  });

  it('constrains status to the three duty states, defaulting to available', () => {
    expect([...DRIVER_STATUSES]).toEqual(['available', 'on_trip', 'off_duty']);
    expect(column('status')?.enumValues).toEqual([...DRIVER_STATUSES]);
    expect(column('status')?.default).toBe('available');
    expect(column('status')?.notNull).toBe(true);
  });

  it('soft-deletes through is_active rather than removing the row', () => {
    const isActive = column('is_active');
    expect(isActive?.notNull).toBe(true);
    expect(isActive?.default).toBe(true);
  });

  it('keeps the licence expiry a civil Manila date, not an instant', () => {
    expect(column('license_expiry')?.getSQLType()).toBe('date');
    expect(column('created_at')?.getSQLType()).toBe('datetime');
    expect(column('updated_at')?.getSQLType()).toBe('datetime');
  });

  it('indexes the dispatch lookup: active drivers by duty status', () => {
    expect(indexes['drivers_active_status_idx']).toEqual(['is_active', 'status']);
  });

  it('references nothing — drivers is a Wave 1 table with no foreign keys', () => {
    expect(config.foreignKeys).toHaveLength(0);
  });
});

describe('driver_leaves table', () => {
  const { config, column, indexes } = inspect(driverLeaves);

  it('points at a real driver through a foreign key', () => {
    expect(config.foreignKeys).toHaveLength(1);
    const fk = config.foreignKeys[0]?.reference();
    expect(fk?.columns.map((c) => c.name)).toEqual(['driver_id']);
    expect(fk?.foreignColumns.map((c) => c.name)).toEqual(['id']);
    expect(fk?.foreignTable).toBe(drivers);
    expect(column('driver_id')?.notNull).toBe(true);
  });

  /**
   * Civil dates in Asia/Manila, inclusive both ends. A `datetime` here would
   * make "off on the 25th" depend on an hour and a zone, and a leave that
   * ends at 00:00 on its last day is a driver dispatched on a day they are
   * not working.
   */
  it('stores the range as two required civil dates, never instants', () => {
    for (const name of ['start_date', 'end_date']) {
      expect(column(name)?.getSQLType(), `${name} is not a date`).toBe('date');
      expect(column(name)?.notNull, `${name} is nullable`).toBe(true);
    }
  });

  it('indexes (driver_id, start_date, end_date) for the availability lookup', () => {
    expect(indexes['driver_leaves_driver_range_idx']).toEqual([
      'driver_id',
      'start_date',
      'end_date',
    ]);
  });

  it('times the row itself in UTC, keeping the instant and the dates distinct', () => {
    expect(column('created_at')?.getSQLType()).toBe('datetime');
    expect(column('created_at')?.notNull).toBe(true);
  });

  /**
   * Task 11b-3. The range must run forwards, enforced in the database and
   * not only in Zod. The clause itself, not just the name: `CHECK (1 = 1)`
   * is a constraint that exists, migrates cleanly and enforces nothing.
   *
   * `>=`, because the range is inclusive at both ends — a one-day leave is
   * `start_date = end_date`, which `>` would refuse.
   */
  it('declares a CHECK that the range runs forwards, inclusive at both ends', () => {
    expect(config.checks.map((c) => c.name)).toEqual(['driver_leaves_date_order']);
    const clause = new MySqlDialect().sqlToQuery(config.checks[0]!.value).sql;
    expect(clause).toContain('`driver_leaves`.`end_date` >= `driver_leaves`.`start_date`');
  });
});

/**
 * Task 11b-3: the `end_date >= start_date` CHECK, against the real database.
 *
 * `schema-fleet.test.ts` was until now a pure `getTableConfig()` file,
 * because Wave 1 had not been migrated when Tasks 3 and 4 were written. It
 * has since been applied, so the CHECK can be — and must be — proven live
 * and enforcing, not merely declared: MySQL 8.0.15 and earlier PARSE a
 * CHECK and silently ignore it, which is the difference between a
 * constraint and a comment. (This server is 8.0.46.)
 *
 * Gated on the table existing, the same runtime probe
 * `schema-coupons.test.ts` uses, so it reports SKIPPED rather than silently
 * passing if the migration were ever lost.
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

const leavesExist = await tableExists('driver_leaves');
const dbIt = leavesExist ? it : it.skip;

/** Thrown to roll the fixture transaction back; never escapes `inRollback`. */
const ROLLBACK = new Error('__rollback__');

/**
 * Runs `fn` in a transaction that is always rolled back, so these tests
 * leave no driver and no leave behind — the same helper shape
 * `schema-trips.test.ts` uses.
 */
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

/** A driver, for the `driver_id` foreign key to point at. */
async function makeDriver(tx: Transaction): Promise<number> {
  const unique = `__fleet__${Date.now() % 1e9}_${Math.floor(Math.random() * 1e4)}`;
  const [driver] = await tx.insert(drivers).values({
    name: 'Test Driver',
    code: unique.slice(0, 20),
    phone: '09170000000',
    pinHash: 'x'.repeat(40),
  });
  return driver.insertId;
}

/**
 * Runs `run` and reports the MySQL error code it was refused with, or `null`
 * when the database accepted it. The code, not the message: Drizzle wraps a
 * mysql2 error in a `DrizzleQueryError` whose message is the SQL text.
 */
async function rejectionCode(run: () => Promise<unknown>): Promise<string | null> {
  try {
    await run();
    return null;
  } catch (error) {
    let current: unknown = error;
    for (let depth = 0; depth < 5 && current != null; depth += 1) {
      if (typeof current !== 'object') break;
      const code = (current as { code?: unknown }).code;
      if (typeof code === 'string') return code;
      current = (current as { cause?: unknown }).cause;
    }
    return 'UNRECOGNISED';
  }
}

describe('driver_leaves, as actually migrated', () => {
  dbIt('has the date-order CHECK live in information_schema', async () => {
    const [rows] = (await getPool().query(
      'SELECT CONSTRAINT_NAME FROM information_schema.check_constraints ' +
        'WHERE CONSTRAINT_SCHEMA = DATABASE() AND CONSTRAINT_NAME = ?',
      ['driver_leaves_date_order'],
    )) as [Array<{ CONSTRAINT_NAME: string }>, unknown];
    expect(rows, 'driver_leaves_date_order is not an enforced constraint').toHaveLength(1);
  });

  /**
   * The row this CHECK exists to stop. A backwards range is not untidy: the
   * availability query asks `start_date <= :day AND end_date >= :day`, which
   * a reversed range can NEVER satisfy — so the leave silently does nothing
   * and the driver is dispatched on a day they said they were off.
   *
   * A raw `INSERT`, bypassing Zod entirely: the point is that the DATABASE
   * refuses it, the way it must for a seed script or a hand-written UPDATE.
   */
  dbIt('REFUSES a leave that ends before it starts', async () => {
    await inRollback(async (tx) => {
      const driverId = await makeDriver(tx);
      expect(
        await rejectionCode(() =>
          tx.execute(
            sql`INSERT INTO driver_leaves (driver_id, start_date, end_date, created_at)
                VALUES (${driverId}, '2026-12-26', '2026-12-24', UTC_TIMESTAMP())`,
          ),
        ),
        'a backwards leave was stored — it will match no availability query',
      ).toBe('ER_CHECK_CONSTRAINT_VIOLATED');
    });
  });

  /**
   * `>=`, not `>`. The range is inclusive at both ends, so a one-day leave
   * is `start_date = end_date` — and a CHECK written with `>` would refuse
   * the single commonest leave there is.
   */
  dbIt('ACCEPTS a single-day leave, where start_date = end_date', async () => {
    await inRollback(async (tx) => {
      const driverId = await makeDriver(tx);
      expect(
        await rejectionCode(() =>
          tx.execute(
            sql`INSERT INTO driver_leaves (driver_id, start_date, end_date, created_at)
                VALUES (${driverId}, '2026-12-25', '2026-12-25', UTC_TIMESTAMP())`,
          ),
        ),
        'a one-day leave was refused — the CHECK uses > instead of >=',
      ).toBeNull();
    });
  });

  dbIt('ACCEPTS a normal multi-day leave', async () => {
    await inRollback(async (tx) => {
      const driverId = await makeDriver(tx);
      expect(
        await rejectionCode(() =>
          tx.execute(
            sql`INSERT INTO driver_leaves (driver_id, start_date, end_date, created_at)
                VALUES (${driverId}, '2026-12-24', '2026-12-26', UTC_TIMESTAMP())`,
          ),
        ),
        'a normal leave was refused',
      ).toBeNull();
    });
  });
});
