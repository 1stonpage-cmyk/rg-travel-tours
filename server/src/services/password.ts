/**
 * Password hashing (Week 4 plan, Task 5).
 *
 * **Owner decision 2026-10-14, an approved change to BUILD_SPEC §2.** The
 * spec said "argon2/bcrypt"; neither was ever added to `package.json`, and
 * both are native modules that have to compile on the VPS. `scrypt` is in
 * Node core, is memory-hard, needs no dependency and nothing to build —
 * which on a host that has already surprised this project once (outbound
 * SMTP, see `docs/LAUNCH_CHECKLIST.md`) is worth more than the marginal
 * strength argon2id would add.
 *
 * OWASP's scrypt parameters, as specified: **N=2^17, r=8, p=1**, a 16-byte
 * random salt and a 64-byte derived key.
 *
 * ## The stored value is self-describing, and that is the point
 *
 *     scrypt$N=131072,r=8,p=1$<salt base64>$<key base64>
 *
 * The algorithm and its parameters travel with every hash, so
 * `verifyPassword` derives using the parameters THAT HASH was made with
 * rather than today's constants. Three things become possible that a bare
 * `salt:hash` format forecloses:
 *
 *  1. **N can be raised** — as hardware improves it should be — and every
 *     existing password still verifies.
 *  2. **A migration to argon2 is additive**: add a branch, hash new
 *     passwords with it, and old rows keep working.
 *  3. An unknown algorithm **refuses** rather than guessing, so a
 *     half-finished migration locks a user out (loud, recoverable) instead
 *     of accepting a password it cannot actually check.
 *
 * ## Why the rate limit on login is also a memory control
 *
 * Each verification allocates ~128MB and takes ~250ms. That is the point of
 * a memory-hard KDF — it is what makes offline cracking expensive — but it
 * also means an unlimited login endpoint is a memory exhaustion vector:
 * forty concurrent attempts is five gigabytes. The per-IP and per-email
 * limits in `staff-auth.ts` are therefore not only an anti-guessing
 * measure; they are what keeps this function from being a denial of
 * service. Raising N without revisiting them would be a mistake.
 *
 * Nothing here logs, throws with, or returns the password.
 */
import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCallback) as (
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>;

export interface ScryptCost {
  N: number;
  r: number;
  p: number;
}

/** OWASP's recommendation, and the owner's instruction. */
export const SCRYPT_PARAMS = {
  N: 2 ** 17,
  r: 8,
  p: 1,
  keyLength: 64,
  saltLength: 16,
} as const;

/**
 * scrypt needs roughly `128 * N * r` bytes — 128MB at these parameters —
 * and Node's default `maxmem` is 32MB, so it must be set explicitly or
 * every call throws. Doubled, because the limit is checked against an
 * internal estimate that is slightly larger than the formula.
 */
function maxmemFor(cost: ScryptCost): number {
  return 256 * cost.N * cost.r;
}

/** `N=131072,r=8,p=1` — the parameter field of the stored string. */
function encodeCost(cost: ScryptCost): string {
  return `N=${cost.N},r=${cost.r},p=${cost.p}`;
}

/**
 * Parses the parameter field, or `null` if it is not exactly the three
 * expected keys with positive integer values.
 *
 * Strict on purpose: a stored hash is an authentication input, and an
 * unparseable one must refuse rather than fall back to a default that might
 * happen to derive the same key.
 */
function decodeCost(field: string): ScryptCost | null {
  const match = /^N=(\d+),r=(\d+),p=(\d+)$/.exec(field);
  if (!match) return null;

  const [N, r, p] = [Number(match[1]), Number(match[2]), Number(match[3])];
  if (!Number.isSafeInteger(N) || !Number.isSafeInteger(r) || !Number.isSafeInteger(p)) return null;
  if (N < 2 || r < 1 || p < 1) return null;
  // N must be a power of two or scrypt itself rejects it; checking here
  // keeps a malformed row from becoming a thrown error inside a login.
  if ((N & (N - 1)) !== 0) return null;

  return { N, r, p };
}

/**
 * Hashes a password into the self-describing stored form.
 *
 * `cost` is overridable only so a test can use a cheap N — the production
 * path never passes it, and `SCRYPT_PARAMS` is what a real password is
 * hashed with.
 */
export async function hashPassword(
  plain: string,
  cost: ScryptCost = SCRYPT_PARAMS,
): Promise<string> {
  const salt = randomBytes(SCRYPT_PARAMS.saltLength);
  const key = await scrypt(plain, salt, SCRYPT_PARAMS.keyLength, {
    ...cost,
    maxmem: maxmemFor(cost),
  });

  return ['scrypt', encodeCost(cost), salt.toString('base64'), key.toString('base64')].join('$');
}

/**
 * Verifies a password against a stored hash. **Never throws** — every
 * failure, including a malformed or unknown-algorithm row, is `false`.
 *
 * A caller cannot distinguish "wrong password" from "unreadable hash", and
 * should not: both mean "this login does not succeed", and a login that
 * reported the difference would tell an attacker which accounts have
 * salvageable rows.
 */
export async function verifyPassword(plain: string, storedValue: string): Promise<boolean> {
  const parts = storedValue.split('$');
  if (parts.length !== 4) return false;

  const [algorithm, costField, saltB64, keyB64] = parts as [string, string, string, string];
  if (algorithm !== 'scrypt') return false;

  const cost = decodeCost(costField);
  if (!cost) return false;

  const salt = Buffer.from(saltB64, 'base64');
  const expected = Buffer.from(keyB64, 'base64');
  if (salt.length === 0 || expected.length === 0) return false;

  let derived: Buffer;
  try {
    derived = await scrypt(plain, salt, expected.length, { ...cost, maxmem: maxmemFor(cost) });
  } catch {
    // Parameters that parsed but that scrypt still refuses (an N large
    // enough to exceed maxmem, say). Refuse, never crash a login.
    return false;
  }

  /*
   * `timingSafeEqual` rather than `equals` or `===`: those short-circuit at
   * the first differing byte, so the time taken reveals how many leading
   * bytes of a guess were right. It throws on a length mismatch, which is
   * why the lengths are reconciled above by deriving to `expected.length`.
   */
  if (derived.length !== expected.length) return false;
  return timingSafeEqual(derived, expected);
}

/**
 * A fixed hash to verify against when the account does not exist.
 *
 * Built once, lazily, at the production parameters — so the no-user path
 * costs the same ~250ms as the real one. Without it, an unknown email
 * answers in a millisecond and a real one takes a quarter of a second,
 * which enumerates the staff list however identical the error message is.
 *
 * The password it hashes is irrelevant and never matches anything: the
 * point is the work, not the result.
 */
let dummyStored: Promise<string> | undefined;

export async function dummyVerify(plain: string): Promise<boolean> {
  dummyStored ??= hashPassword(randomBytes(32).toString('base64'));
  return verifyPassword(plain, await dummyStored);
}
