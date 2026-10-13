/**
 * Week 4 plan, Task 5: password hashing.
 *
 * Owner decision 2026-10-14: **`scrypt` from `node:crypto`**, an approved
 * change to BUILD_SPEC §2's "argon2/bcrypt" — no new dependency, nothing to
 * compile on the VPS, and a memory-hard KDF from Node core. OWASP's
 * parameters: N=2^17, r=8, p=1, a 16-byte random salt and a 64-byte key.
 *
 * The stored value is **self-describing**, which is the property that makes
 * this decision reversible: the algorithm and its parameters travel with
 * every hash, so N can be raised — or the whole thing migrated to argon2 —
 * without invalidating a single existing password. The tests below pin that
 * by verifying a hash whose parameters are deliberately NOT today's.
 *
 * Each hash costs ~250ms and ~128MB, so these tests hash as few times as
 * they can get away with and share the results.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { SCRYPT_PARAMS, dummyVerify, hashPassword, verifyPassword } from '../services/password';

const PASSWORD = 'correct horse battery staple';
let stored: string;

beforeAll(async () => {
  stored = await hashPassword(PASSWORD);
}, 30_000);

describe('hashPassword', () => {
  it('round-trips: the password it hashed verifies', async () => {
    expect(await verifyPassword(PASSWORD, stored)).toBe(true);
  });

  it('REFUSES the wrong password', async () => {
    expect(await verifyPassword('wrong horse battery staple', stored)).toBe(false);
    expect(await verifyPassword('', stored)).toBe(false);
    expect(await verifyPassword(`${PASSWORD} `, stored)).toBe(false);
  });

  /**
   * The stored string never contains the password, in any form. Obvious,
   * and worth a test anyway: it is the single worst bug this file could
   * have and it would be invisible in every other test, all of which would
   * still pass.
   */
  it('never embeds the password in the stored string', () => {
    expect(stored).not.toContain(PASSWORD);
    expect(stored.toLowerCase()).not.toContain('horse');
  });

  it('salts, so the same password hashes differently every time', async () => {
    const again = await hashPassword(PASSWORD);
    expect(again).not.toBe(stored);
    // ...and both still verify, which is what a salt must not break.
    expect(await verifyPassword(PASSWORD, again)).toBe(true);
  });

  /**
   * The self-describing format. Asserted as a shape rather than a literal
   * so the fields are named: anything that drops the parameters makes every
   * stored hash unverifiable the day they change.
   */
  it('stores the algorithm, the parameters, the salt and the key', () => {
    const [algorithm, params, salt, key] = stored.split('$');
    expect(algorithm).toBe('scrypt');
    expect(params).toBe(`N=${SCRYPT_PARAMS.N},r=${SCRYPT_PARAMS.r},p=${SCRYPT_PARAMS.p}`);
    // 16 raw bytes and 64 raw bytes, base64.
    expect(Buffer.from(salt!, 'base64')).toHaveLength(16);
    expect(Buffer.from(key!, 'base64')).toHaveLength(64);
  });

  it('uses the OWASP parameters the owner specified', () => {
    expect(SCRYPT_PARAMS).toEqual({ N: 131072, r: 8, p: 1, keyLength: 64, saltLength: 16 });
    expect(SCRYPT_PARAMS.N).toBe(2 ** 17);
  });
});

describe('verifyPassword', () => {
  /**
   * **The reason the format is self-describing.** This hash was made with
   * a deliberately cheap N, which is NOT today's parameter — and it must
   * still verify, because the parameters come from the stored string and
   * not from the current constant. If this fails, raising N in future
   * locks every existing user out of their account.
   */
  it('reads the parameters from the stored hash, not from the current constant', async () => {
    const cheap = await hashPassword('old-password', { N: 1024, r: 8, p: 1 });
    expect(cheap).toContain('N=1024');
    expect(await verifyPassword('old-password', cheap)).toBe(true);
    expect(await verifyPassword('not-it', cheap)).toBe(false);
  });

  it('REFUSES a tampered key', async () => {
    const [algorithm, params, salt] = stored.split('$');
    const forged = [algorithm, params, salt, randomBytes(64).toString('base64')].join('$');
    expect(await verifyPassword(PASSWORD, forged)).toBe(false);
  });

  it('REFUSES a tampered salt', async () => {
    const [algorithm, params, , key] = stored.split('$');
    const forged = [algorithm, params, randomBytes(16).toString('base64'), key].join('$');
    expect(await verifyPassword(PASSWORD, forged)).toBe(false);
  });

  /**
   * Fails CLOSED on anything it cannot parse. A malformed row — truncated
   * by an old column width, written by a seed script, half-migrated — must
   * refuse every password rather than throw (which a caller might catch and
   * treat as "no user") or, far worse, accept.
   */
  it('REFUSES a malformed stored value, without throwing', async () => {
    const malformed = [
      '',
      'not-a-hash',
      'scrypt$N=131072,r=8,p=1',
      'scrypt$N=131072,r=8,p=1$only-three-parts',
      'scrypt$$$',
      `scrypt$N=abc,r=8,p=1$${randomBytes(16).toString('base64')}$${randomBytes(64).toString('base64')}`,
      // A plausible bcrypt hash: the thing in the database if this ever
      // half-migrates. It must not verify and must not explode.
      '$2b$12$abcdefghijklmnopqrstuvwxyz012345678901234567890123456789',
    ];
    for (const value of malformed) {
      await expect(
        verifyPassword(PASSWORD, value),
        `${value.slice(0, 24)} did not refuse`,
      ).resolves.toBe(false);
    }
  });

  /**
   * An unknown algorithm refuses rather than guessing. This is what makes a
   * later migration safe: an argon2 hash in the column verifies `false`
   * here until an argon2 branch exists, which is a locked-out user — loud,
   * recoverable — rather than an accepted password.
   */
  it('REFUSES an algorithm it does not implement', async () => {
    const [, params, salt, key] = stored.split('$');
    expect(await verifyPassword(PASSWORD, ['argon2id', params, salt, key].join('$'))).toBe(false);
  });
});

describe('dummyVerify', () => {
  /**
   * The timing half of "no user enumeration". A login that skips hashing
   * when the email is unknown answers in a millisecond, while a real
   * account takes ~250ms — which tells an attacker which emails exist
   * however identical the error message is.
   *
   * Asserted as a RATIO against a real verify rather than an absolute
   * duration: an absolute bound would be flaky on a loaded CI box, and the
   * property that matters is comparability, not speed.
   */
  it('costs about the same as a real verification', async () => {
    const realStart = Date.now();
    await verifyPassword('wrong', stored);
    const real = Date.now() - realStart;

    const dummyStart = Date.now();
    await dummyVerify('wrong');
    const dummy = Date.now() - dummyStart;

    expect(dummy, 'the dummy verify was free — it is not doing the work').toBeGreaterThan(real / 4);
    expect(dummy).toBeLessThan(real * 4);
  });

  it('always answers false, whatever it is given', async () => {
    expect(await dummyVerify('anything')).toBe(false);
    expect(await dummyVerify('')).toBe(false);
  });
});

describe('the comparison itself', () => {
  /**
   * `timingSafeEqual` compares in constant time; `===` on a Buffer or a
   * string short-circuits at the first differing byte, which leaks how much
   * of a guess was right. This test does not inspect the implementation —
   * it pins the property the implementation must have, by showing that the
   * primitive is available and that the module's own verify accepts only an
   * exact match.
   */
  it('rejects keys that differ in a single byte', async () => {
    const [algorithm, params, salt, key] = stored.split('$');
    const bytes = Buffer.from(key!, 'base64');
    bytes[0] = bytes[0]! ^ 0x01;
    const offByOne = [algorithm, params, salt, bytes.toString('base64')].join('$');

    expect(await verifyPassword(PASSWORD, offByOne)).toBe(false);
    // The primitive the implementation is required to use.
    expect(() => timingSafeEqual(Buffer.alloc(4), Buffer.alloc(4))).not.toThrow();
  });
});
