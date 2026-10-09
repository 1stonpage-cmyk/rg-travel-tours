/**
 * Vitest `setupFiles` (fix round 1, C2). `globalSetup` only runs once, in
 * the main Vitest process — each test file runs in its own worker, with its
 * own lazily-created connection pool (server/src/db/client.ts), and that
 * pool's only protection was `process.env.VITEST` selecting TEST_DATABASE_URL
 * over DATABASE_URL. That is one environment variable away from every
 * worker writing to the live `rg_travel`: a curated env, a future worker
 * pool setting, or anything else that unsets VITEST for a worker falls back
 * to DATABASE_URL with nothing else standing in the way.
 *
 * This file runs once per test file, in that file's own worker, before any
 * of its tests, and proves — with a real `SELECT DATABASE()`, not an env
 * var read — that this worker's connection actually is `rg_travel_test`.
 * One query per file; cheap. Converts the fail-open VITEST fallback into a
 * hard abort for every process in this run that can write.
 */
import { assertConnectedDatabase } from '../db/guard';

await assertConnectedDatabase('test');
