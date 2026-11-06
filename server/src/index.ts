import { createApp } from './app';
import { assertConnectedDatabase, assertDatabaseName, databaseNameFromUrl } from './db/guard';
import { warnIfOwnerPasswordUnused } from './db/owner-bootstrap';
import { env } from './env';
import { CLIENT_DIST_DIR } from './html';
import { startScheduledJobs } from './jobs';

try {
  assertDatabaseName(databaseNameFromUrl(env.DATABASE_URL), 'app');
  await assertConnectedDatabase('app');
} catch (error) {
  console.error(`\n[rg-travel-tours] Database check failed.\n  ${(error as Error).message}\n`);
  process.exit(1);
}

// Only production serves the built SPA (and its injected SEO meta) from
// Express — in development Vite owns the HTML on CLIENT_PORT and runs the
// same resolvers itself (D6). Reading client/dist here when it does not exist
// would make `pnpm dev` fail to boot the API.
const clientDistDir = env.NODE_ENV === 'production' ? CLIENT_DIST_DIR : undefined;

// SITE_ENV (not NODE_ENV) decides the crawl directives: a preview deploy runs
// a production build but must never be indexed. See middleware/robots-header.ts.
createApp(env.PUBLIC_BASE_URL, clientDistDir, env.SITE_ENV).listen(env.PORT, () => {
  console.log(`[rg-travel-tours] server listening on http://localhost:${env.PORT}`);
});

/*
 * One line, once, if the one-time bootstrap credential is still sitting in
 * `.env` after the owner it was for already exists (Task 1D).
 *
 * **Deliberately AFTER `listen()`, and deliberately NOT awaited** (review fix,
 * I1). `warnIfOwnerPasswordUnused()` cannot reject — every path, the `env`
 * read included, is inside its own `try` — so there is nothing to await; and
 * awaiting it ahead of `listen()` made an advisory check able to cause the
 * outage it exists to avoid. A thrown or rejected query was always handled,
 * but a query that never ANSWERS is a third case neither a `catch` nor a
 * `connectTimeout` covers: the pool is mysql2's default unbounded, untimed
 * queue (see db/client.ts), so a metadata lock on `users` during a deploy —
 * a concurrent `ALTER TABLE users`, say — would leave `listen()` unreached
 * for as long as the lock held, with PM2 reporting the process online and
 * nothing answering the port. Run after the listener is up, the worst that
 * same stall can do is never print a reminder.
 *
 * It still runs after the database checks above, for the same reason the cron
 * does: there is no point asking a database that has not been proved to be
 * the right one.
 */
void warnIfOwnerPasswordUnused();

/*
 * The cron, started after the database checks above have passed — a sweep
 * against an unreachable or wrong database is not something to schedule.
 *
 * **This process must be the only one running it** (PM2 fork mode, 1
 * instance; see `src/jobs/index.ts` and docs/LAUNCH_CHECKLIST.md). Nothing
 * else in the codebase imports `src/jobs`, so no test can start a schedule.
 */
startScheduledJobs();
