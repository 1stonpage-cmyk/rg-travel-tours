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
import { BUILTIN_PERMITS } from '@rg/shared';

/** `HH:MM`, 24-hour, zero-padded. `'7am'` must fail. */
const clockTime = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);

/** ISO-8601 UTC instant, or null when the schedule field is unset. */
const isoInstantOrNull = z.string().datetime().nullable();

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

/**
 * Accreditation numbers, as an admin-managed LIST (owner decision 2026-11-26,
 * Task 1A — replacing the fixed three-field `{ dot, dti, bir }` block). Each
 * item has its own Show switch; the three builtins (DOT/DTI/BIR) can never
 * be deleted, only hidden — enforced below, not left as a UI courtesy.
 *
 * `BUILTIN_PERMITS` is imported from `@rg/shared` (not defined here) so the
 * client's admin editor and this schema can never drift on the canonical
 * labels — see that constant's own doc comment. Re-exported so `seed-data.ts`
 * keeps importing it from this module rather than from `@rg/shared` directly,
 * and `accreditationBlockSchema` refuses any save that drops, renames or
 * un-builtins one of them.
 */
export { BUILTIN_PERMITS };

const BUILTIN_PERMIT_KEYS: Set<string> = new Set(BUILTIN_PERMITS.map((b) => b.key));

/**
 * `number`, trimmed before length-checked — "store trimmed values, don't
 * rely on the client to trim." `null` passes straight through; a non-null
 * value that trims to zero length is refused (1-60 chars after trimming).
 */
const accreditationNumberSchema = z.preprocess(
  (value) => (typeof value === 'string' ? value.trim() : value),
  z.string().min(1).max(60).nullable(),
);

/**
 * `label`/`key`, trimmed before length-checked — the same "store trimmed
 * values, don't rely on the client to trim" rule `number` above follows.
 * Unlike `number`, neither is nullable here: trimming to empty must still
 * fail `min(1)`, because an all-whitespace label or key is not a valid one.
 * Trimming server-side (rather than trusting the admin screen's own trim)
 * is what keeps a direct tRPC call from storing — and the duplicate-label /
 * builtin-impersonation checks below from missing — a value that differs
 * from another item only by leading/trailing whitespace.
 */
const trimmedRequiredString = (max: number) =>
  z.preprocess(
    (value) => (typeof value === 'string' ? value.trim() : value),
    z.string().min(1).max(max),
  );

const accreditationItemSchema = z
  .object({
    key: trimmedRequiredString(100),
    label: trimmedRequiredString(60),
    number: accreditationNumberSchema,
    show: z.boolean(),
    builtin: z.boolean(),
  })
  .refine((item) => !item.show || item.number !== null, {
    message: 'An item must have a number before it can be shown.',
  });

/** Derived from the schema above, not hand-written, so the two can never drift. */
export type AccreditationItem = z.infer<typeof accreditationItemSchema>;

/**
 * Cross-item rules: exactly the three builtins (present, correctly labelled,
 * flagged `builtin: true`), no custom item impersonating one of them, unique
 * keys, unique labels. `z.array(...).max(10)` is the straightforward overall
 * cap (3 builtins + at most 7 custom).
 */
const accreditationBlockSchema = z
  .object({
    items: z.array(accreditationItemSchema).max(10, 'At most 10 accreditation items are allowed.'),
  })
  .superRefine((block, ctx) => {
    const items = block.items;

    for (const builtin of BUILTIN_PERMITS) {
      const match = items.find((item) => item.key === builtin.key);
      if (!match) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Missing builtin accreditation item "${builtin.key}".`,
        });
        continue;
      }
      if (!match.builtin) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `"${builtin.key}" must remain a builtin item (builtin: true).`,
        });
      }
      if (match.label !== builtin.label) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `"${builtin.key}" label must be "${builtin.label}".`,
        });
      }
    }

    for (const item of items) {
      if (BUILTIN_PERMIT_KEYS.has(item.key)) continue; // checked above
      if (item.builtin) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `"${item.key}" is not a builtin key and must not be flagged builtin.`,
        });
      }
    }

    const keyCounts = new Map<string, number>();
    for (const item of items) keyCounts.set(item.key, (keyCounts.get(item.key) ?? 0) + 1);
    for (const [key, count] of keyCounts) {
      if (count > 1) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Duplicate accreditation key "${key}".`,
        });
      }
    }

    const labelCounts = new Map<string, number>();
    for (const item of items) labelCounts.set(item.label, (labelCounts.get(item.label) ?? 0) + 1);
    for (const [label, count] of labelCounts) {
      if (count > 1) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Duplicate accreditation label "${label}".`,
        });
      }
    }
  });

/** Derived from the schema above, not hand-written, so the two can never drift. */
export type AccreditationBlock = z.infer<typeof accreditationBlockSchema>;

/**
 * The OLD schema (`z.string().min(1).nullable()`, no trim) allowed a
 * whitespace-only string through. The new `accreditationNumberSchema` trims
 * first and refuses an empty result, so a legacy row carrying `'   '` must be
 * normalized the SAME way here or it fails validation on every future read
 * (`readSettings()` throws naming the key, which takes the whole public site
 * down — BUG-023). A non-string legacy value (never producible by the old
 * schema, but not provably impossible from a hand-written `UPDATE`) is an
 * explicit, intentional `null` — the old schema would never have accepted it
 * either, so dropping it silently is reasonable; the `typeof` check is what
 * makes that branch deliberate rather than an accident of a looser ternary.
 */
const normalizeLegacyNumber = (raw: unknown): string | null =>
  typeof raw === 'string' && raw.trim() !== '' ? raw.trim() : null;

/**
 * Upgrades the OLD stored shape (`{ dot, dti, bir }`, each `string | null`)
 * into the new `{ items: [...] }` shape. Nothing was ever "shown" under the
 * old binary pending/number model — it rendered unconditionally — so an
 * upgraded item defaults to `show: false`: an owner reviews before
 * publishing. Exported so a legacy row can be upgraded wherever it's useful
 * to reason about (e.g. admin UI), not only inside this schema's own parse.
 */
export function upgradeLegacyPermits(value: Record<string, unknown>): AccreditationBlock {
  return {
    items: BUILTIN_PERMITS.map((builtin) => ({
      key: builtin.key,
      label: builtin.label,
      number: normalizeLegacyNumber(value[builtin.key]),
      show: false,
      builtin: true,
    })),
  };
}

/**
 * An object shaped like the OLD legacy block — detect and upgrade it before
 * the real validator ever runs, so both a freshly-submitted write and a
 * freshly-read legacy row flow through the SAME final validator (and its
 * refusal rules — including builtin-presence) rather than dodging them.
 *
 * Deliberately narrower than "any non-array object with no `items` key":
 * that used to also match `{}` or a typo'd key like `{ itemz: [] }`, both of
 * which would silently upgrade to three hidden, number-null builtins and
 * report the write as a success — the exact shape of the BUG-118 incident
 * (a write silently wiping real hand-entered configuration while claiming
 * success). An object is only treated as legacy when it actually carries at
 * least one of `dot`/`dti`/`bir` (even `null`) and no `items` key; anything
 * else — including `{}` and `{ itemz: [] }` — falls through to the real
 * validator and is refused outright.
 */
function isLegacyPermitsShape(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    !('items' in value) &&
    ('dot' in value || 'dti' in value || 'bir' in value)
  );
}

export const permitsSchema = z.preprocess(
  (value) => (isLegacyPermitsShape(value) ? upgradeLegacyPermits(value) : value),
  accreditationBlockSchema,
);

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
        'Add the QR image, account name and account number before turning on manual transfer.',
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
