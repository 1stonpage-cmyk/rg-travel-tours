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
import { getTableConfig } from 'drizzle-orm/mysql-core';
import { VAN_STATUSES, vans } from '../db/schema';

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

  it('constrains status to the three fleet states, defaulting to available', () => {
    expect([...VAN_STATUSES]).toEqual(['available', 'on_trip', 'for_repair']);
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
   * the index is present. The §5 capacity query filters active + not
   * for_repair and only then needs `capacity >= pax`, so the two equality
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
