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
 * Settings-driven (spec task 6H, first half). `settings.faqs` is
 * `Array<{ q, a }>`, rendered in API order through the same shadcn
 * `Accordion` — its keyboard behaviour (Radix's roving tabindex, Enter/Space
 * to toggle) is unchanged by this conversion.
 */
export default function FaqSection() {
  const query = trpc.settings.get.useQuery();

  return (
    <section id="faq" className="mx-auto max-w-3xl px-4 py-16 sm:px-6">
      <SectionHeading eyebrow="FAQ" title="Frequently asked questions" />

      <QueryBoundary query={query} skeleton={<FaqSkeleton />} errorTitle="Content could not load">
        {({ faqs }) => (
          <Accordion type="single" collapsible className="mt-8 w-full">
            {faqs.map((faq, i) => (
              <AccordionItem key={faq.q} value={`faq-${i}`}>
                <AccordionTrigger className="text-brand-blue-900 min-h-11 text-left text-base font-semibold">
                  {faq.q}
                </AccordionTrigger>
                <AccordionContent className="text-muted-foreground text-base sm:text-sm">
                  {faq.a}
                </AccordionContent>
              </AccordionItem>
            ))}
          </Accordion>
        )}
      </QueryBoundary>
    </section>
  );
}
