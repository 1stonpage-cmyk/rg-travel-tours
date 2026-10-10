/**
 * Fails a production build while the site still renders placeholder data.
 * Override intentionally with ALLOW_PLACEHOLDER_BUILD=1 (e.g. for a client demo).
 *
 * Task 3.7 deleted placeholder-data.ts — all content now comes from the
 * database (see CLAUDE.md). This guard still reads that file by path, so a
 * missing file means the placeholders are already gone — that is success,
 * not a build error, so this must not throw/ENOENT. Guard the read instead
 * of assuming the file exists.
 *
 * This no longer checks anything real: it always passes now that the file
 * is gone. Task 4.5 owns rewriting it to check settings.content_unverified
 * and is_sample reviews against the database instead.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const file = join(dirname(fileURLToPath(import.meta.url)), '../src/lib/placeholder-data.ts');
const stillPlaceholder =
  existsSync(file) && /export const USING_PLACEHOLDER_DATA = true/.test(readFileSync(file, 'utf8'));

if (stillPlaceholder && !process.env.ALLOW_PLACEHOLDER_BUILD) {
  console.error(
    '\nBuild blocked: the site still renders PLACEHOLDER data (ratings, guest counts, prices).\n' +
      'Spec section 0 forbids presenting these as real. Load real content (task 8D), or set\n' +
      'ALLOW_PLACEHOLDER_BUILD=1 to build a demo deliberately.\n',
  );
  process.exit(1);
}
