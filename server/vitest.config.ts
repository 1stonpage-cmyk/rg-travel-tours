import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
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
