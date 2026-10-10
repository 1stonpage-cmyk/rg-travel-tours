import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * AA contrast guard (BUG-080), in the same spirit as `no-red.test.ts`: it
 * reads the real component source rather than a hand-maintained list, so a
 * pairing added later is checked without anyone remembering to update a
 * fixture.
 *
 * It finds every class-string literal that sets BOTH a `bg-brand-*` and a
 * `text-brand-*` utility, resolves both to the hex values declared in the
 * `@theme` block of `index.css`, and requires WCAG AA (4.5:1) for normal-size
 * text. Tailwind v4 has no config file — `index.css` is the single source of
 * truth for these tokens, which is why the ratios are computed from it here
 * instead of being written down as constants that could drift from it.
 *
 * Why this is worth a guard: `text-brand-warning` on `bg-brand-gold-100`
 * measured 4.51:1 — passing by 0.01, with effectively no headroom, so any
 * later nudge to either token would have pushed live UI below AA silently.
 * It is now `brand-gold-800` on the same background at 7.45:1.
 */

const clientRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const srcRoot = join(clientRoot, 'src');

/** WCAG 2.1 AA for normal-size text. */
const AA_NORMAL = 4.5;

function readTokens(): Map<string, string> {
  const css = readFileSync(join(srcRoot, 'index.css'), 'utf8');
  const tokens = new Map<string, string>();
  for (const m of css.matchAll(/--color-([a-z0-9-]+):\s*(#[0-9a-fA-F]{3,8})\s*;/g)) {
    tokens.set(m[1]!, m[2]!);
  }
  return tokens;
}

/** WCAG relative luminance. */
function luminance(hex: string): number {
  let h = hex.slice(1);
  if (h.length === 3) {
    h = h
      .split('')
      .map((c) => c + c)
      .join('');
  }
  const channel = (v: number) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  const r = channel(parseInt(h.slice(0, 2), 16));
  const g = channel(parseInt(h.slice(2, 4), 16));
  const b = channel(parseInt(h.slice(4, 6), 16));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrastRatio(a: string, b: string): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) {
      if (entry === '__tests__') continue;
      out.push(...sourceFiles(p));
    } else if (extname(p) === '.ts' || extname(p) === '.tsx') {
      out.push(p);
    }
  }
  return out;
}

/** Drop variant prefixes (`hover:`, `md:`, `dark:`) and any `/40` opacity suffix. */
function bareUtility(value: string): string {
  return value.replace(/^(?:[a-z-]+:)+/, '').replace(/\/\d+$/, '');
}

interface Pairing {
  file: string;
  fg: string;
  bg: string;
  ratio: number;
}

function collectPairings(): { pairings: Pairing[]; unresolved: string[] } {
  const tokens = readTokens();
  const pairings: Pairing[] = [];
  const unresolved: string[] = [];

  for (const file of sourceFiles(srcRoot)) {
    const src = readFileSync(file, 'utf8');
    // Class strings are plain quoted literals in this codebase (including the
    // arms of cn()/clsx() objects), so matching literals is enough.
    for (const literal of src.matchAll(/'([^'\n]*)'|"([^"\n]*)"|`([^`\n]*)`/g)) {
      const text = literal[1] ?? literal[2] ?? literal[3] ?? '';
      const backgrounds = [...text.matchAll(/(?:^|\s)((?:[a-z-]+:)*bg-brand-[a-z0-9-]+)/g)].map(
        (m) => bareUtility(m[1]!).replace('bg-', ''),
      );
      const foregrounds = [...text.matchAll(/(?:^|\s)((?:[a-z-]+:)*text-brand-[a-z0-9-]+)/g)].map(
        (m) => bareUtility(m[1]!).replace('text-', ''),
      );
      if (backgrounds.length === 0 || foregrounds.length === 0) continue;

      for (const bg of backgrounds) {
        for (const fg of foregrounds) {
          const bgHex = tokens.get(bg);
          const fgHex = tokens.get(fg);
          if (!bgHex || !fgHex) {
            unresolved.push(`${relative(clientRoot, file)}: ${fg} on ${bg}`);
            continue;
          }
          pairings.push({
            file: relative(clientRoot, file),
            fg,
            bg,
            ratio: contrastRatio(fgHex, bgHex),
          });
        }
      }
    }
  }
  return { pairings, unresolved };
}

describe('brand colour contrast (AA)', () => {
  it('finds brand text-on-background pairings to check', () => {
    const { pairings } = collectPairings();
    // Guards the scanner itself: if a refactor changed how class strings are
    // written and this stopped matching anything, every assertion below would
    // pass vacuously.
    expect(pairings.length).toBeGreaterThanOrEqual(8);
  });

  it('resolves every brand utility it finds to a token in index.css', () => {
    const { unresolved } = collectPairings();
    expect(unresolved).toEqual([]);
  });

  it('holds every brand text-on-background pairing at AA (4.5:1) or better', () => {
    const { pairings } = collectPairings();
    const failing = pairings
      .filter((p) => p.ratio < AA_NORMAL)
      .map((p) => `${p.file}: text-${p.fg} on bg-${p.bg} = ${p.ratio.toFixed(2)}:1`);
    expect(failing).toEqual([]);
  });

  it('keeps the announcement/placeholder amber off the 4.51:1 near-miss (BUG-080)', () => {
    const tokens = readTokens();
    const goldBg = tokens.get('brand-gold-100')!;
    // The colour these two surfaces actually use now.
    expect(contrastRatio(tokens.get('brand-gold-800')!, goldBg)).toBeGreaterThanOrEqual(7);
    // The colour they used to use — pinned as a near-miss so nobody reinstates
    // it believing it is comfortably AA.
    const warning = contrastRatio(tokens.get('brand-warning')!, goldBg);
    expect(warning).toBeLessThan(4.6);

    for (const file of [
      'src/components/layout/AnnouncementBar.tsx',
      'src/components/layout/PlaceholderBadge.tsx',
    ]) {
      const src = readFileSync(join(clientRoot, file), 'utf8');
      const classStrings = [...src.matchAll(/'([^'\n]*)'|"([^"\n]*)"/g)]
        .map((m) => m[1] ?? m[2] ?? '')
        .filter((s) => s.includes('bg-brand-gold-100'));
      expect(classStrings.length).toBeGreaterThan(0);
      for (const s of classStrings) {
        expect(s).not.toMatch(/\btext-brand-warning\b/);
      }
    }
  });
});
