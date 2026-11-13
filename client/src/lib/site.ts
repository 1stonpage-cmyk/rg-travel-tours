/**
 * Static site configuration.
 *
 * The phone numbers and the Facebook URL are REAL, client-confirmed values.
 * The office address and permit numbers are still pending (spec task 8D);
 * permit numbers must never be invented — they render as an explicit pending
 * state. The email keeps its env override until the client confirms it.
 *
 * BRAND vs LEGAL ENTITY — these are deliberately two different values:
 *   `name`          the public trading brand, shown everywhere on the site
 *   `legalOperator` the company that actually runs the tours and holds the
 *                   DOT / DTI / BIR registrations
 * Use `legalOperator` for anything regulatory or legal — the copyright notice,
 * the accreditation block, the "Operated by" credit. Everything customer-facing
 * uses `name`. Do not collapse them back into one value.
 */

const env = import.meta.env;

export const SITE = {
  name: 'TravelSugbo',
  domain: 'TravelSugbo.com',
  /** The licensed operator. Permits and the copyright notice belong to this name. */
  legalOperator: 'R&G Travel & Tours',
  tagline: 'Cebu day tours and multi-day packages, booked direct.',
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
     * Real client-confirmed numbers. These are NOT env-driven: the standalone
     * coming-soon page (coming-soon/index.html) is plain static HTML that
     * cannot read Vite env, and the two surfaces must never drift apart.
     * scripts/check-contact-parity.mjs fails the build if they do.
     *
     * `altPhone` is the WhatsApp/Viber line as well as calls and SMS
     * (owner decision 2026-11-11, 1B — moved off `phone`). `phone` is now
     * calls only.
     */
    phone: {
      display: '0908 469 6246',
      network: 'Smart',
      tel: '+639084696246',
      /** wa.me wants the international number with no "+" or spaces. */
      whatsapp: '639084696246',
    },
    altPhone: {
      display: '0927 737 8431',
      network: 'Globe',
      tel: '+639277378431',
      /** wa.me wants the international number with no "+" or spaces. */
      whatsapp: '639277378431',
    },
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
  /**
   * Accreditation and registration numbers. Rendered as "pending" rather than
   * fabricated; real numbers arrive from Settings (spec section 9).
   */
  permits: {
    dot: { label: 'DOT Accreditation No.', value: null as string | null },
    dti: { label: 'DTI Registration No.', value: null as string | null },
    bir: { label: 'BIR TIN', value: null as string | null },
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
 * `show_tours` is off (owner decision 2026-11-11, 1C). `SITE.tagline`'s own
 * tour-wording promise only makes sense while tours are for sale.
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

/** Builds a wa.me deep link with an optional prefilled message. */
export function whatsappLink(message?: string) {
  const base = `https://wa.me/${SITE.contact.altPhone.whatsapp}`;
  return message ? `${base}?text=${encodeURIComponent(message)}` : base;
}

/**
 * Viber deep link. The number must be percent-encoded ("+" becomes %2B) or
 * Viber reads it as a space and the chat opens on an empty recipient.
 */
export function viberLink() {
  return `viber://chat?number=${encodeURIComponent(SITE.contact.altPhone.tel)}`;
}

/** `tel:` href for either line. */
export function telLink(tel: string) {
  return `tel:${tel}`;
}
