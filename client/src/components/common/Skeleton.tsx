import type { ComponentProps } from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { cn } from '@/lib/utils';

/**
 * Base skeleton bar. `animate-pulse` is Tailwind's own built-in utility
 * (an opacity pulse, not a bespoke keyframe), which means it is already
 * covered by the unconditional `prefers-reduced-motion` clamp in
 * `index.css` (the `*, *::before, *::after` block forces
 * `animation-duration`/`animation-iteration-count` to effectively zero for
 * every element, regardless of which rule or layer set the animation) — see
 * `src/__tests__/query-boundary.test.tsx` for a test that verifies this
 * rather than assuming it.
 *
 * The bar is `bg-brand-blue-100`, the same tone TourCard already uses for
 * its own image placeholder background, so the *static* (reduced-motion or
 * mid-pulse-trough) frame reads as an intentional placeholder shape, not a
 * rendering glitch.
 */
export function Skeleton({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div
      aria-hidden="true"
      className={cn('bg-brand-blue-100 animate-pulse rounded-md', className)}
      {...props}
    />
  );
}

/**
 * Mirrors TourCard's box exactly — same `Card`/`CardContent` components
 * with the same outer classes, and one skeleton bar per text row TourCard
 * renders below the image (meta, title, rating, booked-count, then the
 * price/cta row's two halves) — so swapping between this and the real card
 * causes no layout shift. Covered by
 * `src/__tests__/query-boundary.test.tsx`.
 *
 * The title and "View tour" rows are both real 44px tap targets in
 * TourCard (`flex min-h-11 items-center` / `inline-flex min-h-11
 * items-center`) — the title and CTA bars below are wrapped in the same
 * `min-h-11` container so the skeleton reserves that same 44px, not just
 * the smaller visual height of the bar itself.
 */
export function TourCardSkeleton() {
  return (
    <Card className="overflow-hidden p-0" role="status" aria-label="Loading tour">
      <Skeleton className="aspect-[4/3] w-full rounded-none" />
      <CardContent className="space-y-3 p-4">
        <Skeleton data-skeleton-bar className="h-3.5 w-2/3" />
        <div className="flex min-h-11 items-center">
          <Skeleton data-skeleton-bar className="h-5 w-5/6" />
        </div>
        <Skeleton data-skeleton-bar className="h-4 w-28" />
        <Skeleton data-skeleton-bar className="h-3.5 w-1/2" />
        <div className="flex items-end justify-between pt-1">
          <Skeleton data-skeleton-bar className="h-5 w-20" />
          <div className="flex min-h-11 items-center">
            <Skeleton data-skeleton-bar className="h-6 w-24" />
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

/**
 * Mirrors the review `<li>` markup in ReviewsSection.tsx
 * (`bg-background flex flex-col rounded-xl p-5 shadow-sm`) with one bar per
 * row: the rating line, three lines for the review body, then the
 * reviewer-name and meta lines in the footer.
 */
export function ReviewCardSkeleton() {
  return (
    <div
      className="bg-background flex flex-col rounded-xl p-5 shadow-sm"
      role="status"
      aria-label="Loading review"
      data-testid="review-card-skeleton"
    >
      <Skeleton className="h-4 w-24" />
      <div className="mt-3 flex-1 space-y-2">
        <Skeleton className="h-3.5 w-full" />
        <Skeleton className="h-3.5 w-full" />
        <Skeleton className="h-3.5 w-2/3" />
      </div>
      <div className="mt-4 space-y-1.5">
        <Skeleton className="h-4 w-32" />
        <Skeleton className="h-3 w-40" />
      </div>
    </div>
  );
}
