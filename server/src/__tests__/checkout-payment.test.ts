/**
 * Week 3 checkout plan, Task 7 — `checkout.startPayment`.
 *
 * **The money rule is this file's subject.** Every amount asserted below is
 * read back out of the `bookings` row the server wrote (`total_centavos` and
 * the frozen `price_snapshot.depositPercent`, through `depositCentavos()`
 * from `@rg/shared`) and compared with what the gateway was actually sent.
 * No test here supplies an amount, and one test proves the wire schema
 * refuses a request that tries to.
 *
 * **No test may reach the network, and the refusal tests must prove the
 * gateway was never asked.** Three layers, each load-bearing:
 *
 *   1. `globalThis.fetch` is replaced for the whole file with a throw, so a
 *      forgotten injection says "a test tried to reach the network" instead
 *      of contacting PayMongo.
 *   2. `../services/payments/registry` is mocked so `getProvider()` hands
 *      back a provider built by the REAL `createPaymongoProvider()` with a
 *      fixture key and a stub transport. The real PayMongo client therefore
 *      runs — its method-name mapping, its `metadata`/`reference_number`
 *      assembly, its centavos pass-through — while no socket is opened.
 *   3. `createCheckout` is additionally wrapped in a spy, so "no gateway
 *      call was attempted" is asserted at BOTH levels: the provider was not
 *      invoked, and no HTTP request was built. A refusal that still reaches
 *      the gateway has already created a payment intent someone can
 *      complete, which is why "it threw" is not the assertion.
 *
 * There are no PayMongo keys in this project (owner Ruling 10): all three
 * `PAYMONGO_*` variables in `.env` are empty. The "not configured" case
 * therefore builds the provider with `secretKey: ''` — the real local
 * condition, stated explicitly rather than read from an env file a future
 * machine might have filled in.
 */
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import { ZodError } from 'zod';
import { eq, sql } from 'drizzle-orm';
import {
  BOOKING_PAGE_ROUTE,
  bookingPagePath,
  depositCentavos,
  manilaCivilDate,
  PAYMENT_HOLD_MINUTES,
} from '@rg/shared';
import { getDb, getPool } from '../db/client';
import { bookings, destinations, drivers, tourPriceTiers, tours, vans } from '../db/schema';
import { env } from '../env';
import { appRouter } from '../routers/_app';
import { CHECKOUT_PAYMENT_METHODS } from '../routers/public/checkout';
import { createPaymongoProvider, PaymongoNotConfiguredError } from '../services/payments/paymongo';
import type { PaymentProvider } from '../services/payments/types';
import { describeWithDb } from './helpers/db';

/* -------------------------------------------------------------------------
 * The mocked registry — layer 2 of the three above.
 * ---------------------------------------------------------------------- */

const gateway = vi.hoisted(() => ({
  provider: null as unknown,
  requestedNames: [] as string[],
}));

vi.mock('../services/payments/registry', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/payments/registry')>();
  return {
    ...actual,
    getProvider: (name: string) => {
      gateway.requestedNames.push(name);
      return gateway.provider ?? actual.getProvider(name as never);
    },
  };
});

/** Never a real key. `sk_test_` only because that is the shape of the thing. */
const FIXTURE_SECRET_KEY = 'sk_test_task7_fixture_not_a_real_key';

const CHECKOUT_OK = {
  data: {
    id: 'cs_task7_fixture',
    attributes: { checkout_url: 'https://checkout.paymongo.com/cs_task7_fixture' },
  },
};

/** A stub transport. Records the call; answers with a real `Response`. */
function stubFetch(status: number, payload: unknown) {
  return vi.fn<(...args: unknown[]) => Promise<Response>>(() =>
    Promise.resolve(
      new Response(JSON.stringify(payload), {
        status,
        headers: { 'Content-Type': 'application/json' },
      }),
    ),
  );
}

/**
 * Installs the provider `getProvider()` will return, built from the real
 * PayMongo client so this suite exercises it rather than a hand-written
 * double. Returns both spies the refusal tests assert on.
 */
function installGateway(options: { secretKey?: string; status?: number; payload?: unknown } = {}) {
  const transport = stubFetch(options.status ?? 200, options.payload ?? CHECKOUT_OK);
  const real = createPaymongoProvider({
    secretKey: options.secretKey ?? FIXTURE_SECRET_KEY,
    webhookSecret: 'not-used-by-this-suite',
    fetchImpl: transport as unknown as typeof fetch,
  });
  const createCheckout = vi.fn(real.createCheckout);
  gateway.provider = { ...real, createCheckout } satisfies PaymentProvider;
  return { transport, createCheckout };
}

/** What the PayMongo client actually put on the wire, decoded. */
function sentAttributes(transport: ReturnType<typeof stubFetch>): Record<string, unknown> {
  const [, init] = transport.mock.calls[0] as [string, RequestInit];
  const body = JSON.parse(String(init.body)) as { data: { attributes: Record<string, unknown> } };
  return body.data.attributes;
}

/* -------------------------------------------------------------------------
 * Layer 1 — the network guard.
 * ---------------------------------------------------------------------- */

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
 * Fixtures — a real held booking, written by the real `createHold()`.
 * ---------------------------------------------------------------------- */

const caller = appRouter.createCaller({});

/**
 * This file's own tour day, **relative to the real clock**.
 *
 * It was `'2099-12-18'`. These tests hold a booking through
 * `checkout.createHold`, which takes no `now` parameter — the server's own
 * clock decides what "today" is, by design — and the booking window (owner
 * decision 2026-10-13, pending R&G) caps dates at `maxAdvanceDays`, 180 in
 * the seed. A fixture date in 2099 is now correctly refused, so the date has
 * to be one a guest could really pick. Forty days out: clear of the lead day
 * and the 18:00 cutoff at one end, well inside 180 at the other.
 */
const DAY = manilaCivilDate(new Date(Date.now() + 40 * 86_400_000));

const created = {
  bookingIds: [] as number[],
  tourIds: [] as number[],
  destinationIds: [] as number[],
  vanIds: [] as number[],
  driverIds: [] as number[],
};

const unique = () => `${Math.floor(Math.random() * 1e9)}_${Date.now()}`;

let guestSeq = 0;

/** A tour, its fleet, and a 1-12 pax tier at a round ₱1,000/person. */
async function makeTour() {
  const db = getDb();
  const slug = `__checkout_payment__${unique()}`;
  const [destination] = await db.insert(destinations).values({ name: slug, slug });
  created.destinationIds.push(destination.insertId);
  const [tour] = await db.insert(tours).values({
    slug,
    title: `Task 7 Fixture Tour ${unique()}`.slice(0, 160),
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
    plate: `CPT${suffix}`.slice(0, 20),
    model: 'Task 7 Fixture Van',
    capacity: 12,
    status: 'available',
    isActive: true,
  });
  created.vanIds.push(van.insertId);
  const [driver] = await db.insert(drivers).values({
    name: `Task 7 Fixture Driver ${suffix}`,
    code: `CPT${suffix}`.slice(0, 20),
    phone: '09170000000',
    pinHash: '__cpt_not_a_pin_hash__',
    isActive: true,
  });
  created.driverIds.push(driver.insertId);

  return { tourId: tour.insertId, slug };
}

/**
 * A booking in `pending_payment` with a live hold, created the only way the
 * application can create one: `checkout.quote` then `checkout.createHold`.
 * Nothing here chooses a price.
 */
async function heldBooking(payMode: 'deposit' | 'full' = 'deposit', pax = 3) {
  const tour = await makeTour();
  const quote = await caller.checkout.quote({
    tourSlug: tour.slug,
    date: DAY,
    pax,
    addonIds: [],
  });
  guestSeq += 1;
  const held = await caller.checkout.createHold({
    tourSlug: tour.slug,
    date: DAY,
    pax,
    addonIds: [],
    quoteId: quote.quoteId,
    payMode,
    lead: {
      name: 'Juan Dela Cruz',
      email: `task7_${guestSeq}_${Date.now()}@example.test`,
      phone: `0917${String(2_000_000 + guestSeq).slice(-7)}`,
    },
    pickup: 'SM City Cebu, north entrance',
    consent: true,
  });
  created.bookingIds.push(held.bookingId);
  return { ...held, tourSlug: tour.slug };
}

/** The stored row, as the resolver reads it. */
async function readBooking(bookingId: number) {
  const [row] = await getDb().select().from(bookings).where(eq(bookings.id, bookingId));
  if (!row) throw new Error('fixture booking vanished');
  return row;
}

async function holdExtensionAudits(bookingId: number): Promise<Array<{ data: unknown }>> {
  const [rows] = (await getPool().query(
    'SELECT data FROM audit_log WHERE entity = ? AND entity_id = ? AND action = ?',
    ['bookings', bookingId, 'booking.hold_extended'],
  )) as unknown as [Array<{ data: unknown }>, unknown];
  return rows;
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
  gateway.requestedNames = [];
}

describeWithDb('checkout.startPayment', () => {
  /**
   * The premise `DAY` rests on, proven rather than assumed. `DAY` is
   * today + 40 days, inside the window only because the seeded
   * `maxAdvanceDays` is 180 — tighten that setting and every hold in this
   * file would otherwise fail with an opaque "We're not taking bookings for
   * that date". This aborts the file with the reason instead.
   */
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

  // -----------------------------------------------------------------------
  // The happy path, and the money rule.
  // -----------------------------------------------------------------------

  it('sends the deposit the BOOKING says, with the ref in metadata, and returns the redirect URL', async () => {
    const { transport, createCheckout } = installGateway();
    const held = await heldBooking('deposit', 3);
    const row = await readBooking(held.bookingId);

    const result = await caller.checkout.startPayment({ ref: held.ref });

    expect(result).toEqual({ redirectUrl: 'https://checkout.paymongo.com/cs_task7_fixture' });
    expect(gateway.requestedNames).toContain('paymongo');
    expect(createCheckout).toHaveBeenCalledTimes(1);
    expect(transport).toHaveBeenCalledTimes(1);
    expect(networkGuard).not.toHaveBeenCalled();

    // The amount: read off the stored row and its frozen snapshot, through
    // `depositCentavos()` — never restated here, never sent by the caller.
    const expected = depositCentavos(row.totalCentavos, row.priceSnapshot.depositPercent);
    expect(expected).toBeGreaterThan(0);
    // And it is NOT the full total, so swapping the two branches fails.
    expect(expected).not.toBe(row.totalCentavos);

    const attributes = sentAttributes(transport);
    const lineItems = attributes.line_items as Array<{ amount: number; currency: string }>;
    expect(lineItems[0]?.amount).toBe(expected);
    expect(lineItems[0]?.currency).toBe('PHP');
    // The webhook finds the booking by this, so it is the load-bearing field.
    expect(attributes.metadata).toEqual({ bookingRef: held.ref });
    expect(attributes.reference_number).toBe(held.ref);
  });

  it('sends the whole total for a pay_mode=full booking', async () => {
    const { transport } = installGateway();
    const held = await heldBooking('full', 2);
    const row = await readBooking(held.bookingId);

    await caller.checkout.startPayment({ ref: held.ref });

    const attributes = sentAttributes(transport);
    const lineItems = attributes.line_items as Array<{ amount: number }>;
    expect(lineItems[0]?.amount).toBe(row.totalCentavos);
    expect(row.totalCentavos).not.toBe(
      depositCentavos(row.totalCentavos, row.priceSnapshot.depositPercent),
    );
  });

  it('offers exactly the four methods Ruling 7 fixed — no qrph, no bank_transfer, no cash', async () => {
    // The constant itself, in OUR vocabulary.
    expect([...CHECKOUT_PAYMENT_METHODS]).toEqual(['card', 'gcash', 'maya', 'grab_pay']);

    const { transport } = installGateway();
    const held = await heldBooking();
    await caller.checkout.startPayment({ ref: held.ref });

    // And what PayMongo was actually asked for — `maya` becomes `paymaya`
    // inside the client, which is why this is read off the wire.
    expect(sentAttributes(transport).payment_method_types).toEqual([
      'card',
      'gcash',
      'paymaya',
      'grab_pay',
    ]);
  });

  it('builds the success and cancel URLs from the shared booking-page constant (Ruling 25)', async () => {
    // Pinned by value, so Task 9 mounting `/booking/:ref` and this resolver
    // cannot drift apart without one of them going red.
    expect(BOOKING_PAGE_ROUTE).toBe('/booking/:ref');
    expect(bookingPagePath('RG-7KQ4M9')).toBe('/booking/RG-7KQ4M9');

    const { transport } = installGateway();
    const held = await heldBooking();
    await caller.checkout.startPayment({ ref: held.ref });

    const attributes = sentAttributes(transport);
    expect(attributes.success_url).toBe(`${env.PUBLIC_BASE_URL}/booking/${held.ref}`);
    expect(attributes.cancel_url).toBe(`${env.PUBLIC_BASE_URL}/booking/${held.ref}?cancelled=1`);
  });

  // -----------------------------------------------------------------------
  // Refusals — and the gateway must never have been asked.
  // -----------------------------------------------------------------------

  it('refuses an expired booking, with no gateway call at all', async () => {
    const { transport, createCheckout } = installGateway();
    const held = await heldBooking();
    await getDb()
      .update(bookings)
      .set({ status: 'expired', holdExpiresAt: null })
      .where(eq(bookings.id, held.bookingId));

    const error = await caller.checkout.startPayment({ ref: held.ref }).catch((e: unknown) => e);

    expect(error).toMatchObject({ code: 'CONFLICT' });
    // The whole point: a refusal that still reaches the gateway has already
    // created a payment intent someone can complete.
    expect(createCheckout).not.toHaveBeenCalled();
    expect(transport).not.toHaveBeenCalled();
    expect(networkGuard).not.toHaveBeenCalled();
  });

  it('refuses an already-confirmed booking, with no gateway call at all', async () => {
    const { transport, createCheckout } = installGateway();
    const held = await heldBooking();
    await getDb()
      .update(bookings)
      .set({ status: 'confirmed', holdExpiresAt: null })
      .where(eq(bookings.id, held.bookingId));

    const error = await caller.checkout.startPayment({ ref: held.ref }).catch((e: unknown) => e);

    expect(error).toMatchObject({ code: 'CONFLICT' });
    expect(createCheckout).not.toHaveBeenCalled();
    expect(transport).not.toHaveBeenCalled();
  });

  it('refuses a cancelled booking, with no gateway call at all', async () => {
    const { transport, createCheckout } = installGateway();
    const held = await heldBooking();
    await getDb()
      .update(bookings)
      .set({ status: 'cancelled', holdExpiresAt: null })
      .where(eq(bookings.id, held.bookingId));

    const error = await caller.checkout.startPayment({ ref: held.ref }).catch((e: unknown) => e);

    expect(error).toMatchObject({ code: 'CONFLICT' });
    expect(createCheckout).not.toHaveBeenCalled();
    expect(transport).not.toHaveBeenCalled();
  });

  /**
   * The expiry sweep is a later task, so a lapsed hold still reads
   * `pending_payment` for up to a minute. `recordPayment()` already treats a
   * non-null `hold_expires_at` in the past as dead regardless of status; so
   * does this, for the same reason — the race between the cron and the guest
   * must not decide whether a payment intent gets created.
   */
  it('refuses a booking whose hold has lapsed even though the sweep has not run', async () => {
    const { transport, createCheckout } = installGateway();
    const held = await heldBooking();
    await getDb()
      .update(bookings)
      .set({ holdExpiresAt: new Date(Date.now() - 60_000) })
      .where(eq(bookings.id, held.bookingId));

    const error = await caller.checkout.startPayment({ ref: held.ref }).catch((e: unknown) => e);

    expect(error).toMatchObject({ code: 'CONFLICT' });
    expect((await readBooking(held.bookingId)).status).toBe('pending_payment');
    expect(createCheckout).not.toHaveBeenCalled();
    expect(transport).not.toHaveBeenCalled();
  });

  it('answers an unknown ref with a generic NOT_FOUND and no gateway call', async () => {
    const { transport, createCheckout } = installGateway();

    const error = await caller.checkout.startPayment({ ref: 'RG-ZZZZZZ' }).catch((e: unknown) => e);

    expect(error).toMatchObject({ code: 'NOT_FOUND' });
    expect(createCheckout).not.toHaveBeenCalled();
    expect(transport).not.toHaveBeenCalled();
  });

  it('rejects a request carrying an amount — the .strict() schema at the router boundary', async () => {
    const { transport, createCheckout } = installGateway();
    const held = await heldBooking();

    const error = await caller.checkout
      .startPayment({ ref: held.ref, amountCentavos: 1 } as never)
      .catch((e: unknown) => e);

    expect(error).toMatchObject({ code: 'BAD_REQUEST' });
    // Refused by tRPC's input stage, before the resolver ran at all.
    expect((error as { cause?: unknown }).cause).toBeInstanceOf(ZodError);
    expect(createCheckout).not.toHaveBeenCalled();
    expect(transport).not.toHaveBeenCalled();
  });

  // -----------------------------------------------------------------------
  // Ruling 10 — there are no PayMongo keys. A missing one must be loud.
  // -----------------------------------------------------------------------

  it('fails with a clear, key-free error when PAYMONGO_SECRET_KEY is not set', async () => {
    const { transport } = installGateway({ secretKey: '' });
    const held = await heldBooking();
    // Read back rather than trusting `createHold`'s in-memory Date: MySQL's
    // `datetime` keeps whole seconds, so the stored hold is the comparable
    // one.
    const before = await readBooking(held.bookingId);

    const error = await caller.checkout.startPayment({ ref: held.ref }).catch((e: unknown) => e);

    // Loud, not a silent skip and not a redirect to nowhere.
    expect(error).toMatchObject({ code: 'SERVICE_UNAVAILABLE' });
    // The guest-facing message says the service is unavailable and names no
    // environment variable, no key and no gateway internals.
    const message = (error as Error).message;
    expect(message).not.toMatch(/PAYMONGO|sk_test|sk_live|Basic /i);
    // The real reason survives server-side, as `cause`, for the logs only.
    expect((error as { cause?: unknown }).cause).toBeInstanceOf(PaymongoNotConfiguredError);
    expect(((error as { cause?: Error }).cause as Error).message).toContain('PAYMONGO_SECRET_KEY');
    // It failed before any socket was opened.
    expect(transport).not.toHaveBeenCalled();
    expect(networkGuard).not.toHaveBeenCalled();
    // And it changed nothing: the hold is untouched.
    const row = await readBooking(held.bookingId);
    expect(row.holdExpiresAt?.getTime()).toBe(before.holdExpiresAt?.getTime());
    expect(await holdExtensionAudits(held.bookingId)).toHaveLength(0);
  });

  // -----------------------------------------------------------------------
  // Ruling 4 — extend the hold ONCE, at the gateway redirect.
  // -----------------------------------------------------------------------

  it('extends the hold to created_at + 30 minutes and audits it', async () => {
    installGateway();
    const held = await heldBooking();
    const before = await readBooking(held.bookingId);

    await caller.checkout.startPayment({ ref: held.ref });

    const after = await readBooking(held.bookingId);
    const target = before.createdAt.getTime() + PAYMENT_HOLD_MINUTES * 60_000;
    expect(PAYMENT_HOLD_MINUTES).toBe(30);
    expect(after.holdExpiresAt?.getTime()).toBe(target);
    // It really moved — the hold was shorter before.
    expect(before.holdExpiresAt!.getTime()).toBeLessThan(target);
    // Status is untouched: this task starts a payment, it never records one.
    expect(after.status).toBe('pending_payment');
    expect(after.amountPaidCentavos).toBe(0);

    const audits = await holdExtensionAudits(held.bookingId);
    expect(audits).toHaveLength(1);
  });

  it('does NOT extend the hold a second time', async () => {
    installGateway();
    const held = await heldBooking();

    await caller.checkout.startPayment({ ref: held.ref });
    const afterFirst = await readBooking(held.bookingId);

    await caller.checkout.startPayment({ ref: held.ref });
    const afterSecond = await readBooking(held.bookingId);

    expect(afterSecond.holdExpiresAt?.getTime()).toBe(afterFirst.holdExpiresAt?.getTime());
    // One extension, one audit row — a guest who reloads the payment page
    // does not buy themselves another half hour each time.
    expect(await holdExtensionAudits(held.bookingId)).toHaveLength(1);
  });

  it('does not extend the hold when the gateway refuses the checkout', async () => {
    const { transport } = installGateway({
      status: 400,
      payload: { errors: [{ detail: 'amount must be at least 10000' }] },
    });
    const held = await heldBooking();
    const before = await readBooking(held.bookingId);

    const error = await caller.checkout.startPayment({ ref: held.ref }).catch((e: unknown) => e);

    expect(error).toMatchObject({ code: 'SERVICE_UNAVAILABLE' });
    expect(transport).toHaveBeenCalledTimes(1);
    const row = await readBooking(held.bookingId);
    expect(row.holdExpiresAt?.getTime()).toBe(before.holdExpiresAt?.getTime());
    expect(await holdExtensionAudits(held.bookingId)).toHaveLength(0);
  });

  // -----------------------------------------------------------------------
  // It must add no path to marking anything paid.
  // -----------------------------------------------------------------------

  it('writes no payments row and leaves amount_paid at zero', async () => {
    installGateway();
    const held = await heldBooking();

    await caller.checkout.startPayment({ ref: held.ref });

    const [rows] = (await getDb().execute(
      sql`SELECT COUNT(*) n FROM payments WHERE booking_id = ${held.bookingId}`,
    )) as unknown as [Array<{ n: number }>, unknown];
    expect(Number(rows[0]?.n)).toBe(0);
    expect((await readBooking(held.bookingId)).amountPaidCentavos).toBe(0);
  });
});
