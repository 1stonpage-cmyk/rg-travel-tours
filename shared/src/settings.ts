/**
 * The seventeen `settings` keys, and the shape `admin.settings.write` accepts
 * (Week 7 plan, Task 9; BUILD_SPEC §9 "Users, settings").
 *
 * **Why the key list lives here as well as in the server.** The per-block Zod
 * schemas are `SETTING_SCHEMAS` in `server/src/content/settings-schema.ts` and
 * they stay there: they are the server's own validation boundary, several of
 * them carry cross-field refinements about Manila business policy, and the
 * client has no business parsing a stored block. But the admin editing screen
 * needs a runtime list of the keys in order to draw a section per block, and
 * the tRPC input needs an enum in order to refuse an unknown key before a
 * resolver runs. Both of those are a list of NAMES, not of shapes — so the
 * names are here and the shapes are not.
 *
 * The duplication is pinned rather than trusted:
 * `server/src/__tests__/admin-settings.test.ts` asserts this list and
 * `SETTING_KEYS` from `settings-schema.ts` are the same seventeen. A key added
 * to one side and not the other fails that test instead of becoming an editing
 * screen for a key nothing validates, or a validated block with no way to edit
 * it.
 *
 * **Nothing here validates a block's VALUE.** `value` is deliberately
 * `z.unknown()`: the one validator is `SETTING_SCHEMAS[key]`, called by
 * `writeSettingBlock()`. A second, weaker schema at this boundary is exactly
 * how a block gets written in a shape `readSettings()` then throws on — and
 * `readSettings()` throwing takes every public page down with it (BUG-023).
 */
import { z } from 'zod';

/**
 * One row of the `settings` table per entry, in the order the admin screen
 * reads most naturally rather than alphabetically.
 */
export const SETTING_KEYS = [
  'content_unverified',
  'site_seo',
  'trust',
  'hero',
  'announcement',
  'promo',
  'business_hours',
  'payment_methods',
  'permits',
  'how_it_works',
  'why_book_direct',
  'faqs',
  'contact',
  'booking',
  'payment_qr',
  'legal_privacy',
  'legal_terms',
] as const;

export const settingKeySchema = z.enum(SETTING_KEYS);

export type SettingKey = (typeof SETTING_KEYS)[number];

/**
 * What `admin.settings.write` takes.
 *
 * `.strict()`, so a third field cannot be smuggled past a resolver that reads
 * only two. `value` is `z.unknown()` and therefore OPTIONAL in Zod's inferred
 * input — which is harmless here and deliberately not patched around: every
 * one of the seventeen block schemas refuses `undefined`, so a `write` with no
 * `value` at all is a `BAD_REQUEST` from the real validator rather than a row
 * quietly set to null.
 */
export const settingWriteInput = z
  .object({
    key: settingKeySchema,
    value: z.unknown(),
  })
  .strict();

export type SettingWriteInput = z.infer<typeof settingWriteInput>;
