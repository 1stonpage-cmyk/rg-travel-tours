/**
 * Static site configuration.
 *
 * The Facebook URL is a REAL, client-confirmed value. The office address is
 * still pending (spec task 8D). The email keeps its env override until the
 * client confirms it.
 *
 * The phone/WhatsApp/Viber NUMBERS are deliberately NOT here (owner spec,
 * 2026-11-28, Task 1A — they used to be, and an admin editing them in
 * Settings had no effect on the live site, which is the bug this fixed).
 * They are admin-editable content now: `settings.contact.{phoneDisplay,
 * phoneTel, whatsapp, viber, altPhoneDisplay, altPhoneTel}`, read through
 * `trpc.settings.get`. `phoneWhatsappLink()`/`phoneViberLink()` below build
 * the deep links from whatever number a caller passes in — never from a
 * number of their own.
 *
 * BRAND vs LEGAL ENTITY — these are deliberately two different values:
 *   `name`          the public trading brand, shown everywhere on the site
 *   `legalOperator` the company that actually runs the tours and holds the
 *                   DOT / DTI / BIR registrations
 * Use `legalOperator` for anything regulatory or legal — the copyright notice,
 * the accreditation block, the "Operated by" credit. Everything customer-facing
 * uses `name`. Do not collapse them back into one value.
 *
 * Accreditation numbers themselves are no longer static here (owner decision
 * 2026-11-26, Task 1A) — they come from the admin-managed list in
 * `settings.permits`, already resolved server-side to only the items an
 * admin has switched to show with a real number. See SiteFooter.tsx.
 */

const env = import.meta.env;

export const SITE = {
  name: 'TravelSugbo',
  domain: 'TravelSugbo.com',
  /** The licensed operator. Permits and the copyright notice belong to this name. */
  legalOperator: 'R&G Travel & Tours',
  tagline: 'Private airport and island transfers across Cebu, booked direct.',
  nav: [
    // Transfers lead (Task T14, owner decision 8) — ahead of Tours, which
    // stays fully reachable, unchanged, right behind it. Tours is not
    // hidden; this is a deliberate demotion, not the T15 `show_tours` switch
    // (a separate, later task).
    { label: 'Transfers', href: '/transfer' },
    { label: 'Tours', href: '/tours' },
    { label: 'Packages', href: '/#packages' },
    { label: 'Reviews', href: '/#reviews' },
    { label: 'FAQ', href: '/#faq' },
    { label: 'Contact', href: '/#contact' },
  ],
  /** Short promise line, shown under the wordmark. */
  motto: 'Your journey, our priority',
  contact: {
    /**
     * Carrier labels only — not numbers, so they stay here (owner spec,
     * 2026-11-28, Task 1A: "keep non-number brand fields"). The actual
     * numbers these sit beside now come from `settings.contact` and can
     * change at any time from the admin Settings screen; if the primary or
     * second line's carrier ever changes along with its number, update the
     * label here too.
     */
    phone: { network: 'Smart' },
    altPhone: { network: 'Globe' },
    email: (env.VITE_CONTACT_EMAIL as string) ?? 'hello@travelsugbo.com',
    facebook: 'https://www.facebook.com/profile.php?id=61574390071362',
    address: 'Office address pending — Cebu, Philippines',
    /*
     * No `hours` here on purpose (BUG-100). The business hours live in
     * `settings.contact.hoursNote`, which the admin edits alongside the
     * `business_hours` setting the open/closed line is computed from. Both
     * the contact card (BUG-093) and the footer read that one value; a
     * static copy here could only ever contradict it.
     */
  },
  /**
   * Services beyond tours — one line next to the contact details, no extra
   * page. Split in three so the middle part can be the WhatsApp link while the
   * sentence stays a single source of truth; check-contact-parity.mjs joins
   * them and compares the result with the coming-soon page.
   */
  otherServices: {
    before: 'Need a van transfer, flights or a hotel?',
    link: 'Message us',
    after: '— R&G also handles airline booking, hotel reservations and spot transportation.',
  },
  /** Text chips, not trademarked logo artwork. Real logos arrive in task 8D. */
  paymentMethods: ['GCash', 'Maya', 'GrabPay', 'QR Ph', 'Visa', 'Mastercard'],
} as const;

/** The agency that built this site (owner decision 2026-11-11). Public footer only — never admin/driver/portal. */
export const BUILT_BY = {
  label: 'First On Page',
  url: 'https://firstonpage.com',
} as const;

/**
 * `SITE.nav`, minus "Tours" and "Packages" while `show_tours` is off
 * (transfers-launch plan Task T16; extended to Packages by owner decision
 * 2026-11-10, Decision 2 — packages now follow the same gate as tours,
 * server-side AND here), and minus "Reviews" whenever `hasRealReviews` is
 * false (owner decision 2026-11-13, Task 1A — no fake social proof: a nav
 * link to a reviews section that doesn't exist is not offered). One shared
 * filter rather than three independent `SITE.nav.map(...)` calls each
 * re-deriving the same rule — `SiteHeader.tsx` (desktop nav and mobile nav)
 * and `SiteFooter.tsx` (footer nav) all read this instead.
 */
export function visibleNav(showTours: boolean, hasRealReviews: boolean) {
  const hiddenWhileToursOff = new Set(['/tours', '/#packages']);
  return SITE.nav.filter((item) => {
    if (item.href === '/#reviews') return hasRealReviews;
    return !hiddenWhileToursOff.has(item.href) || showTours;
  });
}

/**
 * Transfers-wording tagline shown under the footer wordmark while
 * `show_tours` is off (owner decision 2026-11-11, 1C). Kept as its own
 * constant rather than folded away now that it is byte-for-byte identical to
 * `SITE.tagline` (task 6/3C) — `SITE.tagline` itself used to carry a
 * tour-only promise that didn't hold while tours were off; it has since been
 * generalised to transfers wording, so both branches of `siteTagline()`
 * below currently return the same string. That is not a bug: the day
 * `SITE.tagline` goes back to naming tours specifically, this constant is
 * what keeps the "off" branch correct without anyone having to remember why.
 */
const TRANSFERS_TAGLINE = 'Private airport and island transfers across Cebu, booked direct.';

/**
 * Same shape as `visibleNav(showTours)` above: an exported function taking
 * the boolean, rather than turning `SITE.tagline` itself into a function or
 * restructuring `SITE` — either of which would break every existing
 * reader's call-shape.
 */
export function siteTagline(showTours: boolean): string {
  return showTours ? SITE.tagline : TRANSFERS_TAGLINE;
}

/**
 * The footer's actual tagline (task 2B): `settings.contact.tagline` is a
 * short free-text admin field that already existed in the settings schema
 * and the admin Settings form, but nothing on the public site read it —
 * the footer called `siteTagline(showTours)` unconditionally instead. When
 * the admin has entered real text (non-whitespace) it wins; otherwise this
 * falls back to the existing `siteTagline(showTours)` behaviour exactly as
 * it works today. Pure and separate from `siteTagline()` itself, which is
 * left unchanged for any other caller.
 */
export function footerTagline(
  settingsTagline: string | null | undefined,
  showTours: boolean,
): string {
  const trimmed = settingsTagline?.trim();
  return trimmed ? trimmed : siteTagline(showTours);
}

/** `tel:` href for either line. */
export function telLink(tel: string) {
  return `tel:${tel}`;
}

/**
 * Builds a wa.me deep link for a given number with an optional prefilled
 * message. Every public surface's WhatsApp link goes through this, passing
 * `settings.contact.whatsapp` from `trpc.settings.get` — never a hardcoded
 * number of its own (owner spec, 2026-11-28, Task 1A). `e164` need not
 * actually carry a leading "+" (the stored `whatsapp` setting doesn't); any
 * one is stripped here since wa.me wants bare digits.
 */
export function phoneWhatsappLink(e164: string, message?: string): string {
  const digits = e164.replace(/^\+/, '');
  const base = `https://wa.me/${digits}`;
  return message ? `${base}?text=${encodeURIComponent(message)}` : base;
}

/**
 * Viber deep link for a given number. The number must carry a leading "+",
 * percent-encoded ("+" becomes %2B), or Viber reads it as a space and the
 * chat opens on an empty recipient — added here if missing, since the
 * fallback value (`settings.contact.viber`, resolved server-side to the
 * WhatsApp number when no Viber number of its own is set — owner spec,
 * 2026-11-28, Task 1A) carries no "+" of its own. Every public surface's
 * Viber link passes that settings value — never a hardcoded number.
 */
export function phoneViberLink(e164: string): string {
  const withPlus = e164 === '' || e164.startsWith('+') ? e164 : `+${e164}`;
  return `viber://chat?number=${encodeURIComponent(withPlus)}`;
}
