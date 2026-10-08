/**
 * Static site configuration. Contact numbers, addresses, and permit numbers are
 * PLACEHOLDERS until the client supplies real values (spec task 8D). Permit
 * numbers must never be invented — they render as an explicit pending state.
 */

const env = import.meta.env;

export const SITE = {
  name: 'R&G Travel & Tours',
  tagline: 'Cebu day tours and multi-day packages, booked direct.',
  nav: [
    { label: 'Tours', href: '/tours' },
    { label: 'Packages', href: '/#packages' },
    { label: 'Reviews', href: '/#reviews' },
    { label: 'FAQ', href: '/#faq' },
    { label: 'Contact', href: '/#contact' },
  ],
  contact: {
    phone: (env.VITE_CONTACT_PHONE as string) ?? '+63 900 000 0000',
    whatsapp: (env.VITE_WHATSAPP_NUMBER as string) ?? '639000000000',
    email: (env.VITE_CONTACT_EMAIL as string) ?? 'hello@randgtraveltours.com',
    facebook: (env.VITE_FACEBOOK_URL as string) ?? 'https://facebook.com/',
    address: 'Office address pending — Cebu, Philippines',
    hours: 'Mon–Sun, 7:00 AM – 9:00 PM (PHT)',
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
  const base = `https://wa.me/${SITE.contact.whatsapp}`;
  return message ? `${base}?text=${encodeURIComponent(message)}` : base;
}
