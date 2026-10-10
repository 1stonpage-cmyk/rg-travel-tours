/**
 * Project-wide constants shared by client and server.
 *
 * Money is handled in integer CENTAVOS everywhere (DB, API, logic) and
 * formatted only at display time. Timestamps are stored in UTC; business
 * dates are computed and displayed in Asia/Manila.
 */

/** Deposit percentage offered at checkout. Overridable from `settings` later. */
export const DEPOSIT_PERCENT = 30;

/** Minutes a booking hold survives before the expiry cron releases capacity. */
export const HOLD_MINUTES = 15;

/** Business timezone for all date display and business-day calculations. */
export const TIMEZONE = 'Asia/Manila';

/** ISO currency code. Amounts are centavos of this currency. */
export const CURRENCY = 'PHP';

/** Prefix for public, non-sequential booking references, e.g. RG-7KQ4M9. */
export const BOOKING_REF_PREFIX = 'RG';

/**
 * The hero photo's WebP candidates — the mobile LCP element.
 *
 * ONE definition with TWO consumers, deliberately: the WebP `<source>` in
 * `client/src/components/home/HeroSection.tsx`, and the
 * `<link rel="preload" as="image">` the SEO injector emits for `/` alone
 * (`server/src/seo/resolvers.ts`, task 4.4b).
 *
 * Those two must agree character for character. If they drift, the browser
 * preloads one candidate list and the `<picture>` then fetches a different
 * one — two hero downloads instead of one earlier one, which is worse than
 * having no preload at all. Sharing the constant makes that drift impossible
 * rather than merely tested for.
 */
export const HERO_IMAGE_PRELOAD = {
  /** The `type` of every candidate below, so a browser without WebP skips the preload. */
  type: 'image/webp',
  /** `srcSet` on the `<source>`; `imagesrcset` on the preload link. */
  srcset: '/hero/hero-cebu-800.webp 800w, /hero/hero-cebu-1920.webp 1920w',
  /** `sizes` on the `<source>`; `imagesizes` on the preload link. */
  sizes: '100vw',
} as const;
