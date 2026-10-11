/**
 * Task 12 of the core-schema plan: `payments`, the last of the 17 tables and
 * the first task of Phase 3.
 *
 * **The first test in this file is the structural guard for the whole
 * phase.** The design rule is that nothing outside
 * `server/src/services/payments/` may name a gateway, and a column called
 * `paymongo_id` would break that rule permanently — a column cannot be
 * confined to a directory. So the guard reads the REAL column list out of
 * `information_schema` and refuses any name matching
 * /paymongo|xendit|stripe/. Adding Xendit later must need a new file in that
 * directory and one line in the registry, never a migration.
 *
 * Two layers, the same split `schema-locks.test.ts` and
 * `schema-trips.test.ts` use:
 *
 *  1. **Declaration assertions** read the Drizzle table object through
 *     `getTableConfig()` — the object drizzle-kit emits DDL from. They go
 *     red the moment `schema.ts` changes, before any migration exists.
 *
 *  2. **DB-backed assertions** read `information_schema` and issue real
 *     statements, which is the only way to prove the enum values, the
 *     indexes and the foreign key actually survived into MySQL. They are
 *     gated on the table existing — the same runtime probe the sibling
 *     suites use — so a lost migration reports as SKIPPED rather than
 *     silently passing.
 */
import { describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { getTableConfig } from 'drizzle-orm/mysql-core';
import { getDb, getPool } from '../db/client';
import type { Transaction } from '../db/client';
import {
  PAYMENT_METHODS,
  PAYMENT_PROVIDERS,
  PAYMENT_STATUSES,
  PAYMENT_TYPES,
  bookings,
  destinations,
  payments,
  tours,
} from '../db/schema';

/** Any column name that would hard-code a gateway into the schema. */
const GATEWAY_NAME = /paymongo|xendit|stripe/;

const config = getTableConfig(payments);
const column = (name: string) => config.columns.find((c) => c.name === name);
const columnNames = config.columns.map((c) => c.name);
/** Index name -> its columns, in the declared order. Order is load-bearing. */
const indexes = Object.fromEntries(
  config.indexes.map((i) => [
    i.config.name,
    i.config.columns.map((c) => ('name' in c ? c.name : String(c))),
  ]),
) as Record<string, string[]>;

describe('payments table (declaration)', () => {
  /**
   * The B1a guarantee, asserted against the declaration so it fails before a
   * migration is ever generated. The DB-backed twin below asserts the same
   * thing against MySQL.
   */
  it('names no gateway in any column', () => {
    expect(columnNames.join(' ')).not.toMatch(GATEWAY_NAME);
    expect(columnNames).toContain('provider');
    expect(columnNames).toContain('provider_ref');
    expect(columnNames).toContain('provider_status');
  });

  /**
   * Task 16b-1, against the declaration — so removing the CHECK from
   * `schema.ts` goes red before a migration is ever generated. The
   * DB-backed twin below proves MySQL is actually enforcing it.
   */
  it('declares the always-positive amount CHECK', () => {
    expect(
      config.checks.map((c) => c.name),
      'the amount range is unconstrained — a negative or zero payment is insertable',
    ).toContain('payments_amount_positive');
  });

  /**
   * `provider` and `method` answer two different questions — WHO processed
   * it and HOW the guest paid. One column cannot carry both: GCash through
   * PayMongo and GCash through Xendit are the same instrument and different
   * processors, and §9 reports need both axes.
   */
  it('separates who processed it from how the guest paid', () => {
    expect(column('provider')?.enumValues).toEqual([...PAYMENT_PROVIDERS]);
    expect(column('provider')?.notNull).toBe(true);
    expect(column('method')?.enumValues).toEqual([...PAYMENT_METHODS]);
    expect(column('method')?.notNull).toBe(true);
  });

  /**
   * `grab_pay` with an underscore, and NO `manual_qr`: a hand-verified QR
   * transfer is `provider='manual'` plus the real instrument, because
   * `provider` already carries the fact a human verified it. Keeping
   * `manual_qr` too would give two ways to record one payment — the drift
   * the split exists to prevent.
   */
  it('lists the instruments, with grab_pay and without manual_qr', () => {
    expect([...PAYMENT_METHODS]).toEqual([
      'card',
      'gcash',
      'maya',
      'grab_pay',
      'qrph',
      'bank_transfer',
      'cash',
    ]);
    expect([...PAYMENT_METHODS]).not.toContain('manual_qr');
  });

  /**
   * ALWAYS POSITIVE, in centavos, for refunds too. Direction comes from
   * `type`; a negative amount plus a `refund` type is two ways of saying one
   * thing and they drift — and a SUM() that mixes them is a silent reporting
   * bug.
   */
  it('stores the amount as int centavos, with direction carried by type', () => {
    expect(column('amount_centavos')?.getSQLType()).toBe('int');
    expect(column('amount_centavos')?.notNull).toBe(true);
    expect([...PAYMENT_TYPES]).toEqual(['payment', 'refund']);
    expect(column('type')?.enumValues).toEqual([...PAYMENT_TYPES]);
    expect(column('type')?.notNull).toBe(true);
  });

  /**
   * `status` is OUR vocabulary and nothing else; `provider_status` keeps the
   * gateway's raw wording verbatim, for support and reconciliation. Mapping
   * a gateway string into `status` is the payment service's job, not the
   * database's.
   */
  it('keeps our status vocabulary separate from the gateway wording', () => {
    expect([...PAYMENT_STATUSES]).toEqual(['pending', 'paid', 'rejected', 'failed', 'refunded']);
    expect(column('status')?.enumValues).toEqual([...PAYMENT_STATUSES]);
    expect(column('status')?.notNull).toBe(true);
    expect(column('status')?.default).toBe('pending');
    // The gateway's own strings live in plain varchars, never in an enum we
    // would have to migrate every time a gateway renames a state.
    expect(column('provider_status')?.getSQLType()).toBe('varchar(80)');
    expect(column('provider_ref')?.getSQLType()).toBe('varchar(191)');
  });

  /**
   * `receipt_path` is a PATH under /uploads — outside the web root, served
   * through an authenticated route (CLAUDE.md Security). Never a public URL,
   * so there is deliberately no `*_url` column on this table to put one in.
   */
  it('stores the receipt as a path, never a public URL', () => {
    expect(column('receipt_path')?.getSQLType()).toBe('varchar(300)');
    expect(columnNames.filter((n) => n.endsWith('_url'))).toEqual([]);
  });

  it('points booking_id at bookings, and nothing cascades', () => {
    const fks = config.foreignKeys.map((fk) => ({
      from: fk.reference().columns.map((c) => c.name),
      to: fk.reference().foreignColumns.map((c) => c.name),
      table: getTableConfig(fk.reference().foreignTable).name,
      onDelete: fk.onDelete,
    }));
    expect(fks).toEqual(
      expect.arrayContaining([
        { from: ['booking_id'], to: ['id'], table: 'bookings', onDelete: undefined },
        { from: ['verified_by'], to: ['id'], table: 'users', onDelete: undefined },
        { from: ['collected_by_driver_id'], to: ['id'], table: 'drivers', onDelete: undefined },
      ]),
    );
    expect(fks).toHaveLength(3);
    expect(column('booking_id')?.notNull).toBe(true);
    // Verification and cash collection are optional paths, not every payment.
    expect(column('verified_by')?.notNull).toBe(false);
    expect(column('collected_by_driver_id')?.notNull).toBe(false);
  });

  /**
   * The two indexes §10 names, plus the one the plan adds: reconciling an
   * incoming webhook against an existing row. It covers BOTH columns —
   * `provider_ref` alone would make two gateways' identical reference
   * strings collide in the lookup.
   */
  it('carries the two spec indexes plus the webhook reconciliation index', () => {
    expect(indexes['payments_booking_idx']).toEqual(['booking_id']);
    expect(indexes['payments_status_idx']).toEqual(['status']);
    expect(indexes['payments_provider_ref_idx']).toEqual(['provider', 'provider_ref']);
  });

  it('times everything with datetime, never MySQL timestamp (which shifts per session)', () => {
    for (const name of ['created_at', 'updated_at', 'verified_at']) {
      expect(column(name)?.getSQLType(), name).toBe('datetime');
    }
    expect(column('created_at')?.notNull).toBe(true);
    expect(column('updated_at')?.notNull).toBe(true);
    // Null until an admin actually approves it.
    expect(column('verified_at')?.notNull).toBe(false);
  });
});

/**
 * True once Task 12's migration has created the table in `rg_travel_test`.
 * Also false when MySQL is unreachable, which is how the rest of the suite
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

const paymentsExists = await tableExists('payments');
const dbIt = paymentsExists ? it : it.skip;

async function columnsOf(table: string): Promise<Array<{ name: string; type: string }>> {
  const [rows] = (await getPool().query(
    'SELECT COLUMN_NAME, COLUMN_TYPE, DATA_TYPE FROM information_schema.columns ' +
      'WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION',
    [table],
  )) as [Array<{ COLUMN_NAME: string; COLUMN_TYPE: string; DATA_TYPE: string }>, unknown];
  return rows.map((r) => ({ name: r.COLUMN_NAME, type: r.COLUMN_TYPE }));
}

async function dataType(table: string, col: string): Promise<string | undefined> {
  const [rows] = (await getPool().query(
    'SELECT DATA_TYPE FROM information_schema.columns ' +
      'WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?',
    [table, col],
  )) as [Array<{ DATA_TYPE: string }>, unknown];
  return rows[0]?.DATA_TYPE;
}

/** Thrown to roll the fixture transaction back; never escapes `inRollback`. */
const ROLLBACK = new Error('__rollback__');

/**
 * Runs `fn` in a transaction that is always rolled back — the same pattern
 * `schema-booking-lines.test.ts` uses, and for a stronger reason here:
 * nothing is committed, so there is no `DELETE FROM payments` anywhere in
 * this suite. A payment is never hard-deleted (Global Constraints), and a
 * cleanup step that deletes them is how that rule gets normalised.
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
 * `DrizzleQueryError` whose message is the SQL text, so matching
 * /foreign key/i on a statement issued through a transaction handle would
 * pass or fail for reasons unrelated to the constraint under test.
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

/**
 * A booking, and the tour and destination its foreign keys need. Built here
 * rather than read out of the seed: a test that looks for "any booking" and
 * returns early when it finds none is a test that cannot fail, which is a
 * bug in its own right (CLAUDE.md).
 */
async function makeBooking(tx: Transaction): Promise<number> {
  const unique = `__pay__${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  const [destination] = await tx.insert(destinations).values({ name: unique, slug: unique });
  const [tour] = await tx
    .insert(tours)
    .values({ slug: unique, title: unique, destinationId: destination.insertId });
  const [booking] = await tx.insert(bookings).values({
    ref: `RG-${unique
      .slice(-6)
      .toUpperCase()
      .replace(/[^ABCDEFGHJKMNPQRSTVWXYZ23456789]/g, 'A')}`,
    tourId: tour.insertId,
    tourDate: new Date('2026-12-25T00:00:00Z'),
    pax: 4,
    leadName: 'Test Guest',
    leadEmail: 'guest@example.test',
    leadPhone: '09170000000',
    payMode: 'full',
    priceSnapshot: {
      tier: { tierId: 1, minPax: 1, maxPax: 6, pricePerPersonCentavos: 189000 },
      addons: [],
      coupon: null,
      depositPercent: 30,
      freeCancelHours: 48,
      subtotalCentavos: 756000,
      discountCentavos: 0,
      totalCentavos: 756000,
    },
    subtotalCentavos: 756000,
    totalCentavos: 756000,
  });
  return booking.insertId;
}

describe('payments, against the real database', () => {
  /**
   * THE structural guard for Phase 3. Proven able to fail by adding a
   * `paymongo_id` column to the table — see the task report.
   */
  dbIt('names no gateway in any column', async () => {
    const names = (await columnsOf('payments')).map((c) => c.name.toLowerCase());
    // The whole point of B1a: adding Xendit must need no schema change.
    expect(names.join(' ')).not.toMatch(GATEWAY_NAME);
    expect(names).toContain('provider');
    expect(names).toContain('provider_ref');
    expect(names).toContain('provider_status');
  });

  dbIt('stores the amount as int centavos', async () => {
    expect(await dataType('payments', 'amount_centavos')).toBe('int');
  });

  dbIt('keeps a refund as its own row, not a booking status', async () => {
    const cols = await columnsOf('payments');
    expect(cols.find((c) => c.name === 'type')?.type).toContain('refund');
  });

  dbIt(
    'carries the instrument enum MySQL side, grab_pay included and manual_qr absent',
    async () => {
      const method = (await columnsOf('payments')).find((c) => c.name === 'method')?.type ?? '';
      for (const value of PAYMENT_METHODS) expect(method).toContain(`'${value}'`);
      expect(method).not.toContain('manual_qr');
    },
  );

  dbIt('has both §10 indexes plus the (provider, provider_ref) reconciliation index', async () => {
    const [rows] = (await getPool().query(
      'SELECT INDEX_NAME, COLUMN_NAME FROM information_schema.statistics ' +
        "WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'payments' " +
        'ORDER BY INDEX_NAME, SEQ_IN_INDEX',
    )) as [Array<{ INDEX_NAME: string; COLUMN_NAME: string }>, unknown];
    const byName: Record<string, string[]> = {};
    for (const r of rows) (byName[r.INDEX_NAME] ??= []).push(r.COLUMN_NAME);
    expect(byName['payments_booking_idx']).toEqual(['booking_id']);
    expect(byName['payments_status_idx']).toEqual(['status']);
    expect(byName['payments_provider_ref_idx']).toEqual(['provider', 'provider_ref']);
  });

  /**
   * A payment that names a booking which does not exist is not a payment of
   * anything. The FK is what makes that impossible, rather than a service
   * remembering to check.
   */
  dbIt('refuses a payment for a booking that does not exist', async () => {
    await inRollback(async (tx) => {
      const code = await rejectionCode(() =>
        tx.insert(payments).values({
          bookingId: 987654321,
          type: 'payment',
          provider: 'manual',
          method: 'gcash',
          amountCentavos: 50000,
          status: 'pending',
        }),
      );
      expect(code, 'an orphan payment was accepted').toBe('ER_NO_REFERENCED_ROW_2');
    });
  });

  /**
   * `provider='manual'` plus a real instrument is how a hand-verified QR
   * transfer is recorded — the thing the removal of `manual_qr` depends on
   * actually working. And the refund beside it is a row of its own with a
   * POSITIVE amount: a SUM() over this table has to read `type` to know
   * direction, which is the property the sign convention would destroy.
   */
  dbIt('accepts provider=manual with a real instrument, and a positive refund', async () => {
    await inRollback(async (tx) => {
      const bookingId = await makeBooking(tx);
      const insert = (type: 'payment' | 'refund', amountCentavos: number) =>
        tx.insert(payments).values({
          bookingId,
          type,
          provider: 'manual',
          method: 'gcash',
          amountCentavos,
          status: type === 'payment' ? 'paid' : 'refunded',
          txnRef: `__pay__${type}`,
        });

      expect(await rejectionCode(() => insert('payment', 150000))).toBeNull();
      expect(await rejectionCode(() => insert('refund', 150000))).toBeNull();

      const [rows] = (await tx.execute(
        sql`SELECT type, amount_centavos FROM payments WHERE booking_id = ${bookingId} ORDER BY type`,
      )) as unknown as [Array<{ type: string; amount_centavos: number }>, unknown];
      expect(rows.map((r) => r.type)).toEqual(['payment', 'refund']);
      // Both positive. The refund is NOT -150000.
      for (const r of rows) expect(Number(r.amount_centavos)).toBe(150000);
    });
  });

  /**
   * Task 16b-1. The CHECK must be live, not merely written: MySQL 8.0.15 and
   * earlier PARSE a CHECK and silently ignore it, so a constraint that is
   * absent from `information_schema.check_constraints` is decoration. This
   * server is 8.0.46, which enforces them — proven here rather than assumed.
   */
  dbIt('declares payments_amount_positive as a real, enforced CHECK', async () => {
    const [rows] = (await getPool().query(
      'SELECT CHECK_CLAUSE FROM information_schema.check_constraints ' +
        'WHERE CONSTRAINT_SCHEMA = DATABASE() AND CONSTRAINT_NAME = ?',
      ['payments_amount_positive'],
    )) as [Array<{ CHECK_CLAUSE: string }>, unknown];
    expect(rows, 'the CHECK was dropped or never migrated').toHaveLength(1);
    expect(rows[0]?.CHECK_CLAUSE.replace(/[`\s]/g, '')).toBe('(amount_centavos>0)');
  });

  /**
   * **The two rejections, by the DATABASE, through raw SQL that bypasses Zod
   * entirely** (task 16b-1).
   *
   * `recordPaymentInputSchema` already requires `.positive()`, and that is
   * the layer a webhook goes through — but a seed script, a migration or a
   * hand-written UPDATE in a SQL client at 2am go through none of it. These
   * tests exist to prove the row is refused when every application-level
   * check has been skipped, which is why they are raw `INSERT`s and not
   * Drizzle inserts through a validated service. A version that went through
   * a validating helper would stay green with the CHECK dropped.
   *
   * Zero as well as a negative: direction comes from `type`, never a sign
   * (§6, Q11), so a negative amount is a refund written the wrong way and a
   * zero is money that did not move being recorded as if it had — which
   * would let a ₱0 webhook confirm a booking for nothing.
   */
  for (const amount of [0, -150000]) {
    dbIt(`REFUSES amount_centavos = ${amount}, whatever the type`, async () => {
      await inRollback(async (tx) => {
        const bookingId = await makeBooking(tx);
        for (const type of ['payment', 'refund'] as const) {
          expect(
            await rejectionCode(() =>
              tx.execute(
                sql`INSERT INTO payments (booking_id, type, provider, method, amount_centavos, status, created_at, updated_at)
                    VALUES (${bookingId}, ${type}, 'manual', 'gcash', ${amount}, 'paid', UTC_TIMESTAMP(), UTC_TIMESTAMP())`,
              ),
            ),
            `a ${type} of ${amount} centavos was accepted — payments_amount_positive is gone`,
          ).toBe('ER_CHECK_CONSTRAINT_VIOLATED');
        }

        const [rows] = (await tx.execute(
          sql`SELECT COUNT(*) AS n FROM payments WHERE booking_id = ${bookingId}`,
        )) as unknown as [Array<{ n: number }>, unknown];
        expect(Number(rows[0]?.n), 'a non-positive payment row was written').toBe(0);
      });
    });
  }

  /** The other side of the same CHECK: one centavo is a real amount. */
  dbIt('accepts the smallest positive amount, one centavo', async () => {
    await inRollback(async (tx) => {
      const bookingId = await makeBooking(tx);
      expect(
        await rejectionCode(() =>
          tx.execute(
            sql`INSERT INTO payments (booking_id, type, provider, method, amount_centavos, status, created_at, updated_at)
                VALUES (${bookingId}, 'payment', 'manual', 'gcash', 1, 'paid', UTC_TIMESTAMP(), UTC_TIMESTAMP())`,
          ),
        ),
        'the CHECK is too strict — it refused a legitimate one-centavo payment',
      ).toBeNull();
    });
  });
});
