import { env } from '../env';
import { getPool } from './client';

/**
 * The one database this project may ever touch. Kong PMS shares this MySQL
 * server, so a wrong DATABASE_URL is not a failed query — it is a migration
 * running against someone else's production data. Every entry point (server
 * boot, seed, migrate) asserts through here before issuing a statement.
 *
 * Messages name the OFFENDING DATABASE and nothing else: never the URL, never
 * the user, never the password (CLAUDE.md security rules).
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

/**
 * Confirms the database the live connection actually resolved to — not just
 * what the connection string claims — is rg_travel. Catches a URL that says
 * rg_travel but resolves elsewhere (wrong host/port, a stale alias, etc).
 *
 * On a connection failure this never surfaces the driver's own error (which
 * can echo back connection details); it reports only the non-secret
 * host:port so the message is safe to print and to put in logs.
 */
export async function assertConnectedDatabase(): Promise<void> {
  let rows: Array<{ db: string | null }>;
  try {
    [rows] = (await getPool().query('SELECT DATABASE() AS db')) as unknown as [
      Array<{ db: string | null }>,
      unknown,
    ];
  } catch {
    throw new Error(
      `Cannot reach MySQL at ${env.DB_HOST}:${env.DB_PORT} — is the service running?`,
    );
  }
  assertDatabaseName(rows[0]?.db ?? null);
}
