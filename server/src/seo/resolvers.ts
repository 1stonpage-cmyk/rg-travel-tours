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
import {
  APP_SURFACE_TITLES,
  formatPeso,
  HERO_IMAGE_PRELOAD,
  STATIC_PUBLIC_TITLES,
} from '@rg/shared';
import { and, asc, eq, sql } from 'drizzle-orm';
import {
  readContentUnverified,
  readSettingBlock,
  resolvePaymentMethods,
} from '../content/settings';
import { getDb } from '../db/client';
import { destinations, packages, tourImages, tourPriceTiers, tours } from '../db/schema';
import { env } from '../env';
import { isPrivatePath, type NOINDEX_PATH_PREFIXES } from '../middleware/robots-header';
import { realAggregate } from '../services/ratings';
import { BRAND, LEGAL_OPERATOR } from './brand';
import {
  aggregateRatingNode,
  faqPageNode,
  touristTripNode,
  travelAgencyNode,
  type JsonLdNode,
} from './jsonld';
import type { ImagePreload, PageMeta, Resolver } from './types';

/** Meta descriptions longer than this are truncated (5A). */
const MAX_DESCRIPTION = 155;

/**
 * The hero preload the home page carries, and no other route does (4.4b).
 *
 * The candidate list itself lives in `@rg/shared` because HeroSection's WebP
 * `<source>` renders from the same constant — see its comment there for why
 * they may never be two separate literals.
 */
const HERO_PRELOAD: ImagePreload = HERO_IMAGE_PRELOAD;

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
  /** Integer centavos — MIN(price_per_person_centavos) across tiers. Null when a tour has no tiers. */
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
      fromPriceCentavos: sql<string | null>`min(${tourPriceTiers.pricePerPersonCentavos})`,
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
      newPriceCentavos: packages.newPriceCentavos,
      oldPriceCentavos: packages.oldPriceCentavos,
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
    // A 404 shell renders the not-found page, never the hero.
    preload: null,
    status: 404,
    robots: 'noindex,nofollow',
  };
}

/**
 * What each app surface calls itself, keyed by the exact prefixes the
 * `X-Robots-Tag` middleware treats as private. Typed against that list, so a
 * surface added there without a title here is a compile error rather than a
 * crash on a driver's phone.
 *
 * The title WORDS come from `APP_SURFACE_TITLES` (`@rg/shared`) because the
 * SPA re-asserts them as `document.title` on client-side navigation (Task
 * 17, item 4) — the browser is a third reader of these names, and a map of
 * its own in the client would be the drifting copy "never build meta in a
 * surface" exists to prevent. The descriptions stay here: they are meta, and
 * no browser tab shows them.
 */
const APP_SURFACE_COPY: Record<
  (typeof NOINDEX_PATH_PREFIXES)[number],
  { title: string; description: string }
> = {
  '/driver': {
    title: `${APP_SURFACE_TITLES['/driver']} | ${BRAND}`,
    description: `Sign-in for ${BRAND} drivers. Not a public page.`,
  },
  '/admin': {
    title: `${APP_SURFACE_TITLES['/admin']} | ${BRAND}`,
    description: `Sign-in for ${BRAND} staff. Not a public page.`,
  },
  '/portal': {
    title: `${APP_SURFACE_TITLES['/portal']} | ${BRAND}`,
    description: `Manage your ${BRAND} booking. Not a public page.`,
  },
};

/**
 * The three app surfaces: the driver portal, the admin console and the
 * customer portal. **200, and permanently `noindex`** (owner decision
 * 2026-10-16, C2).
 *
 * They had no case in the route table, so every one of them fell through to
 * `notFoundMeta` and was served HTTP 404 with the title "Page not found" —
 * measured 2026-10-16. The SPA booted and rendered correctly regardless (a
 * browser renders a 404 body), so nothing was broken; what it cost was real
 * anyway. A driver's tab read "Page not found" for an entire shift, and an
 * uptime monitor pointed at `/driver` reported the portal down.
 *
 * **`noindex` and `404` are not the same statement.** "Do not list this" and
 * "there is nothing here" are different claims, and only the first is true of
 * these routes. They already carry an `X-Robots-Tag`
 * (`middleware/robots-header.ts`); this makes the meta tag agree.
 *
 * "Is this an app surface" is `isPrivatePath`, imported from that same
 * middleware, not a second list of prefixes. Two answers to one question
 * drift, and the one that drifts is the security-relevant one. It matches
 * whole first segments (`/drivers` and `/driverfoo` are not the driver portal
 * and keep 404ing) and is prefix-based rather than a route-table entry because
 * the table matches on an exact segment count, while these surfaces have
 * open-ended paths (`/admin/bookings/3`, `/portal/RG-7KQ4M9`).
 *
 * Pure and SYNCHRONOUS, deliberately: no settings read, no database. A
 * crawler hammering `/admin/...` must not cost a query each time, and these
 * pages must still answer when MySQL is unreachable — which is exactly when
 * somebody is looking at an uptime monitor. Being synchronous is the proof: a
 * function that returns the meta itself cannot have awaited a query. That also
 * means the site-wide noindex gate in `resolvePage` never applies to these:
 * they are `noindex` unconditionally, which is strictly stronger.
 */
export function appSurfaceMeta(pathname: string): PageMeta | null {
  if (!isPrivatePath(pathname)) return null;

  const path = normalisePath(pathname);
  const first = path.split('/')[1] ?? '';
  // `isPrivatePath` has just established that `/${first}` is one of the
  // prefixes, so this lookup cannot miss.
  const copy = APP_SURFACE_COPY[`/${first}` as keyof typeof APP_SURFACE_COPY];

  return {
    title: copy.title,
    description: copy.description,
    canonical: absoluteUrl(path),
    ogImage: null,
    ogType: 'website',
    jsonLd: [],
    // Not content: no hero, no structured data.
    preload: null,
    status: 200,
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
    // The ONLY route that renders HeroSection, and so the only one that may
    // ask the browser to fetch the hero photo early.
    preload: HERO_PRELOAD,
    status: 200,
    robots: 'index,follow',
  };
};

/**
 * `/tours` — the catalog index. Its title is navigational rather than
 * content: there is no `settings` key for it, and inventing one would be a
 * schema change this task does not own. It is read from
 * `STATIC_PUBLIC_TITLES` (`@rg/shared`) so `PublicLayout` can re-assert the
 * same words as `document.title` after a client-side navigation. Its
 * description is the site description, so there is no invented marketing
 * copy on the page.
 */
const resolveToursIndex: Resolver = async () => {
  const { siteSeo, hero } = await readSiteBlocks();
  const ogImage = firstImageUrl(siteSeo.ogImage, hero.imagePath);
  // The organization only. No ItemList of tours: a carousel of links to
  // /tours/:slug would point at pages the SPA does not render yet (D5), and
  // no CollectionPage node earns a rich result.
  const { agency } = await buildSiteGraph(siteSeo.description, ogImage);

  return {
    title: `${STATIC_PUBLIC_TITLES['/tours']} | ${BRAND}`,
    description: siteSeo.description,
    canonical: absoluteUrl('/tours'),
    ogImage,
    ogType: 'website',
    jsonLd: [agency],
    preload: null,
    status: 200,
    robots: 'index,follow',
  };
};

/**
 * The four legal pages (task 2B, 2026-10-27). Titles match the `<h1>` each page's own
 * `LegalPage` component renders from its static content module
 * (`client/src/content/legal/*.tsx`) — `/privacy` and `/terms` no longer read
 * `settings.legal_*`; see docs/superpowers/plans/2026-10-27-legal-pages.md for why.
 */
const LEGAL_PAGES = {
  privacy: {
    path: '/privacy',
    title: `${STATIC_PUBLIC_TITLES['/privacy']} | ${BRAND}`,
    description: `How ${BRAND} (operated by ${LEGAL_OPERATOR}) collects, uses and protects your personal data under the Data Privacy Act of 2012 (RA 10173).`,
  },
  terms: {
    path: '/terms',
    title: `${STATIC_PUBLIC_TITLES['/terms']} | ${BRAND}`,
    description: `Booking, payment, cancellation and safety terms for Cebu tours operated by ${LEGAL_OPERATOR}.`,
  },
  refund: {
    path: '/refund-policy',
    title: `${STATIC_PUBLIC_TITLES['/refund-policy']} | ${BRAND}`,
    description: `Cancellation windows, refund rules and how refunds are paid for ${BRAND} tours operated by ${LEGAL_OPERATOR}.`,
  },
  cookies: {
    path: '/cookies',
    title: `${STATIC_PUBLIC_TITLES['/cookies']} | ${BRAND}`,
    description: `The essential, analytics and marketing cookies ${BRAND} uses, and how to change your choice.`,
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
      preload: null,
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
    preload: null,
    status: 200,
    robots: 'index,follow',
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
        // The discounted price guests actually pay. `old_price_centavos` is a
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
    preload: null,
    status: 200,
    robots: 'index,follow',
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
  { pattern: '/refund-policy', resolve: resolveLegal('refund') },
  { pattern: '/cookies', resolve: resolveLegal('cookies') },
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
  // Before the route table and before any settings read — see
  // `appSurfaceMeta`. Returning here also bypasses the site-wide noindex gate
  // below, which these routes do not need: they are noindex always.
  const appSurface = appSurfaceMeta(pathname);
  if (appSurface) return appSurface;

  const match = matchRoute(pathname);
  if (!match) return notFoundMeta(pathname);

  const meta = await match.resolve(match.params);
  // Fails closed: an unreadable flag resolves to "unverified" (see
  // readContentUnverified), so the shell is served noindex rather than
  // indexable-by-accident.
  return (await readContentUnverified()) ? { ...meta, robots: 'noindex,nofollow' } : meta;
}
