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

export const inquiryInput = z.object({
  type: z.enum(['contact', 'package']),
  packageId: z.number().int().positive().optional(),
  name: z.string().min(1).max(160),
  email: z.email(),
  phone: z.string().max(40).optional(),
  message: z.string().min(1).max(5000),
  /**
   * RA 10173 (Data Privacy Act) consent checkbox. A `false` or missing
   * value fails validation here, before the router ever runs, so a
   * non-consenting submission is never stored.
   *
   * Typed `z.boolean().refine(...)` rather than `z.literal(true)`: both
   * reject everything except `true` at runtime, but `z.literal(true)`
   * infers the TS type `true`, which the brief's own test file (task
   * 1.7's "rejects a missing consent checkbox" case passes a plain
   * `consent: false`) cannot satisfy statically — `false` isn't
   * assignable to `true`. `z.boolean()` infers `boolean`, so the same
   * runtime rejection holds without a compile error on that test.
   */
  consent: z.boolean().refine((value) => value === true, {
    message: 'Consent is required',
  }),
});

export const newsletterInput = z.object({
  email: z.email(),
});

export type ToursListInput = z.infer<typeof toursListInput>;
export type ToursBySlugInput = z.infer<typeof toursBySlugInput>;
export type ReviewsPublishedInput = z.infer<typeof reviewsPublishedInput>;
export type InquiryInput = z.infer<typeof inquiryInput>;
export type NewsletterInput = z.infer<typeof newsletterInput>;
