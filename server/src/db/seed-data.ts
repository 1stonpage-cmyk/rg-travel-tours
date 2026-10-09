/**
 * Today's content, transcribed verbatim from `client/src/lib/placeholder-data.ts`
 * and `client/src/lib/site.ts`, so that when a later task switches the public
 * site over to the API, the rendered page is indistinguishable from today.
 *
 * Two rulings govern the shape of this data (see the task-1.4 brief):
 *
 *  - Price tiers: three `tour_price_tiers` rows per tour, descending with
 *    group size ("Prices drop as your group grows"). The MINIMUM tier
 *    (7-12 pax) equals today's `fromPriceCentavos` exactly, so the "from"
 *    price card never moves:
 *      1-2 pax -> base + 40000
 *      3-6 pax -> base + 20000
 *      7-12 pax -> base
 *
 *  - Destinations: the chip row ("Badian / Kawasan") and the Most Visited
 *    section ("Kawasan Falls") render different labels and different
 *    orderings for the same six rows. `name`/`sortOrder` drive the chip row;
 *    `displayName`/`featuredSortOrder` (both nullable) drive Most Visited.
 *    Only `badian-kawasan` has a non-null `displayName` — every other
 *    destination falls back to `name`, which is the point of the column.
 *
 * `historicalTripsCount` is NULL on every tour: booking counters stay hidden
 * until real bookings exist, never faked (CLAUDE.md: no fake numbers).
 * Permit numbers are null: never invent an accreditation number.
 */
import type { SettingsBlocks } from '../content/settings-schema';

const placeholderImage = (slug: string) => `/placeholders/${slug}.svg`;

// ---------------------------------------------------------------------------
// Destinations
// ---------------------------------------------------------------------------

export interface SeedDestination {
  slug: string;
  name: string;
  /** Most Visited label override. Null means "use `name`". */
  displayName: string | null;
  blurb: string;
  imagePath: string;
  imageAlt: string;
  /** Drives the destination chip row order. */
  sortOrder: number;
  /** Drives the Most Visited section order (independent of `sortOrder`). */
  featuredSortOrder: number | null;
  isFeatured: boolean;
}

export const SEED_DESTINATIONS: SeedDestination[] = [
  {
    slug: 'oslob',
    name: 'Oslob',
    displayName: null,
    blurb: 'Swim beside whale sharks at sunrise, then cool off under Tumalog Falls.',
    imagePath: placeholderImage('oslob'),
    imageAlt: 'Placeholder image for Oslob',
    sortOrder: 0,
    featuredSortOrder: 0,
    isFeatured: true,
  },
  {
    slug: 'mactan',
    name: 'Mactan',
    displayName: null,
    blurb: 'Island hopping, sandbars and reef snorkelling minutes from the airport.',
    imagePath: placeholderImage('mactan'),
    imageAlt: 'Placeholder image for Mactan',
    sortOrder: 1,
    featuredSortOrder: 3,
    isFeatured: true,
  },
  {
    slug: 'badian-kawasan',
    name: 'Badian / Kawasan',
    // The only destination with a Most Visited label distinct from `name`.
    displayName: 'Kawasan Falls',
    blurb: 'Three tiers of turquoise water and the island’s best canyoneering run.',
    imagePath: placeholderImage('badian-kawasan'),
    imageAlt: 'Placeholder image for Kawasan Falls in Badian',
    sortOrder: 2,
    featuredSortOrder: 1,
    isFeatured: true,
  },
  {
    slug: 'moalboal',
    name: 'Moalboal',
    displayName: null,
    blurb: 'Millions of sardines a few metres from the shoreline at Panagsama.',
    imagePath: placeholderImage('moalboal'),
    imageAlt: 'Placeholder image for Moalboal',
    sortOrder: 3,
    featuredSortOrder: 2,
    isFeatured: true,
  },
  {
    slug: 'bohol',
    name: 'Bohol',
    displayName: null,
    blurb: 'Chocolate Hills, tarsiers and the Loboc River, all in one long day.',
    imagePath: placeholderImage('bohol'),
    imageAlt: 'Placeholder image for Bohol',
    sortOrder: 4,
    featuredSortOrder: 4,
    isFeatured: true,
  },
  {
    slug: 'cebu-city',
    name: 'Cebu City',
    displayName: null,
    blurb: 'Magellan’s Cross, Taoist Temple and Tops Lookout with a local guide.',
    imagePath: placeholderImage('cebu-city'),
    imageAlt: 'Placeholder image for Cebu City',
    sortOrder: 5,
    featuredSortOrder: 5,
    isFeatured: true,
  },
];

// ---------------------------------------------------------------------------
// Tours
// ---------------------------------------------------------------------------

export interface SeedPriceTier {
  minPax: number;
  maxPax: number;
  pricePerPerson: number;
}

export interface SeedTourImage {
  path: string;
  alt: string;
  width: number;
  height: number;
  sortOrder: number;
}

export interface SeedTour {
  slug: string;
  title: string;
  destinationSlug: string;
  durationHours: number;
  sortOrder: number;
  isFeatured: boolean;
  /**
   * Fix round 2 (Task 1.6 review, F1): `client/src/lib/placeholder-data.ts`
   * carries an explicit per-tour `freeCancellation` boolean today, and
   * `TourCard.tsx` renders a "Free cancellation" badge from it on five of
   * the six tours. `tours.list` derives that same boolean server-side as
   * `free_cancel_hours != null && > 0` (correct), but this field was left
   * NULL on every seeded tour, so all six badges vanished — a visible
   * regression the "rendered page must be indistinguishable" bar forbids.
   *
   * 24 is a PLACEHOLDER cancellation window, not a confirmed policy number
   * — nobody at the business has signed off on it. It reproduces today's
   * page exactly because only the derived boolean is rendered anywhere
   * right now; the hours value itself has no on-screen consumer yet. A
   * future tour-detail page that displays the window must get a real,
   * client-confirmed number before shipping, not this one by default.
   * `null` for mactan-island-hopping matches today's `false` exactly —
   * not a lesser guess, the correct value.
   */
  freeCancelHours: number | null;
  priceTiers: SeedPriceTier[];
  images: SeedTourImage[];
}

/** Ruling 1: lowest tier equals `base` exactly — the displayed "from" price. */
function priceTiersFrom(base: number): SeedPriceTier[] {
  return [
    { minPax: 1, maxPax: 2, pricePerPerson: base + 40_000 },
    { minPax: 3, maxPax: 6, pricePerPerson: base + 20_000 },
    { minPax: 7, maxPax: 12, pricePerPerson: base },
  ];
}

/** All seeded tour images are the generated 1200x800 placeholder SVGs. */
function singleImage(slug: string, alt: string): SeedTourImage[] {
  return [{ path: placeholderImage(slug), alt, width: 1200, height: 800, sortOrder: 0 }];
}

export const SEED_TOURS: SeedTour[] = [
  {
    slug: 'oslob-whale-shark-tumalog-falls',
    title: 'Oslob Whale Sharks + Tumalog Falls',
    destinationSlug: 'oslob',
    durationHours: 14,
    sortOrder: 0,
    isFeatured: true,
    freeCancelHours: 24,
    priceTiers: priceTiersFrom(189_000),
    images: singleImage(
      'oslob',
      'Placeholder image for the Oslob whale shark and Tumalog Falls day tour',
    ),
  },
  {
    slug: 'kawasan-falls-canyoneering',
    title: 'Kawasan Falls Canyoneering',
    destinationSlug: 'badian-kawasan',
    durationHours: 13,
    sortOrder: 1,
    isFeatured: true,
    freeCancelHours: 24,
    priceTiers: priceTiersFrom(215_000),
    images: singleImage(
      'badian-kawasan',
      'Placeholder image for the Kawasan Falls canyoneering day tour',
    ),
  },
  {
    slug: 'moalboal-sardine-run-turtles',
    title: 'Moalboal Sardine Run & Sea Turtles',
    destinationSlug: 'moalboal',
    durationHours: 12,
    sortOrder: 2,
    isFeatured: true,
    freeCancelHours: 24,
    priceTiers: priceTiersFrom(175_000),
    images: singleImage(
      'moalboal',
      'Placeholder image for the Moalboal sardine run and sea turtle snorkelling tour',
    ),
  },
  {
    slug: 'mactan-island-hopping',
    title: 'Mactan Island Hopping & Snorkelling',
    destinationSlug: 'mactan',
    durationHours: 8,
    sortOrder: 3,
    isFeatured: true,
    // Matches today's `freeCancellation: false` in placeholder-data.ts exactly.
    freeCancelHours: null,
    priceTiers: priceTiersFrom(145_000),
    images: singleImage(
      'mactan',
      'Placeholder image for the Mactan island hopping and snorkelling tour',
    ),
  },
  {
    slug: 'cebu-city-heritage-tour',
    title: 'Cebu City Heritage & Temple Tour',
    destinationSlug: 'cebu-city',
    durationHours: 6,
    sortOrder: 4,
    isFeatured: true,
    freeCancelHours: 24,
    priceTiers: priceTiersFrom(98_000),
    images: singleImage(
      'cebu-city',
      'Placeholder image for the Cebu City heritage and temple tour',
    ),
  },
  {
    slug: 'bohol-countryside-chocolate-hills',
    title: 'Bohol Countryside & Chocolate Hills',
    destinationSlug: 'bohol',
    durationHours: 15,
    sortOrder: 5,
    isFeatured: true,
    freeCancelHours: 24,
    priceTiers: priceTiersFrom(245_000),
    images: singleImage(
      'bohol',
      'Placeholder image for the Bohol countryside and Chocolate Hills tour',
    ),
  },
];

// ---------------------------------------------------------------------------
// Packages
// ---------------------------------------------------------------------------

export interface SeedPackage {
  slug: string;
  title: string;
  days: number;
  oldPrice: number;
  newPrice: number;
  description: string;
  imagePath: string;
  imageAlt: string;
  highlights: string[];
  sortOrder: number;
}

export const SEED_PACKAGES: SeedPackage[] = [
  {
    slug: 'cebu-highlights-3d2n',
    title: 'Cebu Highlights',
    days: 3,
    oldPrice: 1_250_000,
    newPrice: 980_000,
    description:
      'City heritage, Oslob whale sharks and Kawasan canyoneering with hotel transfers included.',
    imagePath: placeholderImage('package-cebu-highlights'),
    imageAlt: 'Placeholder image for the 3-day Cebu Highlights package',
    highlights: ['Private van throughout', 'Licensed guide', '2 nights accommodation'],
    sortOrder: 0,
  },
  {
    slug: 'cebu-bohol-5d4n',
    title: 'Cebu & Bohol Explorer',
    days: 5,
    oldPrice: 2_450_000,
    newPrice: 1_890_000,
    description:
      'South Cebu plus a Bohol countryside crossing — Chocolate Hills, tarsiers and the Loboc River.',
    imagePath: placeholderImage('package-cebu-bohol'),
    imageAlt: 'Placeholder image for the 5-day Cebu and Bohol Explorer package',
    highlights: ['Ferry transfers', 'Island hopping day', '4 nights accommodation'],
    sortOrder: 1,
  },
  {
    slug: 'south-cebu-escape-4d3n',
    title: 'South Cebu Escape',
    days: 4,
    oldPrice: 1_680_000,
    newPrice: 1_340_000,
    description: 'Moalboal sardines, Badian canyoneering and Osmeña Peak sunrise at a slower pace.',
    imagePath: placeholderImage('package-south-cebu'),
    imageAlt: 'Placeholder image for the 4-day South Cebu Escape package',
    highlights: ['Sunrise trek', 'Snorkel gear included', '3 nights accommodation'],
    sortOrder: 2,
  },
];

// ---------------------------------------------------------------------------
// Reviews — all published, all samples (D1). Matched to their tour by title.
// ---------------------------------------------------------------------------

export interface SeedReview {
  name: string;
  tourSlug: string;
  rating: number;
  body: string;
  status: 'published';
  isSample: true;
}

export const SEED_REVIEWS: SeedReview[] = [
  {
    name: 'Placeholder Guest A',
    tourSlug: 'oslob-whale-shark-tumalog-falls',
    rating: 5,
    body: 'Placeholder review copy. Real guest reviews are published only after admin approval (spec task 7A).',
    status: 'published',
    isSample: true,
  },
  {
    name: 'Placeholder Guest B',
    tourSlug: 'kawasan-falls-canyoneering',
    rating: 5,
    body: 'Placeholder review copy. This card demonstrates the verified-booking badge and star layout.',
    status: 'published',
    isSample: true,
  },
  {
    name: 'Placeholder Guest C',
    tourSlug: 'moalboal-sardine-run-turtles',
    rating: 4,
    body: 'Placeholder review copy showing a four-star entry so the breakdown is not uniform.',
    status: 'published',
    isSample: true,
  },
  {
    name: 'Placeholder Guest D',
    tourSlug: 'mactan-island-hopping',
    rating: 5,
    body: 'Placeholder review copy. Replace with published reviews from the reviews table.',
    status: 'published',
    isSample: true,
  },
  {
    name: 'Placeholder Guest E',
    tourSlug: 'bohol-countryside-chocolate-hills',
    rating: 5,
    body: 'Placeholder review copy used to fill the grid on wide screens.',
    status: 'published',
    isSample: true,
  },
  {
    name: 'Placeholder Guest F',
    tourSlug: 'cebu-city-heritage-tour',
    rating: 4,
    body: 'Placeholder review copy. Sub-scores (guide, value, punctuality, safety) arrive in task 2D.',
    status: 'published',
    isSample: true,
  },
];

// ---------------------------------------------------------------------------
// Settings — every key in SETTING_SCHEMAS, from PLACEHOLDER_SETTINGS, FAQS,
// HOW_IT_WORKS, WHY_BOOK_DIRECT and SITE.
// ---------------------------------------------------------------------------

const DEPOSIT_PERCENT = 30;

const LEGAL_TODO_LINE =
  '> **TODO: client legal review.** This text is a placeholder and is not legal advice.';

export const SEED_SETTINGS: SettingsBlocks = {
  // D1 / spec section 0 driver: the on-site placeholder banner and the
  // production-build gate both read this.
  content_unverified: true,

  // Verbatim from client/index.html — today's actual <title>/<meta description>.
  site_seo: {
    title: 'TravelSugbo — Cebu Day Tours & Packages',
    description:
      'Book Cebu day tours and multi-day packages direct with TravelSugbo. Private vans, licensed drivers, pay a 30% deposit online.',
    ogImage: null,
  },

  // From PLACEHOLDER_SETTINGS. ratingAverage/guestsServed are client-supplied,
  // not invented (carried across as-is). ratingCount stays null: no
  // client-supplied review count exists yet. minReviewsForRating is the
  // client's Task 1.9 (R1) ruling: withhold a tour's displayed rating below
  // this many published reviews (sample or real) in favor of a "New" badge.
  trust: {
    ratingAverage: 4.9,
    ratingCount: null,
    guestsServed: 15_000,
    dotAccredited: true,
    depositPercent: DEPOSIT_PERCENT,
    minReviewsForRating: 3,
  },

  // From HeroSection.tsx — today's real hero copy and photo (not a placeholder image).
  hero: {
    eyebrow: 'Cebu, Philippines',
    headline: 'Private Cebu day tours, booked direct with the people who run them.',
    subtitle: `Whale sharks, canyoneering and island hopping in your own van with a licensed driver. Reserve with a ${DEPOSIT_PERCENT}% deposit.`,
    ctaLabel: 'Search tours',
    imagePath: '/hero/hero-cebu-1920.jpg',
    imageAlt:
      'The stone gateway of Fort San Pedro in Cebu City, framed by palm trees under a clear blue sky.',
  },

  // No announcement bar exists on the site today, so there is no "today's
  // content" to transcribe here — unlike every other block in this file,
  // this message is NOT sourced from placeholder-data.ts/site.ts. It is a
  // self-describing TODO, not invented marketing copy, and isActive: false
  // keeps it off until an admin both supplies real copy and turns it on.
  announcement: {
    message: 'TODO: client to supply announcement copy.',
    href: null,
    style: 'info',
    startsAt: null,
    endsAt: null,
    isActive: false,
  },

  // From PromoNewsletter.tsx — today's real newsletter-signup promo, always on.
  promo: {
    code: 'RGTOURS10',
    discountLabel: '10% off',
    headline: 'Get 10% off your first tour',
    body: 'Join the list for Cebu trip tips and seasonal offers. We send a few emails a year and never share your address.',
    startsAt: null,
    endsAt: null,
    isActive: true,
  },

  // From SITE.contact.hours: 'Mon–Sun, 7:00 AM – 9:00 PM (PHT)' — open every day, same window.
  business_hours: Array.from({ length: 7 }, (_, weekday) => ({
    weekday,
    opensAt: '07:00',
    closesAt: '21:00',
    isClosed: false,
  })),

  // From SITE.paymentMethods, in the order shown there.
  payment_methods: ['GCash', 'Maya', 'GrabPay', 'QR Ph', 'Visa', 'Mastercard'].map(
    (label, sortOrder) => ({
      key: label.toLowerCase().replace(/\s+/g, '_'),
      label,
      enabled: true,
      sortOrder,
    }),
  ),

  // From SITE.permits — never invent an accreditation number.
  permits: { dot: null, dti: null, bir: null },

  // Verbatim from HOW_IT_WORKS.
  how_it_works: [
    {
      step: 1,
      title: 'Pick a tour and date',
      body: 'Choose your destination, date and group size. Live availability, no waiting for a reply.',
    },
    {
      step: 2,
      title: 'Reserve with 30% deposit',
      body: 'Pay the deposit or the full amount by GCash, Maya, GrabPay, QR Ph or card.',
    },
    {
      step: 3,
      title: 'Get your driver details',
      body: 'We assign a van and driver, then send you their name, plate number and contact.',
    },
    {
      step: 4,
      title: 'Meet your guide',
      body: 'Your driver arrives at your pickup point. Settle any balance on the day.',
    },
  ],

  // Verbatim from WHY_BOOK_DIRECT.
  why_book_direct: [
    {
      icon: 'tag',
      title: 'No platform mark-up',
      body: 'Booking here skips agency commissions, so the price you see is the operator price.',
    },
    {
      icon: 'wallet',
      title: 'Pay 30% to reserve',
      body: 'Hold your date with a deposit and settle the balance on tour day.',
    },
    {
      icon: 'shield',
      title: 'Licensed vans and drivers',
      body: 'Every trip runs on an accredited van with a professional, insured driver.',
    },
    {
      icon: 'headset',
      title: 'Talk to a real person',
      body: 'Message us on WhatsApp or Viber and reach the team running your trip.',
    },
    {
      icon: 'calendar',
      title: 'Flexible changes',
      body: 'Free cancellation on most tours within the window shown on each tour page.',
    },
    {
      icon: 'map',
      title: 'Local itineraries',
      body: 'Routes built by Cebu-based guides, timed to miss the crowds.',
    },
  ],

  // Verbatim from FAQS, with PLACEHOLDER_SETTINGS.depositPercent (30) resolved.
  faqs: [
    {
      q: 'How much deposit do I need to pay?',
      a: `A ${DEPOSIT_PERCENT}% deposit reserves your date. The balance is collected on tour day. You can also pay in full online.`,
    },
    {
      q: 'Which payment methods do you accept?',
      a: 'GCash, Maya, GrabPay, QR Ph and major cards through PayMongo. You can also transfer manually to our QR code and upload the receipt for verification.',
    },
    {
      q: 'Can I cancel or reschedule?',
      a: 'Most tours include free cancellation within the window shown on the tour page. Message us and we will move your date where availability allows.',
    },
    {
      q: 'Is hotel pickup included?',
      a: 'Yes. Pickup within Cebu City, Mandaue, Lapu-Lapu and Mactan is included. Outside those areas we will quote a small transfer fee.',
    },
    {
      q: 'What should I bring?',
      a: 'Swimwear, a towel, reef-safe sunscreen, a dry bag and a valid ID. Canyoneering tours provide helmets and life vests.',
    },
    {
      q: 'Do you run private or joiner tours?',
      a: 'All tours are private by default — your group gets its own van and driver. Group pricing drops as your party grows.',
    },
    {
      q: 'How do I reach you on tour day?',
      a: 'Your confirmation includes your driver’s mobile number and the office hotline. The WhatsApp button on this site reaches us any time.',
    },
  ],

  // Mirrors client/src/lib/site.ts exactly — site.ts stays the source of truth;
  // server/src/__tests__/seed-parity.test.ts pins these values to it.
  contact: {
    address: 'Office address pending — Cebu, Philippines',
    tagline: 'Cebu day tours and multi-day packages, booked direct.',
    hoursNote: 'Mon–Sun, 7:00 AM – 9:00 PM (PHT)',
    // site.ts's committed fallback literal (`?? 'hello@travelsugbo.com'`) —
    // deliberately ignores any VITE_CONTACT_EMAIL env override, since this
    // seed can't read the client's Vite env. Assumption, not an oversight.
    email: 'hello@travelsugbo.com',
    phoneDisplay: '0908 469 6246',
    phoneTel: '+639084696246',
    whatsapp: '639084696246',
    altPhoneDisplay: '0927 737 8431',
    altPhoneTel: '+639277378431',
    facebook: 'https://www.facebook.com/profile.php?id=61574390071362',
    motto: 'Your journey, our priority',
    otherServices: {
      before: 'Need a van transfer, flights or a hotel?',
      link: 'Message us',
      after: '— R&G also handles airline booking, hotel reservations and spot transportation.',
    },
  },

  // Placeholder legal copy — not legal advice, flagged for client review.
  legal_privacy: {
    markdown: `${LEGAL_TODO_LINE}

# Privacy Notice

TravelSugbo (operated by R&G Travel & Tours) collects the contact and booking
details you provide when you reserve a tour, so we can confirm your trip and
assign a driver.

## What we collect

Name, email, phone number, and the payment references needed to process your
booking. We never see or store your card number, CVV or e-wallet credentials —
PayMongo handles that directly.

## How we use it

Only to run your booking: confirmations, driver assignment, receipts, and
replying to enquiries you send us.

## Your rights

Under the Data Privacy Act of 2012 (RA 10173), you may ask to access, correct
or delete the personal data we hold about you. Contact us using the details
on this site.

This placeholder will be replaced with a reviewed privacy notice before launch.`,
    updatedAt: '2026-10-09T00:00:00.000Z',
  },
  legal_terms: {
    markdown: `${LEGAL_TODO_LINE}

# Terms of Service

These placeholder terms cover booking, payment and cancellation at a high
level while the client's reviewed terms are pending.

## Booking and payment

A deposit reserves your date; the balance is due on tour day unless you pay
in full online. All prices are shown in Philippine pesos.

## Cancellations

Cancellation windows vary by tour and are shown on each tour's page before
you book.

## Conduct and safety

Guests must follow their guide's safety instructions. TravelSugbo and
R&G Travel & Tours reserve the right to refuse service for unsafe conduct.

## Changes to these terms

These terms may change before launch as the client's legal review proceeds.

This placeholder will be replaced with reviewed terms before launch.`,
    updatedAt: '2026-10-09T00:00:00.000Z',
  },
};
