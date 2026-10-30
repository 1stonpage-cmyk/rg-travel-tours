/**
 * CLI entry point for the DEMO half of the seed (Week 7 Task B2, BUG-118).
 * See the module doc-comment at the top of `./seed.ts` for what BASE vs
 * DEMO means and why the split exists.
 *
 * Wired to `pnpm --filter @rg/server db:seed:demo`, following the exact
 * same success/failure pattern as `./seed.ts`'s own `isMainModule` block —
 * `seedDemo()` guards its own database name independently of
 * `seedBase()`'s, so a standalone invocation here is protected the same way
 * a standalone `db:seed` run is.
 *
 * **Never run `db:seed:demo` against the production database once real
 * content exists.** Unlike `db:seed` (base), this half still overwrites
 * admin-edited tours, price tiers, images, packages, reviews and (on the
 * app database) the fleet on every run — that is unchanged, deliberate
 * dev/demo behaviour, not a bug left over from the split.
 */
import { pathToFileURL } from 'node:url';
import { closeDb } from './client';
import { seedDemo } from './seed';

const isMainModule =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMainModule) {
  seedDemo()
    .then(async () => {
      await closeDb();
    })
    .catch(async (error: unknown) => {
      console.error('[seed] failed:', error instanceof Error ? error.message : error);
      await closeDb();
      process.exit(1);
    });
}
