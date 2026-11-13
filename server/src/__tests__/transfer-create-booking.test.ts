/**
 * Transfers-launch plan, Task T10: `createTransferBooking()` — one transaction
 * from a transfer request to a held booking, for BOTH the guest self-serve
 * price source and the staff-quoted one.
 *
 * **Why the fixtures here are COMMITTED, and torn down after every test.** The
 * same two reasons `capacity.test.ts`, `create-hold.test.ts` and
 * `transfer-capacity.test.ts` all document, and they apply hardest here: the
 * four concurrency tests at the bottom need TWO genuinely in-flight
 * transactions, which means two connections, which means committed state — a
 * fixture row inside an uncommitted transaction is invisible to the other
 * connection, and both holds would then see an empty fleet and pass against
 * code with no lock at all. And `vans`/`drivers` are not date-scoped, so every
 * capacity number in this file depends on the fleet being exactly what the test
 * built. `beforeEach` proves the empty-fleet premise rather than assuming it;
 * `afterEach` deletes exactly the ids this file committed, in `rg_travel_test`
 * only.
 *
 * `createTransferBooking` takes `now` as a parameter (defaulted), the same
 * discipline `createHold` uses: the hold expiry and the minimum-notice boundary
 * are then asserted exactly rather than within a tolerance.
 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import {
  CAPACITY_HOLDING_STATUSES,
  HOLD_MINUTES,
  PAYMONGO_MIN_CENTAVOS,
  depositCentavos,
  manilaInstant,
  transferPriceSnapshotSchema,
  type BookingStatus,
  type PayMode,
  type PriceSnapshot,
  type TransferDirection,
  type TransferPlaceType,
} from '@rg/shared';
import { getDb, getPool } from '../db/client';
import {
  bookingTransferDetails,
  bookings,
  coupons,
  couponRedemptions,
  destinations,
  drivers,
  tours,
  transferPlaces,
  transferRouteVehiclePrices,
  transferRoutes,
  vans,
  vehicleTypes,
} from '../db/schema';
import { readSettingBlock, readTransferOperationsSettings } from '../content/settings';
import { generateBookingRef } from '../services/booking-ref';
import { takeFleetDateLock } from '../services/capacity';
import { CouponEmailMismatchError, CouponUsageLimitReachedError } from '../services/coupons';
import {
  CouponExhaustedUnderLockError,
  GatewayMinimumNotMetError,
  HoldContentionError,
  HoldLimitReachedError,
  MAX_ACTIVE_HOLDS_PER_GUEST,
} from '../services/create-hold';
import {
  TransferBookingShapeError,
  TransferCapacityRefusedError,
  TransferNoticeTooShortError,
  TransferRouteNotQuotableError,
  createTransferBooking,
  type CreateTransferBookingInput,
  type TransferBookingPriceSource,
} from '../services/transfers/create-booking';
import { describeWithDb } from './helpers/db';

/**
 * This file's own days — deliberately none of `create-hold.test.ts`'s
 * (2099-12-04..06) or `transfer-capacity.test.ts`'s (2099-12-03..05), so a row
 * either file leaves behind cannot change this one's counts.
 */
const DAY = '2099-12-18';
const DAY_BEFORE = '2099-12-17';
const DAY_AFTER = '2099-12-19';
/** The minimum-notice tests book on the very day `NOW` falls on. */
const NOTICE_DAY = '2099-12-01';
const DAYS = [NOTICE_DAY, DAY_BEFORE, DAY, DAY_AFTER];

/** 2099-12-01, 12:00 noon in Manila. Whole seconds: DATETIME has no fraction. */
const NOW = new Date('2099-12-01T04:00:00Z');

/** The seeded `transfer_operations` values, asserted in `beforeEach`. */
const BUFFER = 60;
const MIN_NOTICE_HOURS = 6;
const STAFF_QUOTE_HOLD_HOURS = 48;
const DEFAULT_DRIVER_CAP = 2;
/** The seeded `trust.depositPercent`, likewise. */
const DEPOSIT_PERCENT = 30;

/** A one-way route duration every fixture shares, so windows are easy to read. */
const DURATION = 120;
const ONE_WAY_PRICE = 350_000;
const DAY_USE_PRICE = 650_000;
const ROUTE_FREE_CANCEL_HOURS = 24;

/**
 * `audit_log.actor_id` carries no foreign key (it is polymorphic over
 * `users`/`drivers`), so a staff-branch test needs no real user row — only a
 * number the audit row can carry back.
 */
const STAFF_USER_ID = 4242;

const created = {
  bookingIds: [] as number[],
  tourIds: [] as number[],
  routeIds: [] as number[],
  destinationIds: [] as number[],
  placeIds: [] as number[],
  couponIds: [] as number[],
  vanIds: [] as number[],
  driverIds: [] as number[],
};

/** Random FIRST, timestamp second — the reasoning is `capacity.test.ts`'s. */
const unique = () => `${Math.floor(Math.random() * 1e9)}_${Date.now()}`;

async function count(statement: Parameters<ReturnType<typeof getDb>['execute']>[0]) {
  const [rows] = (await getDb().execute(statement)) as unknown as [Array<{ n: number }>, unknown];
  return Number(rows[0]?.n ?? -1);
}

/**
 * The real, global `vehicle_types` rows for `'van'`/`'suv'` — seeded by
 * `seedBase` (migration 0023), never a literal id (CLAUDE.md). Resolved
 * fresh in `beforeEach` into these four, so a test can assert the frozen
 * snapshot's `vehicleTypeName` against the real seeded name rather than a
 * hand-typed guess.
 */
let VAN_ID: number;
let SUV_ID: number;
let VAN_NAME: string;

async function vehicleTypeBySlug(slug: string): Promise<{ id: number; name: string }> {
  const [row] = await getDb()
    .select({ id: vehicleTypes.id, name: vehicleTypes.name })
    .from(vehicleTypes)
    .where(eq(vehicleTypes.slug, slug))
    .limit(1);
  if (!row) throw new Error(`No vehicle_types row for slug "${slug}" — expected from seedBase.`);
  return row;
}

async function makeDestination(opts: { isActive?: boolean } = {}) {
  const slug = `__xferhold__${unique()}`;
  const [row] = await getDb()
    .insert(destinations)
    .values({ name: slug, slug, isActive: opts.isActive ?? true });
  created.destinationIds.push(row.insertId);
  return row.insertId;
}

/** An admin-managed pickup/drop-off place — a route's `from`/`to` endpoint. */
async function makePlace(opts: { isActive?: boolean; placeType?: TransferPlaceType } = {}) {
  const slug = `__xferhold__${unique()}`;
  const [row] = await getDb()
    .insert(transferPlaces)
    .values({
      name: slug,
      nameKey: slug.toLowerCase(),
      isActive: opts.isActive ?? true,
      placeType: opts.placeType ?? 'destination',
    });
  created.placeIds.push(row.insertId);
  return row.insertId;
}

/**
 * A transfer route with two places and, unless told otherwise, a price row
 * for BOTH vehicle types — which `transfer-capacity.test.ts`'s own `makeRoute`
 * never needed, because nothing priced a transfer before T9.
 *
 * `vehicleTypeIds: [VAN_ID]` leaves the SUV unpriced, which is one of the two
 * ways `vehiclePriceForRouteAndType` answers `null`.
 *
 * `destinationActive` (kept under that name for minimal diff against this
 * file's many call sites) now marks the route's TO-PLACE inactive, not a
 * `destinations` row — sellability moved from `destinations` to
 * `transfer_places` (owner decision 2026-11-08).
 */
async function makeRoute(
  opts: {
    durationMinutes?: number;
    freeCancelHours?: number;
    isActive?: boolean;
    destinationActive?: boolean;
    reverseEnabled?: boolean;
    fromPlaceType?: TransferPlaceType;
    toPlaceType?: TransferPlaceType;
    vehicleTypeIds?: number[];
    oneWayPriceCentavos?: number;
    dayUsePriceCentavos?: number;
  } = {},
) {
  const fromPlaceId = await makePlace({ placeType: opts.fromPlaceType ?? 'destination' });
  const toPlaceId = await makePlace({
    isActive: opts.destinationActive ?? true,
    placeType: opts.toPlaceType ?? 'destination',
  });
  const slug = `xferhold-${unique()}`;
  const [row] = await getDb()
    .insert(transferRoutes)
    .values({
      fromPlaceId,
      toPlaceId,
      reverseEnabled: opts.reverseEnabled ?? true,
      slug,
      estimatedDurationMinutes: opts.durationMinutes ?? DURATION,
      freeCancelHours: opts.freeCancelHours ?? ROUTE_FREE_CANCEL_HOURS,
      isActive: opts.isActive ?? true,
    });
  created.routeIds.push(row.insertId);

  for (const vehicleTypeId of opts.vehicleTypeIds ?? [VAN_ID, SUV_ID]) {
    await getDb()
      .insert(transferRouteVehiclePrices)
      .values({
        routeId: row.insertId,
        vehicleTypeId,
        oneWayPriceCentavos: opts.oneWayPriceCentavos ?? ONE_WAY_PRICE,
        dayUsePriceCentavos: opts.dayUsePriceCentavos ?? DAY_USE_PRICE,
      });
  }
  return row.insertId;
}

async function makeVan(opts: { vehicleTypeId?: number; capacity?: number } = {}) {
  const suffix = unique();
  const [row] = await getDb()
    .insert(vans)
    .values({
      plate: `XH${suffix}`.slice(0, 20),
      model: 'Transfer Hold Fixture',
      capacity: opts.capacity ?? 12,
      vehicleTypeId: opts.vehicleTypeId ?? VAN_ID,
      status: 'available',
      isActive: true,
    });
  created.vanIds.push(row.insertId);
  return row.insertId;
}

/** `maxTransferJobsPerDay: undefined` leaves the column NULL — "use the default". */
async function makeDriver(opts: { maxTransferJobsPerDay?: number } = {}) {
  const suffix = unique();
  const [row] = await getDb()
    .insert(drivers)
    .values({
      name: `Transfer Hold Fixture ${suffix}`,
      code: `XH${suffix}`.slice(0, 20),
      phone: '09170000000',
      pinHash: '__transfer_hold_not_a_pin_hash__',
      maxTransferJobsPerDay: opts.maxTransferJobsPerDay ?? null,
      isActive: true,
    });
  created.driverIds.push(row.insertId);
  return row.insertId;
}

/** A fleet big enough that the fleet is not what refuses. */
async function makeFleet(n: number) {
  for (let i = 0; i < n; i += 1) {
    await makeVan();
    await makeDriver({ maxTransferJobsPerDay: 8 });
  }
}

async function makeCoupon(
  opts: {
    percentBp?: number;
    amountCentavos?: number;
    usageLimit?: number | null;
    restrictedToEmail?: string | null;
  } = {},
) {
  const code = `__XFER__${unique()}`.toUpperCase().slice(0, 40);
  const [row] = await getDb()
    .insert(coupons)
    .values({
      code,
      discountType: opts.amountCentavos === undefined ? 'percent' : 'fixed',
      percentBp: opts.amountCentavos === undefined ? (opts.percentBp ?? 1000) : null,
      amountCentavos: opts.amountCentavos ?? null,
      usageLimit: opts.usageLimit ?? null,
      restrictedToEmail: opts.restrictedToEmail ?? null,
      isActive: true,
    });
  created.couponIds.push(row.insertId);
  return { id: row.insertId, code };
}

async function makeTour() {
  const destinationId = await makeDestination();
  const slug = `__xferhold__${unique()}`;
  const [row] = await getDb()
    .insert(tours)
    .values({ slug, title: slug, destinationId, groupsPerDay: 5, isActive: true });
  created.tourIds.push(row.insertId);
  return row.insertId;
}

/**
 * The minimum snapshot `bookings.price_snapshot` accepts for a TOUR fixture. No
 * test reads it; it is only here so a hand-written tour hold can exist for the
 * shared hold-cap test.
 */
const TOUR_SNAPSHOT: PriceSnapshot = {
  tier: { tierId: 1, minPax: 1, maxPax: 12, pricePerPersonCentavos: 100000 },
  addons: [],
  coupon: null,
  depositPercent: DEPOSIT_PERCENT,
  freeCancelHours: 48,
  subtotalCentavos: 100000,
  discountCentavos: 0,
  totalCentavos: 100000,
};

/** A committed TOUR booking — the other half of the shared hold-cap pool. */
async function makeTourBooking(opts: {
  tourId: number;
  date: string;
  status?: BookingStatus;
  email?: string;
  phone?: string;
}) {
  const [row] = await getDb()
    .insert(bookings)
    .values({
      ref: generateBookingRef(),
      tourId: opts.tourId,
      tourDate: new Date(`${opts.date}T00:00:00Z`),
      pax: 2,
      leadName: 'Transfer Hold Fixture',
      leadEmail: opts.email ?? 'fixture@example.test',
      leadPhone: opts.phone ?? '+639170000000',
      status: opts.status ?? 'pending_payment',
      payMode: 'full',
      priceSnapshot: TOUR_SNAPSHOT,
      subtotalCentavos: 100000,
      totalCentavos: 100000,
    });
  created.bookingIds.push(row.insertId);
  return row.insertId;
}

let guestSeq = 0;

/** One bookable request, with every field a caller would send. */
function transferInput(over: {
  routeId?: number | null;
  customRouteDescription?: string | null;
  customRouteDurationMinutes?: number | null;
  date?: string;
  vehicleTypeId?: number;
  direction?: TransferDirection;
  productType?: 'transfer_one_way' | 'transfer_day_use';
  pickupTime?: string;
  dayUseEndTime?: string | null;
  pax?: number;
  luggageCount?: number;
  flightNumber?: string | null;
  airline?: string | null;
  payMode?: PayMode;
  couponCode?: string;
  email?: string;
  phone?: string;
  priceSource?: TransferBookingPriceSource;
}): CreateTransferBookingInput {
  guestSeq += 1;
  const productType = over.productType ?? 'transfer_one_way';
  return {
    date: over.date ?? DAY,
    routeId: over.routeId === undefined ? null : over.routeId,
    customRouteDescription:
      over.customRouteDescription === undefined ? null : over.customRouteDescription,
    customRouteDurationMinutes:
      over.customRouteDurationMinutes === undefined ? null : over.customRouteDurationMinutes,
    vehicleTypeId: over.vehicleTypeId ?? VAN_ID,
    direction: over.direction ?? 'forward',
    productType,
    pickupTime: over.pickupTime ?? '08:00',
    dayUseEndTime:
      over.dayUseEndTime === undefined
        ? productType === 'transfer_day_use'
          ? '17:00'
          : null
        : over.dayUseEndTime,
    pax: over.pax ?? 3,
    luggageCount: over.luggageCount ?? 2,
    pickup: 'Mactan-Cebu International Airport, Terminal 2 arrivals',
    pickupMapUrl: null,
    dropoffAddress: 'Shangri-La Mactan, Punta Engaño Road',
    dropoffMapUrl: null,
    flightNumber: over.flightNumber === undefined ? '5J 561' : over.flightNumber,
    airline: over.airline === undefined ? 'Cebu Pacific' : over.airline,
    requests: 'One child seat please.',
    payMode: over.payMode ?? 'deposit',
    ...(over.couponCode ? { couponCode: over.couponCode } : {}),
    lead: {
      name: 'Juan Dela Cruz',
      email: over.email ?? `xfer${guestSeq}_${Date.now()}@example.test`,
      phone: over.phone ?? `+6391700${String(10_000 + guestSeq).slice(-5)}`,
    },
    priceSource: over.priceSource ?? { kind: 'catalog' },
  };
}

/** A booking, with its id registered for teardown if it succeeded. */
async function hold(input: CreateTransferBookingInput, now: Date = NOW) {
  const result = await createTransferBooking(input, now);
  created.bookingIds.push(result.bookingId);
  return result;
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

/** Every row count a refusal must leave untouched. */
async function writtenRowCounts() {
  return {
    bookings: await count(sql`SELECT COUNT(*) n FROM bookings`),
    transferDetails: await count(sql`SELECT COUNT(*) n FROM booking_transfer_details`),
    auditLog: await count(sql`SELECT COUNT(*) n FROM audit_log`),
    couponRedemptions: await count(sql`SELECT COUNT(*) n FROM coupon_redemptions`),
    couponUsedCount: await count(sql`SELECT COALESCE(SUM(used_count), 0) n FROM coupons`),
    fleetDateSlots: await count(sql`SELECT COUNT(*) n FROM fleet_date_slots`),
  };
}

function auditRowsFor(bookingId: number) {
  return count(
    sql`SELECT COUNT(*) n FROM audit_log WHERE entity = 'bookings' AND entity_id = ${bookingId}`,
  );
}

async function auditDataFor(bookingId: number) {
  const [rows] = (await getDb().execute(
    sql`SELECT actor_type, actor_id, action, data FROM audit_log
        WHERE entity = 'bookings' AND entity_id = ${bookingId}`,
  )) as unknown as [
    Array<{ actor_type: string; actor_id: number | null; action: string; data: unknown }>,
    unknown,
  ];
  const row = rows[0];
  if (!row) throw new Error(`no audit row for booking ${bookingId}`);
  return row;
}

/** The status list, interpolated from the shared constant rather than retyped. */
const HOLDING_STATUSES_SQL = sql.join(
  CAPACITY_HOLDING_STATUSES.map((status) => sql`${status}`),
  sql`, `,
);

function transfersHeldOn(date: string) {
  return count(
    sql`SELECT COUNT(*) n FROM bookings
        WHERE tour_date = ${date} AND product_type <> 'tour'
          AND status IN (${HOLDING_STATUSES_SQL})`,
  );
}

function rejections(results: PromiseSettledResult<unknown>[]) {
  return results
    .filter((r): r is PromiseRejectedResult => r.status === 'rejected')
    .map((r) => r.reason as unknown);
}

function registerFulfilled(results: PromiseSettledResult<{ bookingId: number }>[]) {
  for (const r of results) {
    if (r.status === 'fulfilled') created.bookingIds.push(r.value.bookingId);
  }
}

/**
 * Opens `n` pool connections and gives them straight back.
 *
 * Not an optimisation — `create-hold.test.ts` MEASURED that a
 * `Promise.allSettled` pair whose second leg pays a TCP connect and a MySQL
 * handshake is a sequential pair wearing a costume, and it hid a missing lock
 * entirely.
 */
async function warmPool(n = 4) {
  const held = await Promise.all(Array.from({ length: n }, () => getPool().getConnection()));
  for (const connection of held) connection.release();
}

describeWithDb('createTransferBooking', () => {
  beforeEach(async () => {
    /*
     * Every capacity number here counts the WHOLE fleet, so a van or driver
     * left behind by another suite would change all of them. The seed creates
     * neither (`seedDemo` gates the fleet on the app database): prove the
     * premise rather than assume it.
     */
    expect(await count(sql`SELECT COUNT(*) n FROM vans`), 'leftover vans in rg_travel_test').toBe(
      0,
    );
    expect(
      await count(sql`SELECT COUNT(*) n FROM drivers`),
      'leftover drivers in rg_travel_test',
    ).toBe(0);

    /*
     * Every money and timing expectation below is arithmetic over these seeded
     * values, so a change to the owner's defaults must fail HERE, by name,
     * rather than as a dozen unexplained refusals further down.
     */
    const operations = await readTransferOperationsSettings();
    expect(operations.bufferMinutes, 'the seeded buffer changed').toBe(BUFFER);
    expect(operations.minNoticeHours, 'the seeded minimum notice changed').toBe(MIN_NOTICE_HOURS);
    expect(operations.staffQuoteHoldHours, 'the seeded staff-quote hold changed').toBe(
      STAFF_QUOTE_HOLD_HOURS,
    );
    expect(operations.maxTransferJobsPerDriverPerDay, 'the seeded driver cap changed').toBe(
      DEFAULT_DRIVER_CAP,
    );
    const trust = await readSettingBlock('trust');
    expect(trust.depositPercent, 'the seeded deposit percent changed').toBe(DEPOSIT_PERCENT);

    ({ id: VAN_ID, name: VAN_NAME } = await vehicleTypeBySlug('van'));
    SUV_ID = (await vehicleTypeBySlug('suv')).id;
  });

  afterEach(cleanup);

  // -------------------------------------------------------------------------
  // The happy paths
  // -------------------------------------------------------------------------

  it('writes one pending_payment transfer, a 15-minute hold, the frozen window and one audit row', async () => {
    const routeId = await makeRoute();
    await makeFleet(2);

    const result = await hold(transferInput({ routeId, payMode: 'full' }));

    expect(result.ref).toMatch(/^RG-[ABCDEFGHJKMNPQRSTVWXYZ23456789]{6}$/);
    /*
     * Architecture §6 step 4: the guest path reuses the EXISTING 15-minute
     * hold. Both expiry assertions are written as `NOW + HOLD_MINUTES`, so
     * without this line a constant changed to 30 would keep them green and
     * "15 minutes" would be asserted nowhere.
     */
    expect(HOLD_MINUTES).toBe(15);
    expect(result.holdExpiresAt.getTime()).toBe(NOW.getTime() + HOLD_MINUTES * 60_000);

    const row = await bookingRow(result.bookingId);
    expect(row.status).toBe('pending_payment');
    expect(row.tourId, 'a transfer carries no tour_id').toBeNull();
    expect(row.productType).toBe('transfer_one_way');
    expect(row.routeId).toBe(routeId);
    expect(row.vehicleTypeId).toBe(VAN_ID);
    expect(row.pax).toBe(3);
    expect(row.pickup).toContain('Mactan-Cebu');
    expect(row.holdExpiresAt?.getTime()).toBe(NOW.getTime() + HOLD_MINUTES * 60_000);
    expect(row.amountPaidCentavos, 'a hold must not be paid').toBe(0);
    expect(row.couponId).toBeNull();
    // The flat per-vehicle rate IS the subtotal. Nothing multiplies it by pax.
    expect(row.subtotalCentavos).toBe(ONE_WAY_PRICE);
    expect(row.discountCentavos).toBe(0);
    expect(row.totalCentavos).toBe(ONE_WAY_PRICE);

    // The frozen window — a later admin edit to the catalog or the settings
    // must never reinterpret this booking's already-reserved vehicle time.
    const details = await detailsRow(result.bookingId);
    expect(details.pickupTime).toBe('08:00');
    expect(details.dayUseEndTime).toBeNull();
    expect(details.dropoffAddress).toContain('Shangri-La');
    expect(details.luggageCount).toBe(2);
    expect(details.flightNumber).toBe('5J 561');
    expect(details.airline).toBe('Cebu Pacific');
    expect(details.customRouteDescription).toBeNull();
    expect(details.bufferMinutesUsed).toBe(BUFFER);
    expect(details.routeDurationMinutesUsed).toBe(DURATION);

    const snapshot = transferPriceSnapshotSchema.parse(row.priceSnapshot);
    expect(snapshot).toEqual({
      productType: 'transfer_one_way',
      vehicleTypeId: VAN_ID,
      vehicleTypeName: VAN_NAME,
      routeId,
      customRouteDescription: null,
      priceSource: 'catalog',
      priceCentavos: ONE_WAY_PRICE,
      coupon: null,
      depositPercent: DEPOSIT_PERCENT,
      freeCancelHours: ROUTE_FREE_CANCEL_HOURS,
      subtotalCentavos: ONE_WAY_PRICE,
      discountCentavos: 0,
      totalCentavos: ONE_WAY_PRICE,
    });

    expect(await auditRowsFor(result.bookingId)).toBe(1);
    const audit = await auditDataFor(result.bookingId);
    expect(audit.action).toBe('booking.held');
    expect(audit.actor_type).toBe('customer');
    expect(audit.actor_id).toBeNull();
    expect(audit.data).toMatchObject({
      ref: result.ref,
      productType: 'transfer_one_way',
      routeId,
      vehicleTypeId: VAN_ID,
      tourDate: DAY,
      pickupTime: '08:00',
      priceSource: 'catalog',
      totalCentavos: ONE_WAY_PRICE,
      couponId: null,
    });
    // RA 10173: no guest identity in an audit row every admin can read.
    expect(JSON.stringify(audit.data)).not.toContain('Juan');
    expect(JSON.stringify(audit.data)).not.toContain('@example.test');
  });

  it('prices a DAY-USE hire from the day-use column and freezes no route duration', async () => {
    const routeId = await makeRoute();
    await makeFleet(2);

    const result = await hold(
      transferInput({
        routeId,
        productType: 'transfer_day_use',
        pickupTime: '07:00',
        dayUseEndTime: '17:00',
        flightNumber: null,
        airline: null,
        payMode: 'full',
      }),
    );

    const row = await bookingRow(result.bookingId);
    expect(row.productType).toBe('transfer_day_use');
    expect(row.totalCentavos, 'the day-use column, not the one-way one').toBe(DAY_USE_PRICE);

    const details = await detailsRow(result.bookingId);
    expect(details.dayUseEndTime).toBe('17:00');
    /*
     * NULL, and deliberately: a day-use window ends at `dayUseEndTime`, so
     * there is no duration to freeze — storing one would invite
     * `windowForBookedTransfer` to compute the wrong window later.
     */
    expect(details.routeDurationMinutesUsed).toBeNull();
    expect(details.bufferMinutesUsed).toBe(BUFFER);
  });

  /**
   * The STAFF price source with a real catalog route: the window, the duration
   * and the free-cancellation hours all still come from the catalog, and only
   * the PRICE is overridden — plus the longer hold Architecture §6 step 4
   * describes, which reuses `hold_expires_at` and the existing `expire-holds`
   * sweep with nothing new but the duration.
   */
  it('takes a staff-quoted price over the catalog one, with the longer staff hold', async () => {
    const routeId = await makeRoute();
    await makeFleet(2);
    const priceCentavos = 500_000;

    const result = await hold(
      transferInput({
        routeId,
        payMode: 'full',
        priceSource: { kind: 'staff', priceCentavos, staffUserId: STAFF_USER_ID },
      }),
    );

    expect(result.holdExpiresAt.getTime()).toBe(NOW.getTime() + STAFF_QUOTE_HOLD_HOURS * 3_600_000);

    const row = await bookingRow(result.bookingId);
    expect(row.holdExpiresAt?.getTime()).toBe(NOW.getTime() + STAFF_QUOTE_HOLD_HOURS * 3_600_000);
    expect(row.totalCentavos, 'the staff figure, not the catalog one').toBe(priceCentavos);
    expect(row.totalCentavos).not.toBe(ONE_WAY_PRICE);

    const snapshot = transferPriceSnapshotSchema.parse(row.priceSnapshot);
    expect(snapshot.priceSource).toBe('staff_quote');
    expect(snapshot.priceCentavos).toBe(priceCentavos);
    expect(snapshot.routeId).toBe(routeId);
    expect(snapshot.freeCancelHours, 'the catalog route still supplies this').toBe(
      ROUTE_FREE_CANCEL_HOURS,
    );

    // The duration still comes from the catalog, frozen as usual.
    expect((await detailsRow(result.bookingId)).routeDurationMinutesUsed).toBe(DURATION);

    const audit = await auditDataFor(result.bookingId);
    expect(audit.actor_type, 'a staff quote has an actor; a guest hold does not').toBe('user');
    expect(audit.actor_id).toBe(STAFF_USER_ID);
    expect(audit.data).toMatchObject({ priceSource: 'staff_quote', staffUserId: STAFF_USER_ID });
  });

  it('computes the deposit due now from the settings percent, not from the client', async () => {
    const routeId = await makeRoute();
    await makeFleet(2);

    const result = await hold(transferInput({ routeId, payMode: 'deposit' }));
    const row = await bookingRow(result.bookingId);
    expect(row.payMode).toBe('deposit');
    // Nothing stores the deposit — §5 computes it from the total and the
    // frozen percent — so this asserts the two ingredients the snapshot keeps.
    const snapshot = transferPriceSnapshotSchema.parse(row.priceSnapshot);
    expect(depositCentavos(snapshot.totalCentavos, snapshot.depositPercent)).toBe(
      depositCentavos(ONE_WAY_PRICE, DEPOSIT_PERCENT),
    );
  });

  // -------------------------------------------------------------------------
  // `route_id` XOR `custom_route_description` — the invariant the schema's own
  // CHECK comment delegates to this writer
  // -------------------------------------------------------------------------

  /**
   * **The dedicated test `db/schema.ts`'s `bookings_product_type_shape` CHECK
   * promises exists.** That CHECK deliberately says nothing about `route_id` on
   * the transfer branch, because the description it is exclusive with lives on
   * `booking_transfer_details` — a cross-table invariant a single-table MySQL
   * CHECK cannot express. This is where it is enforced.
   */
  it('refuses a request carrying BOTH a route and a custom description, and writes nothing', async () => {
    const routeId = await makeRoute();
    await makeFleet(2);
    const before = await writtenRowCounts();

    const error = await createTransferBooking(
      transferInput({
        routeId,
        customRouteDescription: 'Cebu City to a private resort in Carmen',
        priceSource: { kind: 'staff', priceCentavos: 400_000, staffUserId: STAFF_USER_ID },
      }),
      NOW,
    ).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(TransferBookingShapeError);
    expect((error as TransferBookingShapeError).reason).toBe('route_and_custom_route_description');
    expect(await writtenRowCounts()).toEqual(before);
  });

  it('refuses a request carrying NEITHER a route nor a custom description, and writes nothing', async () => {
    await makeRoute();
    await makeFleet(2);
    const before = await writtenRowCounts();

    const error = await createTransferBooking(
      transferInput({
        routeId: null,
        customRouteDescription: null,
        priceSource: { kind: 'staff', priceCentavos: 400_000, staffUserId: STAFF_USER_ID },
      }),
      NOW,
    ).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(TransferBookingShapeError);
    expect((error as TransferBookingShapeError).reason).toBe(
      'neither_route_nor_custom_route_description',
    );
    expect(await writtenRowCounts()).toEqual(before);
  });

  /**
   * The guest path cannot be the custom one: a catalog price has no catalog row
   * to read. Refused rather than silently repriced from nothing.
   */
  it('refuses a catalog price source with no catalog route', async () => {
    await makeFleet(2);
    const error = await createTransferBooking(
      transferInput({ routeId: null, customRouteDescription: 'Somewhere not in the catalog' }),
      NOW,
    ).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(TransferBookingShapeError);
    expect((error as TransferBookingShapeError).reason).toBe('catalog_price_source_without_route');
  });

  it('refuses a day-use hire with no end time, an end time before its pickup, or a flight', async () => {
    const routeId = await makeRoute();
    await makeFleet(2);
    const before = await writtenRowCounts();

    const reasons = await Promise.all(
      (
        [
          [{ dayUseEndTime: null }, 'day_use_end_time_missing'],
          [{ dayUseEndTime: '08:00' }, 'day_use_end_time_not_after_pickup'],
          [{ dayUseEndTime: 'later' }, 'day_use_end_time_unreadable'],
          [{ flightNumber: '5J 561' }, 'flight_details_on_day_use'],
        ] as const
      ).map(async ([over, expected]) => {
        const error = await createTransferBooking(
          transferInput({
            routeId,
            productType: 'transfer_day_use',
            pickupTime: '08:00',
            dayUseEndTime: '17:00',
            flightNumber: null,
            airline: null,
            ...over,
          }),
          NOW,
        ).catch((e: unknown) => e);
        expect(error, String(expected)).toBeInstanceOf(TransferBookingShapeError);
        return [(error as TransferBookingShapeError).reason, expected];
      }),
    );

    for (const [actual, expected] of reasons) expect(actual).toBe(expected);
    expect(await writtenRowCounts()).toEqual(before);
  });

  it('refuses a one-way transfer carrying a day-use end time, an unreadable pickup time, or a nonsense party', async () => {
    const routeId = await makeRoute();
    await makeFleet(2);

    for (const [over, expected] of [
      [{ dayUseEndTime: '17:00' }, 'day_use_end_time_on_one_way'],
      [{ pickupTime: '24:00' }, 'pickup_time_unreadable'],
      [{ pax: 0 }, 'pax_not_positive'],
      [{ luggageCount: -1 }, 'luggage_count_negative'],
    ] as const) {
      const error = await createTransferBooking(transferInput({ routeId, ...over }), NOW).catch(
        (e: unknown) => e,
      );
      expect(error, String(expected)).toBeInstanceOf(TransferBookingShapeError);
      expect((error as TransferBookingShapeError).reason).toBe(expected);
    }
  });

  /** The server validates even a STAFF-entered price; it does not trust it. */
  it('refuses a staff-quoted price that is not whole, non-negative centavos', async () => {
    const routeId = await makeRoute();
    await makeFleet(2);

    for (const priceCentavos of [-1, 350_000.5]) {
      const error = await createTransferBooking(
        transferInput({
          routeId,
          priceSource: { kind: 'staff', priceCentavos, staffUserId: STAFF_USER_ID },
        }),
        NOW,
      ).catch((e: unknown) => e);
      expect(error, String(priceCentavos)).toBeInstanceOf(TransferBookingShapeError);
      expect((error as TransferBookingShapeError).reason).toBe('staff_price_not_whole_centavos');
    }
  });

  // -------------------------------------------------------------------------
  // Direction and the airport flight-details rule (owner decision 2026-11-08)
  // — both checked POST-catalog-read, inside the transaction, which is why
  // they live here rather than beside `assertBookableShape`'s own pure cases
  // above (see `TRANSFER_BOOKING_SHAPE_PROBLEMS`'s doc comment).
  // -------------------------------------------------------------------------

  it('refuses a reverse-direction hold on a route with reverseEnabled=false, and writes nothing', async () => {
    const routeId = await makeRoute({ reverseEnabled: false });
    await makeFleet(2);
    const before = await writtenRowCounts();

    const error = await createTransferBooking(
      transferInput({ routeId, direction: 'reverse' }),
      NOW,
    ).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(TransferBookingShapeError);
    expect((error as TransferBookingShapeError).reason).toBe('reverse_not_enabled_for_route');
    expect(await writtenRowCounts()).toEqual(before);
  });

  it('accepts a reverse-direction hold on a route with reverseEnabled=true, and freezes it', async () => {
    const routeId = await makeRoute({ reverseEnabled: true });
    await makeFleet(2);

    const result = await hold(transferInput({ routeId, direction: 'reverse', payMode: 'full' }));
    expect((await detailsRow(result.bookingId)).direction).toBe('reverse');
  });

  it('refuses a one-way transfer touching an airport place with no flight details, and writes nothing', async () => {
    const routeId = await makeRoute({ fromPlaceType: 'airport' });
    await makeFleet(2);
    const before = await writtenRowCounts();

    const error = await createTransferBooking(
      transferInput({ routeId, flightNumber: null, airline: null }),
      NOW,
    ).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(TransferBookingShapeError);
    expect((error as TransferBookingShapeError).reason).toBe(
      'flight_details_required_for_airport_route',
    );
    expect(await writtenRowCounts()).toEqual(before);
  });

  it('refuses a one-way airport transfer whose flight details are BLANK STRINGS, not just null, and writes nothing', async () => {
    // A guest's form can post '' rather than omit the field entirely — the
    // check must not pass vacuously on a value that is technically non-null
    // but carries no usable flight detail (owner/Opus review finding).
    const routeId = await makeRoute({ fromPlaceType: 'airport' });
    await makeFleet(2);
    const before = await writtenRowCounts();

    const error = await createTransferBooking(
      transferInput({ routeId, flightNumber: '', airline: '' }),
      NOW,
    ).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(TransferBookingShapeError);
    expect((error as TransferBookingShapeError).reason).toBe(
      'flight_details_required_for_airport_route',
    );
    expect(await writtenRowCounts()).toEqual(before);
  });

  /**
   * **Retargeted from `toPlaceType: 'airport'` (owner decision 3, 2026-11-09).**
   * Under the pre-2026-11-09 "either end" rule this test's `toPlaceType`
   * fixture still proved acceptance once flight details were given — but it
   * no longer exercises the REQUIRED path at all under the new,
   * pickup-only rule: with `toPlaceType: 'airport'` and the default forward
   * direction, the pickup place (`fromPlace`) is not an airport, so flight
   * details are merely optional there now (see the new
   * "drop-off is an airport but pickup is not" test below, which is what
   * now covers that fixture shape). Retargeted to `fromPlaceType: 'airport'` so
   * this test keeps proving what it always meant to: a REQUIRED-and-satisfied
   * hold succeeds.
   */
  it('accepts a one-way airport transfer once flight details are given', async () => {
    const routeId = await makeRoute({ fromPlaceType: 'airport' });
    await makeFleet(2);

    const result = await hold(
      transferInput({
        routeId,
        flightNumber: '5J 561',
        airline: 'Cebu Pacific',
        payMode: 'full',
      }),
    );
    expect((await bookingRow(result.bookingId)).status).toBe('pending_payment');
  });

  // -------------------------------------------------------------------------
  // Decision 3 (owner, 2026-11-09): required only when PICKUP is an airport,
  // not "either end" — narrowing the rule above. Which place is pickup
  // depends on `direction`.
  // -------------------------------------------------------------------------

  it('does NOT require flight details when only the DROP-OFF is an airport (forward direction)', async () => {
    // forward: pickup = fromPlace (not an airport), drop-off = toPlace (is).
    const routeId = await makeRoute({ toPlaceType: 'airport' });
    await makeFleet(2);

    const result = await hold(
      transferInput({
        routeId,
        direction: 'forward',
        flightNumber: null,
        airline: null,
        payMode: 'full',
      }),
    );
    expect((await bookingRow(result.bookingId)).status).toBe('pending_payment');
  });

  /**
   * The symmetric reverse-direction case for the same optional rule: the
   * AIRPORT end is `fromPlace`, but travelling in reverse makes `toPlace`
   * the pickup — so it is still optional. This is one of the two tests that
   * actually discriminate the new rule from the old "either end" one: under
   * the old rule this fixture (an airport route at all) would have required
   * the fields regardless of direction.
   */
  it('does NOT require flight details when only the DROP-OFF is an airport (reverse direction)', async () => {
    // reverse: pickup = toPlace (not an airport), drop-off = fromPlace (is).
    const routeId = await makeRoute({ fromPlaceType: 'airport', reverseEnabled: true });
    await makeFleet(2);

    const result = await hold(
      transferInput({
        routeId,
        direction: 'reverse',
        flightNumber: null,
        airline: null,
        payMode: 'full',
      }),
    );
    expect((await bookingRow(result.bookingId)).status).toBe('pending_payment');
  });

  /**
   * Proves `direction` is actually read, not just accepted — the airport is
   * on `toPlace`, which is only the PICKUP when travelling in reverse. A
   * ternary that ignored direction (always reading `fromPlaceType`) would
   * wrongly accept this hold without flight details; a ternary reading the
   * wrong branch (swapped forward/reverse) would also wrongly accept it.
   */
  it('requires flight details when the PICKUP is an airport via REVERSE direction', async () => {
    const routeId = await makeRoute({ toPlaceType: 'airport', reverseEnabled: true });
    await makeFleet(2);
    const before = await writtenRowCounts();

    const error = await createTransferBooking(
      transferInput({ routeId, direction: 'reverse', flightNumber: null, airline: null }),
      NOW,
    ).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(TransferBookingShapeError);
    expect((error as TransferBookingShapeError).reason).toBe(
      'flight_details_required_for_airport_route',
    );
    expect(await writtenRowCounts()).toEqual(before);
  });

  /** Flight details are stored, even though optional, when the guest volunteers them anyway. */
  it('stores flight details that were given but not required (drop-off-only airport)', async () => {
    const routeId = await makeRoute({ toPlaceType: 'airport' });
    await makeFleet(2);

    const result = await hold(
      transferInput({
        routeId,
        direction: 'forward',
        flightNumber: '5J 999',
        airline: 'Cebu Pacific',
        payMode: 'full',
      }),
    );
    expect((await detailsRow(result.bookingId)).flightNumber).toBe('5J 999');
  });

  it('does NOT require flight details for a DAY-USE hire, even on an airport route', async () => {
    // The airport rule is scoped to `transfer_one_way` only (design note §2) —
    // a day-use hire has no flight to meet, and `assertBookableShape` already
    // refuses flight fields on a day-use request regardless.
    const routeId = await makeRoute({ fromPlaceType: 'airport' });
    await makeFleet(2);

    const result = await hold(
      transferInput({
        routeId,
        productType: 'transfer_day_use',
        pickupTime: '07:00',
        dayUseEndTime: '17:00',
        flightNumber: null,
        airline: null,
        payMode: 'full',
      }),
    );
    expect((await bookingRow(result.bookingId)).status).toBe('pending_payment');
  });

  // -------------------------------------------------------------------------
  // Minimum notice (owner answer 2)
  // -------------------------------------------------------------------------

  /**
   * The boundary, both sides of it, on the SAME day `NOW` falls on — so the
   * rule being tested is the clock and not the calendar. `minNoticeHours` is 6
   * and `NOW` is noon in Manila, so a pickup at 18:00 is exactly on the line
   * (accepted, `>=`) and 17:59 is one minute short.
   */
  it('refuses a pickup with less than the minimum notice, and accepts one exactly on the line', async () => {
    const routeId = await makeRoute();
    await makeFleet(2);
    const before = await writtenRowCounts();

    const error = await createTransferBooking(
      transferInput({ routeId, date: NOTICE_DAY, pickupTime: '17:59' }),
      NOW,
    ).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(TransferNoticeTooShortError);
    expect((error as TransferNoticeTooShortError).minNoticeHours).toBe(MIN_NOTICE_HOURS);
    expect((error as TransferNoticeTooShortError).pickupAt.toISOString()).toBe(
      manilaInstant(NOTICE_DAY, '17:59').toISOString(),
    );
    /*
     * **The capacity was not consumed, and not even the lock anchor survived.**
     * The refusal happens after `takeFleetDateLock` has created
     * `fleet_date_slots(date)`, inside the transaction — so the rollback has to
     * take that row with it, or a refused hold would leave a trace and the
     * "writes nothing" claim would be false.
     */
    expect(await writtenRowCounts()).toEqual(before);
    expect(await transfersHeldOn(NOTICE_DAY)).toBe(0);

    // Exactly six hours out is enough.
    const result = await hold(
      transferInput({ routeId, date: NOTICE_DAY, pickupTime: '18:00', payMode: 'full' }),
    );
    expect((await bookingRow(result.bookingId)).status).toBe('pending_payment');
  });

  /**
   * And a date already gone is refused by the SAME arithmetic — the gap is
   * negative, so there is deliberately no separate past-date guard to keep in
   * step with it.
   */
  it('refuses a pickup that has already been and gone', async () => {
    const routeId = await makeRoute();
    await makeFleet(2);

    const error = await createTransferBooking(
      transferInput({ routeId, date: NOTICE_DAY, pickupTime: '06:00' }),
      NOW,
    ).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(TransferNoticeTooShortError);
    expect((error as TransferNoticeTooShortError).hoursUntilPickup).toBeLessThan(0);
  });

  // -------------------------------------------------------------------------
  // The catalog read
  // -------------------------------------------------------------------------

  it('refuses a retired route, a retired destination, and a vehicle type with no price row', async () => {
    await makeFleet(2);
    const retiredRoute = await makeRoute({ isActive: false });
    const retiredDestination = await makeRoute({ destinationActive: false });
    const vanOnly = await makeRoute({ vehicleTypeIds: [VAN_ID] });
    const before = await writtenRowCounts();

    for (const [routeId, vehicleTypeId, label] of [
      [retiredRoute, VAN_ID, 'retired route'],
      [retiredDestination, VAN_ID, 'retired destination'],
      [vanOnly, SUV_ID, 'no price row for that vehicle type'],
      [999_999_999, VAN_ID, 'a route id that never existed'],
    ] as const) {
      const error = await createTransferBooking(
        transferInput({ routeId, vehicleTypeId }),
        NOW,
      ).catch((e: unknown) => e);
      expect(error, label).toBeInstanceOf(TransferRouteNotQuotableError);
      expect((error as TransferRouteNotQuotableError).routeId, label).toBe(routeId);
    }

    expect(await writtenRowCounts()).toEqual(before);
  });

  // -------------------------------------------------------------------------
  // Capacity — each of `assessTransferCapacity`'s three reasons, propagated
  // -------------------------------------------------------------------------

  it('propagates each capacity refusal reason distinctly, and writes nothing', async () => {
    const routeId = await makeRoute();
    const before = await writtenRowCounts();

    // No vehicle at all: the candidate's own peak of 1 exceeds a fleet of 0.
    let error = await createTransferBooking(transferInput({ routeId }), NOW).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(TransferCapacityRefusedError);
    expect((error as TransferCapacityRefusedError).reason).toBe('no_vehicle_available');

    // A vehicle but no driver: the vehicle gate passes, the driver pool is zero.
    await makeVan();
    error = await createTransferBooking(transferInput({ routeId }), NOW).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TransferCapacityRefusedError);
    expect((error as TransferCapacityRefusedError).reason).toBe('no_driver_available');

    /*
     * And the window past midnight — 23:00 + 120 duration + 60 buffer = 02:00.
     * The fleet is deliberately ample here, so this cannot be answered by
     * either pool: it is condition (1), decided with no database read at all.
     */
    await makeDriver({ maxTransferJobsPerDay: 8 });
    error = await createTransferBooking(transferInput({ routeId, pickupTime: '23:00' }), NOW).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(TransferCapacityRefusedError);
    expect((error as TransferCapacityRefusedError).reason).toBe('pickup_crosses_midnight');

    expect(await writtenRowCounts()).toEqual(before);
  });

  // -------------------------------------------------------------------------
  // The gateway floor (BUG-110) and the ₱0 refusal
  // -------------------------------------------------------------------------

  /**
   * The SAME constant and the SAME error class the tour hold uses — there is no
   * second threshold anywhere. A ₱300 transfer clears the floor paid in full
   * and its 30% deposit (₱90) does not.
   */
  it('refuses a deposit under the gateway minimum while allowing the same booking paid in full', async () => {
    const routeId = await makeRoute({ oneWayPriceCentavos: 30_000 });
    await makeFleet(2);
    expect(depositCentavos(30_000, DEPOSIT_PERCENT)).toBeLessThan(PAYMONGO_MIN_CENTAVOS);
    const before = await writtenRowCounts();

    const error = await createTransferBooking(
      transferInput({ routeId, payMode: 'deposit' }),
      NOW,
    ).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(GatewayMinimumNotMetError);
    expect((error as GatewayMinimumNotMetError).payMode).toBe('deposit');
    expect((error as GatewayMinimumNotMetError).totalCentavos).toBe(30_000);
    expect(await writtenRowCounts(), 'a hold that cannot be paid still took a slot').toEqual(
      before,
    );

    const result = await hold(transferInput({ routeId, payMode: 'full' }));
    expect((await bookingRow(result.bookingId)).totalCentavos).toBe(30_000);
  });

  /**
   * Owner decision 2026-10-30: a ₱0 booking is always refused, never confirmed
   * with no payment step. A 100%-off coupon is the way to produce one.
   */
  it('refuses a ₱0 transfer outright, in either pay mode', async () => {
    const routeId = await makeRoute();
    await makeFleet(2);
    const coupon = await makeCoupon({ percentBp: 10_000 });

    for (const payMode of ['full', 'deposit'] as const) {
      const error = await createTransferBooking(
        transferInput({ routeId, payMode, couponCode: coupon.code }),
        NOW,
      ).catch((e: unknown) => e);
      expect(error, payMode).toBeInstanceOf(GatewayMinimumNotMetError);
      expect((error as GatewayMinimumNotMetError).totalCentavos, payMode).toBe(0);
    }

    expect(
      await count(sql`SELECT used_count n FROM coupons WHERE id = ${coupon.id}`),
      'a refused hold reserved a coupon use',
    ).toBe(0);
  });

  // -------------------------------------------------------------------------
  // Coupons
  // -------------------------------------------------------------------------

  it('applies a percent and a fixed coupon to the flat catalog price', async () => {
    const routeId = await makeRoute();
    await makeFleet(3);
    const percent = await makeCoupon({ percentBp: 1500 });
    const fixed = await makeCoupon({ amountCentavos: 50_000 });

    const percentHold = await hold(
      transferInput({ routeId, payMode: 'full', couponCode: percent.code, pickupTime: '06:00' }),
    );
    const percentRow = await bookingRow(percentHold.bookingId);
    expect(percentRow.discountCentavos).toBe(Math.floor((ONE_WAY_PRICE * 1500) / 10_000));
    expect(percentRow.totalCentavos).toBe(ONE_WAY_PRICE - percentRow.discountCentavos);
    expect(percentRow.couponId).toBe(percent.id);
    expect(transferPriceSnapshotSchema.parse(percentRow.priceSnapshot).coupon).toEqual({
      id: percent.id,
      code: percent.code,
      discount: { discountType: 'percent', percentBp: 1500, amountCentavos: null },
    });
    expect(
      await count(
        sql`SELECT COUNT(*) n FROM coupon_redemptions
            WHERE coupon_id = ${percent.id} AND booking_id = ${percentHold.bookingId}`,
      ),
    ).toBe(1);
    expect(await count(sql`SELECT used_count n FROM coupons WHERE id = ${percent.id}`)).toBe(1);

    const fixedHold = await hold(
      transferInput({ routeId, payMode: 'full', couponCode: fixed.code, pickupTime: '12:00' }),
    );
    const fixedRow = await bookingRow(fixedHold.bookingId);
    expect(fixedRow.discountCentavos).toBe(50_000);
    expect(fixedRow.totalCentavos).toBe(ONE_WAY_PRICE - 50_000);
    expect(transferPriceSnapshotSchema.parse(fixedRow.priceSnapshot).coupon).toEqual({
      id: fixed.id,
      code: fixed.code,
      discount: { discountType: 'fixed', percentBp: null, amountCentavos: 50_000 },
    });
  });

  /**
   * A sign-up coupon's `restricted_to_email` (sign-up coupons plan, Task
   * 1B-i), honoured end-to-end through `createTransferBooking`'s own
   * `validateCoupon` call. Same shape as `create-hold.test.ts`'s equivalent
   * case: the refusal is authoritative here (inside the transaction, with
   * `input.lead.email` in scope), unlike a `quote`/`quoteTransfer` preview.
   */
  it("refuses a restricted-to-email coupon when the booking's lead email does not match, and reserves nothing", async () => {
    const routeId = await makeRoute();
    await makeFleet(2);
    const coupon = await makeCoupon({
      percentBp: 1000,
      restrictedToEmail: 'owner-of-code@example.test',
    });

    const error = await createTransferBooking(
      transferInput({
        routeId,
        payMode: 'full',
        couponCode: coupon.code,
        email: 'someone-else@example.test',
      }),
      NOW,
    ).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(CouponEmailMismatchError);
    expect((error as Error).message).not.toContain('owner-of-code@example.test');
    expect(await count(sql`SELECT used_count n FROM coupons WHERE id = ${coupon.id}`)).toBe(0);
    expect(
      await count(sql`SELECT COUNT(*) n FROM coupon_redemptions WHERE coupon_id = ${coupon.id}`),
    ).toBe(0);
  });

  /**
   * Review fix 4 (post-launch review of 1B) — the transfer-path equivalent
   * of `create-hold.test.ts`'s own positive-path test. The refusal test
   * above only proves `validateCoupon` is called with SOME value for the
   * lead email; swapping `input.lead.email` for `input.lead.phone` at the
   * `validateCoupon` call site in `createTransferBooking` left the whole
   * file green before this test existed, because a wrong field there only
   * ever produces a mismatch and nothing asserted the match case. Confirmed
   * able to fail: that same swap turns this test red
   * (`CouponEmailMismatchError` instead of a successful booking), then
   * restored.
   */
  it("succeeds and applies the discount when a restricted-to-email coupon's email matches the booking's lead email", async () => {
    const routeId = await makeRoute();
    await makeFleet(2);
    const coupon = await makeCoupon({
      percentBp: 1000,
      restrictedToEmail: 'owner-of-code@example.test',
    });

    const result = await hold(
      transferInput({
        routeId,
        payMode: 'full',
        couponCode: coupon.code,
        email: 'owner-of-code@example.test',
      }),
    );

    const row = await bookingRow(result.bookingId);
    expect(row.couponId).toBe(coupon.id);
    expect(row.discountCentavos).toBe(Math.floor((ONE_WAY_PRICE * 1000) / 10_000));
    expect(row.discountCentavos).toBeGreaterThan(0);
    expect(row.totalCentavos).toBe(ONE_WAY_PRICE - row.discountCentavos);
    expect(transferPriceSnapshotSchema.parse(row.priceSnapshot).coupon).toEqual({
      id: coupon.id,
      code: coupon.code,
      discount: { discountType: 'percent', percentBp: 1000, amountCentavos: null },
    });
    expect(
      await count(
        sql`SELECT COUNT(*) n FROM coupon_redemptions
            WHERE coupon_id = ${coupon.id} AND booking_id = ${result.bookingId}`,
      ),
    ).toBe(1);
    expect(await count(sql`SELECT used_count n FROM coupons WHERE id = ${coupon.id}`)).toBe(1);
  });

  // -------------------------------------------------------------------------
  // Hold caps — ONE pool shared with tours
  // -------------------------------------------------------------------------

  /**
   * `assertUnderHoldCaps` counts every `pending_payment` row for an email or a
   * phone with no `product_type` filter, so a guest's tour holds and transfer
   * holds share ONE pool of two. The premise is deliberately one of EACH: were
   * the pool transfer-only, this guest would have a single transfer hold and the
   * third request would be accepted.
   */
  it('counts a tour hold and a transfer hold against ONE shared cap', async () => {
    const routeId = await makeRoute();
    await makeFleet(3);
    const tourId = await makeTour();
    const email = `shared_pool_${Date.now()}@example.test`;
    const phone = '+639170000777';

    expect(MAX_ACTIVE_HOLDS_PER_GUEST).toBe(2);
    // The tour hold sits on another date, so it cannot be what refuses on
    // capacity grounds — only the cap can.
    await makeTourBooking({ tourId, date: DAY_BEFORE, email, phone });
    await hold(transferInput({ routeId, email, phone, payMode: 'full', pickupTime: '06:00' }));

    const error = await createTransferBooking(
      transferInput({ routeId, email, phone, payMode: 'full', pickupTime: '14:00' }),
      NOW,
    ).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(HoldLimitReachedError);
    expect((error as HoldLimitReachedError).scope).toBe('email');
    expect(await transfersHeldOn(DAY)).toBe(1);
  });

  // -------------------------------------------------------------------------
  // The T19 plumbing: a custom, staff-quoted route
  // -------------------------------------------------------------------------

  /**
   * **A one-way custom route with no `customRouteDurationMinutes` refuses,
   * and that is Task T19's own fix for the documented gap, not a bug.** No
   * stored duration exists anywhere in the schema for a staff-quoted trip
   * with no catalog route, and `computeTransferWindow` refuses to GUESS one:
   * a guessed window is wrong by an unknown amount in an unknown direction and
   * would either oversell a vehicle still out on the road or refuse a booking
   * that fitted, untraceably. T19 closes it by making the duration an
   * explicit, required input instead — refused here, BEFORE the transaction
   * opens, exactly like every other member of
   * `TRANSFER_BOOKING_SHAPE_PROBLEMS`.
   */
  it('refuses a one-way CUSTOM route with no duration, and writes nothing', async () => {
    await makeFleet(2);
    const before = await writtenRowCounts();

    const error = await createTransferBooking(
      transferInput({
        routeId: null,
        customRouteDescription: 'Cebu City to a private farm in Balamban',
        customRouteDurationMinutes: null,
        priceSource: { kind: 'staff', priceCentavos: 420_000, staffUserId: STAFF_USER_ID },
      }),
      NOW,
    ).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(TransferBookingShapeError);
    expect((error as TransferBookingShapeError).reason).toBe('custom_one_way_needs_duration');
    expect(await writtenRowCounts()).toEqual(before);
  });

  /**
   * The fix itself: an explicit `customRouteDurationMinutes` is exactly what
   * closes the gap the test above refuses. The duration FROZEN onto
   * `booking_transfer_details` — and the one the capacity window is computed
   * from — must be this exact figure, proven by passing a duration that would
   * itself push the pickup window past midnight if it were, say, one minute
   * longer: a wrong (too-short) duration read back here would hide an
   * oversell rather than merely mis-report it.
   */
  it('books a one-way CUSTOM route, freezing the staff-supplied duration', async () => {
    await makeFleet(2);
    const description = 'Cebu City to a private farm in Balamban';

    const result = await hold(
      transferInput({
        routeId: null,
        customRouteDescription: description,
        customRouteDurationMinutes: 90,
        pickupTime: '08:00',
        payMode: 'full',
        priceSource: { kind: 'staff', priceCentavos: 420_000, staffUserId: STAFF_USER_ID },
      }),
    );

    const row = await bookingRow(result.bookingId);
    expect(row.routeId).toBeNull();
    expect(row.productType).toBe('transfer_one_way');
    expect(row.totalCentavos).toBe(420_000);

    const details = await detailsRow(result.bookingId);
    expect(details.customRouteDescription).toBe(description);
    expect(details.routeDurationMinutesUsed).toBe(90);

    const snapshot = transferPriceSnapshotSchema.parse(row.priceSnapshot);
    expect(snapshot.routeId).toBeNull();
    expect(snapshot.customRouteDescription).toBe(description);
  });

  /**
   * The duration is not just stored — it is what the capacity WINDOW is
   * computed from. A one-vehicle fleet, two one-way custom trips whose
   * windows overlap only because of the SECOND booking's duration: a build
   * that read the duration for storage but not for the capacity check would
   * let both through.
   */
  it('uses the staff-supplied duration for the capacity window, not just storage', async () => {
    await makeVan({ vehicleTypeId: VAN_ID });
    await makeDriver({ maxTransferJobsPerDay: 4 });

    // Trip A: pickup 08:00, a 200-minute duration — its window runs
    // [08:00, 08:00+200min+60min buffer) = [08:00, 12:20). Trip B's 10:00
    // pickup falls inside that window ONLY because A's duration is long; a
    // build that ignored `customRouteDurationMinutes` for the capacity check
    // (freezing it for storage but computing the window some other way)
    // would give A a short default window that 10:00 falls outside of, and
    // both would wrongly fit the one van.
    await hold(
      transferInput({
        routeId: null,
        customRouteDescription: 'Trip A',
        customRouteDurationMinutes: 200,
        pickupTime: '08:00',
        payMode: 'full',
        priceSource: { kind: 'staff', priceCentavos: 300_000, staffUserId: STAFF_USER_ID },
      }),
    );

    const error = await createTransferBooking(
      transferInput({
        routeId: null,
        customRouteDescription: 'Trip B',
        customRouteDurationMinutes: 30,
        pickupTime: '10:00',
        payMode: 'full',
        priceSource: { kind: 'staff', priceCentavos: 300_000, staffUserId: STAFF_USER_ID },
      }),
      NOW,
    ).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(TransferCapacityRefusedError);
    expect((error as TransferCapacityRefusedError).reason).toBe('no_vehicle_available');
  });

  /**
   * The day-use half of the same branch DOES work today, because a day-use
   * window ends at its end time and needs no duration at all. Forward-compatible
   * plumbing proven as far as it goes.
   */
  it('books a day-use CUSTOM route, with no catalog route and no free-cancellation window', async () => {
    await makeFleet(2);
    const description = 'Whole-day hire around southern Cebu, staff quoted';

    const result = await hold(
      transferInput({
        routeId: null,
        customRouteDescription: description,
        productType: 'transfer_day_use',
        pickupTime: '07:00',
        dayUseEndTime: '18:00',
        flightNumber: null,
        airline: null,
        payMode: 'full',
        priceSource: { kind: 'staff', priceCentavos: 700_000, staffUserId: STAFF_USER_ID },
      }),
    );

    const row = await bookingRow(result.bookingId);
    expect(row.routeId).toBeNull();
    expect(row.productType).toBe('transfer_day_use');
    expect(row.totalCentavos).toBe(700_000);

    const details = await detailsRow(result.bookingId);
    expect(details.customRouteDescription).toBe(description);
    expect(details.routeDurationMinutesUsed).toBeNull();

    const snapshot = transferPriceSnapshotSchema.parse(row.priceSnapshot);
    expect(snapshot.routeId).toBeNull();
    expect(snapshot.customRouteDescription).toBe(description);
    expect(
      snapshot.freeCancelHours,
      'there is no catalog route to read a cancellation window from',
    ).toBeNull();
  });

  // -------------------------------------------------------------------------
  // The races
  // -------------------------------------------------------------------------

  /**
   * **Vehicle-short.** One sellable van and two candidate van-type transfers
   * whose windows OVERLAP, so exactly one can be served. Without the date-level
   * lock both transactions read "peak 0, one van free" and both commit.
   *
   * Driven CONCURRENTLY with `Promise.allSettled`, never sequentially: a
   * sequential pair passes against code with no lock at all, because the first
   * booking is already committed when the second one reads. And the loser must
   * be REFUSED, not killed — a deadlock or a lock-wait timeout satisfies
   * "exactly one rejected" identically, and the guest-visible difference is "no
   * van free around then" versus a 500.
   */
  it('serialises two OVERLAPPING transfers for the last vehicle', async () => {
    const routeId = await makeRoute();
    await makeVan({ vehicleTypeId: VAN_ID });
    await makeDriver({ maxTransferJobsPerDay: 4 });
    await warmPool();

    const results = await Promise.allSettled([
      createTransferBooking(transferInput({ routeId, payMode: 'full', pickupTime: '08:00' }), NOW),
      createTransferBooking(transferInput({ routeId, payMode: 'full', pickupTime: '09:00' }), NOW),
    ]);
    registerFulfilled(results);

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const [refusal] = rejections(results);
    expect(refusal, `the loser was not refused on capacity: ${String(refusal)}`).toBeInstanceOf(
      TransferCapacityRefusedError,
    );
    expect((refusal as TransferCapacityRefusedError).reason).toBe('no_vehicle_available');
    expect(await transfersHeldOn(DAY), 'the fleet was oversold').toBe(1);
    expect(await count(sql`SELECT COUNT(*) n FROM booking_transfer_details`)).toBe(1);
  });

  /**
   * **Driver-short.** Vehicles for both (two vans) and windows that do NOT
   * overlap, so the vehicle gate would pass both — the only thing that can
   * refuse one is the driver pool, whose single driver has a cap of one.
   * Architecture §2a is explicit that the hold-time driver check is a job COUNT
   * and not a time-of-day question, which non-overlapping windows isolate.
   */
  it('serialises two transfers for the last DRIVER job of the day', async () => {
    const routeId = await makeRoute();
    await makeVan({ vehicleTypeId: VAN_ID });
    await makeVan({ vehicleTypeId: VAN_ID });
    await makeDriver({ maxTransferJobsPerDay: 1 });
    await warmPool();

    const results = await Promise.allSettled([
      createTransferBooking(transferInput({ routeId, payMode: 'full', pickupTime: '06:00' }), NOW),
      createTransferBooking(transferInput({ routeId, payMode: 'full', pickupTime: '14:00' }), NOW),
    ]);
    registerFulfilled(results);

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const [refusal] = rejections(results);
    expect(refusal, `the loser was not refused on capacity: ${String(refusal)}`).toBeInstanceOf(
      TransferCapacityRefusedError,
    );
    expect((refusal as TransferCapacityRefusedError).reason).toBe('no_driver_available');
    expect(await transfersHeldOn(DAY), 'a driver was overworked past their cap').toBe(1);
  });

  /**
   * And the other direction, which is the reason the vehicle check is a PEAK
   * rather than a count: two NON-overlapping windows on one van must BOTH
   * succeed. Without this, "refuse whenever the van is busy that day" would
   * look like a free improvement — it is exactly the whole-day blocking the
   * owner replaced.
   */
  it('does NOT falsely serialise two NON-overlapping transfers on one vehicle', async () => {
    const routeId = await makeRoute();
    await makeVan({ vehicleTypeId: VAN_ID });
    await makeDriver({ maxTransferJobsPerDay: 4 });
    await warmPool();

    const results = await Promise.allSettled([
      createTransferBooking(transferInput({ routeId, payMode: 'full', pickupTime: '06:00' }), NOW),
      createTransferBooking(transferInput({ routeId, payMode: 'full', pickupTime: '14:00' }), NOW),
    ]);
    registerFulfilled(results);

    expect(rejections(results).map(String), 'a transfer that fitted was refused').toEqual([]);
    expect(await transfersHeldOn(DAY)).toBe(2);
  });

  /**
   * **The coupon's usage cap, refused UNDER THE LOCK.** Two concurrent holds on
   * DIFFERENT dates — so nothing but the coupon row can serialise them — and
   * one coupon with `usage_limit = 1`. Both pass the early `validateCoupon`
   * (each reads `used_count = 0` from its own snapshot); the authoritative
   * re-check under the coupon's own `FOR UPDATE` is what refuses the loser.
   *
   * **The refusal is told apart STRUCTURALLY, by class.** The two checks produce
   * the same message, so asserting the message proves nothing: if either hold
   * had not reached the lock when the holder let go, the loser would be refused
   * by the early read and this test would pass while the lock was missing
   * entirely. Only `reserveCouponUnderLock` can produce
   * `CouponExhaustedUnderLockError`.
   *
   * The staging is `create-hold.test.ts`'s, measured there and reused: a third
   * connection holds the coupon row `FOR UPDATE` while both holds run, so each
   * gets past `validateCoupon` and then stalls asking for the row. **The
   * `fleet_date_slots` rows for both dates are pre-created**, and that is
   * load-bearing rather than tidy: with the rows absent, the second hold blocks
   * inside `takeFleetDateLock` on the first's `INSERT … ON DUPLICATE KEY UPDATE`
   * (a new key takes a next-key lock, and the other date falls in that gap), so
   * the two serialise before the coupon is ever reached.
   */
  it('lets only one of two concurrent transfers hold a single-use coupon', async () => {
    const routeId = await makeRoute();
    await makeFleet(3);
    const coupon = await makeCoupon({ percentBp: 1000, usageLimit: 1 });

    for (const date of [DAY, DAY_AFTER]) {
      await getDb().transaction((tx) => takeFleetDateLock(tx, date));
    }
    await warmPool();

    const settled = [false, false];
    let settledAtCheckpoint: boolean[] = [];
    const holder = await getPool().getConnection();
    let race: Promise<PromiseSettledResult<{ bookingId: number }>[]>;
    try {
      await holder.beginTransaction();
      await holder.query('SELECT used_count FROM coupons WHERE id = ? FOR UPDATE', [coupon.id]);

      race = Promise.allSettled(
        [DAY, DAY_AFTER].map((date, i) =>
          createTransferBooking(
            transferInput({ routeId, date, payMode: 'full', couponCode: coupon.code }),
            NOW,
          ).finally(() => {
            settled[i] = true;
          }),
        ),
      );
      await new Promise((r) => setTimeout(r, 400));
      settledAtCheckpoint = [...settled];
    } finally {
      await holder.rollback();
      holder.release();
    }

    const results = await race;
    registerFulfilled(results);

    expect(
      settledAtCheckpoint,
      'a hold finished while the coupon row was held — the two never reached the lock together',
    ).toEqual([false, false]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const [refusal] = rejections(results);
    expect(
      refusal,
      `the loser was not refused under the coupon lock: ${String(refusal)}`,
    ).toBeInstanceOf(CouponExhaustedUnderLockError);
    expect((refusal as CouponExhaustedUnderLockError).underLock).toBe(true);
    // And it is still a usage-limit refusal to anyone catching the base class.
    expect(refusal).toBeInstanceOf(CouponUsageLimitReachedError);
    expect(
      await count(sql`SELECT used_count n FROM coupons WHERE id = ${coupon.id}`),
      'the coupon was spent twice',
    ).toBe(1);
    expect(
      await count(sql`SELECT COUNT(*) n FROM coupon_redemptions WHERE coupon_id = ${coupon.id}`),
    ).toBe(1);
  });

  // -------------------------------------------------------------------------
  // The ER_LOCK_DEADLOCK retry
  // -------------------------------------------------------------------------

  /**
   * A MySQL error as the service actually receives one: mysql2 decorates the
   * error with `errno`/`code`, and Drizzle wraps that and moves the original
   * onto `.cause` — which is why the detector walks the cause chain.
   */
  function mysqlError(errno: number, code: string): Error {
    const inner = Object.assign(new Error(`${code} (${errno})`), { errno, code });
    return Object.assign(new Error('Failed query'), { cause: inner });
  }

  /**
   * Injected rather than provoked, because provoking it is exactly what cannot
   * be made reliable: InnoDB picks the victim. The transaction is rejected ONCE
   * with a wrapped 1213 and the booking must still land — from a second,
   * COMPLETE transaction, with one booking, one details row and one audit row at
   * the end of it rather than two half-written ones.
   */
  it('restarts the whole transaction when InnoDB kills it as a deadlock victim', async () => {
    const routeId = await makeRoute();
    await makeFleet(1);

    const db = getDb();
    const realTransaction = db.transaction.bind(db);
    let attempts = 0;
    const spy = vi.spyOn(db, 'transaction').mockImplementation(((...args: unknown[]) => {
      attempts += 1;
      if (attempts === 1) return Promise.reject(mysqlError(1213, 'ER_LOCK_DEADLOCK'));
      return (realTransaction as (...a: unknown[]) => unknown)(...args);
    }) as typeof db.transaction);

    try {
      const result = await hold(transferInput({ routeId, payMode: 'full' }));
      expect(attempts, 'the transaction was not retried').toBe(2);
      expect((await bookingRow(result.bookingId)).status).toBe('pending_payment');
      expect(await auditRowsFor(result.bookingId), 'the retry wrote a second audit row').toBe(1);
      expect(await transfersHeldOn(DAY), 'the retry booked the slot twice').toBe(1);
      expect(await count(sql`SELECT COUNT(*) n FROM booking_transfer_details`)).toBe(1);
    } finally {
      spy.mockRestore();
    }
  });

  /**
   * And after `MAX_DEADLOCK_ATTEMPTS` it gives up with the SAME typed error a
   * tour hold does rather than Drizzle's opaque `Failed query`: T11's router
   * needs one vocabulary for every way a hold can fail, and "the date is being
   * hammered, try again" is a different sentence to a guest than a 500.
   */
  it('gives up with a typed HoldContentionError after three deadlocks', async () => {
    const routeId = await makeRoute();
    await makeFleet(1);

    const db = getDb();
    let attempts = 0;
    const spy = vi.spyOn(db, 'transaction').mockImplementation(((...args: unknown[]) => {
      void args;
      attempts += 1;
      return Promise.reject(mysqlError(1213, 'ER_LOCK_DEADLOCK'));
    }) as typeof db.transaction);

    try {
      const error = await createTransferBooking(transferInput({ routeId }), NOW).catch(
        (e: unknown) => e,
      );
      expect(error).toBeInstanceOf(HoldContentionError);
      expect((error as HoldContentionError).attempts).toBe(3);
      expect(attempts, 'the retry is not bounded at three attempts').toBe(3);
      expect(
        (error as Error).cause,
        'the killed transaction must survive as `cause` for the log',
      ).toBeDefined();
      expect(await transfersHeldOn(DAY)).toBe(0);
    } finally {
      spy.mockRestore();
    }
  });

  /**
   * And the retry stays NARROW. A lock-wait timeout (1205) means someone else
   * is sitting on a lock for 50 seconds; re-running that wait helps nobody, so
   * it propagates on the first attempt.
   */
  it('does not retry a lock-wait timeout', async () => {
    const routeId = await makeRoute();
    await makeFleet(1);

    const db = getDb();
    let attempts = 0;
    const spy = vi.spyOn(db, 'transaction').mockImplementation(((...args: unknown[]) => {
      void args;
      attempts += 1;
      return Promise.reject(mysqlError(1205, 'ER_LOCK_WAIT_TIMEOUT'));
    }) as typeof db.transaction);

    try {
      const error = await createTransferBooking(transferInput({ routeId }), NOW).catch(
        (e: unknown) => e,
      );
      expect((error as Error).message).toBe('Failed query');
      expect(attempts, 'a lock-wait timeout was retried').toBe(1);
    } finally {
      spy.mockRestore();
    }
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
    /*
     * Raw SQL, not `db.delete(bookings)`, and deliberately: the convention
     * guard in `schema-conventions.test.ts` scans the whole server tree —
     * tests included — for the Drizzle form, and exempts only the raw-SQL form
     * for exactly this case, a fixture removing its own rows from
     * `rg_travel_test`.
     */
    await pool.query('DELETE FROM bookings WHERE id = ?', [id]);
  }
  for (const id of created.couponIds) await db.delete(coupons).where(eq(coupons.id, id));
  for (const id of created.tourIds) {
    await pool.query('DELETE FROM tour_date_slots WHERE tour_id = ?', [id]);
    await db.delete(tours).where(eq(tours.id, id));
  }
  for (const id of created.routeIds) {
    await db.delete(transferRouteVehiclePrices).where(eq(transferRouteVehiclePrices.routeId, id));
    await db.delete(transferRoutes).where(eq(transferRoutes.id, id));
  }
  for (const id of created.placeIds) {
    await db.delete(transferPlaces).where(eq(transferPlaces.id, id));
  }
  for (const id of created.destinationIds) {
    await db.delete(destinations).where(eq(destinations.id, id));
  }
  for (const id of created.driverIds) await db.delete(drivers).where(eq(drivers.id, id));
  for (const id of created.vanIds) await db.delete(vans).where(eq(vans.id, id));
  for (const day of DAYS) {
    await pool.query('DELETE FROM fleet_date_slots WHERE date = ?', [day]);
  }
  created.bookingIds = [];
  created.couponIds = [];
  created.tourIds = [];
  created.routeIds = [];
  created.placeIds = [];
  created.destinationIds = [];
  created.driverIds = [];
  created.vanIds = [];
}
