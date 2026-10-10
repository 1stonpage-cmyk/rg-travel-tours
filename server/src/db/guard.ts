/**
 * The one database this project may ever touch — and, since task 1.4b, the
 * one TEST database it may ever touch. Kong PMS shares this MySQL server,
 * so a wrong DATABASE_URL is not a failed query — it is a migration running
 * against someone else's production data. Every entry point (server boot,
 * seed, migrate, and now the test suite's global setup) asserts through
 * here before issuing a statement.
 *
 * Context-aware (task 1.4b): the app may only ever touch `rg_travel`, the
 * test suite may only ever touch `rg_travel_test`. Neither context ever
 * accepts the other's database — a test run pointed at `rg_travel` must
 * abort loudly, which is the entire reason this task exists.
 *
 * Messages name the OFFENDING DATABASE, the non-secret host:port, and a
 * fixed enum code — and nothing else: never the URL, never the user, never
 * the password (CLAUDE.md security rules). Since BUG-104 that code also
 * rides on the thrown error as `.code` (see DatabaseFailureCode), so a
 * caller — in particular the production build guard's probe — can tell
 * "MySQL is down" from "wrong password" without parsing prose.
 *
 * This module's top level imports nothing, deliberately. `env.ts` throws at
 * import time when DATABASE_URL is missing — a static `import './client'` or
 * `import '../env'` here would make merely importing this file (e.g. to use
 * the pure assertDatabaseName/databaseNameFromUrl helpers in a test, with no
 * .env present) abort the process. assertConnectedDatabase, the one function
 * that actually needs them, imports them dynamically so that cost is paid
 * only when it is actually called (boot, seed, migrate, test setup).
 */
export type DatabaseContext = 'app' | 'test';

export const APP_DATABASE_NAME = 'rg_travel';
export const TEST_DATABASE_NAME = 'rg_travel_test';

export function databaseNameFromUrl(url: string): string | null {
  try {
    return new URL(url).pathname.replace(/^\//, '') || null;
  } catch {
    return null;
  }
}

function requiredNameFor(context: DatabaseContext): string {
  return context === 'test' ? TEST_DATABASE_NAME : APP_DATABASE_NAME;
}

/**
 * Why a database check failed, as a fixed enum token (BUG-104).
 *
 * Before this existed, every failure in here was a plain `Error` with no
 * `code`, so the production build guard's probe — which classifies with
 * `safeCode()` in ./content-status, reading `error.code` and falling back to
 * the literal `UNREACHABLE` — reported "wrong password", "no such database"
 * and "MySQL is down" identically, and an operator staring at a blocked
 * build could not tell them apart.
 *
 * Every token here is upper-case `[A-Z][A-Z0-9_]*`, which is the shape
 * `safeCode()` (and the build guard's own copy of the same regex in
 * client/scripts/build-guard.mjs) requires. A token that did not match would
 * be silently replaced by `UNREACHABLE` again, which is the whole bug — so
 * if you add one, keep the shape.
 *
 * These are codes, not messages: safe to print, safe to log, safe to put in
 * a build log a client can see. They say nothing about the URL, the user or
 * the password.
 */
export type DatabaseFailureCode =
  | 'DB_NOT_CONFIGURED'
  | 'DB_UNREACHABLE'
  | 'DB_ACCESS_DENIED'
  | 'DB_UNKNOWN_DATABASE'
  | 'DB_WRONG_DATABASE'
  | 'DB_ERROR';

/** An `Error` carrying one of the codes above. */
export interface DatabaseFailure extends Error {
  code: DatabaseFailureCode;
}

/**
 * The ONLY way this module reports a failure, and it never returns.
 *
 * `never` is load-bearing: every call site below is in a position where
 * returning instead of throwing would let a caller carry on against the
 * wrong database, which on this shared MySQL server means a migration
 * running over Kong PMS's data. The return type makes "fail closed" a
 * compile-time property rather than a thing to remember.
 */
function fail(code: DatabaseFailureCode, message: string): never {
  const error = new Error(`${message} [${code}]`) as DatabaseFailure;
  error.code = code;
  throw error;
}

export function assertDatabaseName(
  name: string | null | undefined,
  context: DatabaseContext,
): void {
  const required = requiredNameFor(context);
  if (name === required) return;
  fail(
    'DB_WRONG_DATABASE',
    `Refusing to run against database ${name ? `"${name}"` : '(none)'} in "${context}" context. ` +
      `This project may only touch "${required}" here. ` +
      `Check DATABASE_URL / TEST_DATABASE_URL — Kong PMS shares this MySQL server.`,
  );
}

/**
 * mysql2 / Node driver codes, mapped to what an operator actually needs to
 * know. Anything not listed is `DB_ERROR` — unclassified, still fatal.
 */
const DRIVER_CODES: Readonly<Record<string, DatabaseFailureCode>> = {
  // Could not even dial the server.
  ECONNREFUSED: 'DB_UNREACHABLE',
  ETIMEDOUT: 'DB_UNREACHABLE',
  EHOSTUNREACH: 'DB_UNREACHABLE',
  ENOTFOUND: 'DB_UNREACHABLE',
  // Dialled it; it did not like who we are.
  ER_ACCESS_DENIED_ERROR: 'DB_ACCESS_DENIED',
  ER_NOT_SUPPORTED_AUTH_MODE: 'DB_ACCESS_DENIED',
  // Dialled it, authenticated, and the named database is not there.
  ER_BAD_DB_ERROR: 'DB_UNKNOWN_DATABASE',
};

/** The classification for a raw driver error. Pure; never throws. */
export function classifyConnectionError(error: unknown): DatabaseFailureCode {
  const driverCode = (error as { code?: unknown } | null | undefined)?.code;
  return (typeof driverCode === 'string' ? DRIVER_CODES[driverCode] : undefined) ?? 'DB_ERROR';
}

/**
 * Re-throws a raw connection error as a classified, non-secret failure —
 * and, like `fail`, never returns.
 *
 * The raw error is DISCARDED, deliberately: mysql2's own message echoes the
 * host, the user and sometimes the whole connection string, and Node's
 * `ERR_INVALID_URL` carries the credentialed URL on `err.input`. What
 * survives is the classification, the non-secret `host:port`, the database
 * name that was asked for, and the NAME of the env var to go and look at —
 * never its value.
 *
 * Exported so each branch can be exercised directly with a real driver
 * error shape: the alternative is standing up five broken MySQL servers.
 */
export function throwConnectionFailure(
  error: unknown,
  context: DatabaseContext,
  url: string,
  host: string | undefined,
): never {
  const code = classifyConnectionError(error);
  const at = host ? ` at ${host}` : '';
  const variable = context === 'test' ? 'TEST_DATABASE_URL' : 'DATABASE_URL';

  switch (code) {
    case 'DB_UNREACHABLE':
      return fail(code, `Cannot reach MySQL${at} — is the service running?`);
    case 'DB_ACCESS_DENIED':
      return fail(
        code,
        `MySQL${at} refused the configured credentials. ` +
          `Check the user and password in ${variable}.`,
      );
    case 'DB_UNKNOWN_DATABASE': {
      const wanted = databaseNameFromUrl(url) ?? requiredNameFor(context);
      return fail(
        code,
        `MySQL${at} has no database named "${wanted}". Create it, or fix ${variable}.`,
      );
    }
    default:
      return fail(code, `The connection to MySQL${at} failed for an unclassified reason.`);
  }
}

/**
 * Confirms the database the live connection actually resolved to — not just
 * what the connection string claims — matches the required database for
 * `context` ('app' -> rg_travel, 'test' -> rg_travel_test). Catches a URL
 * that says the right thing but resolves elsewhere (wrong host/port, a
 * stale alias, etc).
 *
 * On a connection failure this never surfaces the driver's own error message
 * or the error object (which can echo back connection details) — only the
 * non-secret host:port (parsed from the URL, same as databaseNameFromUrl),
 * the database name that was asked for, and a fixed `DatabaseFailureCode`
 * (BUG-104), which also rides on the thrown error as `.code` so the build
 * guard's probe can tell "MySQL is down" from "wrong password".
 *
 * EVERY path out of here other than success throws. There is no branch that
 * returns, logs-and-continues, or degrades to a pass: this guard is what
 * stops a migration running against Kong PMS's database on the shared MySQL
 * server, so an unclassified failure is still a fatal failure.
 */
export async function assertConnectedDatabase(context: DatabaseContext = 'app'): Promise<void> {
  const [{ env }, { getPool }] = await Promise.all([import('../env'), import('./client')]);
  const url = context === 'test' ? env.TEST_DATABASE_URL : env.DATABASE_URL;
  if (!url) {
    fail(
      'DB_NOT_CONFIGURED',
      `No ${context === 'test' ? 'TEST_DATABASE_URL' : 'DATABASE_URL'} is configured.`,
    );
  }

  // `new URL(url)` lives INSIDE the try, not before it (fix round 1 cheap
  // fix): unreachable from today's three callers, but Node's
  // ERR_INVALID_URL error carries the full credentialed URL on `err.input`,
  // and nothing upstream of this module is guaranteed to only print
  // `.message` any more — Vitest's own reporter can surface a raw error
  // object. Keeping URL parsing inside the same catch that already discards
  // the raw error means that risk never opens up.
  let host: string | undefined;
  let rows: Array<{ db: string | null }>;
  try {
    host = new URL(url).host;
    [rows] = (await getPool().query('SELECT DATABASE() AS db')) as unknown as [
      Array<{ db: string | null }>,
      unknown,
    ];
  } catch (error) {
    throwConnectionFailure(error, context, url, host);
  }
  // Connected — but possibly to the wrong database, which
  // assertDatabaseName turns into DB_WRONG_DATABASE.
  assertDatabaseName(rows[0]?.db ?? null, context);
}
