/**
 * Task 7 of the core-schema plan: the `sessions` table.
 *
 * Two layers, for one reason each:
 *
 *  1. **Schema assertions** read the Drizzle table object through
 *     `getTableConfig()`, not `information_schema`. `sessions` is a WAVE 2
 *     table, and Waves 2–4 are generated once, in Task 11 — so it does not
 *     exist in `rg_travel_test` yet. Same reasoning as `schema-users.test.ts`
 *     and `schema-fleet.test.ts`. `getTableConfig()` reads the very object
 *     drizzle-kit will generate the DDL from, so every assertion here fails
 *     today if the column, constraint or index it names is changed — none
 *     passes because a table is missing.
 *
 *  2. **The same three properties, re-asserted against the real database**,
 *     gated on `sessions` actually existing. They report as SKIPPED until
 *     Task 11 applies Wave 2, and enable themselves the moment the table
 *     appears — the pattern `audit.test.ts` uses. A schema object and the
 *     DDL that drizzle-kit emits from it are two different things, and "no
 *     foreign key on subject_id" is exactly the kind of property a
 *     generator could get wrong silently.
 */
import { describe, expect, it } from 'vitest';
import { getTableConfig } from 'drizzle-orm/mysql-core';
import { getPool } from '../db/client';
import { SESSION_SUBJECTS, drivers, sessions, users } from '../db/schema';

const config = getTableConfig(sessions);
const column = (name: string) => config.columns.find((c) => c.name === name);
const columnNames = config.columns.map((c) => c.name);
const indexes = Object.fromEntries(
  config.indexes.map((i) => [
    i.config.name,
    i.config.columns.map((c) => ('name' in c ? c.name : String(c))),
  ]),
) as Record<string, string[]>;

describe('sessions table', () => {
  /**
   * The staff subject type is `user`, matching the `users` table — not
   * `admin`. Two names for one thing is how a session check ends up
   * comparing `subject_type` against a string nothing ever writes, and a
   * comparison that is always false in a gate fails OPEN or shut at random
   * depending on which side of it the code sits.
   */
  it('names the three subject types the three portals log in as', () => {
    expect([...SESSION_SUBJECTS]).toEqual(['user', 'customer', 'driver']);
    expect(column('subject_type')?.enumValues).toEqual([...SESSION_SUBJECTS]);
    expect(column('subject_type')?.notNull).toBe(true);
    expect([...SESSION_SUBJECTS], 'the staff type is `user`, never `admin`').not.toContain('admin');
  });

  /**
   * The security assertion, and the point of the task. The cookie carries a
   * raw random token; this table carries only its SHA-256. A column that
   * could hold the token itself would turn read access to the database into
   * every live session at once.
   *
   * The regex sweep, rather than a bare `not.toContain('token')`, is what
   * makes this survive someone adding `token`, `raw_token`, `token_plain`
   * or `session_secret` later: the ONLY column that may mention a token is
   * `token_hash`, and no column may mention a secret, a PIN or a password
   * at all.
   */
  it('stores a token HASH and has no column that could hold the raw token', () => {
    expect(columnNames).toContain('token_hash');
    expect(columnNames).not.toContain('token');
    expect(columnNames.filter((n) => /token/i.test(n))).toEqual(['token_hash']);
    expect(columnNames.filter((n) => /secret|plain|raw|password|pin/i.test(n))).toEqual([]);
  });

  it('sizes token_hash for 64 hex characters of SHA-256, and requires one', () => {
    expect(column('token_hash')?.getSQLType()).toBe('varchar(64)');
    expect(column('token_hash')?.notNull).toBe(true);
  });

  /**
   * Unique, so one token can never resolve to two sessions — and so a
   * lookup is one index hit rather than a scan of every live row.
   */
  it('makes token_hash unique, so a token cannot resolve to two sessions', () => {
    expect(column('token_hash')?.isUnique).toBe(true);
  });

  /**
   * A session with no expiry is a permanent credential. Nullable here would
   * mean "never expires" for any row an insert forgot to fill in, and the
   * expiry sweep would skip it forever.
   */
  it('requires an explicit UTC expiry on every row, never nullable', () => {
    expect(column('expires_at')?.getSQLType()).toBe('datetime');
    expect(column('expires_at')?.notNull).toBe(true);
  });

  it('times the row itself with datetime, never MySQL timestamp (which shifts per session)', () => {
    expect(column('created_at')?.getSQLType()).toBe('datetime');
    expect(column('created_at')?.notNull).toBe(true);
  });

  /**
   * `subject_id` points at `users.id`, `bookings.id` or `drivers.id`
   * depending on `subject_type`, which MySQL cannot express as a foreign
   * key. So it is a plain indexed int with NO foreign key — and this table
   * must carry no foreign key at all, because the only candidate column is
   * the polymorphic one.
   *
   * The second half of the assertion is the one that earns its keep: a pair
   * of nullable `user_id`/`driver_id` FK columns looks like a fix, lets both
   * be set at once, and still cannot constrain the `customer` case.
   */
  it('puts no foreign key on the polymorphic subject_id', () => {
    expect(column('subject_id')?.getSQLType()).toBe('int');
    expect(column('subject_id')?.notNull).toBe(true);
    expect(config.foreignKeys, 'sessions must carry no foreign key').toHaveLength(0);
    expect(columnNames.filter((n) => /_id$/.test(n))).toEqual(['subject_id']);
  });

  /** Belt and braces: the two tables a FK would be tempting for are untouched. */
  it('does not reference users or drivers, however tempting', () => {
    const referenced = config.foreignKeys.map((fk) => fk.reference().foreignTable);
    expect(referenced).not.toContain(users);
    expect(referenced).not.toContain(drivers);
  });

  it('indexes the subject lookup and the expiry sweep', () => {
    expect(indexes['sessions_subject_idx']).toEqual(['subject_type', 'subject_id']);
    expect(indexes['sessions_expiry_idx']).toEqual(['expires_at']);
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

const sessionsExists = await tableExists('sessions');
const dbIt = sessionsExists ? it : it.skip;

describe('sessions, as actually migrated', () => {
  dbIt('has no column that could hold a raw token', async () => {
    const [rows] = (await getPool().query(
      `SELECT COLUMN_NAME FROM information_schema.columns
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'sessions'`,
    )) as [Array<{ COLUMN_NAME: string }>, unknown];
    const names = rows.map((r) => String(r.COLUMN_NAME));
    expect(names).toContain('token_hash');
    expect(names.filter((n) => /token/i.test(n))).toEqual(['token_hash']);
    expect(names.filter((n) => /secret|plain|raw|password|pin/i.test(n))).toEqual([]);
  });

  dbIt('carries no foreign key, so subject_id stays polymorphic', async () => {
    const [rows] = (await getPool().query(
      `SELECT CONSTRAINT_NAME FROM information_schema.table_constraints
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'sessions'
          AND CONSTRAINT_TYPE = 'FOREIGN KEY'`,
    )) as [unknown[], unknown];
    expect(rows, 'a foreign key reached the migrated sessions table').toHaveLength(0);
  });

  dbIt('refuses a row with no expiry', async () => {
    const [rows] = (await getPool().query(
      `SELECT DATA_TYPE, IS_NULLABLE FROM information_schema.columns
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'sessions'
          AND COLUMN_NAME = 'expires_at'`,
    )) as [Array<{ DATA_TYPE: string; IS_NULLABLE: string }>, unknown];
    expect(rows[0]?.DATA_TYPE).toBe('datetime');
    expect(rows[0]?.IS_NULLABLE).toBe('NO');
  });
});
