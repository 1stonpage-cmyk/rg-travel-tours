import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * `AdminLayout` owns the one `<main>` of every admin screen. A page that
 * draws its own nests a second landmark inside it (it shipped that way on
 * five screens), which screen readers announce as two main regions.
 *
 * The exceptions are the screens mounted OUTSIDE that layout, in
 * `App.tsx` — the three unauthenticated ones. Each is reached by somebody
 * who cannot sign in, so it renders its own page shell and therefore owes
 * the document its one `<main>`. The list is exact filenames rather than a
 * pattern, so a NEW admin page cannot excuse itself by being named
 * something similar.
 */
const OUTSIDE_THE_LAYOUT = [
  'AdminLoginPage.tsx',
  // §12's third door (task 1C): both halves of the self-service reset.
  'AdminForgotPasswordPage.tsx',
  'AdminResetPasswordPage.tsx',
];

describe('admin pages and components', () => {
  const roots = ['src/pages/admin', 'src/components/admin'];
  const files = roots.flatMap((dir) =>
    readdirSync(dir)
      .filter((f) => f.endsWith('.tsx'))
      .map((f) => join(dir, f)),
  );

  it('find the sources to scan', () => {
    expect(files.length).toBeGreaterThan(5);
  });

  it('never open a <main> of their own inside the layout', () => {
    const offenders = files.filter(
      (f) =>
        !OUTSIDE_THE_LAYOUT.some((name) => f.endsWith(name)) &&
        /<main[\s>]/.test(readFileSync(f, 'utf8')),
    );
    expect(offenders).toEqual([]);
  });

  /**
   * The allow-list is only safe while it names what it claims to name: each
   * exempt page must exist AND must really draw a `<main>`. Without this, a
   * renamed or deleted screen would leave the list excusing a file nothing
   * answers to — and the next page to acquire that name inherits the
   * exemption silently.
   */
  it('keeps the outside-the-layout allow-list honest', () => {
    for (const name of OUTSIDE_THE_LAYOUT) {
      const match = files.find((f) => f.endsWith(name));
      expect(
        match,
        `${name} is exempt from the single-<main> rule but does not exist`,
      ).toBeDefined();
      expect(
        /<main[\s>]/.test(readFileSync(match as string, 'utf8')),
        `${name} is exempt from the single-<main> rule but draws no <main> of its own`,
      ).toBe(true);
    }
  });
});
