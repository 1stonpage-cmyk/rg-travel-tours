/**
 * The contact details exist in two places that cannot import from each other:
 *
 *   client/src/lib/site.ts   the React app's single source of truth
 *   coming-soon/index.html   a standalone static page, no build step, no JS
 *
 * A number corrected in one and forgotten in the other is the exact failure
 * this guards: the holding page is what the apex domain serves until launch,
 * so a stale number there is a lost booking. This script reads the real values
 * out of site.ts and fails if the static page disagrees — including any extra
 * `tel:`, `wa.me`, `viber:` or `mailto:` target that site.ts does not know
 * about, which is how a leftover placeholder would survive.
 *
 * Run standalone (`node scripts/check-contact-parity.mjs`) or via `pnpm test`.
 */
import { readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const siteFile = join(repoRoot, 'client/src/lib/site.ts');
const pageFile = join(repoRoot, 'coming-soon/index.html');

const site = readFileSync(siteFile, 'utf8');
const page = readFileSync(pageFile, 'utf8');

const failures = [];

/** Pull a single quoted string value out of site.ts by key path. */
function value(key) {
  const match = new RegExp(`${key}:\\s*'([^']*)'`).exec(site);
  if (!match) {
    failures.push(`site.ts: could not read ${key} — the shape of SITE.contact changed`);
    return null;
  }
  return match[1];
}

const expected = {
  phoneDisplay: value('display'),
  phoneTel: value('tel'),
  whatsapp: value('whatsapp'),
  facebook: value('facebook'),
  motto: value('motto'),
};

// `display`/`tel` appear twice (primary, then alternate); take the second pair.
const displays = [...site.matchAll(/display:\s*'([^']*)'/g)].map((m) => m[1]);
const tels = [...site.matchAll(/tel:\s*'([^']*)'/g)].map((m) => m[1]);
expected.altPhoneDisplay = displays[1] ?? null;
expected.altPhoneTel = tels[1] ?? null;

// Email keeps its env fallback: `(env.VITE_CONTACT_EMAIL as string) ?? '...'`.
expected.email = /VITE_CONTACT_EMAIL as string\) \?\? '([^']*)'/.exec(site)?.[1] ?? null;

// The services sentence lives in three parts so the middle can be a link.
const parts = /otherServices:\s*{([\s\S]*?)}/.exec(site)?.[1] ?? '';
const [before, link, after] = [...parts.matchAll(/'([^']*)'/g)].map((m) => m[1]);
expected.services = [before, link, after].every(Boolean)
  ? `${before} ${link} ${after}`.replace(/\s+/g, ' ').trim()
  : null;

for (const [key, got] of Object.entries(expected)) {
  if (got === null || got === undefined) failures.push(`site.ts: ${key} is missing`);
}

/** Text of the page with entities and whitespace normalised for comparison. */
const pageText = page
  .replace(/<!--[\s\S]*?-->/g, ' ')
  .replace(/<[^>]+>/g, ' ')
  .replace(/&amp;/g, '&')
  .replace(/&nbsp;/g, ' ')
  .replace(/\s+/g, ' ')
  .trim();

const must = [
  ['WhatsApp link', `https://wa.me/${expected.whatsapp}`, page],
  ['primary tel: link', `"tel:${expected.phoneTel}"`, page],
  ['alternate tel: link', `"tel:${expected.altPhoneTel}"`, page],
  ['Viber deep link', `viber://chat?number=${encodeURIComponent(expected.phoneTel ?? '')}`, page],
  ['Facebook link', expected.facebook, page],
  ['mailto: link', `mailto:${expected.email}`, page],
  ['primary number, displayed', expected.phoneDisplay, pageText],
  ['alternate number, displayed', expected.altPhoneDisplay, pageText],
  ['motto', expected.motto, pageText],
  ['other-services line', expected.services, pageText],
];

for (const [label, needle, haystack] of must) {
  if (needle && !haystack.includes(needle)) {
    failures.push(`coming-soon/index.html is missing the ${label}: ${needle}`);
  }
}

/** No contact target may exist on the page that site.ts does not declare. */
const allowed = {
  'tel:': new Set([`tel:${expected.phoneTel}`, `tel:${expected.altPhoneTel}`]),
  'wa.me': new Set([`https://wa.me/${expected.whatsapp}`]),
  'viber:': new Set([`viber://chat?number=${encodeURIComponent(expected.phoneTel ?? '')}`]),
  'mailto:': new Set([`mailto:${expected.email}`]),
  'facebook.com': new Set([expected.facebook]),
};

for (const [, href] of page.matchAll(/href="([^"]+)"/g)) {
  for (const [scheme, permitted] of Object.entries(allowed)) {
    if (href.includes(scheme) && !permitted.has(href)) {
      failures.push(`coming-soon/index.html has an unknown ${scheme} target: ${href}`);
    }
  }
}

if (failures.length > 0) {
  console.error(
    `\nContact details differ between ${relative(repoRoot, siteFile).replace(/\\/g, '/')} and ` +
      `${relative(repoRoot, pageFile).replace(/\\/g, '/')}:\n` +
      failures.map((f) => `  - ${f}`).join('\n') +
      '\n',
  );
  process.exit(1);
}

console.log(
  `check-contact-parity: site.ts and coming-soon/index.html agree ` +
    `(${expected.phoneDisplay} / ${expected.altPhoneDisplay}).`,
);
