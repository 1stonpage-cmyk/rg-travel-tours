import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getDb } from '../db/client';
import { settings } from '../db/schema';
import { readSettings, readRawSettings, toSettingsPayload } from '../content/settings';
import { SETTING_KEYS, type SettingsBlocks } from '../content/settings-schema';
import { env } from '../env';
import { isPaymongoConfigured } from '../services/payments/paymongo';
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
  // the whole `settings` table and writes its own fixture rows for all 15
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
