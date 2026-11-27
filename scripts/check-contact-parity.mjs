/**
 * The contact details exist in two places that cannot import from each other:
 *
 *   server/src/db/seed-data.ts   the real phone/WhatsApp/Viber numbers (and
 *                                 the source every public page reads them
 *                                 from, via the database — see
 *                                 client/src/lib/site.ts's own header)
 *   client/src/lib/site.ts       motto, Facebook URL, email and the
 *                                 other-services sentence — non-number brand
 *                                 fields that stayed hardcoded (owner spec,
 *                                 2026-11-28, Task 1A)
 *   coming-soon/index.html       a standalone static page, no build step, no
 *                                 JS, so it cannot read either source live
 *
 * A number corrected in one and forgotten in the other is the exact failure
 * this guards: the holding page is what the apex domain serves until launch,
 * so a stale number there is a lost booking. This script reads the real
 * values out of the two source files and fails if the static page disagrees
 * — including any extra `tel:`, `wa.me`, `viber:` or `mailto:` target that
 * neither source knows about, which is how a leftover placeholder would
 * survive.
 *
 * Run standalone (`node scripts/check-contact-parity.mjs`) or via `pnpm test`.
 */
import { readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const siteFile = join(repoRoot, 'client/src/lib/site.ts');
const seedFile = join(repoRoot, 'server/src/db/seed-data.ts');
const pageFile = join(repoRoot, 'coming-soon/index.html');

const site = readFileSync(siteFile, 'utf8');
const seed = readFileSync(seedFile, 'utf8');
const page = readFileSync(pageFile, 'utf8');

const failures = [];

/** Pull a single quoted string value out of a source file by key. */
function value(source, sourceLabel, key) {
  const match = new RegExp(`${key}:\\s*'([^']*)'`).exec(source);
  if (!match) {
    failures.push(`${sourceLabel}: could not read ${key} — its shape changed`);
    return null;
  }
  return match[1];
}

// The real numbers now live in the seed (server/src/db/seed-data.ts's
// `contact` block), not in site.ts — see this file's own header.
const expected = {
  phoneDisplay: value(seed, 'seed-data.ts', 'phoneDisplay'),
  phoneTel: value(seed, 'seed-data.ts', 'phoneTel'),
  whatsapp: value(seed, 'seed-data.ts', 'whatsapp'),
  altPhoneDisplay: value(seed, 'seed-data.ts', 'altPhoneDisplay'),
  altPhoneTel: value(seed, 'seed-data.ts', 'altPhoneTel'),
  facebook: value(site, 'site.ts', 'facebook'),
  motto: value(site, 'site.ts', 'motto'),
};

// "Empty means use the WhatsApp number" (owner spec, 2026-11-28, Task 1A) —
// the same fallback `resolveContact()` applies server-side. The seed ships
// an empty `viber`, so Viber's real target today is `whatsapp`, with a
// leading "+" added (wa.me wants bare digits; viber:// wants "+").
const seededViber = value(seed, 'seed-data.ts', 'viber');
expected.viber = seededViber || `+${expected.whatsapp ?? ''}`;

// Email keeps its env fallback: `(env.VITE_CONTACT_EMAIL as string) ?? '...'`.
expected.email = /VITE_CONTACT_EMAIL as string\) \?\? '([^']*)'/.exec(site)?.[1] ?? null;

// The services sentence lives in three parts so the middle can be a link.
const parts = /otherServices:\s*{([\s\S]*?)}/.exec(site)?.[1] ?? '';
const [before, link, after] = [...parts.matchAll(/'([^']*)'/g)].map((m) => m[1]);
expected.services = [before, link, after].every(Boolean)
  ? `${before} ${link} ${after}`.replace(/\s+/g, ' ').trim()
  : null;

for (const [key, got] of Object.entries(expected)) {
  if (got === null || got === undefined) failures.push(`${key} is missing`);
}

/** Text of the page with entities and whitespace normalised for comparison. */
const pageText = page
  .replace(/<!--[\s\S]*?-->/g, ' ')
  .replace(/<[^>]+>/g, ' ')
  .replace(/&amp;/g, '&')
  .replace(/&nbsp;/g, ' ')
  .replace(/\s+/g, ' ')
  .trim();

// WhatsApp/Viber are independent settings fields now (owner spec,
// 2026-11-28, Task 1A) — no longer tied by construction to `altPhoneTel`, so
// each is checked against its own expected value above.
const must = [
  ['WhatsApp link', `https://wa.me/${expected.whatsapp}`, page],
  ['primary tel: link', `"tel:${expected.phoneTel}"`, page],
  ['alternate tel: link', `"tel:${expected.altPhoneTel}"`, page],
  ['Viber deep link', `viber://chat?number=${encodeURIComponent(expected.viber ?? '')}`, page],
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

/** No contact target may exist on the page that the seed/site do not declare. */
const allowed = {
  'tel:': new Set([`tel:${expected.phoneTel}`, `tel:${expected.altPhoneTel}`]),
  'wa.me': new Set([`https://wa.me/${expected.whatsapp}`]),
  'viber:': new Set([`viber://chat?number=${encodeURIComponent(expected.viber ?? '')}`]),
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
    `\nContact details differ between ${relative(repoRoot, seedFile).replace(/\\/g, '/')} / ` +
      `${relative(repoRoot, siteFile).replace(/\\/g, '/')} and ` +
      `${relative(repoRoot, pageFile).replace(/\\/g, '/')}:\n` +
      failures.map((f) => `  - ${f}`).join('\n') +
      '\n',
  );
  process.exit(1);
}

console.log(
  `check-contact-parity: seed-data.ts / site.ts and coming-soon/index.html agree ` +
    `(${expected.phoneDisplay} / ${expected.altPhoneDisplay}).`,
);
