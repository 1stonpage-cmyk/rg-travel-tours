/**
 * Shared test fixtures, shaped exactly like real tRPC output — not from the
 * plan's prose, but from calling the live, seeded server directly
 * (`pnpm --filter @rg/server dev`, then curling `/trpc/<procedure>`) and
 * copying what came back. Values are drawn from today's seed content
 * (`server/src/db/seed-data.ts`), loaded by `pnpm db:seed` into the
 * `rg_travel` database — with ONE documented exception: `SETTINGS_FIXTURE.legal`
 * is an abridged excerpt of the two seeded legal documents, not their full
 * text. See the comment on that field; nothing else here is abridged.
 *
 * Types come straight from the routers' exported result interfaces
 * (type-only imports, erased at build — no runtime dependency on server
 * code, and `@trpc/server` itself is deliberately not a client dependency)
 * rather than being hand-written here, so a server-side shape change shows
 * up as a type error in this file instead of a silently-stale fixture.
 *
 * Two things the real API output makes non-obvious, call out explicitly:
 *
 * - Every tour in the current seed returns `rating: null` — a rating only
 *   shows once a tour has 3+ published reviews
 *   (`settings.trust.minReviewsForRating`), and the seed has exactly one
 *   per tour. TOURS_FIXTURE mirrors that reality for most entries, but
 *   `oslob-whale-shark-tumalog-falls` carries a populated `rating` so
 *   star-rendering has something real to assert against.
 * - `bookedThisWeek`/`tripsRun` are `0`/`null` for every tour today (no
 *   bookings table yet). TOURS_FIXTURE keeps that for most entries, but
 *   the same Oslob tour also carries real `bookedThisWeek`/`tripsRun`
 *   values so both the hidden and shown states are covered.
 * - There is no superjson transformer on the server (`server/src/trpc.ts`
 *   is `initTRPC.create()` with no options), so `Date` fields serialize to
 *   ISO strings on the wire. Using real `Date` objects here still produces
 *   the correct wire bytes, because `mockTrpc`'s `JSON.stringify` converts
 *   them the same way the real HTTP response does.
 *
 * A related trap for whoever next imports one of the routers' exported
 * result interfaces (`PackageListItem`, `Review`, etc.) to type a CLIENT
 * value rather than this fixture file: that interface describes what the
 * *server* produces, not what the client actually receives after a JSON
 * round trip with no transformer. Two concrete consequences, both found the
 * hard way while building Task 2.5:
 *   - A `Date`-typed field (`Review.createdAt`/`repliedAt`) arrives on the
 *     client as a plain ISO **string**, not a `Date` instance.
 *   - A field typed `unknown` (`PackageListItem.highlights`) becomes
 *     **optional** on the client — `JSON.stringify` drops a key whose value
 *     is `undefined`, and `unknown` admits `undefined`, so tRPC's
 *     client-side output type reflects that possibility with `?:`.
 * `tsc` will reject a component prop typed directly as one of these server
 * interfaces for exactly this reason. `PackagesSection.tsx`/
 * `ReviewsSection.tsx` work around it by never naming the server interface
 * client-side at all — the data stays structurally inferred from the
 * `useQuery()` call all the way through. This fixture file is the
 * exception that's fine: these are plain object literals checked against
 * the server's own types, not something flowing through tRPC's client
 * output-typing machinery, so the server-shape interfaces apply here
 * exactly as declared.
 */
import type { SettingsPayload } from '../../../../server/src/content/settings';
import type { Destination } from '../../../../server/src/routers/public/destinations';
import type { PackageListItem } from '../../../../server/src/routers/public/packages';
import type { ReviewsPublishedResult } from '../../../../server/src/routers/public/reviews';
import type { TourListItem } from '../../../../server/src/routers/public/tours';

const img = (slug: string) => `/placeholders/${slug}.svg`;

export const SETTINGS_FIXTURE: SettingsPayload = {
  contentUnverified: true,
  siteSeo: {
    title: 'TravelSugbo — Cebu Day Tours & Packages',
    description:
      'Book Cebu day tours and multi-day packages direct with TravelSugbo. Private vans, licensed drivers, pay a 30% deposit online.',
    ogImage: null,
  },
  trust: {
    ratingAverage: 4.9,
    ratingCount: null,
    guestsServed: 15000,
    dotAccredited: true,
    depositPercent: 30,
    minReviewsForRating: 3,
  },
  hero: {
    eyebrow: 'Cebu, Philippines',
    headline: 'Private Cebu day tours, booked direct with the people who run them.',
    subtitle:
      'Whale sharks, canyoneering and island hopping in your own van with a licensed driver. Reserve with a 30% deposit.',
    ctaLabel: 'Search tours',
    imagePath: '/hero/hero-cebu-1920.jpg',
    imageAlt:
      'The stone gateway of Fort San Pedro in Cebu City, framed by palm trees under a clear blue sky.',
  },
  announcement: null,
  promo: {
    code: 'RGTOURS10',
    discountLabel: '10% off',
    headline: 'Get 10% off your first tour',
    body: 'Join the list for Cebu trip tips and seasonal offers. We send a few emails a year and never share your address.',
  },
  openState: { isOpen: false, message: "Closed — we'll reply by 7:00 AM" },
  paymentMethods: [
    { key: 'gcash', label: 'GCash' },
    { key: 'maya', label: 'Maya' },
    { key: 'grabpay', label: 'GrabPay' },
    { key: 'qr_ph', label: 'QR Ph' },
    { key: 'visa', label: 'Visa' },
    { key: 'mastercard', label: 'Mastercard' },
  ],
  permits: { dot: null, dti: null, bir: null },
  howItWorks: [
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
  whyBookDirect: [
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
  faqs: [
    {
      q: 'How much deposit do I need to pay?',
      a: 'A 30% deposit reserves your date. The balance is collected on tour day. You can also pay in full online.',
    },
    {
      q: 'Which payment methods do you accept?',
      // Seeded verbatim — the `{{paymentMethods}}` token is substituted at
      // render time from `settings.paymentMethods` (see FaqSection.tsx).
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
      a: "Your confirmation includes your driver's mobile number and the office hotline. The WhatsApp button on this site reaches us any time.",
    },
  ],
  contact: {
    address: 'Office address pending — Cebu, Philippines',
    tagline: 'Cebu day tours and multi-day packages, booked direct.',
    hoursNote: 'Mon–Sun, 7:00 AM – 9:00 PM (PHT)',
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
   * ABRIDGED, unlike every other block in this file. The seeded legal
   * documents run to ~25 lines of prose each (`legal_privacy`/`legal_terms`
   * in server/src/db/seed-data.ts); copying them in full would create a
   * second copy of the client's legal text, stale the day either is edited.
   * What is kept is what the page tests assert on — the TODO blockquote,
   * the title heading, and the seed's own opening paragraph reproduced with
   * the seed's HARD WRAPPING intact, so the renderer's join-wrapped-lines-
   * into-one-paragraph path is exercised through the real page here and not
   * only in markdown.test.tsx.
   */
  legal: {
    privacy: {
      markdown:
        '> **TODO: client legal review.** This text is a placeholder and is not legal advice.\n\n# Privacy Notice\n\nTravelSugbo (operated by R&G Travel & Tours) collects the contact and booking\ndetails you provide when you reserve a tour, so we can confirm your trip and\nassign a driver.',
      updatedAt: '2026-10-09T00:00:00.000Z',
    },
    terms: {
      markdown:
        '> **TODO: client legal review.** This text is a placeholder and is not legal advice.\n\n# Terms of Service\n\nThese placeholder terms cover booking, payment and cancellation at a high\nlevel while the client’s reviewed terms are pending.',
      updatedAt: '2026-10-09T00:00:00.000Z',
    },
  },
};

export const DESTINATIONS_FIXTURE: Destination[] = [
  {
    id: 6,
    name: 'Oslob',
    slug: 'oslob',
    displayName: null,
    blurb: 'Swim beside whale sharks at sunrise, then cool off under Tumalog Falls.',
    image: { path: img('oslob'), alt: 'Placeholder image for Oslob' },
    sortOrder: 0,
    featuredSortOrder: 0,
    isFeatured: true,
  },
  {
    id: 7,
    name: 'Mactan',
    slug: 'mactan',
    displayName: null,
    blurb: 'Island hopping, sandbars and reef snorkelling minutes from the airport.',
    image: { path: img('mactan'), alt: 'Placeholder image for Mactan' },
    sortOrder: 1,
    featuredSortOrder: 3,
    isFeatured: true,
  },
  {
    id: 8,
    name: 'Badian / Kawasan',
    slug: 'badian-kawasan',
    displayName: 'Kawasan Falls',
    blurb: 'Three tiers of turquoise water and the island’s best canyoneering run.',
    image: { path: img('badian-kawasan'), alt: 'Placeholder image for Kawasan Falls in Badian' },
    sortOrder: 2,
    featuredSortOrder: 1,
    isFeatured: true,
  },
  {
    id: 9,
    name: 'Moalboal',
    slug: 'moalboal',
    displayName: null,
    blurb: 'Millions of sardines a few metres from the shoreline at Panagsama.',
    image: { path: img('moalboal'), alt: 'Placeholder image for Moalboal' },
    sortOrder: 3,
    featuredSortOrder: 2,
    isFeatured: true,
  },
  {
    id: 10,
    name: 'Bohol',
    slug: 'bohol',
    displayName: null,
    blurb: 'Chocolate Hills, tarsiers and the Loboc River, all in one long day.',
    image: { path: img('bohol'), alt: 'Placeholder image for Bohol' },
    sortOrder: 4,
    featuredSortOrder: 4,
    isFeatured: true,
  },
  {
    id: 11,
    name: 'Cebu City',
    slug: 'cebu-city',
    displayName: null,
    blurb: 'Magellan’s Cross, Taoist Temple and Tops Lookout with a local guide.',
    image: { path: img('cebu-city'), alt: 'Placeholder image for Cebu City' },
    sortOrder: 5,
    featuredSortOrder: 5,
    isFeatured: true,
  },
];

export const TOURS_FIXTURE: TourListItem[] = [
  {
    id: 6,
    slug: 'oslob-whale-shark-tumalog-falls',
    title: 'Oslob Whale Sharks + Tumalog Falls',
    destination: { id: 6, name: 'Oslob', slug: 'oslob' },
    image: {
      path: img('oslob'),
      alt: 'Placeholder image for the Oslob whale shark and Tumalog Falls day tour',
      width: 1200,
      height: 800,
    },
    fromPriceCentavos: 189_000,
    durationHours: 14,
    // Populated on purpose — most tours below are null, matching today's
    // seed reality (<3 published reviews). This one has real values so the
    // star-rendering path has something to assert against.
    rating: { average: 4.9, count: 68 },
    bookedThisWeek: 7,
    tripsRun: 412,
    freeCancellation: true,
    badge: 'none',
    alertNote: null,
    isFeatured: true,
  },
  {
    id: 7,
    slug: 'kawasan-falls-canyoneering',
    title: 'Kawasan Falls Canyoneering',
    destination: { id: 8, name: 'Badian / Kawasan', slug: 'badian-kawasan' },
    image: {
      path: img('badian-kawasan'),
      alt: 'Placeholder image for the Kawasan Falls canyoneering day tour',
      width: 1200,
      height: 800,
    },
    fromPriceCentavos: 215_000,
    durationHours: 13,
    rating: null,
    bookedThisWeek: 0,
    tripsRun: null,
    freeCancellation: true,
    badge: 'none',
    alertNote: null,
    isFeatured: true,
  },
  {
    id: 8,
    slug: 'moalboal-sardine-run-turtles',
    title: 'Moalboal Sardine Run & Sea Turtles',
    destination: { id: 9, name: 'Moalboal', slug: 'moalboal' },
    image: {
      path: img('moalboal'),
      alt: 'Placeholder image for the Moalboal sardine run and sea turtle snorkelling tour',
      width: 1200,
      height: 800,
    },
    fromPriceCentavos: 175_000,
    durationHours: 12,
    rating: null,
    // Deliberately 0/null — exercises the "booked X times this week" hide rule.
    bookedThisWeek: 0,
    tripsRun: null,
    freeCancellation: true,
    badge: 'none',
    alertNote: null,
    isFeatured: true,
  },
  {
    id: 9,
    slug: 'mactan-island-hopping',
    title: 'Mactan Island Hopping & Snorkelling',
    destination: { id: 7, name: 'Mactan', slug: 'mactan' },
    image: {
      path: img('mactan'),
      alt: 'Placeholder image for the Mactan island hopping and snorkelling tour',
      width: 1200,
      height: 800,
    },
    fromPriceCentavos: 145_000,
    durationHours: 8,
    rating: null,
    bookedThisWeek: 0,
    tripsRun: null,
    freeCancellation: false,
    badge: 'none',
    alertNote: null,
    isFeatured: true,
  },
  {
    id: 10,
    slug: 'cebu-city-heritage-tour',
    title: 'Cebu City Heritage & Temple Tour',
    destination: { id: 11, name: 'Cebu City', slug: 'cebu-city' },
    image: {
      path: img('cebu-city'),
      alt: 'Placeholder image for the Cebu City heritage and temple tour',
      width: 1200,
      height: 800,
    },
    fromPriceCentavos: 98_000,
    durationHours: 6,
    rating: null,
    bookedThisWeek: 0,
    tripsRun: null,
    freeCancellation: true,
    badge: 'none',
    alertNote: null,
    isFeatured: true,
  },
  {
    id: 11,
    slug: 'bohol-countryside-chocolate-hills',
    title: 'Bohol Countryside & Chocolate Hills',
    destination: { id: 10, name: 'Bohol', slug: 'bohol' },
    image: {
      path: img('bohol'),
      alt: 'Placeholder image for the Bohol countryside and Chocolate Hills tour',
      width: 1200,
      height: 800,
    },
    fromPriceCentavos: 245_000,
    durationHours: 15,
    rating: null,
    bookedThisWeek: 0,
    tripsRun: null,
    freeCancellation: true,
    badge: 'none',
    alertNote: null,
    isFeatured: true,
  },
];

export const PACKAGES_FIXTURE: PackageListItem[] = [
  {
    id: 1,
    slug: 'cebu-highlights-3d2n',
    title: 'Cebu Highlights',
    days: 3,
    oldPriceCentavos: 1_250_000,
    newPriceCentavos: 980_000,
    description:
      'City heritage, Oslob whale sharks and Kawasan canyoneering with hotel transfers included.',
    image: {
      path: img('package-cebu-highlights'),
      alt: 'Placeholder image for the 3-day Cebu Highlights package',
    },
    highlights: ['Private van throughout', 'Licensed guide', '2 nights accommodation'],
    seoTitle: null,
    seoDescription: null,
    ogImage: null,
  },
  {
    id: 2,
    slug: 'cebu-bohol-5d4n',
    title: 'Cebu & Bohol Explorer',
    days: 5,
    oldPriceCentavos: 2_450_000,
    newPriceCentavos: 1_890_000,
    description:
      'South Cebu plus a Bohol countryside crossing — Chocolate Hills, tarsiers and the Loboc River.',
    image: {
      path: img('package-cebu-bohol'),
      alt: 'Placeholder image for the 5-day Cebu and Bohol Explorer package',
    },
    highlights: ['Ferry transfers', 'Island hopping day', '4 nights accommodation'],
    seoTitle: null,
    seoDescription: null,
    ogImage: null,
  },
  {
    id: 3,
    slug: 'south-cebu-escape-4d3n',
    title: 'South Cebu Escape',
    days: 4,
    oldPriceCentavos: 1_680_000,
    newPriceCentavos: 1_340_000,
    description: 'Moalboal sardines, Badian canyoneering and Osmeña Peak sunrise at a slower pace.',
    image: {
      path: img('package-south-cebu'),
      alt: 'Placeholder image for the 4-day South Cebu Escape package',
    },
    highlights: ['Sunrise trek', 'Snorkel gear included', '3 nights accommodation'],
    seoTitle: null,
    seoDescription: null,
    ogImage: null,
  },
];

export const REVIEWS_FIXTURE: ReviewsPublishedResult = {
  items: [
    {
      id: 1,
      tourId: 6,
      tourTitle: 'Oslob Whale Sharks + Tumalog Falls',
      name: 'Placeholder Guest A',
      rating: 5,
      guide: null,
      value: null,
      punctuality: null,
      safety: null,
      body: 'Placeholder review copy. Real guest reviews are published only after admin approval (spec task 7A).',
      isSample: true,
      reply: null,
      repliedAt: null,
      createdAt: new Date('2026-10-09T12:41:15.000Z'),
    },
    {
      id: 2,
      tourId: 7,
      tourTitle: 'Kawasan Falls Canyoneering',
      name: 'Placeholder Guest B',
      rating: 5,
      guide: null,
      value: null,
      punctuality: null,
      safety: null,
      // Round 1 fix on Task 2.5: this used to say "demonstrates the
      // verified-booking badge" — that badge was removed because zero
      // seeded reviews have a bookingId, so it was fabricated social proof.
      body: 'Placeholder review copy. This card demonstrates the star layout.',
      isSample: true,
      reply: null,
      repliedAt: null,
      createdAt: new Date('2026-10-09T12:41:15.000Z'),
    },
    {
      id: 3,
      tourId: 8,
      tourTitle: 'Moalboal Sardine Run & Sea Turtles',
      name: 'Placeholder Guest C',
      rating: 4,
      guide: null,
      value: null,
      punctuality: null,
      safety: null,
      body: 'Placeholder review copy showing a four-star entry so the breakdown is not uniform.',
      isSample: true,
      reply: null,
      repliedAt: null,
      createdAt: new Date('2026-10-09T12:41:15.000Z'),
    },
    {
      id: 4,
      tourId: 9,
      tourTitle: 'Mactan Island Hopping & Snorkelling',
      name: 'Placeholder Guest D',
      rating: 5,
      guide: null,
      value: null,
      punctuality: null,
      safety: null,
      body: 'Placeholder review copy. Replace with published reviews from the reviews table.',
      isSample: true,
      reply: null,
      repliedAt: null,
      createdAt: new Date('2026-10-09T12:41:15.000Z'),
    },
    {
      id: 5,
      tourId: 11,
      tourTitle: 'Bohol Countryside & Chocolate Hills',
      name: 'Placeholder Guest E',
      rating: 5,
      guide: null,
      value: null,
      punctuality: null,
      safety: null,
      body: 'Placeholder review copy used to fill the grid on wide screens.',
      isSample: true,
      reply: null,
      repliedAt: null,
      createdAt: new Date('2026-10-09T12:41:15.000Z'),
    },
    {
      id: 6,
      tourId: 10,
      tourTitle: 'Cebu City Heritage & Temple Tour',
      name: 'Placeholder Guest F',
      rating: 4,
      guide: null,
      value: null,
      punctuality: null,
      safety: null,
      body: 'Placeholder review copy. Sub-scores (guide, value, punctuality, safety) arrive in task 2D.',
      isSample: true,
      reply: null,
      repliedAt: null,
      createdAt: new Date('2026-10-09T12:41:15.000Z'),
    },
  ],
  displayAggregate: { average: 4.666666666666667, count: 6 },
  realAggregate: null,
};
