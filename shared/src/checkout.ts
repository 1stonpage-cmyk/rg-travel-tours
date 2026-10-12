/**
 * Shared checkout schemas (plan week 3, Task 1).
 *
 * Everything the browser may send during checkout is validated here, and
 * **nothing the browser sends is money** (CLAUDE.md): a quote request names
 * a tour, a date, a head count, add-on ids and an optional coupon code, and
 * never a price. `.strict()` on every object is load-bearing — an unknown
 * key (e.g. a client-supplied `totalCentavos`) is a rejection, not a
 * silently dropped field.
 *
 * `quoteResultSchema` is defined in Task 2 alongside the pricing service
 * that produces it, not here.
 */
import { z } from 'zod';
import { PAY_MODES } from './booking';

/** A civil date in Asia/Manila — the tour day, not an instant. */
const civilDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected a YYYY-MM-DD date');

/**
 * A Philippine mobile number, in any of the forms a guest might type it.
 *
 * Owner decision 2026-10-12 (plan Q10, resolved): accepts `09XXXXXXXXX`
 * (11 digits) and `+639XXXXXXXXX`, with spaces or dashes stripped first —
 * the seed data's own numbers are formatted `0908 469 6246`, and a guest who
 * types their number the way they read it must not be rejected for it.
 * `.transform()` normalises every accepted form to `+639XXXXXXXXX`, which is
 * the stored form, so the schema's output is already canonical.
 *
 * Exported and reused by both checkout (`createHoldInput`) and booking
 * lookup, so the two cannot drift on what counts as a valid PH mobile
 * number.
 */
export const phPhoneSchema = z
  .string()
  .transform((value) => value.replace(/[\s-]/g, ''))
  .pipe(z.string().regex(/^(09\d{9}|\+639\d{9})$/, 'Expected a PH mobile number'))
  .transform((value) => (value.startsWith('+') ? value : `+63${value.slice(1)}`));

/**
 * What the browser may ask for. `.strict()` is load-bearing: the server
 * computes all money (CLAUDE.md), so a request carrying `totalCentavos` is a
 * bug or an attack, and either way it must be refused rather than ignored.
 */
export const quoteInput = z
  .object({
    tourSlug: z.string().min(1).max(160),
    date: civilDate,
    pax: z.number().int().min(1).max(12),
    addonIds: z.array(z.number().int().positive()).max(20).default([]),
    couponCode: z.string().min(1).max(40).optional(),
  })
  .strict();
export type QuoteInput = z.infer<typeof quoteInput>;

export const createHoldInput = quoteInput
  .extend({
    payMode: z.enum(PAY_MODES),
    /**
     * Owner decision Q3: the short-lived server-side quote id (a truncated
     * SHA-256 digest, produced in Task 2) that the client echoes back here
     * so a price cannot be replayed after an admin edits a price tier.
     */
    quoteId: z.string().regex(/^[0-9a-f]{32}$/, 'Expected a 32-character lowercase hex quote id'),
    lead: z
      .object({
        name: z.string().min(1).max(160),
        email: z.email().max(200),
        phone: phPhoneSchema,
      })
      .strict(),
    pickup: z.string().max(400).optional(),
    pickupMapUrl: z.url().max(500).optional(),
    requests: z.string().max(2000).optional(),
    /** RA 10173. Anything but `true` fails here, before the router runs. */
    consent: z.boolean().refine((v) => v === true, { message: 'Consent is required' }),
  })
  .strict();
export type CreateHoldInput = z.infer<typeof createHoldInput>;

export const bookingLookupInput = z
  .object({ ref: z.string().min(1).max(12), email: z.email().max(200) })
  .strict();
