/**
 * Week 5 "Dispatch", Task 10: `admin.dispatch.assign` — the assignment
 * mutation. **The most dangerous test file in this week**: it is the first
 * to exercise code that writes `bookings.van_id` / `.driver_id`, and a wrong
 * answer here is a van sent to two trips on the same morning.
 *
 * Fixtures are COMMITTED and cleaned up per test, exactly as
 * `dispatch-availability.test.ts` does and for the same reason: `vans` and
 * `drivers` are not scoped to a date, every test depends on the fleet being
 * exactly what it built, and this file alphabetically precedes
 * `dispatch-availability.test.ts`'s own zero-leftover sanity check — a row
 * left behind here would fail that file, not this one, which is precisely
 * the "32 unrelated failures" shape `global-setup.ts`'s leak guard exists
 * to catch sooner.
 *
 * Role refusals are asserted on `code`, never the message
 * (`admin-bookings.test.ts:256-272`'s pattern) — `requireRole()` throws
 * `'Admin sign-in required.'` / `'Not permitted for this account.'`, and
 * neither contains the word a message-matching regex would look for.
 */
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { ZodError } from 'zod';
import { OVERRIDE_REASON_MIN_LENGTH, type BookingStatus, type PriceSnapshot } from '@rg/shared';
import { appRouter } from '../routers/_app';
import { assignVanAndDriver } from '../services/dispatch/assign';
import { getDb, getPool } from '../db/client';
import {
  auditLog,
  bookingTransferDetails,
  bookings,
  destinations,
  driverLeaves,
  drivers,
  payments,
  tours,
  transferPlaces,
  transferRoutes,
  users,
  vans,
  vehicleTypes,
} from '../db/schema';
import { generateBookingRef } from '../services/booking-ref';
import { resetTransportForTests, setTransportForTests } from '../services/notify';
import { staffContext } from './helpers/ctx';
import { describeWithDb } from './helpers/db';

/** Far enough out that no seed or other suite's fixture owns it. */
const TOUR_DATE = '2099-12-15';

/** Random first, timestamp second — same discipline as capacity.test.ts. */
const unique = () => `${Math.floor(Math.random() * 1e9)}_${Date.now()}`;

/** Every id this file commits, so `afterEach` removes exactly those rows. */
const created = {
  bookingIds: [] as number[],
  tourIds: [] as number[],
  routeIds: [] as number[],
  destIds: [] as number[],
  placeIds: [] as number[],
  vanIds: [] as number[],
  driverIds: [] as number[],
  leaveIds: [] as number[],
};

/**
 * The real, global `vehicle_types.id` for `'van'`/`'suv'` — seeded by
 * `seedBase` (migration 0023), never a literal id (CLAUDE.md). Resolved
 * fresh in `beforeEach` into `VAN_ID`/`SUV_ID`, below.
 */
let VAN_ID: number;
let SUV_ID: number;

async function vehicleTypeIdBySlug(slug: string): Promise<number> {
  const [row] = await getDb()
    .select({ id: vehicleTypes.id })
    .from(vehicleTypes)
    .where(eq(vehicleTypes.slug, slug))
    .limit(1);
  if (!row) throw new Error(`No vehicle_types row for slug "${slug}" — expected from seedBase.`);
  return row.id;
}

/* ----- Task T8: the transfer branch's window arithmetic ----- */

/** The seeded `transfer_operations` values the transfer cases below assume. */
const BUFFER = 60;
const DEFAULT_DRIVER_CAP = 2;
/** The one-way duration every transfer fixture here shares. */
const DURATION = 120;

/** Minutes since midnight, so the cases read as times. */
const at = (hours: number, minutes = 0) => hours * 60 + minutes;
/** Minutes back to the `"HH:mm"` civil label the column stores. */
const hhmm = (minutes: number) =>
  `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;

async function count(statement: Parameters<ReturnType<typeof getDb>['execute']>[0]) {
  const [rows] = (await getDb().execute(statement)) as unknown as [Array<{ n: number }>, unknown];
  return Number(rows[0]?.n ?? -1);
}

async function makeTour() {
  const db = getDb();
  const slug = `__dispassign__${unique()}`;
  const [destination] = await db.insert(destinations).values({ name: slug, slug });
  created.destIds.push(destination.insertId);
  const [tour] = await db
    .insert(tours)
    .values({ slug, title: slug, destinationId: destination.insertId, isActive: true });
  created.tourIds.push(tour.insertId);
  return tour.insertId;
}

/**
 * `luggageCapacity: undefined` leaves the column NULL — "not recorded for
 * this vehicle", which is what makes pre-task 0C's soft check skip its
 * luggage half. Every van this file made before 0C stays in that state, so
 * the existing cases are untouched by the new check's luggage arm.
 */
async function makeVan(
  opts: { capacity?: number; vehicleTypeId?: number; luggageCapacity?: number } = {},
) {
  const suffix = unique();
  const [van] = await getDb()
    .insert(vans)
    .values({
      plate: `DSP${suffix}`.slice(0, 20),
      model: 'Assignment Fixture Van',
      capacity: opts.capacity ?? 12,
      luggageCapacity: opts.luggageCapacity ?? null,
      status: 'available',
      isActive: true,
      vehicleTypeId: opts.vehicleTypeId ?? VAN_ID,
    });
  created.vanIds.push(van.insertId);
  return van.insertId;
}

/** `maxTransferJobsPerDay: undefined` leaves the column NULL — "use the default". */
async function makeDriver(opts: { maxTransferJobsPerDay?: number } = {}) {
  const suffix = unique();
  const [driver] = await getDb()
    .insert(drivers)
    .values({
      name: `Assignment Fixture Driver ${suffix}`,
      code: `DSP${suffix}`.slice(0, 20),
      phone: '09170000000',
      // Not a real hash: nothing here logs in.
      pinHash: '__dispassign_not_a_pin_hash__',
      isActive: true,
      maxTransferJobsPerDay: opts.maxTransferJobsPerDay ?? null,
    });
  created.driverIds.push(driver.insertId);
  return driver.insertId;
}

/** An admin-managed pickup/drop-off place — a route's `from`/`to` endpoint. */
async function makePlace() {
  const db = getDb();
  const slug = `__dispassign__${unique()}`;
  const [place] = await db
    .insert(transferPlaces)
    .values({ name: slug, nameKey: slug.toLowerCase() });
  created.placeIds.push(place.insertId);
  return place.insertId;
}

/** A transfer route, plus the two places its `from`/`to` foreign keys need. */
async function makeRoute() {
  const db = getDb();
  const fromPlaceId = await makePlace();
  const toPlaceId = await makePlace();
  const slug = `__dispassign__${unique()}`;
  const [route] = await db
    .insert(transferRoutes)
    .values({ fromPlaceId, toPlaceId, slug, estimatedDurationMinutes: DURATION });
  created.routeIds.push(route.insertId);
  return route.insertId;
}

async function makeStaff(role: 'owner' | 'dispatcher' | 'finance') {
  const suffix = unique();
  const [row] = await getDb()
    .insert(users)
    .values({
      name: `Dispatch Assign ${role} ${suffix}`,
      email: `dispassign_${role}_${suffix}@example.test`,
      passwordHash: '__dispassign_not_a_hash__',
      role,
      isActive: true,
    });
  return row.insertId;
}

/** The minimum snapshot `bookings.price_snapshot` will accept. No test reads it. */
const SNAPSHOT: PriceSnapshot = {
  tier: { tierId: 1, minPax: 1, maxPax: 12, pricePerPersonCentavos: 100000 },
  addons: [],
  coupon: null,
  depositPercent: 30,
  freeCancelHours: 48,
  subtotalCentavos: 100000,
  discountCentavos: 0,
  totalCentavos: 100000,
};

async function makeBooking(opts: {
  tourId: number;
  pax?: number;
  status?: BookingStatus;
  vanId?: number | null;
  driverId?: number | null;
}) {
  const [booking] = await getDb()
    .insert(bookings)
    .values({
      ref: generateBookingRef(),
      tourId: opts.tourId,
      tourDate: new Date(`${TOUR_DATE}T00:00:00Z`),
      pax: opts.pax ?? 2,
      leadName: 'Dispatch Assign Fixture',
      leadEmail: 'dispassign@example.test',
      leadPhone: '09170000000',
      status: opts.status ?? 'confirmed',
      payMode: 'full',
      priceSnapshot: SNAPSHOT,
      subtotalCentavos: 100000,
      totalCentavos: 100000,
      vanId: opts.vanId ?? null,
      driverId: opts.driverId ?? null,
    });
  created.bookingIds.push(booking.insertId);
  return booking.insertId;
}

/**
 * A committed TRANSFER booking and its `booking_transfer_details` row — what
 * `createTransferBooking()` (Task T10) will write, built by hand here because
 * it does not exist yet, exactly as `transfer-capacity.test.ts` does.
 *
 * Both frozen values are stored (`buffer_minutes_used`,
 * `route_duration_minutes_used`), because `assignVanAndDriver` recomputes this
 * booking's window from THOSE and never from the catalog route.
 *
 * Window, with the seeded defaults: `[pickup, pickup + 120 + 60)`.
 */
async function makeTransferBooking(opts: {
  routeId: number;
  pickupMinutes: number;
  vehicleTypeId?: number;
  status?: BookingStatus;
  pax?: number;
  vanId?: number | null;
  driverId?: number | null;
  /** Bags. The column is NOT NULL DEFAULT 0, so omitting it means zero bags. */
  luggageCount?: number;
}) {
  const id = await getDb().transaction(async (tx) => {
    const [booking] = await tx.insert(bookings).values({
      ref: generateBookingRef(),
      tourId: null,
      productType: 'transfer_one_way',
      routeId: opts.routeId,
      vehicleTypeId: opts.vehicleTypeId ?? VAN_ID,
      tourDate: new Date(`${TOUR_DATE}T00:00:00Z`),
      pax: opts.pax ?? 2,
      leadName: 'Dispatch Assign Transfer Fixture',
      leadEmail: 'dispassign@example.test',
      leadPhone: '09170000000',
      status: opts.status ?? 'confirmed',
      payMode: 'full',
      priceSnapshot: SNAPSHOT,
      subtotalCentavos: 100000,
      totalCentavos: 100000,
      vanId: opts.vanId ?? null,
      driverId: opts.driverId ?? null,
    });
    await tx.insert(bookingTransferDetails).values({
      bookingId: booking.insertId,
      pickupTime: hhmm(opts.pickupMinutes),
      dropoffAddress: 'Fixture drop-off',
      ...(opts.luggageCount === undefined ? {} : { luggageCount: opts.luggageCount }),
      bufferMinutesUsed: BUFFER,
      routeDurationMinutesUsed: DURATION,
    });
    return booking.insertId;
  });
  created.bookingIds.push(id);
  return id;
}

async function auditRowsFor(entity: string, entityId: number) {
  return getDb()
    .select({
      action: auditLog.action,
      actorId: auditLog.actorId,
      data: auditLog.data,
    })
    .from(auditLog)
    .where(and(eq(auditLog.entity, entity), eq(auditLog.entityId, entityId)))
    .orderBy(asc(auditLog.id));
}

/**
 * Reads EVERY money-bearing column on the booking plus its payment rows —
 * see the vacuity-guard note on the test that uses it.
 */
async function moneySnapshot(id: number) {
  const [b] = await getDb()
    .select({
      subtotalCentavos: bookings.subtotalCentavos,
      discountCentavos: bookings.discountCentavos,
      totalCentavos: bookings.totalCentavos,
      amountPaidCentavos: bookings.amountPaidCentavos,
      payMode: bookings.payMode,
    })
    .from(bookings)
    .where(eq(bookings.id, id));
  const rows = await getDb()
    .select({ id: payments.id, status: payments.status, amount: payments.amountCentavos })
    .from(payments)
    .where(eq(payments.bookingId, id))
    .orderBy(payments.id);
  return { ...b, payments: rows };
}

/**
 * Week 7 Task 14: `assign` now sends §11's "driver assigned" email after its
 * transaction commits, so this file needs a transport — a MOCK one, which
 * never touches a network (`notify.test.ts` set that rule). Without it every
 * successful assignment below would also log "SMTP is not configured".
 */
interface SentMail {
  to: string;
  subject: string;
  html: string;
  text: string;
}
const sent: SentMail[] = [];

let dispatcherId = 0;
let financeId = 0;

beforeAll(async () => {
  dispatcherId = await makeStaff('dispatcher');
  financeId = await makeStaff('finance');
}, 60_000);

afterAll(async () => {
  const pool = getPool();
  for (const id of [dispatcherId, financeId]) {
    await pool.query('DELETE FROM sessions WHERE subject_type = ? AND subject_id = ?', [
      'user',
      id,
    ]);
    await pool.query('DELETE FROM users WHERE id = ?', [id]);
  }
});

describeWithDb('admin.dispatch.assign', () => {
  beforeEach(async () => {
    // Same sanity check `dispatch-availability.test.ts` opens with: a van
    // or driver left behind by another suite would change what this file's
    // availability re-checks see.
    expect(await count(sql`SELECT COUNT(*) n FROM vans`), 'leftover vans in rg_travel_test').toBe(
      0,
    );
    expect(
      await count(sql`SELECT COUNT(*) n FROM drivers`),
      'leftover drivers in rg_travel_test',
    ).toBe(0);

    VAN_ID = await vehicleTypeIdBySlug('van');
    SUV_ID = await vehicleTypeIdBySlug('suv');

    sent.length = 0;
    setTransportForTests({
      sendMail: async (message) => {
        sent.push(message as unknown as SentMail);
        return { messageId: 'mock' };
      },
    });
  });

  afterEach(async () => {
    resetTransportForTests();
    const pool = getPool();
    for (const id of created.bookingIds) {
      // The details row FIRST: it references the booking, so the delete below
      // would otherwise die on the foreign key.
      await pool.query('DELETE FROM booking_transfer_details WHERE booking_id = ?', [id]);
      await pool.query('DELETE FROM bookings WHERE id = ?', [id]);
    }
    for (const id of created.leaveIds) {
      await pool.query('DELETE FROM driver_leaves WHERE id = ?', [id]);
    }
    /*
     * Every `assign()` call that reaches `takeSlotLocks` leaves a
     * `tour_date_slots` row behind, keyed by this test's own fresh
     * `tour_id` — and `tours` cannot be deleted while one still
     * references it (`tour_date_slots_tour_id_tours_id_fk`). Same
     * discipline `capacity.test.ts` / `create-hold.test.ts` /
     * `checkout-router.test.ts` already use for exactly this reason.
     * `fleet_date_slots` is keyed only by date, shared across every
     * tour this file's tests touch, so it is swept once by date rather
     * than per tour id.
     */
    for (const id of created.tourIds) {
      await pool.query('DELETE FROM tour_date_slots WHERE tour_id = ?', [id]);
    }
    await pool.query('DELETE FROM fleet_date_slots WHERE date = ?', [TOUR_DATE]);
    for (const id of created.tourIds) await pool.query('DELETE FROM tours WHERE id = ?', [id]);
    // Before the places/destinations they reference.
    for (const id of created.routeIds) {
      await pool.query('DELETE FROM transfer_routes WHERE id = ?', [id]);
    }
    for (const id of created.placeIds) {
      await pool.query('DELETE FROM transfer_places WHERE id = ?', [id]);
    }
    for (const id of created.destIds) {
      await pool.query('DELETE FROM destinations WHERE id = ?', [id]);
    }
    for (const id of created.driverIds) await pool.query('DELETE FROM drivers WHERE id = ?', [id]);
    for (const id of created.vanIds) await pool.query('DELETE FROM vans WHERE id = ?', [id]);
    created.bookingIds = [];
    created.leaveIds = [];
    created.tourIds = [];
    created.routeIds = [];
    created.placeIds = [];
    created.destIds = [];
    created.driverIds = [];
    created.vanIds = [];
  });

  it('assigns a van and a driver and moves the booking to assigned', async () => {
    const tourId = await makeTour();
    const vanId = await makeVan({ capacity: 4 });
    const driverId = await makeDriver();
    const bookingId = await makeBooking({ tourId, pax: 2, status: 'confirmed' });

    const api = appRouter.createCaller(staffContext(dispatcherId, 'dispatcher') as never);
    await expect(api.admin.dispatch.assign({ bookingId, vanId, driverId })).resolves.toEqual({
      ok: true,
    });

    const [row] = await getDb().select().from(bookings).where(eq(bookings.id, bookingId));
    expect({ vanId: row!.vanId, driverId: row!.driverId, status: row!.status }).toEqual({
      vanId,
      driverId,
      status: 'assigned',
    });
  });

  it('writes an audit row naming the actor and both previous values', async () => {
    const tourId = await makeTour();
    const vanId = await makeVan({ capacity: 4 });
    const driverId = await makeDriver();
    const bookingId = await makeBooking({ tourId, pax: 2, status: 'confirmed' });

    const api = appRouter.createCaller(staffContext(dispatcherId, 'dispatcher') as never);
    await api.admin.dispatch.assign({ bookingId, vanId, driverId });

    const rows = await auditRowsFor('bookings', bookingId);
    const row = rows.at(-1)!;
    expect(row.action).toBe('booking_assigned');
    expect(row.actorId).toBe(dispatcherId);
    expect(row.data).toMatchObject({
      vanId,
      driverId,
      previousVanId: null,
      previousDriverId: null,
    });
  });

  it('changes no money and no payment row', async () => {
    const tourId = await makeTour();
    const vanId = await makeVan({ capacity: 4 });
    const driverId = await makeDriver();
    const bookingId = await makeBooking({ tourId, pax: 2, status: 'confirmed' });

    const before = await moneySnapshot(bookingId);
    // VACUITY GUARD: two empty snapshots are equal, so a `moneySnapshot`
    // that silently returns nothing would make this test pass while
    // watching nothing at all. Assert it actually captured the money
    // columns first.
    expect(before).toMatchObject({
      totalCentavos: expect.any(Number),
      amountPaidCentavos: expect.any(Number),
    });

    const api = appRouter.createCaller(staffContext(dispatcherId, 'dispatcher') as never);
    await api.admin.dispatch.assign({ bookingId, vanId, driverId });
    expect(await moneySnapshot(bookingId)).toEqual(before);
  });

  it('REFUSES finance — §9 gives assignment to owner and dispatcher only', async () => {
    const tourId = await makeTour();
    const vanId = await makeVan({ capacity: 4 });
    const driverId = await makeDriver();
    const bookingId = await makeBooking({ tourId, pax: 2, status: 'confirmed' });

    const api = appRouter.createCaller(staffContext(financeId, 'finance') as never);
    await expect(api.admin.dispatch.assign({ bookingId, vanId, driverId })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });

  it('refuses a pending_payment hold', async () => {
    const tourId = await makeTour();
    const vanId = await makeVan({ capacity: 4 });
    const driverId = await makeDriver();
    const bookingId = await makeBooking({ tourId, pax: 2, status: 'pending_payment' });

    const api = appRouter.createCaller(staffContext(dispatcherId, 'dispatcher') as never);
    await expect(api.admin.dispatch.assign({ bookingId, vanId, driverId })).rejects.toThrow(
      /booking_not_assignable/,
    );
  });

  it('refuses a completed, cancelled or expired booking', async () => {
    const tourId = await makeTour();
    const vanId = await makeVan({ capacity: 4 });
    const driverId = await makeDriver();
    const bookingId = await makeBooking({ tourId, pax: 2, status: 'confirmed' });

    const api = appRouter.createCaller(staffContext(dispatcherId, 'dispatcher') as never);
    for (const status of ['completed', 'cancelled', 'expired'] as const) {
      await getDb().update(bookings).set({ status }).where(eq(bookings.id, bookingId));
      await expect(api.admin.dispatch.assign({ bookingId, vanId, driverId })).rejects.toThrow(
        /booking_not_assignable/,
      );
    }
  });

  /* ---- Q2: pre-assigning an unverified receipt (owner-decided 2026-10-14) ---- */

  it('ALLOWS pre-assigning a pending_verification booking', async () => {
    const tourId = await makeTour();
    const vanId = await makeVan({ capacity: 4 });
    const driverId = await makeDriver();
    const bookingId = await makeBooking({ tourId, pax: 2, status: 'pending_verification' });

    const api = appRouter.createCaller(staffContext(dispatcherId, 'dispatcher') as never);
    await expect(api.admin.dispatch.assign({ bookingId, vanId, driverId })).resolves.toEqual({
      ok: true,
    });
  });

  it('does NOT move a pre-assigned booking to assigned - it is still unpaid', async () => {
    // `assigned` reads as paid everywhere else in the system (§5's status
    // table). Writing it over an unchecked receipt would be a money lie.
    const tourId = await makeTour();
    const vanId = await makeVan({ capacity: 4 });
    const driverId = await makeDriver();
    const bookingId = await makeBooking({ tourId, pax: 2, status: 'pending_verification' });

    const api = appRouter.createCaller(staffContext(dispatcherId, 'dispatcher') as never);
    await api.admin.dispatch.assign({ bookingId, vanId, driverId });

    const [row] = await getDb().select().from(bookings).where(eq(bookings.id, bookingId));
    expect(row!.status).toBe('pending_verification');
    expect({ vanId: row!.vanId, driverId: row!.driverId }).toEqual({ vanId, driverId });
  });

  /* ---- Q3: re-assigning a trip already under way (owner-decided 2026-10-14) ---- */

  it('ALLOWS re-assigning an in_progress trip when a reason is given', async () => {
    const tourId = await makeTour();
    const vanId = await makeVan({ capacity: 4 });
    const driverId = await makeDriver();
    const otherVanId = await makeVan({ capacity: 4 });
    const otherDriverId = await makeDriver();
    const bookingId = await makeBooking({ tourId, pax: 2, status: 'confirmed' });

    const api = appRouter.createCaller(staffContext(dispatcherId, 'dispatcher') as never);
    await api.admin.dispatch.assign({ bookingId, vanId, driverId });
    await getDb().update(bookings).set({ status: 'in_progress' }).where(eq(bookings.id, bookingId));

    await expect(
      api.admin.dispatch.assign({
        bookingId,
        vanId: otherVanId,
        driverId: otherDriverId,
        reason: 'Van ABC 123 broke down at Carcar; swapped to DEF 456.',
      }),
    ).resolves.toEqual({ ok: true });

    const [row] = await getDb().select().from(bookings).where(eq(bookings.id, bookingId));
    expect(row!.status).toBe('in_progress'); // the trip is still under way
  });

  it('REFUSES an in_progress re-assignment with no reason', async () => {
    const tourId = await makeTour();
    const otherVanId = await makeVan({ capacity: 4 });
    const otherDriverId = await makeDriver();
    const bookingId = await makeBooking({ tourId, pax: 2, status: 'in_progress' });

    const api = appRouter.createCaller(staffContext(dispatcherId, 'dispatcher') as never);
    await expect(
      api.admin.dispatch.assign({ bookingId, vanId: otherVanId, driverId: otherDriverId }),
    ).rejects.toThrow(/reason_required/);
  });

  it('REFUSES an in_progress re-assignment whose reason is only whitespace', async () => {
    const tourId = await makeTour();
    const otherVanId = await makeVan({ capacity: 4 });
    const otherDriverId = await makeDriver();
    const bookingId = await makeBooking({ tourId, pax: 2, status: 'in_progress' });

    const api = appRouter.createCaller(staffContext(dispatcherId, 'dispatcher') as never);
    await expect(
      api.admin.dispatch.assign({
        bookingId,
        vanId: otherVanId,
        driverId: otherDriverId,
        reason: '   ',
      }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });

  /**
   * The SERVICE's guard, separately from Zod's (Task 10 review, F4).
   *
   * The whitespace case above is refused by `assignInputSchema`'s
   * `.trim().min(3)` and never reaches the service, so a bare
   * `.rejects.toThrow()` there proved only that Zod exists. The service's
   * own `reason_required` — which is the rule that cannot live in Zod,
   * because Zod cannot see the booking's status — is reached by omitting
   * the field entirely, and that is what this asserts, by its exact code.
   */
  it('refuses an in_progress re-assignment at the SERVICE, not just at Zod', async () => {
    const tourId = await makeTour();
    const vanId = await makeVan({ capacity: 4 });
    const otherVanId = await makeVan({ capacity: 4 });
    const driverId = await makeDriver();
    const otherDriverId = await makeDriver();
    const bookingId = await makeBooking({ tourId, pax: 2, status: 'confirmed' });

    const api = appRouter.createCaller(staffContext(dispatcherId, 'dispatcher') as never);
    await api.admin.dispatch.assign({ bookingId, vanId, driverId });
    await getDb().update(bookings).set({ status: 'in_progress' }).where(eq(bookings.id, bookingId));

    // A VALID Zod payload with no `reason` key at all — so the refusal can
    // only have come from the service's status-aware check.
    await expect(
      api.admin.dispatch.assign({ bookingId, vanId: otherVanId, driverId: otherDriverId }),
    ).rejects.toMatchObject({ message: expect.stringContaining('reason_required') });
  });

  it('does NOT demand a reason for an ordinary first assignment', async () => {
    const tourId = await makeTour();
    const vanId = await makeVan({ capacity: 4 });
    const driverId = await makeDriver();
    const bookingId = await makeBooking({ tourId, pax: 2, status: 'confirmed' });

    const api = appRouter.createCaller(staffContext(dispatcherId, 'dispatcher') as never);
    await expect(api.admin.dispatch.assign({ bookingId, vanId, driverId })).resolves.toEqual({
      ok: true,
    });
  });

  it('audits an in_progress re-assignment with old -> new values and the reason', async () => {
    const tourId = await makeTour();
    const vanId = await makeVan({ capacity: 4 });
    const driverId = await makeDriver();
    const otherVanId = await makeVan({ capacity: 4 });
    const otherDriverId = await makeDriver();
    const bookingId = await makeBooking({ tourId, pax: 2, status: 'confirmed' });

    const api = appRouter.createCaller(staffContext(dispatcherId, 'dispatcher') as never);
    await api.admin.dispatch.assign({ bookingId, vanId, driverId });
    await getDb().update(bookings).set({ status: 'in_progress' }).where(eq(bookings.id, bookingId));
    await api.admin.dispatch.assign({
      bookingId,
      vanId: otherVanId,
      driverId: otherDriverId,
      reason: 'Breakdown at Carcar',
    });

    const rows = await auditRowsFor('bookings', bookingId);
    const last = rows.at(-1)!;
    expect(last.action).toBe('booking_reassigned_in_progress');
    expect(last.actorId).toBe(dispatcherId);
    expect(last.data).toMatchObject({
      previousVanId: vanId,
      previousDriverId: driverId,
      vanId: otherVanId,
      driverId: otherDriverId,
      reason: 'Breakdown at Carcar',
    });
  });

  it('REFUSES finance an in_progress re-assignment', async () => {
    const tourId = await makeTour();
    const vanId = await makeVan({ capacity: 4 });
    const driverId = await makeDriver();
    const bookingId = await makeBooking({ tourId, pax: 2, status: 'in_progress' });

    const api = appRouter.createCaller(staffContext(financeId, 'finance') as never);
    await expect(
      api.admin.dispatch.assign({ bookingId, vanId, driverId, reason: 'Breakdown' }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('refuses a van too small for the group', async () => {
    const tourId = await makeTour();
    const tinyVanId = await makeVan({ capacity: 2 });
    const driverId = await makeDriver();
    const bookingId = await makeBooking({ tourId, pax: 6, status: 'confirmed' });

    const api = appRouter.createCaller(staffContext(dispatcherId, 'dispatcher') as never);
    /*
     * EXACTLY `van_too_small` (Task 10 review, F1). The old alternation
     * `/van_too_small|van_unavailable/` stayed green if the whole
     * size-diagnostic branch were deleted, because a van too small is also
     * simply absent from `vansFreeOn`'s answer and would fall through to
     * `van_unavailable`. Pinning the specific reason is the point: Task 12
     * maps these strings to copy, and "that van is too small for 6 guests"
     * is a different sentence to "that van is not available".
     */
    await expect(
      api.admin.dispatch.assign({ bookingId, vanId: tinyVanId, driverId }),
    ).rejects.toMatchObject({ message: expect.stringContaining('van_too_small') });
  });

  it('refuses a driver who is on leave that day', async () => {
    const tourId = await makeTour();
    const vanId = await makeVan({ capacity: 4 });
    const driverId = await makeDriver();
    const bookingId = await makeBooking({ tourId, pax: 2, status: 'confirmed' });

    const [leave] = await getDb()
      .insert(driverLeaves)
      .values({
        driverId,
        startDate: new Date(`${TOUR_DATE}T00:00:00Z`),
        endDate: new Date(`${TOUR_DATE}T00:00:00Z`),
      });
    created.leaveIds.push(leave.insertId);

    const api = appRouter.createCaller(staffContext(dispatcherId, 'dispatcher') as never);
    // Both halves: the CODE a client branches on, and the REASON Task 12
    // maps to copy. `asTrpcError` sets `message` to the reason string, so a
    // message match is meaningful here — unlike the role refusals, where
    // `requireRole`'s message never names its code — but the code is the
    // contract and is asserted first.
    await expect(api.admin.dispatch.assign({ bookingId, vanId, driverId })).rejects.toMatchObject({
      code: 'CONFLICT',
      message: expect.stringContaining('driver_unavailable'),
    });

    // And nothing was written: a refused assignment leaves the booking
    // exactly as it was, or the refusal is cosmetic.
    const [row] = await getDb()
      .select({ vanId: bookings.vanId, driverId: bookings.driverId, status: bookings.status })
      .from(bookings)
      .where(eq(bookings.id, bookingId));
    expect(row).toEqual({ vanId: null, driverId: null, status: 'confirmed' });
  });

  /**
   * THE CONCURRENCY TEST. Two dispatchers, one van, one date. Exactly one
   * must win. Written as two OVERLAPPING transactions
   * (`Promise.allSettled` over two concurrent `assign` calls) — not two
   * sequential calls, which would pass with no lock at all. Each call opens
   * its own transaction (the router's job), so this is a real race between
   * two pool connections, not a single connection calling itself twice.
   */
  it('gives one van to exactly one of two simultaneous assignments', async () => {
    const tourId = await makeTour();
    const vanId = await makeVan({ capacity: 4 });
    const driverA = await makeDriver();
    const driverB = await makeDriver();
    const firstBookingId = await makeBooking({ tourId, pax: 2, status: 'confirmed' });
    const secondBookingId = await makeBooking({ tourId, pax: 2, status: 'confirmed' });

    const api = appRouter.createCaller(staffContext(dispatcherId, 'dispatcher') as never);
    const results = await Promise.allSettled([
      api.admin.dispatch.assign({ bookingId: firstBookingId, vanId, driverId: driverA }),
      api.admin.dispatch.assign({ bookingId: secondBookingId, vanId, driverId: driverB }),
    ]);
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    expect(fulfilled).toHaveLength(1);

    const rows = await getDb()
      .select({ id: bookings.id, vanId: bookings.vanId })
      .from(bookings)
      .where(inArray(bookings.id, [firstBookingId, secondBookingId]));
    expect(rows.filter((r) => r.vanId === vanId)).toHaveLength(1);
  });

  /**
   * THE FLEET LOCK, which the two tests above do not actually prove
   * (Task 10 review, F2).
   *
   * Both of those put their two bookings on the SAME tour, so
   * `tour_date_slots(tour_id, date)` serialises them and the fleet lock
   * never does any work. This is the case only the fleet lock can stop, and
   * it is the one that stranded guests would come from: **one van, two
   * DIFFERENT tours, the same date.** Two dispatchers, two tour pages, one
   * physical vehicle.
   *
   * `schema.ts` says it in as many words on `fleetDateSlots`: "the fleet is
   * global… two bookings for DIFFERENT tours on the same date lock different
   * `tour_date_slots` rows, never wait for each other, and can both take the
   * last van."
   *
   * Proven by narrowing `takeSlotLocks` to the tour lock alone — see the
   * mutation list in the report. With the fleet lock gone this test reports
   * two winners and one van double-booked, while the two tests above stay
   * green, which is exactly why it had to exist separately.
   */
  /**
   * The 1213 retry (Task 10 review, F5), injected rather than provoked for
   * the same reason `create-hold.test.ts` injects it: InnoDB picks the
   * victim, so provoking a deadlock reliably is exactly what cannot be
   * made to work.
   *
   * It could never double-dispatch a van — InnoDB rolls the victim back —
   * but without the retry the dispatcher saw Drizzle's opaque
   * `Failed query` 500 on a busy morning, with the fleet apparently broken
   * for no stated reason.
   */
  it('retries the whole transaction when InnoDB kills it as a deadlock victim', async () => {
    const tourId = await makeTour();
    const vanId = await makeVan({ capacity: 4 });
    const driverId = await makeDriver();
    const bookingId = await makeBooking({ tourId, pax: 2, status: 'confirmed' });

    const db = getDb();
    const realTransaction = db.transaction.bind(db);
    let attempts = 0;
    const spy = vi.spyOn(db, 'transaction').mockImplementation(((...args: unknown[]) => {
      attempts += 1;
      if (attempts === 1) {
        const inner = Object.assign(new Error('ER_LOCK_DEADLOCK (1213)'), {
          errno: 1213,
          code: 'ER_LOCK_DEADLOCK',
        });
        return Promise.reject(Object.assign(new Error('Failed query'), { cause: inner }));
      }
      return (realTransaction as (...a: unknown[]) => unknown)(...args);
    }) as typeof db.transaction);

    try {
      const api = appRouter.createCaller(staffContext(dispatcherId, 'dispatcher') as never);
      await expect(api.admin.dispatch.assign({ bookingId, vanId, driverId })).resolves.toEqual({
        ok: true,
      });
      expect(attempts, 'the transaction was not retried').toBe(2);

      // One assignment, not two half-written ones.
      const [row] = await getDb()
        .select({ vanId: bookings.vanId, driverId: bookings.driverId, status: bookings.status })
        .from(bookings)
        .where(eq(bookings.id, bookingId));
      expect(row).toEqual({ vanId, driverId, status: 'assigned' });
    } finally {
      spy.mockRestore();
    }
  });

  it('gives up as a CONFLICT, not a 500, after three deadlocks', async () => {
    const tourId = await makeTour();
    const vanId = await makeVan({ capacity: 4 });
    const driverId = await makeDriver();
    const bookingId = await makeBooking({ tourId, pax: 2, status: 'confirmed' });

    const db = getDb();
    let attempts = 0;
    const spy = vi.spyOn(db, 'transaction').mockImplementation((() => {
      attempts += 1;
      const inner = Object.assign(new Error('ER_LOCK_DEADLOCK (1213)'), {
        errno: 1213,
        code: 'ER_LOCK_DEADLOCK',
      });
      return Promise.reject(Object.assign(new Error('Failed query'), { cause: inner }));
    }) as typeof db.transaction);

    try {
      const api = appRouter.createCaller(staffContext(dispatcherId, 'dispatcher') as never);
      await expect(api.admin.dispatch.assign({ bookingId, vanId, driverId })).rejects.toMatchObject(
        { code: 'CONFLICT' },
      );
      // EXACTLY three — the bound is the point, not "more than one".
      expect(attempts).toBe(3);

      // And nothing was written.
      const [row] = await getDb()
        .select({ vanId: bookings.vanId, status: bookings.status })
        .from(bookings)
        .where(eq(bookings.id, bookingId));
      expect(row).toEqual({ vanId: null, status: 'confirmed' });
    } finally {
      spy.mockRestore();
    }
  });

  /**
   * THE FLEET LOCK, FROM THE DRIVER SIDE (owner request, 2026-10-15).
   *
   * The van version of this test sits below. This is the same scenario with
   * the scarce resource swapped: **one driver, two DIFFERENT tours, the same
   * date.** Two dispatchers, two tour pages, one human being who can only be
   * in one van.
   *
   * It is the fleet lock that stops it, not the tour lock — the two bookings
   * are on different tours, so they lock different `tour_date_slots` rows
   * and would never wait for each other. `fleet_date_slots(date)` is the
   * only row they share.
   *
   * The loser must get a **CONFLICT**, not a 500 and not a silent overwrite:
   * `driver_unavailable` maps to CONFLICT in `asTrpcError`, which is a
   * sentence a dispatcher can act on ("someone just took that driver").
   */
  it('gives one driver to one of two tours competing on the same date', async () => {
    const tourA = await makeTour();
    const tourB = await makeTour();
    const driverId = await makeDriver();
    const vanA = await makeVan({ capacity: 4 });
    const vanB = await makeVan({ capacity: 4 });
    const bookingA = await makeBooking({ tourId: tourA, pax: 2, status: 'confirmed' });
    const bookingB = await makeBooking({ tourId: tourB, pax: 2, status: 'confirmed' });

    const api = appRouter.createCaller(staffContext(dispatcherId, 'dispatcher') as never);
    const results = await Promise.allSettled([
      api.admin.dispatch.assign({ bookingId: bookingA, vanId: vanA, driverId }),
      api.admin.dispatch.assign({ bookingId: bookingB, vanId: vanB, driverId }),
    ]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);

    // A CLEAN refusal, which is the half a 500 would fail while still
    // leaving exactly one winner — so asserting the count alone would miss
    // it.
    expect(rejected[0]!.reason).toMatchObject({
      code: 'CONFLICT',
      message: expect.stringContaining('driver_unavailable'),
    });

    // Exactly one booking holds the driver. A double-write shows up here
    // even if both promises had somehow resolved.
    const rows = await getDb()
      .select({ id: bookings.id, driverId: bookings.driverId })
      .from(bookings)
      .where(inArray(bookings.id, [bookingA, bookingB]));
    expect(rows.filter((r) => r.driverId === driverId)).toHaveLength(1);
  });

  it('gives one van to one of two tours competing on the same date', async () => {
    const tourA = await makeTour();
    const tourB = await makeTour();
    const vanId = await makeVan({ capacity: 4 });
    const driverA = await makeDriver();
    const driverB = await makeDriver();
    const bookingA = await makeBooking({ tourId: tourA, pax: 2, status: 'confirmed' });
    const bookingB = await makeBooking({ tourId: tourB, pax: 2, status: 'confirmed' });

    const api = appRouter.createCaller(staffContext(dispatcherId, 'dispatcher') as never);
    const results = await Promise.allSettled([
      api.admin.dispatch.assign({ bookingId: bookingA, vanId, driverId: driverA }),
      api.admin.dispatch.assign({ bookingId: bookingB, vanId, driverId: driverB }),
    ]);

    // Exactly one winner, and exactly one booking holding the van. The
    // second assertion is the one that matters: a double-write would show
    // up here as two rows even if both promises somehow resolved.
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);

    const rows = await getDb()
      .select({ id: bookings.id, vanId: bookings.vanId })
      .from(bookings)
      .where(inArray(bookings.id, [bookingA, bookingB]));
    expect(rows.filter((r) => r.vanId === vanId)).toHaveLength(1);
  });

  it('gives one driver to exactly one of two simultaneous assignments', async () => {
    const tourId = await makeTour();
    const driverId = await makeDriver();
    const vanA = await makeVan({ capacity: 4 });
    const vanB = await makeVan({ capacity: 4 });
    const firstBookingId = await makeBooking({ tourId, pax: 2, status: 'confirmed' });
    const secondBookingId = await makeBooking({ tourId, pax: 2, status: 'confirmed' });

    const api = appRouter.createCaller(staffContext(dispatcherId, 'dispatcher') as never);
    const results = await Promise.allSettled([
      api.admin.dispatch.assign({ bookingId: firstBookingId, vanId: vanA, driverId }),
      api.admin.dispatch.assign({ bookingId: secondBookingId, vanId: vanB, driverId }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  });

  /* ---- Week 7 Task 14 (7E): §11's "driver assigned" guest email ---- */

  /**
   * The email names the DRIVER and the PLATE, which is why `NotifyPayload`
   * grew two fields for it — and it names the tour title and the tour date,
   * **neither of which is in the mutation's input**. That is the proof the
   * notice re-queries the committed booking rather than echoing the request
   * back, the same discipline `sendReceiptNotices` follows.
   */
  it('emails the guest with the driver, the plate and the committed booking facts', async () => {
    const tourId = await makeTour();
    const vanId = await makeVan({ capacity: 4 });
    const driverId = await makeDriver();
    const bookingId = await makeBooking({ tourId, pax: 2, status: 'confirmed' });

    const api = appRouter.createCaller(staffContext(dispatcherId, 'dispatcher') as never);
    await api.admin.dispatch.assign({ bookingId, vanId, driverId });

    const [booking] = await getDb()
      .select({ ref: bookings.ref, leadEmail: bookings.leadEmail })
      .from(bookings)
      .where(eq(bookings.id, bookingId));
    const [van] = await getDb().select({ plate: vans.plate }).from(vans).where(eq(vans.id, vanId));
    const [driver] = await getDb()
      .select({ name: drivers.name })
      .from(drivers)
      .where(eq(drivers.id, driverId));

    expect(sent).toHaveLength(1);
    expect(sent[0]!.to).toBe(booking!.leadEmail);
    expect(sent[0]!.subject).toContain(booking!.ref);
    expect(sent[0]!.html).toContain(driver!.name);
    expect(sent[0]!.html).toContain(van!.plate);
    // Read back from the row, not from the input: the input carried three ids
    // and nothing else.
    expect(sent[0]!.html).toContain(TOUR_DATE);
  });

  /**
   * A refused assignment emails nobody.
   *
   * The booking is one that is ALREADY assigned, deliberately. A refusal on a
   * never-assigned booking proves less than it looks: `sendAssignmentNotice`
   * inner-joins `vans` and `drivers`, so with both ids still null it would
   * find no row and send nothing wherever it were called from. Refusing a
   * RE-assignment is the case where the notice could genuinely fire for work
   * that did not happen — and moving the call above the verdict check turns
   * this red, while the never-assigned version stays green (measured).
   */
  it('sends nothing when the assignment is refused', async () => {
    const tourId = await makeTour();
    const vanId = await makeVan({ capacity: 4 });
    const driverId = await makeDriver();
    const otherVanId = await makeVan({ capacity: 4 });
    const otherDriverId = await makeDriver();
    const bookingId = await makeBooking({ tourId, pax: 2, status: 'confirmed' });

    const api = appRouter.createCaller(staffContext(dispatcherId, 'dispatcher') as never);
    await api.admin.dispatch.assign({ bookingId, vanId, driverId });
    expect(sent).toHaveLength(1);
    sent.length = 0;

    // An in_progress re-assignment with no reason: refused by the service,
    // on a booking that already holds a van and a driver.
    await getDb().update(bookings).set({ status: 'in_progress' }).where(eq(bookings.id, bookingId));
    await expect(
      api.admin.dispatch.assign({ bookingId, vanId: otherVanId, driverId: otherDriverId }),
    ).rejects.toThrow(/reason_required/);

    expect(sent).toHaveLength(0);
  });

  it('sends nothing when the van is too small', async () => {
    const tourId = await makeTour();
    const tinyVanId = await makeVan({ capacity: 2 });
    const driverId = await makeDriver();
    const bookingId = await makeBooking({ tourId, pax: 6, status: 'confirmed' });

    const api = appRouter.createCaller(staffContext(dispatcherId, 'dispatcher') as never);
    await expect(
      api.admin.dispatch.assign({ bookingId, vanId: tinyVanId, driverId }),
    ).rejects.toThrow(/van_too_small/);

    expect(sent).toHaveLength(0);
  });

  /**
   * **THE TEST THIS WHOLE ARRANGEMENT EXISTS FOR.** A mail server being down
   * must never fail an assignment: the transaction has already committed by
   * the time the notice is attempted, so the van really is dispatched and the
   * dispatcher must be told so.
   *
   * Driven from the transport rather than by trusting `notify()`'s swallow,
   * because the failure that matters is "the whole email step blew up", and
   * this asserts both halves — the mutation still resolves `ok`, and the
   * booking row really is assigned.
   */
  it('still assigns the van and driver when the mail transport is down', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const tourId = await makeTour();
    const vanId = await makeVan({ capacity: 4 });
    const driverId = await makeDriver();
    const bookingId = await makeBooking({ tourId, pax: 2, status: 'confirmed' });

    setTransportForTests({
      sendMail: async () => {
        throw new Error('smtp unreachable');
      },
    });

    const api = appRouter.createCaller(staffContext(dispatcherId, 'dispatcher') as never);
    await expect(api.admin.dispatch.assign({ bookingId, vanId, driverId })).resolves.toEqual({
      ok: true,
    });

    const [row] = await getDb()
      .select({ vanId: bookings.vanId, driverId: bookings.driverId, status: bookings.status })
      .from(bookings)
      .where(eq(bookings.id, bookingId));
    expect(row).toEqual({ vanId, driverId, status: 'assigned' });
  });

  /**
   * And a re-assignment emails the NEW driver and van. The notice is not
   * "once per booking" — the guest's information changed, so they are told
   * again.
   */
  it('emails the new driver and plate on a re-assignment', async () => {
    const tourId = await makeTour();
    const vanId = await makeVan({ capacity: 4 });
    const driverId = await makeDriver();
    const otherVanId = await makeVan({ capacity: 4 });
    const otherDriverId = await makeDriver();
    const bookingId = await makeBooking({ tourId, pax: 2, status: 'confirmed' });

    const api = appRouter.createCaller(staffContext(dispatcherId, 'dispatcher') as never);
    await api.admin.dispatch.assign({ bookingId, vanId, driverId });
    await getDb().update(bookings).set({ status: 'in_progress' }).where(eq(bookings.id, bookingId));
    await api.admin.dispatch.assign({
      bookingId,
      vanId: otherVanId,
      driverId: otherDriverId,
      reason: 'Breakdown at Carcar',
    });

    const [otherVan] = await getDb()
      .select({ plate: vans.plate })
      .from(vans)
      .where(eq(vans.id, otherVanId));
    expect(sent).toHaveLength(2);
    expect(sent[1]!.html).toContain(otherVan!.plate);
  });

  it('lets a booking keep the van it already has when re-assigning the driver', async () => {
    const tourId = await makeTour();
    const vanId = await makeVan({ capacity: 4 });
    const driverId = await makeDriver();
    const otherDriverId = await makeDriver();
    const bookingId = await makeBooking({ tourId, pax: 2, status: 'confirmed' });

    const api = appRouter.createCaller(staffContext(dispatcherId, 'dispatcher') as never);
    await api.admin.dispatch.assign({ bookingId, vanId, driverId });
    await expect(
      api.admin.dispatch.assign({ bookingId, vanId, driverId: otherDriverId }),
    ).resolves.toEqual({
      ok: true,
    });
  });

  /* ======================================================================= *
   * Task T8 — assigning a TRANSFER. The branch that used to be a loud throw
   * ("transfer assignment is not built yet"): the fleet lock alone, the
   * booking's own FROZEN window, and the one new driver diagnostic.
   * ======================================================================= */

  it('assigns a van of the requested type and a non-overlapping driver to a transfer', async () => {
    const routeId = await makeRoute();
    // An SUV exists too, and must NOT be the one that satisfies this: the
    // booking asks for a van.
    await makeVan({ capacity: 12, vehicleTypeId: SUV_ID });
    const vanId = await makeVan({ capacity: 12, vehicleTypeId: VAN_ID });
    const driverId = await makeDriver();
    const bookingId = await makeTransferBooking({ routeId, pickupMinutes: at(8) });

    const api = appRouter.createCaller(staffContext(dispatcherId, 'dispatcher') as never);
    await expect(api.admin.dispatch.assign({ bookingId, vanId, driverId })).resolves.toEqual({
      ok: true,
    });

    const [row] = await getDb().select().from(bookings).where(eq(bookings.id, bookingId));
    expect({ vanId: row!.vanId, driverId: row!.driverId, status: row!.status }).toEqual({
      vanId,
      driverId,
      status: 'assigned',
    });

    /*
     * The SAME audit action a tour gets. A transfer's assignment is the same
     * two ids written to the same two columns, and `admin.bookings.detail`'s
     * trail reads `entity = 'bookings'` — a second action name would split one
     * event in two for no reader's benefit.
     */
    const audit = (await auditRowsFor('bookings', bookingId)).at(-1)!;
    expect(audit.action).toBe('booking_assigned');
    expect(audit.actorId).toBe(dispatcherId);
    expect(audit.data).toMatchObject({
      vanId,
      driverId,
      previousVanId: null,
      previousDriverId: null,
    });
  });

  it('refuses a van of the WRONG vehicle type for a transfer', async () => {
    const routeId = await makeRoute();
    const suvId = await makeVan({ capacity: 12, vehicleTypeId: SUV_ID });
    const driverId = await makeDriver();
    // `vehicle_type_requested = 'van'`, and the SUV is big enough for the
    // group — so `van_too_small` would be the wrong sentence and is not it.
    const bookingId = await makeTransferBooking({ routeId, pickupMinutes: at(8), pax: 2 });

    const api = appRouter.createCaller(staffContext(dispatcherId, 'dispatcher') as never);
    await expect(
      api.admin.dispatch.assign({ bookingId, vanId: suvId, driverId }),
    ).rejects.toMatchObject({ code: 'CONFLICT', message: 'van_unavailable' });

    const [row] = await getDb()
      .select({ vanId: bookings.vanId, driverId: bookings.driverId, status: bookings.status })
      .from(bookings)
      .where(eq(bookings.id, bookingId));
    expect(row).toEqual({ vanId: null, driverId: null, status: 'confirmed' });
  });

  /**
   * **Dedicated review finding, T8: `van_too_small` is a TOUR-only sentence.**
   * The candidate is SMALL (capacity 1) AND the wrong type — exactly the
   * combination that used to say "too small" when the true, and only, gate
   * is the type. `pax: 1` so the group genuinely would have fit if the type
   * had matched, isolating the one thing actually wrong with this van.
   */
  it('says van_unavailable, never van_too_small, for a small van of the WRONG type', async () => {
    // `capacity: 1 < pax: 2` on purpose — genuinely "too small" as well as the
    // wrong type, so the pre-fix diagnostic (`capacity < pax`) would have said
    // `van_too_small` here. The type mismatch is the true, and only, gate.
    const routeId = await makeRoute();
    const suvId = await makeVan({ capacity: 1, vehicleTypeId: SUV_ID });
    const driverId = await makeDriver();
    const bookingId = await makeTransferBooking({ routeId, pickupMinutes: at(8), pax: 2 });

    const api = appRouter.createCaller(staffContext(dispatcherId, 'dispatcher') as never);
    await expect(
      api.admin.dispatch.assign({ bookingId, vanId: suvId, driverId }),
    ).rejects.toMatchObject({ code: 'CONFLICT', message: 'van_unavailable' });
  });

  it('refuses a van whose transfer window overlaps one it already holds', async () => {
    const routeId = await makeRoute();
    const vanId = await makeVan({ capacity: 12, vehicleTypeId: VAN_ID });
    const driverId = await makeDriver();
    // Held: [08:00, 11:00). Candidate: [10:00, 13:00).
    await makeTransferBooking({ routeId, pickupMinutes: at(8), vanId, status: 'assigned' });
    const bookingId = await makeTransferBooking({ routeId, pickupMinutes: at(10) });

    const api = appRouter.createCaller(staffContext(dispatcherId, 'dispatcher') as never);
    await expect(api.admin.dispatch.assign({ bookingId, vanId, driverId })).rejects.toMatchObject({
      code: 'CONFLICT',
      message: 'van_unavailable',
    });
  });

  it('ACCEPTS a van for a second transfer whose window does not overlap the first', async () => {
    // The owner's "several jobs a day", through the real mutation. Without it
    // the test above would also pass against a whole-day exclusion.
    const routeId = await makeRoute();
    const vanId = await makeVan({ capacity: 12, vehicleTypeId: VAN_ID });
    const driverId = await makeDriver();
    await makeTransferBooking({ routeId, pickupMinutes: at(8), vanId, status: 'assigned' });
    const bookingId = await makeTransferBooking({ routeId, pickupMinutes: at(11) });

    const api = appRouter.createCaller(staffContext(dispatcherId, 'dispatcher') as never);
    await expect(api.admin.dispatch.assign({ bookingId, vanId, driverId })).resolves.toEqual({
      ok: true,
    });
  });

  it('refuses a driver whose transfer window overlaps, UNDER their daily cap', async () => {
    /*
     * One held job against a cap of 2, so the count rule says yes and only the
     * overlap can refuse — which is what makes this the control for the
     * `driver_at_daily_cap` test below. The two reasons are not
     * interchangeable and this pair is the proof.
     */
    const routeId = await makeRoute();
    const vanId = await makeVan({ capacity: 12, vehicleTypeId: VAN_ID });
    const otherVanId = await makeVan({ capacity: 12, vehicleTypeId: VAN_ID });
    const driverId = await makeDriver();
    await makeTransferBooking({
      routeId,
      pickupMinutes: at(8),
      vanId: otherVanId,
      driverId,
      status: 'assigned',
    });
    const bookingId = await makeTransferBooking({ routeId, pickupMinutes: at(10) });

    const api = appRouter.createCaller(staffContext(dispatcherId, 'dispatcher') as never);
    await expect(api.admin.dispatch.assign({ bookingId, vanId, driverId })).rejects.toMatchObject({
      code: 'CONFLICT',
      message: 'driver_unavailable',
    });
  });

  it('refuses a driver at their daily transfer cap with driver_at_daily_cap, not driver_unavailable', async () => {
    /*
     * THE TEST THE NEW DIAGNOSTIC EXISTS FOR. Two held jobs at the seeded
     * default cap of 2, both far from the candidate — [06:00, 09:00) and
     * [12:00, 15:00) against [18:00, 21:00) — so NO window overlaps and the
     * count is the only thing refusing. Neither held job holds a van, so the
     * van this assigns is genuinely free and the refusal can only be about
     * the driver.
     */
    const routeId = await makeRoute();
    const vanId = await makeVan({ capacity: 12, vehicleTypeId: VAN_ID });
    const driverId = await makeDriver();
    expect(DEFAULT_DRIVER_CAP).toBe(2);
    await makeTransferBooking({ routeId, pickupMinutes: at(6), driverId, status: 'assigned' });
    await makeTransferBooking({ routeId, pickupMinutes: at(12), driverId, status: 'assigned' });
    const bookingId = await makeTransferBooking({ routeId, pickupMinutes: at(18) });

    const api = appRouter.createCaller(staffContext(dispatcherId, 'dispatcher') as never);
    await expect(api.admin.dispatch.assign({ bookingId, vanId, driverId })).rejects.toMatchObject({
      code: 'CONFLICT',
      message: 'driver_at_daily_cap',
    });

    // And nothing was written.
    const [row] = await getDb()
      .select({ vanId: bookings.vanId, driverId: bookings.driverId, status: bookings.status })
      .from(bookings)
      .where(eq(bookings.id, bookingId));
    expect(row).toEqual({ vanId: null, driverId: null, status: 'confirmed' });
  });

  /**
   * **Dedicated review finding, T8: the cap diagnostic defers to the TRUE
   * reason.** This driver is at their cap (same two jobs as the test above)
   * AND on leave that day. Leave is the real reason they cannot be assigned
   * — `driver_at_daily_cap` would send a dispatcher re-checking a cap that
   * was never the issue.
   */
  it('says driver_unavailable, never driver_at_daily_cap, for a driver on leave who is also at cap', async () => {
    const routeId = await makeRoute();
    const vanId = await makeVan({ capacity: 12, vehicleTypeId: VAN_ID });
    const driverId = await makeDriver();
    expect(DEFAULT_DRIVER_CAP).toBe(2);
    await makeTransferBooking({ routeId, pickupMinutes: at(6), driverId, status: 'assigned' });
    await makeTransferBooking({ routeId, pickupMinutes: at(12), driverId, status: 'assigned' });
    const bookingId = await makeTransferBooking({ routeId, pickupMinutes: at(18) });

    const [leave] = await getDb()
      .insert(driverLeaves)
      .values({
        driverId,
        startDate: new Date(`${TOUR_DATE}T00:00:00Z`),
        endDate: new Date(`${TOUR_DATE}T00:00:00Z`),
      });
    created.leaveIds.push(leave.insertId);

    const api = appRouter.createCaller(staffContext(dispatcherId, 'dispatcher') as never);
    await expect(api.admin.dispatch.assign({ bookingId, vanId, driverId })).rejects.toMatchObject({
      code: 'CONFLICT',
      message: 'driver_unavailable',
    });
  });

  it('never says driver_at_daily_cap on the TOUR branch', async () => {
    // A tour assignment refused for a driver on leave keeps the one reason it
    // always had: the new diagnostic is transfer-only by construction.
    const tourId = await makeTour();
    const vanId = await makeVan({ capacity: 4 });
    const driverId = await makeDriver({ maxTransferJobsPerDay: 0 });
    const bookingId = await makeBooking({ tourId, pax: 2, status: 'confirmed' });

    const [leave] = await getDb()
      .insert(driverLeaves)
      .values({
        driverId,
        startDate: new Date(`${TOUR_DATE}T00:00:00Z`),
        endDate: new Date(`${TOUR_DATE}T00:00:00Z`),
      });
    created.leaveIds.push(leave.insertId);

    const api = appRouter.createCaller(staffContext(dispatcherId, 'dispatcher') as never);
    await expect(api.admin.dispatch.assign({ bookingId, vanId, driverId })).rejects.toMatchObject({
      message: 'driver_unavailable',
    });
  });

  it('re-assigns a transfer to the SAME van and driver it already holds', async () => {
    // `excludeBookingId` through the real mutation: the booking's own window
    // overlaps itself exactly, and its own job counts against its own driver,
    // so without the exclusion this is refused twice over.
    const routeId = await makeRoute();
    const vanId = await makeVan({ capacity: 12, vehicleTypeId: VAN_ID });
    const driverId = await makeDriver({ maxTransferJobsPerDay: 1 });
    const bookingId = await makeTransferBooking({ routeId, pickupMinutes: at(8) });

    const api = appRouter.createCaller(staffContext(dispatcherId, 'dispatcher') as never);
    await expect(api.admin.dispatch.assign({ bookingId, vanId, driverId })).resolves.toEqual({
      ok: true,
    });
    await expect(api.admin.dispatch.assign({ bookingId, vanId, driverId })).resolves.toEqual({
      ok: true,
    });

    const [row] = await getDb()
      .select({ vanId: bookings.vanId, driverId: bookings.driverId })
      .from(bookings)
      .where(eq(bookings.id, bookingId));
    expect(row).toEqual({ vanId, driverId });
  });

  it('changes no money when it assigns a transfer', async () => {
    const routeId = await makeRoute();
    const vanId = await makeVan({ capacity: 12, vehicleTypeId: VAN_ID });
    const driverId = await makeDriver();
    const bookingId = await makeTransferBooking({ routeId, pickupMinutes: at(8) });

    const before = await moneySnapshot(bookingId);
    expect(before).toMatchObject({
      totalCentavos: expect.any(Number),
      amountPaidCentavos: expect.any(Number),
    });

    const api = appRouter.createCaller(staffContext(dispatcherId, 'dispatcher') as never);
    await api.admin.dispatch.assign({ bookingId, vanId, driverId });
    expect(await moneySnapshot(bookingId)).toEqual(before);
  });

  /* ======================================================================= *
   * Pre-task 0C — the TRANSFER seat + luggage soft check (owner decision
   * 2026-11-03). A transfer's van pool is filtered by vehicle TYPE alone
   * (`minCapacity: 0`), so an undersized van really is offered: step 6b
   * refuses it with `vehicle_too_small` unless the request carries
   * `override` AND a reason, which it then records on the one audit row.
   * ======================================================================= */

  const OVERRIDE_REASON = 'Four of the six are toddlers on laps.';

  it('assigns a transfer whose van fits both the seats and the stated luggage', async () => {
    const routeId = await makeRoute();
    // Measured van: 12 seats, 10 bags. Booking: 6 guests, 3 bags. Both fit,
    // so neither half of the check fires.
    const vanId = await makeVan({ capacity: 12, vehicleTypeId: VAN_ID, luggageCapacity: 10 });
    const driverId = await makeDriver();
    const bookingId = await makeTransferBooking({
      routeId,
      pickupMinutes: at(8),
      pax: 6,
      luggageCount: 3,
    });

    const api = appRouter.createCaller(staffContext(dispatcherId, 'dispatcher') as never);
    await expect(api.admin.dispatch.assign({ bookingId, vanId, driverId })).resolves.toEqual({
      ok: true,
    });

    // And NO override on the audit row. An unconditional `vehicleOverride`
    // key would make every later assertion about it meaningless.
    const audit = (await auditRowsFor('bookings', bookingId)).at(-1)!;
    expect(audit.action).toBe('booking_assigned');
    expect(audit.data).not.toHaveProperty('vehicleOverride');
  });

  /**
   * The NULL half, which is the state almost the whole real fleet is in on
   * the day this ships: `vans.luggage_capacity` is NULL = "not measured
   * yet", so the luggage comparison is SKIPPED rather than guessed. Fifty
   * bags against an unmeasured van assigns, and that is deliberate — a zero
   * would refuse every van nobody has got round to measuring.
   */
  it('skips the luggage check entirely when the van has no recorded luggage capacity', async () => {
    const routeId = await makeRoute();
    const vanId = await makeVan({ capacity: 12, vehicleTypeId: VAN_ID });
    const driverId = await makeDriver();
    const bookingId = await makeTransferBooking({
      routeId,
      pickupMinutes: at(8),
      pax: 2,
      luggageCount: 50,
    });

    const api = appRouter.createCaller(staffContext(dispatcherId, 'dispatcher') as never);
    await expect(api.admin.dispatch.assign({ bookingId, vanId, driverId })).resolves.toEqual({
      ok: true,
    });
    const audit = (await auditRowsFor('bookings', bookingId)).at(-1)!;
    expect(audit.data).not.toHaveProperty('vehicleOverride');
  });

  it('refuses a transfer van with too few SEATS, with vehicle_too_small and no override', async () => {
    const routeId = await makeRoute();
    // Right TYPE, genuinely free, and two seats short of the party — the
    // exact case `vansFreeOn`'s `minCapacity: 0` lets through.
    const vanId = await makeVan({ capacity: 4, vehicleTypeId: VAN_ID });
    const driverId = await makeDriver();
    const bookingId = await makeTransferBooking({ routeId, pickupMinutes: at(8), pax: 6 });

    const api = appRouter.createCaller(staffContext(dispatcherId, 'dispatcher') as never);
    await expect(api.admin.dispatch.assign({ bookingId, vanId, driverId })).rejects.toMatchObject({
      // BAD_REQUEST, not CONFLICT: re-sending this unchanged is refused
      // again, so "re-check the day" would be the wrong sentence.
      code: 'BAD_REQUEST',
      message: 'vehicle_too_small',
    });

    // Nothing written, and no audit row at all — a refusal that still
    // audited would claim an assignment that never happened.
    const [row] = await getDb()
      .select({ vanId: bookings.vanId, driverId: bookings.driverId, status: bookings.status })
      .from(bookings)
      .where(eq(bookings.id, bookingId));
    expect(row).toEqual({ vanId: null, driverId: null, status: 'confirmed' });
    expect(await auditRowsFor('bookings', bookingId)).toEqual([]);
    expect(sent).toHaveLength(0);
  });

  it('refuses a transfer van short on stated LUGGAGE, even though the seats fit', async () => {
    const routeId = await makeRoute();
    // 12 seats for 2 guests — the seat half cannot be what refuses this.
    const vanId = await makeVan({ capacity: 12, vehicleTypeId: VAN_ID, luggageCapacity: 2 });
    const driverId = await makeDriver();
    const bookingId = await makeTransferBooking({
      routeId,
      pickupMinutes: at(8),
      pax: 2,
      luggageCount: 6,
    });

    const api = appRouter.createCaller(staffContext(dispatcherId, 'dispatcher') as never);
    await expect(api.admin.dispatch.assign({ bookingId, vanId, driverId })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: 'vehicle_too_small',
    });

    const [row] = await getDb()
      .select({ vanId: bookings.vanId, status: bookings.status })
      .from(bookings)
      .where(eq(bookings.id, bookingId));
    expect(row).toEqual({ vanId: null, status: 'confirmed' });
  });

  it('ASSIGNS an undersized transfer van when override and a reason came with it', async () => {
    const routeId = await makeRoute();
    const vanId = await makeVan({ capacity: 4, vehicleTypeId: VAN_ID, luggageCapacity: 2 });
    const driverId = await makeDriver();
    const bookingId = await makeTransferBooking({
      routeId,
      pickupMinutes: at(8),
      pax: 6,
      luggageCount: 6,
    });

    const api = appRouter.createCaller(staffContext(dispatcherId, 'dispatcher') as never);
    await expect(
      api.admin.dispatch.assign({
        bookingId,
        vanId,
        driverId,
        override: true,
        overrideReason: OVERRIDE_REASON,
      }),
    ).resolves.toEqual({ ok: true });

    const [row] = await getDb()
      .select({ vanId: bookings.vanId, driverId: bookings.driverId, status: bookings.status })
      .from(bookings)
      .where(eq(bookings.id, bookingId));
    expect(row).toEqual({ vanId, driverId, status: 'assigned' });

    /*
     * ONE audit row, with the fit AS IT WAS recorded on it — not just the
     * reason. The van's seats and luggage figure are admin-editable, so a
     * row carrying only "they overrode it" could not be read back later
     * against numbers that have since changed.
     */
    const rows = await auditRowsFor('bookings', bookingId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.action).toBe('booking_assigned');
    expect(rows[0]!.data).toMatchObject({
      vanId,
      driverId,
      vehicleOverride: {
        pax: 6,
        vanCapacity: 4,
        luggageCount: 6,
        vanLuggageCapacity: 2,
        reason: OVERRIDE_REASON,
      },
    });
  });

  /**
   * TWO Zod rules, not one, and each needs its own payload — a point the
   * first draft of this test missed, and measuring it is what found that:
   *
   *  - `overrideReason: z.string().trim().min(5)` refuses a reason that is
   *    PRESENT and too short (or only whitespace);
   *  - the schema-level `.refine()` refuses `override: true` with the field
   *    OMITTED ENTIRELY, which no per-field rule can see.
   *
   * Neutering the refine leaves the first three cases green — so a test that
   * only sent short strings would have proved the field rule twice and the
   * refine not at all.
   */
  it('REJECTS override: true without a usable reason, at Zod', async () => {
    const routeId = await makeRoute();
    const vanId = await makeVan({ capacity: 4, vehicleTypeId: VAN_ID });
    const driverId = await makeDriver();
    const bookingId = await makeTransferBooking({ routeId, pickupMinutes: at(8), pax: 6 });

    const api = appRouter.createCaller(staffContext(dispatcherId, 'dispatcher') as never);
    const payloads = [
      { label: 'empty', extra: { overrideReason: '' } },
      { label: 'whitespace', extra: { overrideReason: '   ' } },
      { label: 'under five characters', extra: { overrideReason: 'tiny' } },
      // The `.refine()`'s own case: the key is not there at all.
      { label: 'omitted', extra: {} },
    ];
    for (const { label, extra } of payloads) {
      const error = await api.admin.dispatch
        .assign({ bookingId, vanId, driverId, override: true, ...extra })
        .then(
          () => null,
          (thrown: unknown) => thrown,
        );
      expect(error, `an override reason that was ${label} was accepted`).not.toBe(null);
      expect(error).toMatchObject({ code: 'BAD_REQUEST' });

      /*
       * The issue is pinned to `overrideReason`'s OWN path, which is what
       * lets the panel place the message beside that box rather than render
       * raw Zod JSON in a banner (CLAUDE.md). A refusal that arrived with no
       * path would pass a bare `BAD_REQUEST` assertion and still leave the
       * dispatcher reading a blob.
       */
      const cause = (error as { cause?: unknown }).cause;
      expect(cause).toBeInstanceOf(ZodError);
      const paths = (cause as ZodError).issues.map((issue) => issue.path.join('.'));
      expect(paths).toContain('overrideReason');
    }

    // Zod refused before the service ran, so nothing was written at all.
    const [row] = await getDb()
      .select({ vanId: bookings.vanId, status: bookings.status })
      .from(bookings)
      .where(eq(bookings.id, bookingId));
    expect(row).toEqual({ vanId: null, status: 'confirmed' });
    expect(await auditRowsFor('bookings', bookingId)).toEqual([]);
  });

  /**
   * The override is INERT on a tour, and this documents that rather than
   * relying on it. A tour's own `vansFreeOn` call passes `minCapacity: pax`,
   * so an undersized van is never offered and step 6b's condition cannot
   * occur — which is why `vehicle_too_small` is transfer-only and why a tour
   * assignment carrying `override: true` is simply an ordinary assignment.
   */
  it('ignores override on a TOUR assignment — it assigns normally and audits no override', async () => {
    const tourId = await makeTour();
    const vanId = await makeVan({ capacity: 12, luggageCapacity: 1 });
    const driverId = await makeDriver();
    /*
     * The van is recorded as holding ONE bag, which on the transfer branch is
     * the kind of figure that refuses. It cannot refuse here, and for two
     * independent reasons worth stating because neither is obvious: a tour
     * booking has no `booking_transfer_details` row, so its `luggageCount`
     * is NULL and the luggage half has nothing to compare against; and the
     * seats cannot refuse either, because a tour's own `vansFreeOn` call
     * passes `minCapacity: pax`, so the 12-seat van would not have been
     * offered for these 6 guests if it did not fit.
     */
    const bookingId = await makeBooking({ tourId, pax: 6, status: 'confirmed' });

    const api = appRouter.createCaller(staffContext(dispatcherId, 'dispatcher') as never);
    await expect(
      api.admin.dispatch.assign({
        bookingId,
        vanId,
        driverId,
        override: true,
        overrideReason: OVERRIDE_REASON,
      }),
    ).resolves.toEqual({ ok: true });

    const audit = (await auditRowsFor('bookings', bookingId)).at(-1)!;
    expect(audit.action).toBe('booking_assigned');
    expect(audit.data).not.toHaveProperty('vehicleOverride');
  });

  /* ----------------------------------------------------------------------- *
   * Step 6b's own fail-closed re-check, with NO Zod in the path.
   *
   * **Why these three tests have to bypass the router** (dedicated review
   * finding, 2026-11-03, and the reason it was found at all): every other
   * test in this file reaches step 6b through tRPC, where
   * `assignInputSchema` refuses a reasonless override FIRST. So the
   * service's own re-check was never executed by the suite — the reviewer
   * weakened it to `if (!override)` and all 48 tests stayed green. These
   * call `assignVanAndDriver(tx, …)` directly, which is also the shape a
   * future in-process caller takes (a job, a backfill, a later task's
   * internal convert path), and that caller has no Zod layer to save it.
   * ----------------------------------------------------------------------- */

  /** Builds the undersized-transfer fixture these three share. */
  async function undersizedTransferFixture() {
    const routeId = await makeRoute();
    // Right TYPE and genuinely free, two seats short of the party.
    const vanId = await makeVan({ capacity: 4, vehicleTypeId: VAN_ID });
    const driverId = await makeDriver();
    const bookingId = await makeTransferBooking({ routeId, pickupMinutes: at(8), pax: 6 });
    return { vanId, driverId, bookingId };
  }

  /** `assignVanAndDriver` with no router, no Zod, no input parsing. */
  async function assignDirect(input: {
    bookingId: number;
    vanId: number;
    driverId: number;
    override?: boolean;
    overrideReason?: string;
  }) {
    return await getDb().transaction((tx) =>
      assignVanAndDriver(tx, { ...input, actorUserId: dispatcherId }),
    );
  }

  it('refuses at the SERVICE when override arrives with NO reason, Zod bypassed', async () => {
    const { vanId, driverId, bookingId } = await undersizedTransferFixture();

    // `override: true` and no `overrideReason` key at all — a payload tRPC
    // would never deliver, because the schema's `.refine()` stops it.
    await expect(assignDirect({ bookingId, vanId, driverId, override: true })).resolves.toEqual({
      ok: false,
      reason: 'vehicle_too_small',
    });

    // An empty string is the same refusal by the same branch.
    await expect(
      assignDirect({ bookingId, vanId, driverId, override: true, overrideReason: '   ' }),
    ).resolves.toEqual({ ok: false, reason: 'vehicle_too_small' });

    // Nothing written and NO audit row — an override that was refused must
    // not leave a row claiming a reasoned one.
    const [row] = await getDb()
      .select({ vanId: bookings.vanId, driverId: bookings.driverId, status: bookings.status })
      .from(bookings)
      .where(eq(bookings.id, bookingId));
    expect(row).toEqual({ vanId: null, driverId: null, status: 'confirmed' });
    expect(await auditRowsFor('bookings', bookingId)).toEqual([]);
  });

  it('refuses at the SERVICE when the override reason is shorter than Zod would accept', async () => {
    /*
     * The THRESHOLD half of the same finding: the service used to test
     * presence only, so a direct caller could bank a one-character reason
     * while `assignInputSchema` demanded five. Both now read
     * `OVERRIDE_REASON_MIN_LENGTH`, so this asserts the boundary rather than
     * the literal — change the constant and this test follows it.
     */
    const { vanId, driverId, bookingId } = await undersizedTransferFixture();
    expect(OVERRIDE_REASON_MIN_LENGTH).toBeGreaterThan(1);

    const tooShort = 'x'.repeat(OVERRIDE_REASON_MIN_LENGTH - 1);
    await expect(
      assignDirect({ bookingId, vanId, driverId, override: true, overrideReason: tooShort }),
    ).resolves.toEqual({ ok: false, reason: 'vehicle_too_small' });
    // And one that is only long enough once you forget to trim it.
    await expect(
      assignDirect({
        bookingId,
        vanId,
        driverId,
        override: true,
        overrideReason: `  ${tooShort}  `,
      }),
    ).resolves.toEqual({ ok: false, reason: 'vehicle_too_small' });

    expect(await auditRowsFor('bookings', bookingId)).toEqual([]);
  });

  /**
   * The positive control for the two above. Without it they would also pass
   * against a service that refuses EVERY direct override — which is the
   * other way to get this wrong, and would break the router path too.
   */
  it('ACCEPTS a direct override whose reason meets the threshold exactly', async () => {
    const { vanId, driverId, bookingId } = await undersizedTransferFixture();

    const justLongEnough = 'x'.repeat(OVERRIDE_REASON_MIN_LENGTH);
    await expect(
      assignDirect({ bookingId, vanId, driverId, override: true, overrideReason: justLongEnough }),
    ).resolves.toEqual({ ok: true });

    const rows = await auditRowsFor('bookings', bookingId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.data).toMatchObject({
      vehicleOverride: { pax: 6, vanCapacity: 4, reason: justLongEnough },
    });
  });

  /**
   * The override is not a side door around §9's role gate. Finance is
   * refused `FORBIDDEN` by `adminProcedure('assignVanDriver')` BEFORE any of
   * step 6b runs — and the payload here is the one that would otherwise
   * SUCCEED for a dispatcher, so the refusal can only be the role.
   */
  it('REFUSES finance an undersized-vehicle override — the gate comes first', async () => {
    const routeId = await makeRoute();
    const vanId = await makeVan({ capacity: 4, vehicleTypeId: VAN_ID });
    const driverId = await makeDriver();
    const bookingId = await makeTransferBooking({ routeId, pickupMinutes: at(8), pax: 6 });

    const finance = appRouter.createCaller(staffContext(financeId, 'finance') as never);
    await expect(
      finance.admin.dispatch.assign({
        bookingId,
        vanId,
        driverId,
        override: true,
        overrideReason: OVERRIDE_REASON,
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });

    const [row] = await getDb()
      .select({ vanId: bookings.vanId, status: bookings.status })
      .from(bookings)
      .where(eq(bookings.id, bookingId));
    expect(row).toEqual({ vanId: null, status: 'confirmed' });
    expect(await auditRowsFor('bookings', bookingId)).toEqual([]);

    // VACUITY GUARD: the exact same payload must be ACCEPTED for a
    // dispatcher, or this test would pass against a request that was simply
    // malformed and prove nothing about the role gate.
    const dispatcher = appRouter.createCaller(staffContext(dispatcherId, 'dispatcher') as never);
    await expect(
      dispatcher.admin.dispatch.assign({
        bookingId,
        vanId,
        driverId,
        override: true,
        overrideReason: OVERRIDE_REASON,
      }),
    ).resolves.toEqual({ ok: true });
  });
});
