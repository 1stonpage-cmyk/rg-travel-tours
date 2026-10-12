/**
 * Task 18 of the core-schema plan: the convention guards.
 *
 * These read the **real source**, not a fixture list — the pattern set by
 * `client/src/__tests__/no-red.test.ts` and `contrast.test.ts`. A guard that
 * reads a list of known tables stops guarding the moment someone adds a
 * table and forgets the list; a guard that reads `schema.ts` and the server
 * tree cannot be out of date.
 *
 * Four conventions, all from CLAUDE.md § Conventions:
 *
 *  1. Money is integer centavos — no `decimal`, `float` or `double` column.
 *  2. Time columns are `datetime`, never `timestamp`. MySQL converts a
 *     `timestamp` to UTC on write and back to the *session* time zone on
 *     read, so the same row reads differently from two connections. This
 *     project stores UTC and computes business dates in Asia/Manila, in JS.
 *  3. Every money column is named `*_centavos`, so a bare `price` can never
 *     be read as pesos by mistake. Four legacy columns predate the rule and
 *     are exempted explicitly below — see LEGACY_UNSUFFIXED.
 *  4. Nothing hard-deletes a booking or a payment.
 *
 * **The vacuity trap.** A scan that stops matching — a renamed file, a
 * tightened regex, a moved directory — passes on an empty array and reports
 * green forever. Five bugs on this project were tests of exactly that shape
 * (docs/BUGS_LOG.md). So every scan here asserts twice: that it found the
 * material it is supposed to be reading, and that its own pattern still
 * matches a known-bad sample (`expectPatternIsLive`). Only then does it
 * assert the source is clean.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const serverRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const schemaPath = join(serverRoot, 'src/db/schema.ts');
const sourceRoot = join(serverRoot, 'src');

/**
 * Blank out comment spans before matching, so prose *about* a rule does not
 * trip the rule. `schema.ts` documents these conventions in its own JSDoc —
 * "never DECIMAL/float", "a `decimal` or a float is forbidden", "a check-in
 * timestamp is evidence that a trip ran" — and all three would be offences
 * if the guards matched comments. Lifted from `no-red.test.ts`, which solved
 * the same problem for the word "red": block comments are blanked
 * character-by-character so line numbers stay stable, and `//` only starts a
 * line comment when it is not preceded by `:` (so `https://` survives).
 */
function stripComments(text: string): string {
  const withoutBlockComments = text.replace(/\/\*[\s\S]*?\*\//g, (match) =>
    match.replace(/[^\n]/g, ' '),
  );
  return withoutBlockComments.replace(/(^|[^:])\/\/.*$/gm, (_match, prefix: string) => prefix);
}

function collectTsFiles(target: string): string[] {
  const stats = statSync(target, { throwIfNoEntry: false });
  if (!stats) return [];
  if (stats.isFile()) return extname(target) === '.ts' ? [target] : [];
  return readdirSync(target).flatMap((entry) => {
    if (entry === 'node_modules' || entry === 'dist') return [];
    return collectTsFiles(join(target, entry));
  });
}

const rel = (file: string) => relative(serverRoot, file).replace(/\\/g, '/');

/** This file names every forbidden pattern as a sample, so it exempts itself. */
const SELF = 'src/__tests__/schema-conventions.test.ts';

const allServerFiles = collectTsFiles(sourceRoot)
  .map(rel)
  .filter((f) => f !== SELF);
/** Application source: what actually runs in production. */
const appFiles = allServerFiles.filter((f) => !f.includes('__tests__'));

const readStripped = (file: string) => stripComments(readFileSync(join(serverRoot, file), 'utf8'));

const SCHEMA = readStripped('src/db/schema.ts');

/**
 * The second half of the vacuity guard: prove the pattern itself still
 * matches something it must catch. A regex that silently stops matching
 * (a typo, an escaped character, a Drizzle API change) would otherwise make
 * `not.toMatch` pass forever.
 */
function expectPatternIsLive(re: RegExp, knownBad: string, label: string): void {
  expect(re.test(knownBad), `the ${label} pattern no longer matches a known violation`).toBe(true);
}

describe('schema conventions, read from the real source', () => {
  it('is reading the schema that defines the tables', () => {
    expect(schemaPath.endsWith('schema.ts')).toBe(true);
    expect(SCHEMA.length).toBeGreaterThan(10_000);
    // 29 tables as of task 16b. Asserted as a floor, not an equality, so
    // adding a table does not fail this — but losing the file, reading the
    // wrong path, or stripping the whole file to comments does.
    expect([...SCHEMA.matchAll(/mysqlTable\(/g)].length).toBeGreaterThanOrEqual(29);
  });

  it('declares no decimal, float or double column — money is int centavos', () => {
    // No `\s*\(` requirement: an imported-but-unused `decimal` is already
    // the start of the mistake, and `decimal()` with no args would slip past
    // a paren-anchored pattern.
    const re = /\b(?:decimal|float|double)\b/;
    expectPatternIsLive(
      re,
      "amount: decimal('amount', { precision: 10, scale: 2 })",
      'decimal/float/double',
    );
    // Money exists to be scanned: every money column in this schema is an
    // `int`, so there must be plenty of them.
    expect([...SCHEMA.matchAll(/\bint\('/g)].length).toBeGreaterThan(50);
    expect(SCHEMA).not.toMatch(re);
  });

  it('declares every time column as datetime, never timestamp', () => {
    const re = /\btimestamp\b/;
    expectPatternIsLive(re, "createdAt: timestamp('created_at')", 'timestamp');
    // 45 datetime columns as of task 16b. Without this floor, a schema with
    // no time columns at all would pass the assertion below vacuously.
    expect([...SCHEMA.matchAll(/\bdatetime\('/g)].length).toBeGreaterThan(40);
    expect(SCHEMA).not.toMatch(re);
  });

  it('names every money column *_centavos', () => {
    const re = /int\('([a-z_]*(?:price|amount|total|subtotal|discount|spend)[a-z_]*)'\)/g;
    expectPatternIsLive(new RegExp(re.source), "total: int('total')", 'money column');

    // `m[1]!`: the pattern has exactly one capture group and only matches
    // when it participates, so the group is always present. TypeScript
    // types `matchAll` groups as optional regardless.
    const money = [...SCHEMA.matchAll(re)].map((m) => m[1]!);
    // The plan's vacuity guard: without it, a regex that stops matching
    // makes the assertion below pass on an empty array. 12 today.
    expect(money.length).toBeGreaterThan(5);

    /**
     * Four money columns predate this convention. They ARE centavos — the
     * seed stores `newPrice: 980_000` for ₱9,800 and the API renames them
     * to `newPriceCentavos` on the way out — but the DB column names lack
     * the suffix. Renaming them needs a migration plus a seed, router and
     * client sweep, which task 18 (a test-only task) must not do. Logged as
     * BUG-106; the owner decides.
     *
     * This is an exemption, not a loophole: the exhaustiveness assertion
     * below fails if one of these is renamed or dropped, so the list cannot
     * rot, and any NEW unsuffixed money column still goes red.
     */
    const LEGACY_UNSUFFIXED = [
      'price_per_person', // tour_price_tiers
      'price', // tour_addons
      'old_price', // packages
      'new_price', // packages
    ];
    expect(
      LEGACY_UNSUFFIXED.filter((name) => !money.includes(name)),
      'a legacy exemption no longer exists in schema.ts — delete it from LEGACY_UNSUFFIXED',
    ).toEqual([]);

    const offenders = money.filter(
      (name) => !name.endsWith('_centavos') && !LEGACY_UNSUFFIXED.includes(name),
    );
    expect(
      offenders,
      `money columns must be named *_centavos (CLAUDE.md): ${offenders.join(', ')}`,
    ).toEqual([]);
  });

  it('never hard-deletes a booking or a payment anywhere in the server source', () => {
    // Drizzle form, scanned across the whole server tree.
    const drizzleDelete = /\.delete\(\s*(?:schema\.)?(?:bookings|payments)\s*\)/;
    expectPatternIsLive(drizzleDelete, 'await db.delete(bookings)', 'Drizzle hard-delete');
    expect(allServerFiles.length).toBeGreaterThan(50);

    const drizzleOffenders = allServerFiles.filter((f) => drizzleDelete.test(readStripped(f)));
    expect(drizzleOffenders, 'bookings and payments are never hard-deleted (CLAUDE.md)').toEqual(
      [],
    );

    /**
     * Raw-SQL form — beyond what the plan asked for, because `.delete()` is
     * not the only way to lose a row. Scoped to application source: test
     * fixtures legitimately delete their own rows this way
     * (`record-payment.test.ts`), which is cleanup in `rg_travel_test`, not
     * shipped behaviour.
     */
    const rawDelete = /delete\s+from\s+`?(?:bookings|payments)`?\b/i;
    expectPatternIsLive(rawDelete, 'DELETE FROM payments WHERE id = ?', 'raw SQL hard-delete');
    expect(appFiles.length).toBeGreaterThan(30);

    const rawOffenders = appFiles.filter((f) => rawDelete.test(readStripped(f)));
    expect(
      rawOffenders,
      'bookings and payments are never hard-deleted, in SQL either (CLAUDE.md)',
    ).toEqual([]);
  });
});
