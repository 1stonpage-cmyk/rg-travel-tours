import { HERO_IMAGE_PRELOAD, reverseTransferRouteSlug } from '@rg/shared';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetContentUnverifiedCache } from '../content/settings';
import { getDb, getPool } from '../db/client';
import {
  destinations,
  settings,
  tourPriceTiers,
  tours,
  transferPlaces,
  transferRoutes,
  transferRouteVehiclePrices,
  vehicleTypes,
} from '../db/schema';
import { NOINDEX_PATH_PREFIXES } from '../middleware/robots-header';
import {
  absoluteUrl,
  appSurfaceMeta,
  matchRoute,
  normalisePath,
  resolvePage,
} from '../seo/resolvers';
import { describeWithDb } from './helpers/db';

describe('route matching', () => {
  it('matches static routes', () => {
    expect(matchRoute('/')).not.toBeNull();
    expect(matchRoute('/tours')).not.toBeNull();
    expect(matchRoute('/privacy')).not.toBeNull();
    expect(matchRoute('/terms')).not.toBeNull();
  });

  it('extracts a slug parameter', () => {
    expect(matchRoute('/tours/oslob-whale-shark-tumalog-falls')?.params).toEqual({
      slug: 'oslob-whale-shark-tumalog-falls',
    });
    expect(matchRoute('/packages/cebu-highlights-3d2n')?.params).toEqual({
      slug: 'cebu-highlights-3d2n',
    });
  });

  it('ignores a trailing slash and is case-insensitive on the path', () => {
    expect(matchRoute('/tours/')).not.toBeNull();
    expect(matchRoute('/tours/')?.pattern).toBe('/tours');
    expect(matchRoute('/TOURS')?.pattern).toBe('/tours');
    expect(matchRoute('/Tours/Oslob-Whale-Shark-Tumalog-Falls')?.params).toEqual({
      slug: 'oslob-whale-shark-tumalog-falls',
    });
  });

  it('returns null for an unknown path', () => {
    expect(matchRoute('/nope')).toBeNull();
    expect(matchRoute('/tours/a/b')).toBeNull();
    expect(matchRoute('/packages')).toBeNull(); // no index page for packages (they live on the home page)
  });

  it('collapses repeated trailing slashes onto the same route', () => {
    expect(matchRoute('/tours//')?.pattern).toBe('/tours');
    expect(matchRoute('/tours//')?.params).toEqual({});
  });
});

describe('path and URL normalisation', () => {
  it('keeps the root slash and drops every other trailing slash', () => {
    expect(normalisePath('/')).toBe('/');
    expect(normalisePath('')).toBe('/');
    expect(normalisePath('/tours///')).toBe('/tours');
    expect(normalisePath('/Terms')).toBe('/terms');
  });

  it('builds absolute URLs from PUBLIC_BASE_URL and leaves absolute ones alone', () => {
    expect(absoluteUrl('/')).toBe('http://localhost:5180/');
    expect(absoluteUrl('/tours')).toBe('http://localhost:5180/tours');
    expect(absoluteUrl('https://cdn.example.com/a.jpg')).toBe('https://cdn.example.com/a.jpg');
  });
});

describeWithDb('page resolution', () => {
  it('builds home meta from settings.site_seo', async () => {
    const meta = await resolvePage('/');
    expect(meta.status).toBe(200);
    expect(meta.canonical).toBe('http://localhost:5180/');
    expect(meta.title.length).toBeGreaterThan(10);
    // The seeded site_seo block, verbatim — not a generated title.
    expect(meta.title).toBe('TravelSugbo — Cebu Airport & Island Transfers');
    expect(meta.description).toContain('private airport and island transfers');
    // Task 4.3: the home route itself asks for `index,follow`, but the
    // seeded database has `settings.content_unverified = true`, and the
    // site-wide gate in `resolvePage` overrides every route while that is
    // so. Both states are proven in sitemap-robots.test.ts.
    expect(meta.robots).toBe('noindex,nofollow');
  });

  it('falls back to the hero photo for the home og:image when site_seo has none', async () => {
    // Seeded site_seo.ogImage is null, so the chain lands on hero.imagePath.
    expect((await resolvePage('/')).ogImage).toBe('http://localhost:5180/hero/hero-cebu-1920.jpg');
  });

  /**
   * Task: SEO fixes, 2026-11-24. `/transfer` is the MAIN booking page for a
   * transfers-only launch (`settings.show_tours = false`), but used to be
   * permanently `noindex` via `appSurfaceMeta` — see the removed QA-1/
   * BUG-116 entries this task deletes from `NOINDEX_PATH_PREFIXES` and
   * `APP_SURFACE_COPY`. It now gets a real resolver like any other
   * indexable route.
   *
   * `content_unverified` has to be false for the `robots` assertion, same
   * reasoning as the `/photo-credits` and `/tours/:slug` tests above: the
   * seeded default is true, and the site-wide gate in `resolvePage` forces
   * every route to `noindex,nofollow` regardless of what its own resolver
   * asked for.
   */
  it('/transfer resolves to a real, indexable page', async () => {
    await getDb()
      .update(settings)
      .set({ value: false })
      .where(eq(settings.key, 'content_unverified'));
    resetContentUnverifiedCache();
    try {
      const meta = await resolvePage('/transfer');
      expect(meta.status).toBe(200);
      expect(meta.robots).toBe('index,follow');
      expect(meta.title.length).toBeLessThanOrEqual(60);
      expect(meta.description.length).toBeGreaterThanOrEqual(140);
      expect(meta.description.length).toBeLessThanOrEqual(160);
      expect(meta.canonical).toBe(absoluteUrl('/transfer'));
      expect(
        meta.jsonLd.some((n) => (n as Record<string, unknown>)['@type'] === 'TravelAgency'),
      ).toBe(true);
    } finally {
      await getDb()
        .update(settings)
        .set({ value: true })
        .where(eq(settings.key, 'content_unverified'));
      resetContentUnverifiedCache();
    }
  });

  it('/transfer with a query string canonicals to the bare path', async () => {
    // resolvePage is already called with req.path / url.pathname, which
    // strips the query before this function ever sees it — assert directly.
    const meta = await resolvePage('/transfer');
    expect(meta.canonical).not.toContain('?');
  });

  it('an inactive or unknown transfer route slug 404s and noindexes', async () => {
    const meta = await resolvePage('/transfers/does-not-exist');
    expect(meta.status).toBe(404);
    expect(meta.robots).toBe('noindex,nofollow');
  });

  it('gives /tours its own title and the site description', async () => {
    const meta = await resolvePage('/tours');
    expect(meta.status).toBe(200);
    expect(meta.title).toBe('Cebu Day Tours | TravelSugbo');
    expect(meta.canonical).toBe('http://localhost:5180/tours');
  });

  /**
   * The `show_tours` gate on the two tour routes and the package detail
   * route (transfers-launch plan, Task T15; packages added by owner decision
   * 2026-11-10, Decision 2). All three answer `notFoundMeta()` — 404 and
   * `noindex,nofollow`, exactly what a path that names nothing gets — rather
   * than 200 with a title for a catalog the owner has taken off sale.
   *
   * The ON state is already proven by the two tests either side of this one
   * ("gives /tours its own title…" above, and the tour-detail title/
   * description/og:image tests below), all of which run against the
   * harness's `show_tours: true` baseline and would go red if the gate
   * misread the flag. `content_unverified` is deliberately left alone here:
   * these assertions are about `status`, which the site-wide gate does not
   * touch, and `robots` is `noindex,nofollow` under either flag.
   */
  it('serves /tours and /tours/:slug as 404 + noindex while show_tours is off', async () => {
    const db = getDb();
    const tourPath = '/tours/oslob-whale-shark-tumalog-falls';

    // The premise: with the flag on, both are real pages.
    expect((await resolvePage('/tours')).status).toBe(200);
    expect((await resolvePage(tourPath)).status).toBe(200);

    await db.update(settings).set({ value: false }).where(eq(settings.key, 'show_tours'));
    try {
      const index = await resolvePage('/tours');
      expect(index.status).toBe(404);
      expect(index.robots).toBe('noindex,nofollow');
      expect(index.title).toBe('Page not found | TravelSugbo');
      expect(index.canonical).toBe('http://localhost:5180/tours');

      const detail = await resolvePage(tourPath);
      expect(detail.status).toBe(404);
      expect(detail.robots).toBe('noindex,nofollow');
      expect(detail.title).toBe('Page not found | TravelSugbo');
      expect(detail.canonical).toBe(`http://localhost:5180${tourPath}`);

      // Decision 2 (2026-11-10) supersedes the earlier "packages are a
      // different product" ruling: packages now follow the same gate.
      const pkg = await resolvePage('/packages/cebu-highlights-3d2n');
      expect(pkg.status).toBe(404);
      expect(pkg.robots).toBe('noindex,nofollow');
    } finally {
      await db.update(settings).set({ value: true }).where(eq(settings.key, 'show_tours'));
    }
  });

  it('resolves the legal pages as articles', async () => {
    const privacy = await resolvePage('/privacy');
    expect(privacy.status).toBe(200);
    expect(privacy.ogType).toBe('article');
    expect(privacy.canonical).toBe('http://localhost:5180/privacy');
    expect(privacy.title).toContain('Privacy Notice');

    const terms = await resolvePage('/terms');
    expect(terms.ogType).toBe('article');
    expect(terms.title).toContain('Terms of Service');

    // Task 2B (2026-10-27): the two new legal pages resolve the same way.
    const refund = await resolvePage('/refund-policy');
    expect(refund.status).toBe(200);
    expect(refund.ogType).toBe('article');
    expect(refund.canonical).toBe('http://localhost:5180/refund-policy');
    expect(refund.title).toContain('Cancellation & Refund Policy');

    const cookies = await resolvePage('/cookies');
    expect(cookies.status).toBe(200);
    expect(cookies.ogType).toBe('article');
    expect(cookies.canonical).toBe('http://localhost:5180/cookies');
    expect(cookies.title).toContain('Cookie Policy');
  });

  /**
   * Task 1D (owner decision 2026-11-10). Unlike the four legal pages above,
   * `/photo-credits` must answer 200 with its own title (the BUG-116/QA-1
   * defect this file already guards against for `/checkout` et al.) but
   * stay `noindex,nofollow` — it is thin, non-marketing content, not a
   * legal page, and deliberately not in `sitemap.ts`'s static list.
   */
  it('resolves /photo-credits as a real 200 page with its own title', async () => {
    const credits = await resolvePage('/photo-credits');
    expect(credits.status).toBe(200);
    expect(credits.canonical).toBe('http://localhost:5180/photo-credits');
    expect(credits.title).toContain('Photo Credits');
  });

  /**
   * `content_unverified` has to be false for this, same reasoning as the
   * `/tours/:slug` D5 test above: the seeded default is true, and the
   * site-wide gate forces every route to `noindex,nofollow` regardless —
   * which would make a bare `robots === 'noindex,nofollow'` assertion pass
   * even if `resolvePhotoCredits` itself answered `index,follow`.
   */
  it('keeps /photo-credits noindex even once content is verified — it is not a legal page', async () => {
    await getDb()
      .update(settings)
      .set({ value: false })
      .where(eq(settings.key, 'content_unverified'));
    resetContentUnverifiedCache();
    try {
      expect((await resolvePage('/photo-credits')).robots).toBe('noindex,nofollow');
    } finally {
      await getDb()
        .update(settings)
        .set({ value: true })
        .where(eq(settings.key, 'content_unverified'));
      resetContentUnverifiedCache();
    }
  });

  it('falls back to a generated title when a tour has no seo_title', async () => {
    // Title pattern: "<title> — <destination> day tour from ₱X | TravelSugbo"
    const meta = await resolvePage('/tours/oslob-whale-shark-tumalog-falls');
    expect(meta.title).toMatch(/Oslob/);
    expect(meta.title).toMatch(/₱/);
    expect(meta.title).toBe(
      'Oslob Whale Sharks + Tumalog Falls — Oslob day tour from ₱1,890 | TravelSugbo',
    );
  });

  it('falls back to a generated tour description naming the destination and the lowest price', async () => {
    // The seeded tour has neither summary nor about, so the last fallback runs.
    const meta = await resolvePage('/tours/oslob-whale-shark-tumalog-falls');
    expect(meta.description).toBe(
      'Book the Oslob Whale Sharks + Tumalog Falls day tour in Oslob with TravelSugbo. ' +
        'Private van, licensed driver, from ₱1,890 per person.',
    );
  });

  it("uses the tour's own first image as an absolute og:image", async () => {
    const meta = await resolvePage('/tours/oslob-whale-shark-tumalog-falls');
    expect(meta.ogImage).toBe('http://localhost:5180/placeholders/oslob.svg');
  });

  /**
   * Week 7 plan, Task 2 (2D): `/tours/:slug` now renders — the detail page
   * built in this task — so it is released from D5's `noindex` and answers
   * `index,follow`. Task 3 makes the same edit to `resolvePackage` once
   * `/packages/:slug` renders too — see the next test.
   *
   * `content_unverified` has to be false for this: the seeded default is
   * true, and `resolvePage`'s site-wide gate (task 4.3) forces EVERY route
   * to `noindex,nofollow` while it is — which would make this assertion
   * pass even if `resolveTour` itself still said `noindex`.
   */
  it('releases /tours/:slug from D5 — it now answers index,follow', async () => {
    await getDb()
      .update(settings)
      .set({ value: false })
      .where(eq(settings.key, 'content_unverified'));
    resetContentUnverifiedCache();
    try {
      expect((await resolvePage('/tours/oslob-whale-shark-tumalog-falls')).robots).toBe(
        'index,follow',
      );
    } finally {
      await getDb()
        .update(settings)
        .set({ value: true })
        .where(eq(settings.key, 'content_unverified'));
      resetContentUnverifiedCache();
    }
  });

  /**
   * Week 7 plan, Task 3: `/packages/:slug` now renders too, so `resolvePackage`
   * is released from D5's `noindex` the same way `resolveTour` was in Task 2
   * above — same reasoning, same content_unverified-false requirement.
   */
  it('releases /packages/:slug from D5 — it now answers index,follow', async () => {
    await getDb()
      .update(settings)
      .set({ value: false })
      .where(eq(settings.key, 'content_unverified'));
    resetContentUnverifiedCache();
    try {
      expect((await resolvePage('/packages/cebu-highlights-3d2n')).robots).toBe('index,follow');
    } finally {
      await getDb()
        .update(settings)
        .set({ value: true })
        .where(eq(settings.key, 'content_unverified'));
      resetContentUnverifiedCache();
    }
  });

  it('builds package meta from its days, discounted price and description', async () => {
    const meta = await resolvePage('/packages/cebu-highlights-3d2n');
    expect(meta.status).toBe(200);
    expect(meta.canonical).toBe('http://localhost:5180/packages/cebu-highlights-3d2n');
    expect(meta.title).toBe('Cebu Highlights — 3-day Cebu package from ₱9,800 | TravelSugbo');
    expect(meta.description).toBe(
      'City heritage, Oslob whale sharks and Kawasan canyoneering with hotel transfers included.',
    );
  });

  it('returns a 404 PageMeta for an unknown slug', async () => {
    const meta = await resolvePage('/tours/no-such-tour');
    expect(meta.status).toBe(404);
    expect(meta.robots).toBe('noindex,nofollow');
    expect(meta.ogImage).toBeNull();
  });

  it('returns a 404 PageMeta for an unknown path', async () => {
    expect((await resolvePage('/nope')).status).toBe(404);
    expect((await resolvePage('/packages/no-such-package')).status).toBe(404);
  });

  it('asks for the hero preload on / and on no other route (4.4b)', async () => {
    // The home page is the only route that renders HeroSection. The preload
    // used to live in client/index.html, which is the shared SPA shell, so
    // every route paid for it — ~73 KB on mobile and ~295 KB on desktop that
    // the page never used, plus Chrome's "preloaded but not used" warning.
    expect((await resolvePage('/')).preload).toEqual(HERO_IMAGE_PRELOAD);

    for (const path of ['/tours', '/privacy', '/terms', '/refund-policy', '/cookies']) {
      expect((await resolvePage(path)).preload, `${path} should preload nothing`).toBeNull();
    }
    expect((await resolvePage('/tours/oslob-whale-shark-tumalog-falls')).preload).toBeNull();
    expect((await resolvePage('/packages/cebu-highlights-3d2n')).preload).toBeNull();
    expect((await resolvePage('/nope')).preload).toBeNull();
  });
});

/**
 * Task 9 (C2): the driver portal, the admin console and the customer portal
 * answer 200 with a title of their own and `noindex,nofollow`. They used to
 * fall through to the not-found shell: HTTP 404, "Page not found".
 */
describe('app surfaces (pure)', () => {
  const cases = [
    ['/driver', 'Driver portal'],
    ['/driver/login', 'Driver portal'],
    ['/driver/trip/7', 'Driver portal'],
    ['/admin', 'Staff console'],
    ['/admin/bookings/3', 'Staff console'],
    ['/portal', 'My booking'],
    ['/portal/RG-7KQ4M9', 'My booking'],
    // The same normalisation as every other route: case and trailing slash.
    ['/Driver/', 'Driver portal'],
    // BUG-116: /checkout/:tourSlug and /booking/:ref are real public SPA
    // routes that had no entry here, so they 404'd with "Page not found".
    ['/checkout', 'Checkout'],
    ['/checkout/oslob-whale-shark-tumalog-falls', 'Checkout'],
    ['/booking', 'Booking status'],
    ['/booking/RG-7KQ4M9', 'Booking status'],
  ] as const;

  it.each(cases)('%s is 200, noindex and titled as its own place', (path, titleStart) => {
    const meta = appSurfaceMeta(path);
    expect(meta).not.toBeNull();
    expect(meta!.status).toBe(200);
    expect(meta!.robots).toBe('noindex,nofollow');
    expect(meta!.title.startsWith(titleStart)).toBe(true);
    // Not the not-found title, which is the whole bug.
    expect(meta!.title).not.toMatch(/Page not found/);
    // The brand, never the licensed operator: a tab title is customer copy.
    expect(meta!.title.endsWith('| TravelSugbo')).toBe(true);
    // No JSON-LD, no hero preload, no OG image: these pages are not content.
    expect(meta!.jsonLd).toEqual([]);
    expect(meta!.preload).toBeNull();
    expect(meta!.ogImage).toBeNull();
  });

  it('canonicalises to the requested path, not to the home page', () => {
    expect(appSurfaceMeta('/driver/trip/7')!.canonical).toBe('http://localhost:5180/driver/trip/7');
  });

  it('is null for anything that is not an app surface, so the route table runs unchanged', () => {
    // SEO fixes, 2026-11-24: /transfer left NOINDEX_PATH_PREFIXES — it is
    // the main booking page, not an app surface — so it belongs in this
    // list now, not in `cases` above.
    for (const path of ['/', '/tours', '/tours/some-slug', '/privacy', '/nope', '/transfer']) {
      expect(appSurfaceMeta(path), path).toBeNull();
    }
  });

  it('a path that merely STARTS with a surface name is not that surface', () => {
    for (const path of [
      '/drivers',
      '/driverfoo',
      '/administrator',
      '/portalx',
      '/admin-panel',
      '/checkoutfoo',
      '/checkouts',
      '/bookingfoo',
      '/bookings',
      '/transferable',
    ]) {
      expect(appSurfaceMeta(path), path).toBeNull();
    }
  });

  it('covers exactly the paths the X-Robots-Tag middleware calls private', () => {
    // Two answers to one question drift apart, and the one that drifts is
    // the security-relevant one. The prefix list is imported, not retyped, so
    // a surface added there but not given a title here fails to compile; and
    // this fails if it ever stops resolving.
    expect(NOINDEX_PATH_PREFIXES.length).toBeGreaterThan(0);
    for (const prefix of NOINDEX_PATH_PREFIXES) {
      expect(appSurfaceMeta(prefix)?.status, prefix).toBe(200);
      expect(appSurfaceMeta(`${prefix}/anything/at/all`)?.status, prefix).toBe(200);
    }
  });

  it('is synchronous: it returns the meta itself, so it cannot have awaited the database', () => {
    // A driver's phone on a bad connection must not depend on a settings
    // read, and an uptime monitor must get an answer when MySQL is down. An
    // async function returns a Promise whatever it does, so an awaited
    // database read cannot be added to this one without this going red.
    const meta = appSurfaceMeta('/driver/login');
    expect(meta).not.toBeInstanceOf(Promise);
    expect(typeof (meta as unknown as { then?: unknown }).then).toBe('undefined');
    expect(meta!.status).toBe(200);
  });
});

describeWithDb('app surfaces through resolvePage', () => {
  async function readFlag(): Promise<unknown> {
    const [row] = await getDb()
      .select()
      .from(settings)
      .where(eq(settings.key, 'content_unverified'));
    return row?.value;
  }

  async function writeFlag(value: unknown): Promise<void> {
    await getDb().update(settings).set({ value }).where(eq(settings.key, 'content_unverified'));
    resetContentUnverifiedCache();
  }

  it.each([
    '/driver',
    '/driver/login',
    '/driver/trip/7',
    '/admin',
    '/admin/bookings/3',
    '/portal',
    // BUG-116
    '/checkout',
    '/checkout/oslob-whale-shark-tumalog-falls',
    '/booking',
    '/booking/RG-7KQ4M9',
  ])('%s resolves 200 and noindex, not the not-found shell', async (path) => {
    const meta = await resolvePage(path);
    expect(meta.status).toBe(200);
    expect(meta.robots).toBe('noindex,nofollow');
    expect(meta.title).not.toMatch(/Page not found/);
  });

  it('noindex here does not depend on the content flag', async () => {
    // These routes are noindex forever, not only while the site is
    // unverified — so the assertion must hold with the flag CLEARED.
    const before = await readFlag();
    try {
      await writeFlag(false);
      expect(await readFlag()).toBe(false); // premise: it really is cleared
      expect((await resolvePage('/driver')).robots).toBe('noindex,nofollow');
      expect((await resolvePage('/admin/bookings/3')).robots).toBe('noindex,nofollow');
    } finally {
      await writeFlag(before);
    }
  });

  it('a path that merely STARTS with a surface name still 404s', async () => {
    for (const path of [
      '/drivers',
      '/driverfoo',
      '/administrator',
      '/portalx',
      '/checkoutfoo',
      '/bookingfoo',
    ]) {
      expect((await resolvePage(path)).status, path).toBe(404);
    }
  });

  it('issues no database statement at all', async () => {
    // The behavioural half of the synchronous check above: a fire-and-forget
    // read inside a sync function would leave the return type alone. The flag
    // cache is cleared first so a read could not hide behind it.
    resetContentUnverifiedCache();
    const pool = getPool();
    const query = vi.spyOn(pool, 'query');
    const execute = vi.spyOn(pool, 'execute');
    try {
      for (const path of [
        '/driver/login',
        '/admin',
        '/portal/RG-7KQ4M9',
        '/checkout',
        '/booking',
      ]) {
        await resolvePage(path);
      }
      expect(query.mock.calls.length + execute.mock.calls.length).toBe(0);
    } finally {
      query.mockRestore();
      execute.mockRestore();
    }
  });
});

describeWithDb('page resolution — fallback fixtures', () => {
  // Ids far outside the seeded auto-increment range, so these rows never
  // collide with seeded content and never need resetTestDb().
  const DESTINATION_ID = 900_101;
  const TOUR_ID = 900_102;
  const SLUG = 'fixture-seo-tour';

  beforeAll(async () => {
    const db = getDb();
    await db.insert(destinations).values({
      id: DESTINATION_ID,
      name: 'Fixture Bay',
      slug: 'fixture-bay',
      isActive: true,
    });
    await db.insert(tours).values({
      id: TOUR_ID,
      slug: SLUG,
      title: 'Fixture Tour',
      destinationId: DESTINATION_ID,
      isActive: true,
    });
    await db
      .insert(tourPriceTiers)
      .values({ tourId: TOUR_ID, minPax: 1, maxPax: 4, pricePerPersonCentavos: 250_000 });
  });

  afterAll(async () => {
    const db = getDb();
    await db.delete(tourPriceTiers).where(eq(tourPriceTiers.tourId, TOUR_ID));
    await db.delete(tours).where(eq(tours.id, TOUR_ID));
    await db.delete(destinations).where(eq(destinations.id, DESTINATION_ID));
  });

  beforeEach(async () => {
    await getDb()
      .update(tours)
      .set({
        seoTitle: null,
        seoDescription: null,
        summary: null,
        about: null,
        ogImage: null,
        isActive: true,
      })
      .where(eq(tours.id, TOUR_ID));
    await getDb()
      .update(destinations)
      .set({ isActive: true })
      .where(eq(destinations.id, DESTINATION_ID));
  });

  it('prefers seo_title and seo_description over every fallback, verbatim', async () => {
    await getDb()
      .update(tours)
      .set({ seoTitle: 'Hand-written title', seoDescription: 'Hand-written description.' })
      .where(eq(tours.id, TOUR_ID));

    const meta = await resolvePage(`/tours/${SLUG}`);
    expect(meta.title).toBe('Hand-written title');
    expect(meta.description).toBe('Hand-written description.');
  });

  it('treats a blank seo_title as absent and falls back', async () => {
    await getDb().update(tours).set({ seoTitle: '   ' }).where(eq(tours.id, TOUR_ID));
    expect((await resolvePage(`/tours/${SLUG}`)).title).toBe(
      'Fixture Tour — Fixture Bay day tour from ₱2,500 | TravelSugbo',
    );
  });

  it('prefers summary over about for the description', async () => {
    await getDb()
      .update(tours)
      .set({ summary: 'A short summary.', about: 'The long about text.' })
      .where(eq(tours.id, TOUR_ID));
    expect((await resolvePage(`/tours/${SLUG}`)).description).toBe('A short summary.');
  });

  it('truncates long fallback prose to 155 characters and collapses its whitespace', async () => {
    await getDb()
      .update(tours)
      .set({ about: `${'word '.repeat(60)}\n\n  tail` })
      .where(eq(tours.id, TOUR_ID));

    const { description } = await resolvePage(`/tours/${SLUG}`);
    expect(description.length).toBeLessThanOrEqual(155);
    expect(description.endsWith('…')).toBe(true);
    expect(description).not.toMatch(/\s\s|\n/);
  });

  it("prefers the tour's own og_image over its first image", async () => {
    await getDb()
      .update(tours)
      .set({ ogImage: '/uploads/og/fixture.jpg' })
      .where(eq(tours.id, TOUR_ID));
    expect((await resolvePage(`/tours/${SLUG}`)).ogImage).toBe(
      'http://localhost:5180/uploads/og/fixture.jpg',
    );
  });

  it('falls back to the site og:image chain when the tour has no image of its own', async () => {
    // The fixture tour has no tour_images rows at all.
    expect((await resolvePage(`/tours/${SLUG}`)).ogImage).toBe(
      'http://localhost:5180/hero/hero-cebu-1920.jpg',
    );
  });

  it('404s a soft-deleted tour, and a tour under a soft-deleted destination (I1)', async () => {
    await getDb().update(tours).set({ isActive: false }).where(eq(tours.id, TOUR_ID));
    expect((await resolvePage(`/tours/${SLUG}`)).status).toBe(404);

    await getDb().update(tours).set({ isActive: true }).where(eq(tours.id, TOUR_ID));
    await getDb()
      .update(destinations)
      .set({ isActive: false })
      .where(eq(destinations.id, DESTINATION_ID));
    expect((await resolvePage(`/tours/${SLUG}`)).status).toBe(404);
  });
});

/**
 * Task 8 (SEO fixes, 2026-11-24): `/transfers/:slug`, direction-aware.
 *
 * `rg_travel_test` is deliberately kept at zero `transfer_places`/
 * `transfer_routes` rows (same discipline as the fleet — this project's seed
 * gates both to the APP database only; see `db/seed.ts`'s own comments and
 * `seed-demo-transfer-bookings.test.ts`'s header). So this is a dedicated
 * fixture, not the real `SEED_TRANSFER_ROUTES` catalog — ids far outside the
 * seeded range, mirroring "page resolution — fallback fixtures" above.
 */
describeWithDb('page resolution — transfer routes (Task 8)', () => {
  const FROM_PLACE_ID = 900_401;
  const TO_PLACE_ID = 900_402;
  const ROUTE_ID = 900_403;
  const SLUG = 'fixture-seo-origin-to-fixture-seo-destination';
  const REVERSE_SLUG = reverseTransferRouteSlug(SLUG);

  beforeAll(async () => {
    const db = getDb();
    // The real 'van' vehicle_types id — backfilled into every database
    // (including rg_travel_test) by migration 0023, never a literal id.
    const [vanType] = await db
      .select({ id: vehicleTypes.id })
      .from(vehicleTypes)
      .where(eq(vehicleTypes.slug, 'van'));
    if (!vanType) throw new Error('No vehicle_types row for slug "van" — expected from seedBase.');

    await db.insert(transferPlaces).values([
      { id: FROM_PLACE_ID, name: 'Fixture SEO Origin', nameKey: 'fixture seo origin' },
      { id: TO_PLACE_ID, name: 'Fixture SEO Destination', nameKey: 'fixture seo destination' },
    ]);
    await db.insert(transferRoutes).values({
      id: ROUTE_ID,
      fromPlaceId: FROM_PLACE_ID,
      toPlaceId: TO_PLACE_ID,
      slug: SLUG,
      reverseEnabled: true,
      estimatedDurationMinutes: 150,
      freeCancelHours: 24,
    });
    await db.insert(transferRouteVehiclePrices).values({
      routeId: ROUTE_ID,
      vehicleTypeId: vanType.id,
      oneWayPriceCentavos: 250_000,
      dayUsePriceCentavos: 400_000,
    });
  });

  afterAll(async () => {
    const db = getDb();
    await db
      .delete(transferRouteVehiclePrices)
      .where(eq(transferRouteVehiclePrices.routeId, ROUTE_ID));
    await db.delete(transferRoutes).where(eq(transferRoutes.id, ROUTE_ID));
    await db.delete(transferPlaces).where(eq(transferPlaces.id, FROM_PLACE_ID));
    await db.delete(transferPlaces).where(eq(transferPlaces.id, TO_PLACE_ID));
  });

  beforeEach(async () => {
    await getDb()
      .update(transferRoutes)
      .set({ reverseEnabled: true })
      .where(eq(transferRoutes.id, ROUTE_ID));
  });

  /** `content_unverified` has to be false for `robots`, same reasoning as every other indexable-route test in this file. */
  async function withVerifiedContent<T>(fn: () => Promise<T>): Promise<T> {
    await getDb()
      .update(settings)
      .set({ value: false })
      .where(eq(settings.key, 'content_unverified'));
    resetContentUnverifiedCache();
    try {
      return await fn();
    } finally {
      await getDb()
        .update(settings)
        .set({ value: true })
        .where(eq(settings.key, 'content_unverified'));
      resetContentUnverifiedCache();
    }
  }

  it('resolves a transfer route forward slug to a real, indexable page', async () => {
    await withVerifiedContent(async () => {
      const meta = await resolvePage(`/transfers/${SLUG}`);
      expect(meta.status).toBe(200);
      expect(meta.robots).toBe('index,follow');
      expect(meta.title.length).toBeLessThanOrEqual(60);
      expect(meta.description.length).toBeGreaterThanOrEqual(140);
      expect(meta.description.length).toBeLessThanOrEqual(160);
      expect(meta.canonical).toBe(absoluteUrl(`/transfers/${SLUG}`));
      expect(meta.jsonLd.some((n) => (n as Record<string, unknown>)['@type'] === 'Service')).toBe(
        true,
      );
      expect(
        meta.jsonLd.some((n) => (n as Record<string, unknown>)['@type'] === 'BreadcrumbList'),
      ).toBe(true);
      expect(
        meta.jsonLd.some((n) => (n as Record<string, unknown>)['@type'] === 'TravelAgency'),
      ).toBe(true);
    });
  });

  it('resolves the DERIVED reverse slug to the opposite direction, with its own canonical and title', async () => {
    await withVerifiedContent(async () => {
      const forward = await resolvePage(`/transfers/${SLUG}`);
      const reverse = await resolvePage(`/transfers/${REVERSE_SLUG}`);
      expect(reverse.status).toBe(200);
      expect(reverse.robots).toBe('index,follow');
      expect(reverse.canonical).toBe(absoluteUrl(`/transfers/${REVERSE_SLUG}`));
      expect(reverse.title).not.toBe(forward.title);
    });
  });

  /** Proves `resolveTransferRoute`'s 404 inherits `loadTransferRouteSeo`'s own `reverseEnabled` gate end to end. */
  it("a reverse-disabled route's reverse slug 404s even though the forward slug is live", async () => {
    await getDb()
      .update(transferRoutes)
      .set({ reverseEnabled: false })
      .where(eq(transferRoutes.id, ROUTE_ID));

    const forward = await resolvePage(`/transfers/${SLUG}`);
    expect(forward.status).toBe(200);
    const reverse = await resolvePage(`/transfers/${REVERSE_SLUG}`);
    expect(reverse.status).toBe(404);
    expect(reverse.robots).toBe('noindex,nofollow');
  });

  it('404s an inactive route', async () => {
    await getDb()
      .update(transferRoutes)
      .set({ isActive: false })
      .where(eq(transferRoutes.id, ROUTE_ID));
    try {
      expect((await resolvePage(`/transfers/${SLUG}`)).status).toBe(404);
    } finally {
      await getDb()
        .update(transferRoutes)
        .set({ isActive: true })
        .where(eq(transferRoutes.id, ROUTE_ID));
    }
  });
});
