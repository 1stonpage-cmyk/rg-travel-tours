/**
 * `/sitemap.xml` and `/robots.txt` — generated from the database on every
 * request, per the BUILD_SPEC "SEO note (Vite SPA)" bullet: *"Generate
 * /sitemap.xml and /robots.txt dynamically."*
 *
 * Built by hand, with no XML dependency. A sitemap is six tag names and an
 * escaper; pulling in a library to concatenate strings would be a dependency
 * this project does not need (CLAUDE.md: prefer simple solutions). The
 * escaper is the part that actually matters, so it is one function, applied
 * to every value, with its own test.
 *
 * Two rules this file exists to keep:
 *
 *  - **A sitemap must never list a URL whose OWN RESOLVER says `noindex`** —
 *    the per-route decision, not the site-wide `content_unverified` gate
 *    (CLAUDE.md's SEO section; corrected 2026-10-30, BUG-121 — the flat
 *    absolute this used to say is literally false while the site-wide gate
 *    is off, since it would forbid any URL at all from ever being listed).
 *    So the detail URLs are collected, filtered and sorted here
 *    (`detailUrls()`), split by kind (`buildTourDetailUrls`/
 *    `buildPackageDetailUrls`), and both halves are emitted (Week 7 plan,
 *    Tasks 2 and 3) — see `collectSitemapUrls`.
 *  - **`lastmod` is read, never invented.** Every date below comes from an
 *    `updated_at` column. A sitemap that claims today's date for every URL on
 *    every fetch trains crawlers to ignore the field.
 *
 * `PUBLIC_BASE_URL` drives every absolute URL (via `absoluteUrl`). It
 * currently defaults to `http://localhost:5180`; the production value is set
 * in the deploy `.env`, not here.
 */
import { and, asc, eq } from 'drizzle-orm';
import type { RequestHandler } from 'express';
import { readContentUnverified } from '../content/settings';
import { getDb } from '../db/client';
import { destinations, packages, settings, tours } from '../db/schema';
import type { SiteEnv } from '../env';
import { NOINDEX_PATH_PREFIXES } from '../middleware/robots-header';
import { absoluteUrl } from './resolvers';

/** One `<url>` element: where it is, and when its content last changed. */
export interface SitemapEntry {
  /** Absolute URL. */
  loc: string;
  /** From an `updated_at` column, or null when nothing in the database dates this page. */
  lastmod: Date | null;
}

// ---------------------------------------------------------------------------
// XML
// ---------------------------------------------------------------------------

/**
 * Escapes a string for XML character data and attribute values.
 *
 * All five predefined entities, not just the three a `<loc>` strictly needs:
 * slugs and (from Week 2D) titles are admin-editable database content, and an
 * escaper with exceptions is an escaper someone will eventually reuse in the
 * one place the exception matters. `&` goes first, or the ampersands the later
 * replacements introduce get escaped twice.
 */
export function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * A `Date` as the W3C datetime `lastmod` wants: complete date plus hours,
 * minutes and seconds, with an explicit UTC offset.
 *
 * `+00:00` rather than `Z`: both are valid W3C/ISO 8601, and the offset form
 * is the one the sitemaps.org examples use. Milliseconds are dropped — they
 * are noise in a "when did this page change" field.
 */
export function w3cDateTime(date: Date): string {
  return date.toISOString().replace(/\.\d+Z$/, '+00:00');
}

// ---------------------------------------------------------------------------
// Database reads
// ---------------------------------------------------------------------------

/**
 * Everything both URL collectors need, in one round trip's worth of latency.
 *
 * `is_active` is filtered HERE, once, for both of them — and on both sides
 * for tours, exactly as `loadTourSeo` treats soft deletes (I1): a tour under
 * an inactive destination is not publicly visible either. Sorted by slug so
 * the emitted XML is byte-stable between requests, which makes a diff of two
 * fetches mean something.
 */
async function loadSitemapRows() {
  const db = getDb();

  const [settingRows, tourRows, packageRows] = await Promise.all([
    db.select({ key: settings.key, updatedAt: settings.updatedAt }).from(settings),
    db
      .select({ slug: tours.slug, updatedAt: tours.updatedAt })
      .from(tours)
      .innerJoin(destinations, eq(tours.destinationId, destinations.id))
      .where(and(eq(tours.isActive, true), eq(destinations.isActive, true)))
      .orderBy(asc(tours.slug)),
    db
      .select({ slug: packages.slug, updatedAt: packages.updatedAt })
      .from(packages)
      .where(eq(packages.isActive, true))
      .orderBy(asc(packages.slug)),
  ]);

  return { settingRows, tourRows, packageRows };
}

type SitemapRows = Awaited<ReturnType<typeof loadSitemapRows>>;

/** The newest of some dates, or null when there are none. */
function newest(dates: Array<Date | null | undefined>): Date | null {
  let latest: Date | null = null;
  for (const date of dates) {
    if (date && (!latest || date > latest)) latest = date;
  }
  return latest;
}

/**
 * `/tours/:slug` and `/packages/:slug`, already filtered by `is_active` and
 * sorted by slug.
 *
 * Exported and tested. Both halves are now in the sitemap (Week 7 plan,
 * Tasks 2 and 3): `/tours/:slug` and `/packages/:slug` both render, and
 * `resolveTour`/`resolvePackage` both answer `index,follow`, so
 * `collectSitemapUrls` appends `buildTourDetailUrls` and
 * `buildPackageDetailUrls` below.
 */
export async function detailUrls(): Promise<SitemapEntry[]> {
  const rows = await loadSitemapRows();
  return [...buildTourDetailUrls(rows), ...buildPackageDetailUrls(rows)];
}

function buildTourDetailUrls(rows: SitemapRows): SitemapEntry[] {
  return rows.tourRows.map((tour) => ({
    loc: absoluteUrl(`/tours/${tour.slug}`),
    lastmod: tour.updatedAt,
  }));
}

function buildPackageDetailUrls(rows: SitemapRows): SitemapEntry[] {
  return rows.packageRows.map((pkg) => ({
    loc: absoluteUrl(`/packages/${pkg.slug}`),
    lastmod: pkg.updatedAt,
  }));
}

/**
 * Every indexable URL on the site, in crawl-priority order (home first).
 *
 * The four static routes are exactly the `index,follow` entries of
 * `ROUTES` in seo/resolvers.ts. Their `lastmod` comes from the `settings`
 * rows that actually render them: the home page shows nearly every block, so
 * it takes the newest of all of them; `/tours` is dated by its newest tour
 * and falls back to settings when the catalog is empty.
 *
 * All four legal pages (`/privacy`, `/terms`, `/refund-policy`, `/cookies`) are static content
 * now (task 2B, 2026-10-27 — see docs/superpowers/plans/2026-10-27-legal-pages.md), not rendered
 * from a `settings` row any more. There is no `updated_at` left to read for them, and this file's
 * own rule is "read, never invented" — so `lastmod` is omitted for all four (`null`; the renderer
 * below drops the `<lastmod>` tag entirely rather than emit a guessed date).
 */
export async function collectSitemapUrls(): Promise<SitemapEntry[]> {
  const rows = await loadSitemapRows();
  const settingsNewest = newest(rows.settingRows.map((row) => row.updatedAt));

  return [
    { loc: absoluteUrl('/'), lastmod: settingsNewest },
    {
      loc: absoluteUrl('/tours'),
      lastmod: newest(rows.tourRows.map((tour) => tour.updatedAt)) ?? settingsNewest,
    },
    { loc: absoluteUrl('/privacy'), lastmod: null },
    { loc: absoluteUrl('/terms'), lastmod: null },
    { loc: absoluteUrl('/refund-policy'), lastmod: null },
    { loc: absoluteUrl('/cookies'), lastmod: null },

    // Tour detail pages render now and `resolveTour` answers `index,follow`
    // (Task 2, Week 7 plan) — a sitemap may not list a URL whose own
    // resolver says noindex, and an indexable URL must be in the sitemap,
    // so both changes shipped in one commit. `buildTourDetailUrls` already
    // filters `is_active` on both sides and sorts by slug, so there is
    // nothing else to write here.
    ...buildTourDetailUrls(rows),

    // Package detail pages render now too (Task 3, Week 7 plan) and
    // `resolvePackage` answers `index,follow` — same reasoning as the tour
    // half above, shipped in the same commit as that page and that robots
    // line's deletion.
    ...buildPackageDetailUrls(rows),
  ];
}

// ---------------------------------------------------------------------------
// The two documents
// ---------------------------------------------------------------------------

/** The sitemap XML, as a crawler receives it. */
export async function buildSitemap(): Promise<string> {
  const entries = await collectSitemapUrls();

  const urls = entries.map((entry) => {
    const lines = [`    <loc>${escapeXml(entry.loc)}</loc>`];
    // Omitted rather than guessed when the database has no date for a page.
    if (entry.lastmod) lines.push(`    <lastmod>${w3cDateTime(entry.lastmod)}</lastmod>`);
    return `  <url>\n${lines.join('\n')}\n  </url>`;
  });

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    ...urls,
    '</urlset>',
    '',
  ].join('\n');
}

/**
 * robots.txt.
 *
 * Both arguments are REQUIRED, with no defaults. A default on either one
 * would be a silent decision about whether the whole site is crawlable, and
 * the fail-closed value (`'development'`, `true`) is not the value a caller
 * who forgot the argument usually wants — so the type system asks instead.
 *
 * Indexing is allowed in exactly one case: a production deploy whose content
 * flag has been cleared. Everything else — preview, development, or real
 * placeholder content still in the database — gets a blanket `Disallow: /`.
 * The reason is not named in the file: robots.txt is world-readable, and
 * which internal environment serves it is nobody else's business.
 */
export function buildRobots(siteEnv: SiteEnv, contentUnverified: boolean): string {
  if (siteEnv !== 'production' || contentUnverified) {
    return [
      '# This site is not currently published for indexing.',
      'User-agent: *',
      'Disallow: /',
      '',
      // No `Sitemap:` line: pointing a crawler at a list of URLs it has just
      // been told it may not fetch is a contradiction, not a courtesy.
    ].join('\n');
  }

  return [
    'User-agent: *',
    'Allow: /',
    // Prefix matches, so these cover `/admin/bookings` and friends too.
    // Same list the X-Robots-Tag middleware enforces — robots.txt asks
    // politely, the header is what actually binds.
    ...NOINDEX_PATH_PREFIXES.map((prefix) => `Disallow: ${prefix}`),
    '',
    `Sitemap: ${absoluteUrl('/sitemap.xml')}`,
    '',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Express handlers (mounted in app.ts ABOVE the SPA catch-all)
// ---------------------------------------------------------------------------

/** `GET /robots.txt`. Cannot fail: the flag read fails closed, the rest is pure. */
export function robotsTxtHandler(siteEnv: SiteEnv): RequestHandler {
  return async (_req, res) => {
    const contentUnverified = await readContentUnverified();
    res.type('text/plain; charset=utf-8').send(buildRobots(siteEnv, contentUnverified));
  };
}

/**
 * `GET /sitemap.xml`.
 *
 * A database failure answers 503, not 200 with an empty `<urlset>`: an empty
 * sitemap is a positive statement that the site has no pages, and a crawler
 * will cache it. 503 is the documented "come back later". The log names the
 * error's `code` only — never the message, which can echo connection details,
 * and never DATABASE_URL (CLAUDE.md security rules, same as html.ts).
 *
 * `build` is injectable so that failure path has a test: a database outage is
 * not something a test suite can arrange against a live connection, and an
 * untested error branch in a route that logs is exactly where a leak hides.
 */
export function sitemapXmlHandler(build: () => Promise<string> = buildSitemap): RequestHandler {
  return async (_req, res) => {
    try {
      res.type('application/xml').send(await build());
    } catch (error) {
      const code = (error as { code?: string }).code ?? 'unknown error';
      console.error(`[seo] sitemap generation failed (${code}); answering 503.`);
      res.status(503).type('text/plain; charset=utf-8').send('Sitemap temporarily unavailable.\n');
    }
  };
}
