import { Clock, Facebook, Mail, MapPin, Phone } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { ViberGlyph, WhatsAppGlyph } from '@/components/common/BrandGlyphs';
import SectionHeading from '@/components/common/SectionHeading';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { SITE, telLink, viberLink, whatsappLink } from '@/lib/site';
import { cn } from '@/lib/utils';

/**
 * Shared chip for the WhatsApp/Viber rows below (spec task 2.9I): the
 * official brand colour lives only on this circle, behind the glyph — never
 * behind the row's visible "WhatsApp"/"Viber" text, which stays in brand ink
 * on the row's own background. `.press-brand` (not the plain `.press` other
 * rows here don't carry) is the spec's own scale(0.95)-with-spring-back
 * feedback for these specific brand-colour pills.
 */
function ChatIcon({ tone, children }: { tone: 'whatsapp' | 'viber'; children: ReactNode }) {
  return (
    <span
      className={cn(
        'press-brand flex size-9 shrink-0 items-center justify-center rounded-full text-white transition-[transform,box-shadow] duration-200 hover:-translate-y-0.5 hover:shadow-md',
        tone === 'whatsapp' ? 'bg-whatsapp hover:bg-whatsapp-pressed' : 'bg-viber',
      )}
    >
      {children}
    </span>
  );
}

export default function ContactSection() {
  const [submitted, setSubmitted] = useState(false);

  return (
    <section id="contact" className="bg-brand-blue-50 border-t">
      <div className="mx-auto max-w-7xl px-4 py-16 sm:px-6 lg:px-8">
        <SectionHeading
          eyebrow="Contact"
          title="Contact us"
          subtitle="Message us any day between 7:00 AM and 9:00 PM Philippine time."
        />

        <div className="mt-10 grid gap-8 lg:grid-cols-2">
          <ul className="space-y-4">
            <li>
              <a
                href={telLink(SITE.contact.phone.tel)}
                className="bg-background hover:bg-brand-blue-100 flex min-h-11 items-center gap-3 rounded-xl p-4 text-base sm:text-sm"
              >
                <Phone className="text-brand-blue-600 size-5 shrink-0" aria-hidden="true" />
                <span>
                  <span className="text-brand-blue-900 block font-semibold">
                    Call or text ({SITE.contact.phone.network})
                  </span>
                  <span className="text-muted-foreground">{SITE.contact.phone.display}</span>
                </span>
              </a>
            </li>
            <li>
              <a
                href={telLink(SITE.contact.altPhone.tel)}
                className="bg-background hover:bg-brand-blue-100 flex min-h-11 items-center gap-3 rounded-xl p-4 text-base sm:text-sm"
              >
                <Phone className="text-brand-blue-600 size-5 shrink-0" aria-hidden="true" />
                <span>
                  <span className="text-brand-blue-900 block font-semibold">
                    Call or text ({SITE.contact.altPhone.network})
                  </span>
                  <span className="text-muted-foreground">{SITE.contact.altPhone.display}</span>
                </span>
              </a>
            </li>
            <li>
              <a
                href={whatsappLink()}
                target="_blank"
                rel="noreferrer noopener"
                className="bg-background hover:bg-brand-blue-100 flex min-h-11 items-center gap-3 rounded-xl p-4 text-base sm:text-sm"
              >
                <ChatIcon tone="whatsapp">
                  <WhatsAppGlyph className="size-5" />
                </ChatIcon>
                <span>
                  <span className="text-brand-blue-900 block font-semibold">WhatsApp</span>
                  <span className="text-muted-foreground">{SITE.contact.phone.display}</span>
                </span>
              </a>
            </li>
            <li>
              <a
                href={viberLink()}
                className="bg-background hover:bg-brand-blue-100 flex min-h-11 items-center gap-3 rounded-xl p-4 text-base sm:text-sm"
              >
                <ChatIcon tone="viber">
                  <ViberGlyph className="size-5" />
                </ChatIcon>
                <span>
                  <span className="text-brand-blue-900 block font-semibold">Viber</span>
                  <span className="text-muted-foreground">{SITE.contact.phone.display}</span>
                </span>
              </a>
            </li>
            <li>
              <a
                href={`mailto:${SITE.contact.email}`}
                className="bg-background hover:bg-brand-blue-100 flex min-h-11 items-center gap-3 rounded-xl p-4 text-base sm:text-sm"
              >
                <Mail className="text-brand-blue-600 size-5 shrink-0" aria-hidden="true" />
                <span>
                  <span className="text-brand-blue-900 block font-semibold">Email</span>
                  <span className="text-muted-foreground">{SITE.contact.email}</span>
                </span>
              </a>
            </li>
            <li>
              <a
                href={SITE.contact.facebook}
                target="_blank"
                rel="noreferrer noopener"
                className="bg-background hover:bg-brand-blue-100 flex min-h-11 items-center gap-3 rounded-xl p-4 text-base sm:text-sm"
              >
                <Facebook className="text-brand-blue-600 size-5 shrink-0" aria-hidden="true" />
                <span>
                  <span className="text-brand-blue-900 block font-semibold">Facebook</span>
                  <span className="text-muted-foreground">Message our page</span>
                </span>
              </a>
            </li>
            <li className="bg-background flex items-start gap-3 rounded-xl p-4 text-base sm:text-sm">
              <MapPin className="text-brand-blue-600 mt-0.5 size-5 shrink-0" aria-hidden="true" />
              <span>
                <span className="text-brand-blue-900 block font-semibold">Office</span>
                <span className="text-muted-foreground">{SITE.contact.address}</span>
              </span>
            </li>
            <li className="bg-background flex items-start gap-3 rounded-xl p-4 text-base sm:text-sm">
              <Clock className="text-brand-blue-600 mt-0.5 size-5 shrink-0" aria-hidden="true" />
              <span>
                <span className="text-brand-blue-900 block font-semibold">Hours</span>
                <span className="text-muted-foreground">{SITE.contact.hours}</span>
              </span>
            </li>

            {/* Services beyond tours (spec task 1D). One line, no extra page —
                the ask goes straight to the same WhatsApp line. */}
            <li className="border-brand-blue-200 bg-background rounded-xl border border-dashed p-4 text-base sm:text-sm">
              <p className="text-brand-ink">
                {SITE.otherServices.before}{' '}
                <a
                  href={whatsappLink(
                    `Hi ${SITE.name}! I'd like to ask about transfers, flights or hotels.`,
                  )}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="text-brand-blue-700 -my-3.5 inline-block py-3.5 font-semibold underline underline-offset-2"
                >
                  {SITE.otherServices.link}
                </a>{' '}
                {SITE.otherServices.after}
              </p>
            </li>
          </ul>

          <form
            aria-label="Contact inquiry"
            onSubmit={(e) => {
              e.preventDefault();
              setSubmitted(true);
            }}
            className="bg-background space-y-4 rounded-2xl p-6"
          >
            <h3 className="text-brand-blue-900 text-lg font-semibold">Send us a message</h3>

            <div className="space-y-1.5">
              <Label htmlFor="contact-name">Your name</Label>
              <Input id="contact-name" name="name" required className="tap-target" />
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="contact-email">Email</Label>
                <Input
                  id="contact-email"
                  name="email"
                  type="email"
                  required
                  className="tap-target"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="contact-phone">Mobile</Label>
                <Input id="contact-phone" name="phone" type="tel" className="tap-target" />
              </div>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="contact-message">Message</Label>
              <textarea
                id="contact-message"
                name="message"
                required
                rows={4}
                className="border-input bg-background focus-visible:ring-ring w-full rounded-md border px-3 py-2 text-base focus-visible:outline-none focus-visible:ring-2 md:text-sm"
              />
            </div>

            <Button type="submit" size="lg" className="tap-target w-full">
              Send message
            </Button>

            {submitted && (
              <p role="status" className="text-brand-warning text-sm font-medium">
                Form validated. Message delivery is not connected yet (spec task 7C) — nothing has
                been sent. Please use WhatsApp or phone for now.
              </p>
            )}
          </form>
        </div>
      </div>
    </section>
  );
}
