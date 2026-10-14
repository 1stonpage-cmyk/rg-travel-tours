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
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from 'vitest';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import type { BookingStatus, PriceSnapshot } from '@rg/shared';
import { appRouter } from '../routers/_app';
import { getDb, getPool } from '../db/client';
import {
  auditLog,
  bookings,
  destinations,
  driverLeaves,
  drivers,
  payments,
  tours,
  users,
  vans,
} from '../db/schema';
import { generateBookingRef } from '../services/booking-ref';
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
  destIds: [] as number[],
  vanIds: [] as number[],
  driverIds: [] as number[],
  leaveIds: [] as number[],
};

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

async function makeVan(opts: { capacity?: number } = {}) {
  const suffix = unique();
  const [van] = await getDb()
    .insert(vans)
    .values({
      plate: `DSP${suffix}`.slice(0, 20),
      model: 'Assignment Fixture Van',
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
      name: `Assignment Fixture Driver ${suffix}`,
      code: `DSP${suffix}`.slice(0, 20),
      phone: '09170000000',
      // Not a real hash: nothing here logs in.
      pinHash: '__dispassign_not_a_pin_hash__',
      isActive: true,
    });
  created.driverIds.push(driver.insertId);
  return driver.insertId;
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
  });

  afterEach(async () => {
    const pool = getPool();
    for (const id of created.bookingIds) {
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
    for (const id of created.destIds) {
      await pool.query('DELETE FROM destinations WHERE id = ?', [id]);
    }
    for (const id of created.driverIds) await pool.query('DELETE FROM drivers WHERE id = ?', [id]);
    for (const id of created.vanIds) await pool.query('DELETE FROM vans WHERE id = ?', [id]);
    created.bookingIds = [];
    created.leaveIds = [];
    created.tourIds = [];
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
    ).rejects.toThrow();
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
    await expect(
      api.admin.dispatch.assign({ bookingId, vanId: tinyVanId, driverId }),
    ).rejects.toThrow(/van_too_small|van_unavailable/);
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
    await expect(api.admin.dispatch.assign({ bookingId, vanId, driverId })).rejects.toThrow(
      /driver_unavailable/,
    );
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
});
