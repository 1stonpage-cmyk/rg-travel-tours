/**
 * Week 3 checkout plan, Task 5: `createHold()` — one transaction from a
 * guest's form to a held booking.
 *
 * **Why the fixtures here are COMMITTED, and torn down after every test.**
 * The same two reasons `capacity.test.ts` documents, and they apply harder
 * here: the two concurrency tests at the bottom need TWO genuinely in-flight
 * transactions, which means two connections, which means committed state — a
 * fixture row inside an uncommitted transaction is invisible to the other
 * connection, and both holds would then see an empty fleet and pass against
 * code with no lock at all. And `vans`/`drivers` are not date-scoped, so
 * every capacity number in this file depends on the fleet being exactly what
 * the test built. `beforeEach` proves the empty-fleet premise rather than
 * assuming it; `afterEach` deletes exactly the ids this file committed, in
 * `rg_travel_test` only.
 *
 * `createHold` takes `now` as a parameter (defaulted), the same discipline
 * `validateCoupon` uses: the 15-minute hold and the Manila past-date guard
 * are then asserted exactly rather than within a tolerance, and the
 * near-midnight case is testable at all.
 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import {
  CAPACITY_HOLDING_STATUSES,
  HOLD_MINUTES,
  createHoldInput,
  phPhoneSchema,
  priceSnapshotSchema,
  type BookingStatus,
  type CreateHoldInput,
  type PriceSnapshot,
} from '@rg/shared';
import { getDb, getPool } from '../db/client';
import {
  bookingAddons,
  bookings,
  coupons,
  couponRedemptions,
  destinations,
  drivers,
  tourAddons,
  tourBlockedDates,
  tourPriceTiers,
  tours,
  vans,
} from '../db/schema';
import { generateBookingRef } from '../services/booking-ref';
import { takeSlotLocks } from '../services/capacity';
import { CouponUsageLimitReachedError } from '../services/coupons';
import {
  CapacityRefusedError,
  CouponExhaustedUnderLockError,
  HoldContentionError,
  HoldLimitReachedError,
  MAX_ACTIVE_HOLDS_PER_GUEST,
  PriceChangedError,
  TourDateBlockedError,
  TourDatePastError,
  createHold,
} from '../services/create-hold';
import { loadQuoteInputs, priceQuote, quoteDigest } from '../services/pricing';
import { describeWithDb } from './helpers/db';

/**
 * This file's own tour days — deliberately not `capacity.test.ts`'s
 * (2099-11-05), so a row either file leaves behind cannot change the other's
 * counts.
 */
const DAY = '2099-12-05';
const DAY_BEFORE = '2099-12-04';
const DAY_AFTER = '2099-12-06';
const DAYS = [DAY_BEFORE, DAY, DAY_AFTER];

/** 2099-12-01, 12:00 noon in Manila. Whole seconds: DATETIME has no fraction. */
const NOW = new Date('2099-12-01T04:00:00Z');

const created = {
  bookingIds: [] as number[],
  tourIds: [] as number[],
  destinationIds: [] as number[],
  couponIds: [] as number[],
  vanIds: [] as number[],
  driverIds: [] as number[],
};

/** Random first, timestamp second — `vans.plate` is varchar(20). See capacity.test.ts. */
const unique = () => `${Math.floor(Math.random() * 1e9)}_${Date.now()}`;

async function count(statement: Parameters<ReturnType<typeof getDb>['execute']>[0]) {
  const [rows] = (await getDb().execute(statement)) as unknown as [Array<{ n: number }>, unknown];
  return Number(rows[0]?.n ?? -1);
}

interface TourFixture {
  tourId: number;
  slug: string;
  /** Per-person, ₱350. */
  lunchId: number;
  /** Per-booking, ₱1,500. */
  photographerId: number;
}

/** A tour with two price tiers and two add-ons — one per-person, one per-group. */
async function makeTour(
  opts: { groupsPerDay?: number; freeCancelHours?: number | null } = {},
): Promise<TourFixture> {
  const db = getDb();
  const slug = `__hold__${unique()}`;
  const [destination] = await db.insert(destinations).values({ name: slug, slug });
  created.destinationIds.push(destination.insertId);
  const [tour] = await db.insert(tours).values({
    slug,
    title: slug,
    destinationId: destination.insertId,
    groupsPerDay: opts.groupsPerDay ?? 1,
    freeCancelHours: opts.freeCancelHours === undefined ? 48 : opts.freeCancelHours,
    isActive: true,
  });
  created.tourIds.push(tour.insertId);

  await db.insert(tourPriceTiers).values([
    { tourId: tour.insertId, minPax: 1, maxPax: 3, pricePerPersonCentavos: 250000 },
    { tourId: tour.insertId, minPax: 4, maxPax: 12, pricePerPersonCentavos: 189000 },
  ]);
  const [lunch] = await db.insert(tourAddons).values({
    tourId: tour.insertId,
    name: 'Island lunch',
    priceCentavos: 35000,
    perPerson: true,
    isActive: true,
  });
  const [photographer] = await db.insert(tourAddons).values({
    tourId: tour.insertId,
    name: 'Photographer',
    priceCentavos: 150000,
    perPerson: false,
    isActive: true,
  });

  return {
    tourId: tour.insertId,
    slug,
    lunchId: lunch.insertId,
    photographerId: photographer.insertId,
  };
}

async function makeVan(opts: { capacity?: number } = {}) {
  const suffix = unique();
  const [van] = await getDb()
    .insert(vans)
    .values({
      plate: `HOLD${suffix}`.slice(0, 20),
      model: 'Hold Fixture Van',
      capacity: opts.capacity ?? 12,
      status: 'available',
      isActive: true,
    });
  created.vanIds.push(van.insertId);
  return van.insertId;
}

async function makeDriver() {
  const suffix = unique();
  const [driver] = await getDb()
    .insert(drivers)
    .values({
      name: `Hold Fixture Driver ${suffix}`,
      code: `HOLD${suffix}`.slice(0, 20),
      phone: '09170000000',
      pinHash: '__hold_not_a_pin_hash__',
      isActive: true,
    });
  created.driverIds.push(driver.insertId);
  return driver.insertId;
}

/** `vansAndDrivers(n)` — a fleet big enough that the fleet is not what refuses. */
async function makeFleet(n: number) {
  for (let i = 0; i < n; i += 1) {
    await makeVan();
    await makeDriver();
  }
}

async function makeCoupon(
  opts: { percentBp?: number; amountCentavos?: number; usageLimit?: number | null } = {},
) {
  const code = `__HOLD__${unique()}`.toUpperCase().slice(0, 40);
  const [row] = await getDb()
    .insert(coupons)
    .values({
      code,
      discountType: opts.amountCentavos === undefined ? 'percent' : 'fixed',
      percentBp: opts.amountCentavos === undefined ? (opts.percentBp ?? 1000) : null,
      amountCentavos: opts.amountCentavos ?? null,
      usageLimit: opts.usageLimit ?? null,
      isActive: true,
    });
  created.couponIds.push(row.insertId);
  return { id: row.insertId, code };
}

/** The minimum snapshot `bookings.price_snapshot` accepts. No test reads it. */
const FIXTURE_SNAPSHOT: PriceSnapshot = {
  tier: { tierId: 1, minPax: 1, maxPax: 12, pricePerPersonCentavos: 100000 },
  addons: [],
  coupon: null,
  depositPercent: 30,
  freeCancelHours: 48,
  subtotalCentavos: 100000,
  discountCentavos: 0,
  totalCentavos: 100000,
};

/** A committed booking, for the capacity and hold-cap premises. */
async function makeBooking(opts: {
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
      leadName: 'Hold Fixture',
      leadEmail: opts.email ?? 'fixture@example.test',
      leadPhone: opts.phone ?? '+639170000000',
      status: opts.status ?? 'pending_payment',
      payMode: 'full',
      priceSnapshot: FIXTURE_SNAPSHOT,
      subtotalCentavos: 100000,
      totalCentavos: 100000,
    });
  created.bookingIds.push(row.insertId);
  return row.insertId;
}

/**
 * The quote the browser would have been given, produced exactly the way the
 * quote endpoint will: `loadQuoteInputs` + `priceQuote` + `quoteDigest`.
 *
 * Using the real pricing service rather than a hand-written digest is the
 * point — `createHold` recomputes both from the database independently, so a
 * recompute that read the wrong add-ons, the wrong tier or the wrong coupon
 * produces a different total, a different digest, and a PRICE_CHANGED
 * refusal here.
 */
async function quoteFor(
  slug: string,
  date: string,
  pax: number,
  addonIds: number[] = [],
  couponCode?: string,
) {
  const inputs = await loadQuoteInputs(slug, date, addonIds, couponCode);
  const quote = priceQuote({ ...inputs, pax });
  const quoteId = quoteDigest({
    tourId: inputs.tourId,
    date,
    pax,
    addonIds,
    couponCode,
    totalCentavos: quote.totalCentavos,
  });
  return { inputs, quote, quoteId };
}

let guestSeq = 0;

/**
 * A validated `CreateHoldInput`. Parsed through the real schema, so the
 * phone normalisation and `.strict()` apply here exactly as they do on the
 * wire.
 */
function holdInput(over: {
  tourSlug: string;
  date: string;
  pax: number;
  quoteId: string;
  addonIds?: number[];
  couponCode?: string;
  email?: string;
  phone?: string;
  payMode?: 'full' | 'deposit';
}): CreateHoldInput {
  guestSeq += 1;
  return createHoldInput.parse({
    tourSlug: over.tourSlug,
    date: over.date,
    pax: over.pax,
    addonIds: over.addonIds ?? [],
    ...(over.couponCode ? { couponCode: over.couponCode } : {}),
    quoteId: over.quoteId,
    payMode: over.payMode ?? 'deposit',
    lead: {
      name: 'Juan Dela Cruz',
      email: over.email ?? `guest${guestSeq}_${Date.now()}@example.test`,
      phone: over.phone ?? `0917${String(1_000_000 + guestSeq).slice(-7)}`,
    },
    pickup: 'SM City Cebu, north entrance',
    requests: 'One vegetarian meal please.',
    consent: true,
  });
}

/** A hold, with its booking id registered for teardown if it succeeded. */
async function hold(input: CreateHoldInput, now: Date = NOW) {
  const result = await createHold(input, now);
  created.bookingIds.push(result.bookingId);
  return result;
}

async function bookingRow(id: number) {
  const [row] = await getDb().select().from(bookings).where(eq(bookings.id, id));
  if (!row) throw new Error(`booking ${id} not found`);
  return row;
}

/** Every row count a refusal must leave untouched. */
async function writtenRowCounts() {
  return {
    bookings: await count(sql`SELECT COUNT(*) n FROM bookings`),
    bookingAddons: await count(sql`SELECT COUNT(*) n FROM booking_addons`),
    auditLog: await count(sql`SELECT COUNT(*) n FROM audit_log`),
    couponRedemptions: await count(sql`SELECT COUNT(*) n FROM coupon_redemptions`),
    couponUsedCount: await count(sql`SELECT COALESCE(SUM(used_count), 0) n FROM coupons`),
  };
}

function auditRowsFor(bookingId: number) {
  return count(
    sql`SELECT COUNT(*) n FROM audit_log WHERE entity = 'bookings' AND entity_id = ${bookingId}`,
  );
}

/**
 * Bookings holding capacity on one date, across every tour. The status list
 * is interpolated from the shared constant rather than written out, so a
 * sixth capacity-holding status cannot silently narrow what this looks for.
 */
const HOLDING_STATUSES_SQL = sql.join(
  CAPACITY_HOLDING_STATUSES.map((status) => sql`${status}`),
  sql`, `,
);

function heldOnDate(date: string) {
  return count(
    sql`SELECT COUNT(*) n FROM bookings
        WHERE tour_date = ${date} AND status IN (${HOLDING_STATUSES_SQL})`,
  );
}

function rejections(results: PromiseSettledResult<unknown>[]) {
  return results
    .filter((r): r is PromiseRejectedResult => r.status === 'rejected')
    .map((r) => r.reason as unknown);
}

/**
 * Opens `n` pool connections and gives them straight back, so the pool has
 * them live.
 *
 * Not an optimisation. A `Promise.allSettled` pair where the second call has
 * to open a TCP connection and complete a MySQL handshake — while the first
 * runs sub-millisecond statements on a warm one — is a SEQUENTIAL pair
 * wearing a costume: MEASURED on the coupon race below, where it hid a
 * missing lock entirely. Every concurrency test in this file warms the pool
 * first rather than inheriting whatever state the previous test left.
 */
async function warmPool(n = 4) {
  const held = await Promise.all(Array.from({ length: n }, () => getPool().getConnection()));
  for (const connection of held) connection.release();
}

/**
 * The pool's own `connectionLimit`, read from the live pool rather than
 * restated here — a copy of the number would silently stop matching
 * `db/client.ts` and the exhaustion test below would then prove nothing.
 */
function poolConnectionLimit(): number {
  const core = (getPool() as unknown as { pool?: { config?: { connectionLimit?: number } } }).pool;
  const limit = core?.config?.connectionLimit;
  if (typeof limit !== 'number') {
    throw new Error('could not read the pool connectionLimit — mysql2 internals moved');
  }
  return limit;
}

/** Booking ids a concurrent pair actually created, so teardown can reach them. */
function registerFulfilled(results: PromiseSettledResult<{ bookingId: number }>[]) {
  for (const r of results) {
    if (r.status === 'fulfilled') created.bookingIds.push(r.value.bookingId);
  }
}

describeWithDb('createHold', () => {
  beforeEach(async () => {
    // Every capacity number here counts the WHOLE fleet, so a van or driver
    // left behind by another suite would change all of them. The seed
    // creates neither: prove the premise rather than assume it.
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

  it('writes one pending_payment booking, a 15-minute hold, the frozen snapshot, its add-on lines and one audit row', async () => {
    const tour = await makeTour({ groupsPerDay: 2, freeCancelHours: 48 });
    await makeFleet(2);
    const coupon = await makeCoupon({ percentBp: 1000 });
    const addonIds = [tour.lunchId, tour.photographerId];
    const { quote, quoteId } = await quoteFor(tour.slug, DAY, 4, addonIds, coupon.code);

    const result = await hold(
      holdInput({
        tourSlug: tour.slug,
        date: DAY,
        pax: 4,
        addonIds,
        couponCode: coupon.code,
        quoteId,
      }),
    );

    expect(result.ref).toMatch(/^RG-[ABCDEFGHJKMNPQRSTVWXYZ23456789]{6}$/);
    // §5 says FIFTEEN minutes. Both expiry assertions below are written as
    // `NOW + HOLD_MINUTES`, so without this line a constant changed to 30
    // would keep them green and "15 minutes out" would be asserted nowhere.
    expect(HOLD_MINUTES).toBe(15);
    expect(result.holdExpiresAt.getTime()).toBe(NOW.getTime() + HOLD_MINUTES * 60_000);

    const row = await bookingRow(result.bookingId);
    expect(row.status).toBe('pending_payment');
    expect(row.holdExpiresAt?.getTime()).toBe(NOW.getTime() + HOLD_MINUTES * 60_000);
    expect(row.amountPaidCentavos, 'a hold must not be paid').toBe(0);
    expect(row.payMode).toBe('deposit');
    expect(row.couponId).toBe(coupon.id);
    expect(row.leadPhone, 'the schema normalises the phone').toMatch(/^\+639\d{9}$/);
    expect(row.subtotalCentavos).toBe(quote.subtotalCentavos);
    expect(row.discountCentavos).toBe(quote.discountCentavos);
    expect(row.totalCentavos).toBe(quote.totalCentavos);

    // The snapshot — Q5's whole point: a later tour edit cannot change what
    // this guest agreed to, including the cancellation window.
    const snapshot = priceSnapshotSchema.parse(row.priceSnapshot);
    expect(snapshot.freeCancelHours).toBe(48);
    expect(snapshot.depositPercent).toBe(30);
    expect(snapshot.tier).toEqual({
      tierId: quote.tier.id,
      minPax: 4,
      maxPax: 12,
      pricePerPersonCentavos: 189000,
    });
    expect(snapshot.coupon).toEqual({
      id: coupon.id,
      code: coupon.code,
      discount: { discountType: 'percent', percentBp: 1000, amountCentavos: null },
    });
    expect(snapshot.totalCentavos).toBe(quote.totalCentavos);

    // One add-on LINE per add-on, each with its own frozen name and price.
    const lines = await getDb()
      .select()
      .from(bookingAddons)
      .where(eq(bookingAddons.bookingId, result.bookingId));
    expect(lines).toHaveLength(2);
    const lunch = lines.find((l) => l.addonId === tour.lunchId);
    const photographer = lines.find((l) => l.addonId === tour.photographerId);
    expect(lunch).toMatchObject({
      name: 'Island lunch',
      priceCentavos: 35000,
      perPerson: true,
      qty: 4,
    });
    expect(photographer).toMatchObject({
      name: 'Photographer',
      priceCentavos: 150000,
      perPerson: false,
      qty: 1,
    });

    // The hold reserves the coupon too (Q7/Q8), and the change is audited.
    expect(await auditRowsFor(result.bookingId)).toBe(1);
    expect(
      await count(
        sql`SELECT COUNT(*) n FROM coupon_redemptions WHERE coupon_id = ${coupon.id} AND booking_id = ${result.bookingId}`,
      ),
    ).toBe(1);
    expect(await count(sql`SELECT used_count n FROM coupons WHERE id = ${coupon.id}`)).toBe(1);
  });

  /**
   * The money stored is the SERVER's, recomputed from the database — never
   * anything that came from the browser (CLAUDE.md). Expected values are
   * built here from the raw tier and add-on rows, independently of both the
   * quote endpoint's helper and `createHold`'s own loader.
   */
  it('stores the money a fresh priceQuote over the same database rows produces', async () => {
    const tour = await makeTour({ groupsPerDay: 1 });
    await makeFleet(1);
    const addonIds = [tour.lunchId];
    const { quoteId } = await quoteFor(tour.slug, DAY, 2, addonIds);

    const result = await hold(
      holdInput({ tourSlug: tour.slug, date: DAY, pax: 2, addonIds, quoteId }),
    );

    const db = getDb();
    const tiers = await db
      .select({
        id: tourPriceTiers.id,
        minPax: tourPriceTiers.minPax,
        maxPax: tourPriceTiers.maxPax,
        pricePerPersonCentavos: tourPriceTiers.pricePerPersonCentavos,
      })
      .from(tourPriceTiers)
      .where(eq(tourPriceTiers.tourId, tour.tourId));
    const [addon] = await db
      .select({
        id: tourAddons.id,
        name: tourAddons.name,
        priceCentavos: tourAddons.priceCentavos,
        perPerson: tourAddons.perPerson,
      })
      .from(tourAddons)
      .where(eq(tourAddons.id, tour.lunchId));

    const expected = priceQuote({
      tiers,
      pax: 2,
      addons: [addon!],
      coupon: null,
      depositPercent: 30,
      freeCancelHours: 48,
    });
    // 2 × ₱2,500 + 2 × ₱350 = ₱5,700, no coupon.
    expect(expected.totalCentavos).toBe(570000);

    const row = await bookingRow(result.bookingId);
    expect(row.subtotalCentavos).toBe(expected.subtotalCentavos);
    expect(row.discountCentavos).toBe(0);
    expect(row.totalCentavos).toBe(expected.totalCentavos);
    expect(row.couponId).toBeNull();
    const snapshot = priceSnapshotSchema.parse(row.priceSnapshot);
    expect(snapshot.coupon).toBeNull();
    expect(snapshot.subtotalCentavos).toBe(expected.subtotalCentavos);
    expect(snapshot.totalCentavos).toBe(expected.totalCentavos);
  });

  // -------------------------------------------------------------------------
  // Refusals — and every one of them must write NOTHING
  // -------------------------------------------------------------------------

  it('refuses a sold-out day and writes nothing at all', async () => {
    const tour = await makeTour({ groupsPerDay: 1 });
    await makeFleet(2);
    const coupon = await makeCoupon({ percentBp: 1000 });
    const addonIds = [tour.lunchId];
    const { quoteId } = await quoteFor(tour.slug, DAY, 4, addonIds, coupon.code);
    // The day's one group is already taken.
    await makeBooking({ tourId: tour.tourId, date: DAY });

    const before = await writtenRowCounts();
    const error = await hold(
      holdInput({
        tourSlug: tour.slug,
        date: DAY,
        pax: 4,
        addonIds,
        couponCode: coupon.code,
        quoteId,
      }),
    ).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(CapacityRefusedError);
    expect((error as CapacityRefusedError).reason).toBe('tour_sold_out');
    // Not merely "it threw": a refusal that left a booking, an add-on line,
    // an audit row or a consumed coupon use behind would be a sold slot.
    expect(await writtenRowCounts()).toEqual(before);
  });

  it('refuses a tour that has been switched off', async () => {
    const tour = await makeTour({ groupsPerDay: 1 });
    await makeFleet(1);
    const { quoteId } = await quoteFor(tour.slug, DAY, 2);
    await getPool().query('UPDATE tours SET is_active = 0 WHERE id = ?', [tour.tourId]);

    const before = await writtenRowCounts();
    const error = await hold(holdInput({ tourSlug: tour.slug, date: DAY, pax: 2, quoteId })).catch(
      (e: unknown) => e,
    );

    expect(error).toBeInstanceOf(CapacityRefusedError);
    expect((error as CapacityRefusedError).reason).toBe('tour_unavailable');
    expect(await writtenRowCounts()).toEqual(before);
  });

  /**
   * Owner decision Q3: the quote id is a CHANGE DETECTOR. A digest that no
   * longer matches the server's own recompute is refused — and the money on
   * the booking always comes from the recompute, never from the client.
   */
  it('refuses a stale quote id with PRICE_CHANGED', async () => {
    const tour = await makeTour({ groupsPerDay: 2 });
    await makeFleet(2);
    const { quoteId } = await quoteFor(tour.slug, DAY, 4);

    const before = await writtenRowCounts();
    const error = await hold(
      holdInput({ tourSlug: tour.slug, date: DAY, pax: 4, quoteId: 'f'.repeat(32) }),
    ).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PriceChangedError);
    expect(await writtenRowCounts()).toEqual(before);

    // The real-world case: an admin edits the tier between the quote and the
    // hold. The OLD quote id is now stale, and the hold must refuse rather
    // than honour a price nobody offers any more.
    await getPool().query(
      'UPDATE tour_price_tiers SET price_per_person_centavos = ? WHERE tour_id = ? AND min_pax = 4',
      [199000, tour.tourId],
    );
    const stale = await hold(holdInput({ tourSlug: tour.slug, date: DAY, pax: 4, quoteId })).catch(
      (e: unknown) => e,
    );
    expect(stale).toBeInstanceOf(PriceChangedError);
    expect(await writtenRowCounts()).toEqual(before);
  });

  /**
   * Ruling 15 / §5 step 1, first half. A CIVIL date in Asia/Manila, compared
   * against Manila's own today — not a UTC instant.
   */
  it('refuses a tour date already past in Asia/Manila', async () => {
    const tour = await makeTour({ groupsPerDay: 1 });
    await makeFleet(1);
    const past = '2099-11-30'; // the day before NOW's Manila date
    const { quoteId } = await quoteFor(tour.slug, past, 2);

    const before = await writtenRowCounts();
    const error = await hold(holdInput({ tourSlug: tour.slug, date: past, pax: 2, quoteId })).catch(
      (e: unknown) => e,
    );

    expect(error).toBeInstanceOf(TourDatePastError);
    expect(await writtenRowCounts()).toEqual(before);
  });

  /**
   * And the midnight case the civil-date rule exists for. At
   * 2099-12-05T16:30Z it is already 00:30 on the 6th in Cebu: the 5th is
   * yesterday there and must be refused, the 6th is today and must be
   * allowed. An implementation that took "today" from the UTC clock would
   * accept the 5th.
   */
  it('takes "today" from the Manila calendar, not the UTC clock', async () => {
    const tour = await makeTour({ groupsPerDay: 1 });
    await makeFleet(2);
    const justAfterManilaMidnight = new Date('2099-12-05T16:30:00Z');

    const yesterday = await quoteFor(tour.slug, DAY, 2);
    const error = await hold(
      holdInput({ tourSlug: tour.slug, date: DAY, pax: 2, quoteId: yesterday.quoteId }),
      justAfterManilaMidnight,
    ).catch((e: unknown) => e);
    expect(error, `${DAY} is yesterday in Manila`).toBeInstanceOf(TourDatePastError);

    const today = await quoteFor(tour.slug, DAY_AFTER, 2);
    const result = await hold(
      holdInput({ tourSlug: tour.slug, date: DAY_AFTER, pax: 2, quoteId: today.quoteId }),
      justAfterManilaMidnight,
    );
    expect((await bookingRow(result.bookingId)).status).toBe('pending_payment');
  });

  /** Ruling 15 / §5 step 1, second half: `tour_blocked_dates`. */
  it('refuses a date the tour has blocked', async () => {
    const tour = await makeTour({ groupsPerDay: 1 });
    await makeFleet(1);
    const { quoteId } = await quoteFor(tour.slug, DAY, 2);
    await getDb()
      .insert(tourBlockedDates)
      .values({
        tourId: tour.tourId,
        date: new Date(`${DAY}T00:00:00Z`),
        reason: 'Fiesta — no trips',
      });

    const before = await writtenRowCounts();
    const error = await hold(holdInput({ tourSlug: tour.slug, date: DAY, pax: 2, quoteId })).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(TourDateBlockedError);
    expect(await writtenRowCounts()).toEqual(before);

    // The block is per tour per DAY: the next day is still bookable.
    const next = await quoteFor(tour.slug, DAY_AFTER, 2);
    const ok = await hold(
      holdInput({ tourSlug: tour.slug, date: DAY_AFTER, pax: 2, quoteId: next.quoteId }),
    );
    expect(ok.bookingId).toBeGreaterThan(0);
  });

  // -------------------------------------------------------------------------
  // Ruling 5 / Q4 — two active unpaid holds per email AND per phone
  // -------------------------------------------------------------------------

  it('refuses a third active hold for the same email', async () => {
    const tour = await makeTour({ groupsPerDay: 3 });
    await makeFleet(3);
    const email = `cap_${unique()}@example.test`;
    // Two live holds already, on OTHER days — the cap is per guest, not per
    // date, and parking them elsewhere keeps capacity out of the picture.
    await makeBooking({ tourId: tour.tourId, date: DAY_BEFORE, email, phone: '+639170000011' });
    await makeBooking({ tourId: tour.tourId, date: DAY_AFTER, email, phone: '+639170000012' });
    expect(MAX_ACTIVE_HOLDS_PER_GUEST).toBe(2);

    const { quoteId } = await quoteFor(tour.slug, DAY, 2);
    const before = await writtenRowCounts();
    const error = await hold(
      holdInput({ tourSlug: tour.slug, date: DAY, pax: 2, quoteId, email, phone: '09170000013' }),
    ).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(HoldLimitReachedError);
    expect((error as HoldLimitReachedError).scope).toBe('email');
    expect(await writtenRowCounts()).toEqual(before);
  });

  /**
   * The AND, not an OR: two holds under one phone and two DIFFERENT emails
   * must still refuse the third, or one guest takes four slots by reusing an
   * email with two phone numbers.
   */
  it('refuses a third active hold for the same phone even under a different email', async () => {
    const tour = await makeTour({ groupsPerDay: 3 });
    await makeFleet(3);
    const phone = phPhoneSchema.parse('0917 555 0101');
    await makeBooking({
      tourId: tour.tourId,
      date: DAY_BEFORE,
      email: `a_${unique()}@example.test`,
      phone,
    });
    await makeBooking({
      tourId: tour.tourId,
      date: DAY_AFTER,
      email: `b_${unique()}@example.test`,
      phone,
    });

    const { quoteId } = await quoteFor(tour.slug, DAY, 2);
    const before = await writtenRowCounts();
    const error = await hold(
      holdInput({
        tourSlug: tour.slug,
        date: DAY,
        pax: 2,
        quoteId,
        email: `c_${unique()}@example.test`,
        phone: '0917-555-0101',
      }),
    ).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(HoldLimitReachedError);
    expect((error as HoldLimitReachedError).scope).toBe('phone');
    expect(await writtenRowCounts()).toEqual(before);
  });

  it('allows a second hold for the same guest — the cap is two, not one', async () => {
    const tour = await makeTour({ groupsPerDay: 3 });
    await makeFleet(3);
    const email = `pair_${unique()}@example.test`;
    const phone = '0917 555 0202';

    const first = await quoteFor(tour.slug, DAY, 2);
    await hold(
      holdInput({ tourSlug: tour.slug, date: DAY, pax: 2, quoteId: first.quoteId, email, phone }),
    );
    const second = await quoteFor(tour.slug, DAY_AFTER, 2);
    const ok = await hold(
      holdInput({
        tourSlug: tour.slug,
        date: DAY_AFTER,
        pax: 2,
        quoteId: second.quoteId,
        email,
        phone,
      }),
    );
    expect(ok.bookingId).toBeGreaterThan(0);
  });

  // -------------------------------------------------------------------------
  // The races. Driven CONCURRENTLY: a sequential pair passes against code
  // with no lock at all.
  // -------------------------------------------------------------------------

  /**
   * **The last slot cannot be held by two guests.** One group per day, two
   * guests submitting at once. The loser must be REFUSED with a reason a
   * guest can be shown — a deadlock or a lock-wait timeout satisfies
   * "exactly one rejected" identically, and that is the failure this test
   * exists to catch, so the reason is asserted too.
   *
   * **The overlap is CONSTRUCTED, not hoped for.** A bare `Promise.allSettled`
   * leaves it to the pool's warmth — measured on the coupon race below, where
   * the pair ran one after another and a missing lock went unnoticed. This
   * test is the only thing pinning "no plain read before the locks" (the
   * REPEATABLE READ snapshot hazard `capacity.ts` documents), so an overlap
   * that depends on machine, CI, file order or pool size would let a snapshot
   * regression ship behind a green run. So: the pool is warmed, the slot rows
   * are pre-created, a third connection holds the TOUR row so both holds
   * must stall inside `takeSlotLocks`, and the CHECKPOINT asserts that
   * neither call had settled while that lock was held — i.e. both were
   * genuinely in flight — before the holder lets go and the race runs.
   */
  it('lets only one of two concurrent guests hold the last slot', async () => {
    const tour = await makeTour({ groupsPerDay: 1 });
    await makeFleet(2);
    const a = await quoteFor(tour.slug, DAY, 2);
    await warmPool();
    // Pre-created, so the two holds contend on the LOCK rather than on each
    // other's `INSERT … ON DUPLICATE KEY UPDATE` of a new key (Ruling 20).
    await getDb().transaction((tx) => takeSlotLocks(tx, tour.tourId, DAY));

    const settled = [false, false];
    let race: Promise<PromiseSettledResult<{ bookingId: number }>[]>;
    let settledAtCheckpoint: boolean[] = [];
    const holder = await getPool().getConnection();
    try {
      await holder.beginTransaction();
      await holder.query(
        'SELECT tour_id FROM tour_date_slots WHERE tour_id = ? AND date = ? FOR UPDATE',
        [tour.tourId, DAY],
      );

      race = Promise.allSettled(
        [0, 1].map((i) =>
          createHold(
            holdInput({ tourSlug: tour.slug, date: DAY, pax: 2, quoteId: a.quoteId }),
            NOW,
          ).finally(() => {
            settled[i] = true;
          }),
        ),
      );
      // Long enough that a connection handshake cannot explain a stall.
      await new Promise((r) => setTimeout(r, 300));
      settledAtCheckpoint = [...settled];
    } finally {
      await holder.rollback();
      holder.release();
    }

    const results = await race;
    registerFulfilled(results);

    expect(
      settledAtCheckpoint,
      'a hold finished before the race started — the two never overlapped, so this test proves nothing',
    ).toEqual([false, false]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const [refusal] = rejections(results);
    expect(refusal, `the loser was killed, not refused: ${String(refusal)}`).toBeInstanceOf(
      CapacityRefusedError,
    );
    expect((refusal as CapacityRefusedError).reason).toBe('tour_sold_out');
    expect(await heldOnDate(DAY), 'the day was oversold').toBe(1);
  });

  /**
   * **A single-use coupon cannot be held twice.** Two guests, two DIFFERENT
   * dates — so nothing but the coupon row can serialise them — and one
   * coupon with `usage_limit = 1`. Both pass the early `validateCoupon`
   * (each reads `used_count = 0` from its own snapshot); the authoritative
   * re-check under the coupon's own `FOR UPDATE` is what refuses the loser.
   *
   * **The refusal is told apart STRUCTURALLY, by class.** The two checks
   * produce the same message, so asserting the message proves nothing: if
   * either hold had not reached the lock when the holder let go, the loser
   * would be refused by the early read and this test would pass while the
   * lock was missing entirely. `reserveCouponUnderLock` throws
   * `CouponExhaustedUnderLockError` — a subclass, so a caller still sees a
   * usage-limit refusal — and only the under-lock path can produce it.
   */
  it('lets only one of two concurrent guests hold a single-use coupon', async () => {
    const tour = await makeTour({ groupsPerDay: 3 });
    await makeFleet(3);
    const coupon = await makeCoupon({ percentBp: 1000, usageLimit: 1 });
    const first = await quoteFor(tour.slug, DAY, 2, [], coupon.code);
    const second = await quoteFor(tour.slug, DAY_AFTER, 2, [], coupon.code);

    /*
     * **MEASURED, and the reason a third connection is involved.** Started
     * with a bare `Promise.allSettled`, this test passed with
     * `reserveCouponUnderLock` deleted: the two holds did not actually
     * overlap (the second one pays a pool connection handshake the first
     * does not), so the loser was refused by the UNLOCKED `validateCoupon`
     * read and nothing proved the lock existed. A pair that does not
     * interleave is a sequential pair wearing a costume.
     *
     * So the coupon row is held `FOR UPDATE` by a third connection while
     * both holds run: each one gets past `validateCoupon` — which reads
     * `used_count = 0`, because nothing has committed — and then stalls
     * asking for the row. Releasing the holder starts the real race, and
     * only the re-check under the lock can separate them.
     *
     * The wait is on the clock, as in `capacity.test.ts`'s lock-order probe:
     * this user can read neither `performance_schema.data_locks` nor
     * `information_schema.innodb_trx` (both denied), so there is no lock-wait
     * view to poll.
     */
    /*
     * **Pre-create both pairs of slot lock rows**, as `capacity.test.ts`
     * does in its lock-order probe — and here it is load-bearing, not an
     * optimisation. MEASURED: with the rows absent, the second hold blocks
     * inside `takeSlotLocks` on the FIRST hold's `INSERT … ON DUPLICATE KEY
     * UPDATE` (a new key in `tour_date_slots`/`fleet_date_slots` takes a
     * next-key lock, and the other date falls in that gap) until the first
     * commits — so the two holds serialise before the coupon is ever
     * reached and the race under test never happens.
     */
    for (const date of [DAY, DAY_AFTER]) {
      await getDb().transaction((tx) => takeSlotLocks(tx, tour.tourId, date));
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
        [
          { date: DAY, quoteId: first.quoteId },
          { date: DAY_AFTER, quoteId: second.quoteId },
        ].map((leg, i) =>
          createHold(
            holdInput({
              tourSlug: tour.slug,
              date: leg.date,
              pax: 2,
              couponCode: coupon.code,
              quoteId: leg.quoteId,
            }),
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
    // The subclass: refused by the re-check UNDER THE LOCK, not by the early
    // read and not by a deadlock kill followed by a retry.
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

  /**
   * Three concurrent holds for the same date, where the `fleet_date_slots`
   * row does not exist yet — the shape Task 4 measured a deadlock in. All
   * three must get their slot: none refused, none killed.
   *
   * **This test does not by itself pin the `ER_LOCK_DEADLOCK` retry.**
   * Deleting the retry leaves it green, because the deadlock could not be
   * provoked on demand on this machine (four runs, no victim) — the two
   * tests below pin the retry deterministically instead. What this one does
   * guard is that three-way concurrency on one date serves everyone rather
   * than refusing or killing someone.
   */
  it('serves all three of three concurrent holds for the same date', async () => {
    const tour = await makeTour({ groupsPerDay: 3 });
    await makeFleet(3);
    const { quoteId } = await quoteFor(tour.slug, DAY, 2);
    const inputs = [0, 1, 2].map(() =>
      holdInput({ tourSlug: tour.slug, date: DAY, pax: 2, quoteId }),
    );
    // Warm the pool first: a connection handshake is slower than every
    // statement in the transaction, so without this the "concurrent" holds
    // queue up one behind another and race nothing.
    await Promise.all([0, 1, 2, 3].map(() => getDb().execute(sql`SELECT 1`)));

    const results = await Promise.allSettled(inputs.map((input) => createHold(input, NOW)));
    registerFulfilled(results);

    expect(
      rejections(results).map(String),
      'a concurrent hold was killed rather than served',
    ).toEqual([]);
    expect(await heldOnDate(DAY)).toBe(3);
  });

  /**
   * **The coupon lock is LAST: fleet → tour → coupon.** Observed rather than
   * assumed, the same way `capacity.test.ts` observes the fleet-before-tour
   * order — a coupon lock taken earlier lets two guests holding DIFFERENT
   * tours with the SAME coupon each hold one row the other needs, and a
   * deadlock passes every sequential test.
   *
   * The probe: another connection holds the TOUR slot row, so `createHold`
   * stalls inside `takeSlotLocks`. While it is stalled, a third connection
   * asks for the coupon row with `NOWAIT`. The coupon lock comes after both
   * slot locks, so that request must SUCCEED — if it is refused, the hold
   * had already locked the coupon before finishing the slot locks.
   */
  it('takes the coupon lock after both slot locks, never before', async () => {
    const tour = await makeTour({ groupsPerDay: 1 });
    await makeFleet(1);
    const coupon = await makeCoupon({ percentBp: 1000 });
    const { quoteId } = await quoteFor(tour.slug, DAY, 2, [], coupon.code);
    // Pre-create both lock rows, so this measures locking, not insertion.
    await getDb().transaction((tx) => takeSlotLocks(tx, tour.tourId, DAY));

    const holder = await getPool().getConnection();
    let held: Promise<{ bookingId: number }> | undefined;
    try {
      await holder.beginTransaction();
      await holder.query(
        'SELECT tour_id FROM tour_date_slots WHERE tour_id = ? AND date = ? FOR UPDATE',
        [tour.tourId, DAY],
      );

      held = createHold(
        holdInput({ tourSlug: tour.slug, date: DAY, pax: 2, couponCode: coupon.code, quoteId }),
        NOW,
      );
      await new Promise((r) => setTimeout(r, 300));

      const probe = await getPool().getConnection();
      try {
        await probe.beginTransaction();
        // Resolved to a sentinel either way, so a FAILURE reads as "locked"
        // rather than as a formatting error on a driver object.
        const outcome = await probe
          .query('SELECT used_count FROM coupons WHERE id = ? FOR UPDATE NOWAIT', [coupon.id])
          .then(() => 'free')
          .catch((error: Error) => error.message);
        expect(
          outcome,
          'the coupon row was already locked while the hold waited on the tour row — the coupon lock is not last',
        ).toBe('free');
      } finally {
        await probe.rollback();
        probe.release();
      }
    } finally {
      await holder.rollback();
      holder.release();
    }

    // And once the tour row is free the hold completes normally.
    const result = await held;
    created.bookingIds.push(result.bookingId);
    expect((await bookingRow(result.bookingId)).couponId).toBe(coupon.id);
  });

  // -------------------------------------------------------------------------
  // The pool. Nothing inside the transaction may check out a second
  // connection — see the module note on `create-hold.ts`.
  // -------------------------------------------------------------------------

  /**
   * **The regression test for the Critical fix (Ruling 19).** A hold runs
   * inside a transaction, which holds one of the pool's ten connections. If
   * anything inside that transaction then checks out a SECOND connection —
   * `validateCoupon` did, through `getDb()` — then ten concurrent
   * coupon-bearing holds hold all ten connections and each wait for an
   * eleventh. mysql2's connection queue is unbounded and untimed, so nothing
   * releases and nothing times out: the process wedges until it is
   * restarted, taking every other database request with it.
   *
   * Ten concurrent holds is not a thing a test suite can stage reliably, so
   * this stages the same condition deterministically from the other end:
   * check out `connectionLimit - 1` connections by hand, leaving exactly
   * one, and run ONE coupon-bearing hold. With every read going through
   * `tx`, that one connection is enough and the hold completes. Before the
   * fix it waits forever — the race below turns that into a 2-second
   * failure with a message rather than a hung suite.
   *
   * The 2-second ceiling also keeps the hogged connections from leaking: the
   * attempt is awaited again after they are released, so a slow pass and a
   * real regression both end with the pool as they found it.
   */
  it('holds a coupon-bearing booking with only one pool connection left', async () => {
    const tour = await makeTour({ groupsPerDay: 1 });
    await makeFleet(1);
    const coupon = await makeCoupon({ percentBp: 1000 });
    const { quoteId } = await quoteFor(tour.slug, DAY, 2, [], coupon.code);

    const limit = poolConnectionLimit();
    expect(limit, 'a pool of one cannot stage this').toBeGreaterThan(1);
    const hogged = [];
    for (let i = 0; i < limit - 1; i += 1) hogged.push(await getPool().getConnection());

    // One promise, awaited twice: `hold` registers its booking for teardown.
    const attempt = hold(
      holdInput({ tourSlug: tour.slug, date: DAY, pax: 2, couponCode: coupon.code, quoteId }),
    )
      .then(() => 'held' as const)
      .catch((error: unknown) => `failed: ${String(error)}`);

    const outcome = await Promise.race([
      attempt,
      new Promise<string>((resolve) =>
        setTimeout(
          () =>
            resolve(
              'timed out: the hold is waiting for a pool connection it can never get — something inside the transaction took a second connection',
            ),
          2000,
        ),
      ),
    ]);
    for (const connection of hogged) connection.release();
    await attempt;

    expect(outcome).toBe('held');
    expect(await heldOnDate(DAY)).toBe(1);
    expect(
      await count(sql`SELECT used_count n FROM coupons WHERE id = ${coupon.id}`),
      'the coupon was not reserved',
    ).toBe(1);
  });

  // -------------------------------------------------------------------------
  // The ER_LOCK_DEADLOCK retry
  // -------------------------------------------------------------------------

  /**
   * A MySQL error as `createHold` actually receives one: mysql2 decorates the
   * error it throws with `errno`/`code`, and Drizzle wraps that in its own
   * error and moves the original onto `.cause` — which is why the detector
   * walks the cause chain rather than reading `error.code` one level up.
   */
  function mysqlError(errno: number, code: string): Error {
    const inner = Object.assign(new Error(`${code} (${errno})`), { errno, code });
    return Object.assign(new Error('Failed query'), { cause: inner });
  }

  /**
   * The deadlock is injected rather than provoked, because provoking it is
   * exactly what could not be made reliable: InnoDB picks the victim. The
   * transaction is rejected ONCE with a wrapped 1213, and the hold must
   * still succeed — from a second, complete transaction, with one booking at
   * the end of it and not two half-written ones.
   */
  it('restarts the whole transaction when InnoDB kills it as a deadlock victim', async () => {
    const tour = await makeTour({ groupsPerDay: 1 });
    await makeFleet(1);
    const { quoteId } = await quoteFor(tour.slug, DAY, 2);

    const db = getDb();
    const realTransaction = db.transaction.bind(db);
    let attempts = 0;
    const spy = vi.spyOn(db, 'transaction').mockImplementation(((...args: unknown[]) => {
      attempts += 1;
      if (attempts === 1) return Promise.reject(mysqlError(1213, 'ER_LOCK_DEADLOCK'));
      return (realTransaction as (...a: unknown[]) => unknown)(...args);
    }) as typeof db.transaction);

    try {
      const result = await hold(holdInput({ tourSlug: tour.slug, date: DAY, pax: 2, quoteId }));
      expect(attempts, 'the transaction was not retried').toBe(2);
      expect((await bookingRow(result.bookingId)).status).toBe('pending_payment');
      expect(await auditRowsFor(result.bookingId), 'the retry wrote a second audit row').toBe(1);
      expect(await heldOnDate(DAY), 'the retry booked the slot twice').toBe(1);
    } finally {
      spy.mockRestore();
    }
  });

  /**
   * And after {@link MAX_DEADLOCK_ATTEMPTS} it gives up with a TYPED error
   * rather than Drizzle's opaque `Failed query`: the router next task needs
   * one vocabulary for every way a hold can fail, and "the date is being
   * hammered, try again" is a different sentence to a guest than a 500. The
   * killed transaction is kept as `cause` so the log still names the MySQL
   * error, and nothing is written.
   */
  it('gives up with a typed HoldContentionError after three deadlocks', async () => {
    const tour = await makeTour({ groupsPerDay: 1 });
    await makeFleet(1);
    const { quoteId } = await quoteFor(tour.slug, DAY, 2);

    const db = getDb();
    let attempts = 0;
    const spy = vi.spyOn(db, 'transaction').mockImplementation(((...args: unknown[]) => {
      void args;
      attempts += 1;
      return Promise.reject(mysqlError(1213, 'ER_LOCK_DEADLOCK'));
    }) as typeof db.transaction);

    try {
      const error = await createHold(
        holdInput({ tourSlug: tour.slug, date: DAY, pax: 2, quoteId }),
        NOW,
      ).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(HoldContentionError);
      expect((error as HoldContentionError).attempts).toBe(3);
      expect(attempts, 'the retry is not bounded at three attempts').toBe(3);
      expect(
        (error as Error).cause,
        'the killed transaction must survive as `cause` for the log',
      ).toBeDefined();
      expect(await heldOnDate(DAY)).toBe(0);
    } finally {
      spy.mockRestore();
    }
  });

  /**
   * And the retry stays NARROW. A lock-wait timeout (1205) means someone
   * else is sitting on a lock for 50 seconds; re-running that wait helps
   * nobody, so it propagates on the first attempt.
   */
  it('does not retry a lock-wait timeout', async () => {
    const tour = await makeTour({ groupsPerDay: 1 });
    await makeFleet(1);
    const { quoteId } = await quoteFor(tour.slug, DAY, 2);

    const db = getDb();
    let attempts = 0;
    const spy = vi.spyOn(db, 'transaction').mockImplementation(((...args: unknown[]) => {
      void args;
      attempts += 1;
      return Promise.reject(mysqlError(1205, 'ER_LOCK_WAIT_TIMEOUT'));
    }) as typeof db.transaction);

    try {
      const error = await createHold(
        holdInput({ tourSlug: tour.slug, date: DAY, pax: 2, quoteId }),
        NOW,
      ).catch((e: unknown) => e);
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
    await db.delete(bookingAddons).where(eq(bookingAddons.bookingId, id));
    /*
     * Raw SQL, not `db.delete(bookings)`, and deliberately: the convention
     * guard in `schema-conventions.test.ts` scans the whole server tree —
     * tests included — for the Drizzle form, and exempts only the raw-SQL
     * form for exactly this case, a fixture removing its own rows from
     * `rg_travel_test`. `capacity.test.ts` cleans up the same way.
     */
    await pool.query('DELETE FROM bookings WHERE id = ?', [id]);
  }
  for (const id of created.couponIds) await db.delete(coupons).where(eq(coupons.id, id));
  for (const id of created.tourIds) {
    await db.delete(tourBlockedDates).where(eq(tourBlockedDates.tourId, id));
    await db.delete(tourAddons).where(eq(tourAddons.tourId, id));
    await db.delete(tourPriceTiers).where(eq(tourPriceTiers.tourId, id));
    await pool.query('DELETE FROM tour_date_slots WHERE tour_id = ?', [id]);
    await db.delete(tours).where(eq(tours.id, id));
  }
  for (const id of created.destinationIds) {
    await db.delete(destinations).where(eq(destinations.id, id));
  }
  for (const id of created.driverIds) await db.delete(drivers).where(eq(drivers.id, id));
  for (const id of created.vanIds) await db.delete(vans).where(eq(vans.id, id));
  for (const day of DAYS) {
    await pool.query('DELETE FROM fleet_date_slots WHERE date = ?', [day]);
  }
  // The past-date test uses a day outside DAYS; its lock row is created
  // before the guard refuses, inside a transaction that rolls back — but the
  // row can survive if a future change moves the guard. Cheap insurance.
  await pool.query('DELETE FROM fleet_date_slots WHERE date = ?', ['2099-11-30']);
  created.bookingIds = [];
  created.couponIds = [];
  created.tourIds = [];
  created.destinationIds = [];
  created.driverIds = [];
  created.vanIds = [];
}
