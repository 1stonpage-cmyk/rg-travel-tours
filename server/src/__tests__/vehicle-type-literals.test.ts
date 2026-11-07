/**
 * The 1B grep guard design note §2's closing paragraph calls for: no
 * `'van'`/`'suv'` STRING LITERAL left in the transfer/dispatch/tour-capacity
 * LOGIC, now that vehicle types are an admin-managed runtime list rather than
 * a compile-time two-member union (owner decision 2026-11-08 — see
 * `docs/superpowers/plans/2026-11-08-flexible-routes.md`, §2's closing
 * paragraph).
 *
 * **Scoped, not a bare repo-wide grep** (§2's own instruction, verbatim):
 * `server/src/services/transfers/**`, `server/src/services/dispatch/**`, and
 * `server/src/services/capacity.ts`. Three places legitimately still contain
 * those strings and are out of scope FOR THIS GUARD by construction (none of
 * them is under the scanned paths, so there is nothing to exclude by name —
 * named here anyway, per §2's instruction that the scope be stated in the
 * test itself):
 *
 *  - the migration files (`src/db/migrations/**`) — the data backfill joins
 *    on `slug = 'van'`-shaped literals, a natural-key lookup, not logic.
 *  - `src/db/seed-data.ts` — the two slugs are real natural keys for the
 *    seeded rows, not magic strings standing in for a type.
 *  - `shared/src/booking.ts` — the snapshot back-compat reader (§1.8's legacy
 *    `vehicleType` field and its title-casing fallback) must keep
 *    recognizing the literal strings FOREVER, to render a booking frozen
 *    before this migration. That is the one place a `'van'`/`'suv'` literal
 *    is the correct, permanent answer.
 *
 * **Reads the real source** (the `no-red.test.ts` / `schema-conventions
 * .test.ts` pattern), not a fixture list — a scan of a hand-maintained file
 * list stops guarding the moment someone adds a file and forgets it; a scan
 * of the directory tree cannot be out of date. Comments are blanked first so
 * prose ABOUT the old enum (this file's own header, `capacity.ts`'s module
 * note, and others like it) cannot trip the guard — only a quoted string
 * literal in live code can.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const serverRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

/** Mirrors `schema-conventions.test.ts`'s comment blanker exactly. */
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

/**
 * The declared scope, verbatim from the design note: two directories and one
 * single file. Not the migrations folder, not `seed-data.ts`, not
 * `shared/src/booking.ts` — none of the three is reachable from here, which
 * is what "scoped" means; they are documented above rather than coded as an
 * exclusion list, because there is nothing to exclude from a scan that never
 * visits them.
 */
const SCOPE_ROOTS = ['src/services/transfers', 'src/services/dispatch', 'src/services/capacity.ts'];

const scannedFiles = SCOPE_ROOTS.flatMap((root) => collectTsFiles(join(serverRoot, root))).map(rel);

const readStripped = (file: string) => stripComments(readFileSync(join(serverRoot, file), 'utf8'));

/**
 * A quoted `van` or `suv`, single- or double-quoted, with the SAME quote on
 * both sides (`/(['"])(?:van|suv)\1/`-shaped) — a string literal, never a
 * backticked word in prose (this file's own header uses backticks for
 * exactly that reason) and never a longer identifier that merely contains
 * the letters (`vanOnly`, `suvPriceCentavos`), because the quote characters
 * anchor it to a STANDALONE literal.
 */
const VEHICLE_TYPE_LITERAL = /(['"])(van|suv)\1/;

describe('no van/suv string literals left in transfer/dispatch/tour-capacity logic', () => {
  it('is scanning real files, in the declared scope, not an empty or stale list', () => {
    // Vacuity guard, both halves: the scope resolved to real files, and it is
    // at least as big as it is today (floor, not equality, so a new file in
    // scope is swept in automatically rather than silently skipped).
    expect(scannedFiles.length).toBeGreaterThanOrEqual(10);
    expect(scannedFiles).toContain('src/services/capacity.ts');
    expect(scannedFiles).toContain('src/services/transfers/capacity.ts');
    expect(scannedFiles).toContain('src/services/dispatch/availability.ts');
    expect(scannedFiles).toContain('src/services/dispatch/assign.ts');
  });

  it('is proven live against a known-bad sample, including both quote styles', () => {
    expect(VEHICLE_TYPE_LITERAL.test("const vehicleType = 'van';")).toBe(true);
    expect(VEHICLE_TYPE_LITERAL.test('const vehicleType = "suv";')).toBe(true);
    // Not a false positive on a longer identifier or backticked prose.
    expect(VEHICLE_TYPE_LITERAL.test('const vanOnly = true;')).toBe(false);
    expect(VEHICLE_TYPE_LITERAL.test('const suvPriceCentavos = 1;')).toBe(false);
    expect(VEHICLE_TYPE_LITERAL.test('// the old `van`/`suv` enum')).toBe(false);
  });

  it('finds none, anywhere in the declared scope', () => {
    const offenders = scannedFiles.filter((f) => VEHICLE_TYPE_LITERAL.test(readStripped(f)));
    expect(
      offenders,
      "no 'van'/'suv' string literal may remain in transfer/dispatch/tour-capacity logic " +
        '(owner decision 2026-11-08, design note §2) — vehicle types are an admin-managed ' +
        `runtime list, identified by id, not a compile-time union: ${offenders.join(', ')}`,
    ).toEqual([]);
  });
});
