/**
 * Task 4.2 — the JSON-LD graph each public route publishes.
 *
 * The suite is built around ONE rule: `aggregateRating` may only ever be
 * built from real, non-sample published reviews, and must be ABSENT (not
 * null, not zero, not an empty object) otherwise. Every seeded review is
 * `is_sample = 1`, so "absent" is today's correct answer everywhere.
 *
 * An "expect it to be undefined" assertion is the easiest test on this
 * project to write so that it can never fail, so the omission is pinned from
 * both sides:
 *   - `'aggregateRating' in node` is asserted FALSE on a node that is itself
 *     asserted to exist and to be the right `@type`, so a renamed property
 *     or a vanished node fails rather than passes; and
 *   - the "fixtures" suite inserts REAL published reviews and asserts the
 *     rating then APPEARS, with the right value and count — so the omission
 *     tests are proving a data-driven decision, not an unimplemented feature.
 */
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { getDb } from '../db/client';
import { destinations, reviews, tourPriceTiers, tours } from '../db/schema';
import {
  aggregateRatingNode,
  faqPageNode,
  organizationId,
  pesoAmount,
  touristTripNode,
  travelAgencyNode,
  type JsonLdNode,
} from '../seo/jsonld';
import { resolvePage } from '../seo/resolvers';
import { describeWithDb } from './helpers/db';

/**
 * Reading JSON-LD in tests: the builders return `Record<string, unknown>`
 * (nothing downstream of here is typed — Schema.org is a shape, not a
 * TypeScript interface), so these three narrow one level at a time instead
 * of casting the whole graph to `any`. `sub`/`list` ASSERT the property is
 * there, so a renamed or missing key fails the test rather than silently
 * yielding `undefined`.
 */
function graph(nodes: unknown[]): JsonLdNode[] {
  return nodes as JsonLdNode[];
}

function sub(node: JsonLdNode, key: string): JsonLdNode {
  const value = node[key];
  expect(value, `node has no object at "${key}"`).toBeTypeOf('object');
  return value as JsonLdNode;
}

function list(node: JsonLdNode, key: string): JsonLdNode[] {
  const value = node[key];
  expect(Array.isArray(value), `node has no array at "${key}"`).toBe(true);
  return value as JsonLdNode[];
}

// ---------------------------------------------------------------------------
// Pure builders — no database
// ---------------------------------------------------------------------------

const CONTACT = {
  address: 'Office address pending — Cebu, Philippines',
  tagline: 'tagline',
  hoursNote: 'hours',
  email: 'hello@travelsugbo.com',
  phoneDisplay: '0908 469 6246',
  phoneTel: '+639084696246',
  whatsapp: '639084696246',
  altPhoneDisplay: '0927 737 8431',
  altPhoneTel: '+639277378431',
  facebook: 'https://www.facebook.com/profile.php?id=61574390071362',
  motto: 'motto',
  otherServices: { before: 'a', link: 'b', after: 'c' },
};

const OPEN_EVERY_DAY = Array.from({ length: 7 }, (_, weekday) => ({
  weekday,
  opensAt: '07:00',
  closesAt: '21:00',
  isClosed: false,
}));

function agency(rating: Record<string, unknown> | undefined) {
  return travelAgencyNode({
    siteUrl: 'https://travelsugbo.com/',
    description: 'Site description.',
    imageUrl: null,
    contact: CONTACT,
    businessHours: OPEN_EVERY_DAY,
    rating,
  });
}

describe('pesoAmount', () => {
  it('turns integer centavos into a two-decimal peso amount with no symbol', () => {
    expect(pesoAmount(189_000)).toBe('1890.00');
    expect(pesoAmount(980_000)).toBe('9800.00');
    expect(pesoAmount(189_050)).toBe('1890.50');
    expect(pesoAmount(99)).toBe('0.99');
    expect(pesoAmount(0)).toBe('0.00');
  });
});

describe('aggregateRatingNode', () => {
  it('returns undefined when there are no real reviews at all', () => {
    expect(aggregateRatingNode(null, 3)).toBeUndefined();
  });

  it('returns undefined below the minReviewsForRating threshold', () => {
    expect(aggregateRatingNode({ average: 5, count: 2 }, 3)).toBeUndefined();
  });

  it('builds the node once the threshold is met, rounded to one decimal', () => {
    expect(aggregateRatingNode({ average: (5 + 5 + 4) / 3, count: 3 }, 3)).toEqual({
      '@type': 'AggregateRating',
      ratingValue: '4.7',
      reviewCount: 3,
      bestRating: 5,
      worstRating: 1,
    });
  });
});

describe('travelAgencyNode', () => {
  it('names the brand and gives the licensed operator as the legal name', () => {
    const node = agency(undefined);
    expect(node['@type']).toBe('TravelAgency');
    expect(node.name).toBe('TravelSugbo');
    expect(node.legalName).toBe('R&G Travel & Tours');
    expect(node['@id']).toBe('https://travelsugbo.com/#organization');
    expect(organizationId('https://travelsugbo.com/')).toBe(node['@id']);
  });

  it('omits the aggregateRating KEY entirely when there is no rating to publish', () => {
    const node = agency(undefined);
    // The node exists and is the right type (asserted above), so this cannot
    // pass by reading a property off nothing.
    expect(Object.keys(node)).not.toContain('aggregateRating');
    expect(JSON.stringify(node)).not.toContain('aggregateRating');
  });

  it('carries the aggregateRating when one is supplied — the omission above is data, not a stub', () => {
    const node = agency({ '@type': 'AggregateRating', ratingValue: '4.7', reviewCount: 3 });
    expect(Object.keys(node)).toContain('aggregateRating');
    expect(sub(node, 'aggregateRating')).toEqual({
      '@type': 'AggregateRating',
      ratingValue: '4.7',
      reviewCount: 3,
    });
  });

  it('publishes no address while the office address is still a pending placeholder', () => {
    expect(Object.keys(agency(undefined))).not.toContain('address');
    expect(JSON.stringify(agency(undefined))).not.toContain('pending');
  });

  it('drops an empty facebook URL instead of emitting an empty sameAs', () => {
    const node = travelAgencyNode({
      siteUrl: 'https://travelsugbo.com/',
      description: 'd',
      imageUrl: null,
      contact: { ...CONTACT, facebook: '  ' },
      businessHours: OPEN_EVERY_DAY,
      rating: undefined,
    });
    expect(Object.keys(node)).not.toContain('sameAs');
  });

  it('emits one OpeningHoursSpecification per open day and none for a closed one', () => {
    const hours = OPEN_EVERY_DAY.map((day) =>
      day.weekday === 0 ? { ...day, isClosed: true, opensAt: null, closesAt: null } : day,
    );
    const node = travelAgencyNode({
      siteUrl: 'https://travelsugbo.com/',
      description: 'd',
      imageUrl: null,
      contact: CONTACT,
      businessHours: hours,
      rating: undefined,
    });

    const specs = node.openingHoursSpecification as Array<Record<string, unknown>>;
    expect(specs).toHaveLength(6);
    expect(specs.map((s) => s.dayOfWeek)).toEqual([
      'Monday',
      'Tuesday',
      'Wednesday',
      'Thursday',
      'Friday',
      'Saturday',
    ]);
    expect(specs[0]).toMatchObject({ opens: '07:00', closes: '21:00' });
  });
});

describe('faqPageNode', () => {
  const methods = [{ label: 'GCash' }, { label: 'Maya' }, { label: 'QR Ph' }];

  it('substitutes the {{paymentMethods}} token so the answer matches the rendered page', () => {
    const node = faqPageNode(
      [{ q: 'Which payment methods?', a: '{{paymentMethods}} Or transfer manually.' }],
      methods,
    )!;
    const [question] = list(node, 'mainEntity');
    expect(sub(question!, 'acceptedAnswer').text).toBe(
      'GCash, Maya and QR Ph through PayMongo. Or transfer manually.',
    );
    expect(JSON.stringify(node)).not.toContain('{{');
  });

  it('says so plainly when every online method is disabled', () => {
    const node = faqPageNode([{ q: 'Payment?', a: '{{paymentMethods}}' }], [])!;
    const [question] = list(node, 'mainEntity');
    expect(sub(question!, 'acceptedAnswer').text).toBe('Message us for current payment options.');
  });

  it('omits the whole node rather than emitting an empty mainEntity', () => {
    expect(faqPageNode([], methods)).toBeUndefined();
    expect(faqPageNode([{ q: 'Half a FAQ?', a: '   ' }], methods)).toBeUndefined();
  });
});

describe('touristTripNode', () => {
  it('omits the offer when a tour has no price tier at all', () => {
    const node = touristTripNode({
      name: 'Fixture Tour',
      url: 'https://travelsugbo.com/tours/fixture',
      description: 'd',
      imageUrl: null,
      priceCentavos: null,
      siteUrl: 'https://travelsugbo.com/',
      rating: undefined,
    });
    expect(Object.keys(node)).not.toContain('offers');
    expect(Object.keys(node)).not.toContain('itinerary');
    expect(sub(node, 'provider')).toMatchObject({
      '@id': 'https://travelsugbo.com/#organization',
    });
  });
});

// ---------------------------------------------------------------------------
// The graph each route publishes
// ---------------------------------------------------------------------------

function nodeOfType(nodes: unknown[], type: string): JsonLdNode {
  const node = graph(nodes).find((n) => n['@type'] === type);
  expect(node, `no ${type} node in the graph`).toBeDefined();
  return node!;
}

describeWithDb('home JSON-LD', () => {
  it('describes a TravelAgency under the brand, operated by the legal entity', async () => {
    const [agencyNode] = graph((await resolvePage('/')).jsonLd);
    expect(agencyNode!['@type']).toBe('TravelAgency');
    expect(agencyNode!.name).toBe('TravelSugbo');
    const parent = agencyNode!.parentOrganization as JsonLdNode | undefined;
    expect(parent?.name ?? agencyNode!.legalName).toBe('R&G Travel & Tours');
  });

  it('carries the real phone number and the Facebook page', async () => {
    const [agencyNode] = graph((await resolvePage('/')).jsonLd);
    expect(agencyNode!.telephone).toBe('+639084696246');
    expect(agencyNode!.sameAs).toContain('https://www.facebook.com/profile.php?id=61574390071362');
  });

  it('includes an FAQPage built from the FAQ settings, with the token substituted', async () => {
    const faq = nodeOfType((await resolvePage('/')).jsonLd, 'FAQPage');
    const questions = list(faq, 'mainEntity');
    expect(questions.length).toBeGreaterThan(0);
    expect(sub(questions[0]!, 'acceptedAnswer')['@type']).toBe('Answer');
    // The stored answer for the payment question holds `{{paymentMethods}}`;
    // publishing the raw token would disagree with the rendered page.
    expect(JSON.stringify(faq)).not.toContain('{{');
    expect(JSON.stringify(faq)).toContain('through PayMongo.');
  });

  it('OMITS aggregateRating while only sample reviews exist', async () => {
    const agencyNode = nodeOfType((await resolvePage('/')).jsonLd, 'TravelAgency');
    expect(Object.keys(agencyNode)).not.toContain('aggregateRating');
  });

  it('emits no invented permit or rating value anywhere in the graph', async () => {
    const json = JSON.stringify((await resolvePage('/')).jsonLd);
    expect(json).not.toMatch(/DOT-\d/);
    expect(json).not.toContain('4.9'); // the client-supplied figure is not a review average
    expect(json).not.toContain('AggregateRating');
  });

  it('is valid, parseable JSON with @context and @type on every node', async () => {
    for (const path of ['/', '/tours', '/privacy', '/terms']) {
      const nodes = graph((await resolvePage(path)).jsonLd);
      expect(nodes.length, path).toBeGreaterThan(0);
      for (const node of nodes) {
        expect(node['@context'], path).toBe('https://schema.org');
        expect(typeof node['@type'], path).toBe('string');
        expect(JSON.parse(JSON.stringify(node))).toEqual(node);
      }
    }
  });

  it('gives the organization the same @id on every page it appears on', async () => {
    const ids = await Promise.all(
      ['/', '/tours', '/privacy', '/terms', '/tours/oslob-whale-shark-tumalog-falls'].map(
        async (path) => nodeOfType((await resolvePage(path)).jsonLd, 'TravelAgency')['@id'],
      ),
    );
    expect(new Set(ids)).toEqual(new Set(['http://localhost:5180/#organization']));
  });

  it('publishes nothing at all on a 404 page', async () => {
    expect((await resolvePage('/nope')).jsonLd).toEqual([]);
    expect((await resolvePage('/tours/no-such-tour')).jsonLd).toEqual([]);
  });
});

describeWithDb('tour and package JSON-LD', () => {
  it('describes a TouristTrip with a PHP offer at the lowest tier price', async () => {
    const node = nodeOfType(
      (await resolvePage('/tours/oslob-whale-shark-tumalog-falls')).jsonLd,
      'TouristTrip',
    );
    expect(node.name).toBe('Oslob Whale Sharks + Tumalog Falls');
    expect(sub(node, 'offers').priceCurrency).toBe('PHP');
    expect(sub(node, 'offers').price).toBe('1890.00'); // pesos, from 189000 centavos
    expect(node.itinerary).toEqual({ '@type': 'Place', name: 'Oslob' });
  });

  it('omits aggregateRating when the tour has only sample reviews', async () => {
    const node = nodeOfType(
      (await resolvePage('/tours/oslob-whale-shark-tumalog-falls')).jsonLd,
      'TouristTrip',
    );
    // The seeded Oslob tour HAS a published review — a sample one, rated 5.
    expect(Object.keys(node)).not.toContain('aggregateRating');
  });

  it('offers a package at its discounted price, not its struck-through one', async () => {
    const node = nodeOfType(
      (await resolvePage('/packages/cebu-highlights-3d2n')).jsonLd,
      'TouristTrip',
    );
    expect(node.name).toBe('Cebu Highlights');
    expect(sub(node, 'offers').price).toBe('9800.00'); // new_price 980000, not old_price 1250000
    expect(JSON.stringify(node)).not.toContain('12500');
    expect(Object.keys(node)).not.toContain('aggregateRating');
  });
});

describeWithDb('aggregateRating — real reviews', () => {
  // Ids far outside the seeded auto-increment range, as the other SEO suites
  // do, so these rows never collide with seeded content.
  const DESTINATION_ID = 900_301;
  const TOUR_ID = 900_302;
  const SLUG = 'fixture-jsonld-tour';
  const PATH = `/tours/${SLUG}`;
  const insertedReviewIds: number[] = [];

  beforeAll(async () => {
    const db = getDb();
    await db
      .insert(destinations)
      .values({ id: DESTINATION_ID, name: 'Fixture Bay', slug: 'fixture-jsonld-bay' });
    await db
      .insert(tours)
      .values({ id: TOUR_ID, slug: SLUG, title: 'Fixture Tour', destinationId: DESTINATION_ID });
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

  afterEach(async () => {
    const db = getDb();
    for (const id of insertedReviewIds.splice(0)) {
      await db.delete(reviews).where(eq(reviews.id, id));
    }
  });

  async function addReview(rating: number, isSample: boolean): Promise<void> {
    const [result] = await getDb().insert(reviews).values({
      tourId: TOUR_ID,
      name: 'Fixture Reviewer',
      rating,
      body: 'Fixture review body.',
      status: 'published',
      isSample,
    });
    insertedReviewIds.push(result.insertId);
  }

  async function tripNode(): Promise<JsonLdNode> {
    return nodeOfType((await resolvePage(PATH)).jsonLd, 'TouristTrip');
  }

  it('still omits the key with three PUBLISHED SAMPLE reviews', async () => {
    await addReview(5, true);
    await addReview(5, true);
    await addReview(5, true);
    expect(Object.keys(await tripNode())).not.toContain('aggregateRating');
  });

  it('still omits the key with two real reviews — below minReviewsForRating (3)', async () => {
    await addReview(5, false);
    await addReview(4, false);
    expect(Object.keys(await tripNode())).not.toContain('aggregateRating');
  });

  it('publishes the rating once three real reviews exist, from those reviews only', async () => {
    await addReview(5, false);
    await addReview(5, false);
    await addReview(4, false);
    // A sample review alongside them must not move the average or the count.
    await addReview(1, true);

    const node = await tripNode();
    expect(sub(node, 'aggregateRating')).toEqual({
      '@type': 'AggregateRating',
      ratingValue: '4.7',
      reviewCount: 3,
      bestRating: 5,
      worstRating: 1,
    });
  });

  it("gives the organization node the site-wide real aggregate, not the tour's", async () => {
    await addReview(4, false);
    await addReview(4, false);
    await addReview(4, false);

    const home = nodeOfType((await resolvePage('/')).jsonLd, 'TravelAgency');
    expect(sub(home, 'aggregateRating')).toMatchObject({ ratingValue: '4.0', reviewCount: 3 });
  });
});
