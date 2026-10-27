/**
 * `reviews.published`, `reviews.forTour`, `reviews.voteHelpful` — the public
 * reviews surface.
 *
 * `published` is the site-wide list the home page reads (Task 1.6). `forTour`
 * is §4's reviews BLOCK on a tour detail page: the aggregate, the 5–1★
 * breakdown, the four sub-score averages, a star filter and three orderings.
 * `voteHelpful` is §4's "Was this helpful?".
 *
 * **Nothing here can publish a review.** A guest's submission lands `pending`
 * (`portal.submitReview`) and only `admin.reviews.setStatus` moves it, so
 * every read below filters on `status = 'published'` and that filter is the
 * whole of the moderation guarantee on this side.
 */
import {
  REVIEW_STAR_VALUES,
  reviewHelpfulInput,
  reviewsPublishedInput,
  tourReviewsInput,
  type ReviewStarCount,
  type ReviewSubscoreAverages,
  type TourReviewItem,
  type TourReviewsResult,
} from '@rg/shared';
import { TRPCError } from '@trpc/server';
import { and, desc, eq, sql, type SQL } from 'drizzle-orm';
import { readTrustSettings } from '../../content/settings';
import { getDb } from '../../db/client';
import { isDuplicateKeyError } from '../../db/duplicate-key';
import { destinations, reviewHelpfulVotes, reviews, tours } from '../../db/schema';
import {
  applyRatingThreshold,
  displayAggregate,
  realAggregate,
  type Aggregate,
} from '../../services/ratings';
import { voterHashForRequest } from '../../services/reviews/votes';
import { publicProcedure, router } from '../../trpc';

export interface Review {
  id: number;
  tourId: number | null;
  /** The reviewed tour's title, joined in — null when `tourId` is null. */
  tourTitle: string | null;
  name: string;
  rating: number;
  guide: number | null;
  value: number | null;
  punctuality: number | null;
  safety: number | null;
  body: string;
  isSample: boolean;
  reply: string | null;
  repliedAt: Date | null;
  createdAt: Date;
}

export interface ReviewsPublishedResult {
  items: Review[];
  /** All published reviews, samples included (D1) — drives the visible star ratings. */
  displayAggregate: Aggregate | null;
  /** Published AND `is_sample = 0` — drives JSON-LD `AggregateRating` only, never a seeded-sample score. */
  realAggregate: Aggregate | null;
}

/** The one refusal for a slug that is not a publicly visible tour. */
function tourNotFound(slug: string): TRPCError {
  return new TRPCError({
    code: 'NOT_FOUND',
    message: `NOT_FOUND: no tour found for slug "${slug}"`,
  });
}

/** `AVG()` comes back from mysql2 as a decimal string, or null over no rows. */
function averageOrNull(value: string | number | null): number | null {
  if (value === null) return null;
  return Math.round(Number(value) * 10) / 10;
}

export const reviewsRouter = router({
  published: publicProcedure
    .input(reviewsPublishedInput)
    .query(async ({ input }): Promise<ReviewsPublishedResult> => {
      const db = getDb();
      const conditions = [eq(reviews.status, 'published')];
      if (input.tourId !== undefined) conditions.push(eq(reviews.tourId, input.tourId));

      // One query, one left join — a review has at most one tour, so there's
      // no fan-out to batch (unlike tours.list's per-tour images/ratings).
      // Never N+1: see "no N+1" test in public-queries.test.ts.
      const items = await db
        .select({
          id: reviews.id,
          tourId: reviews.tourId,
          tourTitle: tours.title,
          name: reviews.name,
          rating: reviews.rating,
          guide: reviews.guide,
          value: reviews.value,
          punctuality: reviews.punctuality,
          safety: reviews.safety,
          body: reviews.body,
          isSample: reviews.isSample,
          reply: reviews.reply,
          repliedAt: reviews.repliedAt,
          createdAt: reviews.createdAt,
        })
        .from(reviews)
        .leftJoin(tours, eq(reviews.tourId, tours.id))
        .where(and(...conditions))
        .orderBy(desc(reviews.createdAt), desc(reviews.id))
        .limit(input.limit);

      const [display, real] = await Promise.all([
        displayAggregate(input.tourId),
        realAggregate(input.tourId),
      ]);

      return { items, displayAggregate: display, realAggregate: real };
    }),

  /**
   * §4's reviews block for one tour.
   *
   * ## The slug is resolved, never trusted as an id
   *
   * The input carries a slug and the resolver turns it into an id, with the
   * same NOT_FOUND `tours.bySlug` answers — including for a soft-deleted tour
   * or one whose DESTINATION is inactive (I1). A tour that is not publicly
   * visible has no publicly visible reviews either.
   *
   * ## Five queries, whatever the review count
   *
   * The slug lookup, the page of reviews (left-joined to their votes so
   * `helpfulCount` and the `helpful` ordering come from one query), the star
   * breakdown, the sub-score averages, and the `trust` settings row. None of
   * them runs once per review — `reviews-moderation.test.ts` counts the real
   * `pool.query()` calls rather than trusting this paragraph.
   *
   * ## The headline numbers ignore the filter
   *
   * `total`, `breakdown`, `subscores` and `rating` are computed over EVERY
   * published review of the tour, so clicking "3★" narrows the list without
   * rewriting the summary above it. `matching` is the filtered count, which is
   * what the list's own heading says.
   *
   * ## No fabricated social proof
   *
   * `rating` is withheld below `settings.trust.minReviewsForRating` by the
   * same `applyRatingThreshold` the tour cards use, and is `null` rather than
   * a zero when there is nothing to average — `count` is still reported, so
   * the block can say "2 reviews" without claiming a score. Samples ARE
   * counted here, exactly as `displayAggregate` counts them (D1): they are
   * placeholder content kept out of search by `content_unverified`, and out of
   * structured data by `realAggregate`, not hidden from the page itself.
   */
  forTour: publicProcedure
    .input(tourReviewsInput)
    .query(async ({ input }): Promise<TourReviewsResult> => {
      const db = getDb();

      const [tour] = await db
        .select({ id: tours.id })
        .from(tours)
        .innerJoin(destinations, eq(tours.destinationId, destinations.id))
        .where(
          and(
            eq(tours.slug, input.tourSlug),
            eq(tours.isActive, true),
            eq(destinations.isActive, true),
          ),
        )
        .limit(1);
      if (!tour) throw tourNotFound(input.tourSlug);

      const publishedForTour = and(eq(reviews.tourId, tour.id), eq(reviews.status, 'published'));

      const itemConditions: SQL[] = [publishedForTour as SQL];
      if (input.starFilter !== undefined) {
        itemConditions.push(eq(reviews.rating, input.starFilter));
      }

      /*
       * `COUNT()` over the left-joined votes, so the count and the `helpful`
       * ordering come from the same query as the page. Counting in JS instead
       * would order the WRONG rows: the limit is applied by the database.
       *
       * Every selected non-aggregate column is named in the GROUP BY
       * (ONLY_FULL_GROUP_BY), the same way `admin.coupons.list` does it.
       * `bookingId` is selected only so `verified` can be derived from it
       * below — it is never returned.
       */
      const helpfulCount = sql<string>`count(${reviewHelpfulVotes.voterHash})`;
      const orderBy =
        input.sort === 'helpful'
          ? [desc(helpfulCount), desc(reviews.createdAt), desc(reviews.id)]
          : input.sort === 'highest'
            ? [desc(reviews.rating), desc(reviews.createdAt), desc(reviews.id)]
            : [desc(reviews.createdAt), desc(reviews.id)];

      const [rows, breakdownRows, [subscoreRow], trust] = await Promise.all([
        db
          .select({
            id: reviews.id,
            bookingId: reviews.bookingId,
            name: reviews.name,
            rating: reviews.rating,
            guide: reviews.guide,
            value: reviews.value,
            punctuality: reviews.punctuality,
            safety: reviews.safety,
            body: reviews.body,
            reply: reviews.reply,
            repliedAt: reviews.repliedAt,
            createdAt: reviews.createdAt,
            helpfulCount,
          })
          .from(reviews)
          .leftJoin(reviewHelpfulVotes, eq(reviewHelpfulVotes.reviewId, reviews.id))
          .where(and(...itemConditions))
          .groupBy(
            reviews.id,
            reviews.bookingId,
            reviews.name,
            reviews.rating,
            reviews.guide,
            reviews.value,
            reviews.punctuality,
            reviews.safety,
            reviews.body,
            reviews.reply,
            reviews.repliedAt,
            reviews.createdAt,
          )
          .orderBy(...orderBy)
          .limit(input.limit),
        db
          .select({ rating: reviews.rating, count: sql<string>`count(*)` })
          .from(reviews)
          .where(publishedForTour)
          .groupBy(reviews.rating),
        db
          .select({
            guide: sql<string | null>`avg(${reviews.guide})`,
            value: sql<string | null>`avg(${reviews.value})`,
            punctuality: sql<string | null>`avg(${reviews.punctuality})`,
            safety: sql<string | null>`avg(${reviews.safety})`,
          })
          .from(reviews)
          .where(publishedForTour),
        readTrustSettings(),
      ]);

      const countByStar = new Map<number, number>();
      for (const row of breakdownRows) countByStar.set(row.rating, Number(row.count));

      const breakdown: ReviewStarCount[] = REVIEW_STAR_VALUES.map((stars) => ({
        stars,
        count: countByStar.get(stars) ?? 0,
      }));

      let total = 0;
      let starSum = 0;
      for (const { stars, count } of breakdown) {
        total += count;
        starSum += stars * count;
      }

      const subscores: ReviewSubscoreAverages = {
        guide: averageOrNull(subscoreRow?.guide ?? null),
        value: averageOrNull(subscoreRow?.value ?? null),
        punctuality: averageOrNull(subscoreRow?.punctuality ?? null),
        safety: averageOrNull(subscoreRow?.safety ?? null),
      };

      const items: TourReviewItem[] = rows.map((row) => ({
        id: row.id,
        name: row.name,
        rating: row.rating,
        guide: row.guide,
        value: row.value,
        punctuality: row.punctuality,
        safety: row.safety,
        body: row.body,
        // §4's badge. `booking_id` itself stays off the wire — see
        // `TourReviewItem.verified` for why presence alone is sufficient.
        verified: row.bookingId !== null,
        reply: row.reply,
        repliedAt: row.repliedAt === null ? null : row.repliedAt.toISOString(),
        createdAt: row.createdAt.toISOString(),
        // mysql2 returns COUNT() as a string.
        helpfulCount: Number(row.helpfulCount),
      }));

      return {
        tourId: tour.id,
        rating: applyRatingThreshold(
          total === 0 ? null : { average: starSum / total, count: total },
          trust.minReviewsForRating,
        ),
        breakdown,
        subscores,
        total,
        matching: input.starFilter === undefined ? total : (countByStar.get(input.starFilter) ?? 0),
        items,
      };
    }),

  /**
   * §4's "Was this helpful?" — **one vote per browser, arbitrated by the
   * composite primary key**.
   *
   * ## The duplicate is a shrug, not an error
   *
   * `review_helpful_votes`'s primary key is `(review_id, voter_hash)`, so a
   * second vote from the same browser is refused by the key itself rather than
   * by a read-then-write check that two concurrent clicks could both pass.
   * `counted: false` is the honest answer: nothing changed, and nothing went
   * wrong either — telling a reader their second tap was an error would be a
   * worse page than telling them it did nothing. The same shape as
   * `checkInStop`'s `already_checked_in`.
   *
   * ## What a voter is
   *
   * A hash of an anonymous `rg_vid` cookie plus the IP, never the IP itself
   * (RA 10173) — see `services/reviews/votes.ts`, which also explains why the
   * per-IP rate limiter in `app.ts` is the other half of §4's rule rather than
   * an optional extra.
   *
   * ## Only a published review can be voted on
   *
   * A pending or hidden review answers the SAME `NOT_FOUND` an id that was
   * never issued gets. A distinguishable refusal would make a numeric id an
   * oracle for what is sitting in the moderation queue, and voting on a review
   * nobody can read is meaningless anyway.
   *
   * No audit row: §12's list is payments, refunds, status changes and
   * assignments, and a row per anonymous click would bury the log an admin
   * reads.
   */
  voteHelpful: publicProcedure.input(reviewHelpfulInput).mutation(async ({ input, ctx }) => {
    const db = getDb();
    const [review] = await db
      .select({ id: reviews.id })
      .from(reviews)
      .where(and(eq(reviews.id, input.reviewId), eq(reviews.status, 'published')))
      .limit(1);
    if (!review) {
      throw new TRPCError({ code: 'NOT_FOUND', message: 'No published review with that id.' });
    }

    const voterHash = voterHashForRequest(ctx.req, ctx.res);
    try {
      await db.insert(reviewHelpfulVotes).values({ reviewId: review.id, voterHash });
      return { ok: true as const, counted: true };
    } catch (error) {
      if (isDuplicateKeyError(error)) return { ok: true as const, counted: false };
      throw error;
    }
  }),
});
