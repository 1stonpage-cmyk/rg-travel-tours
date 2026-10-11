/**
 * Task 6 of the core-schema plan: the two lock rows — `tour_date_slots` and
 * `fleet_date_slots` — and `payment_events`, the cross-provider webhook
 * idempotency log. This is also the task that generates and applies the
 * Wave 1 migration, so unlike Tasks 1-5 these tables DO exist in
 * `rg_travel_test` and the DB-backed layer below actually runs.
 *
 * Two layers, for one reason each:
 *
 *  1. **Schema assertions** read the Drizzle table objects through
 *     `getTableConfig()`. They pin the declaration drizzle-kit generates DDL
 *     from, so a change to `schema.ts` goes red before any migration is
 *     generated — not after one has already been applied.
 *
 *  2. **DB-backed assertions** read `information_schema` and issue raw
 *     statements. They are what prove the key shapes survived into MySQL,
 *     and they carry the one property that cannot be expressed in a
 *     declaration at all: that two transactions for DIFFERENT tours on the
 *     SAME date actually serialise on the fleet row.
 *
 *     They are gated on the tables existing, the same runtime probe
 *     `audit.test.ts` and `schema-coupons.test.ts` use, so they report as
 *     SKIPPED rather than silently passing if the migration were ever lost.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { getTableConfig } from 'drizzle-orm/mysql-core';
import { getPool } from '../db/client';
import { PAYMENT_PROVIDERS, fleetDateSlots, paymentEvents, tourDateSlots } from '../db/schema';

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

const tourSlots = inspect(tourDateSlots);
const fleetSlots = inspect(fleetDateSlots);
const events = inspect(paymentEvents);

describe('tour_date_slots table', () => {
  /**
   * A composite primary key on (tour_id, date) is the whole table: it is
   * what makes "one row per tour-day" true, so the §5 `FOR UPDATE` lock has
   * exactly one row to take. An autoincrement id with a unique index beside
   * it would let two rows exist for the same tour-day under a race, and two
   * transactions would then lock different rows and both pass the capacity
   * check.
   */
  it('is keyed on (tour_id, date), in that order, with no surrogate id', () => {
    expect(tourSlots.config.primaryKeys).toHaveLength(1);
    expect(tourSlots.config.primaryKeys[0]?.columns.map((c) => c.name)).toEqual([
      'tour_id',
      'date',
    ]);
    expect(tourSlots.columnNames).toEqual(['tour_id', 'date']);
  });

  it('is a mutex, not data — no counter, no status, no timestamps', () => {
    expect(tourSlots.columnNames).toHaveLength(2);
  });

  it('stores the tour day as a civil date, never a datetime instant', () => {
    expect(tourSlots.column('date')?.getSQLType()).toBe('date');
    expect(tourSlots.column('date')?.notNull).toBe(true);
  });

  it('points tour_id at tours, so a lock row cannot name a tour that does not exist', () => {
    expect(tourSlots.config.foreignKeys).toHaveLength(1);
    const fk = tourSlots.config.foreignKeys[0]!.reference();
    expect(fk.columns.map((c) => c.name)).toEqual(['tour_id']);
    expect(fk.foreignColumns.map((c) => c.name)).toEqual(['id']);
    // RESTRICT everywhere: nothing in this schema cascades.
    expect(tourSlots.config.foreignKeys[0]!.onDelete).toBeUndefined();
  });
});

describe('fleet_date_slots table', () => {
  /**
   * Keyed by date ALONE. That is the Q14 answer and the reason the table
   * exists: the fleet is a date-global resource, so every tour booking on a
   * given day has to contend on the same row. Add `tour_id` to this key and
   * it becomes a second copy of `tour_date_slots`, enforcing nothing.
   */
  it('is keyed by date alone, so every tour contends on the same row', () => {
    expect(fleetSlots.columnNames).toEqual(['date']);
    expect(fleetSlots.column('date')?.primary).toBe(true);
    expect(fleetSlots.column('date')?.getSQLType()).toBe('date');
  });

  it('references nothing — it is a date, not a row in another table', () => {
    expect(fleetSlots.config.foreignKeys).toHaveLength(0);
  });
});

describe('payment_events table', () => {
  it('names the three providers the payment layer knows, manual included', () => {
    expect([...PAYMENT_PROVIDERS]).toEqual(['paymongo', 'xendit', 'manual']);
    expect(events.column('provider')?.enumValues).toEqual([...PAYMENT_PROVIDERS]);
    expect(events.column('provider')?.notNull).toBe(true);
  });

  /**
   * The index shape is the idempotency guarantee. It must cover BOTH
   * columns: unique on `provider_event_id` alone would make a Xendit event
   * that happens to share a PayMongo event's id look like a duplicate and be
   * dropped — a payment silently not recorded.
   */
  it('is unique on (provider, provider_event_id), never on the event id alone', () => {
    expect(events.indexes['payment_events_provider_event_unique']).toEqual([
      'provider',
      'provider_event_id',
    ]);
    const unique = events.config.indexes.find(
      (i) => i.config.name === 'payment_events_provider_event_unique',
    );
    expect(unique?.config.unique).toBe(true);
    // ...and the column must not carry a unique constraint of its own either.
    expect(events.column('provider_event_id')?.isUnique).toBeFalsy();
  });

  /**
   * 191, not 255: this column sits in a unique index and utf8mb4 at 4
   * bytes/char puts 255 over MySQL's 767-byte index prefix limit on older
   * row formats.
   */
  it('caps the provider event id at an indexable 191 characters', () => {
    expect(events.column('provider_event_id')?.getSQLType()).toBe('varchar(191)');
    expect(events.column('provider_event_id')?.notNull).toBe(true);
  });

  /**
   * `processed_at` nullable is what lets a crash mid-processing be retried:
   * the row exists (so the event is not processed twice) but is not yet
   * marked done (so it is not lost). A NOT NULL column with a sentinel would
   * make "received" and "acted on" indistinguishable.
   */
  it('leaves processed_at nullable and indexed, so an unfinished event can be found again', () => {
    expect(events.column('processed_at')?.notNull).toBe(false);
    expect(events.column('processed_at')?.getSQLType()).toBe('datetime');
    expect(events.indexes['payment_events_unprocessed_idx']).toEqual(['processed_at']);
  });

  it('times receipt with datetime, never MySQL timestamp (which shifts per session)', () => {
    expect(events.column('received_at')?.getSQLType()).toBe('datetime');
    expect(events.column('received_at')?.notNull).toBe(true);
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

const locksExist =
  (await tableExists('tour_date_slots')) &&
  (await tableExists('fleet_date_slots')) &&
  (await tableExists('payment_events'));
const dbIt = locksExist ? it : it.skip;

/** A date far enough out that no seed or fixture owns it. */
const TEST_DAY = '2099-12-25';
/** Marks every event row these tests write, so cleanup deletes exactly those. */
const EVENT_PREFIX = '__evt_test__';

async function primaryKeyColumns(table: string): Promise<string[]> {
  const [rows] = (await getPool().query(
    'SELECT COLUMN_NAME FROM information_schema.key_column_usage ' +
      "WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND CONSTRAINT_NAME = 'PRIMARY' " +
      'ORDER BY ORDINAL_POSITION',
    [table],
  )) as [Array<{ COLUMN_NAME: string }>, unknown];
  return rows.map((r) => r.COLUMN_NAME);
}

/** The on-demand row creation of owner decision Q8 — safe to race. */
async function touchFleetSlot(day: string): Promise<void> {
  await getPool().query(
    'INSERT INTO fleet_date_slots (date) VALUES (?) ON DUPLICATE KEY UPDATE date = date',
    [day],
  );
}

describe('the lock tables, against the real database', () => {
  afterAll(async () => {
    if (!locksExist) return;
    await getPool().query('DELETE FROM fleet_date_slots WHERE date = ?', [TEST_DAY]);
    await getPool().query('DELETE FROM payment_events WHERE provider_event_id LIKE ?', [
      `${EVENT_PREFIX}%`,
    ]);
  });

  dbIt('gives tour_date_slots a composite primary key on (tour_id, date)', async () => {
    expect(await primaryKeyColumns('tour_date_slots')).toEqual(['tour_id', 'date']);
  });

  dbIt('keys fleet_date_slots by date alone', async () => {
    expect(await primaryKeyColumns('fleet_date_slots')).toEqual(['date']);
  });

  /**
   * The test that justifies the table existing at all. Two transactions for
   * DIFFERENT tours on the SAME date must serialise on this row.
   *
   * Without it both would hold only their own `tour_date_slots` row, never
   * block, and both would pass a "a van is free" check against the same last
   * van.
   */
  dbIt('serialises two different tours booking the same date', async () => {
    await touchFleetSlot(TEST_DAY);

    const lockFleet = async (hold: number) => {
      const conn = await getPool().getConnection();
      try {
        await conn.beginTransaction();
        await conn.query('SELECT date FROM fleet_date_slots WHERE date = ? FOR UPDATE', [TEST_DAY]);
        const acquiredAt = Date.now();
        if (hold > 0) await new Promise((r) => setTimeout(r, hold));
        await conn.commit();
        return acquiredAt;
      } finally {
        conn.release();
      }
    };

    const startedAt = Date.now();
    // The first transaction takes the row and holds it for 300ms.
    const first = lockFleet(300);
    // Let it get there, then have a second transaction — standing in for a
    // booking of a DIFFERENT tour on the same day — ask for the same row.
    await new Promise((r) => setTimeout(r, 50));
    const second = lockFleet(0);

    const [, secondAcquiredAt] = await Promise.all([first, second]);

    expect(secondAcquiredAt, 'the second transaction never acquired the lock').not.toBeNull();
    expect(
      secondAcquiredAt - startedAt,
      'the second transaction did not wait for the first',
    ).toBeGreaterThan(150);
  });

  /**
   * Both halves matter. The cross-provider insert is the one that would go
   * red if the unique index covered `provider_event_id` alone — which is
   * exactly the bug this index shape prevents.
   */
  dbIt('is unique on (provider, provider_event_id), not on the event id alone', async () => {
    const eventId = `${EVENT_PREFIX}shared`;
    const insert = (provider: string) =>
      getPool().query(
        'INSERT INTO payment_events (provider, provider_event_id, type, received_at) ' +
          'VALUES (?, ?, ?, UTC_TIMESTAMP())',
        [provider, eventId, 'payment.paid'],
      );

    await expect(insert('paymongo')).resolves.toBeDefined();
    // Same id, different provider: allowed. Two gateways can mint the same string.
    await expect(insert('xendit')).resolves.toBeDefined();
    // Same id, same provider: refused. This is the idempotency guarantee.
    await expect(insert('paymongo')).rejects.toThrow(/duplicate/i);
  });
});
