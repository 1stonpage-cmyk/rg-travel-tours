/**
 * Bug 1B: `checkout.createHold` and `checkout.createHoldTransfer` now sign the
 * guest in the instant their hold commits — the exact mechanism
 * `portal.login` already uses (`createSession('customer', bookingId, now)` +
 * `setSessionCookie`), run once more here rather than reimplemented. Before
 * this, a guest who had just created a hold was sent to `/portal/login` to
 * re-prove a ref + email they had typed moments earlier.
 *
 * **What is under test here, and what is NOT.** `create-hold.test.ts` and
 * `transfer-create-booking.test.ts` already pin every money/capacity/coupon
 * rule of the two services; `checkout-router.test.ts` and
 * `checkout-create-hold-transfer.test.ts` already pin the translation layer.
 * This file is narrowly about the ONE new thing: that a successful hold sets
 * exactly one cookie, scoped to that one booking, on the EXISTING
 * `rg_customer_session` surface — and that a refused hold sets none at all.
 *
 * `fakeResponse()` / `callerWithCookies()` are `portal-login.test.ts`'s own
 * pattern, copied rather than reinvented, for the same reason that file gives:
 * a test needs to OBSERVE `res.cookie()` calls, which `helpers/ctx.ts`'s
 * `testContext()` deliberately discards.
 */
import { afterEach, beforeAll, expect, it } from 'vitest';
import type { Request, Response } from 'express';
import { eq } from 'drizzle-orm';
import { manilaCivilDate } from '@rg/shared';
import { getDb, getPool } from '../db/client';
import {
  destinations,
  drivers,
  tourPriceTiers,
  tours,
  transferPlaces,
  transferRouteVehiclePrices,
  transferRoutes,
  vans,
  vehicleTypes,
} from '../db/schema';
import { SESSION_COOKIE_BY_SUBJECT } from '../middleware/session-cookie';
import { appRouter } from '../routers/_app';
import { readSession } from '../services/sessions';
import { describeWithDb } from './helpers/db';

/** Thirty days out, same offset `checkout-router.test.ts`'s own `DAY` uses. */
const DAY = manilaCivilDate(new Date(Date.now() + 30 * 86_400_000));

const created = {
  bookingIds: [] as number[],
  tourIds: [] as number[],
  destinationIds: [] as number[],
  vanIds: [] as number[],
  driverIds: [] as number[],
  routeIds: [] as number[],
  placeIds: [] as number[],
};

const unique = () => `${Math.floor(Math.random() * 1e9)}_${Date.now()}`;

let guestSeq = 0;
let VAN_TYPE_ID = 0;

async function vanVehicleTypeId(): Promise<number> {
  const [row] = await getDb()
    .select({ id: vehicleTypes.id })
    .from(vehicleTypes)
    .where(eq(vehicleTypes.slug, 'van'))
    .limit(1);
  if (!row) throw new Error('No vehicle_types row for slug "van" — expected from seedBase.');
  return row.id;
}

/** Captures every `res.cookie()` / `res.clearCookie()` call a resolver makes. */
function fakeResponse() {
  const cookies: Array<{ name: string; value: string }> = [];
  const res = {
    cookie: (name: string, value: string) => void cookies.push({ name, value }),
    clearCookie: (name: string) => void cookies.push({ name, value: '' }),
  } as unknown as Response;
  return { res, cookies };
}

/** A caller on the real `appRouter`, anonymous, whose Set-Cookie calls are observable. */
function callerWithCookies() {
  const { res, cookies } = fakeResponse();
  return {
    cookies,
    api: appRouter.createCaller({
      req: { ip: '127.0.0.1' } as unknown as Request,
      res,
      customerSession: null,
    } as never),
  };
}

// ---------------------------------------------------------------------------
// Tour fixtures — the same shape `checkout-router.test.ts` builds.
// ---------------------------------------------------------------------------

async function makeTour(pricePerPersonCentavos = 100000) {
  const db = getDb();
  const slug = `__hold_session__${unique()}`;
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
    minPax: 1,
    maxPax: 12,
    pricePerPersonCentavos,
  });
  return { tourId: tour.insertId, slug };
}

async function makeFleet() {
  const suffix = unique();
  const [van] = await getDb()
    .insert(vans)
    .values({
      plate: `HS${suffix}`.slice(0, 20),
      model: 'Hold-Session Fixture Van',
      capacity: 12,
      vehicleTypeId: VAN_TYPE_ID,
      status: 'available',
      isActive: true,
    });
  created.vanIds.push(van.insertId);
  const [driver] = await getDb()
    .insert(drivers)
    .values({
      name: `Hold-Session Fixture Driver ${suffix}`,
      code: `HS${suffix}`.slice(0, 20),
      phone: '09170000000',
      pinHash: '__hs_not_a_pin_hash__',
      maxTransferJobsPerDay: 8,
      isActive: true,
    });
  created.driverIds.push(driver.insertId);
}

function validHoldInput(over: { tourSlug: string; date: string; pax: number; quoteId: string }) {
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
      email: `hold_session_${guestSeq}_${Date.now()}@example.test`,
      phone: `0917${String(1_000_000 + guestSeq).slice(-7)}`,
    },
    pickup: 'SM City Cebu, north entrance',
    consent: true,
  };
}

async function holdTour() {
  const tour = await makeTour();
  await makeFleet();
  const { api } = callerWithCookies();
  const quote = await api.checkout.quote({ tourSlug: tour.slug, date: DAY, pax: 2, addonIds: [] });
  const { api: api2, cookies } = callerWithCookies();
  const result = await api2.checkout.createHold(
    validHoldInput({ tourSlug: tour.slug, date: DAY, pax: 2, quoteId: quote.quoteId }),
  );
  created.bookingIds.push(result.bookingId);
  return { result, cookies };
}

// ---------------------------------------------------------------------------
// Transfer fixtures — the same shape `checkout-create-hold-transfer.test.ts` builds.
// ---------------------------------------------------------------------------

async function makePlace() {
  const slug = `__hs_place__${unique()}`;
  const [row] = await getDb()
    .insert(transferPlaces)
    .values({ name: slug, nameKey: slug.toLowerCase(), isActive: true });
  created.placeIds.push(row.insertId);
  return row.insertId;
}

async function makeRoute() {
  const fromPlaceId = await makePlace();
  const toPlaceId = await makePlace();
  const [route] = await getDb()
    .insert(transferRoutes)
    .values({
      fromPlaceId,
      toPlaceId,
      slug: `hs-${unique()}`,
      estimatedDurationMinutes: 120,
      freeCancelHours: 24,
      isActive: true,
      reverseEnabled: true,
    });
  created.routeIds.push(route.insertId);
  await getDb().insert(transferRouteVehiclePrices).values({
    routeId: route.insertId,
    vehicleTypeId: VAN_TYPE_ID,
    oneWayPriceCentavos: 350000,
    dayUsePriceCentavos: 650000,
  });
  return route.insertId;
}

function transferHoldInput(over: { routeId: number }) {
  guestSeq += 1;
  return {
    routeId: over.routeId,
    vehicleTypeId: VAN_TYPE_ID,
    direction: 'forward' as const,
    productType: 'transfer_one_way' as const,
    date: DAY,
    pickupTime: '08:00',
    pax: 3,
    luggageCount: 2,
    pickup: 'Mactan-Cebu International Airport, Terminal 2 arrivals',
    dropoffAddress: 'Shangri-La Mactan, Punta Engaño Road',
    flightNumber: '5J 561',
    airline: 'Cebu Pacific',
    requests: 'One child seat please.',
    payMode: 'full' as const,
    lead: {
      name: 'Juan Dela Cruz',
      email: `hold_session_t_${guestSeq}_${Date.now()}@example.test`,
      phone: `0917${String(1_000_000 + guestSeq).slice(-7)}`,
    },
    consent: true,
  };
}

async function holdTransfer() {
  const routeId = await makeRoute();
  await makeFleet();
  const { api, cookies } = callerWithCookies();
  const result = await api.checkout.createHoldTransfer(transferHoldInput({ routeId }) as never);
  created.bookingIds.push(result.bookingId);
  return { result, cookies };
}

async function cleanup() {
  const pool = getPool();
  const db = getDb();
  for (const id of created.bookingIds) {
    await pool.query('DELETE FROM sessions WHERE subject_type = ? AND subject_id = ?', [
      'customer',
      id,
    ]);
    await pool.query('DELETE FROM booking_transfer_details WHERE booking_id = ?', [id]);
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
  for (const id of created.routeIds) {
    await db.delete(transferRouteVehiclePrices).where(eq(transferRouteVehiclePrices.routeId, id));
    await db.delete(transferRoutes).where(eq(transferRoutes.id, id));
  }
  for (const id of created.placeIds) {
    await db.delete(transferPlaces).where(eq(transferPlaces.id, id));
  }
  for (const id of created.driverIds) await db.delete(drivers).where(eq(drivers.id, id));
  for (const id of created.vanIds) await db.delete(vans).where(eq(vans.id, id));
  await pool.query('DELETE FROM fleet_date_slots WHERE date = ?', [DAY]);
  created.bookingIds = [];
  created.tourIds = [];
  created.destinationIds = [];
  created.vanIds = [];
  created.driverIds = [];
  created.routeIds = [];
  created.placeIds = [];
}

describeWithDb('checkout.createHold / createHoldTransfer — Bug 1B session', () => {
  beforeAll(async () => {
    VAN_TYPE_ID = await vanVehicleTypeId();
  });

  afterEach(cleanup);

  // -------------------------------------------------------------------------
  // 1 & 2 — a successful hold mints exactly one, correctly-scoped cookie.
  // -------------------------------------------------------------------------

  it('createHold sets exactly one rg_customer_session cookie, scoped to the new booking', async () => {
    const { result, cookies } = await holdTour();

    expect(cookies).toHaveLength(1);
    expect(cookies[0]!.name).toBe(SESSION_COOKIE_BY_SUBJECT.customer);
    expect(await readSession(cookies[0]!.value, new Date())).toEqual({
      subjectType: 'customer',
      subjectId: result.bookingId,
    });
  });

  it('createHoldTransfer sets exactly one rg_customer_session cookie, scoped to the new booking', async () => {
    const { result, cookies } = await holdTransfer();

    expect(cookies).toHaveLength(1);
    expect(cookies[0]!.name).toBe(SESSION_COOKIE_BY_SUBJECT.customer);
    expect(await readSession(cookies[0]!.value, new Date())).toEqual({
      subjectType: 'customer',
      subjectId: result.bookingId,
    });
  });

  // -------------------------------------------------------------------------
  // 3 — fail-closed: a refused hold sets NO cookie at all, on either mutation.
  //
  // The trigger is an empty fleet. CLAUDE.md: "The test database keeps an
  // EMPTY fleet" — so simply not calling a fleet fixture is a deterministic
  // capacity refusal, thrown from INSIDE createHoldService/createTransferBooking's
  // own try block (unlike a Turnstile refusal, which is checked before the
  // try block and so could never exercise a bug in where the cookie code sits
  // relative to that call).
  //
  // **Proven able to fail** (manual exercise, not committed): temporarily
  // moving the `createSession`/`setSessionCookie` lines in `checkout.ts` to
  // run BEFORE `createHoldService(input)` / `createTransferBooking(...)`
  // turns both of these red — a cookie is set despite the capacity refusal —
  // and restoring the original order (mint AFTER the awaited service call,
  // inside the same `try`) turns them green again.
  // -------------------------------------------------------------------------

  it('createHold sets no cookie when the hold is refused (no fleet)', async () => {
    const tour = await makeTour();
    const { api, cookies } = callerWithCookies();
    const quote = await api.checkout.quote({
      tourSlug: tour.slug,
      date: DAY,
      pax: 2,
      addonIds: [],
    });

    const error = await api.checkout
      .createHold(
        validHoldInput({ tourSlug: tour.slug, date: DAY, pax: 2, quoteId: quote.quoteId }),
      )
      .catch((e: unknown) => e);

    expect(error).toMatchObject({ code: 'BAD_REQUEST' });
    expect(cookies, 'a refused hold must set no cookie at all').toHaveLength(0);
  });

  it('createHoldTransfer sets no cookie when the hold is refused (no fleet)', async () => {
    const routeId = await makeRoute();
    const { api, cookies } = callerWithCookies();

    const error = await api.checkout
      .createHoldTransfer(transferHoldInput({ routeId }) as never)
      .catch((e: unknown) => e);

    expect(error).toMatchObject({ code: 'BAD_REQUEST' });
    expect(cookies, 'a refused hold must set no cookie at all').toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // 4 — scope: the minted session reaches exactly the booking it was minted
  // for, and nothing else, through the real customer-only surface.
  // -------------------------------------------------------------------------

  it('the minted session resolves to the SAME booking through portal.booking, not some other one', async () => {
    const other = await holdTour(); // a second, unrelated booking — never reached below.
    const { result, cookies } = await holdTour();

    const session = await readSession(cookies[0]!.value, new Date());
    const portalApi = appRouter.createCaller({
      req: {} as unknown as Request,
      res: fakeResponse().res,
      customerSession: session,
    } as never);

    const booking = await portalApi.portal.booking();
    expect(booking.ref).toBe(result.ref);
    expect(booking.ref).not.toBe(other.result.ref);
  });

  // -------------------------------------------------------------------------
  // 5 — staff/driver cookies untouched (trivial given #1/#2, asserted
  // explicitly per the task's own instruction).
  // -------------------------------------------------------------------------

  it('a successful hold never sets the staff or driver cookie', async () => {
    const { cookies } = await holdTour();
    expect(cookies.some((c) => c.name === SESSION_COOKIE_BY_SUBJECT.user)).toBe(false);
    expect(cookies.some((c) => c.name === SESSION_COOKIE_BY_SUBJECT.driver)).toBe(false);
  });

  it('a successful transfer hold never sets the staff or driver cookie', async () => {
    const { cookies } = await holdTransfer();
    expect(cookies.some((c) => c.name === SESSION_COOKIE_BY_SUBJECT.user)).toBe(false);
    expect(cookies.some((c) => c.name === SESSION_COOKIE_BY_SUBJECT.driver)).toBe(false);
  });
});
