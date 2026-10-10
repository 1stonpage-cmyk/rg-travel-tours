/**
 * Typed reader for the `settings` table.
 *
 * `readSettings()` fails loudly — never silently defaults — when a key is
 * missing or its stored JSON doesn't match its schema. A missing setting
 * means the seed (Task 1.4) didn't run or ran wrong; substituting a default
 * would put invented content on a live marketing page, which this project
 * forbids. Errors name the key, never the value.
 */
import { eq } from 'drizzle-orm';
import { getDb } from '../db/client';
import { settings } from '../db/schema';
import { resolveOpenState, type OpenState } from '../services/hours';
import { isWithinWindow } from '../services/schedule';
import {
  SETTING_KEYS,
  SETTING_SCHEMAS,
  type SettingKey,
  type SettingsBlocks,
} from './settings-schema';

/** All rows, unvalidated — key -> whatever JSON is stored. */
export async function readRawSettings(): Promise<Record<string, unknown>> {
  const db = getDb();
  const rows = await db.select().from(settings);
  const raw: Record<string, unknown> = {};
  for (const row of rows) {
    raw[row.key] = row.value;
  }
  return raw;
}

/**
 * Every settings key, parsed through its schema. Throws naming the key if
 * it is missing from the table or its value fails validation.
 */
export async function readSettings(): Promise<SettingsBlocks> {
  const raw = await readRawSettings();
  const blocks: Record<string, unknown> = {};

  for (const key of SETTING_KEYS) {
    if (!(key in raw)) {
      throw new Error(`Missing setting: "${key}"`);
    }

    const result = SETTING_SCHEMAS[key].safeParse(raw[key]);
    if (!result.success) {
      throw new Error(`Invalid setting: "${key}"`);
    }

    blocks[key] = result.data;
  }

  return blocks as SettingsBlocks;
}

/**
 * ONE settings block, in one round trip — for callers that need a single key
 * and must not take on a dependency on every other settings key being valid
 * (readSettings() throws on the first bad key, whichever block it's in).
 * Throws naming the requested key under the same two conditions
 * readSettings() would, and names only the key, never the stored value.
 */
export async function readSettingBlock<K extends SettingKey>(key: K): Promise<SettingsBlocks[K]> {
  const db = getDb();
  const [row] = await db.select().from(settings).where(eq(settings.key, key));
  if (!row) {
    throw new Error(`Missing setting: "${key}"`);
  }

  const result = SETTING_SCHEMAS[key].safeParse(row.value);
  if (!result.success) {
    throw new Error(`Invalid setting: "${key}"`);
  }

  return result.data as SettingsBlocks[K];
}

/**
 * Just the `trust` block — for callers like `tours.list`/`tours.bySlug`
 * (Task 1.9, R1) that need only `minReviewsForRating`. Kept as a named
 * function because three call sites read better for it; the single-key read
 * itself lives in `readSettingBlock` above.
 */
export async function readTrustSettings(): Promise<SettingsBlocks['trust']> {
  return readSettingBlock('trust');
}

// ---------------------------------------------------------------------------
// SettingsPayload — the RESOLVED shape `settings.get` sends to the browser
// (Task 1.6, ruling 3). `SettingsBlocks` above is the raw, Zod-parsed row
// data; this collapses the date-window and business-hours logic server-side
// so the client never evaluates a schedule itself — a browser clock in the
// wrong timezone must never show a Manila promo at the wrong moment.
// ---------------------------------------------------------------------------

export interface ResolvedAnnouncement {
  message: string;
  href: string | null;
  style: 'info' | 'warning';
}

export interface ResolvedPromo {
  code: string;
  discountLabel: string;
  headline: string;
  body: string;
}

export interface ResolvedPaymentMethod {
  key: string;
  label: string;
}

export interface SettingsPayload {
  contentUnverified: SettingsBlocks['content_unverified'];
  siteSeo: SettingsBlocks['site_seo'];
  trust: SettingsBlocks['trust'];
  hero: SettingsBlocks['hero'];
  /** null when inactive or outside its Asia/Manila window — schedule fields never reach the client. */
  announcement: ResolvedAnnouncement | null;
  /** null when inactive or outside its window. */
  promo: ResolvedPromo | null;
  openState: OpenState;
  /** Enabled only, sorted by sortOrder. The `enabled` flag itself never reaches the client. */
  paymentMethods: ResolvedPaymentMethod[];
  permits: SettingsBlocks['permits'];
  howItWorks: SettingsBlocks['how_it_works'];
  whyBookDirect: SettingsBlocks['why_book_direct'];
  faqs: SettingsBlocks['faqs'];
  contact: SettingsBlocks['contact'];
  legal: {
    privacy: SettingsBlocks['legal_privacy'];
    terms: SettingsBlocks['legal_terms'];
  };
}

function resolveAnnouncement(
  block: SettingsBlocks['announcement'],
  now: Date,
): ResolvedAnnouncement | null {
  if (!block.isActive || !isWithinWindow(block.startsAt, block.endsAt, now)) return null;
  return { message: block.message, href: block.href, style: block.style };
}

function resolvePromo(block: SettingsBlocks['promo'], now: Date): ResolvedPromo | null {
  if (!block.isActive || !isWithinWindow(block.startsAt, block.endsAt, now)) return null;
  return {
    code: block.code,
    discountLabel: block.discountLabel,
    headline: block.headline,
    body: block.body,
  };
}

function resolvePaymentMethods(block: SettingsBlocks['payment_methods']): ResolvedPaymentMethod[] {
  return block
    .filter((method) => method.enabled)
    .sort((a, b) => a.sortOrder - b.sortOrder)
    .map((method) => ({ key: method.key, label: method.label }));
}

/** Pure — takes already-parsed blocks plus the instant to resolve schedules against, so it's testable with no DB and no real clock. */
export function toSettingsPayload(blocks: SettingsBlocks, now: Date): SettingsPayload {
  return {
    contentUnverified: blocks.content_unverified,
    siteSeo: blocks.site_seo,
    trust: blocks.trust,
    hero: blocks.hero,
    announcement: resolveAnnouncement(blocks.announcement, now),
    promo: resolvePromo(blocks.promo, now),
    openState: resolveOpenState(blocks.business_hours, now),
    paymentMethods: resolvePaymentMethods(blocks.payment_methods),
    permits: blocks.permits,
    howItWorks: blocks.how_it_works,
    whyBookDirect: blocks.why_book_direct,
    faqs: blocks.faqs,
    contact: blocks.contact,
    legal: { privacy: blocks.legal_privacy, terms: blocks.legal_terms },
  };
}

/** `readSettings()` + `toSettingsPayload()` against the current instant — what `settings.get` calls. */
export async function getSettingsPayload(now: Date = new Date()): Promise<SettingsPayload> {
  return toSettingsPayload(await readSettings(), now);
}
