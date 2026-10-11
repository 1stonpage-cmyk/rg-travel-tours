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
  // Core-schema plan, Task 1. Its own assertions live in schema-users.test.ts.
  'users',
  // Core-schema plan, Task 2. Its own assertions live in audit.test.ts.
  'auditLog',
  // Core-schema plan, Tasks 3 and 4. Their own assertions live in
  // schema-fleet.test.ts.
  'vans',
  'drivers',
  'driverLeaves',
  // Core-schema plan, Task 5. Its own assertions live in schema-coupons.test.ts.
  'coupons',
  // Core-schema plan, Task 6 — the two lock rows and the webhook event log.
  // Their own assertions live in schema-locks.test.ts.
  'tourDateSlots',
  'fleetDateSlots',
  'paymentEvents',
  // Core-schema plan, Task 7 — the first Wave 2 table. Its own assertions
  // live in schema-sessions.test.ts.
  'sessions',
];

describe('public content schema', () => {
  it('exports every public content table and no booking tables yet', () => {
    for (const name of EXPECTED_TABLES) expect(schema).toHaveProperty(name);
    expect(schema).not.toHaveProperty('bookings');
    expect(schema).not.toHaveProperty('payments');
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
