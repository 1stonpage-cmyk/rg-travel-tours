/**
 * Task 1 of the core-schema plan: the `users` table and the three admin roles.
 *
 * Most assertions here run against the Drizzle schema object and the shared
 * constants, NOT against `information_schema`. That was originally forced —
 * Wave 1's migration is generated once, in Task 6, so `users` did not exist
 * in `rg_travel_test` while Task 1 was written — and it is kept because
 * `getTableConfig()` pins the declaration drizzle-kit generates DDL from, so
 * a change to `schema.ts` goes red before a migration is generated rather
 * than after one has been applied.
 *
 * Task 6 adds the one DB-backed guard at the bottom, carried forward from
 * Task 1: nothing pinned `password_hash` at 255 characters, and a later
 * narrowing to, say, `varchar(60)` would silently truncate every argon2id
 * hash written after it — locking out every admin, with no error anywhere.
 * It is gated on the table existing (the same runtime probe `audit.test.ts`
 * uses) so it reports as SKIPPED rather than silently passing.
 */
import { describe, expect, it } from 'vitest';
import { ADMIN_ROLES, adminRoleSchema } from '@rg/shared';
import { getTableConfig } from 'drizzle-orm/mysql-core';
import { getPool } from '../db/client';
import { users } from '../db/schema';

const config = getTableConfig(users);
const column = (name: string) => config.columns.find((c) => c.name === name);
const columnNames = config.columns.map((c) => c.name);

describe('admin roles', () => {
  it('is exactly the three roles the permission matrix uses', () => {
    expect([...ADMIN_ROLES]).toEqual(['owner', 'dispatcher', 'finance']);
  });

  it('rejects a role outside the matrix', () => {
    expect(adminRoleSchema.safeParse('admin').success).toBe(false);
    expect(adminRoleSchema.safeParse('superuser').success).toBe(false);
  });
});

describe('users table', () => {
  it('stores only a password hash — no column can hold a plaintext password', () => {
    expect(columnNames).toContain('password_hash');
    expect(columnNames.filter((n) => /password|passwd|pin/i.test(n))).toEqual(['password_hash']);
  });

  it('constrains role to the shared ADMIN_ROLES, so there is one source of truth', () => {
    expect(column('role')?.enumValues).toEqual([...ADMIN_ROLES]);
  });

  it('makes email unique, so one address cannot hold two admin accounts', () => {
    expect(column('email')?.isUnique).toBe(true);
  });

  it('soft-deletes through is_active rather than removing the row', () => {
    const isActive = column('is_active');
    expect(isActive?.notNull).toBe(true);
    expect(isActive?.default).toBe(true);
  });

  it('times everything with datetime, never MySQL timestamp (which shifts per session)', () => {
    for (const name of ['last_login_at', 'created_at', 'updated_at']) {
      expect(column(name)?.getSQLType(), `${name} is not a datetime`).toBe('datetime');
    }
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

const usersExists = await tableExists('users');
const dbIt = usersExists ? it : it.skip;

describe('users, against the real database', () => {
  /**
   * Carried forward from Task 1. `password_hash` must stay wide enough for a
   * full argon2id encoded hash — ~97 characters for the default parameters,
   * and longer as they are raised. MySQL does not error on an oversized
   * value in a narrowed column by default; it TRUNCATES, so narrowing this
   * column would store a prefix of every new hash, every verification would
   * fail, and the only symptom would be admins who cannot sign in.
   *
   * Asserted from `information_schema`, not from the declaration, because
   * the declaration is not what the password verifier reads from.
   */
  dbIt('keeps password_hash at 255 characters, wide enough for an argon2id hash', async () => {
    const [rows] = (await getPool().query(
      'SELECT DATA_TYPE, CHARACTER_MAXIMUM_LENGTH, IS_NULLABLE FROM information_schema.columns ' +
        "WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' " +
        "AND COLUMN_NAME = 'password_hash'",
    )) as [
      Array<{ DATA_TYPE: string; CHARACTER_MAXIMUM_LENGTH: number; IS_NULLABLE: string }>,
      unknown,
    ];

    expect(rows, 'users.password_hash is missing').toHaveLength(1);
    expect(rows[0]?.DATA_TYPE).toBe('varchar');
    expect(Number(rows[0]?.CHARACTER_MAXIMUM_LENGTH)).toBe(255);
    // NOT NULL: an account with no hash is an account with no password.
    expect(rows[0]?.IS_NULLABLE).toBe('NO');
  });
});
