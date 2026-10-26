import { Link } from 'react-router-dom';
import { SITE } from '@/lib/site';
import { PlaceholderChip, ScrollableTable, type LegalPageContent } from './shared';

/**
 * Transcribed by hand from C:\dev\project-notes\RGTravelTours\legal\01-privacy-policy.md
 * (owner-approved draft, 2026-10-27). Wording is the owner's, not invented — see that file for
 * the source. [CONTACT EMAIL]/[CONTACT PHONE] become the real values already confirmed in
 * site.ts (task 2A); every other bracket stays a visible `PlaceholderChip` (owner decision #2).
 */
export const privacyContent: LegalPageContent = {
  title: 'Privacy Policy',
  effectiveDate: <PlaceholderChip context="effective date" />,
  sections: [
    {
      id: 'what-we-collect',
      heading: '1. What we collect',
      body: (
        <>
          <p>
            TravelSugbo.com ("TravelSugbo", "we", "us") is operated by{' '}
            <PlaceholderChip context="registered business name" /> (R&amp;G Travel &amp; Tours),{' '}
            <PlaceholderChip context="business address" />, Philippines. We respect your privacy and
            handle your personal data in line with the Data Privacy Act of 2012 (Republic Act No.
            10173), its Implementing Rules and Regulations, and issuances of the National Privacy
            Commission (NPC).
          </p>
          <p className="font-semibold">When you book or ask about a tour:</p>
          <ul className="list-disc space-y-1 pl-5">
            <li>Lead guest name, email address and mobile number</li>
            <li>
              Booking details: tour, date, group size, add-ons, pickup location, special requests
            </li>
            <li>Coupon codes you use</li>
          </ul>
          <p className="font-semibold">When you pay:</p>
          <ul className="list-disc space-y-1 pl-5">
            <li>
              Online payments (card, e-wallets) are processed by our payment provider, PayMongo. We
              never see or store your full card number, CVV or e-wallet login. We receive only a
              payment reference, amount, method and status.
            </li>
            <li>
              If you pay by bank or e-wallet transfer, the receipt image you upload, which may show
              your name, account details and transaction reference.
            </li>
            <li>If you pay cash on tour day, the amount collected by our driver.</li>
          </ul>
          <p className="font-semibold">When you use our site:</p>
          <ul className="list-disc space-y-1 pl-5">
            <li>
              Technical data such as IP address, browser type and pages visited, used for security
              (for example, blocking repeated failed attempts) and to keep the site working.
            </li>
            <li>
              Cookies, as described in our <Link to="/cookies">Cookie Policy</Link>. Analytics and
              marketing cookies are only used if you agree.
            </li>
          </ul>
          <p className="font-semibold">When you contact us, leave a review or subscribe:</p>
          <p>what you send us (your message, review and rating, email address).</p>
        </>
      ),
    },
    {
      id: 'why-we-use-it',
      heading: '2. Why we use it',
      body: (
        <ScrollableTable>
          <thead>
            <tr className="border-border border-b">
              <th scope="col" className="p-3 font-semibold">
                Purpose
              </th>
              <th scope="col" className="p-3 font-semibold">
                Legal basis (RA 10173)
              </th>
            </tr>
          </thead>
          <tbody>
            {[
              [
                'Take, confirm and manage your booking; assign a van and driver; contact you about your trip',
                'Needed to fulfil our contract with you',
              ],
              [
                'Process payments, verify transfer receipts, issue refunds',
                'Contract; legal obligation',
              ],
              ['Keep records for tax and accounting', 'Legal obligation'],
              ['Prevent fraud and abuse, keep the site secure', 'Legitimate interest'],
              [
                'Send a review request after your trip',
                'Legitimate interest (you can opt out anytime)',
              ],
              ['Newsletters and promotions', 'Your consent'],
              [
                'Analytics (Google Analytics) and advertising (Meta Pixel)',
                'Your consent, via the cookie banner',
              ],
            ].map(([purpose, basis]) => (
              <tr key={purpose} className="border-border border-b last:border-0">
                <td className="p-3">{purpose}</td>
                <td className="p-3">{basis}</td>
              </tr>
            ))}
          </tbody>
        </ScrollableTable>
      ),
    },
    {
      id: 'who-we-share-it-with',
      heading: '3. Who we share it with',
      body: (
        <>
          <p>We share only what each party needs:</p>
          <ul className="list-disc space-y-1 pl-5">
            <li>
              <strong>Your assigned driver and guide:</strong> lead guest name, mobile number,
              pickup details and group size for your trip.
            </li>
            <li>
              <strong>PayMongo:</strong> to process online payments and refunds.
            </li>
            <li>
              <strong>Our email provider (Brevo):</strong> to send booking confirmations and trip
              emails.
            </li>
            <li>
              <strong>Our hosting and network providers</strong> (for example, our server host and
              Cloudflare): to run and protect the website.
            </li>
            <li>
              <strong>Tour partners</strong> (resorts, boat operators, attraction managers): when
              needed to arrange entry or permits for your booked tour.
            </li>
            <li>
              <strong>Google and Meta:</strong> only if you accept analytics or marketing cookies.
            </li>
            <li>
              <strong>Government authorities:</strong> when required by law.
            </li>
          </ul>
          <p>
            We do <strong>not</strong> sell your personal data. Some providers may process data
            outside the Philippines; we use providers that protect data to a standard comparable to
            Philippine law.
          </p>
        </>
      ),
    },
    {
      id: 'how-long-we-keep-it',
      heading: '4. How long we keep it',
      body: (
        <ul className="list-disc space-y-1 pl-5">
          <li>
            Booking and payment records: as long as required by Philippine tax and accounting law,
            then deleted or anonymised. <PlaceholderChip context="retention period" />
          </li>
          <li>
            Transfer receipt images: <PlaceholderChip context="retention period" /> after the trip,
            unless needed for a dispute.
          </li>
          <li>
            Security logs: <PlaceholderChip context="retention period" />.
          </li>
          <li>Newsletter data: until you unsubscribe.</li>
        </ul>
      ),
    },
    {
      id: 'how-we-protect-it',
      heading: '5. How we protect it',
      body: (
        <p>
          Encrypted connections (HTTPS), restricted staff access by role, receipt files stored
          privately and shown only to authorised staff, passwords stored in hashed form, and an
          audit trail of payment and booking changes. No system is perfectly secure, but we take
          reasonable organisational, physical and technical measures.
        </p>
      ),
    },
    {
      id: 'your-rights',
      heading: '6. Your rights',
      body: (
        <>
          <p>
            Under RA 10173 you have the right to be informed, to access your data, to correct it, to
            object to processing, to have it erased or blocked, to data portability, and to claim
            damages. You may also file a complaint with the National Privacy Commission
            (privacy.gov.ph).
          </p>
          <p>
            To use any right, contact our Data Protection Officer:
            <br />
            <PlaceholderChip context="DPO name" /> ·{' '}
            <a href={`mailto:${SITE.contact.email}`}>{SITE.contact.email}</a> ·{' '}
            <a href={`tel:${SITE.contact.phone.tel}`}>{SITE.contact.phone.display}</a>
          </p>
          <p>
            We may need to confirm your identity (for example, your booking reference and email)
            before acting.
          </p>
        </>
      ),
    },
    {
      id: 'children',
      heading: '7. Children',
      body: (
        <p>
          Bookings must be made by an adult. Details of children joining a tour are provided by
          their parent or guardian.
        </p>
      ),
    },
    {
      id: 'changes',
      heading: '8. Changes',
      body: (
        <p>
          We may update this policy. The effective date above shows the latest version. Major
          changes will be announced on the website.
        </p>
      ),
    },
    {
      id: 'contact',
      heading: '9. Contact',
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
