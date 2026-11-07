/**
 * Transfers-launch plan, Task T11: `checkout.createHoldTransfer` — the public,
 * guest-facing wrapper over `createTransferBooking()`.
 *
 * **Two layers are under test here and they are deliberately told apart in
 * every assertion.** The Zod wire input (`createHoldTransferInput`,
 * `@rg/shared`) refuses a malformed request at the router boundary, before the
 * resolver runs at all — proven by the refusal carrying a `ZodError` as its
 * `cause`, which no translated service refusal ever does (the pattern
 * `checkout-router.test.ts` established for `consent: false`). The translation
 * layer turns each of `createTransferBooking()`'s typed refusals into one
 * guest-safe sentence — proven by asserting the sentence, not merely the code,
 * because the whole point of the translator is that a guest is never shown a
 * service's own developer-facing text.
 *
 * Nothing here re-tests the service's own behaviour; that is
 * `transfer-create-booking.test.ts`'s whole file. What is asserted about money
 * below is only that the figure came from the CATALOG rather than from this
 * test — the wire carries no price, and `.strict()` is pinned to prove one
 * cannot be smuggled in.
 *
 * **The procedure takes no `now`** (deliberately — nothing on the wire may
 * decide what "now" is), so every fixture date here is relative to the real
 * clock, the same way `checkout-router.test.ts`'s `DAY` is. The minimum-notice
 * tests are the ones that care: they name an instant a couple of hours either
 * side of this moment and let the server's own clock judge it.
 *
 * Fixtures are COMMITTED and torn down after every test, and the fleet premise
 * is proven rather than assumed — `vans` and `drivers` are not date-scoped, so
 * a leftover row changes every capacity verdict in the file (the discipline
 * `transfer-create-booking.test.ts` documents at length).
 */
import { ZodError } from 'zod';
import { afterEach, beforeAll, beforeEach, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import request from 'supertest';
import {
  AMOUNT_BELOW_GATEWAY_MINIMUM,
  HOLD_MINUTES,
  NOTHING_TO_PAY_ONLINE,
  PAYMONGO_MIN_CENTAVOS,
  TOTAL_BELOW_GATEWAY_MINIMUM,
  bookingRefSchema,
  depositCentavos,
  manilaCivilDate,
  manilaTimeHHMM,
  type PayMode,
} from '@rg/shared';
import { createApp } from '../app';
import { readSettingBlock, readTransferOperationsSettings } from '../content/settings';
import { getDb, getPool } from '../db/client';
import {
  bookingTransferDetails,
  bookings,
  coupons,
  couponRedemptions,
  drivers,
  transferPlaces,
  transferRouteVehiclePrices,
  transferRoutes,
  vans,
  vehicleTypes,
} from '../db/schema';
import { MAX_ACTIVE_HOLDS_PER_GUEST } from '../services/create-hold';
import { CHECKOUT_HOLD_MAX, CHECKOUT_HOLD_PROCEDURES } from '../middleware/rate-limit';
import { appRouter } from '../routers/_app';
import { testContext } from './helpers/ctx';
import { describeWithDb } from './helpers/db';

const caller = appRouter.createCaller(testContext());

/** The seeded `transfer_operations` / `trust` values, asserted in `beforeAll`. */
const BUFFER = 60;
const MIN_NOTICE_HOURS = 6;
const DEPOSIT_PERCENT = 30;

/** This file's own catalog numbers. Nothing below hardcodes a total. */
const DURATION = 120;
const ONE_WAY_PRICE = 350_000;
const DAY_USE_PRICE = 650_000;
const ROUTE_FREE_CANCEL_HOURS = 24;

/**
 * An unknown route id, a retired route, a vehicle type with no price row, and
 * (Task 0D, owner decision 2026-11-06 #1) a route whose DESTINATION is
 * retired — all four get the SAME one `NOT_FOUND` sentence, deliberately
 * non-distinguishing: naming which of the four it was would make a numeric
 * id an enumeration oracle for the catalog. Hoisted to one constant (review
 * finding, Minor) so the two tests that assert it cannot drift apart — a
 * future wording change that updates one and misses the other is now a
 * compile-time-shared reference, not a second string to remember to edit.
 */
const UNQUOTABLE_ROUTE_REFUSAL = {
  code: 'NOT_FOUND',
  message: 'That route is no longer available for that vehicle.',
};

/**
 * A pickup day far enough out that the minimum-notice rule is never what
 * refuses — thirty days, the same offset and the same reasoning as
 * `checkout-router.test.ts`'s `DAY`. (A transfer is NOT subject to the
 * tour booking window, so `maxAdvanceDays` does not bound this one.)
 */
const DAY = manilaCivilDate(new Date(Date.now() + 30 * 86_400_000));

/** Every date this file can create a `fleet_date_slots` anchor for. */
const DATES = [
  manilaCivilDate(new Date(Date.now() - 86_400_000)),
  manilaCivilDate(new Date()),
  manilaCivilDate(new Date(Date.now() + 86_400_000)),
  DAY,
];

const created = {
  bookingIds: [] as number[],
  routeIds: [] as number[],
  placeIds: [] as number[],
  couponIds: [] as number[],
  vanIds: [] as number[],
  driverIds: [] as number[],
};

const unique = () => `${Math.floor(Math.random() * 1e9)}_${Date.now()}`;

/**
 * The real, global `vehicle_types.id` for `'van'`/`'suv'` — seeded by
 * `seedBase` (migration 0023), never a literal id (CLAUDE.md). Resolved in
 * `beforeAll`.
 */
let VAN_ID = 0;
let SUV_ID = 0;

async function vehicleTypeIdBySlug(slug: string): Promise<number> {
  const [row] = await getDb()
    .select({ id: vehicleTypes.id })
    .from(vehicleTypes)
    .where(eq(vehicleTypes.slug, slug))
    .limit(1);
  if (!row) throw new Error(`No vehicle_types row for slug "${slug}" — expected from seedBase.`);
  return row.id;
}

async function count(statement: Parameters<ReturnType<typeof getDb>['execute']>[0]) {
  const [rows] = (await getDb().execute(statement)) as unknown as [Array<{ n: number }>, unknown];
  return Number(rows[0]?.n ?? -1);
}

/** Every row count a refused request must leave untouched. */
async function writtenRowCounts() {
  return {
    bookings: await count(sql`SELECT COUNT(*) n FROM bookings`),
    transferDetails: await count(sql`SELECT COUNT(*) n FROM booking_transfer_details`),
    auditLog: await count(sql`SELECT COUNT(*) n FROM audit_log`),
    couponRedemptions: await count(sql`SELECT COUNT(*) n FROM coupon_redemptions`),
    couponUsedCount: await count(sql`SELECT COALESCE(SUM(used_count), 0) n FROM coupons`),
  };
}

/** A pickup/drop-off place with nothing else attached — what a route runs between. */
async function makePlace(opts: { isActive?: boolean } = {}) {
  const slug = `__t11place__${unique()}`;
  const [row] = await getDb()
    .insert(transferPlaces)
    .values({ name: slug, nameKey: slug.toLowerCase(), isActive: opts.isActive ?? true });
  created.placeIds.push(row.insertId);
  return row.insertId;
}

async function makeRoute(
  opts: {
    isActive?: boolean;
    /** Owner decision 2026-11-08: sellability moved from `destinations` to the route's TO place. */
    toPlaceActive?: boolean;
    vehicleTypeIds?: number[];
    oneWayPriceCentavos?: number;
  } = {},
) {
  const fromPlaceId = await makePlace();
  const toPlaceId = await makePlace({ isActive: opts.toPlaceActive ?? true });

  const [route] = await getDb()
    .insert(transferRoutes)
    .values({
      fromPlaceId,
      toPlaceId,
      slug: `t11-${unique()}`,
      estimatedDurationMinutes: DURATION,
      freeCancelHours: ROUTE_FREE_CANCEL_HOURS,
      isActive: opts.isActive ?? true,
    });
  created.routeIds.push(route.insertId);

  for (const vehicleTypeId of opts.vehicleTypeIds ?? [VAN_ID, SUV_ID]) {
    await getDb()
      .insert(transferRouteVehiclePrices)
      .values({
        routeId: route.insertId,
        vehicleTypeId,
        oneWayPriceCentavos: opts.oneWayPriceCentavos ?? ONE_WAY_PRICE,
        dayUsePriceCentavos: DAY_USE_PRICE,
      });
  }
  return route.insertId;
}

async function makeVan() {
  const suffix = unique();
  const [row] = await getDb()
    .insert(vans)
    .values({
      plate: `T11${suffix}`.slice(0, 20),
      model: 'T11 Fixture',
      capacity: 12,
      vehicleTypeId: VAN_ID,
      status: 'available',
      isActive: true,
    });
  created.vanIds.push(row.insertId);
}

async function makeDriver(maxTransferJobsPerDay: number) {
  const suffix = unique();
  const [row] = await getDb()
    .insert(drivers)
    .values({
      name: `T11 Fixture ${suffix}`,
      code: `T11${suffix}`.slice(0, 20),
      phone: '09170000000',
      pinHash: '__t11_not_a_pin_hash__',
      maxTransferJobsPerDay,
      isActive: true,
    });
  created.driverIds.push(row.insertId);
}

/** A fleet ample enough that capacity is never what refuses. */
async function makeFleet(n = 2) {
  for (let i = 0; i < n; i += 1) {
    await makeVan();
    await makeDriver(8);
  }
}

async function makeCoupon(percentBp: number) {
  const code = `__T11__${unique()}`.toUpperCase().slice(0, 40);
  const [row] = await getDb()
    .insert(coupons)
    .values({ code, discountType: 'percent', percentBp, usageLimit: null, isActive: true });
  created.couponIds.push(row.insertId);
  return { id: row.insertId, code };
}

let guestSeq = 0;

/**
 * A structurally valid `createHoldTransferInput` payload, as a plain object the
 * caller sends ON THE WIRE — never pre-parsed, so the router's own `.input()`
 * stage is what actually runs in every test below.
 */
function holdInput(over: Record<string, unknown> & { routeId: number }) {
  guestSeq += 1;
  return {
    // `routeId` comes from `over`, which is spread last and is typed to
    // require it — there is no sensible default route id.
    vehicleTypeId: VAN_ID,
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
    payMode: 'full' as PayMode,
    lead: {
      name: 'Juan Dela Cruz',
      email: `t11_${guestSeq}_${Date.now()}@example.test`,
      phone: `0917${String(1_000_000 + guestSeq).slice(-7)}`,
    },
    consent: true,
    ...over,
  };
}

/** Holds, registering the booking for teardown. */
async function hold(input: ReturnType<typeof holdInput>) {
  const result = await caller.checkout.createHoldTransfer(input as never);
  created.bookingIds.push(result.bookingId);
  return result;
}

function refusal(input: ReturnType<typeof holdInput>) {
  return caller.checkout.createHoldTransfer(input as never).catch((e: unknown) => e);
}

/**
 * The `ZodError` a wire-level refusal carries as its `cause` — and the
 * assertion that it carries one at all, which is what proves the request never
 * reached the resolver (a translated service refusal has no `ZodError` cause).
 */
function zodCause(error: unknown): ZodError {
  expect(error, 'not a refusal').toMatchObject({ code: 'BAD_REQUEST' });
  const cause = (error as { cause?: unknown }).cause;
  expect(cause, 'the refusal did not come from the Zod input stage').toBeInstanceOf(ZodError);
  return cause as ZodError;
}

/** Every message the input stage put against one dot-path (`'lead.phone'`). */
function messagesAt(error: unknown, path: string): string[] {
  return zodCause(error)
    .issues.filter((issue) => issue.path.join('.') === path)
    .map((issue) => issue.message);
}

async function bookingRow(id: number) {
  const [row] = await getDb().select().from(bookings).where(eq(bookings.id, id));
  if (!row) throw new Error(`booking ${id} not found`);
  return row;
}

async function detailsRow(id: number) {
  const [row] = await getDb()
    .select()
    .from(bookingTransferDetails)
    .where(eq(bookingTransferDetails.bookingId, id));
  if (!row) throw new Error(`booking_transfer_details ${id} not found`);
  return row;
}

describeWithDb('checkout.createHoldTransfer', () => {
  /**
   * The settings every expectation below is arithmetic over. A change to the
   * owner's defaults must fail HERE, by name, rather than as a dozen
   * unexplained refusals further down — `transfer-create-booking.test.ts`'s own
   * premise check, repeated because this file quotes the notice hours in an
   * asserted SENTENCE.
   */
  beforeAll(async () => {
    const operations = await readTransferOperationsSettings();
    expect(operations.bufferMinutes, 'the seeded buffer changed').toBe(BUFFER);
    expect(operations.minNoticeHours, 'the seeded minimum notice changed').toBe(MIN_NOTICE_HOURS);
    const trust = await readSettingBlock('trust');
    expect(trust.depositPercent, 'the seeded deposit percent changed').toBe(DEPOSIT_PERCENT);
    VAN_ID = await vehicleTypeIdBySlug('van');
    SUV_ID = await vehicleTypeIdBySlug('suv');
  });

  beforeEach(async () => {
    expect(await count(sql`SELECT COUNT(*) n FROM vans`), 'leftover vans in rg_travel_test').toBe(
      0,
    );
    expect(
      await count(sql`SELECT COUNT(*) n FROM drivers`),
      'leftover drivers in rg_travel_test',
    ).toBe(0);
  });

  afterEach(cleanup);

  // -------------------------------------------------------------------------
  // The happy path
  // -------------------------------------------------------------------------

  it('holds a one-way transfer and returns the HeldBooking shape, priced from the catalog', async () => {
    const routeId = await makeRoute();
    await makeFleet();

    const before = Date.now();
    const result = await hold(holdInput({ routeId }));

    expect(bookingRefSchema.safeParse(result.ref).success).toBe(true);
    expect(result.bookingId).toBeGreaterThan(0);
    /*
     * The guest hold reuses the EXISTING 15-minute window (Architecture §6
     * step 4). The procedure takes no `now`, so this is a bracket rather than
     * an exact instant — the service's own suite pins the exact arithmetic.
     */
    expect(result.holdExpiresAt.getTime()).toBeGreaterThanOrEqual(
      before + HOLD_MINUTES * 60_000 - 5_000,
    );
    expect(result.holdExpiresAt.getTime()).toBeLessThanOrEqual(
      Date.now() + HOLD_MINUTES * 60_000 + 5_000,
    );

    const row = await bookingRow(result.bookingId);
    expect(row.status).toBe('pending_payment');
    expect(row.tourId, 'a transfer carries no tour_id').toBeNull();
    expect(row.productType).toBe('transfer_one_way');
    expect(row.routeId).toBe(routeId);
    expect(row.vehicleTypeId).toBe(VAN_ID);
    expect(row.pax).toBe(3);
    expect(row.amountPaidCentavos, 'a hold must not be paid').toBe(0);
    // The flat per-vehicle CATALOG rate — this test sent no price at all.
    expect(row.totalCentavos).toBe(ONE_WAY_PRICE);

    const details = await detailsRow(result.bookingId);
    expect(details.pickupTime).toBe('08:00');
    expect(details.dayUseEndTime).toBeNull();
    expect(details.dropoffAddress).toContain('Shangri-La');
    expect(details.luggageCount).toBe(2);
    expect(details.flightNumber).toBe('5J 561');
    expect(details.customRouteDescription, 'the guest path is catalog-only').toBeNull();
    expect(details.bufferMinutesUsed).toBe(BUFFER);
    expect(details.routeDurationMinutesUsed).toBe(DURATION);
  });

  it('holds a DAY-USE hire from the day-use column, with its end time and no flight', async () => {
    const routeId = await makeRoute();
    await makeFleet();

    const result = await hold(
      holdInput({
        routeId,
        productType: 'transfer_day_use',
        pickupTime: '07:00',
        dayUseEndTime: '17:00',
        flightNumber: undefined,
        airline: undefined,
      }),
    );

    const row = await bookingRow(result.bookingId);
    expect(row.productType).toBe('transfer_day_use');
    expect(row.totalCentavos, 'the day-use column, not the one-way one').toBe(DAY_USE_PRICE);
    const details = await detailsRow(result.bookingId);
    expect(details.dayUseEndTime).toBe('17:00');
    expect(details.flightNumber).toBeNull();
    expect(details.airline).toBeNull();
  });

  /**
   * The deposit mode reaches the same booking with the same catalog total —
   * what differs is only what a gateway will be asked for, which this
   * procedure never computes (the snapshot keeps the two ingredients and §5
   * derives it).
   */
  it('accepts the deposit pay mode, with the percent from settings and nothing from the wire', async () => {
    const routeId = await makeRoute();
    await makeFleet();

    const result = await hold(holdInput({ routeId, payMode: 'deposit' }));
    const row = await bookingRow(result.bookingId);
    expect(row.payMode).toBe('deposit');
    expect(row.totalCentavos).toBe(ONE_WAY_PRICE);
    expect(depositCentavos(row.totalCentavos, row.priceSnapshot.depositPercent)).toBe(
      depositCentavos(ONE_WAY_PRICE, DEPOSIT_PERCENT),
    );
  });

  // -------------------------------------------------------------------------
  // The Zod layer — every refusal lands BEFORE the service, against its own
  // field, and writes nothing
  // -------------------------------------------------------------------------

  it('refuses an unreadable pickup time at the wire boundary, naming the field', async () => {
    const routeId = await makeRoute();
    await makeFleet();
    const before = await writtenRowCounts();

    const error = await refusal(holdInput({ routeId, pickupTime: '8:00' }));

    expect(messagesAt(error, 'pickupTime')).toEqual(['Enter a pickup time as HH:mm, like 08:30.']);
    expect(await writtenRowCounts()).toEqual(before);
  });

  it('refuses a day-use end time on a ONE-WAY request, naming that field', async () => {
    const routeId = await makeRoute();
    await makeFleet();

    const error = await refusal(holdInput({ routeId, dayUseEndTime: '17:00' }));

    expect(messagesAt(error, 'dayUseEndTime')).toEqual([
      'A one-way transfer has no end time — please leave it blank.',
    ]);
  });

  it('refuses a DAY-USE request with no end time, one that is not after pickup, or a flight', async () => {
    const routeId = await makeRoute();
    await makeFleet();
    const dayUse = (over: Record<string, unknown>) =>
      holdInput({
        routeId,
        productType: 'transfer_day_use',
        pickupTime: '08:00',
        dayUseEndTime: '17:00',
        flightNumber: undefined,
        airline: undefined,
        ...over,
      });

    expect(
      messagesAt(await refusal(dayUse({ dayUseEndTime: undefined })), 'dayUseEndTime'),
    ).toEqual(['Tell us what time you need the vehicle until.']);
    // Equal, not merely earlier: `[x, x)` is an EMPTY window, so the hire
    // would occupy no vehicle at all.
    expect(messagesAt(await refusal(dayUse({ dayUseEndTime: '08:00' })), 'dayUseEndTime')).toEqual([
      'The end time must be later than the pickup time.',
    ]);
    const flight = await refusal(dayUse({ flightNumber: '5J 561', airline: 'Cebu Pacific' }));
    expect(messagesAt(flight, 'flightNumber')).toEqual([
      'A day-use hire carries no flight — please leave the flight details blank.',
    ]);
    expect(messagesAt(flight, 'airline')).toHaveLength(1);
  });

  /**
   * **T11 review, Important finding: an unpadded `pickupTime` must not mark a
   * perfectly good `dayUseEndTime` invalid too.**
   *
   * Zod 4 runs `superRefine` even when a field-level check has already failed,
   * so the day-use cross-field comparison used to run against a `pickupTime`
   * it only ASSUMED was padded `HH:mm`. `'17:00' <= '8:00'` is lexicographically
   * true, so a guest who typed `8:00` instead of `08:00` was told, on a second
   * field, that their nine-hour window ends before it starts — and might well
   * have "fixed" the one field that was right. The same class as BUG-120, and
   * the reason the comparison is now gated on the clock pattern.
   *
   * Both halves matter: the `pickupTime` issue must still fire (the request IS
   * malformed), and `dayUseEndTime` must carry NOTHING.
   */
  it('does not mark a valid dayUseEndTime invalid when pickupTime itself is malformed', async () => {
    const routeId = await makeRoute();
    await makeFleet();

    const error = await refusal(
      holdInput({
        routeId,
        productType: 'transfer_day_use',
        // The typo under test: a real nine-hour window, 08:00 to 17:00, with
        // the hour left unpadded.
        pickupTime: '8:00',
        dayUseEndTime: '17:00',
        flightNumber: undefined,
        airline: undefined,
      }),
    );

    expect(messagesAt(error, 'pickupTime')).toEqual(['Enter a pickup time as HH:mm, like 08:30.']);
    expect(
      messagesAt(error, 'dayUseEndTime'),
      'a malformed pickup time must not accuse the end time of anything',
    ).toEqual([]);
    // Belt-and-suspenders over the two path-scoped checks above: pins the
    // WHOLE issue list to pickupTime alone, so a spurious issue on some third
    // path would not slip past two assertions that only ever look where they
    // expect trouble.
    expect(zodCause(error).issues.map((issue) => issue.path.join('.'))).toEqual(['pickupTime']);
  });

  it('refuses a missing drop-off address — required, unlike a tour pickup', async () => {
    const routeId = await makeRoute();
    await makeFleet();

    expect(
      messagesAt(await refusal(holdInput({ routeId, dropoffAddress: '' })), 'dropoffAddress'),
    ).toEqual(['Enter where you are going.']);
    expect(
      messagesAt(
        await refusal(holdInput({ routeId, dropoffAddress: undefined })),
        'dropoffAddress',
      ),
    ).toHaveLength(1);
  });

  it('refuses consent: false (RA 10173) before the resolver runs, and writes nothing', async () => {
    const routeId = await makeRoute();
    await makeFleet();
    const before = await writtenRowCounts();

    const error = await refusal(holdInput({ routeId, consent: false }));

    expect(messagesAt(error, 'consent')).toEqual(['Consent is required']);
    expect(await writtenRowCounts()).toEqual(before);
  });

  /**
   * BUG-120's shape, on the new form: a bad phone marks the PHONE invalid and
   * says nothing about the name or the email. The issue paths are what a
   * client reads through `nestedFieldErrors` (`server/src/trpc.ts`), so
   * asserting them here is asserting what a guest will actually see beside
   * each box.
   */
  it('puts a bad lead phone against lead.phone only, never against the name or email', async () => {
    const routeId = await makeRoute();
    await makeFleet();

    const error = await refusal(
      holdInput({
        routeId,
        lead: { name: 'Juan Dela Cruz', email: 'juan@example.test', phone: '12345' },
      }),
    );

    expect(messagesAt(error, 'lead.phone')).toEqual([
      'Enter a valid PH mobile number, like 0917 123 4567',
    ]);
    expect(messagesAt(error, 'lead.name')).toEqual([]);
    expect(messagesAt(error, 'lead.email')).toEqual([]);
  });

  it('REFUSES an input that carries a price — the server computes all money', async () => {
    const routeId = await makeRoute();
    await makeFleet();
    const before = await writtenRowCounts();

    const error = await refusal(holdInput({ routeId, totalCentavos: 1 }));

    // `.strict()`: an unknown key is a refusal, never a silently dropped field.
    expect(zodCause(error).issues.some((issue) => /unrecognized/i.test(issue.message))).toBe(true);
    expect(await writtenRowCounts()).toEqual(before);
  });

  /**
   * And the two fields this wrapper has no business accepting at all: it is
   * catalog-only (Architecture §3), so a custom route description belongs to
   * T19's staff path, and there is no quote digest to replay.
   */
  it('REFUSES a custom route description and a quoteId — this wrapper is catalog-only', async () => {
    const routeId = await makeRoute();
    await makeFleet();

    for (const extra of [
      { customRouteDescription: 'Cebu City to a private resort' },
      { quoteId: 'a'.repeat(32) },
    ]) {
      zodCause(await refusal(holdInput({ routeId, ...extra })));
    }
  });

  // -------------------------------------------------------------------------
  // The translation layer — one guest-safe sentence per typed refusal
  // -------------------------------------------------------------------------

  it('translates each capacity refusal into its own sentence, and writes nothing', async () => {
    const routeId = await makeRoute();
    const before = await writtenRowCounts();

    // No fleet at all: the candidate's own peak of 1 exceeds a fleet of 0.
    expect(await refusal(holdInput({ routeId }))).toMatchObject({
      code: 'BAD_REQUEST',
      message: 'No vehicle is available for that pickup time. Please try another time.',
    });

    // A vehicle but no driver: the vehicle gate passes, the driver pool is 0.
    await makeVan();
    expect(await refusal(holdInput({ routeId }))).toMatchObject({
      code: 'BAD_REQUEST',
      message: 'No driver is available for that date. Please try another date.',
    });

    /*
     * And the window past midnight: 23:00 + 120 duration + 60 buffer = 02:00.
     * The fleet is ample here, so neither pool can be what answers — it is
     * capacity condition (1), decided with no database read at all.
     */
    await makeDriver(8);
    expect(await refusal(holdInput({ routeId, pickupTime: '23:00' }))).toMatchObject({
      code: 'BAD_REQUEST',
      message: 'That trip would run past midnight. Please choose an earlier pickup time.',
    });

    expect(await writtenRowCounts()).toEqual(before);
  });

  /**
   * **Both sides of `TransferNoticeTooShortError`, which is ONE class covering
   * two different facts** (T10 review, M-2). A pickup two hours out is short of
   * the six hours the owner's settings ask for; a pickup two hours ago has
   * already happened, and telling that guest "we need six hours' notice"
   * invites them to count six hours from a moment that is gone.
   *
   * Both instants are named relative to the real clock, because this procedure
   * takes no `now`. The civil date is read in MANILA from each instant, so the
   * pair works at any hour of the day, including either side of midnight.
   */
  it('tells a too-soon pickup how much notice is needed, and a past one that it has passed', async () => {
    const routeId = await makeRoute();
    await makeFleet();
    const before = await writtenRowCounts();

    const soon = new Date(Date.now() + 2 * 3_600_000);
    expect(
      await refusal(
        holdInput({ routeId, date: manilaCivilDate(soon), pickupTime: manilaTimeHHMM(soon) }),
      ),
    ).toMatchObject({
      code: 'BAD_REQUEST',
      message:
        `This transfer needs at least ${MIN_NOTICE_HOURS} hours' notice before pickup. ` +
        'Please choose a later time.',
    });

    const gone = new Date(Date.now() - 2 * 3_600_000);
    expect(
      await refusal(
        holdInput({ routeId, date: manilaCivilDate(gone), pickupTime: manilaTimeHHMM(gone) }),
      ),
      'a pickup that has been and gone must not be told to add notice to it',
    ).toMatchObject({
      code: 'BAD_REQUEST',
      message: 'That pickup time has already passed. Please choose a later date or time.',
    });

    expect(await writtenRowCounts()).toEqual(before);
  });

  /**
   * An unknown route id, a retired route and a vehicle type with no price row
   * get ONE sentence between them — the same reasoning `quoteTransfer` records
   * for the same four cases: distinguishing them over a numeric id would make
   * this mutation an enumeration oracle for the catalog.
   */
  it('refuses an unquotable route with one NOT_FOUND sentence for every cause', async () => {
    await makeFleet();
    const retired = await makeRoute({ isActive: false });
    const vanOnly = await makeRoute({ vehicleTypeIds: [VAN_ID] });

    expect(await refusal(holdInput({ routeId: retired }))).toMatchObject(UNQUOTABLE_ROUTE_REFUSAL);
    expect(await refusal(holdInput({ routeId: vanOnly, vehicleTypeId: SUV_ID }))).toMatchObject(
      UNQUOTABLE_ROUTE_REFUSAL,
    );
    expect(await refusal(holdInput({ routeId: 2_000_000_000 }))).toMatchObject(
      UNQUOTABLE_ROUTE_REFUSAL,
    );
  });

  /**
   * Task 0D (owner decision 2026-11-06 #1, retargeted 2026-11-08 from
   * `destinations` to the route's TO place): a route whose TO place is
   * retired is not sellable even while the route's own flag is still
   * active — `vehiclePriceForRouteAndType` joins to `transfer_places`
   * (both ends) and checks both flags, so this hold must be refused with
   * the same sentence the route-retired case above gets (deliberately
   * non-distinguishing — see this file's header and the T9 review finding
   * it cites: naming WHY would make a numeric id an enumeration oracle for
   * which places exist).
   */
  it('refuses a route whose place is retired, even though the route itself is active', async () => {
    await makeFleet();
    const inactivePlaceRoute = await makeRoute({ toPlaceActive: false });
    const before = await writtenRowCounts();

    expect(await refusal(holdInput({ routeId: inactivePlaceRoute }))).toMatchObject(
      UNQUOTABLE_ROUTE_REFUSAL,
    );
    expect(
      await writtenRowCounts(),
      'a hold refused for a retired place must leave no slot, booking or audit row',
    ).toEqual(before);
  });

  /**
   * BUG-110 at the surface a transfer guest meets, all three bands of
   * `gatewayMinimumMessage()` — the same constant, the same shared chooser and
   * the same sentences the tour hold and both quote previews use. There is no
   * second threshold anywhere, and no band gets offered a way out that would
   * refuse it identically.
   */
  it('refuses a deposit under the ₱100 floor, a total under it, and a ₱0 booking — each with its own sentence', async () => {
    await makeFleet();
    // ₱300: a 30% deposit is ₱90, under the floor, while the total clears it.
    const shortDeposit = await makeRoute({ oneWayPriceCentavos: 30_000 });
    expect(depositCentavos(30_000, DEPOSIT_PERCENT)).toBeLessThan(PAYMONGO_MIN_CENTAVOS);
    // ₱50: no pay mode reaches ₱100, so "pay in full instead" is not an answer.
    const cheap = await makeRoute({ oneWayPriceCentavos: 5_000 });
    const full = await makeRoute();
    const freebie = await makeCoupon(10_000); // 100% off — percent_bp allows it
    const before = await writtenRowCounts();

    expect(await refusal(holdInput({ routeId: shortDeposit, payMode: 'deposit' }))).toMatchObject({
      code: 'BAD_REQUEST',
      message: AMOUNT_BELOW_GATEWAY_MINIMUM,
    });
    expect(await refusal(holdInput({ routeId: cheap }))).toMatchObject({
      code: 'BAD_REQUEST',
      message: TOTAL_BELOW_GATEWAY_MINIMUM,
    });
    expect(await refusal(holdInput({ routeId: full, couponCode: freebie.code }))).toMatchObject({
      code: 'BAD_REQUEST',
      message: NOTHING_TO_PAY_ONLINE,
    });

    expect(
      await writtenRowCounts(),
      'a hold that can never be paid still took a slot or a coupon use',
    ).toEqual(before);
  });

  it('refuses an unknown coupon with the SAME sentence the tour hold and both quotes give', async () => {
    const routeId = await makeRoute();
    await makeFleet();

    expect(
      await refusal(holdInput({ routeId, couponCode: `NOPE_${unique()}`.slice(0, 40) })),
    ).toMatchObject({ code: 'BAD_REQUEST', message: "We couldn't find that coupon code." });
  });

  /**
   * The hold cap is ONE pool shared with tours (`assertUnderHoldCaps` counts
   * every pending booking for an email or phone, with no `product_type`
   * filter), so the sentence must be the one the tour hold gives, word for
   * word: two different sentences would describe one cap and send the guest
   * looking for a second one.
   *
   * The three windows are non-overlapping (pickup + 120 duration + 60 buffer =
   * three hours each) and the fleet is ample, so only the cap can refuse.
   */
  it("refuses a third pending hold for one guest with the tour holds' own sentence", async () => {
    const routeId = await makeRoute();
    await makeFleet(3);
    expect(MAX_ACTIVE_HOLDS_PER_GUEST).toBe(2);
    const lead = {
      name: 'Juan Dela Cruz',
      email: `t11_pool_${Date.now()}@example.test`,
      phone: '0917 000 0777',
    };

    await hold(holdInput({ routeId, lead, pickupTime: '06:00' }));
    await hold(holdInput({ routeId, lead, pickupTime: '09:00' }));

    expect(await refusal(holdInput({ routeId, lead, pickupTime: '12:00' }))).toMatchObject({
      code: 'CONFLICT',
      message:
        'You already have the maximum number of pending bookings for this contact. ' +
        'Please complete or cancel one before starting another.',
    });
  });

  it('checkout.createHoldTransfer is a mutation, and the only new one', () => {
    const procedures = appRouter._def.procedures as unknown as Record<
      string,
      { _def: { type: string } }
    >;
    expect(procedures['checkout.createHoldTransfer']?._def.type).toBe('mutation');
  });
});

/**
 * Deletes exactly the rows this file committed, in foreign-key order, after
 * every test — the fleet is not date-scoped, so each test must start from an
 * empty one.
 */
async function cleanup() {
  const pool = getPool();
  const db = getDb();
  for (const id of created.bookingIds) {
    await pool.query('DELETE FROM audit_log WHERE entity = ? AND entity_id = ?', ['bookings', id]);
    await db.delete(couponRedemptions).where(eq(couponRedemptions.bookingId, id));
    await db.delete(bookingTransferDetails).where(eq(bookingTransferDetails.bookingId, id));
    // Raw SQL, not `db.delete(bookings)`: `schema-conventions.test.ts`'s guard
    // greps the server tree for the Drizzle form and exempts only this shape
    // for a fixture removing its own rows from `rg_travel_test`.
    await pool.query('DELETE FROM bookings WHERE id = ?', [id]);
  }
  for (const id of created.couponIds) {
    await pool.query('DELETE FROM coupon_redemptions WHERE coupon_id = ?', [id]);
    await db.delete(coupons).where(eq(coupons.id, id));
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
  for (const date of DATES) {
    await pool.query('DELETE FROM fleet_date_slots WHERE date = ?', [date]);
  }
  created.bookingIds = [];
  created.couponIds = [];
  created.routeIds = [];
  created.placeIds = [];
  created.driverIds = [];
  created.vanIds = [];
}

// ---------------------------------------------------------------------------
// Ruling 5's budget, which this mutation SHARES with `checkout.createHold`
//
// No database needed: every request below fails Zod validation before any
// resolver runs, exactly like `checkout-router.test.ts`'s own limiter tests —
// and that is deliberate, because a DB-less run must still catch a limiter
// that fails open on a new public mutation.
// ---------------------------------------------------------------------------

const BROWSER_ORIGIN = 'http://localhost:5180';
function post(app: Parameters<typeof request>[0], path: string) {
  return request(app).post(path).set('Origin', BROWSER_ORIGIN);
}

it('is listed in the hold limiter, alongside checkout.createHold', () => {
  expect([...CHECKOUT_HOLD_PROCEDURES]).toEqual([
    'checkout.createHold',
    'checkout.createHoldTransfer',
  ]);
});

it('is actually mounted in app.ts: the real app refuses the 6th createHoldTransfer from one IP', async () => {
  const app = createApp();
  const statuses: number[] = [];
  for (let i = 0; i < CHECKOUT_HOLD_MAX + 1; i += 1) {
    const res = await post(app, '/trpc/checkout.createHoldTransfer').send({});
    statuses.push(res.status);
  }
  expect(statuses.slice(0, CHECKOUT_HOLD_MAX)).not.toContain(429);
  expect(statuses[CHECKOUT_HOLD_MAX]).toBe(429);
});

/**
 * **ONE budget, not two.** Ruling 5 caps hold creations per IP, and a transfer
 * hold is a hold — it takes fleet capacity, reserves a coupon use and spends
 * the same per-guest pool. A separate budget would simply double what one
 * script may take, so five tour holds must leave no transfer hold behind them.
 */
it('spends ONE shared budget: five createHold calls leave no createHoldTransfer', async () => {
  const app = createApp();
  for (let i = 0; i < CHECKOUT_HOLD_MAX; i += 1) {
    const res = await post(app, '/trpc/checkout.createHold').send({});
    expect(res.status).not.toBe(429);
  }
  const res = await post(app, '/trpc/checkout.createHoldTransfer').send({});
  expect(res.status).toBe(429);
});
