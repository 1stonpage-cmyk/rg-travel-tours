import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { getDb } from '../db/client';
import { destinations, tourPriceTiers, tours } from '../db/schema';
import { absoluteUrl, matchRoute, normalisePath, resolvePage } from '../seo/resolvers';
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
    expect(meta.title).toBe('TravelSugbo — Cebu Day Tours & Packages');
    expect(meta.description).toContain('Book Cebu day tours');
    expect(meta.robots).toBe('index,follow');
  });

  it('falls back to the hero photo for the home og:image when site_seo has none', async () => {
    // Seeded site_seo.ogImage is null, so the chain lands on hero.imagePath.
    expect((await resolvePage('/')).ogImage).toBe('http://localhost:5180/hero/hero-cebu-1920.jpg');
  });

  it('gives /tours its own title and the site description', async () => {
    const meta = await resolvePage('/tours');
    expect(meta.status).toBe(200);
    expect(meta.title).toBe('Cebu Day Tours | TravelSugbo');
    expect(meta.canonical).toBe('http://localhost:5180/tours');
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

  it('keeps tour and package detail URLs out of the index while no page renders them (D5)', async () => {
    expect((await resolvePage('/tours/oslob-whale-shark-tumalog-falls')).robots).toBe(
      'noindex,nofollow',
    );
    expect((await resolvePage('/packages/cebu-highlights-3d2n')).robots).toBe('noindex,nofollow');
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
      .values({ tourId: TOUR_ID, minPax: 1, maxPax: 4, pricePerPerson: 250_000 });
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
