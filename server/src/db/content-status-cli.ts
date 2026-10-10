/**
 * One-shot CLI for the production build guard: prints `probePayload()` as a
 * single JSON line and exits 0, always. See `./content-status.ts` for why the
 * guard shells out to this instead of importing it.
 *
 * Run as `node <tsx-cli> src/db/content-status-cli.ts` from the server
 * package directory (that cwd is what `../env` resolves the repo-root `.env`
 * against). Exit code is always 0 — an unreachable database is a result, not
 * a crash; the guard decides what it means.
 */
import { closeDb } from './client';
import { probePayload } from './content-status';

process.stdout.write(`${JSON.stringify(await probePayload())}\n`);

// Best effort: the pool may never have opened, and a connect attempt that
// timed out can keep it from closing cleanly. The result is already out, so
// exit rather than let a half-open socket hold a build hostage.
await closeDb().catch(() => undefined);
process.exit(0);
