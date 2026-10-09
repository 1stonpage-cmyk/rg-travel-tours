/**
 * The one database this project may ever touch. Kong PMS shares this MySQL
 * server, so a wrong DATABASE_URL is not a failed query — it is a migration
 * running against someone else's production data. Every entry point (server
 * boot, seed, migrate) asserts through here before issuing a statement.
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
 * only when it is actually called (boot, seed, migrate).
 */
export const REQUIRED_DATABASE_NAME = 'rg_travel';

export function databaseNameFromUrl(url: string): string | null {
  try {
    return new URL(url).pathname.replace(/^\//, '') || null;
  } catch {
    return null;
  }
}

export function assertDatabaseName(name: string | null | undefined): void {
  if (name === REQUIRED_DATABASE_NAME) return;
  throw new Error(
    `Refusing to run against database ${name ? `"${name}"` : '(none)'}. ` +
      `This project may only touch "${REQUIRED_DATABASE_NAME}". ` +
      `Check DB_NAME in .env — Kong PMS shares this MySQL server.`,
  );
}

/** mysql2/Node error codes that mean "could not even dial the server". */
const UNREACHABLE_CODES = new Set(['ECONNREFUSED', 'ETIMEDOUT', 'EHOSTUNREACH']);

/**
 * Confirms the database the live connection actually resolved to — not just
 * what the connection string claims — is rg_travel. Catches a URL that says
 * rg_travel but resolves elsewhere (wrong host/port, a stale alias, etc).
 *
 * On a connection failure this never surfaces the driver's own error message
 * or the error object (which can echo back connection details) — only the
 * non-secret host:port (parsed from the URL, same as databaseNameFromUrl)
 * and, for anything other than an unreachable host, the error's `code`,
 * which is a fixed non-secret enum string (e.g. `ER_ACCESS_DENIED_ERROR`),
 * never its message.
 */
export async function assertConnectedDatabase(): Promise<void> {
  const [{ env }, { getPool }] = await Promise.all([import('../env'), import('./client')]);
  const host = new URL(env.DATABASE_URL).host;

  let rows: Array<{ db: string | null }>;
  try {
    [rows] = (await getPool().query('SELECT DATABASE() AS db')) as unknown as [
      Array<{ db: string | null }>,
      unknown,
    ];
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code && UNREACHABLE_CODES.has(code)) {
      throw new Error(`Cannot reach MySQL at ${host} — is the service running?`);
    }
    throw new Error(`Database connection failed (${code ?? 'unknown error'}).`);
  }
  assertDatabaseName(rows[0]?.db ?? null);
}
