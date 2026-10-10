/**
 * The route → `PageMeta` map for the public site, and the database reads
 * behind it.
 *
 * ONE module, used by BOTH surfaces (plan decision D6):
 *   - production: `server/src/html.ts`, mounted last in `app.ts`
 *   - development: the `rg-seo-dev` middleware in `client/vite.config.ts`
 * Neither surface may build meta of its own — if a title is wrong, it is
 * wrong here, in one place, for both.
 *
 * Nothing in here is HTML. Escaping is `seo/render.ts`'s job, and happens
 * once, for every value, there. A resolver returning markup would smuggle an
 * un-escaped database string past that boundary.
 *
 * Task 4.2 added the JSON-LD each route publishes: the nodes themselves are
 * built by the pure builders in `seo/jsonld.ts`, and this module's only job
 * is to hand them the rows and settings they need.
 */
import { formatPeso } from '@rg/shared';
import { and, asc, eq, sql } from 'drizzle-orm';
import {
  readContentUnverified,
  readSettingBlock,
  resolvePaymentMethods,
} from '../content/settings';
import { getDb } from '../db/client';
import { destinations, packages, tourImages, tourPriceTiers, tours } from '../db/schema';
import { env } from '../env';
import { realAggregate } from '../services/ratings';
import { BRAND, LEGAL_OPERATOR } from './brand';
import {
  aggregateRatingNode,
  faqPageNode,
  touristTripNode,
  travelAgencyNode,
  type JsonLdNode,
} from './jsonld';
import type { PageMeta, Resolver } from './types';

/** Meta descriptions longer than this are truncated (5A). */
const MAX_DESCRIPTION = 155;

// ---------------------------------------------------------------------------
// Paths and URLs
// ---------------------------------------------------------------------------

/**
 * Lowercases, and drops a trailing slash so `/tours/` and `/tours` are one
 * page with one canonical URL. `/` stays `/`.
 *
 * Lowercasing covers the slug segments too, deliberately: every slug in the
 * database is lowercase, so `/Tours/OSLOB-...` resolves to the same tour
 * instead of 404ing, and its canonical tag points at the one lowercase URL.
 */
export function normalisePath(pathname: string): string {
  const trimmed = pathname.toLowerCase().replace(/\/+$/, '');
  return trimmed === '' ? '/' : trimmed;
}

/**
 * Absolute URL for a site-relative path, from `PUBLIC_BASE_URL` (default
 * `http://localhost:5180`; the production value comes from the deploy .env).
 * An already-absolute URL is returned untouched, so an `og_image` row holding
 * a full CDN URL still works.
 */
export function absoluteUrl(path: string): string {
  if (/^https?:\/\//i.test(path)) return path;
  const base = env.PUBLIC_BASE_URL.replace(/\/+$/, '');
  return `${base}${path.startsWith('/') ? path : `/${path}`}`;
}

// ---------------------------------------------------------------------------
// Text helpers
// ---------------------------------------------------------------------------

/** A trimmed non-empty string, or null — an empty `seo_title` means "fall back", not "use an empty title". */
function nonEmpty(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

/**
 * Collapses whitespace (an `about` column holds multi-line prose) and cuts to
 * at most `max` characters INCLUDING the ellipsis, on a word boundary where
 * one is near enough to the limit to look deliberate.
 */
function truncate(text: string, max: number = MAX_DESCRIPTION): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat.length <= max) return flat;

  const cut = flat.slice(0, max - 1);
  const lastSpace = cut.lastIndexOf(' ');
  const body = lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut;
  return `${body.replace(/[\s,;:.–—-]+$/, '')}…`;
}

/** First non-empty candidate, as an absolute URL — the `og:image` fallback chain. */
function firstImageUrl(...candidates: Array<string | null | undefined>): string | null {
  for (const candidate of candidates) {
    const path = nonEmpty(candidate);
    if (path) return absoluteUrl(path);
  }
  return null;
}

// ---------------------------------------------------------------------------
// Database reads
//
// Each loader returns exactly the columns the meta (and task 4.2's JSON-LD)
// needs, and returns null — never throws — for a slug that is missing or
// soft-deleted, because "no such tour" is a 404 page, not a server error.
// ---------------------------------------------------------------------------

/** One tour's SEO inputs: its own columns, its destination, its lowest price tier and its first image. */
export interface TourSeoRow {
  id: number;
  slug: string;
  title: string;
  summary: string | null;
  about: string | null;
  durationHours: number | null;
  seoTitle: string | null;
  seoDescription: string | null;
  ogImage: string | null;
  destinationName: string;
  destinationSlug: string;
  /** Integer centavos — MIN(price_per_person) across tiers. Null when a tour has no tiers. */
  fromPriceCentavos: number | null;
  /** `tour_images.path` of the lowest-sorted image, or null. */
  firstImagePath: string | null;
}

/** One package's SEO inputs. `newPriceCentavos` is NOT NULL in the schema. */
export interface PackageSeoRow {
  id: number;
  slug: string;
  title: string;
  days: number;
  description: string | null;
  seoTitle: string | null;
  seoDescription: string | null;
  ogImage: string | null;
  imagePath: string | null;
  /** Integer centavos. */
  newPriceCentavos: number;
  /** Integer centavos, or null when there is no "was" price. */
  oldPriceCentavos: number | null;
}

/**
 * The published tour behind a slug, or null.
 *
 * Soft deletes count on BOTH sides, exactly as `tours.bySlug` treats them
 * (I1): an inactive tour and a tour under an inactive destination are both
 * "not publicly visible", so both resolve to a 404 page rather than to meta
 * for a page the site no longer offers.
 */
export async function loadTourSeo(slug: string): Promise<TourSeoRow | null> {
  const db = getDb();
  const [row] = await db
    .select({
      id: tours.id,
      slug: tours.slug,
      title: tours.title,
      summary: tours.summary,
      about: tours.about,
      durationHours: tours.durationHours,
      seoTitle: tours.seoTitle,
      seoDescription: tours.seoDescription,
      ogImage: tours.ogImage,
      destinationName: destinations.name,
      destinationSlug: destinations.slug,
      fromPriceCentavos: sql<string | null>`min(${tourPriceTiers.pricePerPerson})`,
    })
    .from(tours)
    .innerJoin(destinations, eq(tours.destinationId, destinations.id))
    .leftJoin(tourPriceTiers, eq(tourPriceTiers.tourId, tours.id))
    .where(and(eq(tours.slug, slug), eq(tours.isActive, true), eq(destinations.isActive, true)))
    // Every selected non-aggregate column, as this server's ONLY_FULL_GROUP_BY requires.
    .groupBy(
      tours.id,
      tours.slug,
      tours.title,
      tours.summary,
      tours.about,
      tours.durationHours,
      tours.seoTitle,
      tours.seoDescription,
      tours.ogImage,
      destinations.name,
      destinations.slug,
    );

  if (!row) return null;

  const [image] = await db
    .select({ path: tourImages.path })
    .from(tourImages)
    .where(eq(tourImages.tourId, row.id))
    // `id` breaks a sort_order tie deterministically (I3) — the same order
    // the catalog uses, so the OG image matches the card image.
    .orderBy(asc(tourImages.sortOrder), asc(tourImages.id))
    .limit(1);

  return {
    ...row,
    fromPriceCentavos: row.fromPriceCentavos === null ? null : Number(row.fromPriceCentavos),
    firstImagePath: image?.path ?? null,
  };
}

/** The published package behind a slug, or null. */
export async function loadPackageSeo(slug: string): Promise<PackageSeoRow | null> {
  const db = getDb();
  const [row] = await db
    .select({
      id: packages.id,
      slug: packages.slug,
      title: packages.title,
      days: packages.days,
      description: packages.description,
      seoTitle: packages.seoTitle,
      seoDescription: packages.seoDescription,
      ogImage: packages.ogImage,
      imagePath: packages.imagePath,
      newPriceCentavos: packages.newPrice,
      oldPriceCentavos: packages.oldPrice,
    })
    .from(packages)
    .where(and(eq(packages.slug, slug), eq(packages.isActive, true)));

  return row ?? null;
}

/**
 * `site_seo` + `hero` — the last two links of every page's `og:image`
 * fallback chain, and the home page's own title and description. Two
 * primary-key reads in one round trip's worth of latency.
 */
async function readSiteBlocks() {
  const [siteSeo, hero] = await Promise.all([
    readSettingBlock('site_seo'),
    readSettingBlock('hero'),
  ]);
  return { siteSeo, hero };
}

// ---------------------------------------------------------------------------
// JSON-LD inputs (4.2)
//
// The nodes are built by `seo/jsonld.ts`, which is pure; everything below
// only fetches what those builders need. The rating is ALWAYS
// `realAggregate()` — published reviews with `is_sample = 0` — never
// `displayAggregate()` and never `settings.trust.ratingAverage`.
// ---------------------------------------------------------------------------

/**
 * The organization node every indexable page carries, plus the review
 * threshold its page-level nodes need, in one round trip's worth of latency.
 *
 * The site-wide `aggregateRating` passes through the same gate as a tour's:
 * `realAggregate()` with no tour filter today returns null (every seeded
 * review is a sample), so the key is absent from the emitted node.
 */
async function buildSiteGraph(
  description: string,
  imageUrl: string | null,
): Promise<{ agency: JsonLdNode; minReviewsForRating: number }> {
  const [contact, businessHours, trust, aggregate] = await Promise.all([
    readSettingBlock('contact'),
    readSettingBlock('business_hours'),
    readSettingBlock('trust'),
    realAggregate(),
  ]);

  return {
    agency: travelAgencyNode({
      siteUrl: absoluteUrl('/'),
      description,
      imageUrl,
      contact,
      businessHours,
      rating: aggregateRatingNode(aggregate, trust.minReviewsForRating),
    }),
    minReviewsForRating: trust.minReviewsForRating,
  };
}

// ---------------------------------------------------------------------------
// 5A fallbacks — applied when seo_title / seo_description are empty
// ---------------------------------------------------------------------------

function tourTitle(tour: TourSeoRow): string {
  const explicit = nonEmpty(tour.seoTitle);
  if (explicit) return explicit;

  const price = tour.fromPriceCentavos === null ? null : formatPeso(tour.fromPriceCentavos);
  const from = price ? ` from ${price}` : '';
  return `${tour.title} — ${tour.destinationName} day tour${from} | ${BRAND}`;
}

function tourDescription(tour: TourSeoRow): string {
  // Admin-entered copy is used verbatim — only the generated FALLBACKS below
  // are truncated. Silently cutting a deliberate `seo_description` would be
  // the tool editing the client's words.
  const explicit = nonEmpty(tour.seoDescription);
  if (explicit) return explicit;

  const prose = nonEmpty(tour.summary) ?? nonEmpty(tour.about);
  if (prose) return truncate(prose);

  const price = tour.fromPriceCentavos === null ? null : formatPeso(tour.fromPriceCentavos);
  const from = price ? `, from ${price} per person` : '';
  return `Book the ${tour.title} day tour in ${tour.destinationName} with ${BRAND}. Private van, licensed driver${from}.`;
}

function packageTitle(pkg: PackageSeoRow): string {
  const explicit = nonEmpty(pkg.seoTitle);
  if (explicit) return explicit;

  return `${pkg.title} — ${pkg.days}-day Cebu package from ${formatPeso(pkg.newPriceCentavos)} | ${BRAND}`;
}

function packageDescription(pkg: PackageSeoRow): string {
  const explicit = nonEmpty(pkg.seoDescription);
  if (explicit) return explicit;

  const prose = nonEmpty(pkg.description);
  if (prose) return truncate(prose);

  return `Book the ${pkg.title}, a ${pkg.days}-day Cebu package with ${BRAND}. Private van, licensed driver, from ${formatPeso(pkg.newPriceCentavos)} per person.`;
}

// ---------------------------------------------------------------------------
// Resolvers
// ---------------------------------------------------------------------------

/**
 * The meta for a path with no page behind it — an unknown route, or a known
 * route whose slug does not resolve to published content.
 *
 * Pure, and deliberately so: a crawler hammering nonsense URLs must not cost
 * a settings read each time, and a 404 shell must still render when the
 * database is unreachable. `canonical` echoes the requested (normalised) path
 * rather than claiming to be the home page; `noindex,nofollow` is what
 * actually keeps it out of the index.
 */
export function notFoundMeta(pathname: string): PageMeta {
  return {
    title: `Page not found | ${BRAND}`,
    description: `This page does not exist. Browse Cebu day tours and multi-day packages on ${BRAND}.`,
    canonical: absoluteUrl(normalisePath(pathname)),
    ogImage: null,
    ogType: 'website',
    jsonLd: [],
    status: 404,
    robots: 'noindex,nofollow',
  };
}

const resolveHome: Resolver = async () => {
  const { siteSeo, hero } = await readSiteBlocks();
  const ogImage = firstImageUrl(siteSeo.ogImage, hero.imagePath);

  const [{ agency }, faqs, paymentMethods] = await Promise.all([
    buildSiteGraph(siteSeo.description, ogImage),
    readSettingBlock('faqs'),
    readSettingBlock('payment_methods'),
  ]);
  // Omitted, not emitted empty, when there are no FAQs to publish.
  const faq = faqPageNode(faqs, resolvePaymentMethods(paymentMethods));

  return {
    title: siteSeo.title,
    description: siteSeo.description,
    canonical: absoluteUrl('/'),
    ogImage,
    ogType: 'website',
    jsonLd: faq ? [agency, faq] : [agency],
    status: 200,
    robots: 'index,follow',
  };
};

/**
 * `/tours` — the catalog index. Its title is navigational and lives here
 * rather than in `settings`: there is no `settings` key for it, and inventing
 * one would be a schema change this task does not own. Its description is the
 * site description, so there is no invented marketing copy on the page.
 */
const resolveToursIndex: Resolver = async () => {
  const { siteSeo, hero } = await readSiteBlocks();
  const ogImage = firstImageUrl(siteSeo.ogImage, hero.imagePath);
  // The organization only. No ItemList of tours: a carousel of links to
  // /tours/:slug would point at pages the SPA does not render yet (D5), and
  // no CollectionPage node earns a rich result.
  const { agency } = await buildSiteGraph(siteSeo.description, ogImage);

  return {
    title: `Cebu Day Tours | ${BRAND}`,
    description: siteSeo.description,
    canonical: absoluteUrl('/tours'),
    ogImage,
    ogType: 'website',
    jsonLd: [agency],
    status: 200,
    robots: 'index,follow',
  };
};

/** The two legal pages. Titles match the `<h1>` the markdown in `settings.legal_*` renders. */
const LEGAL_PAGES = {
  privacy: {
    path: '/privacy',
    title: `Privacy Notice | ${BRAND}`,
    description: `How ${BRAND} (operated by ${LEGAL_OPERATOR}) collects, uses and protects your personal data under the Data Privacy Act of 2012 (RA 10173).`,
  },
  terms: {
    path: '/terms',
    title: `Terms of Service | ${BRAND}`,
    description: `Booking, payment, cancellation and safety terms for Cebu tours operated by ${LEGAL_OPERATOR}.`,
  },
} as const;

function resolveLegal(page: keyof typeof LEGAL_PAGES): Resolver {
  return async () => {
    const { siteSeo, hero } = await readSiteBlocks();
    const copy = LEGAL_PAGES[page];
    const ogImage = firstImageUrl(siteSeo.ogImage, hero.imagePath);
    // The organization only — the identity behind the policy. The policy
    // text itself is prose; there is no Schema.org type a crawler does
    // anything useful with here.
    const { agency } = await buildSiteGraph(siteSeo.description, ogImage);

    return {
      title: copy.title,
      description: copy.description,
      canonical: absoluteUrl(copy.path),
      ogImage,
      ogType: 'article',
      jsonLd: [agency],
      status: 200,
      robots: 'index,follow',
    };
  };
}

const resolveTour: Resolver = async (params) => {
  const slug = params.slug ?? '';
  const [tour, site] = await Promise.all([loadTourSeo(slug), readSiteBlocks()]);
  if (!tour) return notFoundMeta(`/tours/${slug}`);

  const canonical = absoluteUrl(`/tours/${tour.slug}`);
  const description = tourDescription(tour);
  const ogImage = firstImageUrl(
    tour.ogImage,
    tour.firstImagePath,
    site.siteSeo.ogImage,
    site.hero.imagePath,
  );

  const [{ agency, minReviewsForRating }, aggregate] = await Promise.all([
    buildSiteGraph(site.siteSeo.description, ogImage),
    // Samples excluded, so a tour carrying only seeded reviews publishes no
    // rating at all — the key is absent, never a zero.
    realAggregate(tour.id),
  ]);

  return {
    title: tourTitle(tour),
    description,
    canonical,
    ogImage,
    ogType: 'website',
    jsonLd: [
      touristTripNode({
        name: tour.title,
        url: canonical,
        description,
        imageUrl: ogImage,
        priceCentavos: tour.fromPriceCentavos,
        destinationName: tour.destinationName,
        siteUrl: absoluteUrl('/'),
        rating: aggregateRatingNode(aggregate, minReviewsForRating),
      }),
      agency,
    ],
    status: 200,
    // D5: the resolver is complete and tested, but NO PAGE RENDERS THIS URL
    // yet — the SPA has no /tours/:slug route, so the shell would be served
    // with correct meta over an empty body. Serving that to a crawler as
    // indexable would be the one thing worse than not having the page.
    // WEEK 2D: delete this line (and uncomment the sitemap's detail URLs in
    // seo/sitemap.ts) in the same task that builds the detail page.
    robots: 'noindex,nofollow',
  };
};

const resolvePackage: Resolver = async (params) => {
  const slug = params.slug ?? '';
  const [pkg, site] = await Promise.all([loadPackageSeo(slug), readSiteBlocks()]);
  if (!pkg) return notFoundMeta(`/packages/${slug}`);

  const canonical = absoluteUrl(`/packages/${pkg.slug}`);
  const description = packageDescription(pkg);
  const ogImage = firstImageUrl(
    pkg.ogImage,
    pkg.imagePath,
    site.siteSeo.ogImage,
    site.hero.imagePath,
  );
  const { agency } = await buildSiteGraph(site.siteSeo.description, ogImage);

  return {
    title: packageTitle(pkg),
    description,
    canonical,
    ogImage,
    ogType: 'website',
    jsonLd: [
      touristTripNode({
        name: pkg.title,
        url: canonical,
        description,
        imageUrl: ogImage,
        // The discounted price guests actually pay. `old_price` is a
        // strike-through display figure, not an offer.
        priceCentavos: pkg.newPriceCentavos,
        siteUrl: absoluteUrl('/'),
        // `reviews` rows join to a TOUR (`reviews.tour_id`); nothing in the
        // schema links a review to a package, so no package can ever have a
        // real aggregate to publish. Hard-coded undefined, not a lookup.
        rating: undefined,
      }),
      agency,
    ],
    status: 200,
    // D5, same as /tours/:slug above. WEEK 2D: delete this line.
    robots: 'noindex,nofollow',
  };
};

// ---------------------------------------------------------------------------
// The route table
// ---------------------------------------------------------------------------

export interface RouteEntry {
  /** Path pattern. A `:name` segment captures into `params.name`. */
  pattern: string;
  resolve: Resolver;
}

/**
 * Every public URL shape the site answers, most specific first is NOT
 * required — patterns are matched by segment count and literal segments, so
 * `/tours` and `/tours/:slug` cannot collide.
 *
 * This is the list task 4.3's sitemap walks and the list Week 2D extends.
 */
export const ROUTES: RouteEntry[] = [
  { pattern: '/', resolve: resolveHome },
  { pattern: '/tours', resolve: resolveToursIndex },
  { pattern: '/tours/:slug', resolve: resolveTour },
  { pattern: '/packages/:slug', resolve: resolvePackage },
  { pattern: '/privacy', resolve: resolveLegal('privacy') },
  { pattern: '/terms', resolve: resolveLegal('terms') },
];

export interface RouteMatch {
  /** The matched entry's pattern — handy for logging and for task 4.3. */
  pattern: string;
  resolve: Resolver;
  params: Record<string, string>;
}

/**
 * Finds the route for a pathname, or null when nothing matches.
 *
 * A hand-rolled segment comparison on purpose: a path matcher is twenty lines
 * and this project adds no dependency it does not need. Trailing slashes and
 * letter case are normalised away first (see `normalisePath`).
 */
export function matchRoute(pathname: string): RouteMatch | null {
  const segments = normalisePath(pathname).split('/');

  for (const route of ROUTES) {
    const patternSegments = route.pattern.split('/');
    if (patternSegments.length !== segments.length) continue;

    const params: Record<string, string> = {};
    let matched = true;

    for (let i = 0; i < patternSegments.length; i += 1) {
      // `?? ''` only satisfies noUncheckedIndexedAccess — both arrays are
      // the same length by the guard above, so neither index is ever absent.
      const expected = patternSegments[i] ?? '';
      const actual = segments[i] ?? '';

      if (expected.startsWith(':')) {
        // No empty-capture guard here on purpose: `normalisePath` has already
        // removed every trailing slash, so a `:slug` position can never be an
        // empty segment — a guard for it would be a branch no test could ever
        // reach. And were one to slip through, `loadTourSeo('')` finds no row
        // and the page 404s, which is the right answer anyway.
        params[expected.slice(1)] = actual;
      } else if (expected !== actual) {
        matched = false;
        break;
      }
    }

    if (matched) return { pattern: route.pattern, resolve: route.resolve, params };
  }

  return null;
}

/**
 * The one entry point both injection surfaces call: pathname in, `PageMeta`
 * out, 404 meta for anything that does not resolve. Never throws for an
 * unknown path — only a database failure can throw, and both callers treat
 * that as "serve the un-injected shell".
 *
 * Task 4.3 added the site-wide gate at the end: while
 * `settings.content_unverified` is true, the database holds placeholder
 * tours, placeholder prices and `is_sample` reviews, and EVERY route is
 * served `noindex,nofollow` regardless of what its own resolver asked for.
 * Each resolver still states its own intent (`/` is `index,follow`), because
 * that intent is what takes effect the moment an admin clears the flag.
 *
 * The gate lives here, in the one function both surfaces call, rather than in
 * each resolver — a resolver added later cannot forget it. `SITE_ENV` is
 * deliberately NOT part of this: a preview deploy is a transport-level fact,
 * enforced by the `X-Robots-Tag` header and robots.txt (which is the stronger
 * signal anyway), and reading it here would make the meta tag depend on an
 * import-time environment variable no test could vary.
 */
export async function resolvePage(pathname: string): Promise<PageMeta> {
  const match = matchRoute(pathname);
  if (!match) return notFoundMeta(pathname);

  const meta = await match.resolve(match.params);
  // Fails closed: an unreadable flag resolves to "unverified" (see
  // readContentUnverified), so the shell is served noindex rather than
  // indexable-by-accident.
  return (await readContentUnverified()) ? { ...meta, robots: 'noindex,nofollow' } : meta;
}
