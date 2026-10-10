/**
 * Blocks a build that would publish seed content as if it were real.
 *
 * Runs first in `@rg/client`'s build script, before `tsc` and `vite build`.
 * Two things make a build unsafe to serve as the live TravelSugbo site:
 * a PUBLISHED `is_sample` review (seeded social proof — CLAUDE.md forbids
 * presenting it as real) and `settings.content_unverified` still being set
 * (the database still holds placeholder tours, placeholder prices and pending
 * permit numbers, and clearing that flag is what publishes the site to search
 * engines — task 4.3). Either one blocks every build; override deliberately
 * with ALLOW_PLACEHOLDER_BUILD=1.
 *
 * Task 3.7 deleted `src/lib/placeholder-data.ts` and with it the only thing
 * the previous version of this script looked at — which it read through
 * `existsSync`, so since that deletion it has checked nothing and exited 0
 * every time. That dead check is gone rather than kept: a guard that cannot
 * fire is worse than no guard, because it reads like protection. The real
 * state now lives in the database, so this asks the database.
 *
 * Split in two on purpose:
 *   - ./build-guard.mjs  — the pure decision (unit-tested in
 *                          client/src/__tests__/build-guard.test.ts against
 *                          these very functions, not a copy of them);
 *   - this file           — the I/O: run the probe, print, set the exit code.
 *
 * The probe is `server/src/db/content-status-cli.ts`, run through the server
 * package's own `tsx` in a child process. The client package has no mysql2
 * and no dotenv, and must not grow either: the server already owns the pool,
 * the Kong-database assertion and the env schema, and this must not become a
 * second copy of any of them. Nothing here is imported by the client bundle —
 * it is a build-time script, not application code.
 *
 * SECURITY: nothing printed here is derived from DATABASE_URL. The probe
 * reports a failure as a bare driver code and `guardInputs` re-sanitises it.
 */
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { evaluateGuard, guardInputs } from './build-guard.mjs';

const serverDir = resolve(dirname(fileURLToPath(import.meta.url)), '../../server');

/** Outer bound on the child process; the probe's own SELECT timeout is shorter. */
const SPAWN_TIMEOUT_MS = 20_000;

/**
 * Whatever the probe printed, or `null` if it could not be run at all.
 * `guardInputs` is responsible for treating anything unrecognised as
 * "unreachable" — this function only has to avoid throwing.
 */
function runProbe() {
  try {
    const requireFromServer = createRequire(resolve(serverDir, 'package.json'));
    const result = spawnSync(
      process.execPath,
      [requireFromServer.resolve('tsx/cli'), resolve(serverDir, 'src/db/content-status-cli.ts')],
      { cwd: serverDir, encoding: 'utf8', timeout: SPAWN_TIMEOUT_MS, windowsHide: true },
    );

    // The last JSON line wins: tsx and the mysql2 driver are both entitled to
    // print warnings around it.
    const line = (result.stdout ?? '')
      .split(/\r?\n/)
      .filter((candidate) => candidate.startsWith('{'))
      .pop();
    return line === undefined ? null : JSON.parse(line);
  } catch {
    return null;
  }
}

const result = evaluateGuard(guardInputs(runProbe(), process.env));

if (!result.ok) {
  console.error(`\n${result.message}\n`);
  process.exit(1);
}

console.log(`\n${result.message}\n`);
