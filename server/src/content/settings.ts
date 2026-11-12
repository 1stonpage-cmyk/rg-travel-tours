/**
 * Typed reader for the `settings` table.
 *
 * `readSettings()` fails loudly — never silently defaults — when a key is
 * missing or its stored JSON doesn't match its schema. A missing setting
 * means the seed (Task 1.4) didn't run or ran wrong; substituting a default
 * would put invented content on a live marketing page, which this project
 * forbids. Errors name the key, never the value.
 *
 * TWO narrow, explicitly-requested exceptions, and no more:
 *
 * 1. `transfer_operations` (pre-task 0A, 2026-11-03). It is operational
 *    configuration — buffer minutes, notice hours, a per-driver job cap — not
 *    guest-facing content, and it is read on EVERY tour quote and hold via
 *    `assessCapacity()`, not only transfer ones. A missing or malformed row
 *    there must not 500 every booking on the site, so
 *    `readTransferOperationsSettings()` / `readTransferOperationsSettingsTx()`
 *    fall back to `TRANSFER_OPERATIONS_DEFAULTS` instead of throwing.
 * 2. `show_tours` (transfers-launch plan, Task T15). It is a feature switch,
 *    not content, and it is read on every tour-related public request —
 *    `tours.list`/`bySlug`, the tour quote/hold path, the SEO resolver, the
 *    sitemap. More importantly it gates the SAME `SettingsPayload` that every
 *    single page's `settings.get` call reads, so a missing or malformed row
 *    here must not take the WHOLE SITE down the way a missing
 *    `content_unverified` or `transfer_operations` row theoretically could
 *    today: `readSettings()` therefore resolves this one key through
 *    `resolveShowTours()` rather than throwing on it (see the special case in
 *    the loop below). The fallback is `false` — tours hidden — because a
 *    database that cannot prove tours are meant to be visible must not show
 *    them.
 *
 * Do not extend this pattern to any other settings key without a new owner
 * decision.
 */
import { eq } from 'drizzle-orm';
import { bookableDateRange, type BookableDateRange } from '@rg/shared';
import { getDb, type Transaction } from '../db/client';
import { settings } from '../db/schema';
import { resolveOpenState, type OpenState } from '../services/hours';
import { isPaymongoConfigured } from '../services/payments/paymongo';
import { isWithinWindow } from '../services/schedule';
import {
  SETTING_KEYS,
  SETTING_SCHEMAS,
  SHOW_TOURS_DEFAULT,
  TRANSFER_OPERATIONS_DEFAULTS,
  transferOperationsSchema,
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
 *
 * ONE key is exempt: `show_tours` resolves through `resolveShowTours()`
 * instead (Task T15). This is load-bearing rather than cosmetic — this
 * function is what `getSettingsPayload()`, i.e. the public `settings.get`
 * every page calls, runs. Without the carve-out, the moment `show_tours`
 * joined `SETTING_SCHEMAS` every page on any database that has not re-run
 * `db:seed` would throw `Missing setting: "show_tours"`: a site-wide 500,
 * not merely a tours problem. Every other key keeps the fail-loud contract
 * this file's own top-of-file note describes, `transfer_operations`
 * included — its fallback lives in its own readers, not here.
 */
export async function readSettings(): Promise<SettingsBlocks> {
  const raw = await readRawSettings();
  const blocks: Record<string, unknown> = {};

  for (const key of SETTING_KEYS) {
    if (key === 'show_tours') {
      blocks[key] = resolveShowTours(raw[key]);
      continue;
    }
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
 * ONE settings block, read through the CALLER'S TRANSACTION.
 *
 * Not `readSettingBlock()` above: that one reads through `getDb()`, i.e. a
 * second pooled connection, which inside an open transaction is both a read
 * outside that transaction's locks and — as `df8b38d` had to fix — a second
 * connection taken while the first is held, which starves the pool under load.
 * Anything running inside a booking or capacity transaction reads through `tx`.
 *
 * It lives here rather than in `create-hold.ts`, where it was first written,
 * because `services/transfers/capacity.ts` needs the same read and a transfer
 * capacity check has no business importing from the tour hold-creation service.
 * Behaviour is unchanged from that original: same two failure conditions, same
 * messages, and it names only the KEY, never the stored value, which can
 * contain anything an admin typed.
 *
 * **Call it AFTER the locks.** A settings read is a plain `SELECT`, so taken
 * before `takeSlotLocks()`/`takeFleetDateLock()` it pins the REPEATABLE READ
 * snapshot and silently defeats every capacity count that follows — see THE
 * PRECONDITION in `services/capacity.ts`.
 */
export async function readSettingBlockTx<K extends SettingKey>(
  tx: Transaction,
  key: K,
): Promise<SettingsBlocks[K]> {
  const [row] = await tx
    .select({ value: settings.value })
    .from(settings)
    .where(eq(settings.key, key))
    .limit(1);
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

/**
 * `transfer_operations`, never throwing. Missing row -> full defaults.
 * Row present but some fields missing/invalid as a whole -> full defaults.
 * Row present with SOME valid fields and SOME missing fields -> the valid
 * fields are kept, the missing ones default (owner-requested fallback,
 * 2026-11-03 — see pre-task 0A). Every fallback path logs exactly one
 * console.warn naming which fields defaulted (or "row missing" / "row
 * invalid"), and never logs the raw stored value.
 *
 * This is a narrow, explicitly-requested carve-out for this ONE operational
 * block — `transfer_operations` is buffer minutes, notice hours, etc., not
 * guest-facing marketing content — and must not be generalised to any other
 * settings key. Every other key keeps the fail-loud contract this file's own
 * doc comment describes.
 */
function resolveTransferOperations(raw: unknown): SettingsBlocks['transfer_operations'] {
  if (raw === undefined) {
    console.warn('[settings] transfer_operations row is missing; using defaults.');
    return TRANSFER_OPERATIONS_DEFAULTS;
  }

  const full = transferOperationsSchema.safeParse(raw);
  if (full.success) return full.data;

  const partial = transferOperationsSchema.partial().safeParse(raw);
  if (partial.success) {
    const missing = (
      Object.keys(TRANSFER_OPERATIONS_DEFAULTS) as Array<keyof typeof TRANSFER_OPERATIONS_DEFAULTS>
    ).filter((key) => !(key in partial.data));
    if (missing.length > 0) {
      console.warn(
        `[settings] transfer_operations missing field(s) ${missing.join(', ')}; using defaults for those.`,
      );
    }
    return { ...TRANSFER_OPERATIONS_DEFAULTS, ...partial.data };
  }

  console.warn('[settings] transfer_operations value is invalid; using full defaults.');
  return TRANSFER_OPERATIONS_DEFAULTS;
}

/**
 * Just the `transfer_operations` block — the buffer, the minimum notice, the
 * staff-quote hold and the default per-driver transfer-job cap (transfers-launch
 * plan, Task T7). A named wrapper for the same reason `readTrustSettings` is
 * one: the call sites read better, and the single-key read itself is above.
 *
 * Unlike every other settings reader in this file, this one NEVER throws —
 * see `resolveTransferOperations`'s own note on why this key alone gets a
 * fallback. Plain pooled-connection read; anything inside an open transaction
 * wants `readTransferOperationsSettingsTx(tx)` instead.
 */
export async function readTransferOperationsSettings(): Promise<
  SettingsBlocks['transfer_operations']
> {
  const db = getDb();
  const [row] = await db.select().from(settings).where(eq(settings.key, 'transfer_operations'));
  return resolveTransferOperations(row?.value);
}

/**
 * `transfer_operations`, with the same fallback as `readTransferOperationsSettings`
 * above, read through the CALLER'S TRANSACTION — see `readSettingBlockTx`'s own
 * note on why a transaction-bound read matters for anything inside a capacity
 * or booking transaction.
 */
export async function readTransferOperationsSettingsTx(
  tx: Transaction,
): Promise<SettingsBlocks['transfer_operations']> {
  const [row] = await tx
    .select({ value: settings.value })
    .from(settings)
    .where(eq(settings.key, 'transfer_operations'));
  return resolveTransferOperations(row?.value);
}

/**
 * `show_tours`, never throwing. Missing row -> `SHOW_TOURS_DEFAULT` (false).
 * Row present but not a boolean -> the same default. A second, narrow
 * carve-out alongside `transfer_operations` above — see this file's own
 * top-of-file note on why. Logs exactly one console.warn naming which
 * case fired, never the raw stored value.
 */
function resolveShowTours(raw: unknown): boolean {
  if (raw === undefined) {
    console.warn('[settings] show_tours row is missing; using default (tours hidden).');
    return SHOW_TOURS_DEFAULT;
  }
  const result = SETTING_SCHEMAS.show_tours.safeParse(raw);
  if (result.success) return result.data;
  console.warn('[settings] show_tours value is invalid; using default (tours hidden).');
  return SHOW_TOURS_DEFAULT;
}

/**
 * Just the `show_tours` flag — for the five consultation points named in
 * the transfers-launch plan's Architecture §4 (`tours.list`/`bySlug`,
 * `checkout.quote`/`createHold`'s tour path, the SEO resolver, the
 * sitemap). Plain pooled-connection read; none of those call sites run
 * inside an existing transaction at the point they check this, so unlike
 * `transfer_operations` there is no `...Tx` variant.
 */
export async function readShowTours(): Promise<boolean> {
  const db = getDb();
  const [row] = await db.select().from(settings).where(eq(settings.key, 'show_tours'));
  return resolveShowTours(row?.value);
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
  /**
   * Whether tours may be shown/booked at all — the transfers-launch plan's
   * second visibility gate (Task T15), independent of `contentUnverified`.
   * `false` (hidden) is the built-in product default; an owner flips it on
   * through the admin settings screen once real tour content is ready to
   * sell alongside transfers. A missing or malformed row degrades to the
   * same default rather than failing the whole payload — see
   * `resolveShowTours()` in this file.
   */
  showTours: boolean;
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
  /**
   * The sign-up coupon's public face — percent only; the expiry day count is
   * email copy, not page copy, and stays server-side (sign-up coupons plan,
   * Task 1B-i). `PromoNewsletter.tsx` reads this to say "Sign up for N% off"
   * so the CTA tracks the live admin setting rather than a hardcoded number.
   * A required field, not optional: `signup_coupon` is seeded by `seedBase`
   * like every other settings row, so there is always a value to publish.
   */
  signupCoupon: {
    discountPercent: number;
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
    showTours: blocks.show_tours,
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
    signupCoupon: { discountPercent: blocks.signup_coupon.discountPercent },
  };
}

/** `readSettings()` + `toSettingsPayload()` against the current instant — what `settings.get` calls. */
export async function getSettingsPayload(now: Date = new Date()): Promise<SettingsPayload> {
  // The only real caller, and so the one place the environment is consulted.
  return toSettingsPayload(await readSettings(), now, isPaymongoConfigured());
}
