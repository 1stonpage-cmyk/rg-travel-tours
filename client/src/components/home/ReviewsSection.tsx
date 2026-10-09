import QueryBoundary, { EmptyState } from '@/components/common/QueryBoundary';
import { ReviewCardSkeleton } from '@/components/common/Skeleton';
import SectionHeading from '@/components/common/SectionHeading';
import StarRating from '@/components/common/StarRating';
import { trpc } from '@/lib/trpc';

const SKELETON_CARD_COUNT = 6;

/** `createdAt` is stored UTC; displayed in Asia/Manila per the project-wide time convention. */
const reviewDateFormatter = new Intl.DateTimeFormat('en-PH', {
  timeZone: 'Asia/Manila',
  month: 'long',
  year: 'numeric',
});

/**
 * The server has no superjson transformer (see `mock-trpc.ts`'s own
 * comment on this), so `createdAt` arrives over the wire, and through the
 * mock, as a plain JSON ISO string, not a `Date` instance. `instanceof
 * Date` handles the (currently theoretical) case of a caller handing in a
 * real `Date` without going through JSON first.
 */
function toDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

function ReviewsGridSkeleton() {
  return (
    <ul className="mt-10 grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
      {Array.from({ length: SKELETON_CARD_COUNT }, (_, i) => (
        <li key={i}>
          <ReviewCardSkeleton />
        </li>
      ))}
    </ul>
  );
}

export default function ReviewsSection() {
  const reviewsQuery = trpc.reviews.published.useQuery({});

  return (
    <section id="reviews" className="bg-brand-blue-50 border-y">
      <div className="mx-auto max-w-7xl px-4 py-16 sm:px-6 lg:px-8">
        <SectionHeading
          eyebrow="Guest reviews"
          title="What guests say"
          subtitle="Only admin-approved reviews are published."
        />

        <QueryBoundary
          query={reviewsQuery}
          skeleton={<ReviewsGridSkeleton />}
          empty={
            <EmptyState title="No reviews yet" body="Published guest reviews will appear here." />
          }
          isEmpty={(data) => data.items.length === 0}
          errorTitle="Reviews could not load"
        >
          {(data) => (
            <ul className="mt-10 grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
              {data.items.map((review) => (
                <li
                  key={review.id}
                  className="bg-background flex flex-col rounded-xl p-5 shadow-sm"
                >
                  <StarRating value={review.rating} />
                  {/* Plain-text child — never dangerouslySetInnerHTML. Review
                      bodies are user-submitted and not yet moderated for markup. */}
                  <blockquote className="text-brand-ink mt-3 flex-1 text-base sm:text-sm">
                    {review.body}
                  </blockquote>
                  <footer className="mt-4 text-sm">
                    <p className="text-brand-blue-900 font-semibold">{review.name}</p>
                    <p className="text-muted-foreground text-xs">
                      {reviewDateFormatter.format(toDate(review.createdAt))}
                    </p>
                  </footer>
                </li>
              ))}
            </ul>
          )}
        </QueryBoundary>
      </div>
    </section>
  );
}
