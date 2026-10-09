import { createApp } from './app';
import { assertConnectedDatabase, assertDatabaseName, databaseNameFromUrl } from './db/guard';
import { env } from './env';

try {
  assertDatabaseName(databaseNameFromUrl(env.DATABASE_URL), 'app');
  await assertConnectedDatabase('app');
} catch (error) {
  console.error(`\n[rg-travel-tours] Database check failed.\n  ${(error as Error).message}\n`);
  process.exit(1);
}

createApp(env.PUBLIC_BASE_URL).listen(env.PORT, () => {
  console.log(`[rg-travel-tours] server listening on http://localhost:${env.PORT}`);
});
