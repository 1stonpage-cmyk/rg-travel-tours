/**
 * Zod input schemas for the public tRPC read queries (Task 1.6). Shared
 * between client and server so the client's call sites get the same
 * validation shape as the server enforces.
 *
 * Task 1.7 adds the mutation inputs (`inquiries.create`,
 * `newsletter.subscribe`) to this same module.
 */
import { z } from 'zod';

export const toursListInput = z.object({
  /** Destination slug. Omit to list every active tour. */
  destination: z.string().min(1).optional(),
});

export const toursBySlugInput = z.object({
  slug: z.string().min(1),
});

export const reviewsPublishedInput = z.object({
  /** Default 6, max 50 — a review list is never an unbounded feed. */
  limit: z.number().int().min(1).max(50).default(6),
  tourId: z.number().int().positive().optional(),
});

export type ToursListInput = z.infer<typeof toursListInput>;
export type ToursBySlugInput = z.infer<typeof toursBySlugInput>;
export type ReviewsPublishedInput = z.infer<typeof reviewsPublishedInput>;
