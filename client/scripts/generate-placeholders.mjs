/**
 * Generates brand-gradient SVG placeholder tiles into public/placeholders/.
 * Blue -> gold, labelled PLACEHOLDER so they cannot be mistaken for real
 * photography. Replaced by the client's real photos in spec task 8D.
 *
 * Run: pnpm --filter @rg/client placeholders
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const outDir = join(dirname(fileURLToPath(import.meta.url)), '../public/placeholders');

const TILES = [
  { slug: 'oslob', label: 'OSLOB' },
  { slug: 'mactan', label: 'MACTAN' },
  { slug: 'badian-kawasan', label: 'BADIAN / KAWASAN' },
  { slug: 'moalboal', label: 'MOALBOAL' },
  { slug: 'bohol', label: 'BOHOL' },
  { slug: 'cebu-city', label: 'CEBU CITY' },
  { slug: 'package-cebu-highlights', label: 'CEBU HIGHLIGHTS' },
  { slug: 'package-cebu-bohol', label: 'CEBU & BOHOL' },
  { slug: 'package-south-cebu', label: 'SOUTH CEBU' },
  { slug: 'hero', label: 'HERO IMAGE', width: 1600, height: 900 },
];

const escapeXml = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function tile({ slug, label, width = 1200, height = 800 }) {
  const id = `g-${slug}`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img" aria-label="${escapeXml(label)} placeholder">
  <defs>
    <linearGradient id="${id}" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#172554"/>
      <stop offset="55%" stop-color="#1d4ed8"/>
      <stop offset="100%" stop-color="#d4a017"/>
    </linearGradient>
  </defs>
  <rect width="${width}" height="${height}" fill="url(#${id})"/>
  <g fill="#ffffff" font-family="system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif" text-anchor="middle">
    <text x="${width / 2}" y="${height / 2 - 10}" font-size="${Math.round(width / 16)}" font-weight="700" letter-spacing="2">${escapeXml(label)}</text>
    <text x="${width / 2}" y="${height / 2 + Math.round(width / 22)}" font-size="${Math.round(width / 34)}" font-weight="600" letter-spacing="6" opacity="0.85">PLACEHOLDER</text>
  </g>
</svg>
`;
}

mkdirSync(outDir, { recursive: true });

for (const spec of TILES) {
  writeFileSync(join(outDir, `${spec.slug}.svg`), tile(spec), 'utf8');
  console.log(`wrote placeholders/${spec.slug}.svg`);
}
