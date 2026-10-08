/**
 * ============================================================================
 * PLACEHOLDER DATA — NOT REAL BUSINESS DATA
 * ============================================================================
 * Every value here is invented scaffolding so the public home page can be built
 * and reviewed before real content exists (spec task 8D).
 *
 * Spec section 0 forbids faking social proof. Accordingly:
 *   - a dev-only banner marks the page as placeholder-backed
 *     (components/layout/PlaceholderBadge.tsx)
 *   - the per-tour ratingAverage/ratingCount/bookedTotal/bookedThisWeek values
 *     below ARE invented placeholders. That is acceptable only because the dev
 *     banner declares tour details to be placeholders, and because this whole
 *     module is deleted in one commit once tasks 2C/2D read from the API —
 *     these numbers must never reach a production build un-replaced.
 *   - the site-wide trust-line figures in PLACEHOLDER_SETTINGS
 *     (ratingAverage, guestsServed) are NOT invented — they are figures the
 *     client supplied directly. ratingCount is deliberately null because no
 *     client-supplied review count exists yet; inventing one would be
 *     fabricated social proof. See the comment on PLACEHOLDER_SETTINGS below.
 *   - permit numbers are NOT invented here; see lib/site.ts, where they render
 *     as an explicit pending state
 *
 * Delete this entire file once tasks 2C/2D read from the API.
 * Money is integer CENTAVOS, per the project-wide convention.
 * ============================================================================
 */

export const USING_PLACEHOLDER_DATA = true;

const img = (slug: string) => `/placeholders/${slug}.svg`;

export const PLACEHOLDER_SETTINGS: {
  ratingAverage: number;
  ratingCount: number | null;
  guestsServed: number;
  dotAccredited: boolean;
  promoCode: string;
  depositPercent: number;
} = {
  /** TODO: client to verify — supplied by the client, not invented. */
  ratingAverage: 4.9,
  /**
   * No client-supplied review count exists yet. Deliberately null: inventing a
   * count would be fabricated social proof (spec section 0). The UI omits any
   * count claim while this is null.
   * TODO: client to supply, then render alongside the average.
   */
  ratingCount: null,
  /** TODO: client to verify — supplied by the client, not invented. */
  guestsServed: 15000,
  /** TODO: client to verify — accreditation claim, permit number still pending in site.ts. */
  dotAccredited: true,
  promoCode: 'RGTOURS10',
  depositPercent: 30,
};

export const DESTINATIONS = [
  { id: 1, name: 'Oslob', slug: 'oslob' },
  { id: 2, name: 'Mactan', slug: 'mactan' },
  { id: 3, name: 'Badian / Kawasan', slug: 'badian-kawasan' },
  { id: 4, name: 'Moalboal', slug: 'moalboal' },
  { id: 5, name: 'Bohol', slug: 'bohol' },
  { id: 6, name: 'Cebu City', slug: 'cebu-city' },
];

export const TOURS = [
  {
    id: 1,
    slug: 'oslob-whale-shark-tumalog-falls',
    title: 'Oslob Whale Sharks + Tumalog Falls',
    destination: 'Oslob',
    image: img('oslob'),
    alt: 'Placeholder image for the Oslob whale shark and Tumalog Falls day tour',
    fromPriceCentavos: 189_000,
    durationHours: 14,
    ratingAverage: 4.9,
    ratingCount: 68,
    bookedTotal: 412,
    bookedThisWeek: 7,
    freeCancellation: true,
  },
  {
    id: 2,
    slug: 'kawasan-falls-canyoneering',
    title: 'Kawasan Falls Canyoneering',
    destination: 'Badian / Kawasan',
    image: img('badian-kawasan'),
    alt: 'Placeholder image for the Kawasan Falls canyoneering day tour',
    fromPriceCentavos: 215_000,
    durationHours: 13,
    ratingAverage: 4.8,
    ratingCount: 54,
    bookedTotal: 356,
    bookedThisWeek: 5,
    freeCancellation: true,
  },
  {
    id: 3,
    slug: 'moalboal-sardine-run-turtles',
    title: 'Moalboal Sardine Run & Sea Turtles',
    destination: 'Moalboal',
    image: img('moalboal'),
    alt: 'Placeholder image for the Moalboal sardine run and sea turtle snorkelling tour',
    fromPriceCentavos: 175_000,
    durationHours: 12,
    ratingAverage: 4.7,
    ratingCount: 41,
    bookedTotal: 288,
    // Deliberately 0 so the "booked X times this week" hide rule is exercised.
    bookedThisWeek: 0,
    freeCancellation: true,
  },
  {
    id: 4,
    slug: 'mactan-island-hopping',
    title: 'Mactan Island Hopping & Snorkelling',
    destination: 'Mactan',
    image: img('mactan'),
    alt: 'Placeholder image for the Mactan island hopping and snorkelling tour',
    fromPriceCentavos: 145_000,
    durationHours: 8,
    ratingAverage: 4.6,
    ratingCount: 37,
    bookedTotal: 231,
    bookedThisWeek: 4,
    freeCancellation: false,
  },
  {
    id: 5,
    slug: 'cebu-city-heritage-tour',
    title: 'Cebu City Heritage & Temple Tour',
    destination: 'Cebu City',
    image: img('cebu-city'),
    alt: 'Placeholder image for the Cebu City heritage and temple tour',
    fromPriceCentavos: 98_000,
    durationHours: 6,
    ratingAverage: 4.5,
    ratingCount: 29,
    bookedTotal: 174,
    bookedThisWeek: 3,
    freeCancellation: true,
  },
  {
    id: 6,
    slug: 'bohol-countryside-chocolate-hills',
    title: 'Bohol Countryside & Chocolate Hills',
    destination: 'Bohol',
    image: img('bohol'),
    alt: 'Placeholder image for the Bohol countryside and Chocolate Hills tour',
    fromPriceCentavos: 245_000,
    durationHours: 15,
    ratingAverage: 4.8,
    ratingCount: 33,
    bookedTotal: 142,
    bookedThisWeek: 2,
    freeCancellation: true,
  },
];

export const MOST_VISITED = [
  {
    name: 'Oslob',
    slug: 'oslob',
    image: img('oslob'),
    alt: 'Placeholder image for Oslob',
    blurb: 'Swim beside whale sharks at sunrise, then cool off under Tumalog Falls.',
  },
  {
    name: 'Kawasan Falls',
    slug: 'badian-kawasan',
    image: img('badian-kawasan'),
    alt: 'Placeholder image for Kawasan Falls in Badian',
    blurb: 'Three tiers of turquoise water and the island’s best canyoneering run.',
  },
  {
    name: 'Moalboal',
    slug: 'moalboal',
    image: img('moalboal'),
    alt: 'Placeholder image for Moalboal',
    blurb: 'Millions of sardines a few metres from the shoreline at Panagsama.',
  },
  {
    name: 'Mactan',
    slug: 'mactan',
    image: img('mactan'),
    alt: 'Placeholder image for Mactan',
    blurb: 'Island hopping, sandbars and reef snorkelling minutes from the airport.',
  },
  {
    name: 'Bohol',
    slug: 'bohol',
    image: img('bohol'),
    alt: 'Placeholder image for Bohol',
    blurb: 'Chocolate Hills, tarsiers and the Loboc River, all in one long day.',
  },
  {
    name: 'Cebu City',
    slug: 'cebu-city',
    image: img('cebu-city'),
    alt: 'Placeholder image for Cebu City',
    blurb: 'Magellan’s Cross, Taoist Temple and Tops Lookout with a local guide.',
  },
];

export const PACKAGES = [
  {
    id: 1,
    slug: 'cebu-highlights-3d2n',
    title: 'Cebu Highlights',
    days: 3,
    oldPriceCentavos: 1_250_000,
    newPriceCentavos: 980_000,
    description:
      'City heritage, Oslob whale sharks and Kawasan canyoneering with hotel transfers included.',
    image: img('package-cebu-highlights'),
    alt: 'Placeholder image for the 3-day Cebu Highlights package',
    highlights: ['Private van throughout', 'Licensed guide', '2 nights accommodation'],
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
    image: img('package-cebu-bohol'),
    alt: 'Placeholder image for the 5-day Cebu and Bohol Explorer package',
    highlights: ['Ferry transfers', 'Island hopping day', '4 nights accommodation'],
  },
  {
    id: 3,
    slug: 'south-cebu-escape-4d3n',
    title: 'South Cebu Escape',
    days: 4,
    oldPriceCentavos: 1_680_000,
    newPriceCentavos: 1_340_000,
    description: 'Moalboal sardines, Badian canyoneering and Osmeña Peak sunrise at a slower pace.',
    image: img('package-south-cebu'),
    alt: 'Placeholder image for the 4-day South Cebu Escape package',
    highlights: ['Sunrise trek', 'Snorkel gear included', '3 nights accommodation'],
  },
];

export const REVIEWS = [
  {
    id: 1,
    name: 'Placeholder Guest A',
    tour: 'Oslob Whale Sharks + Tumalog Falls',
    rating: 5,
    body: 'Placeholder review copy. Real guest reviews are published only after admin approval (spec task 7A).',
    dateLabel: 'Placeholder date',
    verified: true,
  },
  {
    id: 2,
    name: 'Placeholder Guest B',
    tour: 'Kawasan Falls Canyoneering',
    rating: 5,
    body: 'Placeholder review copy. This card demonstrates the verified-booking badge and star layout.',
    dateLabel: 'Placeholder date',
    verified: true,
  },
  {
    id: 3,
    name: 'Placeholder Guest C',
    tour: 'Moalboal Sardine Run',
    rating: 4,
    body: 'Placeholder review copy showing a four-star entry so the breakdown is not uniform.',
    dateLabel: 'Placeholder date',
    verified: false,
  },
  {
    id: 4,
    name: 'Placeholder Guest D',
    tour: 'Mactan Island Hopping',
    rating: 5,
    body: 'Placeholder review copy. Replace with published reviews from the reviews table.',
    dateLabel: 'Placeholder date',
    verified: true,
  },
  {
    id: 5,
    name: 'Placeholder Guest E',
    tour: 'Bohol Countryside',
    rating: 5,
    body: 'Placeholder review copy used to fill the grid on wide screens.',
    dateLabel: 'Placeholder date',
    verified: true,
  },
  {
    id: 6,
    name: 'Placeholder Guest F',
    tour: 'Cebu City Heritage Tour',
    rating: 4,
    body: 'Placeholder review copy. Sub-scores (guide, value, punctuality, safety) arrive in task 2D.',
    dateLabel: 'Placeholder date',
    verified: false,
  },
];

export const WHY_BOOK_DIRECT = [
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
];

export const HOW_IT_WORKS = [
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
];

export const FAQS = [
  {
    q: 'How much deposit do I need to pay?',
    a: `A ${PLACEHOLDER_SETTINGS.depositPercent}% deposit reserves your date. The balance is collected on tour day. You can also pay in full online.`,
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
];

const pesoFormatter = new Intl.NumberFormat('en-PH', {
  style: 'currency',
  currency: 'PHP',
  minimumFractionDigits: 0,
  maximumFractionDigits: 0,
});

/** Formats integer centavos as whole pesos, e.g. 150000 -> "₱1,500". */
export function formatPeso(centavos: number) {
  return pesoFormatter.format(Math.round(centavos / 100)).replace(/ /g, '');
}
