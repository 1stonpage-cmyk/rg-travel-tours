import { describe, expect, it } from 'vitest';
import {
  APP_DATABASE_NAME,
  TEST_DATABASE_NAME,
  assertDatabaseName,
  databaseNameFromUrl,
} from '../db/guard';
import { getPool } from '../db/client';
import { describeWithDb } from './helpers/db';

describe('database name guard', () => {
  it('app context requires exactly rg_travel', () => {
    expect(APP_DATABASE_NAME).toBe('rg_travel');
    expect(() => assertDatabaseName('rg_travel', 'app')).not.toThrow();
  });

  it('test context requires exactly rg_travel_test', () => {
    expect(TEST_DATABASE_NAME).toBe('rg_travel_test');
    expect(() => assertDatabaseName('rg_travel_test', 'test')).not.toThrow();
  });

  it.each(['kong_pms', 'mysql', 'rg_travel_backup', 'RG_TRAVEL', '', null, undefined])(
    'app context aborts on %s',
    (name) => {
      expect(() => assertDatabaseName(name, 'app')).toThrow(/rg_travel/);
    },
  );

  it('never leaks the connection string or password in the message', () => {
    const secret = 'mysql://rg_travel:sup3rs3cret@localhost:3306/kong_pms';
    try {
      assertDatabaseName(databaseNameFromUrl(secret), 'app');
      throw new Error('should have aborted');
    } catch (error) {
      const message = (error as Error).message;
      expect(message).not.toContain('sup3rs3cret');
      expect(message).not.toContain('mysql://');
      expect(message).toContain('kong_pms');
    }
  });

  it('reads the database name out of a URL', () => {
    expect(databaseNameFromUrl('mysql://u:p@localhost:3306/rg_travel')).toBe('rg_travel');
    expect(databaseNameFromUrl('mysql://u:p@localhost:3306/rg_travel?ssl=true')).toBe('rg_travel');
    expect(databaseNameFromUrl('not a url')).toBeNull();
  });
});

describe('context-aware database guard', () => {
  it('app context accepts only rg_travel', () => {
    expect(() => assertDatabaseName('rg_travel', 'app')).not.toThrow();
    expect(() => assertDatabaseName('rg_travel_test', 'app')).toThrow(/rg_travel/);
  });

  it('test context accepts only rg_travel_test', () => {
    expect(() => assertDatabaseName('rg_travel_test', 'test')).not.toThrow();
    expect(() => assertDatabaseName('rg_travel', 'test')).toThrow(/rg_travel_test/);
  });

  it.each(['kong_pms', 'mysql', '', null, undefined])('rejects %s in both contexts', (name) => {
    expect(() => assertDatabaseName(name, 'app')).toThrow();
    expect(() => assertDatabaseName(name, 'test')).toThrow();
  });

  it('still never leaks a connection string or password', () => {
    try {
      assertDatabaseName(databaseNameFromUrl('mysql://u:s3cret@h/kong_pms'), 'app');
    } catch (error) {
      expect((error as Error).message).not.toContain('s3cret');
      expect((error as Error).message).not.toContain('mysql://');
    }
  });
});

describeWithDb('database connection isolation', () => {
  it('the test suite is connected to rg_travel_test, never rg_travel', async () => {
    const [rows] = (await getPool().query('SELECT DATABASE() AS db')) as unknown as [
      Array<{ db: string }>,
      unknown,
    ];
    expect(rows[0]?.db).toBe('rg_travel_test');
  });
});
