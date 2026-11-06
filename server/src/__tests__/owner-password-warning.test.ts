/**
 * Task 1D — the boot-time reminder that `OWNER_PASSWORD` is a ONE-TIME
 * bootstrap credential.
 *
 * The decision is a pure function, so the truth table below needs no server,
 * no boot and no database. What this file adds beyond it are the wrapper's
 * two database-shaped properties, both tested against a `getDb` that THROWS,
 * because they are about surviving a failure rather than producing a success:
 * a hygiene warning that can stop the server from starting is worse than no
 * warning at all.
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
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `getDb` throws, every time. Nothing in this file wants a real connection:
 * the wrapper's contract here is "survive this", and the decision is pure.
 */
const dbMock = vi.hoisted(() => ({
  getDb: vi.fn((): never => {
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
