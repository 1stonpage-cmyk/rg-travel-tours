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
import { afterEach, beforeAll, expect, it, vi } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import express from 'express';
import request from 'supertest';
import {
  AMOUNT_BELOW_GATEWAY_MINIMUM,
  bookingRefSchema,
  DATE_BLOCKED,
  manilaCivilDate,
  NOTHING_TO_PAY_ONLINE,
  PAYMONGO_MIN_CENTAVOS,
  quoteResultSchema,
  TOTAL_BELOW_GATEWAY_MINIMUM,
} from '@rg/shared';
import { createApp } from '../app';
import { getDb, getPool } from '../db/client';
import {
  bookings,
  coupons,
  destinations,
  drivers,
  tourBlockedDates,
  tourPriceTiers,
  tours,
  vans,
} from '../db/schema';
import { loadQuoteInputs, priceQuote, quoteDigest } from '../services/pricing';
import {
  BOOKING_LOOKUP_MAX,
  BOOKING_LOOKUP_PROCEDURES,
  CHECKOUT_HOLD_MAX,
  CHECKOUT_HOLD_PROCEDURES,
  createBookingLookupLimiter,
  createCheckoutHoldLimiter,
} from '../middleware/rate-limit';
import { appRouter } from '../routers/_app';
import { testContext } from './helpers/ctx';
import { describeWithDb } from './helpers/db';

/**
 * Every POST here is a BROWSER request, so it carries the `Origin` header a
 * browser always sends. Required since Week 4 Task 5 mounted the CSRF
 * origin check ahead of the limiters and the body parser
 * (`middleware/origin-check.ts`): without it these requests are refused 403
 * before the thing under test ever runs.
 */
const BROWSER_ORIGIN = 'http://localhost:5180';
function post(app: Parameters<typeof request>[0], path: string) {
  return request(app).post(path).set('Origin', BROWSER_ORIGIN);
}

const caller = appRouter.createCaller(testContext());

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
  couponIds: [] as number[],
};

const unique = () => `${Math.floor(Math.random() * 1e9)}_${Date.now()}`;

async function countBookings(): Promise<number> {
  const [rows] = (await getDb().execute(sql`SELECT COUNT(*) n FROM bookings`)) as unknown as [
    Array<{ n: number }>,
    unknown,
  ];
  return Number(rows[0]?.n ?? -1);
}

/**
 * A tour with one price tier spanning [minPax, maxPax] at a round
 * ₱1,000/person — or at `pricePerPersonCentavos` when the caller needs a
 * different price, which the gateway-floor test (BUG-110) does.
 */
async function makeTourWithTier(minPax: number, maxPax: number, pricePerPersonCentavos = 100000) {
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
    pricePerPersonCentavos,
  });
  return { tourId: tour.insertId, slug };
}

/** A tour with one price tier covering 1-12 pax at a round ₱1,000/person. */
async function makeTour() {
  return makeTourWithTier(1, 12);
}

/**
 * A percentage coupon with no limits — this file's first coupon fixture, added
 * for BUG-110 fix round 1's zero-total case (a 100%-off booking, which
 * `percent_bp` allows and which no gateway can take).
 */
async function makeCoupon(percentBp: number) {
  const code = `__CRT__${unique()}`.toUpperCase().slice(0, 40);
  const [row] = await getDb()
    .insert(coupons)
    .values({ code, discountType: 'percent', percentBp, usageLimit: null, isActive: true });
  created.couponIds.push(row.insertId);
  return { id: row.insertId, code };
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
    // Task F4 added this file's first blocked-date fixtures; they are keyed
    // by tour, so they have to go before the tour does.
    await db.delete(tourBlockedDates).where(eq(tourBlockedDates.tourId, id));
    await pool.query('DELETE FROM tour_date_slots WHERE tour_id = ?', [id]);
    await db.delete(tours).where(eq(tours.id, id));
  }
  for (const id of created.destinationIds) {
    await db.delete(destinations).where(eq(destinations.id, id));
  }
  for (const id of created.driverIds) await db.delete(drivers).where(eq(drivers.id, id));
  for (const id of created.vanIds) await db.delete(vans).where(eq(vans.id, id));
  for (const id of created.couponIds) {
    // Redemptions first: nothing here is expected to redeem one (the holds
    // these coupons appear in are refused), but a leftover child row would
    // keep the coupon alive and change the next run's counts.
    await pool.query('DELETE FROM coupon_redemptions WHERE coupon_id = ?', [id]);
    await db.delete(coupons).where(eq(coupons.id, id));
  }
  await pool.query('DELETE FROM fleet_date_slots WHERE date = ?', [DAY]);
  created.bookingIds = [];
  created.tourIds = [];
  created.destinationIds = [];
  created.driverIds = [];
  created.vanIds = [];
  created.couponIds = [];
}

describeWithDb('checkout router', () => {
  /**
   * The premise `DAY` rests on, proven rather than assumed.
   *
   * `DAY` is today + 30 days, which is inside the window only because the
   * seeded `maxAdvanceDays` is 180. If a later task tightens that setting,
   * every booking test in this file would otherwise fail with an opaque
   * "We're not taking bookings for that date" and nothing naming the cause.
   * A `beforeAll` failure aborts the file with the reason instead.
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

  /**
   * BUG-110, at the surface a guest actually meets. The service's own
   * refusal is pinned in `create-hold.test.ts`; what this asserts is the
   * SENTENCE — one shared constant, guest-facing, naming what to do instead
   * — and that nothing was written. Before this, a sub-₱100 deposit held a
   * slot and failed later at PayMongo with "amount must be at least 10000".
   */
  it('refuses a deposit below the gateway minimum with the shared guest message, and writes nothing', async () => {
    // ₱300 for one guest: a 30% deposit is ₱90, under the ₱100 floor.
    const tour = await makeTourWithTier(1, 12, 30000);
    await makeFleet();
    const quote = await caller.checkout.quote({
      tourSlug: tour.slug,
      date: DAY,
      pax: 1,
      addonIds: [],
    });
    expect(quote.amountDueNowCentavos.deposit).toBeLessThan(PAYMONGO_MIN_CENTAVOS);
    const before = await countBookings();

    const error = await caller.checkout
      .createHold(
        validHoldInput({ tourSlug: tour.slug, date: DAY, pax: 1, quoteId: quote.quoteId }),
      )
      .catch((e: unknown) => e);

    expect(error).toMatchObject({
      code: 'BAD_REQUEST',
      message: AMOUNT_BELOW_GATEWAY_MINIMUM,
    });
    // Guest-safe and actionable: it names the floor and the ways round it,
    // and no gateway, provider or environment-variable name.
    expect(AMOUNT_BELOW_GATEWAY_MINIMUM).toContain('₱100');
    expect(AMOUNT_BELOW_GATEWAY_MINIMUM).toMatch(/in full/i);
    expect(AMOUNT_BELOW_GATEWAY_MINIMUM).toMatch(/contact us/i);
    expect(AMOUNT_BELOW_GATEWAY_MINIMUM).not.toMatch(/paymongo|gateway|centavos/i);
    expect(await countBookings(), 'a refused hold must leave no booking row').toBe(before);
  });

  /**
   * BUG-110 fix round 1, on the wire. The sentence above is only true while
   * paying in full would actually work. These two are the bands where it would
   * not, and where the shipped wording sent a guest at an alternative that
   * refuses them identically — or, at ₱0, at one that does not exist at all.
   *
   * `gatewayMinimumMessage()` makes the choice (its three bands are unit-pinned
   * in `shared/src/__tests__/checkout.test.ts`); what these assert is that the
   * REFUSING SURFACE reaches the right band from a real request, off the
   * server's recomputed total.
   */
  it('does not offer "pay in full" when the whole total is under the gateway minimum', async () => {
    // ₱50 for one guest: there is no pay mode that reaches ₱100.
    const tour = await makeTourWithTier(1, 12, 5000);
    await makeFleet();
    const quote = await caller.checkout.quote({
      tourSlug: tour.slug,
      date: DAY,
      pax: 1,
      addonIds: [],
    });
    expect(quote.totalCentavos).toBeGreaterThan(0);
    expect(quote.totalCentavos).toBeLessThan(PAYMONGO_MIN_CENTAVOS);
    const before = await countBookings();

    const error = await caller.checkout
      .createHold(
        validHoldInput({
          tourSlug: tour.slug,
          date: DAY,
          pax: 1,
          quoteId: quote.quoteId,
          extra: { payMode: 'full' },
        }),
      )
      .catch((e: unknown) => e);

    expect(error).toMatchObject({
      code: 'BAD_REQUEST',
      message: TOTAL_BELOW_GATEWAY_MINIMUM,
    });
    expect(
      TOTAL_BELOW_GATEWAY_MINIMUM,
      'paying in full is the charge that was just refused — offering it is a loop',
    ).not.toMatch(/in full/i);
    expect(TOTAL_BELOW_GATEWAY_MINIMUM).toMatch(/contact us/i);
    expect(await countBookings(), 'a refused hold must leave no booking row').toBe(before);
  });

  it('tells a 100%-off guest there is nothing to pay, and offers no payment route at all', async () => {
    const tour = await makeTour();
    await makeFleet();
    const coupon = await makeCoupon(10000); // 100% off — percent_bp allows it

    // 2026-10-30 owner decision: a ₱0 total is refused in the preview too,
    // not only at hold time — `checkout.quote` must throw here, the same
    // refusal `createHold` already gives below.
    const quoteError = await caller.checkout
      .quote({
        tourSlug: tour.slug,
        date: DAY,
        pax: 2,
        addonIds: [],
        couponCode: coupon.code,
      })
      .catch((e: unknown) => e);

    expect(quoteError).toMatchObject({
      code: 'BAD_REQUEST',
      message: NOTHING_TO_PAY_ONLINE,
    });

    // The preview now refuses before handing back a quoteId, so the
    // independent createHold assertion below recomputes the SAME quote the
    // service layer would (bypassing the router's own now-refusing `quote`
    // procedure) — exactly `create-hold.test.ts`'s own `quoteFor()` helper.
    const inputs = await loadQuoteInputs(tour.slug, DAY, [], coupon.code);
    const quote = priceQuote({ ...inputs, pax: 2 });
    expect(quote.totalCentavos, 'the premise: a 100% coupon leaves nothing to pay').toBe(0);
    const quoteId = quoteDigest({
      tourId: inputs.tourId,
      date: DAY,
      pax: 2,
      addonIds: [],
      couponCode: coupon.code,
      totalCentavos: quote.totalCentavos,
    });

    const before = await countBookings();

    const error = await caller.checkout
      .createHold(
        validHoldInput({
          tourSlug: tour.slug,
          date: DAY,
          pax: 2,
          quoteId,
          extra: { payMode: 'full', couponCode: coupon.code },
        }),
      )
      .catch((e: unknown) => e);

    expect(error).toMatchObject({
      code: 'BAD_REQUEST',
      message: NOTHING_TO_PAY_ONLINE,
    });
    // Nothing to pay means nothing to pay by ANY method: neither clause of the
    // original sentence can appear here.
    expect(NOTHING_TO_PAY_ONLINE).toMatch(/nothing to pay/i);
    expect(NOTHING_TO_PAY_ONLINE).toMatch(/contact us/i);
    expect(NOTHING_TO_PAY_ONLINE).not.toMatch(/in full/i);
    expect(NOTHING_TO_PAY_ONLINE).not.toMatch(/bank transfer|QR code/i);
    expect(await countBookings(), 'a refused hold must leave no booking row').toBe(before);
  });

  /**
   * The boundary this guard must not be over-tight against — mirrors
   * `create-hold.test.ts`'s own "still holds a normal-priced tour on
   * deposit" pattern: a coupon that discounts heavily but still leaves a
   * real amount due must keep returning a successful quote.
   */
  it('still returns a successful quote when a coupon leaves ₱1 or more due', async () => {
    // 99% off a ₱1,000 (1-pax) subtotal leaves ₱10 due — comfortably above
    // zero, so the new `totalCentavos <= 0` guard must not catch it.
    const tour = await makeTour();
    await makeFleet();
    const coupon = await makeCoupon(9900); // 99% off

    const quote = await caller.checkout.quote({
      tourSlug: tour.slug,
      date: DAY,
      pax: 1,
      addonIds: [],
      couponCode: coupon.code,
    });

    expect(quote.totalCentavos).toBeGreaterThanOrEqual(100); // >= ₱1
    expect(quote.quoteId).toBeTruthy();
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

  /**
   * Final whole-branch review, F4: `tour_blocked_dates` had exactly ONE
   * production call site — inside `createHold()` — so `availability`
   * answered `{ ok: true }` for a blocked date, the checkout page showed no
   * banner, and the guest was refused only on submit.
   *
   * That defeats the precedence work this week did. The order of the date
   * guards exists so both surfaces say the SAME reason for the same request
   * (see `create-hold.ts` step 2), and they cannot agree on a reason one of
   * them never evaluates. So this asserts both halves: the reason reaches
   * the wire, and it is `date_blocked` rather than a capacity reason or
   * `date_not_bookable`.
   */
  it('availability reports date_blocked for a date the tour has blocked', async () => {
    const tour = await makeTour();
    await makeFleet();
    await getDb()
      .insert(tourBlockedDates)
      .values({
        tourId: tour.tourId,
        date: new Date(`${DAY}T00:00:00Z`),
        reason: 'Fiesta — no trips',
      });

    expect(await caller.checkout.availability({ tourSlug: tour.slug, date: DAY, pax: 2 })).toEqual({
      ok: false,
      reason: DATE_BLOCKED,
    });
  });

  /**
   * The agreement itself, asserted rather than assumed: the advisory read
   * and the authoritative write must name the same cause for one request.
   * `createHold()` throws `TourDateBlockedError`, whose router translation
   * is "This tour isn't running on that date." — the same thing
   * `date_blocked` tells the guest early.
   */
  it('availability and createHold agree on WHY a blocked date is refused', async () => {
    const tour = await makeTour();
    await makeFleet();
    const quote = await caller.checkout.quote({
      tourSlug: tour.slug,
      date: DAY,
      pax: 2,
      addonIds: [],
    });
    await getDb()
      .insert(tourBlockedDates)
      .values({ tourId: tour.tourId, date: new Date(`${DAY}T00:00:00Z`) });

    const advisory = await caller.checkout.availability({
      tourSlug: tour.slug,
      date: DAY,
      pax: 2,
    });
    const refusal = await caller.checkout
      .createHold(
        validHoldInput({ tourSlug: tour.slug, date: DAY, pax: 2, quoteId: quote.quoteId }),
      )
      .catch((e: unknown) => e);

    expect(advisory).toEqual({ ok: false, reason: DATE_BLOCKED });
    expect(refusal).toMatchObject({
      code: 'BAD_REQUEST',
      message: "This tour isn't running on that date.",
    });
  });

  /**
   * Precedence, matching `createHold()`'s own order (past, then blocked,
   * then the window, then capacity): a date that is BOTH blocked and
   * outside the booking window reports the blocked reason, because that is
   * the one the hold would have thrown first. Were the two surfaces to
   * order these differently, the page would promise one sentence and the
   * submit would deliver another.
   */
  it('availability reports date_blocked ahead of date_not_bookable for today', async () => {
    const tour = await makeTour();
    await makeFleet();
    const today = manilaCivilDate(new Date());
    await getDb()
      .insert(tourBlockedDates)
      .values({ tourId: tour.tourId, date: new Date(`${today}T00:00:00Z`) });

    expect(
      await caller.checkout.availability({ tourSlug: tour.slug, date: today, pax: 2 }),
      'today is also outside the window under minLeadDays: 1 — blocked still wins',
    ).toEqual({ ok: false, reason: DATE_BLOCKED });
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

  // -------------------------------------------------------------------------
  // checkout.bookingStatus — Task 9: a read, and only a read.
  //
  // §6: "The success redirect page only reads status ... It never confirms
  // anything itself." The enumeration test below is the one that actually
  // proves that for the whole router, not just this procedure: a third
  // checkout mutation is how a redirect page quietly becomes a way to
  // confirm a booking.
  // -------------------------------------------------------------------------

  it('returns status, amounts and a tour summary for a real held booking', async () => {
    const tour = await makeTour();
    await makeFleet();
    const quote = await caller.checkout.quote({
      tourSlug: tour.slug,
      date: DAY,
      pax: 2,
      addonIds: [],
    });
    const held = await caller.checkout.createHold(
      validHoldInput({ tourSlug: tour.slug, date: DAY, pax: 2, quoteId: quote.quoteId }),
    );
    created.bookingIds.push(held.bookingId);

    const status = await caller.checkout.bookingStatus({ ref: held.ref });

    expect(status.ref).toBe(held.ref);
    expect(status.status).toBe('pending_payment');
    expect(status.tourTitle).toBe(tour.slug); // makeTour() sets title = slug
    expect(status.date).toBe(DAY);
    expect(status.pax).toBe(2);
    expect(status.payMode).toBe('deposit');
    expect(status.totalCentavos).toBe(quote.totalCentavos);
    expect(status.paidCentavos).toBe(0);
    // Server arithmetic on a server value (`total - paid`), same spirit as
    // `startPayment`'s own `depositCentavos()` read just above — never
    // trusted from the wire, and never forbidden by the client-only
    // money-arithmetic guard (`checkout-page.test.tsx`), which scans
    // `client/` only.
    expect(status.balanceCentavos).toBe(quote.totalCentavos);
    expect(status.paymentReviewRequired).toBe(false);
  });

  it('reflects a status change made elsewhere (e.g. the webhook) — a live read, never a cached confirmation', async () => {
    const tour = await makeTour();
    await makeFleet();
    const quote = await caller.checkout.quote({
      tourSlug: tour.slug,
      date: DAY,
      pax: 1,
      addonIds: [],
    });
    const held = await caller.checkout.createHold(
      validHoldInput({ tourSlug: tour.slug, date: DAY, pax: 1, quoteId: quote.quoteId }),
    );
    created.bookingIds.push(held.bookingId);

    // Simulates what only a verified webhook or an admin approval may do —
    // never this procedure itself.
    await getDb()
      .update(bookings)
      .set({ status: 'confirmed', amountPaidCentavos: quote.totalCentavos, holdExpiresAt: null })
      .where(eq(bookings.id, held.bookingId));

    const status = await caller.checkout.bookingStatus({ ref: held.ref });
    expect(status.status).toBe('confirmed');
    expect(status.paidCentavos).toBe(quote.totalCentavos);
    expect(status.balanceCentavos).toBe(0);
  });

  it('answers an unknown ref with the SAME generic NOT_FOUND startPayment uses — never leaking whether a ref exists', async () => {
    const error = await caller.checkout
      .bookingStatus({ ref: 'RG-ZZZZZZ' })
      .catch((e: unknown) => e);
    expect(error).toMatchObject({ code: 'NOT_FOUND' });
    expect((error as Error).message).toBe('We could not find that booking.');
  });

  it('checkout.bookingStatus is itself a query, never a mutation', () => {
    const procedures = appRouter._def.procedures as unknown as Record<
      string,
      { _def: { type: string } }
    >;
    expect(procedures['checkout.bookingStatus']?._def.type).toBe('query');
  });

  /**
   * The brief's own test, verbatim: this is the single most load-bearing
   * assertion in the whole task. `createHold` and `startPayment` are the
   * only two checkout mutations — a third here is exactly how a page that
   * is supposed to only READ status would quietly become a way to CONFIRM
   * one.
   */
  it('exposes no mutation that could confirm a booking', () => {
    const procs = Object.entries(appRouter._def.procedures);
    const checkoutMutations = procs
      .filter(([name]) => name.startsWith('checkout.'))
      .filter(([, p]) => (p as { _def: { type: string } })._def.type === 'mutation')
      .map(([name]) => name);
    // createHold and startPayment are the only two. A third mutation here is
    // how a redirect page quietly becomes a way to confirm a booking.
    expect(checkoutMutations.sort()).toEqual(['checkout.createHold', 'checkout.startPayment']);
  });

  // -------------------------------------------------------------------------
  // checkout.bookingLookup — Task 10: §7's guest self-service lookup
  // (ref + email). The per-IP limiter has its own suite further below,
  // against the real app and a toy one, mirroring createCheckoutHoldLimiter.
  // -------------------------------------------------------------------------

  it('returns the booking for a correct ref + email pair', async () => {
    const tour = await makeTour();
    await makeFleet();
    const quote = await caller.checkout.quote({
      tourSlug: tour.slug,
      date: DAY,
      pax: 2,
      addonIds: [],
    });
    const input = validHoldInput({
      tourSlug: tour.slug,
      date: DAY,
      pax: 2,
      quoteId: quote.quoteId,
    });
    const held = await caller.checkout.createHold(input);
    created.bookingIds.push(held.bookingId);

    const result = await caller.checkout.bookingLookup({
      ref: held.ref,
      email: input.lead.email,
    });

    expect(result.ref).toBe(held.ref);
    expect(result.status).toBe('pending_payment');
    expect(result.tourTitle).toBe(tour.slug); // makeTour() sets title = slug
    expect(result.date).toBe(DAY);
    expect(result.pax).toBe(2);
    expect(result.payMode).toBe('deposit');
    expect(result.totalCentavos).toBe(quote.totalCentavos);
    expect(result.paidCentavos).toBe(0);
    expect(result.paymentReviewRequired).toBe(false);
    // An implementer's choice, narrower than strictly required (not a
    // spec-forbidden field): this resolver hands back no `balanceCentavos`,
    // unlike `bookingStatus`.
    expect(result).not.toHaveProperty('balanceCentavos');
  });

  it('matches the email case-insensitively', async () => {
    const tour = await makeTour();
    await makeFleet();
    const quote = await caller.checkout.quote({
      tourSlug: tour.slug,
      date: DAY,
      pax: 1,
      addonIds: [],
    });
    const input = validHoldInput({
      tourSlug: tour.slug,
      date: DAY,
      pax: 1,
      quoteId: quote.quoteId,
    });
    const held = await caller.checkout.createHold(input);
    created.bookingIds.push(held.bookingId);

    const result = await caller.checkout.bookingLookup({
      ref: held.ref,
      email: input.lead.email.toUpperCase(),
    });
    expect(result.ref).toBe(held.ref);
  });

  /**
   * The brief's own load-bearing assertion: a wrong email on a REAL ref
   * must be indistinguishable from an unknown ref altogether. Asserting
   * both are merely "an error" would pass against a leaking implementation
   * that returns "wrong email" for one case and "no such booking" for the
   * other — only comparing the two for deep equality catches that. Compared
   * as `{ code, message }` rather than the raw thrown objects: a raw
   * `TRPCError`'s own `.stack` differs between any two throw expressions by
   * construction (different call-site line), so including it would make
   * this assertion fail for a reason that has nothing to do with the
   * security property it exists to check.
   */
  it('answers a wrong email and an unknown ref with the exact same error — never revealing which half was wrong', async () => {
    const tour = await makeTour();
    await makeFleet();
    const quote = await caller.checkout.quote({
      tourSlug: tour.slug,
      date: DAY,
      pax: 1,
      addonIds: [],
    });
    const input = validHoldInput({
      tourSlug: tour.slug,
      date: DAY,
      pax: 1,
      quoteId: quote.quoteId,
    });
    const held = await caller.checkout.createHold(input);
    created.bookingIds.push(held.bookingId);

    const wrongEmailError = await caller.checkout
      .bookingLookup({ ref: held.ref, email: `nope_${unique()}@example.test` })
      .catch((e: unknown) => e);
    const unknownRefError = await caller.checkout
      .bookingLookup({ ref: 'RG-ZZZZZZ', email: input.lead.email })
      .catch((e: unknown) => e);

    const shapeOf = (e: unknown) => ({
      code: (e as { code: unknown }).code,
      message: (e as { message: unknown }).message,
    });
    expect(shapeOf(wrongEmailError)).toEqual(shapeOf(unknownRefError));
    expect(shapeOf(wrongEmailError)).toEqual({
      code: 'NOT_FOUND',
      message: 'We could not find that booking.',
    });
  });

  it('checkout.bookingLookup is itself a query, never a mutation', () => {
    const procedures = appRouter._def.procedures as unknown as Record<
      string,
      { _def: { type: string } }
    >;
    expect(procedures['checkout.bookingLookup']?._def.type).toBe('query');
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
    await post(app, `/trpc/${CHECKOUT_HOLD_PROCEDURES[0]}`).expect(200);
  }
  await post(app, `/trpc/${CHECKOUT_HOLD_PROCEDURES[0]}`).expect(429);
});

it('the checkout.createHold limiter leaves every other procedure alone', async () => {
  const app = appWithLimiterOnly();
  for (let i = 0; i < CHECKOUT_HOLD_MAX + 5; i += 1) {
    await post(app, '/trpc/checkout.quote').expect(200);
  }
});

it('gives each app its own counter, so one cannot exhaust another', async () => {
  const a = appWithLimiterOnly();
  for (let i = 1; i <= CHECKOUT_HOLD_MAX; i += 1) {
    await post(a, `/trpc/${CHECKOUT_HOLD_PROCEDURES[0]}`).expect(200);
  }
  await post(appWithLimiterOnly(), `/trpc/${CHECKOUT_HOLD_PROCEDURES[0]}`).expect(200);
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
    const res = await post(app, '/trpc/checkout.createHold').send({});
    statuses.push(res.status);
  }
  expect(statuses.slice(0, CHECKOUT_HOLD_MAX)).not.toContain(429);
  expect(statuses[CHECKOUT_HOLD_MAX]).toBe(429);
});

it('the real app leaves checkout.quote unaffected by the createHold limiter', async () => {
  const app = createApp();
  for (let i = 0; i < CHECKOUT_HOLD_MAX + 5; i += 1) {
    const res = await post(app, '/trpc/checkout.quote').send({});
    expect(res.status).not.toBe(429);
  }
});

// ---------------------------------------------------------------------------
// Task 10, §7 — 5 FAILED booking-lookup attempts per IP per 15 minutes
// ---------------------------------------------------------------------------

/**
 * Unlike `appWithLimiterOnly()` above, this toy handler can answer either a
 * success or a failure on demand (`?ok=1`), because the whole point of this
 * limiter is that the two are treated differently
 * (`skipSuccessfulRequests`). Defaults to a 404 — a "failed attempt" — so
 * every test that doesn't care about the success/failure distinction still
 * exercises the budget this limiter actually enforces.
 */
function appWithLookupLimiterOnly() {
  const app = express();
  app.use(createBookingLookupLimiter());
  app.all('/trpc/*splat', (req, res) => {
    const ok = req.query.ok === '1';
    res.status(ok ? 200 : 404).json({ ok });
  });
  return app;
}

it(`allows ${BOOKING_LOOKUP_MAX} failed booking-lookup attempts per IP and refuses the next one`, async () => {
  const app = appWithLookupLimiterOnly();
  for (let i = 1; i <= BOOKING_LOOKUP_MAX; i += 1) {
    await post(app, `/trpc/${BOOKING_LOOKUP_PROCEDURES[0]}`).expect(404);
  }
  await post(app, `/trpc/${BOOKING_LOOKUP_PROCEDURES[0]}`).expect(429);
});

it('the booking-lookup limiter leaves every other procedure alone', async () => {
  const app = appWithLookupLimiterOnly();
  for (let i = 0; i < BOOKING_LOOKUP_MAX + 5; i += 1) {
    await post(app, '/trpc/checkout.quote').expect(404);
  }
});

it('gives each app its own counter, so one cannot exhaust another', async () => {
  const a = appWithLookupLimiterOnly();
  for (let i = 1; i <= BOOKING_LOOKUP_MAX; i += 1) {
    await post(a, `/trpc/${BOOKING_LOOKUP_PROCEDURES[0]}`).expect(404);
  }
  await request(appWithLookupLimiterOnly())
    .post(`/trpc/${BOOKING_LOOKUP_PROCEDURES[0]}`)
    .expect(404);
});

/**
 * Ruling 8, proven at the limiter level rather than trusted from the option
 * name: many more successes than the budget must never trip it, and the
 * real budget (failures) is exactly `BOOKING_LOOKUP_MAX` before the next
 * one is refused.
 */
it('counts failed attempts only — a successful lookup never counts against the limit', async () => {
  const app = appWithLookupLimiterOnly();
  for (let i = 0; i < BOOKING_LOOKUP_MAX * 3; i += 1) {
    await post(app, `/trpc/${BOOKING_LOOKUP_PROCEDURES[0]}?ok=1`).expect(200);
  }
  for (let i = 1; i <= BOOKING_LOOKUP_MAX; i += 1) {
    await post(app, `/trpc/${BOOKING_LOOKUP_PROCEDURES[0]}`).expect(404);
  }
  await post(app, `/trpc/${BOOKING_LOOKUP_PROCEDURES[0]}`).expect(429);
});

/**
 * The regression this whole pattern exists to catch (brief): a limiter that
 * exists but is unmounted. `appWithLookupLimiterOnly()` above cannot see
 * that — it mounts the limiter by hand regardless of app.ts's real state.
 * Only a test against `createApp()` itself proves the mount in app.ts is
 * real. An empty body fails `.input()` validation (BAD_REQUEST, a 4xx) —
 * a failed attempt either way, which is what this limiter counts.
 */
it('is actually mounted in app.ts: the real app refuses the next bookingLookup call from one IP', async () => {
  const app = createApp();
  const statuses: number[] = [];
  for (let i = 0; i < BOOKING_LOOKUP_MAX + 1; i += 1) {
    const res = await post(app, '/trpc/checkout.bookingLookup').send({});
    statuses.push(res.status);
  }
  expect(statuses.slice(0, BOOKING_LOOKUP_MAX)).not.toContain(429);
  expect(statuses[BOOKING_LOOKUP_MAX]).toBe(429);
});

it('the real app leaves checkout.quote unaffected by the booking-lookup limiter', async () => {
  const app = createApp();
  for (let i = 0; i < BOOKING_LOOKUP_MAX + 5; i += 1) {
    const res = await post(app, '/trpc/checkout.quote').send({});
    expect(res.status).not.toBe(429);
  }
});

// ---------------------------------------------------------------------------
// Final whole-branch review, F1 — the batching bypass, against the REAL app
//
// The two tests `rate-limit.test.ts` cannot write: they pin the limiter's
// handling of a 207 and of a multi-call batch using toy routes, which proves
// the mechanism but assumes the status codes. These prove that real
// `@trpc/server` really answers those shapes with those statuses, through
// `createApp()`'s real mount — which is where the hole actually was.
//
// `checkout.bookingLookup` is a QUERY, so the shape a browser (and an
// attacker) sends is a GET batch — `httpBatchLink` POSTs only mutations.
// Measured: a POST to it answers 405 (METHOD_NOT_SUPPORTED), so a test that
// drove this bypass over POST would be exercising nothing.
//
// No database: `health` needs none, and every lookup below fails Zod
// validation before the resolver runs. That is deliberate (same reasoning as
// the limiter tests above) — a DB-less run must still catch a limiter that
// fails open.
// ---------------------------------------------------------------------------

/** A GET batch, the shape `httpBatchLink` sends for queries. */
function batchPath(procedures: string[]): string {
  const input = Object.fromEntries(procedures.map((_, i) => [i, {}]));
  return `/trpc/${procedures.join(',')}?batch=1&input=${encodeURIComponent(JSON.stringify(input))}`;
}

/**
 * The exploit as reported: one failed lookup batched with one SUCCESSFUL
 * call. `getHTTPStatusCode` sees {200, 400}, answers 207, and
 * `express-rate-limit` used to read 207 as a success and hand the hit back
 * — unlimited ref-oracle attempts. MEASURED before the fix: twelve
 * consecutive 207s, never a 429.
 */
it('counts a failed lookup hidden in a mixed-status (207) batch', async () => {
  const app = createApp();
  const path = batchPath(['health', 'checkout.bookingLookup']);
  const statuses: number[] = [];
  for (let i = 0; i < BOOKING_LOOKUP_MAX + 1; i += 1) {
    statuses.push((await request(app).get(path)).status);
  }
  // The mixed batch really is a 207 — the premise of the whole finding.
  expect(statuses.slice(0, BOOKING_LOOKUP_MAX)).toEqual(Array(BOOKING_LOOKUP_MAX).fill(207));
  expect(statuses[BOOKING_LOOKUP_MAX]).toBe(429);
});

/**
 * The amplification half: N failed lookups in ONE request are N attempts,
 * not one. Three per batch against a budget of five means the second batch
 * crosses it. MEASURED before the fix: four batches (twelve failed lookups)
 * and never a 429.
 */
it('spends the lookup budget per failed call, not per batched request', async () => {
  const app = createApp();
  const path = batchPath(Array(3).fill(BOOKING_LOOKUP_PROCEDURES[0]));
  const first = await request(app).get(path);
  const second = await request(app).get(path);
  // Uniform statuses across the batch, so tRPC answers the shared 400 —
  // which is why counting "one 4xx per request" saw one attempt, not three.
  expect(first.status).toBe(400);
  expect(second.status).toBe(429);
});

/**
 * The same amplification against the owner's "5 hold creations per IP per
 * 15 minutes" (Ruling 5 / Q4). `createHold` is a mutation, so this one is a
 * POST batch — the shape `httpBatchLink` really sends for it. Six calls in
 * one request exceed the budget inside that single request.
 */
it('spends the createHold budget per batched call, not per request', async () => {
  const app = createApp();
  const calls = Array(CHECKOUT_HOLD_MAX + 1).fill(CHECKOUT_HOLD_PROCEDURES[0]);
  const body = Object.fromEntries(calls.map((_, i) => [i, {}]));
  const res = await request(app)
    .post(`/trpc/${calls.join(',')}?batch=1`)
    .set('Origin', BROWSER_ORIGIN)
    .send(body);
  expect(res.status).toBe(429);
});
