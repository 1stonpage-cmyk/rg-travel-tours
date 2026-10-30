/**
 * Task 8 of the core-schema plan: the `bookings` table — the central record
 * of the whole system.
 *
 * Three layers, for one reason each:
 *
 *  1. **Shared constants.** `BOOKING_STATUSES`, `CAPACITY_HOLDING_STATUSES`,
 *     `PAY_MODES` and `priceSnapshotSchema` are plain data from `@rg/shared`
 *     with no database anywhere near them, so these assertions run always
 *     and everywhere.
 *
 *  2. **Schema assertions** read the Drizzle table object through
 *     `getTableConfig()`, not `information_schema`. `bookings` is a WAVE 2
 *     table, and Waves 2–4 are generated once, in Task 11 — so it does not
 *     exist in `rg_travel_test` yet. `getTableConfig()` reads the very
 *     object drizzle-kit will generate the DDL from, so every assertion here
 *     fails today if the column, constraint or index it names is changed —
 *     none passes because a table is missing.
 *
 *  3. **The same load-bearing properties, re-asserted against the real
 *     database**, gated on `bookings` actually existing. They report as
 *     SKIPPED until Task 11 applies Wave 2, and enable themselves the moment
 *     the table appears — the pattern `audit.test.ts` and
 *     `schema-sessions.test.ts` use. A schema object and the DDL drizzle-kit
 *     emits from it are two different things, and "every money column is an
 *     int" is exactly the kind of property a generator could get wrong
 *     silently.
 */
import { describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { getTableConfig } from 'drizzle-orm/mysql-core';
import {
  BOOKING_STATUSES,
  CAPACITY_HOLDING_STATUSES,
  PAY_MODES,
  bookingRefSchema,
  priceSnapshotSchema,
  type PriceSnapshot,
} from '@rg/shared';
import { getDb, getPool, type Transaction } from '../db/client';
import { bookings, coupons, destinations, drivers, tours, vans } from '../db/schema';

/**
 * The four money columns, and the CHECK that keeps each of them from going
 * negative (task 16b-6). One name per column, so a violation says which.
 */
const MONEY_CHECKS = [
  ['subtotal_centavos', 'bookings_subtotal_non_negative'],
  ['discount_centavos', 'bookings_discount_non_negative'],
  ['total_centavos', 'bookings_total_non_negative'],
  ['amount_paid_centavos', 'bookings_amount_paid_non_negative'],
] as const;

const config = getTableConfig(bookings);
const column = (name: string) => config.columns.find((c) => c.name === name);
const columnNames = config.columns.map((c) => c.name);
const indexes = Object.fromEntries(
  config.indexes.map((i) => [
    i.config.name,
    i.config.columns.map((c) => ('name' in c ? c.name : String(c))),
  ]),
) as Record<string, string[]>;
const foreignKeys = config.foreignKeys.map((fk) => {
  const reference = fk.reference();
  return {
    columns: reference.columns.map((c) => c.name),
    table: getTableConfig(reference.foreignTable).name,
    foreignColumns: reference.foreignColumns.map((c) => c.name),
    onDelete: fk.onDelete,
    onUpdate: fk.onUpdate,
  };
});

/** A complete, valid snapshot — the baseline the rejection tests mutate. */
function validSnapshot(): PriceSnapshot {
  return {
    tier: { tierId: 1, minPax: 7, maxPax: 12, pricePerPersonCentavos: 189000 },
    addons: [{ addonId: 1, name: 'Island lunch', priceCentavos: 35000, perPerson: true, qty: 1 }],
    coupon: {
      id: 1,
      code: 'SUGBO10',
      discount: { discountType: 'percent', percentBp: 1000, amountCentavos: null },
    },
    depositPercent: 30,
    freeCancelHours: 48,
    subtotalCentavos: 1568000,
    discountCentavos: 156800,
    totalCentavos: 1411200,
  };
}

describe('booking statuses (@rg/shared)', () => {
  it('matches BUILD_SPEC section 5 exactly, in order', () => {
    expect([...BOOKING_STATUSES]).toEqual([
      'pending_payment',
      'pending_verification',
      'confirmed',
      'assigned',
      'in_progress',
      'completed',
      'cancelled',
      'expired',
    ]);
  });

  /**
   * The load-bearing assertion of this whole task.
   *
   * These are exactly the five statuses §5's table marks "Holds capacity:
   * Yes". Add one and the capacity check refuses valid bookings — annoying,
   * visible, reported within the hour. Remove one and it OVERSELLS THE
   * FLEET: a trip is sold that cannot be run, discovered by a family on a
   * kerb in Cebu at 6am. So the set is pinned in both directions — the five
   * that hold, and the three that must not.
   */
  it('holds capacity for exactly the five statuses the spec marks "Yes"', () => {
    expect([...CAPACITY_HOLDING_STATUSES]).toEqual([
      'pending_payment',
      'pending_verification',
      'confirmed',
      'assigned',
      'in_progress',
    ]);
    for (const done of ['completed', 'cancelled', 'expired'] as const) {
      expect(
        CAPACITY_HOLDING_STATUSES,
        `${done} does not hold capacity — §5's table says "No"`,
      ).not.toContain(done);
    }
  });

  /**
   * A typo here would be a string that matches no booking row, i.e. a whole
   * status silently dropped from the capacity count. `satisfies` in the
   * shared module makes that a typecheck failure; this makes it a test
   * failure too, because a typecheck is not run by `pnpm test`.
   */
  it('counts only real booking statuses as capacity-holding', () => {
    for (const status of CAPACITY_HOLDING_STATUSES) {
      expect(BOOKING_STATUSES, `${status} is not a booking status`).toContain(status);
    }
    expect(CAPACITY_HOLDING_STATUSES.length).toBeLessThan(BOOKING_STATUSES.length);
  });

  it('offers the two payment modes section 6 defines, and no third', () => {
    expect([...PAY_MODES]).toEqual(['full', 'deposit']);
  });
});

describe('public booking refs (@rg/shared)', () => {
  it('accepts the form the spec shows and rejects the characters a guest could misread', () => {
    expect(bookingRefSchema.safeParse('RG-7KQ4M9').success).toBe(true);
    // 0/O, 1/I/L and U are excluded so a ref survives a bad phone line.
    for (const ambiguous of ['RG-0KQ4M9', 'RG-OKQ4M9', 'RG-1KQ4M9', 'RG-IKQ4M9', 'RG-UKQ4M9']) {
      expect(bookingRefSchema.safeParse(ambiguous).success, ambiguous).toBe(false);
    }
  });

  /**
   * BUG-108 (owner decision 2026-10-23, Q10): a lowercase or mixed-case ref
   * is no longer in this "rejects" list — `bookingRefSchema` now normalises
   * (trim, then uppercase) BEFORE the shape check, so `rg-7kq4m9` is
   * accepted and resolves to `RG-7KQ4M9`. That normalisation is asserted in
   * `server/src/__tests__/booking-ref.test.ts`, next to the schema's other
   * tests. What is still rejected — because normalising a ref cannot
   * change its length or its characters — is the wrong prefix and the
   * wrong length.
   */
  it('rejects the wrong prefix and the wrong length', () => {
    for (const bad of ['RG7KQ4M9', 'RG-7KQ4M', 'RG-7KQ4M99', '7KQ4M9', '']) {
      expect(bookingRefSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });
});

describe('price snapshot shape (@rg/shared)', () => {
  /**
   * The snapshot freezes REFUND RIGHTS, not just prices (owner decision
   * 2026-10-11, Q5). `freeCancelHours` and `depositPercent` are the two
   * fields that make that true, and they are the two a writer focused on
   * "the totals" would most naturally leave out. Pinned by name so that
   * cannot happen quietly.
   */
  it('freezes the tour cancellation window (free_cancel_hours) and the deposit percent', () => {
    const keys = Object.keys(priceSnapshotSchema.shape);
    expect(
      keys,
      'free_cancel_hours must be frozen, or a tour edit rewrites refund rights',
    ).toContain('freeCancelHours');
    expect(keys).toContain('depositPercent');
  });

  it('refuses a snapshot with no free-cancellation window', () => {
    const withoutWindow: Record<string, unknown> = { ...validSnapshot() };
    delete withoutWindow.freeCancelHours;
    expect(priceSnapshotSchema.safeParse(validSnapshot()).success).toBe(true);
    expect(priceSnapshotSchema.safeParse(withoutWindow).success).toBe(false);
  });

  it('refuses a snapshot with no deposit percent', () => {
    const withoutDeposit: Record<string, unknown> = { ...validSnapshot() };
    delete withoutDeposit.depositPercent;
    expect(priceSnapshotSchema.safeParse(withoutDeposit).success).toBe(false);
  });

  it('freezes the tier price, every add-on with its per-person flag, and the coupon', () => {
    const keys = Object.keys(priceSnapshotSchema.shape);
    expect(keys).toEqual(
      expect.arrayContaining([
        'tier',
        'addons',
        'coupon',
        'subtotalCentavos',
        'discountCentavos',
        'totalCentavos',
      ]),
    );
    const noAddonFlag = validSnapshot();
    // @ts-expect-error — deleting a required field is the point of the test.
    delete noAddonFlag.addons[0].perPerson;
    expect(priceSnapshotSchema.safeParse(noAddonFlag).success).toBe(false);
    // No coupon is a valid snapshot; a missing coupon KEY is not.
    expect(priceSnapshotSchema.safeParse({ ...validSnapshot(), coupon: null }).success).toBe(true);
  });

  it('keeps money integral — a float price is refused outright', () => {
    const fractional = validSnapshot();
    fractional.tier.pricePerPersonCentavos = 1890.5;
    expect(priceSnapshotSchema.safeParse(fractional).success).toBe(false);
  });
});

describe('bookings table', () => {
  /**
   * Money is integer centavos everywhere (CLAUDE.md), and the four summary
   * columns are the whole of it: subtotal, discount, total, amount paid.
   * Task 18 adds a source-wide guard; this asserts it for this table.
   */
  it('stores every money column as int centavos, and names it so', () => {
    const money = config.columns.filter((c) => /_centavos$/.test(c.name));
    expect(money.map((c) => c.name)).toEqual([
      'subtotal_centavos',
      'discount_centavos',
      'total_centavos',
      'amount_paid_centavos',
    ]);
    for (const c of money) expect(c.getSQLType(), c.name).toBe('int');
  });

  /**
   * Task 16b-6, against the declaration — so removing a CHECK from
   * `schema.ts` goes red before a migration is ever generated. The DB-backed
   * twins below prove MySQL is actually enforcing them.
   *
   * One CHECK per column rather than one compound expression, so the
   * constraint that fires names the column that was violated.
   */
  it('declares a non-negative CHECK on every money column', () => {
    const declared = config.checks.map((c) => c.name);
    for (const [col, name] of MONEY_CHECKS) {
      expect(declared, `${col} is unconstrained — a negative amount is insertable`).toContain(name);
    }
  });

  /**
   * The other half of the convention: no money column may hide behind a name
   * without the suffix. `price_snapshot` is the one documented exception —
   * it is a JSON blob, not an amount.
   */
  it('leaves no money-ish column without the _centavos suffix', () => {
    const moneyish = columnNames.filter(
      (n) => /amount|price|total|discount|fee|balance|paid/.test(n) && n !== 'price_snapshot',
    );
    expect(moneyish.filter((n) => !/_centavos$/.test(n))).toEqual([]);
  });

  /**
   * §5 defines balance as `total - amount_paid`. Storing it creates two
   * places that must agree about what a guest owes, and the day they
   * disagree someone is charged twice or waved through for free.
   */
  /**
   * Task 16b-3. The flag `recordPayment()` raises when money lands on a
   * booking that was already cancelled, expired, or holding a lapsed hold.
   *
   * NOT NULL with a `false` default, so every existing row and every new one
   * starts unflagged — a nullable flag would make "not reviewed" and "no
   * review needed" the same value. A boolean rather than a ninth
   * `BOOKING_STATUSES` member: this is orthogonal to the §5 lifecycle, and a
   * new status would have to be threaded through every capacity query,
   * portal view and driver filter that switches on it.
   */
  it('flags a booking whose payment needs an admin review, defaulting to false', () => {
    expect(columnNames, 'late money has nowhere to be recorded as needing review').toContain(
      'payment_review_required',
    );
    expect(column('payment_review_required')?.getSQLType()).toBe('boolean');
    expect(column('payment_review_required')?.notNull).toBe(true);
    expect(column('payment_review_required')?.default, 'a booking must start unflagged').toBe(
      false,
    );
    // It is not a status. The §5 lifecycle is unchanged by 16b-3.
    expect(column('status')?.enumValues).toEqual([...BOOKING_STATUSES]);
  });

  it('has NO balance column — balance is total minus amount paid, computed at read time', () => {
    expect(columnNames).not.toContain('balance');
    expect(columnNames).not.toContain('balance_centavos');
    expect(columnNames.filter((n) => /balance|due|owed|outstanding|remaining/.test(n))).toEqual([]);
  });

  it('uses no decimal, float or double anywhere near a price', () => {
    const offenders = config.columns
      .filter((c) => /decimal|float|double|numeric|real/i.test(c.getSQLType()))
      .map((c) => `${c.name}: ${c.getSQLType()}`);
    expect(offenders).toEqual([]);
  });

  /**
   * `ref` is the only identifier a guest ever sees, and §7 logs them into the
   * portal with ref + email — so two bookings sharing one would hand a guest
   * someone else's trip. Task 9 generates it; this task creates the column.
   */
  it('makes the public ref unique, required, and wide enough for RG- plus six', () => {
    expect(column('ref')?.getSQLType()).toBe('varchar(12)');
    expect(column('ref')?.notNull).toBe(true);
    expect(column('ref')?.isUnique, 'two guests could be handed the same ref').toBe(true);
  });

  it('starts every booking at pending_payment, with the spec section 5 status set', () => {
    expect(column('status')?.enumValues).toEqual([...BOOKING_STATUSES]);
    expect(column('status')?.notNull).toBe(true);
    expect(column('status')?.default).toBe('pending_payment');
  });

  it('requires a pay mode and a price snapshot on every row', () => {
    expect(column('pay_mode')?.enumValues).toEqual([...PAY_MODES]);
    expect(column('pay_mode')?.notNull).toBe(true);
    // Nullable here would mean a booking whose refund rights nothing records.
    expect(column('price_snapshot')?.getSQLType()).toBe('json');
    expect(column('price_snapshot')?.notNull).toBe(true);
  });

  /**
   * The tour DAY is a civil date in Asia/Manila, not an instant: a trip on
   * the 25th is on the 25th in Cebu whatever the server clock says, and a
   * datetime turns "which day is this" into a timezone question.
   */
  it('stores the tour day as a civil date, never an instant', () => {
    expect(column('tour_date')?.getSQLType()).toBe('date');
    expect(column('tour_date')?.notNull).toBe(true);
  });

  /**
   * MySQL's `timestamp` converts on read and write using the session's
   * `time_zone`, so the same row reads differently from two connections.
   * Everything here is `datetime`, written in UTC from JS.
   */
  it('times every instant with datetime, never MySQL timestamp', () => {
    const timeish = config.columns.filter((c) => /_at$|_date$|expiry|expires/.test(c.name));
    expect(timeish.length).toBeGreaterThan(5);
    for (const c of timeish) {
      expect(['datetime', 'date'], `${c.name} is ${c.getSQLType()}`).toContain(c.getSQLType());
    }
    expect(column('created_at')?.notNull).toBe(true);
    expect(column('updated_at')?.notNull).toBe(true);
  });

  it('names the three indexes BUILD_SPEC section 10 requires, plus the hold sweep', () => {
    // The capacity check: tour + date, then count the holding statuses.
    expect(indexes['bookings_tour_date_status_idx']).toEqual(['tour_id', 'tour_date', 'status']);
    expect(indexes['bookings_ref_idx']).toEqual(['ref']);
    // The driver portal's "my trips today".
    expect(indexes['bookings_driver_date_idx']).toEqual(['driver_id', 'tour_date']);
    // Added by the plan: the per-minute cron that expires 15-minute holds.
    expect(indexes['bookings_hold_expiry_idx']).toEqual(['status', 'hold_expires_at']);
  });

  /**
   * Nothing in this schema cascades (plan: `ON DELETE RESTRICT` everywhere).
   * Bookings are never hard-deleted, and a cascade from `tours` or `coupons`
   * is precisely the mechanism that would quietly delete one — along with
   * the money trail attached to it.
   */
  it('references tours, coupons, vans and drivers, and cascades nothing', () => {
    expect(foreignKeys.map((fk) => `${fk.columns.join(',')}->${fk.table}`).sort()).toEqual([
      'coupon_id->coupons',
      'driver_id->drivers',
      'tour_id->tours',
      'van_id->vans',
    ]);
    for (const fk of foreignKeys) {
      expect(fk.foreignColumns, `${fk.columns} must point at a primary key`).toEqual(['id']);
      expect(fk.onDelete, `${fk.columns} must not cascade`).toBeUndefined();
      expect(fk.onUpdate, `${fk.columns} must not cascade`).toBeUndefined();
    }
    const referenced = config.foreignKeys.map((fk) => fk.reference().foreignTable);
    for (const table of [tours, coupons, vans, drivers]) expect(referenced).toContain(table);
  });

  /**
   * §5: "Bookings confirm automatically; van + driver are assigned later by
   * dispatch." So a confirmed booking with no van and no driver is a normal
   * state, and both columns are nullable — while the tour it is for never
   * is.
   */
  it('keeps the dispatch assignment nullable and the tour mandatory', () => {
    expect(column('tour_id')?.notNull).toBe(true);
    expect(column('van_id')?.notNull).toBe(false);
    expect(column('driver_id')?.notNull).toBe(false);
    expect(column('coupon_id')?.notNull).toBe(false);
    // The 15-minute hold is cleared, not zeroed, once there is nothing to expire.
    expect(column('hold_expires_at')?.notNull).toBe(false);
  });
});

/**
 * True once Wave 2 (Task 11) has created the table in `rg_travel_test`. Also
 * false when MySQL is unreachable, which is how the rest of the suite
 * behaves (see `helpers/db.ts`).
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

const bookingsExists = await tableExists('bookings');
const dbIt = bookingsExists ? it : it.skip;

/** Thrown to roll the fixture transaction back; never escapes `inRollback`. */
const ROLLBACK = new Error('__rollback__');

/**
 * Runs `fn` in a transaction that is always rolled back — the pattern
 * `schema-payments.test.ts` uses, and for the same reason: nothing is
 * committed, so there is no `DELETE FROM bookings` anywhere in this file. A
 * booking is never hard-deleted (Global Constraints), and a cleanup step
 * that deletes them is how that rule gets normalised.
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

/**
 * Runs `run` and reports the MySQL error code it was refused with, or `null`
 * when the database accepted it.
 *
 * The code, not the message: Drizzle wraps a mysql2 error in a
 * `DrizzleQueryError` whose message is the SQL text, so matching on the
 * message would pass or fail for reasons unrelated to the constraint.
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

/** A tour and its destination, so the booking FK has something to point at. */
async function makeTour(tx: Transaction): Promise<number> {
  const unique = `__bk16b6__${Date.now()}_${Math.floor(Math.random() * 1e9)}`;
  const [destination] = await tx.insert(destinations).values({ name: unique, slug: unique });
  const [tour] = await tx
    .insert(tours)
    .values({ slug: unique, title: unique, destinationId: destination.insertId });
  return tour.insertId;
}

/**
 * A public ref for a raw insert. `ref` is UNIQUE, and every fixture here
 * lives inside a rolled-back transaction, so a fresh random tail from the
 * spec's unambiguous alphabet is enough — nothing it could collide with is
 * ever committed.
 */
function nextRef(): string {
  const alphabet = 'ABCDEFGHJKMNPQRSTVWXYZ23456789';
  let tail = '';
  for (let i = 0; i < 6; i += 1) {
    tail += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return `RG-${tail}`;
}

/**
 * **A raw INSERT, bypassing Zod and Drizzle's own typing entirely** — which
 * is the whole point of task 16b-6's tests. `priceSnapshotSchema` and the
 * server's pricing code already make a negative impossible through the
 * application, and none of that reaches a seed script, a migration or a
 * hand-written UPDATE in a SQL client. These statements go straight at
 * MySQL, so what they prove is that the DATABASE refuses the row.
 */
function insertBookingMoney(
  tx: Transaction,
  tourId: number,
  money: { subtotal: number; discount: number; total: number; paid: number },
): Promise<unknown> {
  const snapshot = JSON.stringify(validSnapshot());
  return tx.execute(
    sql`INSERT INTO bookings
          (ref, tour_id, tour_date, pax, lead_name, lead_email, lead_phone,
           status, pay_mode, price_snapshot,
           subtotal_centavos, discount_centavos, total_centavos, amount_paid_centavos,
           created_at, updated_at)
        VALUES
          (${nextRef()}, ${tourId}, '2099-12-25', 2, 'Raw SQL Guest',
           'raw@example.test', '09170000000',
           'pending_payment', 'full', ${snapshot},
           ${money.subtotal}, ${money.discount}, ${money.total}, ${money.paid},
           UTC_TIMESTAMP(), UTC_TIMESTAMP())`,
  );
}

/** The baseline the rejection cases below perturb one column at a time. */
const VALID_MONEY = { subtotal: 1568000, discount: 156800, total: 1411200, paid: 0 };

describe('bookings, as actually migrated', () => {
  dbIt('stores every money column as int centavos in the real table', async () => {
    const [rows] = (await getPool().query(
      `SELECT COLUMN_NAME, DATA_TYPE FROM information_schema.columns
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'bookings'
          AND COLUMN_NAME LIKE '%centavos'
        ORDER BY ORDINAL_POSITION`,
    )) as [Array<{ COLUMN_NAME: string; DATA_TYPE: string }>, unknown];
    expect(rows.map((r) => String(r.COLUMN_NAME))).toEqual([
      'subtotal_centavos',
      'discount_centavos',
      'total_centavos',
      'amount_paid_centavos',
    ]);
    for (const r of rows) expect(r.DATA_TYPE, String(r.COLUMN_NAME)).toBe('int');
  });

  dbIt('has no decimal, float or double column, and no stored balance', async () => {
    const [rows] = (await getPool().query(
      `SELECT COLUMN_NAME, DATA_TYPE FROM information_schema.columns
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'bookings'`,
    )) as [Array<{ COLUMN_NAME: string; DATA_TYPE: string }>, unknown];
    const names = rows.map((r) => String(r.COLUMN_NAME));
    expect(names.filter((n) => /balance|owed|outstanding/.test(n))).toEqual([]);
    expect(
      rows
        .filter((r) => /decimal|float|double|numeric/i.test(String(r.DATA_TYPE)))
        .map((r) => String(r.COLUMN_NAME)),
    ).toEqual([]);
  });

  dbIt('enforces the unique public ref at the database level', async () => {
    const [rows] = (await getPool().query(
      `SELECT NON_UNIQUE FROM information_schema.statistics
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'bookings'
          AND COLUMN_NAME = 'ref'`,
    )) as [Array<{ NON_UNIQUE: number | string }>, unknown];
    expect(rows.length, 'ref carries no index at all').toBeGreaterThan(0);
    expect(
      rows.some((r) => Number(r.NON_UNIQUE) === 0),
      'no UNIQUE index on ref — two guests could share a booking reference',
    ).toBe(true);
  });

  dbIt('carries the four named indexes', async () => {
    const [rows] = (await getPool().query(
      `SELECT DISTINCT INDEX_NAME FROM information_schema.statistics
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'bookings'`,
    )) as [Array<{ INDEX_NAME: string }>, unknown];
    const names = rows.map((r) => String(r.INDEX_NAME));
    for (const wanted of [
      'bookings_tour_date_status_idx',
      'bookings_ref_idx',
      'bookings_driver_date_idx',
      'bookings_hold_expiry_idx',
    ]) {
      expect(names, `${wanted} is missing`).toContain(wanted);
    }
  });

  /**
   * Task 16b-6. The CHECKs must be LIVE, not merely written: MySQL 8.0.15
   * and earlier parse a CHECK and silently ignore it, so a constraint absent
   * from `information_schema.check_constraints` is decoration. This server is
   * 8.0.46, which enforces them — proven here rather than assumed.
   *
   * The clause is asserted exactly, `>= 0` included: a CHECK that drifted to
   * `> 0` would still appear in the catalogue and would still refuse every
   * negative, while quietly making a 100%-coupon booking (`total_centavos`
   * = 0) and every unpaid booking (`amount_paid_centavos` = 0) impossible to
   * insert. The accept-zero test below is the other half of that.
   */
  dbIt('declares all four money CHECKs as real, enforced `>= 0` constraints', async () => {
    const [rows] = (await getPool().query(
      'SELECT CONSTRAINT_NAME, CHECK_CLAUSE FROM information_schema.check_constraints ' +
        'WHERE CONSTRAINT_SCHEMA = DATABASE() AND CONSTRAINT_NAME IN (?, ?, ?, ?)',
      MONEY_CHECKS.map(([, name]) => name),
    )) as [Array<{ CONSTRAINT_NAME: string; CHECK_CLAUSE: string }>, unknown];
    const clauses = Object.fromEntries(
      rows.map((r) => [String(r.CONSTRAINT_NAME), String(r.CHECK_CLAUSE).replace(/[`\s]/g, '')]),
    );
    for (const [col, name] of MONEY_CHECKS) {
      expect(clauses[name], `${name} was dropped or never migrated`).toBe(`(${col}>=0)`);
    }
  });

  /**
   * **The four rejections, by the DATABASE, through raw SQL that bypasses
   * Zod entirely** (task 16b-6).
   *
   * One column at a time, off an otherwise valid row, so the constraint that
   * fires is unambiguous — a row with all four negative would be refused by
   * whichever CHECK MySQL evaluated first and would stay green with three of
   * them dropped.
   */
  for (const [col, name] of MONEY_CHECKS) {
    const key = col.replace(/_centavos$/, '').replace('amount_paid', 'paid') as
      'subtotal' | 'discount' | 'total' | 'paid';
    dbIt(`REFUSES a negative ${col}`, async () => {
      await inRollback(async (tx) => {
        const tourId = await makeTour(tx);
        expect(
          await rejectionCode(() => insertBookingMoney(tx, tourId, { ...VALID_MONEY, [key]: -1 })),
          `a negative ${col} was accepted — ${name} is gone`,
        ).toBe('ER_CHECK_CONSTRAINT_VIOLATED');

        const [rows] = (await tx.execute(
          sql`SELECT COUNT(*) AS n FROM bookings WHERE tour_id = ${tourId}`,
        )) as unknown as [Array<{ n: number }>, unknown];
        expect(Number(rows[0]?.n), `a booking with a negative ${col} was written`).toBe(0);
      });
    });
  }

  /**
   * The other side of the same four CHECKs, and the reason they are `>= 0`
   * and not `> 0`: **zero is legitimate in every one of them.** A 100%
   * coupon discounts the whole subtotal and leaves `total_centavos = 0` — a
   * free trip an admin deliberately gave away — and every booking starts
   * with `amount_paid_centavos = 0`. A strict CHECK would refuse this row,
   * so this test is what stops one being tightened by mistake.
   */
  dbIt('accepts zero in all four columns — a 100% coupon is a real booking', async () => {
    await inRollback(async (tx) => {
      const tourId = await makeTour(tx);
      expect(
        await rejectionCode(() =>
          insertBookingMoney(tx, tourId, {
            subtotal: 0,
            discount: 0,
            total: 0,
            paid: 0,
          }),
        ),
        'the CHECKs are too strict — they refused a legitimate zero-value booking',
      ).toBeNull();

      const [rows] = (await tx.execute(
        sql`SELECT COUNT(*) AS n FROM bookings WHERE tour_id = ${tourId}`,
      )) as unknown as [Array<{ n: number }>, unknown];
      expect(Number(rows[0]?.n), 'the zero-value booking was not written').toBe(1);
    });
  });
});
