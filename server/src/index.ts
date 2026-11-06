import { createApp } from './app';
import { assertConnectedDatabase, assertDatabaseName, databaseNameFromUrl } from './db/guard';
import { env } from './env';
import { CLIENT_DIST_DIR } from './html';
import { startScheduledJobs } from './jobs';
import { warnIfOwnerPasswordUnused } from './db/owner-bootstrap';

try {
  assertDatabaseName(databaseNameFromUrl(env.DATABASE_URL), 'app');
  await assertConnectedDatabase('app');
} catch (error) {
  console.error(`\n[rg-travel-tours] Database check failed.\n  ${(error as Error).message}\n`);
  process.exit(1);
}

/*
 * One line, once, if the one-time bootstrap credential is still sitting in
 * `.env` after the owner it was for already exists (Task 1D). It runs here
 * because the checks above have just proved the database reachable and the
 * right one — and it CANNOT stop the boot: it catches its own failures and
 * fails open on purpose. See db/owner-bootstrap.ts for why this is the one
 * guard in the tree that does.
 */
await warnIfOwnerPasswordUnused();

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
 * The cron, started after the database checks above have passed — a sweep
 * against an unreachable or wrong database is not something to schedule.
 *
 * **This process must be the only one running it** (PM2 fork mode, 1
 * instance; see `src/jobs/index.ts` and docs/LAUNCH_CHECKLIST.md). Nothing
 * else in the codebase imports `src/jobs`, so no test can start a schedule.
 */
startScheduledJobs();
