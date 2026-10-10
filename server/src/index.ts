import { createApp } from './app';
import { assertConnectedDatabase, assertDatabaseName, databaseNameFromUrl } from './db/guard';
import { env } from './env';
import { CLIENT_DIST_DIR } from './html';

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

createApp(env.PUBLIC_BASE_URL, clientDistDir).listen(env.PORT, () => {
  console.log(`[rg-travel-tours] server listening on http://localhost:${env.PORT}`);
});
