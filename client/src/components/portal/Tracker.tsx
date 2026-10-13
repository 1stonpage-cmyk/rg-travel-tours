/**
 * The five-step booking tracker (BUILD_SPEC §7, Week 4 Task 9).
 *
 * **It decides nothing.** The five booleans come from `portalTracker()` in
 * `@rg/shared`, computed on the server and tested there over all eight
 * booking statuses. This component renders them, which is why there is no
 * status logic in this file at all — the page and the server cannot
 * disagree about which steps are lit because only one of them is deciding.
 *
 * ## Accessibility over decoration
 *
 * An ordered list, because the steps are ordered. Each step says "done" or
 * "not done yet" in text for a screen reader rather than relying on a
 * filled circle, and the connector lines are `aria-hidden` — they are a
 * drawing of the list, not information. `aria-current="step"` marks the
 * first step that has not happened, which is the one thing a guest is
 * actually waiting on.
 *
 * Mobile-first: a vertical list at 360px (five horizontal labels do not fit
 * a phone without truncating the longest, "Verified by admin"), becoming a
 * row from `sm` where there is width for it.
 *
 * No red: a step that has not happened is grey-blue, not a warning. Nothing
 * here has failed.
 */
import { Check } from 'lucide-react';
import type { TrackerState } from '@rg/shared';
import { cn } from '@/lib/utils';

type Props = {
  steps: TrackerState[];
};

export default function Tracker({ steps }: Props) {
  const firstPending = steps.findIndex((state) => !state.done);

  return (
    <ol aria-label="Booking progress" className="space-y-3 sm:flex sm:space-x-2 sm:space-y-0">
      {steps.map((state, index) => (
        <li
          key={state.step}
          aria-current={index === firstPending ? 'step' : undefined}
          className="flex items-center gap-3 sm:flex-1 sm:flex-col sm:gap-2 sm:text-center"
        >
          <span
            aria-hidden="true"
            className={cn(
              'flex size-7 shrink-0 items-center justify-center rounded-full border text-xs font-semibold transition-colors',
              state.done
                ? 'bg-brand-blue-700 border-brand-blue-700 text-white'
                : 'border-brand-blue-200 bg-background text-brand-blue-900/50',
            )}
          >
            {state.done ? <Check className="size-4" /> : index + 1}
          </span>
          <span
            className={cn(
              'text-sm',
              state.done ? 'text-brand-blue-900 font-semibold' : 'text-muted-foreground',
            )}
          >
            {state.step}
            {/* The state in words, for a reader who cannot see the fill. */}
            <span className="sr-only">{state.done ? ' — done' : ' — not done yet'}</span>
          </span>
        </li>
      ))}
    </ol>
  );
}
