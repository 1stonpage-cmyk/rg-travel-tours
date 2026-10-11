/**
 * Task 2 of the core-schema plan: the `audit_log` table and `writeAudit()`.
 *
 * Three layers, for one reason each:
 *
 *  1. **Schema assertions** read the Drizzle table object through
 *     `getTableConfig()`, not `information_schema` — Wave 1's migration is
 *     generated once, in Task 6, so `audit_log` does not exist in
 *     `rg_travel_test` yet. Same reasoning as `schema-users.test.ts`.
 *
 *  2. **A recording transaction handle** proves the load-bearing property
 *     without a database: `writeAudit` inserts through the handle it is
 *     given. If it ever reached for `getDb()` instead, the handle would see
 *     nothing and these go red today, with no table required.
 *
 *  3. **The real rollback test** needs the migrated table, so it is gated on
 *     `audit_log` actually existing. It is SKIPPED until Task 6 generates and
 *     applies Wave 1, and enables itself the moment the table appears — no
 *     one has to remember to come back. It is not a test that passes while
 *     the table is missing; it is a test that reports as skipped.
 *
 *     Its ability to fail was proven by hand (see the Task 2 report): with
 *     `audit_log` created in `rg_travel_test` and `writeAudit` changed to use
 *     `getDb()` instead of the `tx` handle, the row survived the rollback and
 *     this test went red.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { getTableConfig } from 'drizzle-orm/mysql-core';
import { getDb, getPool, type Transaction } from '../db/client';
import { AUDIT_ACTOR_TYPES, auditLog } from '../db/schema';
import { writeAudit } from '../services/audit';

const config = getTableConfig(auditLog);
const column = (name: string) => config.columns.find((c) => c.name === name);

describe('audit_log table', () => {
  it('names the five actor types a money trail has to tell apart', () => {
    expect([...AUDIT_ACTOR_TYPES]).toEqual(['user', 'customer', 'driver', 'system', 'provider']);
    expect(column('actor_type')?.enumValues).toEqual([...AUDIT_ACTOR_TYPES]);
  });

  it('leaves actor_id nullable, because a cron job and a gateway are not rows', () => {
    expect(column('actor_id')?.notNull).toBe(false);
  });

  it('puts no foreign key on the polymorphic actor_id', () => {
    expect(config.foreignKeys).toHaveLength(0);
  });

  it('times the row with datetime, never MySQL timestamp (which shifts per session)', () => {
    expect(column('created_at')?.getSQLType()).toBe('datetime');
    expect(column('created_at')?.notNull).toBe(true);
  });

  it('indexes the three ways the log is read: by entity, by actor, by time', () => {
    expect(config.indexes.map((i) => i.config.name).sort()).toEqual([
      'audit_log_actor_idx',
      'audit_log_created_idx',
      'audit_log_entity_idx',
    ]);
  });
});

/**
 * A stand-in for a Drizzle transaction handle that records what was inserted
 * through it. Deliberately implements only `insert(...).values(...)`: anything
 * else `writeAudit` tried to do would throw rather than pass quietly.
 */
function recordingTx() {
  const inserts: Array<{ table: unknown; values: Record<string, unknown> }> = [];
  const tx = {
    insert(table: unknown) {
      return {
        values(values: Record<string, unknown>) {
          inserts.push({ table, values });
          return Promise.resolve();
        },
      };
    },
  };
  return { tx: tx as unknown as Transaction, inserts };
}

describe('writeAudit', () => {
  it('writes through the handle it is given, not through the pool', async () => {
    const { tx, inserts } = recordingTx();

    await writeAudit(tx, {
      actorType: 'user',
      actorId: 1,
      action: 'payment.verified',
      entity: 'payments',
      entityId: 42,
      data: { amountCentavos: 189000 },
    });

    expect(inserts).toHaveLength(1);
    expect(inserts[0]?.table).toBe(auditLog);
    expect(inserts[0]?.values).toMatchObject({
      actorType: 'user',
      actorId: 1,
      action: 'payment.verified',
      entity: 'payments',
      entityId: 42,
      data: { amountCentavos: 189000 },
    });
    expect(inserts[0]?.values.createdAt).toBeInstanceOf(Date);
  });

  it('stores an absent data blob as an explicit null, never undefined', async () => {
    const { tx, inserts } = recordingTx();

    await writeAudit(tx, {
      actorType: 'system',
      actorId: null,
      action: 'booking.expired',
      entity: 'bookings',
      entityId: 999,
    });

    expect(inserts[0]?.values.data).toBeNull();
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

const auditLogExists = await tableExists('audit_log');
const dbIt = auditLogExists ? it : it.skip;

describe('writeAudit, against the real database', () => {
  const entity = '__audit_test__';
  const committedId = 10_000 + Math.floor(Math.random() * 10_000);
  const rolledBackId = committedId + 1;

  afterAll(async () => {
    if (!auditLogExists) return;
    await getDb().delete(auditLog).where(eq(auditLog.entity, entity));
  });

  dbIt('records an actor, an action, an entity and a UTC timestamp', async () => {
    const db = getDb();
    const before = Date.now();

    await db.transaction(async (tx) => {
      await writeAudit(tx, {
        actorType: 'user',
        actorId: 1,
        action: 'payment.verified',
        entity,
        entityId: committedId,
        data: { amountCentavos: 189000 },
      });
    });

    const rows = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.entity, entity), eq(auditLog.entityId, committedId)));

    expect(rows).toHaveLength(1);
    expect(rows[0]?.action).toBe('payment.verified');
    expect(rows[0]?.actorType).toBe('user');
    expect(rows[0]?.data).toEqual({ amountCentavos: 189000 });
    // Written in UTC from JS, so it lands within a second of "now".
    expect(rows[0]?.createdAt.getTime()).toBeGreaterThanOrEqual(before - 1000);
  });

  /**
   * The load-bearing one. An audit row written outside the transaction it
   * describes survives a rollback, and the log then claims a payment was
   * verified when it was not.
   */
  dbIt('rolls the audit row back with the transaction it describes', async () => {
    const db = getDb();

    await expect(
      db.transaction(async (tx) => {
        await writeAudit(tx, {
          actorType: 'system',
          actorId: null,
          action: 'booking.expired',
          entity,
          entityId: rolledBackId,
        });
        throw new Error('simulated failure after the audit write');
      }),
    ).rejects.toThrow('simulated failure');

    const rows = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.entity, entity), eq(auditLog.entityId, rolledBackId)));

    expect(rows, 'an audit row survived a rolled-back transaction').toHaveLength(0);
  });
});
