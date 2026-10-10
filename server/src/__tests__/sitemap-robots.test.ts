/**
 * Task 4.3 — /sitemap.xml, /robots.txt and the X-Robots-Tag header.
 *
 * Two policies are under test and they are tested separately on purpose:
 *
 *  - the PURE policy (`buildRobots`, `robotsTagValue`, `escapeXml`), which
 *    needs no database and can therefore be driven through every combination
 *    of environment and content flag;
 *  - the WIRED behaviour through `createApp`, which proves the pure policy is
 *    actually reached — that the routes are mounted above the SPA catch-all,
 *    and that the header middleware runs before them.
 *
 * The content_unverified tests flip the real setting in `rg_travel_test` and
 * reset the flag cache around every flip, because a header test that quietly
 * read a stale `true` would pass forever. `resetTestDb()` in `afterAll` puts
 * the seeded baseline back for the files that run after this one.
 */
import { eq } from 'drizzle-orm';
import express from 'express';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../app';
import {
  CONTENT_UNVERIFIED_TTL_MS,
  readContentUnverified,
  resetContentUnverifiedCache,
} from '../content/settings';
import { getDb } from '../db/client';
import { packages, settings, tours } from '../db/schema';
import { isPrivatePath, robotsHeader, robotsTagValue } from '../middleware/robots-header';
import { absoluteUrl } from '../seo/resolvers';
import {
  buildRobots,
  buildSitemap,
  collectSitemapUrls,
  detailUrls,
  escapeXml,
  sitemapXmlHandler,
  w3cDateTime,
} from '../seo/sitemap';
import { describeWithDb } from './helpers/db';
import { resetTestDb } from './helpers/test-db';

const SHELL = `<!doctype html><html lang="en"><head>
<meta charset="UTF-8" />
<title>TravelSugbo</title>
<meta name="description" content="shell description" />
</head><body><div id="root"></div></body></html>`;

function makeDist(): string {
  const dir = mkdtempSync(join(tmpdir(), 'rg-robots-dist-'));
  writeFileSync(join(dir, 'index.html'), SHELL, 'utf8');
  mkdirSync(join(dir, 'assets'));
  writeFileSync(join(dir, 'assets', 'app.css'), '.a{color:#334155}', 'utf8');
  return dir;
}

/** Writes the real setting and drops the cache, so the next read sees it. */
async function setContentUnverified(value: boolean): Promise<void> {
  await getDb().update(settings).set({ value }).where(eq(settings.key, 'content_unverified'));
  resetContentUnverifiedCache();
}

// ---------------------------------------------------------------------------
// Pure policy
// ---------------------------------------------------------------------------

describe('buildRobots', () => {
  it('allows everything and names the sitemap in production, once content is verified', () => {
    const txt = buildRobots('production', false);

    expect(txt).toContain('User-agent: *');
    expect(txt).toContain('Allow: /');
    expect(txt).toMatch(/^Sitemap: https?:\/\/\S+\/sitemap\.xml$/m);
    expect(txt).toContain(`Sitemap: ${absoluteUrl('/sitemap.xml')}`);
    // The operational surfaces are still asked for politely...
    expect(txt).toContain('Disallow: /admin');
    expect(txt).toContain('Disallow: /driver');
    expect(txt).toContain('Disallow: /portal');
    // ...but nothing blanket-blocks the site. (`toContain('Disallow: /')`
    // would be satisfied by the three lines above, hence the anchored match.)
    expect(txt).not.toMatch(/^Disallow: \/$/m);
  });

  it('disallows everything in preview', () => {
    const txt = buildRobots('preview', false);

    expect(txt).toMatch(/^Disallow: \/$/m);
    expect(txt).not.toContain('Allow: /');
    // No point advertising a URL list a crawler was just told not to fetch.
    expect(txt).not.toContain('Sitemap:');
  });

  it('disallows everything in development', () => {
    expect(buildRobots('development', false)).toMatch(/^Disallow: \/$/m);
    expect(buildRobots('development', false)).not.toContain('Allow: /');
  });

  it('disallows everything in production while content_unverified is true', () => {
    const txt = buildRobots('production', true);

    expect(txt).toMatch(/^Disallow: \/$/m);
    expect(txt).not.toContain('Allow: /');
    expect(txt).not.toContain('Sitemap:');
  });

  it('never names the environment it is running in', () => {
    for (const env of ['development', 'preview', 'production'] as const) {
      const txt = buildRobots(env, true);
      expect(txt).not.toContain('preview');
      expect(txt).not.toContain('development');
    }
  });
});

describe('robotsTagValue', () => {
  it.each(['/admin', '/driver', '/portal', '/admin/bookings', '/portal/booking/RG-7KQ4M9'])(
    'sets noindex on %s even in verified production',
    (path) => {
      expect(robotsTagValue(path, 'production', false)).toBe('noindex, nofollow');
    },
  );

  it('does not set it on the public pages in verified production', () => {
    for (const path of ['/', '/tours', '/privacy', '/terms']) {
      expect(robotsTagValue(path, 'production', false)).toBeNull();
    }
  });

  it('sets noindex on every path in the preview environment', () => {
    for (const path of ['/', '/tours', '/privacy', '/terms']) {
      expect(robotsTagValue(path, 'preview', false)).toBe('noindex, nofollow');
    }
  });

  it('sets noindex on every path while content_unverified is true', () => {
    for (const path of ['/', '/tours', '/privacy', '/terms']) {
      expect(robotsTagValue(path, 'production', true)).toBe('noindex, nofollow');
    }
  });

  it('matches the private prefixes on segment boundaries only', () => {
    expect(isPrivatePath('/admin')).toBe(true);
    expect(isPrivatePath('/admin/')).toBe(true);
    expect(isPrivatePath('/ADMIN/Bookings')).toBe(true);
    // A future public page must not be noindexed by a loose prefix match.
    expect(isPrivatePath('/administrators')).toBe(false);
    expect(isPrivatePath('/portal-tour')).toBe(false);
    expect(isPrivatePath('/tours')).toBe(false);
  });
});

describe('XML helpers', () => {
  it('escapes all five predefined entities', () => {
    expect(escapeXml(`a&b<c>d"e'f`)).toBe('a&amp;b&lt;c&gt;d&quot;e&apos;f');
  });

  it('escapes the ampersand first, so nothing is double-escaped', () => {
    expect(escapeXml('<')).toBe('&lt;');
    expect(escapeXml('&lt;')).toBe('&amp;lt;');
  });

  it('formats lastmod as a W3C datetime with an explicit UTC offset', () => {
    expect(w3cDateTime(new Date('2024-01-02T03:04:05.678Z'))).toBe('2024-01-02T03:04:05+00:00');
  });
});

// ---------------------------------------------------------------------------
// /sitemap.xml, against the database
// ---------------------------------------------------------------------------

describeWithDb('buildSitemap', () => {
  afterAll(async () => {
    await resetTestDb();
    resetContentUnverifiedCache();
  });

  it('lists home, /tours, /privacy and /terms', async () => {
    const xml = await buildSitemap();

    expect(xml).toContain(`<loc>${absoluteUrl('/')}</loc>`);
    expect(xml).toContain(`<loc>${absoluteUrl('/tours')}</loc>`);
    expect(xml).toContain(`<loc>${absoluteUrl('/privacy')}</loc>`);
    expect(xml).toContain(`<loc>${absoluteUrl('/terms')}</loc>`);
    expect(xml.match(/<loc>/g)).toHaveLength(4);
  });

  it('does NOT list tour or package detail URLs yet (D5 — no page behind them)', async () => {
    const xml = await buildSitemap();

    expect(xml).not.toContain('/tours/oslob');
    expect(xml).not.toContain('/packages/');

    // ...and the exclusion is a deliberate omission, not a missing feature:
    // the collector that Week 2D switches on already produces them.
    const detail = await detailUrls();
    expect(detail.map((entry) => entry.loc)).toContain(
      absoluteUrl('/tours/oslob-whale-shark-tumalog-falls'),
    );
    expect(detail.some((entry) => entry.loc.includes('/packages/'))).toBe(true);
  });

  it('uses updated_at for lastmod in W3C date format', async () => {
    const db = getDb();
    const known = new Date('2024-01-02T03:04:05Z');
    await db.update(settings).set({ updatedAt: known }).where(eq(settings.key, 'legal_privacy'));

    // The premise, asserted rather than assumed: the column really does hold
    // the date we wrote (drizzle's $onUpdateFn did not overwrite it).
    const [row] = await db
      .select({ updatedAt: settings.updatedAt })
      .from(settings)
      .where(eq(settings.key, 'legal_privacy'));
    expect(row?.updatedAt.toISOString()).toBe(known.toISOString());

    const privacy = (await collectSitemapUrls()).find(
      (entry) => entry.loc === absoluteUrl('/privacy'),
    );
    expect(privacy?.lastmod?.toISOString()).toBe(known.toISOString());
    expect(await buildSitemap()).toContain('<lastmod>2024-01-02T03:04:05+00:00</lastmod>');

    // Every lastmod the document carries is in the W3C form, not just that one.
    const lastmods = [...(await buildSitemap()).matchAll(/<lastmod>([^<]+)<\/lastmod>/g)].map(
      (match) => match[1],
    );
    expect(lastmods).toHaveLength(4);
    for (const value of lastmods) {
      expect(value).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+00:00$/);
    }
  });

  it('is well-formed XML with a urlset namespace', async () => {
    const xml = await buildSitemap();

    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>\n')).toBe(true);
    expect(xml).toContain('<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">');
    expect(xml.trimEnd().endsWith('</urlset>')).toBe(true);
    // Balanced elements...
    expect(xml.match(/<url>/g)).toHaveLength(4);
    expect(xml.match(/<\/url>/g)).toHaveLength(4);
    expect(xml.match(/<loc>/g)?.length).toBe(xml.match(/<\/loc>/g)?.length);
    // ...and no raw ampersand anywhere outside an entity, which is the one
    // way a database string can break a parser.
    expect(xml.replace(/&(amp|lt|gt|quot|apos);/g, '')).not.toContain('&');
  });

  it('omits inactive tours and packages once detail pages exist', async () => {
    const db = getDb();
    const tourSlug = 'oslob-whale-shark-tumalog-falls';
    const packageSlug = 'cebu-highlights-3d2n';

    // The guard is only meaningful if they are there to begin with.
    const before = (await detailUrls()).map((entry) => entry.loc);
    expect(before).toContain(absoluteUrl(`/tours/${tourSlug}`));
    expect(before).toContain(absoluteUrl(`/packages/${packageSlug}`));

    await db.update(tours).set({ isActive: false }).where(eq(tours.slug, tourSlug));
    await db.update(packages).set({ isActive: false }).where(eq(packages.slug, packageSlug));

    const after = (await detailUrls()).map((entry) => entry.loc);
    expect(after).not.toContain(absoluteUrl(`/tours/${tourSlug}`));
    expect(after).not.toContain(absoluteUrl(`/packages/${packageSlug}`));
    expect(after.length).toBe(before.length - 2);

    await resetTestDb();
  });

  it('sorts the detail URLs by slug, so two fetches are byte-identical', async () => {
    const tourLocs = (await detailUrls())
      .filter((entry) => entry.loc.includes('/tours/'))
      .map((entry) => entry.loc);

    expect(tourLocs).toEqual([...tourLocs].sort());
    expect(tourLocs.length).toBeGreaterThan(1);
  });
});

// ---------------------------------------------------------------------------
// Failure paths — the indexing gate is a control, so it has to fail closed
// ---------------------------------------------------------------------------

describeWithDb('readContentUnverified', () => {
  afterAll(async () => {
    await resetTestDb();
    resetContentUnverifiedCache();
  });

  it('fails closed when the setting cannot be read, and does not cache the failure', async () => {
    const db = getDb();

    await setContentUnverified(false);
    expect(await readContentUnverified()).toBe(false); // premise: it reads false

    resetContentUnverifiedCache();
    await db.delete(settings).where(eq(settings.key, 'content_unverified'));
    // Cannot prove the content is real => treat the site as unverified.
    expect(await readContentUnverified()).toBe(true);

    // The failure is not cached, so a transient outage does not pin the site
    // to noindex for a whole TTL.
    await db.insert(settings).values({ key: 'content_unverified', value: false });
    expect(await readContentUnverified()).toBe(false);
  });

  it('reuses the cached answer until the TTL expires', async () => {
    const start = 1_000_000;

    await setContentUnverified(false);
    expect(await readContentUnverified(start)).toBe(false);

    // Changed in the database behind the cache's back (no reset).
    await getDb()
      .update(settings)
      .set({ value: true })
      .where(eq(settings.key, 'content_unverified'));
    expect(await readContentUnverified(start + CONTENT_UNVERIFIED_TTL_MS - 1)).toBe(false);
    expect(await readContentUnverified(start + CONTENT_UNVERIFIED_TTL_MS)).toBe(true);
  });
});

describe('failure paths with no database', () => {
  it('sets noindex when the content flag read rejects outright', async () => {
    const app = express()
      .use(robotsHeader('production', () => Promise.reject(new Error('mysql said no'))))
      .get('/', (_req, res) => {
        res.send('ok');
      });

    const res = await request(app).get('/');

    expect(res.status).toBe(200);
    expect(res.headers['x-robots-tag']).toBe('noindex, nofollow');
  });

  it('answers /sitemap.xml with 503 — never an empty urlset — when generation fails', async () => {
    const boom = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:3306 for rg_travel'), {
      code: 'ECONNREFUSED',
    });
    const app = express().get(
      '/sitemap.xml',
      sitemapXmlHandler(() => Promise.reject(boom)),
    );

    const res = await request(app).get('/sitemap.xml');

    expect(res.status).toBe(503);
    expect(res.text).not.toContain('<urlset');
    // The response body leaks neither the message nor any connection detail.
    expect(res.text).not.toContain('ECONNREFUSED');
    expect(res.text).not.toContain('rg_travel');
    expect(res.text).not.toContain('3306');
  });
});

// ---------------------------------------------------------------------------
// Wired through Express
// ---------------------------------------------------------------------------

describeWithDb('crawl directives through createApp', () => {
  const dist = makeDist();
  const production = createApp('http://localhost:5180', dist, 'production');
  const preview = createApp('http://localhost:5180', dist, 'preview');

  beforeEach(() => {
    resetContentUnverifiedCache();
  });

  afterAll(async () => {
    await resetTestDb();
    resetContentUnverifiedCache();
  });

  it('serves /robots.txt as plain text, not the HTML shell', async () => {
    await setContentUnverified(false);
    const res = await request(production).get('/robots.txt');

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/plain');
    expect(res.text).not.toContain('<!doctype html');
    expect(res.text).toContain('Allow: /');
    expect(res.text).toContain(`Sitemap: ${absoluteUrl('/sitemap.xml')}`);
  });

  it('serves a /robots.txt that disallows everything while content is unverified', async () => {
    await setContentUnverified(true);
    const res = await request(production).get('/robots.txt');

    expect(res.status).toBe(200);
    expect(res.text).toMatch(/^Disallow: \/$/m);
    expect(res.text).not.toContain('Allow: /');
  });

  it('serves /sitemap.xml as XML in both content states', async () => {
    for (const unverified of [false, true]) {
      await setContentUnverified(unverified);
      const res = await request(production).get('/sitemap.xml');

      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toContain('xml');
      expect(res.text).toContain('<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">');
      expect(res.text).toContain(`<loc>${absoluteUrl('/')}</loc>`);
    }
  });

  it('leaves the public home page indexable in verified production', async () => {
    await setContentUnverified(false);
    // The flag really is false, read through the same path the app uses.
    expect(await readContentUnverified()).toBe(false);

    const res = await request(production).get('/');

    expect(res.status).toBe(200);
    expect(res.headers['x-robots-tag']).toBeUndefined();
    // The meta pipeline agrees: no robots tag in the shell either.
    expect(res.text).not.toContain('name="robots"');
    // And the response really is the resolved page, not an error or a 404
    // shell that would make the two assertions above vacuous.
    expect(res.text).toContain(`<link rel="canonical" href="${absoluteUrl('/')}">`);
  });

  it.each(['/admin', '/driver', '/portal', '/admin/bookings'])(
    'sets noindex on %s in verified production',
    async (path) => {
      await setContentUnverified(false);
      const res = await request(production).get(path);

      expect(res.headers['x-robots-tag']).toBe('noindex, nofollow');
      // These are not SPA routes yet, so the shell answers 404 — stated here
      // so the header assertion above is read in the right context.
      expect(res.status).toBe(404);
    },
  );

  it('sets noindex on every public path while content_unverified is true', async () => {
    await setContentUnverified(true);
    expect(await readContentUnverified()).toBe(true);

    for (const path of ['/', '/tours', '/privacy', '/terms']) {
      const res = await request(production).get(path);

      expect(res.status).toBe(200);
      expect(res.headers['x-robots-tag']).toBe('noindex, nofollow');
      // Both halves of the ruling: the header AND the meta tag.
      expect(res.text).toContain('<meta name="robots" content="noindex,nofollow">');
    }
  });

  it('sets noindex on static assets too while content_unverified is true', async () => {
    await setContentUnverified(true);
    const res = await request(production).get('/assets/app.css');

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/css');
    expect(res.headers['x-robots-tag']).toBe('noindex, nofollow');
  });

  it('sets noindex on every public path in the preview environment', async () => {
    await setContentUnverified(false);

    for (const path of ['/', '/tours', '/privacy', '/terms']) {
      const res = await request(preview).get(path);

      expect(res.status).toBe(200);
      expect(res.headers['x-robots-tag']).toBe('noindex, nofollow');
    }
  });

  it('does not shadow the API routes or the SPA shell', async () => {
    await setContentUnverified(false);

    expect((await request(production).get('/api/health')).body).toMatchObject({ ok: true });
    expect((await request(production).get('/tours')).text).toContain('<!doctype html');
  });
});
