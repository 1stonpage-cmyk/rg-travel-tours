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
 * The hero photo's candidates — the mobile LCP element.
 *
 * ONE definition with TWO consumers, deliberately: the `<img>` in
 * `client/src/components/home/HeroSection.tsx`, and the
 * `<link rel="preload" as="image">` the SEO injector emits for `/` alone
 * (`server/src/seo/resolvers.ts`, task 4.4b).
 *
 * Those two must agree character for character. If they drift, the browser
 * preloads one candidate list and the `<img>` then fetches a different one —
 * two hero downloads instead of one earlier one, which is worse than having
 * no preload at all. Sharing the constant makes that drift impossible rather
 * than merely tested for.
 *
 * JPEG, not WebP (BUG-103). The hero was served through a `<picture>` whose
 * WebP `<source>` was LARGER than the JPEG it was meant to beat — 295,436 B
 * vs 289,855 B at 1920, and 73,388 B vs 71,774 B at 800 — so every browser
 * that advertised WebP support paid extra bytes for the privilege. Those two
 * `.webp` files are deleted and the `<picture>`/`<source>` pair is gone with
 * them; the `<img>` and its JPEG srcset are the whole story now.
 *
 * This is not "WebP is not worth it" — a properly encoded WebP would win
 * comfortably. It is that this repo has no image encoder (no sharp, no cwebp,
 * no ImageMagick, no ffmpeg) and adding one was out of scope. Revisit when
 * admin photo uploads are built and a real image pipeline exists; see the
 * deferred item in docs/BUGS_LOG.md.
 */
export const HERO_IMAGE_PRELOAD = {
  /** The `type` of every candidate below. */
  type: 'image/jpeg',
  /** `srcSet` on the `<img>`; `imagesrcset` on the preload link. */
  srcset: '/hero/hero-cebu-800.jpg 800w, /hero/hero-cebu-1920.jpg 1920w',
  /** `sizes` on the `<img>`; `imagesizes` on the preload link. */
  sizes: '100vw',
} as const;
