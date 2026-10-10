import { Clock, Facebook, Mail, MapPin, Phone } from 'lucide-react';
import { useState, type FormEvent, type ReactNode } from 'react';
import { ViberGlyph, WhatsAppGlyph } from '@/components/common/BrandGlyphs';
import SectionHeading from '@/components/common/SectionHeading';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { describeMutationError } from '@/lib/mutation-errors';
import { SITE, telLink, viberLink, whatsappLink } from '@/lib/site';
import { trpc } from '@/lib/trpc';
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
  const [consentError, setConsentError] = useState<string | null>(null);
  const sendInquiry = trpc.inquiries.create.useMutation();

  function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const data = new FormData(form);
    if (data.get('consent') !== 'on') {
      // Clear any earlier result first: without this, a second submit with
      // consent unchecked renders the stale "Message sent" status right
      // beside the new consent alert — two contradictory statuses, one of
      // them about a message that is not being sent.
      sendInquiry.reset();
      setConsentError(
        'Please agree to be contacted before sending — we need this to reply to you (RA 10173).',
      );
      return;
    }
    setConsentError(null);
    const phone = String(data.get('phone') ?? '').trim();
    sendInquiry.mutate(
      {
        type: 'contact',
        name: String(data.get('name') ?? ''),
        email: String(data.get('email') ?? ''),
        phone: phone === '' ? undefined : phone,
        message: String(data.get('message') ?? ''),
        consent: true,
      },
      { onSuccess: () => form.reset() },
    );
  }

  /**
   * `settings.openState.message` — computed server-side, in Asia/Manila
   * (Task 1.5's `resolveOpenState`), never recomputed here from a client
   * clock (which would be correct only for a guest already in that
   * timezone). Fix round 1, F1: spec 6E says the contact section and the
   * WhatsApp button *show* this message — rendering it `sr-only` (as this
   * component first did) hides it from every sighted visitor, which is
   * the one audience it exists for. It renders visibly now, directly under
   * the existing Hours line below, as a small status line rather than a
   * banner. FloatingWhatsApp reads the identical `openState` off the same
   * `trpc.settings.get.useQuery()` cache entry (TanStack Query dedupes by
   * key), so the two can never disagree.
   */
  const { data: settings } = trpc.settings.get.useQuery();
  const openState = settings?.openState ?? null;
  /**
   * The displayed hours come from `settings.contact.hoursNote`, not from
   * `SITE.contact.hours` and not from a hardcoded "7 AM–9 PM" subtitle.
   * `openState.message` above is computed server-side from the
   * `business_hours` setting, so a static hours line could contradict it —
   * change the hours and this one card would have said "Mon–Sun, 7:00 AM –
   * 9:00 PM" directly above "Closed — we'll reply by 9:00 AM". Both
   * statements now come off the same settings payload.
   */
  const hoursNote = settings?.contact.hoursNote ?? null;

  return (
    <section id="contact" className="bg-brand-blue-50 border-t">
      <div className="mx-auto max-w-7xl px-4 py-16 sm:px-6 lg:px-8">
        <SectionHeading
          eyebrow="Contact"
          title="Contact us"
          subtitle={
            hoursNote ? `Message us any time — we're open ${hoursNote}.` : 'Message us any time.'
          }
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
                {hoursNote && <span className="text-muted-foreground">{hoursNote}</span>}
                {/*
                 * Live open/closed status (spec 6E). A small status line,
                 * not a banner: same text-sm scale as the surrounding copy,
                 * with only the dot — a decorative, non-text element —
                 * carrying the open/closed colour, so there is no coloured-
                 * text contrast pairing to verify (CLAUDE.md: no red; BUG-080
                 * means text-brand-warning on bg-brand-gold-100 is avoided
                 * on purpose here).
                 */}
                {openState && (
                  <span className="text-brand-blue-900 mt-1 flex items-center gap-1.5 text-sm font-medium">
                    <span
                      aria-hidden="true"
                      className={cn(
                        'size-2 shrink-0 rounded-full',
                        openState.isOpen ? 'bg-brand-blue-500' : 'bg-brand-warning',
                      )}
                    />
                    {openState.message}
                  </span>
                )}
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
            onSubmit={handleSubmit}
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

            {/*
             * RA 10173 (Data Privacy Act) consent checkbox. The server
             * rejects a missing/false `consent` outright (Task 1.7's
             * `inquiryInput`), but that's a backstop, not the UX — this
             * blocks submission client-side first and says why, right here
             * next to the checkbox, rather than leaving a disabled button
             * with no explanation.
             */}
            <div className="flex items-start gap-2.5">
              <input
                id="contact-consent"
                name="consent"
                type="checkbox"
                onChange={() => setConsentError(null)}
                className="accent-brand-blue-600 border-input mt-0.5 size-5 shrink-0 rounded"
              />
              <Label
                htmlFor="contact-consent"
                className="text-muted-foreground text-sm font-normal"
              >
                I agree to be contacted about this message and consent to {SITE.legalOperator}{' '}
                storing my details, per the Data Privacy Act (RA 10173).
              </Label>
            </div>
            {consentError && (
              <p role="alert" className="text-brand-error text-sm font-medium">
                {consentError}
              </p>
            )}

            <Button
              type="submit"
              size="lg"
              className="tap-target w-full"
              disabled={sendInquiry.isPending}
            >
              {sendInquiry.isPending ? 'Sending…' : 'Send message'}
            </Button>

            {sendInquiry.isSuccess && (
              <p role="status" className="text-brand-blue-700 text-sm font-medium">
                Message sent — we'll get back to you soon.
              </p>
            )}
            {sendInquiry.isError && (
              <p role="alert" className="text-brand-error text-sm font-medium">
                {describeMutationError(sendInquiry.error)}
              </p>
            )}
          </form>
        </div>
      </div>
    </section>
  );
}
