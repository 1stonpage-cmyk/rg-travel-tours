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

/**
 * How long a hold lasts once the guest has reached the gateway (owner
 * Ruling 4 / Q5): `created_at + 30 minutes`, replacing the 15 minutes
 * `createHold()` set.
 *
 * It lives HERE, beside `HOLD_MINUTES`, because hold duration now has three
 * consumers — `createHold()`, `checkout.startPayment`, and the expiry sweep
 * that acts on what they wrote — and two homes for one concept is how the
 * two homes come to disagree. Neither value changed when it moved.
 *
 * **Extended ONCE, and that is the whole subtlety.** A guest who has
 * reached the payment page has committed, and typing a card number slowly
 * should not land their money in `recordPayment()`'s review queue — that
 * queue is for genuine anomalies. But an extension that reapplied on every
 * `startPayment` call would be a renewable hold: reload the page, keep the
 * slot forever, and the capacity nobody is paying for is never released.
 *
 * So the extension is computed FROM `created_at` and the UPDATE only
 * matches a row whose `hold_expires_at` is still short of that target
 * (`extendHoldForPayment` in `server/src/routers/public/checkout.ts`). A
 * second call matches nothing, writes nothing and audits nothing. No new
 * column is needed to remember that it already happened, because
 * `created_at` already remembers.
 *
 * **It does not change what happens when the money lands late anyway.**
 * `recordPayment()` still records such a payment, still leaves the status
 * alone and still raises `payment_review_required`. This makes that path
 * rarer; it does not remove it.
 */
export const PAYMENT_HOLD_MINUTES = 30;

/** Business timezone for all date display and business-day calculations. */
export const TIMEZONE = 'Asia/Manila';

/** ISO currency code. Amounts are centavos of this currency. */
export const CURRENCY = 'PHP';

/** Prefix for public, non-sequential booking references, e.g. RG-7KQ4M9. */
export const BOOKING_REF_PREFIX = 'RG';

/**
 * The booking-status page, as a React Router path template (owner Ruling 25).
 *
 * ONE definition with TWO consumers that must agree character for character,
 * for the same reason `HERO_IMAGE_PRELOAD` below is shared: the route the
 * client mounts (plan Task 9) and the `success_url` / `cancel_url` the
 * gateway redirect is built from (`checkout.startPayment`, plan Task 7). If
 * they drift, a guest who has just paid lands on a 404 — and the only place
 * that shows up is production, because each half is individually correct.
 *
 * `bookingPagePath()` is the builder for a concrete ref; the cancel URL adds
 * `?cancelled=1` on top of it, which is a query string and not part of the
 * path.
 */
export const BOOKING_PAGE_ROUTE = '/booking/:ref';

/**
 * The booking-status page for one ref, e.g. `/booking/RG-7KQ4M9`.
 *
 * Derived from `BOOKING_PAGE_ROUTE` rather than retyping `/booking/` — one
 * literal in the codebase, not two that could quietly drift apart. See
 * `shared/src/__tests__/constants.test.ts`, which fails if this goes back
 * to a hand-typed template string.
 */
export function bookingPagePath(ref: string): string {
  return BOOKING_PAGE_ROUTE.replace(':ref', ref);
}

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
