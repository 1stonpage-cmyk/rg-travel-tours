import { afterEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import * as schema from '../db/schema';
import { getDb } from '../db/client';
import { describeWithDb } from './helpers/db';

const EXPECTED_TABLES = [
  'settings',
  'destinations',
  'tours',
  'tourImages',
  'tourPriceTiers',
  'tourItineraryStops',
  'tourAddons',
  'tourBlockedDates',
  'packages',
  'reviews',
  'inquiries',
  'newsletterSubscribers',
];

describe('public content schema', () => {
  it('exports every public content table and no booking tables yet', () => {
    for (const name of EXPECTED_TABLES) expect(schema).toHaveProperty(name);
    expect(schema).not.toHaveProperty('bookings');
    expect(schema).not.toHaveProperty('payments');
    expect(schema).not.toHaveProperty('users');
    expect(schema).not.toHaveProperty('sessions');
    expect(schema).not.toHaveProperty('vans');
    expect(schema).not.toHaveProperty('drivers');
    expect(schema).not.toHaveProperty('coupons');
    expect(schema).not.toHaveProperty('auditLog');
    expect(schema).not.toHaveProperty('tourDateSlots');
  });

  it('carries the columns the public site depends on', () => {
    expect(schema.reviews.isSample).toBeDefined();
    expect(schema.tours.historicalTripsCount).toBeDefined();
    expect(schema.tours.badge).toBeDefined();
    expect(schema.tours.seoTitle).toBeDefined();
    expect(schema.packages.seoTitle).toBeDefined();
    expect(schema.destinations.blurb).toBeDefined();
  });
});

describeWithDb('public content schema (DB-backed)', () => {
  const prefix = `__schema_test__${Date.now()}`;
  let destinationId: number | undefined;
  let tourId: number | undefined;
  let tierId: number | undefined;

  afterEach(async () => {
    const db = getDb();
    if (tierId !== undefined) {
      await db.delete(schema.tourPriceTiers).where(eq(schema.tourPriceTiers.id, tierId));
      tierId = undefined;
    }
    if (tourId !== undefined) {
      await db.delete(schema.tours).where(eq(schema.tours.id, tourId));
      tourId = undefined;
    }
    if (destinationId !== undefined) {
      await db.delete(schema.destinations).where(eq(schema.destinations.id, destinationId));
      destinationId = undefined;
    }
  });

  it('keeps money columns integral through a real insert/read round trip', async () => {
    const db = getDb();

    const [destinationResult] = await db.insert(schema.destinations).values({
      name: `${prefix} destination`,
      slug: `${prefix}-destination`,
    });
    destinationId = destinationResult.insertId;

    const [tourResult] = await db.insert(schema.tours).values({
      slug: `${prefix}-tour`,
      title: `${prefix} tour`,
      destinationId,
    });
    tourId = tourResult.insertId;

    const [tierResult] = await db.insert(schema.tourPriceTiers).values({
      tourId,
      minPax: 7,
      maxPax: 12,
      pricePerPerson: 189000,
    });
    tierId = tierResult.insertId;

    const [row] = await db
      .select()
      .from(schema.tourPriceTiers)
      .where(eq(schema.tourPriceTiers.id, tierId));

    expect(row?.pricePerPerson).toBe(189000);
    expect(Number.isInteger(row?.pricePerPerson)).toBe(true);
  });
});
