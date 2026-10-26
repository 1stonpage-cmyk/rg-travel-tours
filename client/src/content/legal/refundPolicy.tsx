import { SITE } from '@/lib/site';
import { PlaceholderChip, ScrollableTable, type LegalPageContent } from './shared';

/**
 * Transcribed by hand from C:\dev\project-notes\RGTravelTours\legal\03-refund-policy.md
 * (owner-approved draft, 2026-10-27) — see privacy.tsx's file note for the same conventions.
 *
 * The source file opens with an internal note addressed to R&G ("every rule in square brackets
 * is a placeholder... nothing here has been decided for you") — that's instruction for the
 * owner, not copy for a guest, so it is deliberately NOT rendered on the public page. Every
 * bracket it refers to still becomes a visible `PlaceholderChip` below (owner decision #2).
 */
export const refundPolicyContent: LegalPageContent = {
  title: 'Cancellation & Refund Policy',
  effectiveDate: <PlaceholderChip context="effective date" />,
  sections: [
    {
      id: 'if-you-cancel',
      heading: '1. If you cancel',
      body: (
        <>
          <p>
            Cancel by contacting us at{' '}
            <a href={`mailto:${SITE.contact.email}`}>{SITE.contact.email}</a> or{' '}
            <a href={`tel:${SITE.contact.phone.tel}`}>{SITE.contact.phone.display}</a> with your
            booking reference. Cancellation time is counted from your tour's pickup time (Philippine
            time).
          </p>
          <ScrollableTable>
            <thead>
              <tr className="border-border border-b">
                <th scope="col" className="p-3 font-semibold">
                  When you cancel
                </th>
                <th scope="col" className="p-3 font-semibold">
                  Refund
                </th>
              </tr>
            </thead>
            <tbody>
              <tr className="border-border border-b">
                <td className="p-3">
                  <PlaceholderChip context="days before tour" /> or more before the tour
                </td>
                <td className="p-3">
                  <PlaceholderChip context="refund percentage" /> of the amount paid
                </td>
              </tr>
              <tr className="border-border border-b">
                <td className="p-3">
                  Between <PlaceholderChip context="days before tour" /> and{' '}
                  <PlaceholderChip context="hours before tour" /> before
                </td>
                <td className="p-3">
                  <PlaceholderChip context="refund percentage" /> of the amount paid
                </td>
              </tr>
              <tr>
                <td className="p-3">
                  Less than <PlaceholderChip context="hours before tour" /> before, or no-show
                </td>
                <td className="p-3">
                  <PlaceholderChip context="refund amount for a no-show" />
                </td>
              </tr>
            </tbody>
          </ScrollableTable>
          <ul className="mt-3 list-disc space-y-1 pl-5">
            <li>
              <strong>Deposits:</strong>{' '}
              <PlaceholderChip context="whether deposits are refundable" />
            </li>
            <li>
              <strong>Date changes:</strong> you may move your booking to another available date{' '}
              <PlaceholderChip context="date-change allowance" />
            </li>
            <li>
              <strong>Group size changes:</strong>{' '}
              <PlaceholderChip context="group-size change rule" />. Reductions after payment are
              treated as a partial cancellation.
            </li>
          </ul>
        </>
      ),
    },
    {
      id: 'if-we-cancel',
      heading: '2. If we cancel',
      body: (
        <>
          <p>
            If we cancel because of weather, sea conditions, a government advisory or because we
            cannot run the tour safely, you may choose:
          </p>
          <ul className="list-disc space-y-1 pl-5">
            <li>a new date at no extra cost, or</li>
            <li>a full refund of the amount you paid.</li>
          </ul>
        </>
      ),
    },
    {
      id: 'how-refunds-are-paid',
      heading: '3. How refunds are paid',
      body: (
        <ul className="list-disc space-y-1 pl-5">
          <li>
            Refunds go back to the original payment method: card or e-wallet payments through
            PayMongo, transfers to the account you name, cash payments{' '}
            <PlaceholderChip context="cash refund method" />.
          </li>
          <li>
            We aim to process approved refunds within{' '}
            <PlaceholderChip context="refund processing days" /> business days. Your bank or
            e-wallet may take extra time to show the money.
          </li>
          <li>A refund is never more than the amount you actually paid.</li>
          <li>
            <PlaceholderChip context="whether processing fees are deducted" /> deducted from
            refunds.
          </li>
          <li>
            If you used a coupon on a cancelled booking, the coupon use is returned where the coupon
            is still valid. Coupons have no cash value.
          </li>
        </ul>
      ),
    },
    {
      id: 'not-refundable',
      heading: '4. Not refundable',
      body: (
        <ul className="list-disc space-y-1 pl-5">
          <li>
            Unused parts of a tour once it has started (for example, choosing to skip an activity).
          </li>
          <li>Delays or missed activities caused by the guest being late.</li>
          <li>
            <PlaceholderChip context="other exclusions" />
          </li>
        </ul>
      ),
    },
    {
      id: 'questions-or-disputes',
      heading: '5. Questions or disputes',
      body: (
        <p>
          Contact us at <a href={`mailto:${SITE.contact.email}`}>{SITE.contact.email}</a> or{' '}
          <a href={`tel:${SITE.contact.phone.tel}`}>{SITE.contact.phone.display}</a> with your
          booking reference. If you are not satisfied, you may also approach the Department of Trade
          and Industry (DTI).
        </p>
      ),
    },
  ],
};
