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
 *     be read as pesos by mistake. Four legacy columns used to be exempted
 *     here (BUG-106); cleanup A3 renamed them, so the rule now holds with no
 *     exemptions at all and this guard carries no allow-list to rot.
 *  4. Nothing hard-deletes a booking or a payment.
 *  5. Nothing writes `bookings.amount_paid_centavos` except two named
 *     functions in the payments service (A5b, made function-scoped in M1).
 *     That column IS the money the business believes it has received, and
 *     the whole "only a verified webhook or an admin approval marks a
 *     booking paid" rule is only as strong as the number of places that can
 *     move it.
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
import ts from 'typescript';
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

/** What `findCreditWrites` reports for one write to `amount_paid_centavos`. */
interface CreditWrite {
  /** The enclosing TOP-LEVEL declaration's name; `null` when it has none. */
  owner: string | null;
  line: number;
}

/** What a source file declares at top level, and where it moves the column. */
interface CreditWriteScan {
  declared: Set<string>;
  writes: CreditWrite[];
}

const RAW_CREDIT_WRITE = /\bamount_paid_centavos\s*=/i;
const DRIZZLE_CREDIT_KEY = 'amountPaidCentavos';

/** The text of a property name, when it is spelled as a literal. */
function propertyNameText(name: ts.PropertyName): string | undefined {
  if (ts.isIdentifier(name) || ts.isStringLiteralLike(name)) return name.text;
  if (ts.isComputedPropertyName(name) && ts.isStringLiteralLike(name.expression)) {
    return name.expression.text;
  }
  return undefined;
}

/**
 * The name of the top-level declaration that `node` sits inside, or `null`
 * when there is none: module-level code, an expression statement, an
 * anonymous `export default function () {}`. `null` is never on an
 * allow-list, so every unnameable position fails closed.
 */
function enclosingTopLevelName(node: ts.Node, file: ts.SourceFile): string | null {
  let top: ts.Node = node;
  while (top.parent && top.parent !== file) top = top.parent;
  if (top.parent !== file) return null;
  if (ts.isVariableStatement(top)) {
    const declaration = top.declarationList.declarations.find(
      (d) => d.pos <= node.pos && node.end <= d.end,
    );
    return declaration && ts.isIdentifier(declaration.name) ? declaration.name.text : null;
  }
  if (ts.isFunctionDeclaration(top) || ts.isClassDeclaration(top)) return top.name?.text ?? null;
  return null;
}

/**
 * Finds every place `source` moves `bookings.amount_paid_centavos`, by
 * parsing it. The unit is the top-level declaration. Runs over the ORIGINAL
 * text, never the comment-stripped copy: stripping blanks characters in
 * place, but a parser should see the file the compiler sees.
 *
 * Two write shapes, the same two the regex half of this guard knows:
 *
 *  - the Drizzle object key `amountPaidCentavos: ...` (or the shorthand
 *    `{ amountPaidCentavos }`) in an object literal, i.e. `.set({...})` /
 *    `.values({...})`. A TYPE annotation is a different syntax node
 *    (`PropertySignature`, `PropertyDeclaration`, `Parameter`) and is simply
 *    not visited, and the `schema.ts` column declaration is excluded by
 *    shape (`int(...)`), as the regex does.
 *  - the raw-SQL fragment `amount_paid_centavos =` inside any string or
 *    template literal. Comments are not literals, so prose cannot trip it.
 */
function findCreditWrites(source: string, fileName = 'sample.ts'): CreditWriteScan {
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true);
  const declared = new Set<string>();
  const writes: CreditWrite[] = [];

  for (const statement of file.statements) {
    if (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) {
      if (statement.name) declared.add(statement.name.text);
    } else if (ts.isVariableStatement(statement)) {
      for (const d of statement.declarationList.declarations) {
        if (ts.isIdentifier(d.name)) declared.add(d.name.text);
      }
    }
  }

  const record = (node: ts.Node) => {
    writes.push({
      owner: enclosingTopLevelName(node, file),
      line: file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1,
    });
  };

  const visit = (node: ts.Node): void => {
    if (ts.isPropertyAssignment(node) && propertyNameText(node.name) === DRIZZLE_CREDIT_KEY) {
      const init = node.initializer;
      const isColumnDeclaration =
        ts.isCallExpression(init) &&
        ts.isIdentifier(init.expression) &&
        init.expression.text === 'int';
      if (!isColumnDeclaration) record(node);
    } else if (ts.isShorthandPropertyAssignment(node) && node.name.text === DRIZZLE_CREDIT_KEY) {
      record(node);
    } else if (
      (ts.isStringLiteralLike(node) ||
        ts.isTemplateHead(node) ||
        ts.isTemplateMiddle(node) ||
        ts.isTemplateTail(node)) &&
      RAW_CREDIT_WRITE.test(node.text)
    ) {
      record(node);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);

  return { declared, writes };
}

/**
 * The only top-level functions in `record-payment.ts` that may move
 * `bookings.amount_paid_centavos`, each with the reason it may. Adding an
 * entry is the legitimate way to add a third crediting function — in the
 * same commit as the function, so a reviewer sees this diff.
 */
const CREDITING_FUNCTIONS: Record<string, string> = {
  // The webhook / admin-recorded path: the single place a verified PayMongo
  // payment or an admin-entered payment becomes money the business holds.
  recordPayment: 'credits a booking for a verified webhook or an admin-recorded payment',
  // The single credit path for manual evidence. `verifyCashPayment` and
  // `approveManualReceipt` both delegate to it, so a driver's cash claim or a
  // guest's receipt is credited here, once, after an owner or finance
  // approval, under the booking row lock — and nowhere else.
  verifyPendingManualPayment:
    'credits a booking when owner/finance approve a pending cash claim or receipt',
};

/** Writes whose enclosing top-level declaration is not on `allowed`. */
function unauthorisedCreditWrites(scan: CreditWriteScan, allowed: readonly string[]): string[] {
  return scan.writes
    .filter((w) => w.owner === null || !allowed.includes(w.owner))
    .map((w) => `${w.owner ?? '<no named top-level declaration>'} (line ${w.line})`);
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
     * NO EXEMPTIONS. `LEGACY_UNSUFFIXED` used to sit here holding
     * `price_per_person`, `price`, `old_price` and `new_price` — four columns
     * that predated the convention (BUG-106). Cleanup A3 renamed all four
     * (migration 0008), so the list is gone rather than empty: an empty
     * allow-list is an invitation to add to it, and its own exhaustiveness
     * assertion would have been vacuous.
     */
    const offenders = money.filter((name) => !name.endsWith('_centavos'));
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

  /**
   * A5b. `bookings.amount_paid_centavos` is the one number that says how
   * much money the business believes it has received, and CLAUDE.md's rule —
   * "only a verified PayMongo webhook or an admin approval" marks a booking
   * paid — is enforced by `recordPayment()` and its A5b sibling
   * `verifyCashPayment()`, both in `record-payment.ts`. That enforcement is
   * worth exactly as much as the number of places that can move the column.
   *
   * A5b is why this guard exists now. Driver-collected cash needed a second
   * way into that column, and the tempting shortcut was a `status` parameter
   * on `recordPayment()` or a quiet `UPDATE bookings SET amount_paid...` in
   * a driver service. Either would have been invisible in review a month
   * later. So the rule is written down where it cannot rot.
   *
   * **The unit is the top-level function (M1).** Until M1 the unit was the
   * file, and the docblock admitted it: a new function in `record-payment.ts`
   * could write the column with this guard green (measured twice in Week
   * 6.5, Task 2). Now the guard PARSES `record-payment.ts` with the
   * TypeScript compiler, finds the top-level declaration enclosing every
   * write, and requires its name to be on `CREDITING_FUNCTIONS` below. Two
   * functions are on it, and nothing else in that file may move the column —
   * `recordPendingCash`, `rejectCashPayment`, `verifyCashPayment` and
   * `approveManualReceipt` included. A write at module top level, or inside
   * a declaration with no name (an anonymous default export), has no name to
   * be on the list and fails closed. Every OTHER file may not write the
   * column at all, exactly as before.
   *
   * To legitimately add a third crediting function: put its name on
   * `CREDITING_FUNCTIONS` in the SAME commit as the function, with a
   * comment saying why it may credit a booking. The reviewer sees the
   * allow-list diff; that is the review this guard exists to force. And the
   * list cannot rot: every entry must still exist and still contain a write,
   * so renaming or emptying one fails here instead of leaving a stale
   * permission behind.
   *
   * What the parser sees is an object key `amountPaidCentavos:` (or its
   * shorthand) and the raw-SQL fragment `amount_paid_centavos =` in a string
   * or template literal. It does not see a write built by indirection (a
   * key assembled at runtime, a helper that takes the column name) — which
   * the old regex could not see either; review is still what covers that.
   */
  it('writes amount_paid_centavos from two named functions only — recordPayment() and the manual-verification path', () => {
    /**
     * What this regex actually matches: ANY `amountPaidCentavos:` in the
     * server tree, not specifically Drizzle's write form
     * (`.set({ amountPaidCentavos: ... })` / `.values({ amountPaidCentavos: ... })`)
     * — an earlier revision of this comment claimed the narrower anchor, but
     * the pattern below has none. A `.select()` alias or a plain
     * response-object key spelled `amountPaidCentavos:` trips it exactly
     * like a real write would (Task 9's `bookingStatus` field and Task 10's
     * `bookingLookup` field both had to pick a different wire name for
     * exactly this reason — see `routers/public/checkout.ts`).
     *
     * This is deliberate, not a bug to fix: anchoring to `.set(`/`.values(`
     * would require matching across lines, and a naive anchor could
     * UNDER-match some real write shape nobody has written yet. For a
     * payment-integrity guard the costs of the two kinds of mistake are not
     * symmetric — a false positive here costs a cosmetic rename on a read;
     * a false negative costs a money bug nobody sees — so the net stays
     * this wide on purpose, and renaming a wire field is the expected
     * accommodation when a read trips it, not a workaround.
     *
     * Two things are excluded, and both are the colon meaning something
     * other than "assign this value":
     *
     *  - a TYPE annotation (`amountPaidCentavos: number`) in an interface, a
     *    class field or a constructor parameter. `RefundExceedsPaidError`
     *    legitimately carries the paid amount as a readonly field, and
     *    reporting an error class as a writer of the column would train
     *    readers to ignore this guard.
     *  - the column DECLARATION in `schema.ts` (`amountPaidCentavos:
     *    int('amount_paid_centavos')`). Defining the column is not moving
     *    it. Excluded by shape rather than by exempting the file, so a
     *    second declaration is still fine and a real write smuggled INTO
     *    `schema.ts` is still caught.
     *
     * `\s*` lives inside the lookahead, not before it. Outside, it
     * backtracks to zero characters when the lookahead fails and the
     * exclusion stops working — which is exactly what this guard did on its
     * first run, reporting `errors.ts` and `schema.ts` as writers.
     */
    const drizzleWrite = /\bamountPaidCentavos\s*:(?!\s*(?:number|string|bigint)\b|\s*int\()/;
    expectPatternIsLive(
      drizzleWrite,
      'set({ amountPaidCentavos: booking.amountPaidCentavos + 100 })',
      'amount_paid_centavos Drizzle write',
    );
    // And the raw-SQL form, for the same reason the hard-delete guard above
    // scans for one: `.set()` is not the only way to move a column.
    const rawWrite = /\bamount_paid_centavos\s*=/i;
    expectPatternIsLive(
      rawWrite,
      'UPDATE bookings SET amount_paid_centavos = 0',
      'amount_paid_centavos raw SQL write',
    );

    /** The one module that contains any crediting function. */
    const OWNER = 'src/services/payments/record-payment.ts';
    // Vacuity, both halves: the tree was scanned, and the owning module is
    // really in it. A renamed or moved `record-payment.ts` must fail here
    // rather than leave the guard quietly watching nothing.
    expect(appFiles.length).toBeGreaterThan(30);
    expect(appFiles, 'the module that owns recordPayment() was not scanned').toContain(OWNER);
    // It writes the column, so the patterns above are proven against the
    // real source and not only against their samples.
    const owner = readStripped(OWNER);
    expect(drizzleWrite.test(owner) || rawWrite.test(owner)).toBe(true);

    // Half one, unchanged in strictness: no OTHER file may write the column.
    const writers = appFiles.filter(
      (f) => f !== OWNER && (drizzleWrite.test(readStripped(f)) || rawWrite.test(readStripped(f))),
    );
    expect(
      writers,
      'only the payments service that owns recordPayment() may write ' +
        `bookings.amount_paid_centavos (CLAUDE.md, A5b): ${writers.join(', ')}`,
    ).toEqual([]);

    // Half two (M1): inside the owner, only the allow-listed functions may.
    const scan = findCreditWrites(readFileSync(join(serverRoot, OWNER), 'utf8'), OWNER);
    // Vacuity, fail closed: each entry must still exist AND still write.
    for (const name of Object.keys(CREDITING_FUNCTIONS)) {
      expect(
        scan.declared.has(name),
        `${name} is on the crediting allow-list but ${OWNER} no longer declares it — ` +
          'remove or rename the entry in the same commit',
      ).toBe(true);
      expect(
        scan.writes.some((w) => w.owner === name),
        `${name} is on the crediting allow-list but no longer writes amount_paid_centavos — ` +
          'an allow-list entry that permits nothing is a stale permission; remove it',
      ).toBe(true);
    }
    expect(
      unauthorisedCreditWrites(scan, Object.keys(CREDITING_FUNCTIONS)),
      `only ${Object.keys(CREDITING_FUNCTIONS).join(' and ')} may write ` +
        `bookings.amount_paid_centavos inside ${OWNER} (CLAUDE.md, A5b / M1). ` +
        'To add a crediting function, add it to CREDITING_FUNCTIONS with a reason',
    ).toEqual([]);
  });

  it('proves the per-function detector is live against in-memory samples', () => {
    const allowed = ['credits'];

    // A write in an allow-listed function: found, and accepted.
    const ok = findCreditWrites(
      'async function credits(db) { await db.update(b).set({ amountPaidCentavos: 1 }); }',
    );
    expect(ok.writes.map((w) => w.owner)).toEqual(['credits']);
    expect(unauthorisedCreditWrites(ok, allowed)).toEqual([]);

    // The same write in any other named function: reported by name.
    const other = findCreditWrites(
      'export async function sneaky(db) { await db.update(b).set({ amountPaidCentavos: 1 }); }',
    );
    expect(unauthorisedCreditWrites(other, allowed)).toEqual([expect.stringMatching(/^sneaky /)]);

    // Arrow function bound to a const is named by the const.
    const arrow = findCreditWrites(
      'const quiet = async (db) => db.set({ amountPaidCentavos: 1 });',
    );
    expect(unauthorisedCreditWrites(arrow, allowed)).toEqual([expect.stringMatching(/^quiet /)]);

    // A nested closure is attributed to its top-level declaration, so a
    // helper declared inside an allow-listed function stays that function's.
    const nested = findCreditWrites(
      'function credits(db) { const go = () => db.set({ amountPaidCentavos: 1 }); return go(); }',
    );
    expect(nested.writes.map((w) => w.owner)).toEqual(['credits']);

    // Top-level (module) code has no function to be on the list: fail closed.
    const top = findCreditWrites('db.update(b).set({ amountPaidCentavos: 1 });');
    expect(top.writes.map((w) => w.owner)).toEqual([null]);
    expect(unauthorisedCreditWrites(top, allowed)).toHaveLength(1);

    // So does a declaration with no name.
    const anon = findCreditWrites(
      'export default async function (db) { db.set({ amountPaidCentavos: 1 }); }',
    );
    expect(unauthorisedCreditWrites(anon, allowed)).toHaveLength(1);

    // The raw-SQL shapes, in a plain string and in a template literal.
    const raw = findCreditWrites(
      "function a(db) { db.execute('UPDATE bookings SET amount_paid_centavos = 0'); }\n" +
        'function b(db) { db.execute(sql`UPDATE bookings SET amount_paid_centavos = ${n}`); }',
    );
    expect(unauthorisedCreditWrites(raw, allowed)).toEqual([
      expect.stringMatching(/^a /),
      expect.stringMatching(/^b /),
    ]);

    // Not writes: type annotations, a read, a comment, the column declaration.
    const notWrites = findCreditWrites(
      [
        'interface Paid { amountPaidCentavos: number }',
        'class E { constructor(readonly amountPaidCentavos: number) {} }',
        "const amountPaid = { amountPaidCentavos: int('amount_paid_centavos') };",
        'function read(b) { return b.amountPaidCentavos + 1; }',
        '// set({ amountPaidCentavos: 1 }) and amount_paid_centavos = 1 in prose',
      ].join('\n'),
    );
    expect(notWrites.writes).toEqual([]);
    expect([...notWrites.declared].sort()).toEqual(['E', 'amountPaid', 'read']);
  });
});
