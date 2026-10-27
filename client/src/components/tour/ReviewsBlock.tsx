/**
 * The public reviews block for one tour (Week 7 plan, Task 11; BUILD_SPEC §4
 * "Reviews"). Lives inside `TourDetailPage.tsx`'s `<section id="reviews">`.
 *
 * Reads `trpc.reviews.forTour` — one query carries the aggregate, the 5–1★
 * breakdown, the four sub-score averages and the current page of reviews, so
 * changing the star filter, the sort or "show more" is always a single
 * re-query, never a client-side re-slice of a list fetched once.
 *
 * ## The breakdown and sub-scores never move when the filter does
 *
 * `breakdown`, `subscores`, `total` and `rating` are computed server-side over
 * every published review of the tour, ignoring `starFilter` — only `items`
 * (the list itself) and `matching` (the count the list's own heading uses)
 * respond to it. Clicking "3★" narrows the list without rewriting the summary
 * above it, which is the server's own contract (`forTour`'s doc comment) and
 * this component simply trusts it rather than re-deriving anything.
 *
 * ## Stars are never the only signal
 *
 * `StarRating` already prints the numeric average beside the stars and gives
 * it a real screen-reader string (BUG-063). This block repeats that rule for
 * the four sub-scores, which have no shared component: each one shows its
 * number beside (or instead of) the stars, never stars alone.
 *
 * ## Helpful votes are optimistic, and un-voting is not offered
 *
 * `voteHelpful` returns `counted: false` for a browser's second click — a
 * shrug, not an error — and there is no query that can tell this page in
 * advance whether a review was already voted on by this browser (the vote
 * cookie is httpOnly). So "already voted" is purely local state for this page
 * session: a `Set` of review ids this browser has successfully clicked
 * "Helpful" on *during this visit*, bumping the displayed count by one only
 * when the server said `counted: true`. A page reload forgets it, same as the
 * server's own cookie-based memory would look like to a fresh tab.
 */
import { useState } from 'react';
import { ThumbsUp } from 'lucide-react';
import { keepPreviousData } from '@tanstack/react-query';
import {
  REVIEW_SORTS,
  REVIEW_STAR_VALUES,
  REVIEW_SUBSCORES,
  REVIEW_SUBSCORE_LABELS,
  TOUR_REVIEWS_DEFAULT_LIMIT,
  TOUR_REVIEWS_MAX_LIMIT,
  type ReviewSort,
  type TourReviewItem,
  type TourReviewsResult,
} from '@rg/shared';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import QueryBoundary, { EmptyState } from '@/components/common/QueryBoundary';
import { ReviewCardSkeleton } from '@/components/common/Skeleton';
import StarRating from '@/components/common/StarRating';
import { SITE } from '@/lib/site';
import { cn } from '@/lib/utils';
import { trpc } from '@/lib/trpc';

const SORT_LABELS: Record<ReviewSort, string> = {
  newest: 'Newest',
  highest: 'Highest rated',
  helpful: 'Most helpful',
};

/** `createdAt`/`repliedAt` are UTC instants; shown in Asia/Manila, same rule as `ReviewsSection.tsx`. */
const monthYearFormatter = new Intl.DateTimeFormat('en-PH', {
  timeZone: 'Asia/Manila',
  month: 'long',
  year: 'numeric',
});

function toDate(value: string): Date {
  return new Date(value);
}

type Props = { tourSlug: string };

function BreakdownSkeleton() {
  return (
    <div className="mt-4 space-y-6">
      <ul className="space-y-2" aria-hidden="true">
        {REVIEW_STAR_VALUES.map((stars) => (
          <li key={stars} className="bg-brand-blue-100 h-4 w-full animate-pulse rounded" />
        ))}
      </ul>
      <ul className="grid gap-4 sm:grid-cols-2">
        {Array.from({ length: 3 }, (_, i) => (
          <li key={i}>
            <ReviewCardSkeleton />
          </li>
        ))}
      </ul>
    </div>
  );
}

/** The 5★-down-to-1★ bars. Always over every published review — see module note. */
function Breakdown({
  breakdown,
  total,
}: {
  breakdown: TourReviewsResult['breakdown'];
  total: number;
}) {
  return (
    <ul className="mt-4 space-y-1.5" aria-label="Rating breakdown">
      {breakdown.map(({ stars, count }) => {
        const pct = total > 0 ? Math.round((count / total) * 100) : 0;
        return (
          <li key={stars} className="flex items-center gap-2 text-sm">
            <span className="text-brand-ink w-9 shrink-0 font-medium">{stars}★</span>
            <span className="bg-brand-blue-100 h-2 flex-1 overflow-hidden rounded-full">
              <span
                className="bg-brand-gold-500 block h-full rounded-full"
                style={{ width: `${pct}%` }}
              />
            </span>
            <span className="text-muted-foreground w-10 shrink-0 text-right">{count}</span>
          </li>
        );
      })}
    </ul>
  );
}

/** The four sub-score averages — a number beside (or instead of) the stars, always. */
function Subscores({ subscores }: { subscores: TourReviewsResult['subscores'] }) {
  return (
    <dl className="mt-6 grid gap-4 sm:grid-cols-2" data-testid="tour-subscores">
      {REVIEW_SUBSCORES.map((key) => {
        const value = subscores[key];
        return (
          <div key={key} className="flex items-center justify-between gap-3 text-sm">
            <dt className="text-brand-ink font-medium">{REVIEW_SUBSCORE_LABELS[key]}</dt>
            <dd>
              {value === null ? (
                <span className="text-muted-foreground">Not yet rated</span>
              ) : (
                <StarRating value={value} size="sm" />
              )}
            </dd>
          </div>
        );
      })}
    </dl>
  );
}

function StarFilterControl({
  breakdown,
  total,
  value,
  onChange,
}: {
  breakdown: TourReviewsResult['breakdown'];
  total: number;
  value: number | undefined;
  onChange: (next: number | undefined) => void;
}) {
  const countByStar = new Map(breakdown.map((row) => [row.stars, row.count]));
  return (
    <div role="group" aria-label="Filter by star rating" className="flex flex-wrap gap-2 text-sm">
      <button
        type="button"
        aria-pressed={value === undefined}
        onClick={() => onChange(undefined)}
        className={cn(
          'tap-target rounded-full border px-3 font-semibold transition-colors',
          value === undefined
            ? 'border-brand-blue-700 bg-brand-blue-700 text-white'
            : 'border-brand-blue-200 text-brand-blue-800 hover:bg-brand-blue-50',
        )}
      >
        All ({total})
      </button>
      {REVIEW_STAR_VALUES.map((stars) => (
        <button
          key={stars}
          type="button"
          aria-pressed={value === stars}
          onClick={() => onChange(stars)}
          className={cn(
            'tap-target rounded-full border px-3 font-semibold transition-colors',
            value === stars
              ? 'border-brand-blue-700 bg-brand-blue-700 text-white'
              : 'border-brand-blue-200 text-brand-blue-800 hover:bg-brand-blue-50',
          )}
        >
          {stars}★ ({countByStar.get(stars) ?? 0})
        </button>
      ))}
    </div>
  );
}

function ReviewListItem({
  review,
  voted,
  bump,
  onVote,
  voting,
}: {
  review: TourReviewItem;
  voted: boolean;
  bump: number;
  onVote: () => void;
  voting: boolean;
}) {
  const displayedHelpfulCount = review.helpfulCount + bump;

  return (
    <li className="border-brand-blue-100 rounded-xl border bg-white p-4 sm:p-5">
      <div className="flex flex-wrap items-center gap-2">
        <StarRating value={review.rating} size="sm" />
        {review.verified ? (
          <Badge className="bg-brand-blue-50 text-brand-blue-800 border-0">Verified booking</Badge>
        ) : null}
      </div>
      <p className="text-brand-ink mt-2 text-sm leading-relaxed">{review.body}</p>
      <footer className="mt-3 flex flex-wrap items-center justify-between gap-2 text-sm">
        <div>
          <p className="text-brand-blue-900 font-semibold">{review.name}</p>
          <p className="text-muted-foreground text-xs">
            {monthYearFormatter.format(toDate(review.createdAt))}
          </p>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={voted || voting}
          aria-pressed={voted}
          onClick={onVote}
          className="tap-target gap-1.5"
        >
          <ThumbsUp className="size-3.5" aria-hidden="true" />
          {voted
            ? `Marked helpful (${displayedHelpfulCount})`
            : `Helpful (${displayedHelpfulCount})`}
        </Button>
      </footer>

      {review.reply ? (
        <div className="border-brand-gold-500 bg-brand-blue-50 mt-3 rounded-lg border-l-4 p-3">
          <p className="text-brand-blue-900 text-xs font-semibold">Response from {SITE.name}</p>
          <p className="text-brand-ink mt-1 text-sm leading-relaxed">{review.reply}</p>
          {review.repliedAt ? (
            <p className="text-muted-foreground mt-1 text-xs">
              {monthYearFormatter.format(toDate(review.repliedAt))}
            </p>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}

function ReviewsBody({
  data,
  sort,
  setSort,
  starFilter,
  setStarFilter,
  onShowMore,
  canShowMore,
}: {
  data: TourReviewsResult;
  sort: ReviewSort;
  setSort: (next: ReviewSort) => void;
  starFilter: number | undefined;
  setStarFilter: (next: number | undefined) => void;
  onShowMore: () => void;
  canShowMore: boolean;
}) {
  const [votedIds, setVotedIds] = useState<Set<number>>(new Set());
  const [bumps, setBumps] = useState<Record<number, number>>({});

  /*
   * Deliberately no `utils.reviews.forTour.invalidate()` here. A refetch
   * after a real server vote would come back with `helpfulCount` already
   * incremented, and adding the optimistic `bump` on top of THAT would
   * double-count the same vote. The bump is the whole story for this page
   * session (see the module note on why there is no way to know in
   * advance) — it is not a stand-in for a refetch that is about to correct
   * it.
   */
  const vote = trpc.reviews.voteHelpful.useMutation({
    onSuccess: (result, variables) => {
      setVotedIds((current) => new Set(current).add(variables.reviewId));
      if (result.counted) {
        setBumps((current) => ({ ...current, [variables.reviewId]: 1 }));
      }
    },
  });

  return (
    <div className="mt-4">
      {data.rating ? (
        <StarRating value={data.rating.average} count={data.rating.count} size="md" />
      ) : data.total > 0 ? (
        <p className="text-muted-foreground text-sm">
          {data.total} {data.total === 1 ? 'review' : 'reviews'} — not enough yet for a rating.
        </p>
      ) : null}

      <Breakdown breakdown={data.breakdown} total={data.total} />
      <Subscores subscores={data.subscores} />

      <div className="mt-6 flex flex-wrap items-center justify-between gap-3">
        <StarFilterControl
          breakdown={data.breakdown}
          total={data.total}
          value={starFilter}
          onChange={setStarFilter}
        />
        <label className="flex items-center gap-2 text-sm">
          <span className="text-brand-ink font-medium">Sort by</span>
          <select
            value={sort}
            onChange={(event) => setSort(event.target.value as ReviewSort)}
            className="tap-target border-brand-blue-200 rounded-md border bg-white px-2 text-sm"
          >
            {REVIEW_SORTS.map((option) => (
              <option key={option} value={option}>
                {SORT_LABELS[option]}
              </option>
            ))}
          </select>
        </label>
      </div>

      <p className="text-muted-foreground mt-4 text-sm">
        Showing {data.items.length} of {data.matching} {data.matching === 1 ? 'review' : 'reviews'}
        {starFilter ? ` rated ${starFilter}★` : ''}.
      </p>

      {data.items.length === 0 ? (
        <p className="text-muted-foreground mt-3 text-sm">No reviews match this filter.</p>
      ) : (
        <ul className="mt-3 grid gap-4 sm:grid-cols-2" aria-label="Reviews">
          {data.items.map((review) => (
            <ReviewListItem
              key={review.id}
              review={review}
              voted={votedIds.has(review.id)}
              bump={bumps[review.id] ?? 0}
              voting={vote.isPending && vote.variables?.reviewId === review.id}
              onVote={() => vote.mutate({ reviewId: review.id })}
            />
          ))}
        </ul>
      )}

      {canShowMore ? (
        <div className="mt-4 flex justify-center">
          <Button type="button" variant="outline" className="tap-target" onClick={onShowMore}>
            Show more reviews
          </Button>
        </div>
      ) : null}
    </div>
  );
}

export default function ReviewsBlock({ tourSlug }: Props) {
  const [starFilter, setStarFilter] = useState<number | undefined>(undefined);
  const [sort, setSort] = useState<ReviewSort>('newest');
  const [limit, setLimit] = useState(TOUR_REVIEWS_DEFAULT_LIMIT);

  const query = trpc.reviews.forTour.useQuery(
    { tourSlug, starFilter, sort, limit },
    { placeholderData: keepPreviousData },
  );

  function changeStarFilter(next: number | undefined) {
    setStarFilter(next);
    setLimit(TOUR_REVIEWS_DEFAULT_LIMIT);
  }

  function changeSort(next: ReviewSort) {
    setSort(next);
    setLimit(TOUR_REVIEWS_DEFAULT_LIMIT);
  }

  return (
    <QueryBoundary
      query={query}
      skeleton={<BreakdownSkeleton />}
      empty={<EmptyState title="No reviews yet" body="Published guest reviews will appear here." />}
      isEmpty={(data) => data.total === 0}
      errorTitle="Reviews could not load"
    >
      {(data) => (
        <ReviewsBody
          data={data}
          sort={sort}
          setSort={changeSort}
          starFilter={starFilter}
          setStarFilter={changeStarFilter}
          canShowMore={data.items.length < data.matching && limit < TOUR_REVIEWS_MAX_LIMIT}
          onShowMore={() =>
            setLimit((current) =>
              Math.min(current + TOUR_REVIEWS_DEFAULT_LIMIT, TOUR_REVIEWS_MAX_LIMIT),
            )
          }
        />
      )}
    </QueryBoundary>
  );
}
