import QueryBoundary from '@/components/common/QueryBoundary';
import SectionHeading from '@/components/common/SectionHeading';
import { Skeleton } from '@/components/common/Skeleton';
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from '@/components/ui/accordion';
import { trpc } from '@/lib/trpc';

const SKELETON_ITEM_COUNT = 5;

/**
 * Cross-block coupling (spec task 3.4, the main point of this task): the
 * footer's payment chips (SiteFooter.tsx) and this one FAQ answer both
 * describe `settings.paymentMethods`. Task 3.3 wired this section to
 * `settings.faqs` verbatim, which left the seeded answer to this exact
 * question as static prose naming every method by hand — if an admin
 * disables one (say GrabPay), the footer chip disappears but the FAQ goes
 * on advertising it. Matching this question's text and composing its
 * answer from the live `paymentMethods` list, instead of rendering
 * `faq.a` for it, is what closes that drift. Do NOT split this back into
 * two independent copies of the method list — if the seeded question
 * text in `server/src/db/seed-data.ts` ever changes, update this constant
 * to match, or this composition silently stops firing and the answer
 * quietly reverts to whatever static prose is seeded.
 */
const PAYMENT_METHODS_QUESTION = 'Which payment methods do you accept?';

/**
 * Fix round 1, F2: an earlier version of this function folded the 'visa'
 * and 'mastercard' keys into the literal phrase "major cards" so the
 * composed sentence would byte-match the original hand-written FAQ copy.
 * That fold was itself a second, hidden source of truth — exactly the
 * thing this task exists to remove — and it did not survive scrutiny:
 *
 * - Disabling Visa while leaving Mastercard enabled still said "major
 *   cards" (the `some()` check only cared that *a* card remained), which
 *   overstates what is actually accepted once there is only one card
 *   network left — the footer and the FAQ would disagree again.
 * - A newly added card brand not in the fold list (e.g. "JCB") would
 *   render correctly (listed by name, not silently dropped), but
 *   inconsistently — grouped prose for two networks, a bare name for a
 *   third.
 * - The only disabled-method test exercised GrabPay, which was never
 *   folded — so the fold path itself had no coverage at all.
 *
 * Listing every enabled method by its own label, with no grouping,
 * removes the hidden mapping entirely: the sentence is a pure function of
 * `settings.paymentMethods`, so disabling or adding any one method —
 * card network or otherwise — is reflected correctly and identically to
 * the footer chips, with nothing for this file to keep in sync by hand.
 * This does change today's seeded wording (`"... QR Ph and major cards
 * ..."` becomes `"... QR Ph, Visa and Mastercard ..."`) — a small, data-
 * supported copy change traded for actually being correct.
 */

/** `['A']` -> `'A'`, `['A','B']` -> `'A and B'`, `['A','B','C']` -> `'A, B and C'` — no Oxford comma, matching the seeded answer's own style. */
function formatList(items: string[]): string {
  if (items.length === 0) return '';
  if (items.length === 1) return items[0]!;
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

/**
 * Composes the one FAQ answer that must never drift from the footer's
 * payment chips. `methods` is already enabled-only and sorted by
 * `sortOrder` (server-resolved — see `resolvePaymentMethods`,
 * server/src/content/settings.ts), so this only has to join the labels —
 * no grouping, no per-key special-casing (see the comment above).
 */
function paymentMethodsAnswer(methods: { label: string }[]): string {
  const list = formatList(methods.map((m) => m.label));

  if (!list) {
    return 'Message us for current payment options. You can also transfer manually to our QR code and upload the receipt for verification.';
  }
  return `${list} through PayMongo. You can also transfer manually to our QR code and upload the receipt for verification.`;
}

/** One bar per question row, roughly the trigger's own min-h-11 height, so the real accordion causes no layout shift once it resolves. */
function FaqSkeleton() {
  return (
    <div role="status" aria-label="Loading FAQ" className="mt-8 w-full space-y-4">
      {Array.from({ length: SKELETON_ITEM_COUNT }, (_, i) => (
        <Skeleton key={i} className="h-11 w-full" />
      ))}
    </div>
  );
}

/**
 * Settings-driven (spec task 6H, first half; the payment-methods answer
 * below is task 3.4). `settings.faqs` is `Array<{ q, a }>`, rendered in API
 * order through the same shadcn `Accordion` — its keyboard behaviour
 * (Radix's roving tabindex, Enter/Space to toggle) is unchanged by this
 * conversion. One exception: the answer to `PAYMENT_METHODS_QUESTION` is
 * composed at render time from `settings.paymentMethods` instead of
 * rendered from `faq.a` verbatim — see that constant's comment for why.
 */
export default function FaqSection() {
  const query = trpc.settings.get.useQuery();

  return (
    <section id="faq" className="mx-auto max-w-3xl px-4 py-16 sm:px-6">
      <SectionHeading eyebrow="FAQ" title="Frequently asked questions" />

      <QueryBoundary query={query} skeleton={<FaqSkeleton />} errorTitle="Content could not load">
        {({ faqs, paymentMethods }) => (
          <Accordion type="single" collapsible className="mt-8 w-full">
            {faqs.map((faq, i) => {
              const answer =
                faq.q === PAYMENT_METHODS_QUESTION ? paymentMethodsAnswer(paymentMethods) : faq.a;
              return (
                <AccordionItem key={faq.q} value={`faq-${i}`}>
                  <AccordionTrigger className="text-brand-blue-900 min-h-11 text-left text-base font-semibold">
                    {faq.q}
                  </AccordionTrigger>
                  <AccordionContent className="text-muted-foreground text-base sm:text-sm">
                    {answer}
                  </AccordionContent>
                </AccordionItem>
              );
            })}
          </Accordion>
        )}
      </QueryBoundary>
    </section>
  );
}
