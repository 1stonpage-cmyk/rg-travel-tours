import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { isDuplicateKeyError } from '../db/duplicate-key';

/**
 * `isDuplicateKeyError` arbitrates unique indexes: the webhook idempotency
 * gate, the check-in double-tap, the booking-ref retry, the newsletter
 * signup. A catch that stops matching does not throw, it falls through to
 * the generic error path (a 500, or a double payment).
 */

const dup = () => Object.assign(new Error('Duplicate entry'), { code: 'ER_DUP_ENTRY' });
const wrap = (cause: unknown) => Object.assign(new Error('Failed query'), { cause });

describe('isDuplicateKeyError — error shapes', () => {
  it('recognises a bare mysql2 error', () => {
    expect(isDuplicateKeyError(dup())).toBe(true);
  });

  it('recognises one wrapped one level deep (Drizzle: DrizzleQueryError.cause)', () => {
    expect(isDuplicateKeyError(wrap(dup()))).toBe(true);
  });

  it('recognises one wrapped two levels deep', () => {
    expect(isDuplicateKeyError(wrap(wrap(dup())))).toBe(true);
  });

  it('answers false for a null cause', () => {
    expect(isDuplicateKeyError(wrap(null))).toBe(false);
  });

  it('terminates on a cause cycle and answers false', () => {
    const a: Error & { cause?: unknown } = new Error('a');
    const b: Error & { cause?: unknown } = new Error('b');
    a.cause = b;
    b.cause = a;
    expect(isDuplicateKeyError(a)).toBe(false);
  });

  it('still finds the code on a cycle that contains it', () => {
    const a: Error & { cause?: unknown } = new Error('a');
    const b = dup() as Error & { cause?: unknown };
    a.cause = b;
    b.cause = a;
    expect(isDuplicateKeyError(a)).toBe(true);
  });

  it('answers false for a non-object, even one that spells the code', () => {
    expect(isDuplicateKeyError('ER_DUP_ENTRY')).toBe(false);
    expect(isDuplicateKeyError(1062)).toBe(false);
  });

  it('answers false for undefined and null', () => {
    expect(isDuplicateKeyError(undefined)).toBe(false);
    expect(isDuplicateKeyError(null)).toBe(false);
  });

  it('answers false for a different MySQL code', () => {
    const other = Object.assign(new Error('deadlock'), { code: 'ER_LOCK_DEADLOCK' });
    expect(isDuplicateKeyError(other)).toBe(false);
    expect(isDuplicateKeyError(wrap(other))).toBe(false);
  });

  it('walks a bounded chain: the fifth link is read, the sixth is not', () => {
    let chain: unknown = dup();
    for (let i = 0; i < 4; i += 1) chain = wrap(chain);
    expect(isDuplicateKeyError(chain)).toBe(true);
    expect(isDuplicateKeyError(wrap(chain))).toBe(false);
  });
});

/** Files under `dir` (recursive), repo-relative with forward slashes, tests excluded. */
function sourceFiles(dir: string, repoRoot: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name === '__tests__' || name === 'node_modules') continue;
      out.push(...sourceFiles(full, repoRoot));
    } else if (name.endsWith('.ts') && !name.endsWith('.test.ts')) {
      out.push(relative(repoRoot, full).split(sep).join('/'));
    }
  }
  return out;
}

describe('the duplicate-key predicate has one implementation', () => {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
  const files = sourceFiles(join(repoRoot, 'server/src'), repoRoot);
  const HOME = 'server/src/db/duplicate-key.ts';

  /** Files whose source matches `re`. Comments are not stripped: none may imitate the code. */
  const matching = (re: RegExp) =>
    files.filter((f) => re.test(readFileSync(join(repoRoot, f), 'utf8'))).sort();

  it('scans the real source tree', () => {
    expect(files).toContain(HOME);
    expect(files.length).toBeGreaterThan(50);
  });

  it('compares an error code to ER_DUP_ENTRY in exactly one file', () => {
    // A fourth copy is how one of them stops recognising a duplicate without
    // anybody noticing: that catch does not throw, it falls through to a 500
    // on a path whose whole design is "insert and catch".
    expect(matching(/code\s*={2,3}\s*['"`]ER_DUP_ENTRY['"`]/)).toEqual([HOME]);
  });

  it('defines a duplicate-key predicate in exactly one file', () => {
    // Under whatever name: the old private copies were `isDuplicateEntryError`.
    expect(matching(/(?:function|const)\s+isDuplicate\w*\s*[=(]/)).toEqual([HOME]);
  });
});
