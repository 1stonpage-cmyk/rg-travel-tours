/**
 * BUG-104 — the database guard must say WHY a connection failed, in a form
 * the production build guard can read.
 *
 * `server/src/db/guard.ts` used to throw plain `Error`s with no `code`. The
 * build guard's probe classifies with `safeCode()` (db/content-status.ts),
 * which reads `error.code` and falls back to the literal `UNREACHABLE` — so
 * "MySQL is down", "wrong password" and "no such database" all arrived at a
 * blocked production build as the same word, and an operator had nothing to
 * act on.
 *
 * Two properties are under test and they are not the same property:
 *
 *  1. The CLASSIFICATION is right, and the message still leaks nothing. The
 *     existing security tests in db-guard.test.ts cover `assertDatabaseName`;
 *     these cover the connection-failure path, which is where the driver's
 *     own error — the one that echoes host, user and password — is handled.
 *  2. It FAILS CLOSED. Every branch throws. A classification refactor that
 *     let one case return instead would be far worse than the bug it fixed:
 *     this guard is what stops a migration running against Kong PMS's
 *     database on the shared MySQL server. `callAndCatch` below returns a
 *     sentinel rather than failing outright when nothing is thrown, so the
 *     "it threw at all" assertion is explicit in every case instead of being
 *     implied by a `.toThrow()` that would also be satisfied by the wrong
 *     error.
 *
 * Module mocking lives in this file rather than db-guard.test.ts so
 * `vi.resetModules()` cannot disturb that file's live `getPool()` suite.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  assertDatabaseName,
  classifyConnectionError,
  throwConnectionFailure,
  type DatabaseFailure,
  type DatabaseFailureCode,
} from '../db/guard';
import { safeCode } from '../db/content-status';

/**
 * A credentialed URL and a driver message of the shape mysql2 actually
 * produces. Every assertion below checks that NONE of this reaches the
 * message — the user and the password in particular.
 */
const SECRET_URL = 'mysql://rg_user:sup3rs3cret@db.internal:3306/rg_travel';
const HOST = 'db.internal:3306';
const RAW_DRIVER_MESSAGE =
  "Access denied for user 'rg_user'@'10.0.0.5' (using password: YES) " +
  'connecting to mysql://rg_user:sup3rs3cret@db.internal:3306/rg_travel';

/** Didn't throw. Distinguishable from any real failure. */
const DID_NOT_THROW = Symbol('did not throw');

function driverError(code: string | undefined): Error {
  const error = new Error(RAW_DRIVER_MESSAGE);
  if (code !== undefined) Object.assign(error, { code });
  return error;
}

function callAndCatch(fn: () => unknown): DatabaseFailure | typeof DID_NOT_THROW {
  try {
    fn();
  } catch (error) {
    return error as DatabaseFailure;
  }
  return DID_NOT_THROW;
}

/**
 * The existing security property, asserted per branch. The positive check
 * comes first on purpose: without it, a sentinel or an empty message would
 * satisfy every `not.toContain` below just as happily as a correct one.
 */
function expectSafeMessage(message: string, expectedCode: DatabaseFailureCode): void {
  expect(message).toContain(expectedCode);
  expect(message).not.toContain('sup3rs3cret');
  expect(message).not.toContain('mysql://');
  expect(message).not.toContain('rg_user');
  expect(message).not.toContain('10.0.0.5');
  expect(message).not.toContain('using password');
}

describe('connection failures are classified, and every branch throws', () => {
  it.each([
    ['ECONNREFUSED', 'DB_UNREACHABLE'],
    ['ETIMEDOUT', 'DB_UNREACHABLE'],
    ['EHOSTUNREACH', 'DB_UNREACHABLE'],
    ['ENOTFOUND', 'DB_UNREACHABLE'],
    ['ER_ACCESS_DENIED_ERROR', 'DB_ACCESS_DENIED'],
    ['ER_NOT_SUPPORTED_AUTH_MODE', 'DB_ACCESS_DENIED'],
    ['ER_BAD_DB_ERROR', 'DB_UNKNOWN_DATABASE'],
    // "other": a code nobody mapped, and an error with no code at all.
    ['ER_LOCK_WAIT_TIMEOUT', 'DB_ERROR'],
    [undefined, 'DB_ERROR'],
  ] as Array<[string | undefined, DatabaseFailureCode]>)(
    'driver code %s becomes %s',
    (driverCode, expected) => {
      const failure = callAndCatch(() =>
        throwConnectionFailure(driverError(driverCode), 'app', SECRET_URL, HOST),
      );

      expect(failure, 'throwConnectionFailure RETURNED instead of throwing').not.toBe(
        DID_NOT_THROW,
      );
      const thrown = failure as DatabaseFailure;
      expect(thrown.code).toBe(expected);
      // The non-secret host is named, so the message is actually useful...
      expect(thrown.message).toContain(HOST);
      // ...and nothing else from the driver's error or the URL is.
      expectSafeMessage(thrown.message, expected);
    },
  );

  it('connected-but-wrong-database is DB_WRONG_DATABASE and names the offending database', () => {
    const failure = callAndCatch(() => assertDatabaseName('kong_pms', 'app'));

    expect(failure, 'assertDatabaseName RETURNED on a wrong database').not.toBe(DID_NOT_THROW);
    const thrown = failure as DatabaseFailure;
    expect(thrown.code).toBe('DB_WRONG_DATABASE');
    expect(thrown.message).toContain('kong_pms');
    expect(thrown.message).toContain('rg_travel');
    expectSafeMessage(thrown.message, 'DB_WRONG_DATABASE');
  });

  it('names the database that does not exist, taken from the URL, not the password beside it', () => {
    const failure = callAndCatch(() =>
      throwConnectionFailure(driverError('ER_BAD_DB_ERROR'), 'app', SECRET_URL, HOST),
    ) as DatabaseFailure;

    expect(failure.message).toContain('rg_travel');
    expectSafeMessage(failure.message, 'DB_UNKNOWN_DATABASE');
  });

  it('omits the host rather than printing "undefined" when the URL could not be parsed', () => {
    const failure = callAndCatch(() =>
      throwConnectionFailure(driverError('ERR_INVALID_URL'), 'app', 'not a url', undefined),
    ) as DatabaseFailure;

    expect(failure.code).toBe('DB_ERROR');
    expect(failure.message).not.toContain('undefined');
    expect(failure.message).not.toContain('not a url');
  });

  it('classifyConnectionError never throws, whatever it is handed', () => {
    for (const value of [null, undefined, 'ECONNREFUSED', 42, {}, { code: 7 }]) {
      expect(classifyConnectionError(value)).toBe('DB_ERROR');
    }
  });
});

describe('the codes survive to the production build guard', () => {
  /**
   * The actual bug: `safeCode()` replaces anything that is not an upper-case
   * enum token with `UNREACHABLE`, so a code that is merely *present* is not
   * enough — it has to be shaped to pass. This is the end-to-end check from
   * the guard's throw to what the build guard's probe would print.
   */
  it.each([
    ['ECONNREFUSED', 'DB_UNREACHABLE'],
    ['ER_ACCESS_DENIED_ERROR', 'DB_ACCESS_DENIED'],
    ['ER_BAD_DB_ERROR', 'DB_UNKNOWN_DATABASE'],
    ['ER_LOCK_WAIT_TIMEOUT', 'DB_ERROR'],
  ] as Array<[string, DatabaseFailureCode]>)(
    'safeCode() passes %s through as %s, not UNREACHABLE',
    (driverCode, expected) => {
      const failure = callAndCatch(() =>
        throwConnectionFailure(driverError(driverCode), 'app', SECRET_URL, HOST),
      );
      expect(safeCode(failure)).toBe(expected);
      expect(safeCode(failure)).not.toBe('UNREACHABLE');
    },
  );

  it('safeCode() passes the wrong-database code through too', () => {
    const failure = callAndCatch(() => assertDatabaseName('kong_pms', 'app'));
    expect(safeCode(failure)).toBe('DB_WRONG_DATABASE');
  });
});

/**
 * The live path, with the environment and the pool replaced — the only way
 * to exercise "no connection string" and "the query itself rejected" without
 * five broken MySQL servers. Mocks are registered with `vi.doMock` and the
 * module is re-imported, because guard.ts imports `../env` and `./client`
 * dynamically (so that merely importing the pure helpers does not trip
 * env.ts's import-time throw).
 */
describe('assertConnectedDatabase routes the live path through the same classification', () => {
  afterEach(() => {
    vi.doUnmock('../env');
    vi.doUnmock('../db/client');
    vi.resetModules();
  });

  async function loadGuard() {
    vi.resetModules();
    return import('../db/guard');
  }

  it('throws DB_NOT_CONFIGURED when no connection string is configured', async () => {
    vi.doMock('../env', () => ({ env: { DATABASE_URL: undefined, TEST_DATABASE_URL: undefined } }));
    vi.doMock('../db/client', () => ({
      getPool: () => {
        throw new Error('the pool must never be reached with no URL configured');
      },
    }));
    const { assertConnectedDatabase } = await loadGuard();

    await expect(assertConnectedDatabase('app')).rejects.toMatchObject({
      code: 'DB_NOT_CONFIGURED',
    });
  });

  it('turns a rejecting pool query into the classified failure, not the driver error', async () => {
    vi.doMock('../env', () => ({
      env: { DATABASE_URL: SECRET_URL, TEST_DATABASE_URL: SECRET_URL },
    }));
    vi.doMock('../db/client', () => ({
      getPool: () => ({ query: () => Promise.reject(driverError('ER_ACCESS_DENIED_ERROR')) }),
    }));
    const { assertConnectedDatabase } = await loadGuard();

    const rejection = await assertConnectedDatabase('app').then(
      () => DID_NOT_THROW,
      (error: unknown) => error as DatabaseFailure,
    );

    expect(rejection, 'assertConnectedDatabase RESOLVED on a failed connection').not.toBe(
      DID_NOT_THROW,
    );
    const thrown = rejection as DatabaseFailure;
    expect(thrown.code).toBe('DB_ACCESS_DENIED');
    expectSafeMessage(thrown.message, 'DB_ACCESS_DENIED');
  });

  it('rejects when the live connection resolved to the wrong database', async () => {
    vi.doMock('../env', () => ({
      env: { DATABASE_URL: SECRET_URL, TEST_DATABASE_URL: SECRET_URL },
    }));
    vi.doMock('../db/client', () => ({
      getPool: () => ({ query: () => Promise.resolve([[{ db: 'kong_pms' }], undefined]) }),
    }));
    const { assertConnectedDatabase } = await loadGuard();

    const rejection = await assertConnectedDatabase('app').then(
      () => DID_NOT_THROW,
      (error: unknown) => error as DatabaseFailure,
    );

    expect(rejection, 'assertConnectedDatabase RESOLVED against kong_pms').not.toBe(DID_NOT_THROW);
    expect((rejection as DatabaseFailure).code).toBe('DB_WRONG_DATABASE');
    expect((rejection as DatabaseFailure).message).toContain('kong_pms');
  });

  it('still resolves when the connection really is the required database', async () => {
    // The pass case, so the suite above cannot be satisfied by a guard that
    // simply throws at everything.
    vi.doMock('../env', () => ({
      env: { DATABASE_URL: SECRET_URL, TEST_DATABASE_URL: SECRET_URL },
    }));
    vi.doMock('../db/client', () => ({
      getPool: () => ({ query: () => Promise.resolve([[{ db: 'rg_travel' }], undefined]) }),
    }));
    const { assertConnectedDatabase } = await loadGuard();

    await expect(assertConnectedDatabase('app')).resolves.toBeUndefined();
  });
});
