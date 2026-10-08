import { Clock, Facebook, Mail, MapPin, MessageCircle, Phone } from 'lucide-react';
import { useState } from 'react';
import SectionHeading from '@/components/common/SectionHeading';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { SITE, whatsappLink } from '@/lib/site';

export default function ContactSection() {
  const [submitted, setSubmitted] = useState(false);
  const telHref = `tel:${SITE.contact.phone.replace(/\s/g, '')}`;

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
                href={telHref}
                className="bg-background hover:bg-brand-blue-100 flex min-h-11 items-center gap-3 rounded-xl p-4 text-sm"
              >
                <Phone className="text-brand-blue-600 size-5 shrink-0" aria-hidden="true" />
                <span>
                  <span className="text-brand-blue-900 block font-semibold">Phone / Viber</span>
                  <span className="text-muted-foreground">{SITE.contact.phone}</span>
                </span>
              </a>
            </li>
            <li>
              <a
                href={whatsappLink()}
                target="_blank"
                rel="noreferrer noopener"
                className="bg-background hover:bg-brand-blue-100 flex min-h-11 items-center gap-3 rounded-xl p-4 text-sm"
              >
                <MessageCircle className="text-brand-blue-600 size-5 shrink-0" aria-hidden="true" />
                <span>
                  <span className="text-brand-blue-900 block font-semibold">WhatsApp</span>
                  <span className="text-muted-foreground">Chat with the team</span>
                </span>
              </a>
            </li>
            <li>
              <a
                href={`mailto:${SITE.contact.email}`}
                className="bg-background hover:bg-brand-blue-100 flex min-h-11 items-center gap-3 rounded-xl p-4 text-sm"
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
                className="bg-background hover:bg-brand-blue-100 flex min-h-11 items-center gap-3 rounded-xl p-4 text-sm"
              >
                <Facebook className="text-brand-blue-600 size-5 shrink-0" aria-hidden="true" />
                <span>
                  <span className="text-brand-blue-900 block font-semibold">Facebook</span>
                  <span className="text-muted-foreground">Message our page</span>
                </span>
              </a>
            </li>
            <li className="bg-background flex items-start gap-3 rounded-xl p-4 text-sm">
              <MapPin className="text-brand-blue-600 mt-0.5 size-5 shrink-0" aria-hidden="true" />
              <span>
                <span className="text-brand-blue-900 block font-semibold">Office</span>
                <span className="text-muted-foreground">{SITE.contact.address}</span>
              </span>
            </li>
            <li className="bg-background flex items-start gap-3 rounded-xl p-4 text-sm">
              <Clock className="text-brand-blue-600 mt-0.5 size-5 shrink-0" aria-hidden="true" />
              <span>
                <span className="text-brand-blue-900 block font-semibold">Hours</span>
                <span className="text-muted-foreground">{SITE.contact.hours}</span>
              </span>
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
                className="border-input bg-background focus-visible:ring-ring w-full rounded-md border px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2"
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
