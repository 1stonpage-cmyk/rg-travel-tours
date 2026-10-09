import { reviewsPublishedInput } from '@rg/shared';
import { and, desc, eq } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { reviews, tours } from '../../db/schema';
import { displayAggregate, realAggregate, type Aggregate } from '../../services/ratings';
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
});
