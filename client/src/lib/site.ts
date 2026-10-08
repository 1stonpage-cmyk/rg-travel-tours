/**
 * Static site configuration. Contact numbers, addresses, and permit numbers are
 * PLACEHOLDERS until the client supplies real values (spec task 8D). Permit
 * numbers must never be invented — they render as an explicit pending state.
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
  /** Short mark for the 36px header square and the browser-tab favicon. */
  shortMark: 'TS',
  domain: 'TravelSugbo.com',
  /** The licensed operator. Permits and the copyright notice belong to this name. */
  legalOperator: 'R&G Travel & Tours',
  tagline: 'Cebu day tours and multi-day packages, booked direct.',
  nav: [
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
     * `phone` is the primary line — WhatsApp, Viber and voice calls all land
     * on it. `altPhone` is a second network for calls and SMS only.
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
    },
    email: (env.VITE_CONTACT_EMAIL as string) ?? 'hello@travelsugbo.com',
    facebook: 'https://www.facebook.com/profile.php?id=61574390071362',
    address: 'Office address pending — Cebu, Philippines',
    hours: 'Mon–Sun, 7:00 AM – 9:00 PM (PHT)',
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
    after:
      '— R&G also handles airline booking, hotel reservations and spot transportation.',
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

/** Builds a wa.me deep link with an optional prefilled message. */
export function whatsappLink(message?: string) {
  const base = `https://wa.me/${SITE.contact.phone.whatsapp}`;
  return message ? `${base}?text=${encodeURIComponent(message)}` : base;
}

/**
 * Viber deep link. The number must be percent-encoded ("+" becomes %2B) or
 * Viber reads it as a space and the chat opens on an empty recipient.
 */
export function viberLink() {
  return `viber://chat?number=${encodeURIComponent(SITE.contact.phone.tel)}`;
}

/** `tel:` href for either line. */
export function telLink(tel: string) {
  return `tel:${tel}`;
}
