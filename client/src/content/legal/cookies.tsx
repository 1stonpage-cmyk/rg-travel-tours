import { Link } from 'react-router-dom';
import CookieSettingsButton from '@/components/common/CookieSettingsButton';
import { SITE } from '@/lib/site';
import { PlaceholderChip, ScrollableTable, type LegalPageContent } from './shared';

/**
 * Transcribed by hand from C:\dev\project-notes\RGTravelTours\legal\04-cookie-policy.md
 * (owner-approved draft, 2026-10-27) — see privacy.tsx's file note for the same conventions.
 */

export const cookiesContent: LegalPageContent = {
  title: 'Cookie Policy',
  effectiveDate: <PlaceholderChip context="effective date" />,
  sections: [
    {
      id: 'about-cookies',
      heading: 'About this page',
      body: (
        <p>
          Cookies are small files a website stores in your browser. TravelSugbo.com uses a few,
          grouped below. You can change your choice anytime with <CookieSettingsButton /> at the
          bottom of every page.
        </p>
      ),
    },
    {
      id: 'essential',
      heading: '1. Essential (always on)',
      body: (
        <>
          <p>Needed for the site to work. They cannot be switched off.</p>
          <ScrollableTable>
            <thead>
              <tr className="border-border border-b">
                <th scope="col" className="p-3 font-semibold">
                  Name
                </th>
                <th scope="col" className="p-3 font-semibold">
                  What it does
                </th>
                <th scope="col" className="p-3 font-semibold">
                  How long
                </th>
              </tr>
            </thead>
            <tbody>
              <tr className="border-border border-b">
                <td className="p-3">Session cookie</td>
                <td className="p-3">
                  Keeps your booking or account session secure while you check out or view your
                  booking
                </td>
                <td className="p-3">Until you sign out or it expires</td>
              </tr>
              <tr>
                <td className="p-3">Cookie-choice record</td>
                <td className="p-3">Remembers your cookie choice so we don't ask every visit</td>
                <td className="p-3">12 months</td>
              </tr>
            </tbody>
          </ScrollableTable>
        </>
      ),
    },
    {
      id: 'analytics',
      heading: '2. Analytics (only if you agree)',
      body: (
        <>
          <p>
            Google Analytics helps us understand how visitors use the site (pages visited, device
            type) so we can improve it. Data is aggregated.
          </p>
          <ScrollableTable>
            <thead>
              <tr className="border-border border-b">
                <th scope="col" className="p-3 font-semibold">
                  Name
                </th>
                <th scope="col" className="p-3 font-semibold">
                  Provider
                </th>
                <th scope="col" className="p-3 font-semibold">
                  How long
                </th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td className="p-3">_ga, _ga_*</td>
                <td className="p-3">Google</td>
                <td className="p-3">Up to 2 years</td>
              </tr>
            </tbody>
          </ScrollableTable>
        </>
      ),
    },
    {
      id: 'marketing',
      heading: '3. Marketing (only if you agree)',
      body: (
        <>
          <p>
            Meta Pixel lets us measure our Facebook and Instagram ads and show relevant ads to
            people who visited our site.
          </p>
          <ScrollableTable>
            <thead>
              <tr className="border-border border-b">
                <th scope="col" className="p-3 font-semibold">
                  Name
                </th>
                <th scope="col" className="p-3 font-semibold">
                  Provider
                </th>
                <th scope="col" className="p-3 font-semibold">
                  How long
                </th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td className="p-3">_fbp, _fbc</td>
                <td className="p-3">Meta</td>
                <td className="p-3">Up to 90 days</td>
              </tr>
            </tbody>
          </ScrollableTable>
        </>
      ),
    },
    {
      id: 'your-choices',
      heading: '4. Your choices',
      body: (
        <>
          <ul className="list-disc space-y-1 pl-5">
            <li>Choose Accept all, Reject all, or pick categories in Customize.</li>
            <li>Analytics and marketing tools do not load until you agree.</li>
            <li>You can also delete cookies in your browser settings.</li>
          </ul>
          <p>
            See our <Link to="/privacy">Privacy Policy</Link> for how we handle personal data.
            Questions: <a href={`mailto:${SITE.contact.email}`}>{SITE.contact.email}</a>.
          </p>
        </>
      ),
    },
  ],
};
