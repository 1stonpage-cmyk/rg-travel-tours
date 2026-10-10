/**
 * Task 4.4 — performance pass, asserted at the level that is actually
 * testable in jsdom: the markup.
 *
 * None of these assert a Lighthouse score (plan decision D4 adds no
 * Lighthouse dependency and claims no scores). What they do pin down is the
 * four mechanical things a slow first paint on a Philippine mobile
 * connection comes from, every one of which is a visible attribute:
 *
 *  1. the hero (the mobile LCP element) is discoverable in the HTML head —
 *     but only on the route that renders it, which since task 4.4b means the
 *     server's per-route injector and NOT this shared shell,
 *  2. every content image reserves its box before it loads,
 *  3. everything below the fold is lazy and decoded off the main thread,
 *     while the hero is neither,
 *  4. nothing render-blocking is fetched from a font CDN.
 *
 * The image tests deliberately count what they found before asserting on
 * it. A `querySelectorAll('img')` that matches nothing would otherwise make
 * `.every(...)` vacuously true and the test green against a page with no
 * images at all.
 */
import { HERO_IMAGE_PRELOAD } from '@rg/shared';
import { render, screen } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it } from 'vitest';
import { TrpcProviders } from '@/lib/trpc';
import HomePage from '@/pages/public/HomePage';
import {
  DESTINATIONS_FIXTURE,
  PACKAGES_FIXTURE,
  REVIEWS_FIXTURE,
  SETTINGS_FIXTURE,
  TOURS_FIXTURE,
} from './helpers/fixtures';
import { mockTrpc } from './helpers/mock-trpc';

/** The shell the server's meta injector rewrites — read from disk, not a copy. */
const clientRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const INDEX_HTML = readFileSync(join(clientRoot, 'index.html'), 'utf8');
const INDEX_CSS = readFileSync(join(clientRoot, 'src/index.css'), 'utf8');

/**
 * Home renders 16 images with the seeded fixtures: the hero, six tour cards
 * (CatalogPreview), six Most Visited destinations and three packages. The
 * exact number matters less than it being this large — it is the guard
 * against a selector that silently matches nothing.
 */
const EXPECTED_HOME_IMAGE_COUNT = 16;

function renderHome() {
  return render(
    <TrpcProviders>
      <MemoryRouter>
        <HomePage />
      </MemoryRouter>
    </TrpcProviders>,
  );
}

/** Waits for the API-driven sections, then returns every rendered `<img>`. */
async function loadedHomeImages(container: HTMLElement): Promise<HTMLImageElement[]> {
  // Three separate queries feed the three image-bearing sections; waiting on
  // one card from the last of them is what makes the count below stable.
  await screen.findByText(/most visited places/i);
  await screen.findByRole('heading', { name: /cebu & bohol explorer/i });
  return [...container.querySelectorAll('img')];
}

describe('performance markup', () => {
  beforeEach(() => {
    mockTrpc({
      'settings.get': SETTINGS_FIXTURE,
      'destinations.list': DESTINATIONS_FIXTURE,
      'tours.list': TOURS_FIXTURE,
      'packages.list': PACKAGES_FIXTURE,
      'reviews.published': REVIEWS_FIXTURE,
    });
  });

  it('keeps the hero preload out of the shared SPA shell (4.4b)', () => {
    // index.html is served for EVERY route, so a preload in it also lands on
    // /tours, /privacy and /terms, where no hero renders — wasted bytes and
    // Chrome's "preloaded but not used" warning. The server's SEO injector
    // emits it for / alone; seo-render/seo-html/seo-resolvers cover that end.
    expect(INDEX_HTML, 'index.html has a rel="preload" link again').not.toMatch(/rel="preload"/i);
    // The BUG-079 viewport meta must survive any edit to this file. Matched on
    // the TAG, not on the file: the comment above it explains BUG-079 and names
    // `viewport-fit=cover` too, so a whole-file `toContain` would stay green
    // with the attribute deleted from the tag.
    const viewport = /<meta\s+name="viewport"[^>]*>/i.exec(INDEX_HTML)?.[0];
    expect(viewport, 'index.html has no viewport meta').toBeTruthy();
    expect(viewport).toContain('viewport-fit=cover');
  });

  it('names exactly the preloaded WebP candidates on the hero <picture>', async () => {
    const { container } = renderHome();
    await loadedHomeImages(container);

    const source = container.querySelector('picture > source[type="image/webp"]');
    expect(source, 'hero <picture> has no WebP source').toBeTruthy();
    // Byte-identical to what the server preloads, because both render from
    // HERO_IMAGE_PRELOAD. A mismatch means the browser fetches the hero twice.
    expect(source?.getAttribute('srcset')).toBe(HERO_IMAGE_PRELOAD.srcset);
    expect(source?.getAttribute('sizes')).toBe(HERO_IMAGE_PRELOAD.sizes);
    // And the candidates really are the two hero widths, so the constant
    // cannot be quietly emptied and still satisfy the equality above.
    expect(HERO_IMAGE_PRELOAD.srcset).toBe(
      '/hero/hero-cebu-800.webp 800w, /hero/hero-cebu-1920.webp 1920w',
    );
  });

  it('gives every content image explicit width and height', async () => {
    const { container } = renderHome();
    const images = await loadedHomeImages(container);
    expect(images).toHaveLength(EXPECTED_HOME_IMAGE_COUNT);

    const missing = images
      .filter((img) => !img.getAttribute('width') || !img.getAttribute('height'))
      .map((img) => img.getAttribute('src'));
    expect(missing, 'images without both width and height').toEqual([]);
  });

  it('lazy-loads images below the fold but not the hero', async () => {
    const { container } = renderHome();
    const images = await loadedHomeImages(container);

    const hero = container.querySelector<HTMLImageElement>('img[src^="/hero/"]');
    expect(hero, 'hero image not found').toBeTruthy();
    expect(hero).toHaveAttribute('fetchpriority', 'high');
    expect(hero).not.toHaveAttribute('loading', 'lazy');

    const belowFold = images.filter((img) => img !== hero);
    expect(belowFold).toHaveLength(EXPECTED_HOME_IMAGE_COUNT - 1);

    const eager = belowFold
      .filter((img) => img.getAttribute('loading') !== 'lazy')
      .map((img) => img.getAttribute('src'));
    expect(eager, 'below-the-fold images not marked loading="lazy"').toEqual([]);

    const sync = belowFold
      .filter((img) => img.getAttribute('decoding') !== 'async')
      .map((img) => img.getAttribute('src'));
    expect(sync, 'below-the-fold images not marked decoding="async"').toEqual([]);
  });

  it('has no render-blocking font link in index.html', () => {
    // `--font-sans` names 'Inter' first but nothing ever fetches it, so the
    // local fallback stack is what renders — and there is no blocking
    // round-trip to a font CDN. Asserted, not assumed, in both files that
    // could introduce one.
    for (const [name, source] of [
      ['index.html', INDEX_HTML],
      ['index.css', INDEX_CSS],
    ] as const) {
      expect(source, `${name} fetches from a font CDN`).not.toMatch(
        /fonts\.googleapis\.com|fonts\.gstatic\.com|use\.typekit\.net/,
      );
      expect(source, `${name} declares a webfont`).not.toMatch(/@font-face/);
    }
  });
});
