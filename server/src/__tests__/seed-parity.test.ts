import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  SEED_DESTINATIONS,
  SEED_PACKAGES,
  SEED_REVIEWS,
  SEED_SETTINGS,
  SEED_TOURS,
} from '../db/seed-data';
import { SETTING_KEYS, SETTING_SCHEMAS } from '../content/settings-schema';

const siteTs = readFileSync(join(process.cwd(), '../client/src/lib/site.ts'), 'utf8');

/** Same regex approach scripts/check-contact-parity.mjs uses, so the three
 *  surfaces (site.ts, coming-soon, seed) can never disagree. */
function firstQuoted(key: string): string {
  const m = new RegExp(`${key}:\\s*'([^']*)'`).exec(siteTs);
  if (!m?.[1]) throw new Error(`site.ts no longer declares ${key}`);
  return m[1];
}

describe('seeded contact settings mirror site.ts', () => {
  const contact = SEED_SETTINGS.contact;

  it('matches the WhatsApp number', () => {
    expect(contact.whatsapp).toBe(firstQuoted('whatsapp'));
  });

  it('matches the Facebook URL and motto', () => {
    expect(contact.facebook).toBe(firstQuoted('facebook'));
    expect(contact.motto).toBe(firstQuoted('motto'));
  });

  it('matches both displayed numbers', () => {
    const displays = [...siteTs.matchAll(/display:\s*'([^']*)'/g)].map((m) => m[1]);
    expect(contact.phoneDisplay).toBe(displays[0]);
    expect(contact.altPhoneDisplay).toBe(displays[1]);
  });

  it('matches the other-services sentence, part for part', () => {
    const parts = /otherServices:\s*{([\s\S]*?)}/.exec(siteTs)?.[1] ?? '';
    const [before, link, after] = [...parts.matchAll(/'([^']*)'/g)].map((m) => m[1]);
    expect(contact.otherServices).toEqual({ before, link, after });
  });
});

describe('seeded content honours the no-fake-numbers rule', () => {
  it('leaves every permit number empty', () => {
    expect(SEED_SETTINGS.permits).toEqual({ dot: null, dti: null, bir: null });
  });

  it('flags the content as unverified', () => {
    expect(SEED_SETTINGS.content_unverified).toBe(true);
  });
});

describe('SEED_SETTINGS satisfies every settings schema', () => {
  it.each(SETTING_KEYS)('key "%s" parses with its schema', (key) => {
    const result = SETTING_SCHEMAS[key].safeParse(SEED_SETTINGS[key]);
    expect(result.success).toBe(true);
  });

  it('covers every settings key — none missing, none extra', () => {
    expect(Object.keys(SEED_SETTINGS).sort()).toEqual([...SETTING_KEYS].sort());
  });
});

describe('seeded destinations', () => {
  it('seeds exactly six, all featured', () => {
    expect(SEED_DESTINATIONS).toHaveLength(6);
    expect(SEED_DESTINATIONS.every((d) => d.isFeatured)).toBe(true);
  });

  it('gives only badian-kawasan a non-null displayName', () => {
    for (const destination of SEED_DESTINATIONS) {
      if (destination.slug === 'badian-kawasan') {
        expect(destination.displayName).toBe('Kawasan Falls');
      } else {
        expect(destination.displayName).toBeNull();
      }
    }
  });
});

describe('seeded tours (Ruling 1 — price tiers)', () => {
  // Today's displayed "from" price per tour, verbatim from placeholder-data.ts.
  const todaysFromPrice: Record<string, number> = {
    'oslob-whale-shark-tumalog-falls': 189_000,
    'kawasan-falls-canyoneering': 215_000,
    'moalboal-sardine-run-turtles': 175_000,
    'mactan-island-hopping': 145_000,
    'cebu-city-heritage-tour': 98_000,
    'bohol-countryside-chocolate-hills': 245_000,
  };

  it('seeds exactly six tours', () => {
    expect(SEED_TOURS).toHaveLength(6);
  });

  it.each(SEED_TOURS)('$slug has three tiers whose minimum is today\'s "from" price', (tour) => {
    expect(tour.priceTiers).toHaveLength(3);
    const min = Math.min(...tour.priceTiers.map((t) => t.pricePerPerson));
    expect(min).toBe(todaysFromPrice[tour.slug]);
    // Descending with group size.
    const [low, mid, high] = [...tour.priceTiers].sort((a, b) => a.minPax - b.minPax);
    expect(low!.pricePerPerson).toBeGreaterThan(mid!.pricePerPerson);
    expect(mid!.pricePerPerson).toBeGreaterThan(high!.pricePerPerson);
  });

  it('Oslob tier prices match the brief exactly', () => {
    const oslob = SEED_TOURS.find((t) => t.slug === 'oslob-whale-shark-tumalog-falls');
    const prices = oslob?.priceTiers.map((t) => t.pricePerPerson).sort((a, b) => b - a);
    expect(prices).toEqual([229_000, 209_000, 189_000]);
  });

  it('every tour image uses the real intrinsic SVG size (1200x800)', () => {
    for (const tour of SEED_TOURS) {
      for (const image of tour.images) {
        expect(image.width).toBe(1200);
        expect(image.height).toBe(800);
      }
    }
  });
});

describe('seeded packages', () => {
  it('seeds exactly three', () => {
    expect(SEED_PACKAGES).toHaveLength(3);
  });
});

describe('seeded reviews (D1)', () => {
  it('seeds exactly six, all published samples', () => {
    expect(SEED_REVIEWS).toHaveLength(6);
    for (const review of SEED_REVIEWS) {
      expect(review.status).toBe('published');
      expect(review.isSample).toBe(true);
    }
  });

  it('matches each review to a real seeded tour slug', () => {
    const tourSlugs = new Set(SEED_TOURS.map((t) => t.slug));
    for (const review of SEED_REVIEWS) {
      expect(tourSlugs.has(review.tourSlug)).toBe(true);
    }
  });
});

describe('legal placeholders open with the required TODO blockquote', () => {
  it.each(['legal_privacy', 'legal_terms'] as const)('%s', (key) => {
    expect(SEED_SETTINGS[key].markdown.startsWith('> **TODO: client legal review.**')).toBe(true);
  });
});
