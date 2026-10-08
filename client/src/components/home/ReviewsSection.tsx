import { BadgeCheck } from 'lucide-react';
import SectionHeading from '@/components/common/SectionHeading';
import StarRating from '@/components/common/StarRating';
import { PLACEHOLDER_SETTINGS, REVIEWS } from '@/lib/placeholder-data';

export default function ReviewsSection() {
  // Mandated correction: ratingCount is nullable (spec section 0 forbids
  // fabricating a review count), so the "from N reviews" clause is only
  // appended when a real count exists — same pattern as the hero trust line
  // in HeroSection.tsx. Without this guard, a template literal would print
  // the literal word "null" on the live homepage.
  const subtitle = `${PLACEHOLDER_SETTINGS.ratingAverage.toFixed(1)} average${
    PLACEHOLDER_SETTINGS.ratingCount !== null
      ? ` from ${PLACEHOLDER_SETTINGS.ratingCount} reviews`
      : ''
  }. Only admin-approved reviews are published.`;

  return (
    <section id="reviews" className="bg-brand-blue-50 border-y">
      <div className="mx-auto max-w-7xl px-4 py-16 sm:px-6 lg:px-8">
        <SectionHeading eyebrow="Guest reviews" title="What guests say" subtitle={subtitle} />

        <ul className="mt-10 grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
          {REVIEWS.map((review) => (
            <li key={review.id} className="bg-background flex flex-col rounded-xl p-5 shadow-sm">
              <StarRating value={review.rating} />
              <blockquote className="text-brand-ink mt-3 flex-1 text-base sm:text-sm">{review.body}</blockquote>
              <footer className="mt-4 text-sm">
                <p className="text-brand-blue-900 flex flex-wrap items-center gap-1.5 font-semibold">
                  {review.name}
                  {review.verified && (
                    <span className="text-brand-gold-700 inline-flex items-center gap-1 text-xs font-medium">
                      <BadgeCheck className="size-3.5" aria-hidden="true" />
                      Verified booking
                    </span>
                  )}
                </p>
                <p className="text-muted-foreground text-xs">
                  {review.tour} · {review.dateLabel}
                </p>
              </footer>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
