/**
 * Schema.org JSON-LD node builders for the public site (task 4.2 / spec 5C).
 *
 * PURE: every builder is a function of its arguments. No database, no `env`,
 * no `absoluteUrl` — callers pass URLs already absolute (which also keeps
 * this module free of an import cycle with `seo/resolvers.ts`, the only
 * module that reads rows and knows the base URL). Nothing here is HTML
 * either: `seo/render.ts` serialises and escapes these nodes, once, for both
 * injection surfaces.
 *
 * THE RULE THAT GOVERNS THIS FILE — CLAUDE.md, "DO NOT fake social proof":
 * `aggregateRating` is built ONLY from `realAggregate()` (published reviews
 * with `is_sample = 0`), only once it clears `settings.trust.
 * minReviewsForRating`, and the key is OMITTED ENTIRELY otherwise — see
 * `aggregateRatingNode` and `compact` below. A zero-count AggregateRating is
 * both a structured-data error and a false claim about a real business, and
 * `settings.trust.ratingAverage` (a client-supplied marketing figure, 4.9
 * today) is NOT a review average and never reaches structured data.
 *
 * Likewise absent: permit numbers. `settings.permits` is `null` across the
 * board and renders as "— pending —" on the page; an accreditation claim in
 * machine-readable form would be worse than one in prose, so there is no
 * `hasCredential` here and `trust.dotAccredited` is not emitted.
 */
import type { SettingsBlocks } from '../content/settings-schema';
import type { Aggregate } from '../services/ratings';
import { BRAND, LEGAL_OPERATOR } from './brand';

/** One `<script type="application/ld+json">` node. */
export type JsonLdNode = Record<string, unknown>;

const CONTEXT = 'https://schema.org';

/** The fragment that gives the organization one stable `@id` across every page. */
const ORGANIZATION_FRAGMENT = '#organization';

/** Weekday 0 = Sunday, matching `settings.business_hours` (and `Date#getDay`). */
const DAY_NAMES = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
] as const;

/**
 * Drops keys whose value is `undefined`, so "we have no data for this" is an
 * ABSENT KEY rather than `null`, `0` or `{}`.
 *
 * This is the mechanism behind the rule at the top of the file: a builder
 * writes `aggregateRating: maybeRating` and, when there is no real rating,
 * the property does not exist on the returned object at all — not in the
 * emitted JSON, and not to a caller that reads it with `in`.
 */
function compact(node: Record<string, unknown>): JsonLdNode {
  return Object.fromEntries(Object.entries(node).filter(([, value]) => value !== undefined));
}

/** A trimmed non-empty string, or undefined — an empty settings field is "no value", not "". */
function text(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

/**
 * Integer centavos as a Schema.org currency amount: pesos, two decimals,
 * no symbol and no thousands separator (`189000` -> `'1890.00'`).
 *
 * Deliberately NOT `formatPeso()` from `@rg/shared`, which produces display
 * copy (`'₱1,890'`) that a parser cannot read. Centavos remain the internal
 * representation everywhere else.
 */
export function pesoAmount(centavos: number): string {
  return (Math.round(centavos) / 100).toFixed(2);
}

/**
 * An `AggregateRating` node, or `undefined` when no rating may be published.
 *
 * `aggregate` MUST come from `realAggregate()` — samples excluded. Two gates,
 * both of which must return `undefined` rather than a zeroed node:
 *   - no real published reviews at all (`null`), which is today's state for
 *     every tour and for the site as a whole; and
 *   - fewer than `minReviewsForRating` of them (settings.trust, 3 today) —
 *     the same withholding threshold the on-page star ratings respect.
 */
export function aggregateRatingNode(
  aggregate: Aggregate | null,
  minReviewsForRating: number,
): JsonLdNode | undefined {
  if (!aggregate) return undefined;
  if (aggregate.count < minReviewsForRating) return undefined;

  return {
    '@type': 'AggregateRating',
    // One decimal: a 4.666… average publishes as '4.7', not as float noise.
    ratingValue: aggregate.average.toFixed(1),
    reviewCount: aggregate.count,
    bestRating: 5,
    worstRating: 1,
  };
}

function openingHoursSpecification(
  hours: SettingsBlocks['business_hours'],
): JsonLdNode[] | undefined {
  const specs = hours.flatMap((day) => {
    if (day.isClosed || !day.opensAt || !day.closesAt) return [];
    return [
      {
        '@type': 'OpeningHoursSpecification',
        dayOfWeek: DAY_NAMES[day.weekday],
        opens: day.opensAt,
        closes: day.closesAt,
      },
    ];
  });

  return specs.length > 0 ? specs : undefined;
}

export interface AgencyInput {
  /** Absolute home-page URL. Also the base of the organization's `@id`. */
  siteUrl: string;
  /** `settings.site_seo.description` — the site's own words, not generated copy. */
  description: string;
  /** Absolute image URL from the page's og:image chain, or null. */
  imageUrl: string | null;
  contact: SettingsBlocks['contact'];
  businessHours: SettingsBlocks['business_hours'];
  /** From `aggregateRatingNode()`. `undefined` omits the key — never pass a zeroed node. */
  rating: JsonLdNode | undefined;
}

/** `<siteUrl>#organization` — the one `@id` every page's provider reference points at. */
export function organizationId(siteUrl: string): string {
  return `${siteUrl.replace(/\/+$/, '')}/${ORGANIZATION_FRAGMENT}`;
}

/**
 * The site's identity node, emitted on every indexable page with the same
 * `@id` so search engines treat the set as one organization.
 *
 * `name` is the brand; `legalName` is the licensed operator, which is what
 * Schema.org's `legalName` means ("the official name of the organization,
 * e.g. the registered company name"). `address` is deliberately absent:
 * `settings.contact.address` is still `'Office address pending — Cebu,
 * Philippines'`, and publishing a placeholder as a PostalAddress — or
 * inventing a street — is worse than having no address property.
 */
export function travelAgencyNode(input: AgencyInput): JsonLdNode {
  const sameAs = [input.contact.facebook]
    .map(text)
    .filter((url): url is string => url !== undefined);

  return compact({
    '@context': CONTEXT,
    '@type': 'TravelAgency',
    '@id': organizationId(input.siteUrl),
    name: BRAND,
    legalName: LEGAL_OPERATOR,
    url: input.siteUrl,
    description: input.description,
    image: input.imageUrl ?? undefined,
    telephone: text(input.contact.phoneTel),
    email: text(input.contact.email),
    areaServed: 'Cebu, Philippines',
    sameAs: sameAs.length > 0 ? sameAs : undefined,
    openingHoursSpecification: openingHoursSpecification(input.businessHours),
    aggregateRating: input.rating,
  });
}

// ---------------------------------------------------------------------------
// FAQPage
// ---------------------------------------------------------------------------

/**
 * `{{paymentMethods}}` — the token an admin may put in any stored FAQ answer,
 * substituted from the live enabled payment methods. Mirrors
 * `client/src/components/home/FaqSection.tsx`, because Google requires the
 * answer text in the markup to match the answer text on the page: emitting
 * the raw token would publish `'{{paymentMethods}}'` to search results while
 * visitors read 'GCash, Maya … through PayMongo.'
 */
const PAYMENT_METHODS_TOKEN = '{{paymentMethods}}';

/** `['A','B','C']` -> `'A, B and C'` — no Oxford comma, matching the seeded answer's style. */
function formatList(items: string[]): string {
  if (items.length === 0) return '';
  if (items.length === 1) return items[0]!;
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

function paymentMethodsSentence(methods: { label: string }[]): string {
  const list = formatList(methods.map((method) => method.label));
  if (!list) return 'Message us for current payment options.';
  return `${list} through PayMongo.`;
}

function resolveAnswer(answer: string, methods: { label: string }[]): string {
  if (!answer.includes(PAYMENT_METHODS_TOKEN)) return answer;
  return answer.split(PAYMENT_METHODS_TOKEN).join(paymentMethodsSentence(methods));
}

/**
 * An `FAQPage` from `settings.faqs`, or `undefined` when there is nothing to
 * publish — an empty `mainEntity` array is an invalid FAQPage, so the node is
 * omitted rather than emitted hollow.
 *
 * `methods` must already be enabled-only and sorted (`resolvePaymentMethods`,
 * server/src/content/settings.ts) — the same list the footer's payment chips
 * and the on-page answer render from.
 */
export function faqPageNode(
  faqs: SettingsBlocks['faqs'],
  methods: { label: string }[],
): JsonLdNode | undefined {
  const mainEntity = faqs.flatMap((faq) => {
    const question = text(faq.q);
    const answer = text(resolveAnswer(faq.a, methods));
    if (!question || !answer) return [];

    return [
      {
        '@type': 'Question',
        name: question,
        acceptedAnswer: { '@type': 'Answer', text: answer },
      },
    ];
  });

  if (mainEntity.length === 0) return undefined;

  return { '@context': CONTEXT, '@type': 'FAQPage', mainEntity };
}

// ---------------------------------------------------------------------------
// Trips — day tours and multi-day packages
// ---------------------------------------------------------------------------

export interface TripInput {
  /** The product's own name, not the SEO title. */
  name: string;
  /** Absolute canonical URL of the page describing it. */
  url: string;
  description: string;
  imageUrl: string | null;
  /** Integer centavos — the lowest price a guest can pay. Null omits the offer. */
  priceCentavos: number | null;
  /** A `Place` name for `itinerary`, when the row has a real one. Omitted otherwise. */
  destinationName?: string | null;
  /** Absolute home-page URL, for the `provider` reference's `@id`. */
  siteUrl: string;
  /** From `aggregateRatingNode()`. `undefined` omits the key. */
  rating: JsonLdNode | undefined;
}

/**
 * The offer. `price` is pesos with two decimals and `priceCurrency` is PHP —
 * Schema.org wants a currency amount, not this project's internal centavos.
 *
 * No `availability`: whether a given date has a van free is a live
 * calendar question this node cannot answer, and `InStock` on a page that
 * might be fully booked would be a claim we have not checked.
 */
function offerNode(priceCentavos: number | null, url: string): JsonLdNode | undefined {
  if (priceCentavos === null) return undefined;

  return {
    '@type': 'Offer',
    price: pesoAmount(priceCentavos),
    priceCurrency: 'PHP',
    url,
  };
}

/**
 * A `TouristTrip` for one tour or package.
 *
 * `TouristTrip` for both: Schema.org's `Trip` models "an itinerary of visits
 * to one or more places", which is a day tour and a 3-day package alike. The
 * duration is not emitted — `Trip` has no `duration` property (only
 * `arrivalTime`/`departureTime`, which no row here holds), and inventing a
 * departure time to carry a 14-hour figure would be fabricating data.
 */
export function touristTripNode(input: TripInput): JsonLdNode {
  const destination = text(input.destinationName);

  return compact({
    '@context': CONTEXT,
    '@type': 'TouristTrip',
    name: input.name,
    url: input.url,
    description: input.description,
    image: input.imageUrl ?? undefined,
    itinerary: destination ? { '@type': 'Place', name: destination } : undefined,
    provider: {
      '@type': 'TravelAgency',
      '@id': organizationId(input.siteUrl),
      name: BRAND,
    },
    offers: offerNode(input.priceCentavos, input.url),
    aggregateRating: input.rating,
  });
}
