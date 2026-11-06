/**
 * Task 1D — the boot-time reminder that `OWNER_PASSWORD` is a ONE-TIME
 * bootstrap credential.
 *
 * The decision is a pure function, so the truth table below needs no server,
 * no boot and no database. What this file adds beyond it are the wrapper's
 * database-shaped properties, tested against a `getDb` that fails — both ways
 * it can, synchronously and as a rejected query — because they are about
 * surviving a failure rather than producing a success: a hygiene warning that
 * can stop the server from starting is worse than no warning at all. The last
 * block pins the boot WIRING by reading `src/index.ts` as text, including the
 * one thing a `catch` cannot cover: that the call sits after `listen()`.
 *
 * The warning's live path — a real `users` table, a real query — is tested in
 * `owner-seed.test.ts`, which already owns the machinery for standing an
 * active owner up and putting the machine's ambient one aside.
 *
 * The create-only half of this requirement — that `seedFirstOwner` never
 * overwrites an existing owner's password hash when `OWNER_PASSWORD` is set
 * and an active owner already exists — is NOT duplicated here either. It is
 * already pinned by `owner-seed.test.ts`'s "does NOT overwrite an existing
 * owner on a second run", which seeds twice with two different passwords and
 * verifies the first one still matches.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `getDb` throws synchronously by default. Nothing in this file wants a real
 * connection: the wrapper's contract here is "survive this", and the decision
 * is pure.
 */
const dbMock = vi.hoisted(() => ({
  getDb: vi.fn<() => unknown>(() => {
    throw new Error('simulated database failure at boot');
  }),
}));
vi.mock('../db/client', () => dbMock);

import { env } from '../env';
import {
  UNUSED_OWNER_PASSWORD_WARNING,
  shouldWarnUnusedOwnerPassword,
  warnIfOwnerPasswordUnused,
} from '../db/owner-bootstrap';

/**
 * A query builder shaped like Drizzle's whose terminal `limit()` REJECTS
 * (review fix, Minor 1). The default mock above throws from `getDb()` itself,
 * so the query promise is never created — behaviourally the same under an
 * `await` inside a `try`, but it leaves the rejected-promise half asserted by
 * reasoning rather than by a test. This one creates it.
 */
interface RejectingQuery {
  select: () => RejectingQuery;
  from: () => RejectingQuery;
  where: () => RejectingQuery;
  limit: () => Promise<never>;
}
function rejectingDb(): RejectingQuery {
  const chain: RejectingQuery = {
    select: () => chain,
    from: () => chain,
    where: () => chain,
    limit: () => Promise.reject(new Error('simulated query rejection')),
  };
  return chain;
}

describe('the unused-OWNER_PASSWORD decision', () => {
  /**
   * All four combinations. The one that is easy to get wrong is the second:
   * a configured password with no owner yet is the LEGITIMATE bootstrap, and
   * telling that deployer to delete the variable would lock them out.
   */
  it('warns only when the password is set AND an owner already exists', () => {
    expect(shouldWarnUnusedOwnerPassword({ ownerPasswordSet: true, ownerExists: true })).toBe(true);
    expect(shouldWarnUnusedOwnerPassword({ ownerPasswordSet: true, ownerExists: false })).toBe(
      false,
    );
    expect(shouldWarnUnusedOwnerPassword({ ownerPasswordSet: false, ownerExists: true })).toBe(
      false,
    );
    expect(shouldWarnUnusedOwnerPassword({ ownerPasswordSet: false, ownerExists: false })).toBe(
      false,
    );
  });

  /** The wording is specified word for word, and a reader greps for it. */
  it('is worded exactly as the owner instruction specifies', () => {
    expect(UNUSED_OWNER_PASSWORD_WARNING).toBe(
      'OWNER_PASSWORD is set but unused — remove it from .env',
    );
  });
});

describe('the boot-time check', () => {
  const original = env.OWNER_PASSWORD;
  let warn: ReturnType<typeof vi.spyOn>;
  let debug: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    dbMock.getDb.mockClear();
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    debug = vi.spyOn(console, 'debug').mockImplementation(() => {});
  });

  afterEach(() => {
    (env as { OWNER_PASSWORD?: string }).OWNER_PASSWORD = original;
    warn.mockRestore();
    debug.mockRestore();
  });

  /**
   * FAILS OPEN, which is the point of the whole wrapper. The query throws;
   * boot must continue with nothing worse than a debug line, and certainly
   * no warning claiming an owner exists when nothing could be read.
   */
  it('never throws when the database query fails, and warns nothing', async () => {
    (env as { OWNER_PASSWORD?: string }).OWNER_PASSWORD = 'a-long-enough-owner-password';

    await expect(warnIfOwnerPasswordUnused()).resolves.toBeUndefined();

    expect(dbMock.getDb, 'the check never reached the database').toHaveBeenCalled();
    expect(warn, 'a check that could not read anything warned anyway').not.toHaveBeenCalled();
    expect(debug).toHaveBeenCalled();
  });

  /**
   * The same, one layer deeper: the builder exists and its terminal `limit()`
   * rejects. A `catch` around an `await` handles both, but only one of the two
   * was actually exercised before this (review fix, Minor 1).
   */
  it('never throws when the query itself rejects, and warns nothing', async () => {
    (env as { OWNER_PASSWORD?: string }).OWNER_PASSWORD = 'a-long-enough-owner-password';
    dbMock.getDb.mockImplementationOnce(() => rejectingDb());

    await expect(warnIfOwnerPasswordUnused()).resolves.toBeUndefined();

    expect(warn, 'a rejected query warned anyway').not.toHaveBeenCalled();
    expect(debug).toHaveBeenCalled();
  });

  /**
   * With no plaintext configured there is nothing to advise about, so the
   * check spends no query at boot — proved by the throwing mock never being
   * reached rather than by the absence of a log line.
   */
  it('asks the database nothing when OWNER_PASSWORD is unset', async () => {
    (env as { OWNER_PASSWORD?: string }).OWNER_PASSWORD = undefined;

    await expect(warnIfOwnerPasswordUnused()).resolves.toBeUndefined();

    expect(dbMock.getDb, 'it queried with no password configured').not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    expect(debug).not.toHaveBeenCalled();
  });
});

/**
 * The boot wiring, pinned as SOURCE TEXT (review fix, I2).
 *
 * No test may import `src/index.ts` — it boots a server and starts the cron —
 * so the one line that is this whole task's deliverable had nothing holding
 * it: a tidy-up of that file could delete the call and the suite would stay
 * green. Reading the real source is the project's existing answer to that
 * (`client/src/__tests__/contrast.test.ts` and `no-red.test.ts` read real
 * source rather than a fixture; `check:coming-soon` and `check:contact` are
 * standalone source guards).
 *
 * Comments are stripped first, so prose that happens to mention the call —
 * and there is some, right above it — can neither satisfy nor break these.
 */
const indexCode = readFileSync(join(process.cwd(), 'src/index.ts'), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/\/\/.*$/gm, '');

describe('the boot wiring in src/index.ts', () => {
  it('calls warnIfOwnerPasswordUnused() exactly once, and never awaits it', () => {
    expect(
      indexCode.match(/warnIfOwnerPasswordUnused\(\)/g) ?? [],
      'the boot-time check is not called from src/index.ts (or is called twice)',
    ).toHaveLength(1);
    // `void`, deliberately: the function cannot reject, so there is nothing
    // to await — and awaiting it is what made it able to delay the boot.
    expect(indexCode).toMatch(/void\s+warnIfOwnerPasswordUnused\(\);/);
    expect(indexCode, 'awaiting it can delay the listener').not.toMatch(
      /await\s+warnIfOwnerPasswordUnused/,
    );
  });

  /**
   * The ORDER is the fix, not a style point. Awaited — or even just placed —
   * ahead of `listen()`, a query that never answers (a metadata lock on
   * `users` during a deploy; the pool has no query timeout) leaves the port
   * unanswered with the process reporting healthy. After `listen()`, the
   * worst that same stall does is never print a reminder.
   */
  it('makes that call AFTER listen(), so a stalled query cannot delay the listener', () => {
    const listenAt = indexCode.indexOf('.listen(');
    const callAt = indexCode.indexOf('warnIfOwnerPasswordUnused()');

    expect(listenAt, 'src/index.ts no longer calls .listen()').toBeGreaterThan(-1);
    expect(callAt, 'the boot-time check is not called at all').toBeGreaterThan(-1);
    expect(callAt, 'the hygiene check runs before the listener is up').toBeGreaterThan(listenAt);
  });
});
