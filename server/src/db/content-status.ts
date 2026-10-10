/**
 * "Is the site's content real yet?" — read once, for the production build
 * guard (`client/scripts/check-placeholders.mjs`, task 4.5).
 *
 * The guard is a bare-node `.mjs` that runs before any TypeScript is
 * compiled, so it cannot import this file. It runs `./content-status-cli.ts`
 * instead, as a one-shot child process through the server package's own
 * `tsx`, and parses the single JSON line that prints. That indirection is
 * deliberate: it keeps ONE copy of the connection logic (`./client`), ONE
 * copy of the "never touch Kong's database" assertion (`./guard`) and ONE
 * copy of the env contract (`../env`), instead of a second hand-rolled
 * mysql2 connection inside the client package — which would also need mysql2
 * as a client dependency, and does not have one.
 *
 * Two facts, both read-only:
 *   - how many PUBLISHED `is_sample` reviews exist (seeded social proof);
 *   - `settings.content_unverified` (the launch switch from task 4.3).
 * `siteEnv` rides along so the guard learns the deploy environment from the
 * canonical `env.ts` (dotenv + zod + fail-closed default) rather than growing
 * its own .env parser.
 *
 * SECURITY: the payload never contains DATABASE_URL, a host, a user or a
 * password. A failure is reported as the driver's `code` only — a fixed
 * upper-case enum token — and never the error's message, which can echo
 * connection details back (same rule as `./guard`). The guard re-sanitises
 * the code on its side before printing it.
 */
import { and, eq, sql } from 'drizzle-orm';
import { readSettingBlock } from '../content/settings';
import { env, type SiteEnv } from '../env';
import { getDb } from './client';
import { assertConnectedDatabase } from './guard';
import { reviews } from './schema';

/** A build must not hang on a dead database. Short, because this is a probe. */
export const PROBE_TIMEOUT_MS = 5_000;

export interface ContentStatus {
  siteEnv: SiteEnv;
  /** Published reviews with `is_sample = 1`. Must be 0 before launch. */
  sampleReviewCount: number;
  contentUnverified: boolean;
}

/**
 * Read-only. Asserts the connection actually resolved to the right database
 * first (`assertConnectedDatabase('app')`) so this never reads, let alone
 * counts, rows out of Kong PMS's database on the shared MySQL server.
 */
export async function readContentStatus(): Promise<ContentStatus> {
  await assertConnectedDatabase('app');

  const [row] = await getDb()
    .select({ count: sql<string>`count(*)` })
    .from(reviews)
    .where(and(eq(reviews.status, 'published'), eq(reviews.isSample, true)));

  return {
    siteEnv: env.SITE_ENV,
    sampleReviewCount: Number(row?.count ?? 0),
    contentUnverified: await readSettingBlock('content_unverified'),
  };
}

/** Upper-case enum tokens only — never an error message, never a URL. */
const SAFE_CODE = /^[A-Z][A-Z0-9_]{0,40}$/;

/**
 * The driver's error code when it is safely shaped, `UNREACHABLE` otherwise.
 * `UNREACHABLE` covers everything this project throws by hand (guard.ts's
 * wrong-database and cannot-reach errors carry no `code`) as well as any
 * future error whose `code` is not a plain enum token.
 */
export function safeCode(error: unknown): string {
  const code = (error as { code?: unknown } | null | undefined)?.code;
  return typeof code === 'string' && SAFE_CODE.test(code) ? code : 'UNREACHABLE';
}

function rejectAfter(ms: number): Promise<never> {
  return new Promise((_resolve, reject) => {
    setTimeout(
      () => reject(Object.assign(new Error('content probe timed out'), { code: 'ETIMEDOUT' })),
      ms,
    ).unref();
  });
}

/**
 * Exactly what the CLI prints, as an object — so the fail-closed path can be
 * tested without spawning a process. NEVER throws and never rejects: "the
 * database could not be read" is a result the build guard has to read and
 * judge (plan decision D3), not a crash.
 */
export async function probePayload(): Promise<Record<string, unknown>> {
  try {
    const status = await Promise.race([readContentStatus(), rejectAfter(PROBE_TIMEOUT_MS)]);
    return { ok: true, ...status };
  } catch (error) {
    return { ok: false, siteEnv: env.SITE_ENV, code: safeCode(error) };
  }
}
