/**
 * Zod schemas for every row of the `settings` table — one key per entry in
 * the "Settings keys" table of
 * docs/superpowers/plans/2026-10-09-dynamic-site-and-seo.md.
 *
 * These parse the RAW stored blocks. Schedule fields (`startsAt`, `endsAt`,
 * `isActive`) on `announcement` and `promo` are left untouched here — date-
 * window resolution (collapsing to display content or `null`) and the
 * `business_hours` → `openState` computation both happen later, in Task 1.5
 * / 1.6's `SettingsPayload` assembly. This module only validates shape.
 */
import { z } from 'zod';

/** `HH:MM`, 24-hour, zero-padded. `'7am'` must fail. */
const clockTime = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);

/** ISO-8601 UTC instant, or null when the schedule field is unset. */
const isoInstantOrNull = z.string().datetime().nullable();

/**
 * `z.string().min(1).nullable()` — an empty permit string is forbidden.
 * Missing/pending permits are `null`, which the UI renders as "— pending —".
 * Never invent an accreditation number.
 */
const permitField = z.string().min(1).nullable();

const siteSeoSchema = z.object({
  title: z.string(),
  description: z.string(),
  ogImage: z.string().nullable(),
});

const trustSchema = z.object({
  ratingAverage: z.number().nullable(),
  ratingCount: z.number().int().nullable(),
  guestsServed: z.number().int().nullable(),
  dotAccredited: z.boolean(),
  depositPercent: z.number().int(),
  /**
   * Task 1.9 (R1), client-supplied. A tour's displayed rating (stars +
   * count) is withheld below this many published reviews — sample or real,
   * the same population `displayAggregate()` counts — and a "New" badge
   * shows instead. Lives here, with its `ratingAverage`/`ratingCount`
   * siblings, rather than as a sixteenth settings key: this is social-proof
   * display policy, and `readSettings()` throws if any key is missing, so a
   * new key costs schema + seed + every fixture for no benefit.
   */
  minReviewsForRating: z.number().int().min(1),
});

const heroSchema = z.object({
  eyebrow: z.string(),
  headline: z.string(),
  subtitle: z.string(),
  ctaLabel: z.string(),
  imagePath: z.string(),
  imageAlt: z.string(),
});

/**
 * `style` is `z.enum(['info', 'warning'])` — there is no error/danger/red
 * style and never will be. This project forbids red anywhere in the UI;
 * this is where that rule is enforced in code.
 */
const announcementSchema = z.object({
  message: z.string(),
  href: z.string().nullable(),
  style: z.enum(['info', 'warning']),
  startsAt: isoInstantOrNull,
  endsAt: isoInstantOrNull,
  isActive: z.boolean(),
});

const promoSchema = z.object({
  code: z.string(),
  discountLabel: z.string(),
  headline: z.string(),
  body: z.string(),
  startsAt: isoInstantOrNull,
  endsAt: isoInstantOrNull,
  isActive: z.boolean(),
});

/** Weekday 0 = Sunday. Exactly 7 entries — not 6, not 8. */
const businessHourEntrySchema = z.object({
  weekday: z.number().int().min(0).max(6),
  opensAt: clockTime.nullable(),
  closesAt: clockTime.nullable(),
  isClosed: z.boolean(),
});

const businessHoursSchema = z.array(businessHourEntrySchema).length(7);

const paymentMethodSchema = z.object({
  key: z.string(),
  label: z.string(),
  enabled: z.boolean(),
  sortOrder: z.number().int(),
});

const permitsSchema = z.object({
  dot: permitField,
  dti: permitField,
  bir: permitField,
});

const howItWorksStepSchema = z.object({
  step: z.number().int(),
  title: z.string(),
  body: z.string(),
});

const whyBookDirectItemSchema = z.object({
  icon: z.string(),
  title: z.string(),
  body: z.string(),
});

const faqSchema = z.object({
  q: z.string(),
  a: z.string(),
});

const contactSchema = z.object({
  address: z.string(),
  tagline: z.string(),
  hoursNote: z.string(),
  email: z.string(),
  phoneDisplay: z.string(),
  phoneTel: z.string(),
  whatsapp: z.string(),
  altPhoneDisplay: z.string(),
  altPhoneTel: z.string(),
  facebook: z.string(),
  motto: z.string(),
  otherServices: z.object({
    before: z.string(),
    link: z.string(),
    after: z.string(),
  }),
});

/**
 * The bookable date window (owner decision 2026-10-13 — **proposed by
 * developer, not yet confirmed with R&G**). Settings, deliberately, not a
 * schema change: these are business policy the owner will tune, and
 * `tours` has no departure-time column to anchor a per-tour cutoff to.
 *
 * The shape mirrors `BookingWindowSettings` in @rg/shared, which
 * `bookableDateRange()` consumes — one definition of the window, used by the
 * date picker, the quote and `createHold()` alike.
 *
 * `maxAdvanceDays` below `minLeadDays` would leave NO bookable date at all,
 * which is a typo rather than a policy, so the refinement refuses it here
 * instead of letting the site quietly sell nothing. (`isDateBookable()` also
 * fails closed on such a window, so the two layers agree.)
 */
const bookingSchema = z
  .object({
    /** 0 = today is bookable; 1 = tomorrow is the earliest. */
    minLeadDays: z.number().int().min(0).max(30),
    /** Asia/Manila. At or after it, the earliest bookable date moves out one more day. */
    nextDayCutoffTime: clockTime,
    /** How far ahead a guest may book, in days from the Manila today. */
    maxAdvanceDays: z.number().int().min(1).max(730),
  })
  .refine((booking) => booking.maxAdvanceDays >= booking.minLeadDays, {
    message: 'maxAdvanceDays must not be below minLeadDays: no date would be bookable',
  });

/**
 * The R&G payment QR and the account it belongs to (BUILD_SPEC §6 step 1;
 * owner decision 2026-10-14, Q3).
 *
 * **Seeded EMPTY, with `isConfigured: false`, and nothing here is ever
 * invented.** The same rule the DOT/DTI permit numbers follow: a payment
 * instruction that is wrong by a digit sends a guest's money to a stranger,
 * so the seed ships nulls and the site renders an explicit pending state
 * until R&G supply the real values (see `docs/LAUNCH_CHECKLIST.md`).
 *
 * `isConfigured` is the switch the whole flow reads: while it is false the
 * manual-transfer option is **not offered at checkout at all**. It is
 * refused unless all four fields are actually filled, so an admin cannot
 * turn the flow on with nothing behind it — the flag states a fact rather
 * than asserting one.
 */
const paymentQrSchema = z
  .object({
    /**
     * A path under `/uploads`, served through the authenticated receipt-style
     * route — never a public URL, and never a data URI in a settings row.
     * Null until R&G send the image.
     */
    imagePath: z.string().max(300).nullable(),
    /** Exactly as it appears on the account. Null until R&G confirm it. */
    accountName: z.string().max(160).nullable(),
    /** The GCash number or bank account number, as text. Null until confirmed. */
    accountNumber: z.string().max(80).nullable(),
    /** Anything R&G want said beside it, e.g. which bank branch. */
    instructions: z.string().max(600).nullable(),
    /** True only when the four above are real. See the refinement. */
    isConfigured: z.boolean(),
  })
  .refine(
    (qr) =>
      !qr.isConfigured ||
      Boolean(qr.imagePath?.trim() && qr.accountName?.trim() && qr.accountNumber?.trim()),
    {
      message:
        'payment_qr.isConfigured cannot be true without imagePath, accountName and accountNumber',
    },
  );

/**
 * How transfers are OPERATED (owner answers 2026-10-31, answers 1 and 2, plus
 * the same day's driver-capacity addendum). Settings rather than schema for the
 * same reason the `booking` block above is: these are business policy the owner
 * tunes, not facts about a row.
 *
 * - `bufferMinutes` — the gap added after a transfer's estimated end before its
 *   vehicle (and its driver) is considered free again. **One buffer for both
 *   resources, deliberately** — the addendum says so in as many words, so there
 *   is no second driver buffer here and must not be one. Frozen onto each
 *   booking as `booking_transfer_details.buffer_minutes_used` at hold time, so
 *   changing it never reinterprets a booking already taken.
 * - `minNoticeHours` — minimum notice before pickup for a transfer, replacing
 *   tours' day-based window on the transfer path only. Enforced by T11, not
 *   here; the capacity math has no clock.
 * - `staffQuoteHoldHours` — how long a staff-quoted booking's hold lasts (T19),
 *   against the existing `hold_expires_at` column and `expire-holds` sweep.
 *   `min(1)`: a zero-hour hold would expire before the guest could be told.
 * - `maxTransferJobsPerDriverPerDay` — the DEFAULT daily transfer-job cap per
 *   driver, overridable per driver by `drivers.max_transfer_jobs_per_day`.
 *   `min(0)` and not `min(1)`: zero is a legitimate "no transfer jobs are sold
 *   at all" switch, and the pool math handles it (every driver contributes 0,
 *   so every transfer is refused `no_driver_available`).
 *
 * All four are whole non-negative numbers. Nothing here is money.
 */
export const transferOperationsSchema = z.object({
  bufferMinutes: z.number().int().min(0),
  minNoticeHours: z.number().int().min(0),
  staffQuoteHoldHours: z.number().int().min(1),
  maxTransferJobsPerDriverPerDay: z.number().int().min(0),
});

/**
 * Fallback values for `transfer_operations` when the row is missing, or
 * malformed, in the database — the owner's 2026-10-31 decision log values
 * (same ones `db/seed-data.ts` seeds), not invented numbers. Used ONLY by
 * the resilient readers in `content/settings.ts`; every other settings key
 * keeps the project's standing fail-loud contract unchanged.
 */
export const TRANSFER_OPERATIONS_DEFAULTS: z.infer<typeof transferOperationsSchema> = {
  bufferMinutes: 60,
  minNoticeHours: 6,
  staffQuoteHoldHours: 48,
  maxTransferJobsPerDriverPerDay: 2,
};

/**
 * The fallback for `show_tours` when its row is missing or malformed —
 * `false` (tours hidden), the conservative choice: a database that cannot
 * prove tours are meant to be visible should not show them. See
 * `content/settings.ts`'s `resolveShowTours()`, the one place this constant
 * is used. Unlike `transfer_operations`, `show_tours` has no partial shape
 * to merge (`z.boolean()`, not an object) — a malformed value is simply
 * replaced wholesale.
 */
export const SHOW_TOURS_DEFAULT = false;

const legalDocSchema = z.object({
  markdown: z.string(),
  updatedAt: z.string(),
});

/**
 * Sign-up coupon settings (sign-up coupons plan, Task 1B-i): the % off and
 * expiry window a newly-minted `WELCOME-XXXXXXXX` coupon is issued with.
 *
 * `discountPercent` is a WHOLE PERCENT (1..100), matching `trustSchema`'s
 * `depositPercent` convention above — deliberately NOT `coupons.percent_bp`'s
 * basis-point convention. The conversion to basis points
 * (`discountPercent * 100`) happens once, at the moment a code is minted
 * (`newsletter.subscribe`'s mint helper); this block is never re-read to
 * recompute a discount an already-issued code carries as its own snapshot.
 */
const signupCouponSchema = z.object({
  discountPercent: z.number().int().min(1).max(100),
  expiryDays: z.number().int().min(1).max(365),
});

export const SETTING_SCHEMAS = {
  content_unverified: z.boolean(),
  site_seo: siteSeoSchema,
  trust: trustSchema,
  hero: heroSchema,
  announcement: announcementSchema,
  promo: promoSchema,
  business_hours: businessHoursSchema,
  payment_methods: z.array(paymentMethodSchema),
  permits: permitsSchema,
  how_it_works: z.array(howItWorksStepSchema),
  why_book_direct: z.array(whyBookDirectItemSchema),
  faqs: z.array(faqSchema),
  contact: contactSchema,
  booking: bookingSchema,
  payment_qr: paymentQrSchema,
  show_tours: z.boolean(),
  transfer_operations: transferOperationsSchema,
  legal_privacy: legalDocSchema,
  legal_terms: legalDocSchema,
  signup_coupon: signupCouponSchema,
} satisfies Record<string, z.ZodType>;

export type SettingKey = keyof typeof SETTING_SCHEMAS;

/**
 * The raw, Zod-parsed settings — schedule fields (`startsAt`, `endsAt`,
 * `isActive`) on `announcement`/`promo` still present and untouched. This is
 * what `readSettings()` returns. Task 1.6 assembles the separate, resolved
 * `SettingsPayload` the browser receives from this.
 */
export type SettingsBlocks = {
  [K in SettingKey]: z.infer<(typeof SETTING_SCHEMAS)[K]>;
};

export const SETTING_KEYS = Object.keys(SETTING_SCHEMAS) as SettingKey[];
