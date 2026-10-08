import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const clientRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const scanRoots = [join(clientRoot, 'src'), join(clientRoot, 'index.html')];
const scanExtensions = new Set(['.ts', '.tsx', '.css', '.html', '.svg']);

/** This test file names the forbidden patterns, so it must exempt itself. */
const exempt = ['src/__tests__/no-red.test.ts'];

/**
 * Patterns that would introduce red. Covers Tailwind utility families, CSS
 * named colours, and the hue range of hex/rgb reds we would plausibly type.
 */
const forbidden: { label: string; re: RegExp }[] = [
  {
    label: 'tailwind red/rose utility',
    re: /\b(?:bg|text|border|ring|from|via|to|outline|decoration|shadow|fill|stroke|accent|caret|divide|placeholder)-(?:red|rose)-\d{2,3}\b/,
  },
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
];

function collectFiles(target: string): string[] {
  const stats = statSync(target, { throwIfNoEntry: false });
  if (!stats) return [];
  if (stats.isFile()) return scanExtensions.has(extname(target)) ? [target] : [];

  return readdirSync(target).flatMap((entry) => {
    if (entry === 'node_modules' || entry === 'dist') return [];
    return collectFiles(join(target, entry));
  });
}

describe('brand rule: no red anywhere', () => {
  const files = scanRoots.flatMap(collectFiles);

  it('finds source files to scan', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it('contains no red colour values or utilities', () => {
    const offences: string[] = [];

    for (const file of files) {
      const rel = relative(clientRoot, file).replace(/\\/g, '/');
      if (exempt.includes(rel)) continue;

      const lines = readFileSync(file, 'utf8').split(/\r?\n/);
      lines.forEach((line, index) => {
        for (const { label, re } of forbidden) {
          if (re.test(line)) {
            offences.push(`${rel}:${index + 1} [${label}] ${line.trim().slice(0, 100)}`);
          }
        }
      });
    }

    expect(
      offences,
      `Red is forbidden brand-wide (see CLAUDE.md):\n${offences.join('\n')}`,
    ).toEqual([]);
  });
});
