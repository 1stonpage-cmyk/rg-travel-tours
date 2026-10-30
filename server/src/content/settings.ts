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
import { bookableDateRange, type BookableDateRange } from '@rg/shared';
import { getDb } from '../db/client';
import { settings } from '../db/schema';
import { resolveOpenState, type OpenState } from '../services/hours';
import { isPaymongoConfigured } from '../services/payments/paymongo';
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

// ---------------------------------------------------------------------------
// content_unverified — the site-wide indexing gate (task 4.3)
// ---------------------------------------------------------------------------

/**
 * How long a read of `content_unverified` is reused. Every page request and
 * every asset request under the SPA shell asks this question (see
 * middleware/robots-header.ts), and the answer changes roughly once in the
 * lifetime of the site — when an admin clears the flag. A minute's staleness
 * on "may Google index this" is harmless; a settings SELECT per asset request
 * is not.
 */
export const CONTENT_UNVERIFIED_TTL_MS = 60_000;

let unverifiedCache: { value: boolean; expiresAt: number } | null = null;

/** Drops the cached flag. For tests, and for anything that writes the setting. */
export function resetContentUnverifiedCache(): void {
  unverifiedCache = null;
}

/**
 * `settings.content_unverified`, cached, and FAILING CLOSED.
 *
 * While this is true the database still holds seed content — placeholder
 * tours, placeholder prices, `is_sample` reviews — and none of it may be
 * offered to a search engine. So an unreadable or invalid setting resolves to
 * `true`: if we cannot prove the content is real, we do not publish it for
 * indexing. The failure is NOT cached, so a transient database blip does not
 * pin the site to noindex for a whole TTL.
 *
 * Logs the error's `code` only — never the message, which can echo connection
 * details, and never DATABASE_URL (CLAUDE.md security rules).
 */
export async function readContentUnverified(now: number = Date.now()): Promise<boolean> {
  if (unverifiedCache && unverifiedCache.expiresAt > now) return unverifiedCache.value;

  try {
    const value = await readSettingBlock('content_unverified');
    unverifiedCache = { value, expiresAt: now + CONTENT_UNVERIFIED_TTL_MS };
    return value;
  } catch (error) {
    const code = (error as { code?: string }).code ?? 'unreadable';
    console.error(
      `[seo] settings.content_unverified could not be read (${code}); ` +
        'treating the site as unverified (noindex).',
    );
    return true;
  }
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
  /**
   * The bookable date window, **already resolved** against the Manila clock
   * — two civil dates, inclusive. The raw `booking` block (`minLeadDays`,
   * `nextDayCutoffTime`, `maxAdvanceDays`) never reaches the client, for the
   * same reason the announcement's schedule fields never do: a browser clock
   * in the wrong time zone must not evaluate a Manila rule. It is published
   * FOR a date picker to consume — bounding itself by string comparison,
   * computing nothing — and **its consumer exists**: the booking flow's own
   * date input, `client/src/components/home/HeroSection.tsx`, sets the `min`
   * and `max` of its `<input type="date">` from `bookingWindow.earliest` /
   * `.latest`. (This comment used to say no client code read it yet —
   * corrected 2026-10-13, final review F3. That is `bookingWindow`'s only
   * consumer, so a reader who believes there is none will delete the field
   * and un-bound that picker. The enquiry form's "preferred dates" input is
   * a different thing and is deliberately unbounded: an enquiry is not a
   * booking.)
   */
  bookingWindow: BookableDateRange;
  /**
   * Whether the manual QR transfer flow may be offered at all — and
   * **nothing else about it**.
   *
   * The account name, the number and the QR image are deliberately NOT in
   * this payload: it is the public settings query that every page calls, and
   * a guest's payment instructions are read through the session-gated
   * `portal.manualPayment` instead (owner decision 2026-10-14, Q5). What the
   * browser needs here is one boolean — whether to show the option — and
   * one boolean is what it gets.
   */
  manualTransferEnabled: boolean;
  /**
   * Whether the GATEWAY path may be offered at all — "is there a working
   * online payment to send this guest to", answered server-side (task A5).
   *
   * Two independent facts, and it takes BOTH: PayMongo has a secret key in
   * the server environment (`isPaymongoConfigured()`, the same check
   * `createCheckout` itself makes), **and** at least one `payment_methods`
   * entry is enabled (every entry in that block is a gateway method —
   * manual transfer is the separate `payment_qr` block above). Either half
   * missing means `checkout.startPayment` can only refuse, so the button
   * must not be on screen.
   *
   * It is the SIBLING of `manualTransferEnabled`, not a replacement: a
   * checkout reads both and picks one of three states (online, manual-only,
   * neither). Like that flag, it publishes a boolean and nothing else — no
   * key, no method list, no reason. A guest can act on none of those, and
   * "which half is misconfigured" is not a fact the public payload owes
   * anyone.
   */
  onlinePaymentEnabled: boolean;
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

/**
 * Enabled only, sorted by `sortOrder`. Exported because task 4.2's FAQPage
 * JSON-LD needs the same list the browser gets — its answers must match the
 * rendered page word for word, and that starts with the same methods in the
 * same order.
 */
export function resolvePaymentMethods(
  block: SettingsBlocks['payment_methods'],
): ResolvedPaymentMethod[] {
  return block
    .filter((method) => method.enabled)
    .sort((a, b) => a.sortOrder - b.sortOrder)
    .map((method) => ({ key: method.key, label: method.label }));
}

/**
 * Pure — takes already-parsed blocks plus the instant to resolve schedules
 * against, so it's testable with no DB and no real clock.
 *
 * `paymongoConfigured` is passed IN rather than read here (task A5) to keep
 * that promise: an `env` read inside this function would make the whole
 * payload depend on process state, and the gateway-off branch would then be
 * untestable without faking the environment. Deliberately has **no
 * default** — a caller that forgets it fails to compile, rather than
 * quietly publishing "online payment is on".
 */
export function toSettingsPayload(
  blocks: SettingsBlocks,
  now: Date,
  paymongoConfigured: boolean,
): SettingsPayload {
  const enabledPaymentMethods = resolvePaymentMethods(blocks.payment_methods);
  return {
    contentUnverified: blocks.content_unverified,
    siteSeo: blocks.site_seo,
    trust: blocks.trust,
    hero: blocks.hero,
    announcement: resolveAnnouncement(blocks.announcement, now),
    promo: resolvePromo(blocks.promo, now),
    openState: resolveOpenState(blocks.business_hours, now),
    paymentMethods: enabledPaymentMethods,
    permits: blocks.permits,
    howItWorks: blocks.how_it_works,
    whyBookDirect: blocks.why_book_direct,
    faqs: blocks.faqs,
    contact: blocks.contact,
    // Resolved here, beside `openState` and the announcement window, and for
    // the same reason: Manila-clock logic belongs on the server.
    bookingWindow: bookableDateRange(blocks.booking, now),
    // The flag only. See the field's own note on why the details are not here.
    manualTransferEnabled: blocks.payment_qr.isConfigured,
    /*
     * BOTH halves, and the enabled-only list is reused rather than
     * re-filtered — the question "is there an online method to offer" and
     * the list the browser is shown must be the same answer.
     */
    onlinePaymentEnabled: paymongoConfigured && enabledPaymentMethods.length > 0,
    legal: { privacy: blocks.legal_privacy, terms: blocks.legal_terms },
  };
}

/** `readSettings()` + `toSettingsPayload()` against the current instant — what `settings.get` calls. */
export async function getSettingsPayload(now: Date = new Date()): Promise<SettingsPayload> {
  // The only real caller, and so the one place the environment is consulted.
  return toSettingsPayload(await readSettings(), now, isPaymongoConfigured());
}
