import { Link } from 'react-router-dom';
import { SITE } from '@/lib/site';
import { PlaceholderChip, type LegalPageContent } from './shared';

/**
 * Transcribed by hand from C:\dev\project-notes\RGTravelTours\legal\02-terms-of-service.md
 * (owner-approved draft, 2026-10-27) — see privacy.tsx's file note for the same conventions.
 */
export const termsContent: LegalPageContent = {
  title: 'Terms of Service',
  effectiveDate: <PlaceholderChip context="effective date" />,
  sections: [
    {
      id: 'bookings',
      heading: '1. Bookings',
      body: (
        <>
          <p>
            These terms apply when you use TravelSugbo.com or book a tour through it. TravelSugbo is
            operated by <PlaceholderChip context="registered business name" /> (R&amp;G Travel &amp;
            Tours), <PlaceholderChip context="business address" />, Philippines ("we", "us"). By
            booking, you agree to these terms, our <Link to="/privacy">Privacy Policy</Link> and our{' '}
            <Link to="/refund-policy">Refund Policy</Link>.
          </p>
          <ul className="list-disc space-y-1 pl-5">
            <li>
              You must be 18 or older to book. The person who books (the "lead guest") is
              responsible for the whole group.
            </li>
            <li>
              Prices are shown in Philippine pesos. The price is calculated by our system at
              checkout from the tour, date, group size, add-ons and any valid coupon. If a displayed
              price differs from the checkout total, the checkout total applies.
            </li>
            <li>
              When you start checkout, we hold your slot for a limited time. If payment is not
              completed in that time, the hold ends and the slot is released.
            </li>
            <li>
              A booking is confirmed only after we receive and verify payment: automatically for
              online payments, or after our team checks your uploaded receipt for transfers. You
              will receive a booking reference by email.
            </li>
            <li>
              Availability depends on the date, group size and our vans. Some dates may not be
              bookable.
            </li>
          </ul>
        </>
      ),
    },
    {
      id: 'payment',
      heading: '2. Payment',
      body: (
        <ul className="list-disc space-y-1 pl-5">
          <li>
            You may pay online (through our payment provider, PayMongo) or by bank or e-wallet
            transfer with a receipt upload, where offered.
          </li>
          <li>
            Where a deposit option is offered, the remaining balance is due{' '}
            <PlaceholderChip context="balance-on-tour-day rule" />.
          </li>
          <li>
            Uploaded receipts must be genuine and match the amount due. We may reject a receipt that
            cannot be verified; you will be asked to upload a new one within the time shown.
          </li>
          <li>
            Coupons are subject to their own conditions (dates, minimums, usage limits) and cannot
            be exchanged for cash.
          </li>
        </ul>
      ),
    },
    {
      id: 'cancellations-changes-and-refunds',
      heading: '3. Cancellations, changes and refunds',
      body: (
        <p>
          Covered by our <Link to="/refund-policy">Refund Policy</Link>.
        </p>
      ),
    },
    {
      id: 'on-the-day',
      heading: '4. On the day',
      body: (
        <ul className="list-disc space-y-1 pl-5">
          <li>
            Be ready at your pickup point on time. If we cannot reach you after waiting{' '}
            <PlaceholderChip context="wait time before no-show" />, the booking may be treated as a
            no-show.
          </li>
          <li>
            Some activities (canyoneering, snorkelling, swimming with marine life, hiking) need
            reasonable fitness. Tell us about any health condition, pregnancy or mobility need
            before booking. You join activities at your own risk and must follow the instructions of
            guides, drivers and site staff.
          </li>
          <li>
            Respect local rules, protected areas and marine-life guidelines. We may refuse service
            to anyone who is unsafe, abusive or under the influence.
          </li>
          <li>
            Itineraries and timings may change because of weather, traffic, sea conditions,
            government advisories or site closures. We will offer a fair alternative where possible.
          </li>
        </ul>
      ),
    },
    {
      id: 'weather-and-events-beyond-our-control',
      heading: '5. Weather and events beyond our control',
      body: (
        <p>
          If a tour cannot run safely because of weather, a government order or another event beyond
          our control, we will offer a new date or a refund as set out in the{' '}
          <Link to="/refund-policy">Refund Policy</Link>.
        </p>
      ),
    },
    {
      id: 'third-parties',
      heading: '6. Third parties',
      body: (
        <p>
          Entrance fees, boats, resorts and some activities may be provided by third parties. We
          choose partners carefully but are not responsible for their acts or omissions beyond what
          Philippine law requires.
        </p>
      ),
    },
    {
      id: 'our-responsibility',
      heading: '7. Our responsibility',
      body: (
        <p>
          We provide our services with reasonable care and skill. To the extent allowed by law, we
          are not liable for indirect losses, lost or damaged personal belongings, or delays caused
          by events outside our control. Our total liability for a booking is limited to the amount
          you paid for it. Nothing in these terms limits rights you have under Philippine consumer
          law (including RA 7394).
        </p>
      ),
    },
    {
      id: 'reviews-and-content',
      heading: '8. Reviews and content',
      body: (
        <p>
          Reviews you submit must be honest and about your own trip. We may moderate or remove
          reviews that are false, offensive or unrelated. By submitting, you allow us to show your
          review (with your first name) on the website.
        </p>
      ),
    },
    {
      id: 'website-use',
      heading: '9. Website use',
      body: (
        <p>
          Do not misuse the site: no automated scraping, no attempts to break security, no fake
          bookings or receipts. Site content, the TravelSugbo name and logo belong to us and may not
          be copied without permission.
        </p>
      ),
    },
    {
      id: 'governing-law',
      heading: '10. Governing law',
      body: (
        <p>
          These terms are governed by the laws of the Republic of the Philippines. Disputes will be
          brought before the proper courts of Cebu City, without prejudice to your rights as a
          consumer.
        </p>
      ),
    },
    {
      id: 'changes',
      heading: '11. Changes',
      body: (
        <p>
          We may update these terms. The version in force when you book applies to that booking.
        </p>
      ),
    },
    {
      id: 'contact',
      heading: '12. Contact',
      body: (
        <p>
          <PlaceholderChip context="registered business name" /> (R&amp;G Travel &amp; Tours) ·{' '}
          <PlaceholderChip context="business address" /> ·{' '}
          <a href={`mailto:${SITE.contact.email}`}>{SITE.contact.email}</a> ·{' '}
          <a href={`tel:${SITE.contact.phone.tel}`}>{SITE.contact.phone.display}</a>
        </p>
      ),
    },
  ],
};
