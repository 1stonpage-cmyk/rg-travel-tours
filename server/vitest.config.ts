import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // Task 1.4b: asserts the suite is connected to rg_travel_test (never
    // rg_travel), runs migrations against it, and seeds it once — before
    // any test file loads.
    globalSetup: ['./src/__tests__/global-setup.ts'],
  },
});
