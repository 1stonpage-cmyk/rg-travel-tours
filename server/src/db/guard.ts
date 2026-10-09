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
 * Messages name the OFFENDING DATABASE and nothing else: never the URL, never
 * the user, never the password (CLAUDE.md security rules).
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

export function assertDatabaseName(
  name: string | null | undefined,
  context: DatabaseContext,
): void {
  const required = requiredNameFor(context);
  if (name === required) return;
  throw new Error(
    `Refusing to run against database ${name ? `"${name}"` : '(none)'} in "${context}" context. ` +
      `This project may only touch "${required}" here. ` +
      `Check DATABASE_URL / TEST_DATABASE_URL — Kong PMS shares this MySQL server.`,
  );
}

/** mysql2/Node error codes that mean "could not even dial the server". */
const UNREACHABLE_CODES = new Set(['ECONNREFUSED', 'ETIMEDOUT', 'EHOSTUNREACH']);

/**
 * Confirms the database the live connection actually resolved to — not just
 * what the connection string claims — matches the required database for
 * `context` ('app' -> rg_travel, 'test' -> rg_travel_test). Catches a URL
 * that says the right thing but resolves elsewhere (wrong host/port, a
 * stale alias, etc).
 *
 * On a connection failure this never surfaces the driver's own error message
 * or the error object (which can echo back connection details) — only the
 * non-secret host:port (parsed from the URL, same as databaseNameFromUrl)
 * and, for anything other than an unreachable host, the error's `code`,
 * which is a fixed non-secret enum string (e.g. `ER_ACCESS_DENIED_ERROR`),
 * never its message.
 */
export async function assertConnectedDatabase(context: DatabaseContext = 'app'): Promise<void> {
  const [{ env }, { getPool }] = await Promise.all([import('../env'), import('./client')]);
  const url = context === 'test' ? env.TEST_DATABASE_URL : env.DATABASE_URL;
  if (!url) {
    throw new Error(
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
    const code = (error as { code?: string }).code;
    if (code && host !== undefined && UNREACHABLE_CODES.has(code)) {
      throw new Error(`Cannot reach MySQL at ${host} — is the service running?`);
    }
    throw new Error(`Database connection failed (${code ?? 'unknown error'}).`);
  }
  assertDatabaseName(rows[0]?.db ?? null, context);
}
