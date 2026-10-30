import { defineConfig } from 'vitest/config';

/*
 * Task C2: `seedDemo()` now refuses unless ALLOW_DEMO_SEED is exactly '1'.
 * `global-setup.ts` and dozens of test files call `seed('test')` (which
 * calls `seedDemo('test')` internally), and `env.ts` parses `process.env`
 * once at module-import time — so this var has to be in `process.env`
 * before `env.ts` is first imported, not set later inside
 * `global-setup.ts`'s own function body, which would be too late.
 *
 * `test.env` (below) is NOT sufficient by itself: Vitest only applies it
 * inside each test file's own worker, via `setupCommonEnv()` — proven by
 * running the suite with only `test.env` set, which failed with this
 * project's own refusal message, thrown from INSIDE `global-setup.ts`.
 * `globalSetup` runs in Vitest's main process, before any worker exists, so
 * `test.env` never reaches it. Setting it directly on `process.env` here —
 * at vitest.config.ts's own module-load time, which runs in that same main
 * process, before config resolution finishes and before `globalSetup` is
 * ever imported — is early enough for both: `global-setup.ts`'s static
 * `import { env } from '../env'` sees it already set, and worker processes
 * spawned afterwards inherit it from the main process's `process.env` same
 * as any other env var. `test.env` is kept too, belt-and-suspenders, since
 * it is also the documented way to hand a worker an env var and costs
 * nothing extra.
 */
process.env.ALLOW_DEMO_SEED ??= '1';

export default defineConfig({
  test: {
    environment: 'node',
    env: {
      ALLOW_DEMO_SEED: '1',
    },
    include: ['src/**/*.test.ts'],
    // Task 1.4b: asserts the suite is connected to rg_travel_test (never
    // rg_travel), runs migrations against it, and seeds it once — before
    // any test file loads.
    globalSetup: ['./src/__tests__/global-setup.ts'],
    // Fix round 1, C2: globalSetup only proves the main process's
    // connection is right. Each test file gets its own worker and its own
    // pool, so each one re-proves it independently before it can write.
    setupFiles: ['./src/__tests__/per-file-setup.ts'],
    // Fix round 1, I1: test files share one live test database and several
    // suites reset it (resetTestDb truncates+reseeds tours/destinations/
    // settings). Running files concurrently races a reset against another
    // file's in-flight insert/read-back. Correctness over wall-clock here —
    // the suite is small.
    fileParallelism: false,
  },
});
