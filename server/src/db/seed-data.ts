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
  pricePerPersonCentavos: number;
}

export interface SeedTourImage {
  path: string;
  alt: string;
  width: number;
  height: number;
  sortOrder: number;
}

/**
 * One stop on a tour's route, in the order the van reaches it. `sortOrder` is
 * 1-based and contiguous within a tour; `description` is `null` unless it
 * tells a driver something the name does not.
 */
export interface SeedItineraryStop {
  sortOrder: number;
  name: string;
  description: string | null;
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
  /** Written to `rg_travel` only; the test database ships none. See `SEED_TOURS`. */
  stops: SeedItineraryStop[];
}

/** Ruling 1: lowest tier equals `base` exactly — the displayed "from" price. */
function priceTiersFrom(base: number): SeedPriceTier[] {
  return [
    { minPax: 1, maxPax: 2, pricePerPersonCentavos: base + 40_000 },
    { minPax: 3, maxPax: 6, pricePerPersonCentavos: base + 20_000 },
    { minPax: 7, maxPax: 12, pricePerPersonCentavos: base },
  ];
}

/** All seeded tour images are the generated 1200x800 placeholder SVGs. */
function singleImage(slug: string, alt: string): SeedTourImage[] {
  return [{ path: placeholderImage(slug), alt, width: 1200, height: 800, sortOrder: 0 }];
}

/*
 * ITINERARY STOPS (Week 6.5, Task 11 / C4) are APP-DATABASE ONLY: `seed.ts`
 * writes them for `rg_travel` and never for `rg_travel_test`, whose suites
 * count stops to decide how far a trip has got.
 *
 * They are real Cebu and Bohol places in the order a van reaches them, so a
 * driver's itinerary screen and the departures board have something to show on
 * a fresh clone. They are still SEED CONTENT: `settings.content_unverified`
 * is set and the production build is still gated by
 * `client/scripts/check-placeholders.mjs`, so none of this publishes. Whoever
 * replaces the seed content with the operator's real routes replaces these
 * too, and the operator's dispatcher, not this file, is the authority on stop
 * order and timing.
 *
 * No stop carries a permit, accreditation or price; a place name is not an
 * accreditation number and none is invented here.
 */
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
    stops: [
      {
        sortOrder: 1,
        name: 'Oslob whale shark watching, Tan-awan',
        description: 'Registration and the briefing come before anyone enters the water.',
      },
      { sortOrder: 2, name: 'Tumalog Falls, Barangay Tumalog', description: null },
      {
        sortOrder: 3,
        name: 'Simala Shrine, Sibonga',
        description: 'Last stop of the day, on the way back north.',
      },
    ],
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
    stops: [
      {
        sortOrder: 1,
        name: 'Badian canyoneering jump-off, Matutinao',
        description: 'Gear fitting and the guide briefing happen here.',
      },
      { sortOrder: 2, name: 'Kawasan Falls, Matutinao', description: null },
      {
        sortOrder: 3,
        name: 'Carcar chicharon stop, Carcar City',
        description: 'Short food stop on the way home.',
      },
    ],
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
    stops: [
      {
        sortOrder: 1,
        name: 'Panagsama Beach, Moalboal',
        description: 'Sardines and sea turtles are both snorkelled straight off this beach.',
      },
      { sortOrder: 2, name: 'Pescador Island, Moalboal', description: null },
      { sortOrder: 3, name: 'Basdiot White Beach, Moalboal', description: null },
      {
        sortOrder: 4,
        name: 'Carcar chicharon stop, Carcar City',
        description: 'Short food stop on the way home.',
      },
    ],
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
    stops: [
      {
        sortOrder: 1,
        name: 'Mactan boat landing, Cordova',
        description: 'Boat briefing and life jackets before departure.',
      },
      { sortOrder: 2, name: 'Hilutungan Island marine sanctuary', description: null },
      { sortOrder: 3, name: 'Nalusuan Island marine sanctuary', description: null },
      {
        sortOrder: 4,
        name: 'Mactan Shrine, Punta Engaño',
        description: 'Heritage stop at the end, once the boat is back.',
      },
    ],
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
    stops: [
      { sortOrder: 1, name: 'Basilica Minore del Santo Niño', description: null },
      {
        sortOrder: 2,
        name: "Magellan's Cross",
        description: 'Next door to the Basilica; guests walk across, no second drop-off needed.',
      },
      { sortOrder: 3, name: 'Fort San Pedro', description: null },
      {
        sortOrder: 4,
        name: 'Taoist Temple, Beverly Hills',
        description: 'Uphill from the city; the road narrows near the top.',
      },
      {
        sortOrder: 5,
        name: 'Temple of Leah, Busay',
        description: 'Steep, narrow hill road; allow extra time for the climb.',
      },
    ],
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
    stops: [
      { sortOrder: 1, name: 'Baclayon Church, Baclayon', description: null },
      {
        sortOrder: 2,
        name: 'Tarsier sanctuary, Corella',
        description: 'Quiet voices and no flash photography.',
      },
      { sortOrder: 3, name: 'Loboc River cruise and lunch', description: null },
      { sortOrder: 4, name: 'Man-made forest, Bilar', description: null },
      {
        sortOrder: 5,
        name: 'Chocolate Hills complex, Carmen',
        description: 'Last stop before the drive back to Tagbilaran.',
      },
    ],
  },
];

// ---------------------------------------------------------------------------
// Packages
// ---------------------------------------------------------------------------

export interface SeedPackage {
  slug: string;
  title: string;
  days: number;
  oldPriceCentavos: number;
  newPriceCentavos: number;
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
    oldPriceCentavos: 1_250_000,
    newPriceCentavos: 980_000,
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
    oldPriceCentavos: 2_450_000,
    newPriceCentavos: 1_890_000,
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
    oldPriceCentavos: 1_680_000,
    newPriceCentavos: 1_340_000,
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
      // `{{paymentMethods}}` is substituted at render time from the live,
      // enabled-only `payment_methods` setting (see FaqSection.tsx). The
      // list is NOT written out here: a hand-written copy would go stale
      // the moment an admin disables a method, and the footer's payment
      // chips would then disagree with this answer.
      a: '{{paymentMethods}} You can also transfer manually to our QR code and upload the receipt for verification.',
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

  /*
   * The bookable date window. Owner decision 2026-10-13 — PROPOSED BY
   * DEVELOPER, NOT YET CONFIRMED WITH R&G, and recorded as such in
   * BUILD_SPEC §5. Settings rather than constants so the owner can tune all
   * three from the admin surface without a deploy.
   *
   * `minLeadDays: 1` means today is never bookable; `nextDayCutoffTime`
   * takes tomorrow off the table too once 18:00 Manila passes, which is the
   * half that needs R&G's confirmation most — it is the line between "we can
   * still crew a van for tomorrow" and "we cannot".
   */
  /**
   * EMPTY, and it stays empty until R&G send the real QR image and account
   * details (owner decision 2026-10-14, Q3). `isConfigured: false` keeps the
   * manual-transfer option off the checkout entirely, so nothing can be
   * offered to a guest that would send their money nowhere.
   *
   * Never invent an account name or number here — the same rule as the
   * permit numbers above.
   */
  payment_qr: {
    imagePath: null,
    accountName: null,
    accountNumber: null,
    instructions: null,
    isConfigured: false,
  },

  booking: {
    minLeadDays: 1,
    nextDayCutoffTime: '18:00',
    maxAdvanceDays: 180,
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

// ---------------------------------------------------------------------------
// The dispatcher's fleet (Week 5, Task 15)
// ---------------------------------------------------------------------------

/**
 * Vans, drivers, leaves and two unstaffed trips, so every §9 dashboard alert
 * has a REAL row behind it on a fresh clone.
 *
 * **APP DATABASE ONLY** (controller ruling, 2026-10-15). `seed()` applies
 * this under `context === 'app'` and skips it for `'test'`, because
 * `capacity.test.ts` asserts in its `beforeEach` that `vans` and `drivers`
 * hold exactly zero rows — those tests count the WHOLE fleet, so one seeded
 * van would change every number in the file and break the suite that guards
 * the booking path's capacity arithmetic.
 *
 * Dates are expressed as OFFSETS from today, not fixed calendar days: a
 * fixed `2026-11-20` stops being "within 14 days" the moment the month
 * turns, and a demo whose alerts are empty teaches the owner that the
 * dashboard does not work.
 *
 * **Franchise numbers are obviously fake** (`FR-SEED-…`). `CLAUDE.md`:
 * never invent an accreditation number. A plausible-looking one could end up
 * in a screenshot and be taken for R&G's real franchise.
 */
export interface SeedVan {
  plate: string;
  model: string;
  capacity: number;
  status: 'available' | 'parked' | 'for_repair';
  odometer: number | null;
  /** Days from today. Negative is in the past. */
  nextServiceInDays: number | null;
  orcrExpiryInDays: number | null;
  franchiseNo: string | null;
  franchiseExpiryInDays: number | null;
  repairNotes: string | null;
}

export const SEED_VANS: SeedVan[] = [
  {
    plate: 'SEED-001',
    model: 'Toyota HiAce Commuter',
    capacity: 10,
    status: 'available',
    odometer: 84_300,
    // Inside SERVICE_DUE_DAYS, so the "service due" card has a row.
    nextServiceInDays: 9,
    orcrExpiryInDays: 240,
    franchiseNo: 'FR-SEED-0001',
    franchiseExpiryInDays: 400,
    repairNotes: null,
  },
  {
    plate: 'SEED-002',
    model: 'Nissan Urvan Premium',
    capacity: 15,
    status: 'available',
    odometer: 142_900,
    nextServiceInDays: 120,
    orcrExpiryInDays: 310,
    franchiseNo: 'FR-SEED-0002',
    // Inside PAPERS_EXPIRING_DAYS, so the "papers expiring" card has a row.
    franchiseExpiryInDays: 22,
    repairNotes: null,
  },
  {
    plate: 'SEED-003',
    model: 'Toyota HiAce Super Grandia',
    capacity: 6,
    status: 'available',
    odometer: 51_200,
    nextServiceInDays: 200,
    orcrExpiryInDays: 500,
    franchiseNo: 'FR-SEED-0003',
    franchiseExpiryInDays: 500,
    repairNotes: null,
  },
  {
    plate: 'SEED-004',
    model: 'Nissan Urvan Shuttle',
    capacity: 15,
    status: 'for_repair',
    odometer: 201_450,
    // Already overdue — the alert must count it, which is the behaviour a
    // BETWEEN-based window would silently drop.
    nextServiceInDays: -6,
    orcrExpiryInDays: 180,
    franchiseNo: 'FR-SEED-0004',
    franchiseExpiryInDays: 365,
    repairNotes: 'Clutch slipping under load. With the shop since Monday.',
  },
];

export interface SeedDriver {
  name: string;
  code: string;
  phone: string;
  licenseNo: string;
  /** Days from today. */
  licenseExpiryInDays: number;
  languages: string[];
  emergencyContact: string;
  /** Optional leave, as day offsets, inclusive both ends. */
  leave?: { startInDays: number; endInDays: number; reason: string };
}

export const SEED_DRIVERS: SeedDriver[] = [
  {
    name: 'Mario Dela Cruz',
    code: 'D01',
    phone: '+639170000001',
    licenseNo: 'N01-SEED-0001',
    licenseExpiryInDays: 700,
    languages: ['Cebuano', 'Tagalog', 'English'],
    emergencyContact: 'Liza Dela Cruz · +639170000011',
  },
  {
    name: 'Jun Alcantara',
    code: 'D02',
    phone: '+639170000002',
    licenseNo: 'N01-SEED-0002',
    // Inside PAPERS_EXPIRING_DAYS: the licence half of that alert.
    licenseExpiryInDays: 18,
    languages: ['Cebuano', 'English'],
    emergencyContact: 'Rosa Alcantara · +639170000012',
  },
  {
    name: 'Ricky Monteverde',
    code: 'D03',
    phone: '+639170000003',
    licenseNo: 'N01-SEED-0003',
    licenseExpiryInDays: 540,
    languages: ['Cebuano', 'Tagalog'],
    emergencyContact: 'Ana Monteverde · +639170000013',
    // A weekend off, so the drivers screen has a leave range to render and
    // the dispatch dropdowns have someone to exclude.
    leave: { startInDays: 5, endInDays: 6, reason: 'Family event in Bohol' },
  },
  {
    name: 'Benjie Sarmiento',
    code: 'D04',
    phone: '+639170000004',
    licenseNo: 'N01-SEED-0004',
    licenseExpiryInDays: 900,
    languages: ['Cebuano', 'Tagalog', 'English', 'Korean'],
    emergencyContact: 'Mila Sarmiento · +639170000014',
  },
];

/**
 * Two confirmed trips inside the 48-hour window with nobody assigned, so the
 * "unassigned trips" alert and the calendar's gold dot both have something
 * true to show. Tomorrow and the day after — inside
 * `UNASSIGNED_ALERT_HOURS` either way.
 */
export const SEED_UNASSIGNED_TRIPS = [
  { tourSlug: 'kawasan-falls-canyoneering', inDays: 1, pax: 4, leadName: 'Demo Guest One' },
  { tourSlug: 'oslob-whale-shark-tumalog-falls', inDays: 2, pax: 2, leadName: 'Demo Guest Two' },
] as const;
