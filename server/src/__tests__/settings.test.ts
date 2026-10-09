import { afterAll, beforeEach, expect, it } from 'vitest';
import { getDb } from '../db/client';
import { settings } from '../db/schema';
import { readSettings, readRawSettings } from '../content/settings';
import { SETTING_KEYS } from '../content/settings-schema';
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
