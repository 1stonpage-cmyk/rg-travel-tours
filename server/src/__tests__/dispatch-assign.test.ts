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
});
