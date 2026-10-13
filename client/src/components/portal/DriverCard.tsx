/**
 * The assigned driver's card (BUILD_SPEC §7, Week 4 Task 9).
 *
 * Name, van model, plate, and two ways to reach them. It renders only when
 * the server sent a driver — and the SERVER decides whether it may
 * (`isDriverVisible`, §7's "visible from assignment until tour day ends"),
 * so there is no visibility logic in this file. A card that hid a number
 * the browser had already received would not be withholding anything.
 *
 * ## The WhatsApp pill follows the documented brand exception
 *
 * CLAUDE.md allows `#25D366` as a third-party chat colour and sets three
 * conditions, all of which this follows: the pill is **icon-only** with an
 * `aria-label` (white-on-`#25D366` measures 1.98:1 and fails AA at any
 * size, so the glyph is exempt as a logotype but text would not be), the
 * visible wording sits **outside** the pill in brand ink, and red stays
 * forbidden everywhere else.
 *
 * The call button is a plain brand-blue button, because a phone number is
 * not a third-party brand.
 *
 * ## `tel:` and `wa.me` get the number as stored
 *
 * The driver's number is Philippine-local (`09170001234`). `tel:` accepts
 * that as-is; `wa.me` needs the international form with no `+` or spaces,
 * which is what `waNumber()` in `lib/phone.ts` builds — the same rule
 * `lib/site.ts` documents for the business numbers.
 */
import { Phone } from 'lucide-react';
import { WhatsAppGlyph } from '@/components/common/BrandGlyphs';
import { waNumber } from '@/lib/phone';

type Props = {
  driver: {
    name: string;
    phone: string;
    vanModel: string | null;
    vanPlate: string | null;
  };
};

export default function DriverCard({ driver }: Props) {
  const van = [driver.vanModel, driver.vanPlate].filter(Boolean).join(' · ');

  return (
    <section
      aria-labelledby="driver-heading"
      className="border-brand-blue-200 bg-background rounded-2xl border p-5"
    >
      <h2 id="driver-heading" className="text-brand-blue-900 text-base font-semibold">
        Your driver
      </h2>
      <p className="text-brand-blue-900 mt-2 text-lg font-semibold">{driver.name}</p>
      {van ? <p className="text-muted-foreground text-sm">{van}</p> : null}

      <div className="mt-4 flex items-center gap-6">
        <a
          href={`tel:${driver.phone}`}
          className="bg-brand-blue-700 hover:bg-brand-blue-900 focus-visible:ring-brand-gold-400 tap-target inline-flex items-center gap-2 rounded-full px-4 text-sm font-semibold text-white transition-colors focus-visible:outline-none focus-visible:ring-2"
        >
          <Phone className="size-4" aria-hidden="true" />
          Call {driver.name.split(' ')[0]}
        </a>

        {/*
         * The brand-colour exception: icon-only pill, `aria-label`, and the
         * word "WhatsApp" OUTSIDE it on the page background in brand ink.
         */}
        <span className="flex items-center gap-2">
          <a
            href={`https://wa.me/${waNumber(driver.phone)}`}
            target="_blank"
            rel="noreferrer noopener"
            aria-label={`Message ${driver.name} on WhatsApp`}
            className="bg-whatsapp hover:bg-whatsapp-pressed focus-visible:ring-brand-gold-400 tap-target flex size-11 items-center justify-center rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2"
          >
            <WhatsAppGlyph className="size-5" />
          </a>
          <span className="text-brand-blue-900 text-sm font-semibold">WhatsApp</span>
        </span>
      </div>

      <p className="text-muted-foreground mt-4 text-xs">
        Your driver&apos;s details stay here until the end of your tour day.
      </p>
    </section>
  );
}
