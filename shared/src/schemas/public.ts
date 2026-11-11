/**
 * Zod input schemas for the public tRPC read queries (Task 1.6). Shared
 * between client and server so the client's call sites get the same
 * validation shape as the server enforces.
 *
 * Task 1.7 adds the mutation inputs (`inquiries.create`,
 * `newsletter.subscribe`) to this same module.
 */
import { z } from 'zod';
import { INQUIRY_TYPES } from '../packages-admin';

export const toursListInput = z.object({
  /** Destination slug. Omit to list every active tour. */
  destination: z.string().min(1).optional(),
});

export const toursBySlugInput = z.object({
  slug: z.string().min(1),
});

export const packagesBySlugInput = z.object({
  slug: z.string().min(1),
});

export const reviewsPublishedInput = z.object({
  /** Default 6, max 50 — a review list is never an unbounded feed. */
  limit: z.number().int().min(1).max(50).default(6),
  tourId: z.number().int().positive().optional(),
});

export const inquiryInput = z.object({
  // Reads `INQUIRY_TYPES` rather than repeating the literal — a second,
  // hand-copied enum is exactly how this list drifts from the admin side's.
  type: z.enum(INQUIRY_TYPES),
  packageId: z.number().int().positive().optional(),
  /**
   * The `transfer_custom` fields (transfers-launch plan §6, task T17).
   * Optional here the same way `packageId` above is optional for every type
   * that isn't `package` — the form decides which boxes it shows for which
   * type; this schema just gives each one a validated place to land.
   */
  requestedDate: z.iso.date().optional(),
  pax: z.number().int().positive().max(50).optional(),
  routeDescription: z.string().trim().min(1).max(300).optional(),
  name: z.string().min(1).max(160),
  // .max(200) matches the `varchar(200)` email column (round 1 review,
  // I4) — a format-valid but over-long address must fail Zod validation
  // here rather than the MySQL driver with ER_DATA_TOO_LONG.
  //
  // The message is spelled rather than left to zod's own "Invalid email
  // address" (task A4), so the sentence beside the field is project copy and
  // every surface that shows it says the same thing. The FORMAT RULE is
  // unchanged — this is the message only.
  email: z.email('Enter a valid email address.').max(200),
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
  /**
   * Cloudflare Turnstile (Task 13; widened by owner decision 2026-11-11,
   * Task 1A to `contact`+`transfer_custom`; widened again by owner decision
   * 2026-11-11, follow-up, to EVERY inquiry type including `package`).
   * `package` now has its own widget on both of its forms (PackagesSection
   * and PackageInquiryForm), so the gate is checked server-side for every
   * `input.type` with no exclusion left. Optional here rather than
   * required at the schema level because the check itself is feature-
   * flagged (`verifyTurnstile()` is a no-op, returning `true`, whenever
   * `TURNSTILE_ENABLED !== '1'`) — a required field would break every
   * submission whenever the feature is switched off.
   */
  turnstileToken: z.string().optional(),
});

export const newsletterInput = z.object({
  // .max(200) matches the `varchar(200)` email column (round 1 review, I4).
  // Custom message for the same reason `inquiryInput` above carries one.
  email: z.email('Enter a valid email address.').max(200),
});

export type ToursListInput = z.infer<typeof toursListInput>;
export type ToursBySlugInput = z.infer<typeof toursBySlugInput>;
export type PackagesBySlugInput = z.infer<typeof packagesBySlugInput>;
export type ReviewsPublishedInput = z.infer<typeof reviewsPublishedInput>;
export type InquiryInput = z.infer<typeof inquiryInput>;
export type NewsletterInput = z.infer<typeof newsletterInput>;
