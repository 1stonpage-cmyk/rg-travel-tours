import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * `AdminLayout` owns the one `<main>` of every admin screen. A page that
 * draws its own nests a second landmark inside it (it shipped that way on
 * five screens), which screen readers announce as two main regions. The
 * sign-in page is the one exception: it is outside the layout by design.
 */
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
      (f) => !f.endsWith('AdminLoginPage.tsx') && /<main[\s>]/.test(readFileSync(f, 'utf8')),
    );
    expect(offenders).toEqual([]);
  });
});
