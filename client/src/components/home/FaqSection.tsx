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
 * Card networks the seeded prose names collectively as "major cards"
 * rather than spelling out individually — same convention the original,
 * hand-written FAQ answer used. Only these two keys get folded into that
 * phrase; every other enabled method is named by its own label. Keeping
 * this list is what lets `paymentMethodsAnswer` below reproduce today's
 * exact sentence when every method is enabled (this phase's global
 * constraint: "no design change, only the data source changes") while
 * still responding correctly when a method is disabled.
 */
const CARD_METHOD_KEYS = new Set(['visa', 'mastercard']);

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
 * server/src/content/settings.ts), so this only has to group and join.
 */
function paymentMethodsAnswer(methods: { key: string; label: string }[]): string {
  const named = methods.filter((m) => !CARD_METHOD_KEYS.has(m.key)).map((m) => m.label);
  const hasCards = methods.some((m) => CARD_METHOD_KEYS.has(m.key));
  const list = formatList(hasCards ? [...named, 'major cards'] : named);

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
