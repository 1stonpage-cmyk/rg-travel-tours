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
