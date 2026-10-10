import { Clock, Facebook, Mail, MapPin, Phone } from 'lucide-react';
import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { ViberGlyph, WhatsAppGlyph } from '@/components/common/BrandGlyphs';
import { SITE, telLink, viberLink, whatsappLink } from '@/lib/site';
import { trpc } from '@/lib/trpc';
import { cn } from '@/lib/utils';

/**
 * The permit *labels* ("DOT Accreditation No.", ...) are static site chrome
 * — `settings.permits` (server/src/content/settings-schema.ts) only ever
 * carries the three values, never their captions. The values below come
 * from the live settings query instead of `SITE.permits.*.value`, which is
 * why only the labels are pulled from `SITE.permits` here.
 */
const PERMIT_LABELS = {
  dot: SITE.permits.dot.label,
  dti: SITE.permits.dti.label,
  bir: SITE.permits.bir.label,
};

const NO_PERMITS = { dot: null, dti: null, bir: null } as const;

/**
 * Icon-only WhatsApp/Viber buttons beside the primary phone number (spec
 * task 2.10A). Same shape as ContactSection's ChatIcon: the brand colour
 * lives only on this circle, behind the glyph, never behind visible text.
 * The caption below is the "visible wording outside the pill" the brand
 * rule requires — it is `aria-hidden` because the link's own `aria-label`
 * is already the accessible name; without that, a screen reader would
 * announce the button twice. 44px (`size-11`) meets the project's tap
 * target floor; `.press-brand` matches the other brand-colour pills' press
 * feedback (FloatingWhatsApp, ContactSection).
 */
function ChatButton({
  tone,
  href,
  label,
  external,
  children,
}: {
  tone: 'whatsapp' | 'viber';
  href: string;
  label: string;
  external?: boolean;
  children: ReactNode;
}) {
  return (
    <span className="inline-flex flex-col items-center gap-1">
      <a
        href={href}
        {...(external ? { target: '_blank', rel: 'noreferrer noopener' } : {})}
        aria-label={label}
        className={cn(
          'press-brand focus-visible:ring-brand-gold-400 flex size-11 shrink-0 items-center justify-center rounded-full text-white transition-[transform,box-shadow,background-color] duration-200 hover:-translate-y-0.5 hover:shadow-md focus-visible:outline-none focus-visible:ring-2',
          tone === 'whatsapp' ? 'bg-whatsapp hover:bg-whatsapp-pressed' : 'bg-viber',
        )}
      >
        {children}
      </a>
      <span aria-hidden="true" className="text-brand-blue-300 text-[10px] font-medium">
        {tone === 'whatsapp' ? 'WhatsApp' : 'Viber'}
      </span>
    </span>
  );
}

export default function SiteFooter() {
  /**
   * Permits (spec task 6G) and payment methods (6F) both come from
   * `settings.get` now, rather than the static `SITE.permits`/
   * `SITE.paymentMethods` arrays this used to render — `settings.paymentMethods`
   * is already enabled-only and sorted (`resolvePaymentMethods`,
   * server/src/content/settings.ts), so these chips and FaqSection's
   * payment-methods answer can never show a different set of methods; see
   * PAYMENT_METHODS_QUESTION in FaqSection.tsx. Defaults below cover only
   * the brief gap before the query resolves — not a real "no settings"
   * state, since `readSettings()` throws rather than omitting a key.
   */
  const { data: settings } = trpc.settings.get.useQuery();
  const permits = settings?.permits ?? NO_PERMITS;
  const paymentMethods = settings?.paymentMethods ?? [];
  const permitRows = [
    { label: PERMIT_LABELS.dot, value: permits.dot },
    { label: PERMIT_LABELS.dti, value: permits.dti },
    { label: PERMIT_LABELS.bir, value: permits.bir },
  ];

  return (
    <footer className="bg-brand-blue-950 text-brand-blue-100 mt-16">
      <div className="mx-auto grid max-w-7xl gap-10 px-4 py-12 sm:px-6 lg:grid-cols-4 lg:px-8">
        <div className="lg:col-span-2">
          <p className="text-brand-gold-300 text-lg font-bold">{SITE.name}</p>
          <p className="text-brand-blue-100 mt-1 text-base font-medium sm:text-sm">{SITE.motto}</p>
          <p className="text-brand-blue-200 mt-2 max-w-sm text-base sm:text-sm">{SITE.tagline}</p>

          <ul className="mt-6 space-y-2 text-base sm:text-sm">
            {/* Primary line: WhatsApp, Viber and voice calls all land here.
                The apps are named as text rather than as extra links so the
                footer keeps one unambiguous "call this number" target. */}
            <li className="flex items-start gap-2">
              <Phone className="mt-3.5 size-4 shrink-0" aria-hidden="true" />
              <div>
                <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                  <a
                    href={telLink(SITE.contact.phone.tel)}
                    className="flex min-h-11 items-center gap-2 hover:underline"
                  >
                    {SITE.contact.phone.display}
                    <span className="text-brand-blue-300 text-xs">
                      {SITE.contact.phone.network}
                    </span>
                  </a>
                  <span className="flex items-center gap-2">
                    <ChatButton
                      tone="whatsapp"
                      href={whatsappLink()}
                      label="Chat on WhatsApp"
                      external
                    >
                      <WhatsAppGlyph className="size-5" />
                    </ChatButton>
                    <ChatButton tone="viber" href={viberLink()} label="Chat on Viber">
                      <ViberGlyph className="size-5" />
                    </ChatButton>
                  </span>
                </div>
                <p className="text-brand-blue-300 mt-1 text-xs">WhatsApp, Viber and calls</p>
              </div>
            </li>
            <li className="flex items-start gap-2">
              <Phone className="mt-3.5 size-4 shrink-0" aria-hidden="true" />
              <div>
                <a
                  href={telLink(SITE.contact.altPhone.tel)}
                  className="flex min-h-11 items-center gap-2 hover:underline"
                >
                  {SITE.contact.altPhone.display}
                  <span className="text-brand-blue-300 text-xs">
                    {SITE.contact.altPhone.network}
                  </span>
                </a>
                <p className="text-brand-blue-300 -mt-2 text-xs">Calls and SMS</p>
              </div>
            </li>
            <li className="flex items-center gap-2">
              <Mail className="size-4 shrink-0" aria-hidden="true" />
              <a
                href={`mailto:${SITE.contact.email}`}
                className="flex min-h-11 items-center hover:underline"
              >
                {SITE.contact.email}
              </a>
            </li>
            <li className="flex items-start gap-2">
              <MapPin className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
              <span>{SITE.contact.address}</span>
            </li>
            <li className="flex items-center gap-2">
              <Clock className="size-4 shrink-0" aria-hidden="true" />
              <span>{SITE.contact.hours}</span>
            </li>
            <li className="flex items-center gap-2">
              <Facebook className="size-4 shrink-0" aria-hidden="true" />
              <a
                href={SITE.contact.facebook}
                target="_blank"
                rel="noreferrer noopener"
                className="flex min-h-11 items-center hover:underline"
              >
                Facebook
              </a>
            </li>
          </ul>
        </div>

        <nav aria-label="Footer">
          <p className="text-brand-gold-300 text-sm font-semibold uppercase tracking-wider">
            Explore
          </p>
          <ul className="mt-4 space-y-1 text-sm">
            {SITE.nav.map((item) => (
              <li key={item.href}>
                <Link to={item.href} className="flex min-h-11 items-center hover:underline">
                  {item.label}
                </Link>
              </li>
            ))}
          </ul>
        </nav>

        <div>
          <p className="text-brand-gold-300 text-sm font-semibold uppercase tracking-wider">
            Accreditation
          </p>
          {/* The permits below belong to the licensed operator, not to the
              TravelSugbo trading brand — so the credit sits directly above them. */}
          <p className="text-brand-blue-100 mt-3 text-sm font-medium">
            Operated by {SITE.legalOperator}
          </p>
          <dl className="mt-4 space-y-2 text-sm">
            {permitRows.map((permit) => (
              <div key={permit.label}>
                <dt className="text-brand-blue-300">{permit.label}</dt>
                <dd className="font-mono">
                  {permit.value ?? <span className="text-brand-gold-200">— pending —</span>}
                </dd>
              </div>
            ))}
          </dl>

          <p className="text-brand-gold-300 mt-6 text-sm font-semibold uppercase tracking-wider">
            We accept
          </p>
          <ul className="mt-3 flex flex-wrap gap-2">
            {paymentMethods.map((method) => (
              <li
                key={method.key}
                className="border-brand-blue-800 bg-brand-blue-900 text-brand-blue-100 rounded-md border px-2.5 py-1 text-xs font-semibold"
              >
                {method.label}
              </li>
            ))}
          </ul>
        </div>
      </div>

      <div className="border-brand-blue-900 border-t">
        <div className="text-brand-blue-300 mx-auto flex max-w-7xl flex-col gap-2 px-4 pb-20 pt-6 text-xs sm:flex-row sm:items-center sm:justify-between sm:px-6 sm:pb-24 lg:px-8">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-4">
            <p>
              {/* Legal entity, not the trading brand — see SITE.legalOperator. */}©{' '}
              {new Date().getFullYear()} {SITE.legalOperator}. All rights reserved.
            </p>
            {/* Task 3.6: legal pages, rendered from settings.legal via <Markdown/>. Plain
                text links beside the copyright — not a new contact target, so the
                contact-parity guard (scripts/check-contact-parity.mjs) has nothing new
                to track here. */}
            <nav aria-label="Legal" className="flex items-center gap-3">
              <Link to="/privacy" className="flex min-h-11 items-center hover:underline">
                Privacy Policy
              </Link>
              <Link to="/terms" className="flex min-h-11 items-center hover:underline">
                Terms of Service
              </Link>
            </nav>
          </div>
          <p>Payments processed securely by PayMongo. Card details never touch our servers.</p>
        </div>
      </div>
    </footer>
  );
}
