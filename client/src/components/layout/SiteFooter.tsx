import { Clock, Facebook, Mail, MapPin, Phone } from 'lucide-react';
import { Link } from 'react-router-dom';
import { SITE } from '@/lib/site';

const PERMITS = [SITE.permits.dot, SITE.permits.dti, SITE.permits.bir];

export default function SiteFooter() {
  return (
    <footer className="bg-brand-blue-950 text-brand-blue-100 mt-16">
      <div className="mx-auto grid max-w-7xl gap-10 px-4 py-12 sm:px-6 lg:grid-cols-4 lg:px-8">
        <div className="lg:col-span-2">
          <p className="text-brand-gold-300 text-lg font-bold">{SITE.name}</p>
          <p className="text-brand-blue-200 mt-2 max-w-sm text-sm">{SITE.tagline}</p>

          <ul className="mt-6 space-y-2 text-sm">
            <li className="flex items-center gap-2">
              <Phone className="size-4 shrink-0" aria-hidden="true" />
              <a
                href={`tel:${SITE.contact.phone.replace(/\s/g, '')}`}
                className="flex min-h-11 items-center hover:underline"
              >
                {SITE.contact.phone}
              </a>
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
          <dl className="mt-4 space-y-2 text-sm">
            {PERMITS.map((permit) => (
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
            {SITE.paymentMethods.map((method) => (
              <li
                key={method}
                className="border-brand-blue-800 bg-brand-blue-900 text-brand-blue-100 rounded-md border px-2.5 py-1 text-xs font-semibold"
              >
                {method}
              </li>
            ))}
          </ul>
        </div>
      </div>

      <div className="border-brand-blue-900 border-t">
        <div className="text-brand-blue-300 mx-auto flex max-w-7xl flex-col gap-2 px-4 pt-6 pb-20 text-xs sm:flex-row sm:items-center sm:justify-between sm:px-6 sm:pb-24 lg:px-8">
          <p>
            © {new Date().getFullYear()} {SITE.name}. All rights reserved.
          </p>
          <p>Payments processed securely by PayMongo. Card details never touch our servers.</p>
        </div>
      </div>
    </footer>
  );
}
