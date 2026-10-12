/**
 * Week 3 checkout plan, Task 6 — the checkout tRPC router.
 *
 * Thin-resolver contract: every assertion here traces a number back to a
 * SERVER computation (`priceQuote()` via `checkout.quote`, `createHold()`
 * via `checkout.createHold`), never to anything this test or the client
 * supplied. Fixtures are committed and torn down after every test, the same
 * discipline `create-hold.test.ts` uses and for the same reason: `vans` and
 * `drivers` are not date-scoped, so a leftover fixture changes every
 * capacity number in this file.
 */
import { ZodError } from 'zod';
import { afterEach, expect, it, vi } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import express from 'express';
import request from 'supertest';
import { bookingRefSchema, manilaCivilDate, quoteResultSchema } from '@rg/shared';
import { createApp } from '../app';
import { getDb, getPool } from '../db/client';
import { destinations, drivers, tourPriceTiers, tours, vans } from '../db/schema';
import { loadQuoteInputs, priceQuote } from '../services/pricing';
import {
  CHECKOUT_HOLD_MAX,
  CHECKOUT_HOLD_PROCEDURES,
  createCheckoutHoldLimiter,
} from '../middleware/rate-limit';
import { appRouter } from '../routers/_app';
import { describeWithDb } from './helpers/db';

const caller = appRouter.createCaller({});

/**
 * This file's own tour day, **relative to the real clock** rather than a
 * fixed far-future date.
 *
 * It used to be `'2099-12-10'`. The booking window (owner decision
 * 2026-10-13, pending R&G) caps bookings at `maxAdvanceDays` — 180 in the
 * seed — and these resolvers take no `now` parameter: `availability` and
 * `createHold` both run against the server's own clock, by design, because
 * nothing on the wire may decide what "today" is. So a fixture date decades
 * out is now correctly refused, and a date thirty days out is the honest way
 * to test the path a guest actually takes. (The SERVICE-level suites —
 * `create-hold.test.ts` — keep their fixed 2099 dates: `createHold()` does
 * take `now`, so they pin exact instants instead.)
 *
 * Computed once at module load, so every test in the file and the teardown
 * below agree on it.
 */
const DAY = manilaCivilDate(new Date(Date.now() + 30 * 86_400_000));

const created = {
  bookingIds: [] as number[],
  tourIds: [] as number[],
  destinationIds: [] as number[],
  vanIds: [] as number[],
  driverIds: [] as number[],
};

const unique = () => `${Math.floor(Math.random() * 1e9)}_${Date.now()}`;

async function countBookings(): Promise<number> {
  const [rows] = (await getDb().execute(sql`SELECT COUNT(*) n FROM bookings`)) as unknown as [
    Array<{ n: number }>,
    unknown,
  ];
  return Number(rows[0]?.n ?? -1);
}

/** A tour with one price tier spanning [minPax, maxPax] at a round ₱1,000/person. */
async function makeTourWithTier(minPax: number, maxPax: number) {
  const db = getDb();
  const slug = `__checkout_router__${unique()}`;
  const [destination] = await db.insert(destinations).values({ name: slug, slug });
  created.destinationIds.push(destination.insertId);
  const [tour] = await db.insert(tours).values({
    slug,
    title: slug,
    destinationId: destination.insertId,
    groupsPerDay: 1,
    freeCancelHours: 48,
    isActive: true,
  });
  created.tourIds.push(tour.insertId);
  await db.insert(tourPriceTiers).values({
    tourId: tour.insertId,
    minPax,
    maxPax,
    pricePerPersonCentavos: 100000,
  });
  return { tourId: tour.insertId, slug };
}

/** A tour with one price tier covering 1-12 pax at a round ₱1,000/person. */
async function makeTour() {
  return makeTourWithTier(1, 12);
}

/** One van, one driver — enough fleet that capacity is never what refuses. */
async function makeFleet() {
  const suffix = unique();
  const [van] = await getDb()
    .insert(vans)
    .values({
      plate: `CRT${suffix}`.slice(0, 20),
      model: 'Checkout Router Fixture Van',
      capacity: 12,
      status: 'available',
      isActive: true,
    });
  created.vanIds.push(van.insertId);
  const [driver] = await getDb()
    .insert(drivers)
    .values({
      name: `Checkout Router Fixture Driver ${suffix}`,
      code: `CRT${suffix}`.slice(0, 20),
      phone: '09170000000',
      pinHash: '__crt_not_a_pin_hash__',
      isActive: true,
    });
  created.driverIds.push(driver.insertId);
}

let guestSeq = 0;

/** A structurally valid `createHoldInput` payload, as a plain object the
 * caller sends on the wire — NOT pre-parsed, so the router's own `.input()`
 * validation is what actually runs in every test below. */
function validHoldInput(over: {
  tourSlug: string;
  date: string;
  pax: number;
  quoteId: string;
  extra?: Record<string, unknown>;
}) {
  guestSeq += 1;
  return {
    tourSlug: over.tourSlug,
    date: over.date,
    pax: over.pax,
    addonIds: [],
    quoteId: over.quoteId,
    payMode: 'deposit' as const,
    lead: {
      name: 'Juan Dela Cruz',
      email: `guest${guestSeq}_${Date.now()}@example.test`,
      phone: `0917${String(1_000_000 + guestSeq).slice(-7)}`,
    },
    pickup: 'SM City Cebu, north entrance',
    consent: true,
    ...over.extra,
  };
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
}

describeWithDb('checkout router', () => {
  afterEach(cleanup);

  // -------------------------------------------------------------------------
  // checkout.quote
  // -------------------------------------------------------------------------

  it('quote returns a server-computed total for a real tour', async () => {
    const tour = await makeTour();
    const result = await caller.checkout.quote({
      tourSlug: tour.slug,
      date: DAY,
      pax: 3,
      addonIds: [],
    });
    // 3 pax x ₱1,000/person = ₱3,000 — from the tier row, never from this test.
    expect(result.subtotalCentavos).toBe(300000);
    expect(result.totalCentavos).toBe(300000);
    expect(result.discountCentavos).toBe(0);
    expect(quoteResultSchema.safeParse(result).success).toBe(true);
  });

  it('quote with an unknown coupon returns a typed error naming the rule, not a 500', async () => {
    const tour = await makeTour();
    const error = await caller.checkout
      .quote({
        tourSlug: tour.slug,
        date: DAY,
        pax: 2,
        addonIds: [],
        couponCode: `NOPE_${unique()}`,
      })
      .catch((e: unknown) => e);
    expect(error).toMatchObject({ code: 'BAD_REQUEST' });
    expect((error as Error).message.toLowerCase()).toContain('coupon');
  });

  // Round 1 review: the two `translateQuoteError` branches that read
  // pricing.ts's plain-Error text had no test at all — neither proven to
  // land on its intended code rather than falling through to the generic
  // INTERNAL_SERVER_ERROR branch.

  it('quote returns NOT_FOUND for a slug that names no active tour', async () => {
    const error = await caller.checkout
      .quote({
        tourSlug: `__checkout_router_missing__${unique()}`,
        date: DAY,
        pax: 2,
        addonIds: [],
      })
      .catch((e: unknown) => e);
    expect(error).toMatchObject({ code: 'NOT_FOUND' });
  });

  it('quote returns BAD_REQUEST for a head count no tier covers', async () => {
    // A tier that starts at 4 pax leaves 1-3 valid per quoteInput's own
    // Zod bounds (1-12) but uncovered by this tour's own pricing — exactly
    // priceQuote()'s "No price tier covers a head count of N" throw site.
    const tour = await makeTourWithTier(4, 12);
    const error = await caller.checkout
      .quote({ tourSlug: tour.slug, date: DAY, pax: 2, addonIds: [] })
      .catch((e: unknown) => e);
    expect(error).toMatchObject({ code: 'BAD_REQUEST' });
  });

  /**
   * Ruling 24: `translateQuoteError` matches these two `pricing.ts` throw
   * sites by exact substring, because that file is CLAUDE.md "do not
   * modify" and carries no typed error for either case. Round 1 review:
   * that match is a real contract, and nothing pinned it — a wording
   * change in pricing.ts would silently degrade NOT_FOUND/BAD_REQUEST into
   * a generic INTERNAL_SERVER_ERROR with no test going red. This does not
   * reopen pricing.ts (a money file, out of scope); it only pins the two
   * wordings the router's regexes depend on, so drift shows up here first.
   */
  it('Ruling 24 — pins the exact pricing.ts wording checkout.ts depends on', async () => {
    await expect(
      loadQuoteInputs(`__checkout_router_missing__${unique()}`, DAY, [], undefined),
    ).rejects.toThrow(/^No active tour found for slug "/);

    const tour = await makeTourWithTier(4, 12);
    const inputs = await loadQuoteInputs(tour.slug, DAY, [], undefined);
    expect(() => priceQuote({ ...inputs, pax: 2 })).toThrow(
      /^No price tier covers a head count of 2$/,
    );
  });

  // -------------------------------------------------------------------------
  // checkout.createHold
  // -------------------------------------------------------------------------

  it('refuses consent: false before the resolver runs (Zod), and writes nothing', async () => {
    const before = await countBookings();
    const input = validHoldInput({
      tourSlug: '__checkout_router_consent__',
      date: DAY,
      pax: 2,
      quoteId: 'a'.repeat(32),
      extra: { consent: false },
    });

    const error = await caller.checkout.createHold(input as never).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: 'BAD_REQUEST' });
    // Proves it never reached the resolver: tRPC's own input-parsing stage
    // throws with the ZodError as `cause`, before `createHoldService` is
    // ever called. A refusal produced by the resolver's own error
    // translation never carries a ZodError cause.
    expect((error as { cause?: unknown }).cause).toBeInstanceOf(ZodError);
    expect(await countBookings()).toBe(before);
  });

  it('returns a ref matching bookingRefSchema', async () => {
    const tour = await makeTour();
    await makeFleet();
    const quote = await caller.checkout.quote({
      tourSlug: tour.slug,
      date: DAY,
      pax: 2,
      addonIds: [],
    });

    const result = await caller.checkout.createHold(
      validHoldInput({ tourSlug: tour.slug, date: DAY, pax: 2, quoteId: quote.quoteId }),
    );
    created.bookingIds.push(result.bookingId);

    expect(bookingRefSchema.safeParse(result.ref).success).toBe(true);
  });

  it('rejects a request carrying totalCentavos — the .strict() schema at the router boundary', async () => {
    const tour = await makeTour();
    await makeFleet();
    const quote = await caller.checkout.quote({
      tourSlug: tour.slug,
      date: DAY,
      pax: 2,
      addonIds: [],
    });
    const before = await countBookings();

    const input = validHoldInput({
      tourSlug: tour.slug,
      date: DAY,
      pax: 2,
      quoteId: quote.quoteId,
      extra: { totalCentavos: quote.totalCentavos },
    });
    const error = await caller.checkout.createHold(input as never).catch((e: unknown) => e);

    expect(error).toMatchObject({ code: 'BAD_REQUEST' });
    expect((error as { cause?: unknown }).cause).toBeInstanceOf(ZodError);
    expect(await countBookings(), 'an unknown field must not be silently accepted').toBe(before);
  });

  // -------------------------------------------------------------------------
  // checkout.availability — advisory capacity read
  // -------------------------------------------------------------------------

  it('availability reports ok for a real tour with no competing bookings', async () => {
    const tour = await makeTour();
    await makeFleet();
    const verdict = await caller.checkout.availability({ tourSlug: tour.slug, date: DAY, pax: 2 });
    expect(verdict).toEqual({ ok: true });
  });

  /**
   * The booking window (owner decision 2026-10-13, pending R&G). `availability`
   * answers it BEFORE the capacity check, so the date picker greys a closed
   * date out instead of calling it "fully booked" — two different sentences to
   * a guest, and only one of them is true.
   *
   * Today is the case the owner's `minLeadDays: 1` turns off, and it is worth
   * asserting through the router rather than only in the service: the reason
   * has to survive onto the wire for the amber copy to be able to branch on
   * it. A date far beyond `maxAdvanceDays` gets the same reason from the other
   * end of the window.
   */
  it('availability reports date_not_bookable for today and for a date past the window', async () => {
    const tour = await makeTour();
    await makeFleet();
    const today = manilaCivilDate(new Date());

    expect(
      await caller.checkout.availability({ tourSlug: tour.slug, date: today, pax: 2 }),
      'today is not bookable under minLeadDays: 1',
    ).toEqual({ ok: false, reason: 'date_not_bookable' });

    /*
     * The other end of the window. A fixed 2099 date is safe here precisely
     * BECAUSE it is refused: the window check returns before any transaction,
     * so no lock row is created for it and there is nothing to clean up.
     */
    expect(
      await caller.checkout.availability({ tourSlug: tour.slug, date: '2099-12-10', pax: 2 }),
      'a date beyond maxAdvanceDays is not bookable either',
    ).toEqual({ ok: false, reason: 'date_not_bookable' });
  });

  it('availability reports tour_unavailable for an unknown slug, not an error', async () => {
    const verdict = await caller.checkout.availability({
      tourSlug: `__checkout_router_missing__${unique()}`,
      date: DAY,
      pax: 2,
    });
    expect(verdict).toEqual({ ok: false, reason: 'tour_unavailable' });
  });

  /**
   * Round 1 review (Important): `availability` had no try/catch at all, so
   * an unexpected failure's raw `.message` would have reached the client
   * verbatim — `trpc.ts`'s `errorFormatter` only path-scrubs a message, it
   * never replaces it. Injects a failure the same way `create-hold.test.ts`
   * simulates a MySQL deadlock: `vi.spyOn` on the real, singleton `getDb()`
   * instance's `transaction` method (not a mock db), so the tour lookup
   * still succeeds for real and only the capacity read fails.
   */
  it('availability falls through to the fixed message on an unexpected failure, never the raw one', async () => {
    const tour = await makeTour();
    const db = getDb();
    const spy = vi
      .spyOn(db, 'transaction')
      .mockRejectedValueOnce(new Error('ECONNRESET: pretend a connection dropped'));

    try {
      const error = await caller.checkout
        .availability({ tourSlug: tour.slug, date: DAY, pax: 2 })
        .catch((e: unknown) => e);
      expect(error).toMatchObject({ code: 'INTERNAL_SERVER_ERROR' });
      expect((error as Error).message).toBe('Could not complete the request.');
      expect((error as Error).message).not.toContain('ECONNRESET');
    } finally {
      spy.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// Ruling 5 — 5 hold creations per IP per 15 minutes on checkout.createHold
// ---------------------------------------------------------------------------

/**
 * No database needed for the limiter itself — every request here either
 * hits the limiter directly (a toy 200 route) or fails Zod validation before
 * any resolver runs, exactly like `driver-lockout.test.ts`'s own per-IP
 * layer and `rate-limit.test.ts`'s non-DB bypass-shape tests. A DB-less run
 * must still exercise this: that is exactly the environment where a
 * silently skipped suite would hide the limiter being unmounted.
 */
function appWithLimiterOnly() {
  const app = express();
  app.use(createCheckoutHoldLimiter());
  app.all('/trpc/*splat', (_req, res) => res.json({ ok: true }));
  return app;
}

it(`allows ${CHECKOUT_HOLD_MAX} hold attempts per IP and refuses the 6th`, async () => {
  const app = appWithLimiterOnly();
  for (let i = 1; i <= CHECKOUT_HOLD_MAX; i += 1) {
    await request(app).post(`/trpc/${CHECKOUT_HOLD_PROCEDURES[0]}`).expect(200);
  }
  await request(app).post(`/trpc/${CHECKOUT_HOLD_PROCEDURES[0]}`).expect(429);
});

it('the checkout.createHold limiter leaves every other procedure alone', async () => {
  const app = appWithLimiterOnly();
  for (let i = 0; i < CHECKOUT_HOLD_MAX + 5; i += 1) {
    await request(app).post('/trpc/checkout.quote').expect(200);
  }
});

it('gives each app its own counter, so one cannot exhaust another', async () => {
  const a = appWithLimiterOnly();
  for (let i = 1; i <= CHECKOUT_HOLD_MAX; i += 1) {
    await request(a).post(`/trpc/${CHECKOUT_HOLD_PROCEDURES[0]}`).expect(200);
  }
  await request(appWithLimiterOnly()).post(`/trpc/${CHECKOUT_HOLD_PROCEDURES[0]}`).expect(200);
});

/**
 * The regression this whole pattern exists to catch (brief): a limiter that
 * exists but is unmounted. `appWithLimiterOnly()` above cannot see that —
 * it mounts the limiter by hand regardless of app.ts's real state. Only a
 * test against `createApp()` itself proves the mount in app.ts is real.
 */
it('is actually mounted in app.ts: the real app refuses the 6th createHold call from one IP', async () => {
  const app = createApp();
  const statuses: number[] = [];
  for (let i = 0; i < CHECKOUT_HOLD_MAX + 1; i += 1) {
    // Deliberately invalid body — the limiter runs before, and regardless
    // of, tRPC's own input validation (same pattern as rate-limit.test.ts).
    const res = await request(app).post('/trpc/checkout.createHold').send({});
    statuses.push(res.status);
  }
  expect(statuses.slice(0, CHECKOUT_HOLD_MAX)).not.toContain(429);
  expect(statuses[CHECKOUT_HOLD_MAX]).toBe(429);
});

it('the real app leaves checkout.quote unaffected by the createHold limiter', async () => {
  const app = createApp();
  for (let i = 0; i < CHECKOUT_HOLD_MAX + 5; i += 1) {
    const res = await request(app).post('/trpc/checkout.quote').send({});
    expect(res.status).not.toBe(429);
  }
});
