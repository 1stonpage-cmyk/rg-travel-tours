import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { getDb, getPool } from '../db/client';
import { settings } from '../db/schema';
import {
  getSettingsPayload,
  readSettings,
  readRawSettings,
  readShowTours,
  toSettingsPayload,
  readTransferOperationsSettings,
  readTransferOperationsSettingsTx,
} from '../content/settings';
import {
  SETTING_KEYS,
  TRANSFER_OPERATIONS_DEFAULTS,
  type SettingsBlocks,
} from '../content/settings-schema';
import { env } from '../env';
import { isPaymongoConfigured } from '../services/payments/paymongo';
import { takeFleetDateLock } from '../services/capacity';
import { readDefaultDriverTransferCap } from '../services/transfers/capacity';
import { describeWithDb } from './helpers/db';
import { resetTestDb } from './helpers/test-db';

/** A full, valid set of rows for every settings key — used as the baseline
 * for the DB-backed tests below, then mutated per-test to exercise the
 * failure paths. */
function validValueFor(key: string): unknown {
  switch (key) {
    case 'content_unverified':
      return true;
    case 'site_seo':
      return { title: 'TravelSugbo', description: 'Cebu tours', ogImage: null };
    case 'trust':
      return {
        ratingAverage: 4.9,
        ratingCount: 120,
        guestsServed: 15000,
        dotAccredited: true,
        depositPercent: 30,
        minReviewsForRating: 3,
      };
    case 'hero':
      return {
        eyebrow: 'Cebu, Philippines',
        headline: 'Book your Cebu tour',
        subtitle: 'Day tours and packages',
        ctaLabel: 'Book now',
        imagePath: '/placeholders/hero.svg',
        imageAlt: 'Cebu coastline',
      };
    case 'announcement':
      return {
        message: 'Limited slots this weekend',
        href: null,
        style: 'info',
        startsAt: null,
        endsAt: null,
        isActive: true,
      };
    case 'promo':
      return {
        code: 'EARLYBIRD',
        discountLabel: '10% off',
        headline: 'Book early',
        body: 'Save on your next trip',
        startsAt: null,
        endsAt: null,
        isActive: false,
      };
    case 'business_hours':
      return Array.from({ length: 7 }, (_, weekday) => ({
        weekday,
        opensAt: '07:00',
        closesAt: '21:00',
        isClosed: false,
      }));
    case 'payment_methods':
      return [{ key: 'gcash', label: 'GCash', enabled: true, sortOrder: 0 }];
    case 'permits':
      return { dot: null, dti: null, bir: null };
    case 'how_it_works':
      return [{ step: 1, title: 'Pick a tour', body: 'Browse our catalog' }];
    case 'why_book_direct':
      return [{ icon: 'shield', title: 'No markup', body: 'Direct pricing' }];
    case 'faqs':
      return [{ q: 'Is a deposit required?', a: 'Yes, 30%.' }];
    case 'contact':
      return {
        address: 'Cebu City',
        tagline: 'Your Cebu travel partner',
        hoursNote: 'Daily 7am-9pm',
        email: 'hello@travelsugbo.com',
        phoneDisplay: '0917 000 0000',
        phoneTel: '+639170000000',
        whatsapp: '+639170000000',
        altPhoneDisplay: '',
        altPhoneTel: '',
        facebook: '',
        motto: '',
        otherServices: { before: '', link: '', after: '' },
      };
    case 'booking':
      return { minLeadDays: 1, nextDayCutoffTime: '18:00', maxAdvanceDays: 180 };
    case 'payment_qr':
      // Week 4 Task 8: the UNCONFIGURED shape, which is what the seed ships
      // and therefore what a real row looks like until R&G send the real
      // QR and account details.
      return {
        imagePath: null,
        accountName: null,
        accountNumber: null,
        instructions: null,
        isConfigured: false,
      };
    case 'transfer_operations':
      // The owner's four defaults, 2026-10-31 (transfers-launch plan, T7).
      return {
        bufferMinutes: 60,
        minNoticeHours: 6,
        staffQuoteHoldHours: 48,
        maxTransferJobsPerDriverPerDay: 2,
      };
    case 'show_tours':
      // The harness's own baseline (Task T15, see `seedTestBaseline`), not
      // the product default — these fixtures stand in for a database the
      // tours tests can actually see a catalog in.
      return true;
    case 'legal_privacy':
      return { markdown: '# Privacy', updatedAt: '2026-01-01T00:00:00.000Z' };
    case 'legal_terms':
      return { markdown: '# Terms', updatedAt: '2026-01-01T00:00:00.000Z' };
    default:
      throw new Error(`no fixture value for "${key}"`);
  }
}

describeWithDb('readSettings()', () => {
  // rg_travel_test is a disposable database (task 1.4b): each test clears
  // the whole `settings` table and writes its own fixture rows for all 19
  // keys, rather than colliding with (or snapshotting around) the seeded
  // rows. Once the suite is done, resetTestDb() restores the canonical
  // seeded baseline for whatever runs next.
  beforeEach(async () => {
    await getDb().delete(settings);
  });

  afterAll(async () => {
    await resetTestDb();
  });

  async function insertRow(key: string, value: unknown) {
    const db = getDb();
    await db.insert(settings).values({ key, value, updatedAt: new Date() });
  }

  it('parses a full, valid set of rows into SettingsBlocks', async () => {
    for (const key of SETTING_KEYS) {
      await insertRow(key, validValueFor(key));
    }

    const blocks = await readSettings();

    expect(blocks.content_unverified).toBe(true);
    expect(blocks.business_hours).toHaveLength(7);
    expect(blocks.announcement.style).toBe('info');
    expect(blocks.permits).toEqual({ dot: null, dti: null, bir: null });
  });

  it('throws naming the key when a setting is missing from the table', async () => {
    for (const key of SETTING_KEYS) {
      if (key === 'faqs') continue; // deliberately omitted
      await insertRow(key, validValueFor(key));
    }

    await expect(readSettings()).rejects.toThrow(/faqs/);
  });

  it('throws naming the key when a stored value fails its schema', async () => {
    for (const key of SETTING_KEYS) {
      if (key === 'announcement') continue;
      await insertRow(key, validValueFor(key));
    }
    await insertRow('announcement', {
      message: 'Bad style',
      href: null,
      style: 'error', // not a valid style — no red/error style allowed
      startsAt: null,
      endsAt: null,
      isActive: true,
    });

    await expect(readSettings()).rejects.toThrow(/announcement/);
  });

  it('readRawSettings() returns the stored value unvalidated, keyed by setting key', async () => {
    await insertRow('content_unverified', true);

    const raw = await readRawSettings();

    expect(raw.content_unverified).toBe(true);
  });
});

/* =======================================================================
 * `onlinePaymentEnabled` — task A5's launch blocker.
 *
 * The checkout used to offer "Pay now" unconditionally, so a dev or staging
 * box with no `PAYMONGO_SECRET_KEY` (and a production box with every
 * payment method switched off in Settings) sent a guest to a button that
 * could only throw. The flag is computed HERE, from two independent facts,
 * and the browser only renders what it is told.
 *
 * No database: `toSettingsPayload` is pure by design, and these four tests
 * are the reason the `paymongoConfigured` argument is passed in rather than
 * read from `env` inside it — all four branches are reachable with no
 * environment to fake.
 * ======================================================================= */

/** Every settings key at its valid fixture value, so one block can be overridden per test. */
function blocksFixture(overrides: Partial<Record<string, unknown>> = {}): SettingsBlocks {
  const blocks: Record<string, unknown> = {};
  for (const key of SETTING_KEYS) {
    blocks[key] = key in overrides ? overrides[key] : validValueFor(key);
  }
  return blocks as SettingsBlocks;
}

const NOW = new Date('2026-07-01T04:00:00.000Z');

/** Every entry in `payment_methods` is a GATEWAY method — see the field's own note. */
const ALL_METHODS_DISABLED = [
  { key: 'gcash', label: 'GCash', enabled: false, sortOrder: 0 },
  { key: 'maya', label: 'Maya', enabled: false, sortOrder: 1 },
];

describe('toSettingsPayload() — onlinePaymentEnabled (task A5)', () => {
  it('is TRUE when PayMongo is configured and at least one method is enabled', () => {
    const payload = toSettingsPayload(blocksFixture(), NOW, true);
    expect(payload.paymentMethods.length).toBeGreaterThan(0);
    expect(payload.onlinePaymentEnabled).toBe(true);
  });

  it('is FALSE when PayMongo is configured but every payment method is disabled', () => {
    const payload = toSettingsPayload(
      blocksFixture({ payment_methods: ALL_METHODS_DISABLED }),
      NOW,
      true,
    );
    // The same enabled-only list the browser is shown is what the flag reads.
    expect(payload.paymentMethods).toEqual([]);
    expect(payload.onlinePaymentEnabled).toBe(false);
  });

  it('is FALSE when a method is enabled but PayMongo is NOT configured', () => {
    const payload = toSettingsPayload(blocksFixture(), NOW, false);
    expect(payload.paymentMethods.length).toBeGreaterThan(0);
    expect(payload.onlinePaymentEnabled).toBe(false);
  });

  it('is FALSE when neither half is in place', () => {
    const payload = toSettingsPayload(
      blocksFixture({ payment_methods: ALL_METHODS_DISABLED }),
      NOW,
      false,
    );
    expect(payload.onlinePaymentEnabled).toBe(false);
  });

  /**
   * The flag is one boolean and nothing more. `manualTransferEnabled`'s own
   * note explains why that matters for the QR details; the same discipline
   * applies here — the secret key, and even "which half is missing", stay
   * on the server.
   */
  it('publishes the boolean only — no key, no reason, no per-method `enabled` flag', () => {
    const payload = toSettingsPayload(blocksFixture(), NOW, true);
    const serialised = JSON.stringify(payload);
    expect(serialised).toContain('"onlinePaymentEnabled":true');
    expect(serialised).not.toContain('PAYMONGO');
    expect(serialised).not.toContain('secretKey');
    // The published methods carry a key and a label and nothing else — the
    // `enabled` flag that decided the boolean above stays server-side.
    for (const method of payload.paymentMethods) {
      expect(Object.keys(method).sort()).toEqual(['key', 'label']);
    }
  });
});

/**
 * `isPaymongoConfigured()` is the server's half of the same question, and it
 * must answer exactly what `createCheckout` would: a blank or whitespace-only
 * `PAYMONGO_SECRET_KEY` is NOT configured. `.env` ships it blank, which is
 * the state this whole task was reported against.
 */
describe('isPaymongoConfigured()', () => {
  const original = env.PAYMONGO_SECRET_KEY;

  afterEach(() => {
    env.PAYMONGO_SECRET_KEY = original;
  });

  it('is false when the key is unset, blank, or only whitespace', () => {
    env.PAYMONGO_SECRET_KEY = undefined;
    expect(isPaymongoConfigured()).toBe(false);
    env.PAYMONGO_SECRET_KEY = '';
    expect(isPaymongoConfigured()).toBe(false);
    env.PAYMONGO_SECRET_KEY = '   ';
    expect(isPaymongoConfigured()).toBe(false);
  });

  it('is true once a key is set', () => {
    env.PAYMONGO_SECRET_KEY = 'sk_test_notarealkey';
    expect(isPaymongoConfigured()).toBe(true);
  });
});

/* =======================================================================
 * `transfer_operations` fallback (pre-task 0A). This block is the lone,
 * explicitly-requested exception to the fail-loud contract tested above: a
 * missing or malformed `transfer_operations` row must default rather than
 * 500 every tour quote/hold (`assessCapacity()` reads it on every one, not
 * only transfer ones, via `readDefaultDriverTransferCap`). See
 * `content/settings.ts`'s own doc comment for why this key alone gets a
 * fallback.
 * ======================================================================= */
describeWithDb('transfer_operations fallback (pre-task 0A)', () => {
  // Far enough out that no seed or other suite's fixture owns it; harmless
  // to reuse even if another file also locks it, since fileParallelism is
  // off (vitest.config.ts) and the lock row is upserted, not owned.
  const FLEET_DATE = '2098-01-15';

  async function setTransferOperationsRow(value: unknown | undefined) {
    await getDb().delete(settings).where(eq(settings.key, 'transfer_operations'));
    if (value !== undefined) {
      await getDb().insert(settings).values({
        key: 'transfer_operations',
        value,
        updatedAt: new Date(),
      });
    }
  }

  afterEach(async () => {
    vi.restoreAllMocks();
    // Restore the canonical seeded row so any suite that runs later in this
    // file list (e.g. transfer-capacity.test.ts, which asserts the seeded
    // buffer/cap are still the owner's real defaults) sees them, not a
    // fixture this block left behind.
    await setTransferOperationsRow(TRANSFER_OPERATIONS_DEFAULTS);
  });

  afterAll(async () => {
    // `takeFleetDateLock(FLEET_DATE)` creates a lock-anchor row in
    // `fleet_date_slots` nothing else owns — one of the LEAK_TABLES
    // global-setup.ts checks at the end of the run, so this suite must
    // remove exactly what it created (owner decision 2026-10-16, C5).
    await getPool().query('DELETE FROM fleet_date_slots WHERE date = ?', [FLEET_DATE]);
    await resetTestDb();
  });

  it('missing row -> readDefaultDriverTransferCap (every tour quote/hold) returns the default instead of throwing', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await setTransferOperationsRow(undefined);

    const cap = await getDb().transaction(async (tx) => {
      await takeFleetDateLock(tx, FLEET_DATE);
      return readDefaultDriverTransferCap(tx);
    });

    expect(cap).toBe(TRANSFER_OPERATIONS_DEFAULTS.maxTransferJobsPerDriverPerDay);
    expect(warn).toHaveBeenCalledTimes(1);
    const message = String(warn.mock.calls[0]![0]);
    expect(message).toMatch(/transfer_operations/);
    expect(message).toMatch(/missing/i);
  });

  it('missing row -> the plain and transaction readers agree, both logging exactly once', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await setTransferOperationsRow(undefined);

    const plain = await readTransferOperationsSettings();
    expect(plain).toEqual(TRANSFER_OPERATIONS_DEFAULTS);
    expect(warn).toHaveBeenCalledTimes(1);

    warn.mockClear();
    const viaTx = await getDb().transaction((tx) => readTransferOperationsSettingsTx(tx));
    expect(viaTx).toEqual(TRANSFER_OPERATIONS_DEFAULTS);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('partial row -> missing fields default, present fields kept, and the warning names the missing fields', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await setTransferOperationsRow({ bufferMinutes: 90 });

    const result = await readTransferOperationsSettings();

    expect(result).toEqual({
      ...TRANSFER_OPERATIONS_DEFAULTS,
      bufferMinutes: 90,
    });
    expect(warn).toHaveBeenCalledTimes(1);
    const message = String(warn.mock.calls[0]![0]);
    expect(message).toContain('minNoticeHours');
    expect(message).toContain('staffQuoteHoldHours');
    expect(message).toContain('maxTransferJobsPerDriverPerDay');
    expect(message).not.toContain('bufferMinutes');
  });

  it('row present but entirely invalid -> full defaults, one warning, no raw value logged', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await setTransferOperationsRow({
      bufferMinutes: 'a lot',
      secretGuestName: 'should never be logged',
    });

    const result = await readTransferOperationsSettings();

    expect(result).toEqual(TRANSFER_OPERATIONS_DEFAULTS);
    expect(warn).toHaveBeenCalledTimes(1);
    const message = String(warn.mock.calls[0]![0]);
    expect(message).toMatch(/invalid/i);
    expect(message).not.toContain('secretGuestName');
    expect(message).not.toContain('a lot');
  });

  it('full, valid row -> returns exactly its own values and never warns', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const value = {
      bufferMinutes: 45,
      minNoticeHours: 4,
      staffQuoteHoldHours: 24,
      maxTransferJobsPerDriverPerDay: 3,
    };
    await setTransferOperationsRow(value);

    const result = await readTransferOperationsSettings();

    expect(result).toEqual(value);
    expect(warn).not.toHaveBeenCalled();
  });
});

/* =======================================================================
 * `show_tours` fallback (Task T15). The SECOND exception to this file's
 * fail-loud contract, and the one with the widest blast radius: unlike
 * `transfer_operations`, whose fallback lives only in its own readers,
 * `show_tours` is resolved inside `readSettings()` itself — because
 * `readSettings()` is what the public `settings.get` every page calls
 * runs, so a missing row here would 500 the WHOLE SITE rather than merely
 * hide the tours. The site-outage test below is the one that proves that,
 * and it is why the carve-out is in the loop rather than in
 * `readShowTours()` alone.
 *
 * The fallback value is `false` — tours hidden. A database that cannot
 * prove tours are meant to be visible must not show them.
 * ======================================================================= */
describeWithDb('show_tours fallback (Task T15)', () => {
  async function setShowToursRow(value: unknown | undefined) {
    await getDb().delete(settings).where(eq(settings.key, 'show_tours'));
    if (value !== undefined) {
      await getDb().insert(settings).values({
        key: 'show_tours',
        value,
        updatedAt: new Date(),
      });
    }
  }

  afterEach(async () => {
    vi.restoreAllMocks();
    // Back to the HARNESS baseline (`seedTestBaseline`, Part C), not the
    // product default: every later test in this file and every later file
    // expects the tour catalog to be visible.
    await setShowToursRow(true);
  });

  afterAll(async () => {
    // Belt and braces: the canonical seeded baseline, harness flip included,
    // for whatever file runs next.
    await resetTestDb();
  });

  it('missing row -> false, warning once and naming the missing row', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await setShowToursRow(undefined);

    expect(await readShowTours()).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
    const message = String(warn.mock.calls[0]![0]);
    expect(message).toMatch(/show_tours/);
    expect(message).toMatch(/missing/i);
  });

  it('malformed row -> false, warning once and never logging the stored value', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await setShowToursRow('yes');

    expect(await readShowTours()).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
    const message = String(warn.mock.calls[0]![0]);
    expect(message).toMatch(/show_tours/);
    expect(message).toMatch(/invalid/i);
    expect(message).not.toContain('yes');
  });

  /**
   * `0` and `1` are the shape a hand-written `UPDATE settings SET value =
   * 0` leaves behind, and JSON does not make them booleans. They must warn
   * and default, never be coerced — a stored `1` read as `true` would turn
   * the catalog on from a value nothing validated.
   *
   * (`null` is not testable here: `settings.value` is NOT NULL in the
   * schema, so the database refuses that row outright.)
   */
  it('a stored 0 or 1 is malformed, not a coerced boolean', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await setShowToursRow(0);
    expect(await readShowTours()).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![0])).toMatch(/invalid/i);

    warn.mockClear();
    await setShowToursRow(1);
    expect(await readShowTours()).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![0])).toMatch(/invalid/i);
  });

  it('valid row true -> true, with no warning', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await setShowToursRow(true);

    expect(await readShowTours()).toBe(true);
    expect(warn).not.toHaveBeenCalled();
  });

  it('valid row false -> false, with no warning (the product default is not a failure)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await setShowToursRow(false);

    expect(await readShowTours()).toBe(false);
    expect(warn).not.toHaveBeenCalled();
  });

  /**
   * THE SITE-OUTAGE PROOF, and the reason the carve-out lives inside
   * `readSettings()`'s own loop.
   *
   * A test that only drove `readShowTours()` would pass happily while
   * `settings.get` — the query every single public page makes — was down
   * with `Missing setting: "show_tours"` on any database that had not
   * re-run `db:seed`. So this asserts the WHOLE payload path survives a
   * missing row: `readSettings()` resolves rather than throws, every other
   * block still parses, and `getSettingsPayload()` publishes
   * `showTours: false`.
   */
  it('missing row does NOT take settings.get down — the whole payload still resolves', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await setShowToursRow(undefined);

    const blocks = await readSettings();
    expect(blocks.show_tours).toBe(false);
    // Not just the one key: every other block still resolved, which is the
    // claim "the site is up" actually rests on.
    expect(blocks.content_unverified).toBeDefined();
    expect(blocks.business_hours).toHaveLength(7);
    expect(blocks.contact.email.length).toBeGreaterThan(0);

    const payload = await getSettingsPayload(NOW);
    expect(payload.showTours).toBe(false);
    expect(payload.contact.email.length).toBeGreaterThan(0);
  });
});
