/**
 * Task 1 of the core-schema plan: the `users` table and the three admin roles.
 *
 * These assertions run against the Drizzle schema object and the shared
 * constants, NOT against `information_schema`. That is deliberate: Wave 1's
 * migration is generated once, in Task 6, after Tasks 1-5 have all added
 * their tables, so `users` does not exist in `rg_travel_test` yet. A
 * DB-backed version of this file would be skipped (or red) until Task 6 and
 * would prove nothing about the thing Task 1 actually delivers.
 */
import { describe, expect, it } from 'vitest';
import { ADMIN_ROLES, adminRoleSchema } from '@rg/shared';
import { getTableConfig } from 'drizzle-orm/mysql-core';
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
