/**
 * Week 7 plan, Task 20 — 7P: booking refs are case-insensitive on lookup
 * (BUG-108).
 *
 * `bookingLookupInput` used to take `z.string().min(1).max(12)` — anything
 * that length, no case rule — while `startPaymentInput` and
 * `bookingStatusInput` took `bookingRefSchema`, an uppercase-only regex. A
 * guest who typed `rg-7kq4m9` was refused by two of the three procedures
 * before the query ever ran, and accepted by the third only because
 * `bookings.ref`'s column collation happens to compare case-insensitively —
 * a fact nothing in the code asserted.
 *
 * All three now share `bookingRefSchema`, which normalises (trim, then
 * uppercase) BEFORE the shape check (`shared/src/booking.ts`). This file is
 * the cross-procedure proof: the same three ref variants — lowercase,
 * mixed-case, and surrounding whitespace — now resolve the SAME booking
 * through `checkout.bookingLookup`, `checkout.startPayment` and
 * `checkout.bookingStatus`, where two of the three refused them before this
 * fix. The pure schema-level assertions (normalisation, shape-check-still-
 * refuses) live in `booking-ref.test.ts`, next to `bookingRefSchema`'s other
 * tests; this file only exercises the real routers end to end.
 */
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { manilaCivilDate } from '@rg/shared';
import { getDb, getPool } from '../db/client';
import { destinations, drivers, tourPriceTiers, tours, vans } from '../db/schema';
import { appRouter } from '../routers/_app';
import { createPaymongoProvider } from '../services/payments/paymongo';
import type { PaymentProvider } from '../services/payments/types';
import { testContext } from './helpers/ctx';
import { describeWithDb } from './helpers/db';

/* -------------------------------------------------------------------------
 * `checkout.startPayment` reaches a payment gateway. The same two-layer
 * guard `checkout-payment.test.ts` uses: `getProvider()` is mocked to hand
 * back a provider built from the REAL PayMongo client with a stub
 * transport, and `globalThis.fetch` is replaced with a throw for the whole
 * file so a forgotten injection says so instead of contacting PayMongo.
 * ---------------------------------------------------------------------- */

const gateway = vi.hoisted(() => ({ provider: null as unknown }));

vi.mock('../services/payments/registry', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/payments/registry')>();
  return {
    ...actual,
    getProvider: (name: string) => gateway.provider ?? actual.getProvider(name as never),
  };
});

const FIXTURE_SECRET_KEY = 'sk_test_task20_fixture_not_a_real_key';
const CHECKOUT_OK = {
  data: {
    id: 'cs_task20_fixture',
    attributes: { checkout_url: 'https://checkout.paymongo.com/cs_task20_fixture' },
  },
};

function installGateway() {
  const transport = vi.fn<(...args: unknown[]) => Promise<Response>>(() =>
    Promise.resolve(
      new Response(JSON.stringify(CHECKOUT_OK), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    ),
  );
  const real = createPaymongoProvider({
    secretKey: FIXTURE_SECRET_KEY,
    webhookSecret: 'not-used-by-this-suite',
    fetchImpl: transport as unknown as typeof fetch,
  });
  gateway.provider = real satisfies PaymentProvider;
}

const networkGuard = vi.fn((): never => {
  throw new Error('a test tried to reach the network');
});
let realFetch: typeof globalThis.fetch;

beforeAll(() => {
  realFetch = globalThis.fetch;
  globalThis.fetch = networkGuard as unknown as typeof globalThis.fetch;
});

afterAll(() => {
  globalThis.fetch = realFetch;
});

/* -------------------------------------------------------------------------
 * Fixtures — a real held booking, written by the real `checkout.createHold`.
 * ---------------------------------------------------------------------- */

const caller = appRouter.createCaller(testContext());

/**
 * This file's own tour day, relative to the real clock — the booking window
 * caps bookings at `maxAdvanceDays` (180 in the seed), and these resolvers
 * take no `now` from the client.
 */
const DAY = manilaCivilDate(new Date(Date.now() + 50 * 86_400_000));

const created = {
  bookingIds: [] as number[],
  tourIds: [] as number[],
  destinationIds: [] as number[],
  vanIds: [] as number[],
  driverIds: [] as number[],
};

const unique = () => `${Math.floor(Math.random() * 1e9)}_${Date.now()}`;
let guestSeq = 0;

async function makeTour() {
  const db = getDb();
  const slug = `__checkout_lookup__${unique()}`;
  const [destination] = await db.insert(destinations).values({ name: slug, slug });
  created.destinationIds.push(destination.insertId);
  const [tour] = await db.insert(tours).values({
    slug,
    title: `Task 20 Fixture Tour ${unique()}`.slice(0, 160),
    destinationId: destination.insertId,
    groupsPerDay: 4,
    freeCancelHours: 48,
    isActive: true,
  });
  created.tourIds.push(tour.insertId);
  await db.insert(tourPriceTiers).values({
    tourId: tour.insertId,
    minPax: 1,
    maxPax: 12,
    pricePerPersonCentavos: 100000,
  });

  const suffix = unique();
  const [van] = await db.insert(vans).values({
    plate: `CLT${suffix}`.slice(0, 20),
    model: 'Task 20 Fixture Van',
    capacity: 12,
    status: 'available',
    isActive: true,
  });
  created.vanIds.push(van.insertId);
  const [driver] = await db.insert(drivers).values({
    name: `Task 20 Fixture Driver ${suffix}`,
    code: `CLT${suffix}`.slice(0, 20),
    phone: '09170000000',
    pinHash: '__clt_not_a_pin_hash__',
    isActive: true,
  });
  created.driverIds.push(driver.insertId);

  return { tourId: tour.insertId, slug };
}

/** A booking in `pending_payment`, with a live hold, plus the lead email used to create it. */
async function heldBooking() {
  const tour = await makeTour();
  const quote = await caller.checkout.quote({
    tourSlug: tour.slug,
    date: DAY,
    pax: 2,
    addonIds: [],
  });
  guestSeq += 1;
  const email = `task20_${guestSeq}_${Date.now()}@example.test`;
  const held = await caller.checkout.createHold({
    tourSlug: tour.slug,
    date: DAY,
    pax: 2,
    addonIds: [],
    quoteId: quote.quoteId,
    payMode: 'deposit',
    lead: {
      name: 'Juan Dela Cruz',
      email,
      phone: `0917${String(3_000_000 + guestSeq).slice(-7)}`,
    },
    pickup: 'SM City Cebu, north entrance',
    consent: true,
  });
  created.bookingIds.push(held.bookingId);
  return { ...held, email };
}

async function cleanup() {
  const pool = getPool();
  const db = getDb();
  for (const id of created.bookingIds) {
    await pool.query('DELETE FROM audit_log WHERE entity = ? AND entity_id = ?', ['bookings', id]);
    await pool.query('DELETE FROM bookings WHERE id = ?', [id]);
  }
  for (const id of created.tourIds) {
    await db.delete(tourPriceTiers).where(eq(tourPriceTiers.tourId, id));
    await pool.query('DELETE FROM tour_date_slots WHERE tour_id = ?', [id]);
    await db.delete(tours).where(eq(tours.id, id));
  }
  for (const id of created.destinationIds) {
    await db.delete(destinations).where(eq(destinations.id, id));
  }
  for (const id of created.driverIds) await db.delete(drivers).where(eq(drivers.id, id));
  for (const id of created.vanIds) await db.delete(vans).where(eq(vans.id, id));
  await pool.query('DELETE FROM fleet_date_slots WHERE date = ?', [DAY]);
  created.bookingIds = [];
  created.tourIds = [];
  created.destinationIds = [];
  created.driverIds = [];
  created.vanIds = [];
  gateway.provider = null;
}

/** The three variants a guest might actually type or paste, over one real ref. */
function variantsOf(ref: string): Array<{ label: string; ref: string }> {
  return [
    { label: 'lowercase', ref: ref.toLowerCase() },
    { label: 'mixed case', ref: ref[0] + ref.slice(1).toLowerCase() },
    { label: 'surrounding whitespace', ref: `  ${ref}  ` },
  ];
}

describeWithDb('checkout ref lookup is case-insensitive on every procedure (BUG-108)', () => {
  beforeAll(async () => {
    const { bookingWindow } = await caller.settings.get();
    expect(
      DAY >= bookingWindow.earliest && DAY <= bookingWindow.latest,
      `this suite's fixture day ${DAY} is outside the booking window ` +
        `${bookingWindow.earliest}..${bookingWindow.latest} — the booking settings changed, ` +
        `so DAY's offset needs to change with them`,
    ).toBe(true);
  });

  afterEach(cleanup);

  // ---------------------------------------------------------------------
  // checkout.bookingLookup
  // ---------------------------------------------------------------------

  it('bookingLookup resolves the same booking for a lowercase, mixed-case and whitespace-padded ref', async () => {
    const held = await heldBooking();

    for (const { label, ref } of variantsOf(held.ref)) {
      const result = await caller.checkout.bookingLookup({ ref, email: held.email });
      expect(result.ref, label).toBe(held.ref);
    }
  });

  // ---------------------------------------------------------------------
  // checkout.startPayment — refused before this fix for the mixed-case and
  // whitespace variants (and for lowercase).
  // ---------------------------------------------------------------------

  it('startPayment accepts a lowercase, mixed-case and whitespace-padded ref — refused before this fix', async () => {
    for (const { label, ref } of variantsOf((await heldBooking()).ref)) {
      installGateway();
      const result = await caller.checkout.startPayment({ ref });
      expect(result, label).toEqual({
        redirectUrl: 'https://checkout.paymongo.com/cs_task20_fixture',
      });
    }
  });

  // ---------------------------------------------------------------------
  // checkout.bookingStatus — same refusal before this fix.
  // ---------------------------------------------------------------------

  it('bookingStatus accepts a lowercase, mixed-case and whitespace-padded ref — refused before this fix', async () => {
    const held = await heldBooking();

    for (const { label, ref } of variantsOf(held.ref)) {
      const status = await caller.checkout.bookingStatus({ ref });
      expect(status.ref, label).toBe(held.ref);
    }
  });

  // ---------------------------------------------------------------------
  // Normalising never loosens the shape check — proven against the real
  // procedures, not just the schema in isolation.
  // ---------------------------------------------------------------------

  it('still refuses a wrong-length or wrong-charset ref on every procedure, after normalising', async () => {
    const held = await heldBooking();

    await expect(
      caller.checkout.bookingLookup({ ref: 'rg-7kq4m', email: held.email }),
    ).rejects.toThrow();
    await expect(caller.checkout.startPayment({ ref: 'rg-0okq49' })).rejects.toThrow();
    await expect(caller.checkout.bookingStatus({ ref: 'rg-1ilu49' })).rejects.toThrow();
  });
});
