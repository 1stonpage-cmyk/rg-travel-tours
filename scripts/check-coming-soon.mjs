/**
 * Guard for the standalone /coming-soon page.
 *
 * The coming-soon page is served straight off nginx — it is not part of the
 * client build, so neither `no-red.test.ts` nor the Vite build ever sees it.
 * This script applies the two rules that matter for a holding page:
 *
 *   1. NO RED ANYWHERE (CLAUDE.md brand rule), overlays and tints included.
 *   2. No tour names, itineraries or prices. Until real content exists, the
 *      page must not imply a catalogue or quote a peso figure.
 *
 * Run standalone (`node scripts/check-coming-soon.mjs`) or via `pnpm test`,
 * which runs it before the workspace test suites.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pageRoot = join(repoRoot, 'coming-soon');
const scanExtensions = new Set(['.html', '.css', '.svg', '.js', '.mjs']);

/** Mirrors the patterns in client/src/__tests__/no-red.test.ts. */
const forbiddenRed = [
  {
    label: 'css named red',
    re: /\b(?:crimson|firebrick|indianred|darkred|orangered|tomato|maroon)\b/i,
  },
  { label: 'bare css color: red', re: /(?:^|[\s:;("'])red(?:$|[\s;,)"'])/i },
  { label: 'hex red #f00 family', re: /#(?:f00|e00|d00|c00|b00)\b/i },
  {
    label: 'hex red #ff0000 family',
    re: /#(?:ff|ee|dd|cc|bb|aa)(?:0\d|1\d|2\d)(?:0\d|1\d|2\d)\b/i,
  },
  {
    label: 'rgb red',
    re: /rgba?\(\s*(?:1[89]\d|2[0-5]\d)\s*,\s*(?:[0-4]\d?)\s*,\s*(?:[0-4]\d?)\s*[,)]/i,
  },
  {
    // Same reasoning as the client guard: a hue range cannot be checked inside
    // hsl()/oklch()/lab()/color-mix(), so express colour as hex here.
    label: 'non-hex colour function (use a hex brand token so red can be ruled out)',
    re: /\b(?:hsla?|oklch|lch|lab|color-mix)\(/i,
  },
];

/**
 * Tour names and price shapes. Destination words are matched on their own
 * (Cebu is allowed — it is the location, not a product), and any peso figure
 * or per-person rate is forbidden outright.
 */
const forbiddenContent = [
  {
    label: 'tour or destination product name',
    re: /\b(?:oslob|moalboal|mactan|badian|kawasan|bohol|pescador|tumalog|sumilon|sirao|chocolate hills|whale shark|canyoneering|sardine run|island hopping)\b/i,
  },
  { label: 'peso price', re: /(?:₱|\bPHP\b)\s?[\d,]/i },
  { label: 'per-person rate', re: /\bper\s?(?:pax|person|head)\b/i },
  { label: 'deposit or discount figure', re: /\b\d{1,3}\s?%\s?(?:deposit|off|discount)\b/i },
  { label: 'itinerary/booking claim', re: /\b(?:book now|add to cart|checkout|itinerary)\b/i },
];

function collectFiles(target) {
  const stats = statSync(target, { throwIfNoEntry: false });
  if (!stats) return [];
  if (stats.isFile()) return scanExtensions.has(extname(target)) ? [target] : [];
  return readdirSync(target).flatMap((entry) => collectFiles(join(target, entry)));
}

/** Blank out comment spans so prose explaining a rule cannot trip it. */
function stripComments(text) {
  return text
    .replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
}

const files = collectFiles(pageRoot);
const offences = [];

if (files.length === 0) {
  console.error(`\ncheck-coming-soon: no files found under ${relative(repoRoot, pageRoot)}.\n`);
  process.exit(1);
}

for (const file of files) {
  const rel = relative(repoRoot, file).replace(/\\/g, '/');
  const rawLines = readFileSync(file, 'utf8').split(/\r?\n/);
  const checkedLines = stripComments(rawLines.join('\n')).split(/\r?\n/);

  checkedLines.forEach((line, index) => {
    for (const { label, re } of [...forbiddenRed, ...forbiddenContent]) {
      if (re.test(line)) {
        offences.push(
          `${rel}:${index + 1} [${label}] ${(rawLines[index] ?? '').trim().slice(0, 100)}`,
        );
      }
    }
  });
}

if (offences.length > 0) {
  console.error(
    '\nThe coming-soon page must contain no red and no tour names or prices:\n' +
      offences.join('\n') +
      '\n',
  );
  process.exit(1);
}

console.log(`check-coming-soon: ${files.length} file(s) clean — no red, no tour names or prices.`);
