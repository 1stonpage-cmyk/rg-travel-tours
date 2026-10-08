/**
 * Fails a production build while the site still renders placeholder data.
 * Override intentionally with ALLOW_PLACEHOLDER_BUILD=1 (e.g. for a client demo).
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const file = join(dirname(fileURLToPath(import.meta.url)), '../src/lib/placeholder-data.ts');
const stillPlaceholder = /export const USING_PLACEHOLDER_DATA = true/.test(
  readFileSync(file, 'utf8'),
);

if (stillPlaceholder && !process.env.ALLOW_PLACEHOLDER_BUILD) {
  console.error(
    '\nBuild blocked: the site still renders PLACEHOLDER data (ratings, guest counts, prices).\n' +
      'Spec section 0 forbids presenting these as real. Load real content (task 8D), or set\n' +
      'ALLOW_PLACEHOLDER_BUILD=1 to build a demo deliberately.\n',
  );
  process.exit(1);
}
