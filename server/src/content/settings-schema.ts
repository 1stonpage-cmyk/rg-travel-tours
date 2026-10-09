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

const legalDocSchema = z.object({
  markdown: z.string(),
  updatedAt: z.string(),
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
  legal_privacy: legalDocSchema,
  legal_terms: legalDocSchema,
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
