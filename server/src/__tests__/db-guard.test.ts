import { describe, expect, it } from 'vitest';
import { REQUIRED_DATABASE_NAME, assertDatabaseName, databaseNameFromUrl } from '../db/guard';

describe('database name guard', () => {
  it('requires exactly rg_travel', () => {
    expect(REQUIRED_DATABASE_NAME).toBe('rg_travel');
    expect(() => assertDatabaseName('rg_travel')).not.toThrow();
  });

  it.each(['kong_pms', 'mysql', 'rg_travel_backup', 'RG_TRAVEL', '', null, undefined])(
    'aborts on %s',
    (name) => {
      expect(() => assertDatabaseName(name)).toThrow(/rg_travel/);
    },
  );

  it('never leaks the connection string or password in the message', () => {
    const secret = 'mysql://rg_travel:sup3rs3cret@localhost:3306/kong_pms';
    try {
      assertDatabaseName(databaseNameFromUrl(secret));
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
