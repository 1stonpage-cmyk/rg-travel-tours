/**
 * Guard for the single most-repeated defect found in the admin "Clean Pill"
 * button rollout (B2, DEMO POLISH batch, 2026-11-09): a destructive confirm
 * button — "Yes, deactivate {name}", "Yes — cancel {ref}" — styled as a
 * blue `primary-pill` instead of the amber confirm pair owner decision 1
 * requires ("Deactivate = amber outline pill. Never red"). It recurred
 * independently in nine separate places (AdminVehicleTypesPage,
 * AdminDriversPage, AdminToursPage, AdminPackagesPage, AdminCouponsPage,
 * AdminTransferPlacesPage, AdminTransferRoutesPage, AdminSettingsPage,
 * AdminStaffPage, CancelRefundPanel) across a single batch of work, each
 * found only because that file happened to be read closely — nothing
 * stopped it reappearing in the tenth. This reads the real admin source,
 * like `no-red.test.ts` and `schema-conventions.test.ts` do, rather than a
 * fixture list, so a new offender is caught without anyone updating a test.
 *
 * The signal: every destructive confirm button in this codebase, without
 * exception, is phrased "Yes, ..." or "Yes — ..." / "Yes -- ..." — the
 * house style for the second step of a two-step confirm (`CLAUDE.md`'s
 * "Admin buttons" section). A button whose own text takes that shape must
 * be `amber-pill` or `row-amber`; nothing else matches that phrasing
 * (confirmed: "Yes" never appears in any OTHER admin button's text).
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const clientRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const scanRoots = [join(clientRoot, 'src/pages/admin'), join(clientRoot, 'src/components/admin')];
const scanExtensions = new Set(['.tsx']);

/** This file names the forbidden shape in its own doc comment, so it exempts itself. */
const exempt = ['src/__tests__/admin-destructive-confirm-color.test.ts'];

/** Same comment-stripping discipline as `no-red.test.ts`, so a doc comment never trips this. */
function stripComments(text: string): string {
  const withoutBlockComments = text.replace(/\/\*[\s\S]*?\*\//g, (match) =>
    match.replace(/[^\n]/g, ' '),
  );
  return withoutBlockComments.replace(/(^|[^:])\/\/.*$/gm, (_match, prefix: string) => prefix);
}

function collectFiles(target: string): string[] {
  const stats = statSync(target, { throwIfNoEntry: false });
  if (!stats) return [];
  if (stats.isFile()) return scanExtensions.has(extname(target)) ? [target] : [];

  return readdirSync(target).flatMap((entry) => {
    if (entry === 'node_modules' || entry === 'dist') return [];
    return collectFiles(join(target, entry));
  });
}

/** A destructive confirm's own house phrasing — see the file doc comment above. */
const YES_CONFIRM = /\bYes\s?[,—-]/;
const AMBER_VARIANT = /variant=["']amber-pill["']|variant=["']row-amber["']/;

/**
 * Every `<Button ...>...</Button>` element in a stripped-of-comments
 * source string, as `{ attrs, body }`. Non-greedy to the nearest closing
 * tag — correct as long as no `<Button>` nests another, true everywhere
 * in this tree today (confirmed by this test's own offender count below).
 */
function findButtonElements(source: string): { attrs: string; body: string }[] {
  const matches: { attrs: string; body: string }[] = [];
  const re = /<Button\b([^>]*)>([\s\S]*?)<\/Button>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source))) {
    matches.push({ attrs: m[1] ?? '', body: m[2] ?? '' });
  }
  return matches;
}

/** Self-test: the detector must flag the exact bug shape this guard exists for. */
function hasOffendingButton(source: string): boolean {
  return findButtonElements(source).some(
    ({ attrs, body }) => YES_CONFIRM.test(body) && !AMBER_VARIANT.test(attrs),
  );
}

describe('admin buttons: a destructive confirm is always amber, never blue', () => {
  const files = scanRoots.flatMap(collectFiles);

  it('finds admin source files to scan', () => {
    expect(files.length).toBeGreaterThan(10);
  });

  it('the detector itself flags the exact bug shape this guard exists for', () => {
    expect(
      hasOffendingButton(
        '<Button type="button" className={PRIMARY_BUTTON} onClick={doIt}>{`Yes, deactivate ${name}`}</Button>',
      ),
    ).toBe(true);
    expect(
      hasOffendingButton(
        '<Button type="button" variant="primary-pill" onClick={doIt}>{`Yes — cancel ${ref}`}</Button>',
      ),
    ).toBe(true);
    // And does not flag the fixed shape, or an unrelated "Yes"-free button.
    expect(
      hasOffendingButton(
        '<Button type="button" variant="amber-pill" onClick={doIt}>{`Yes, deactivate ${name}`}</Button>',
      ),
    ).toBe(false);
    expect(hasOffendingButton('<Button type="button" variant="primary-pill">Save</Button>')).toBe(
      false,
    );
  });

  it('no admin button phrased as a two-step confirm is styled blue', () => {
    const offences: string[] = [];

    for (const file of files) {
      const rel = relative(clientRoot, file).replace(/\\/g, '/');
      if (exempt.includes(rel)) continue;

      const raw = readFileSync(file, 'utf8');
      const stripped = stripComments(raw);

      for (const { attrs, body } of findButtonElements(stripped)) {
        if (YES_CONFIRM.test(body) && !AMBER_VARIANT.test(attrs)) {
          const textSample = body.replace(/\s+/g, ' ').trim().slice(0, 60);
          offences.push(`${rel}: <Button ${attrs.trim().slice(0, 60)}> ... ${textSample}`);
        }
      }
    }

    expect(
      offences,
      `A "Yes, ..."/"Yes — ..." confirm must be amber-pill or row-amber, never blue ` +
        `(owner decision 1, CLAUDE.md "Admin buttons"):\n${offences.join('\n')}`,
    ).toEqual([]);
  });
});
