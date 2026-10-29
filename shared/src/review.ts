/**
 * The guest review a completed booking may leave (BUILD_SPEC §7, Week 4
 * Task 10).
 *
 * Shared because the form builds itself from these bounds and the server
 * enforces them: one list of sub-scores, one length limit, one set of
 * rules. A client that allowed a 2,000-character review the server would
 * refuse is a form that loses a guest's writing.
 */
import { z } from 'zod';

/**
 * §7's "sub-scores". Each is **optional**: a guest who only wants to leave
 * stars and a sentence should not be made to rate four separate things,
 * and a form that demands them gets fewer reviews, not better ones.
 */
export const REVIEW_SUBSCORES = ['guide', 'value', 'punctuality', 'safety'] as const;
export type ReviewSubscore = (typeof REVIEW_SUBSCORES)[number];

/** The labels a guest reads, so the form and any admin view agree. */
export const REVIEW_SUBSCORE_LABELS: Record<ReviewSubscore, string> = {
  guide: 'Driver and guide',
  value: 'Value for money',
  punctuality: 'On time',
  safety: 'Safety',
};

/** One to five, whole stars. The column is a `tinyint`. */
const starScore = z.number().int().min(1).max(5);

export const REVIEW_BODY_MIN = 10;
export const REVIEW_BODY_MAX = 2000;

/**
 * What a guest submits. **No `bookingId`, no `tourId`, no `name`, and no
 * `status`** — every one of those is the server's to fill in from the
 * session and the booking (`portal.submitReview`).
 *
 * That is not tidiness. A `status` field would let a browser publish
 * straight to the site; a `bookingId` would be an IDOR; a `name` would let
 * a guest sign someone else's review. The input carries only what a guest
 * could legitimately know: their own opinion.
 */
export const submitReviewInput = z
  .object({
    rating: starScore,
    body: z
      .string()
      .trim()
      .min(REVIEW_BODY_MIN, 'Please say a little more — a sentence or two is plenty.')
      .max(REVIEW_BODY_MAX),
    guide: starScore.optional(),
    value: starScore.optional(),
    punctuality: starScore.optional(),
    safety: starScore.optional(),
  })
  .strict();

export type SubmitReviewInput = z.infer<typeof submitReviewInput>;

// ---------------------------------------------------------------------------
// The public reviews block for one tour (Week 7 plan, Task 10; §4 "Reviews").
// ---------------------------------------------------------------------------

/**
 * The star rows of §4's breakdown, **five down to one** — the order the
 * block renders them in, written once so the server and the screen cannot
 * disagree about which end is which.
 */
export const REVIEW_STAR_VALUES = [5, 4, 3, 2, 1] as const;

/**
 * §4's three orderings. `helpful` sorts by the `review_helpful_votes` count,
 * which is why the public query reads that table rather than a cached column
 * — there is none, and a cached count would drift the first time a row was
 * removed.
 */
export const REVIEW_SORTS = ['newest', 'highest', 'helpful'] as const;
export type ReviewSort = (typeof REVIEW_SORTS)[number];

/**
 * A review list is never an unbounded feed — the same rule
 * `reviewsPublishedInput` already follows. The breakdown and the aggregate
 * are computed over EVERY published review of the tour regardless of this
 * limit, so narrowing the page never changes the headline numbers.
 */
export const TOUR_REVIEWS_DEFAULT_LIMIT = 20;
export const TOUR_REVIEWS_MAX_LIMIT = 100;

export const tourReviewsInput = z
  .object({
    /** The tour's public slug. Resolved to an id server-side, like `tours.bySlug`. */
    tourSlug: z.string().min(1),
    /** Show only this many stars. Omitted means every star. */
    starFilter: z.number().int().min(1).max(5).optional(),
    sort: z.enum(REVIEW_SORTS).default('newest'),
    limit: z.number().int().min(1).max(TOUR_REVIEWS_MAX_LIMIT).default(TOUR_REVIEWS_DEFAULT_LIMIT),
  })
  .strict();

export type TourReviewsInput = z.infer<typeof tourReviewsInput>;

/**
 * One published review as the public block renders it.
 *
 * **There is no `bookingId` here, and that is the point.** The booking a
 * review came from is what makes it verified, and it is also a guest's
 * booking — so the server answers the question (`verified`) and never ships
 * the identifier (RA 10173; the same reasoning that keeps a driver's
 * `locked_until` off the wire).
 */
export interface TourReviewItem {
  id: number;
  /** The booking's own lead name, as the submission copied it. Never browser-supplied. */
  name: string;
  rating: number;
  guide: number | null;
  value: number | null;
  punctuality: number | null;
  safety: number | null;
  body: string;
  /**
   * §4's "Verified booking" badge: true when this review came from a real
   * booking rather than being entered by hand.
   *
   * Computed from `reviews.booking_id IS NOT NULL` and nothing else.
   * `portal.submitReview` only sets that column for a booking that was
   * `completed` at the time, and `completed` is terminal — the cancel path's
   * allow-list excludes it ("a trip that ran cannot be un-run") — so a
   * verified review cannot become unverified afterwards.
   */
  verified: boolean;
  /** The operator's public reply, or null. */
  reply: string | null;
  /** ISO instant, or null when there is no reply. The screen converts to Manila. */
  repliedAt: string | null;
  /** ISO instant. */
  createdAt: string;
  /** Rows in `review_helpful_votes` for this review. */
  helpfulCount: number;
}

/** One row of §4's 5–1★ breakdown. */
export interface ReviewStarCount {
  stars: number;
  count: number;
}

/** The four optional sub-scores, averaged — null where nobody rated one. */
export interface ReviewSubscoreAverages {
  guide: number | null;
  value: number | null;
  punctuality: number | null;
  safety: number | null;
}

export interface TourReviewsResult {
  tourId: number;
  /**
   * The displayed aggregate, **behind `settings.trust.minReviewsForRating`**
   * — null below the threshold, so the block shows words rather than a
   * number nobody should read as a measurement. Never a zero.
   */
  rating: { average: number; count: number } | null;
  /** Five rows, 5★ down to 1★, over every published review of the tour. */
  breakdown: ReviewStarCount[];
  subscores: ReviewSubscoreAverages;
  /** Every published review of the tour, ignoring `starFilter` and `limit`. */
  total: number;
  /** How many match `starFilter` — `total` when no filter was given. */
  matching: number;
  items: TourReviewItem[];
}

// ---------------------------------------------------------------------------
// Helpful votes (§4: "one per browser via cookie + IP rate limit").
// ---------------------------------------------------------------------------

export const reviewHelpfulInput = z.object({ reviewId: z.number().int().positive() }).strict();
export type ReviewHelpfulInput = z.infer<typeof reviewHelpfulInput>;

// ---------------------------------------------------------------------------
// Moderation (§9 "Reviews moderation" — owner and dispatcher).
// ---------------------------------------------------------------------------

/**
 * The two statuses moderation may SET.
 *
 * `pending` is deliberately absent: it is where a submission lands, not a
 * decision an admin makes. A moderator publishes or hides, and both
 * directions are reversible — what is not offered is putting a decided
 * review back into the queue as though nobody had looked at it.
 */
export const REVIEW_MODERATION_STATUSES = ['published', 'hidden'] as const;
export type ReviewModerationStatus = (typeof REVIEW_MODERATION_STATUSES)[number];

export const reviewStatusInput = z
  .object({
    id: z.number().int().positive(),
    status: z.enum(REVIEW_MODERATION_STATUSES),
  })
  .strict();
export type ReviewStatusInput = z.infer<typeof reviewStatusInput>;

/** A reply is a short public sentence, not an essay — and never empty. */
export const REVIEW_REPLY_MAX = 1000;

export const reviewReplyInput = z
  .object({
    id: z.number().int().positive(),
    reply: z.string().trim().min(1).max(REVIEW_REPLY_MAX),
  })
  .strict();
export type ReviewReplyInput = z.infer<typeof reviewReplyInput>;

/**
 * One review on the moderation screen.
 *
 * It carries `bookingRef` where the public row carries only `verified`: a
 * moderator deciding whether a review is genuine needs to be able to find
 * the booking, and §9 gives this screen to owner and dispatcher only. The
 * guest's email and phone are still not here — the ref is enough to look
 * the booking up on the screen that is allowed to show them.
 */
export interface ReviewModerationRow {
  id: number;
  status: 'pending' | 'published' | 'hidden';
  name: string;
  rating: number;
  guide: number | null;
  value: number | null;
  punctuality: number | null;
  safety: number | null;
  body: string;
  reply: string | null;
  repliedAt: string | null;
  createdAt: string;
  /** Seeded placeholder content. Blocks a production build while published. */
  isSample: boolean;
  /** Same derivation as the public row's: `booking_id IS NOT NULL`. */
  verified: boolean;
  tourId: number | null;
  tourTitle: string | null;
  /** The public booking ref, or null for a review with no booking behind it. */
  bookingRef: string | null;
}
