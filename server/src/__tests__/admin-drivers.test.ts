/**
 * Week 5 plan, Task 6 — `admin.drivers.*`: CRUD, leaves and PIN reset
 * (BUILD_SPEC §9 "Drivers" / §5B, server half).
 *
 * `resetPin` is the one procedure here that touches a credential, so most of
 * this file is about it: the owner's instruction (2026-10-14) that a reset
 * IS the admin unlock from the Q9 lockout policy, and must clear all five
 * lockout columns in the same transaction as the new hash.
 *
 * **Test 1, and what it does and does not prove (controller ruling,
 * 2026-10-14).** "Can sign in with the new PIN immediately" has no login
 * endpoint to exercise this week — the driver portal is Week 6, and
 * `evaluatePinAttempt()` is a pure function with no caller yet. So
 * `'clears the lockout so a locked-out driver can sign in again'` below is a
 * composition at the layer that actually exists: put the row into the fully
 * locked state, call `resetPin`, read the row back and assert the five
 * lockout fields are cleared, then feed that state into `evaluatePinAttempt`
 * and assert the outcome is `'ok'` (not `'needs_admin_unlock'`, not
 * `'locked'`), and assert the new PIN verifies against the stored hash. That
 * proves the POLICY (the function Week 6's login will sit behind admits the
 * driver) and the CREDENTIAL (the new PIN verifies) — it does not prove an
 * end-to-end login, because nothing can this week. "The old PIN no longer
 * works" (the owner's second named test) is proven separately, by
 * `'stores a scrypt hash that verifies the new PIN and not the old one'`,
 * which resets twice and checks both hashes — not repeated here, because
 * this test's driver has no single "old PIN" of its own (its PIN was last
 * set by that earlier test, not by a login attempt), and re-deriving one
 * would test nothing the other test doesn't already cover.
 *
 * Role refusals are asserted on `code`, never on the message (controller
 * note, 2026-10-14): `requireRole()` throws messages that name neither
 * UNAUTHORIZED nor FORBIDDEN, so a regex on the message can pass against
 * broken code. `admin-bookings.test.ts:256-272` and `admin-vans.test.ts` use
 * the same `.rejects.toMatchObject({ code })` pattern.
 */
import { afterAll, beforeAll, expect, it } from 'vitest';
import { and, asc, eq, inArray } from 'drizzle-orm';
import type { PriceSnapshot } from '@rg/shared';
import { appRouter } from '../routers/_app';
import { getDb, getPool } from '../db/client';
import {
  auditLog,
  bookings,
  destinations,
  driverLeaves,
  drivers,
  tours,
  users,
} from '../db/schema';
import { generateBookingRef } from '../services/booking-ref';
import { evaluatePinAttempt } from '../services/driver-lockout';
import { verifyPassword } from '../services/password';
import { staffContext } from './helpers/ctx';
import { describeWithDb } from './helpers/db';

/** The tour day the "already assigned" leave test uses. */
const TOUR_DATE = '2026-12-01';

/** Every id this file committed, so teardown removes exactly those rows. */
const created = {
  userIds: [] as number[],
  driverIds: [] as number[],
  bookingIds: [] as number[],
  tourIds: [] as number[],
  destinationIds: [] as number[],
};

const unique = () => `${Math.floor(Math.random() * 1e9)}_${Date.now()}`;

async function makeStaff(role: 'owner' | 'dispatcher' | 'finance') {
  const suffix = unique();
  const [row] = await getDb()
    .insert(users)
    .values({
      name: `Admin ${role} ${suffix}`,
      email: `addrv_${role}_${suffix}@example.test`,
      passwordHash: '__addrv_fixture_not_a_hash__',
      role,
      isActive: true,
    });
  created.userIds.push(row.insertId);
  return row.insertId;
}

/** A driver fixture. Not a real hash and not a real PIN: nothing here logs in. */
async function makeDriver() {
  const suffix = unique();
  const [driver] = await getDb()
    .insert(drivers)
    .values({
      name: `Drivers Fixture ${suffix}`,
      code: `ADD${suffix}`.slice(0, 20),
      phone: '09170000000',
      pinHash: '__admin_drivers_fixture_not_a_pin_hash__',
      isActive: true,
    });
  created.driverIds.push(driver.insertId);
  return driver.insertId;
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

/** A committed booking on `tourId`/`date`, unassigned until a test says otherwise. */
async function makeBooking(tourId: number, date: string) {
  const [booking] = await getDb()
    .insert(bookings)
    .values({
      ref: generateBookingRef(),
      tourId,
      tourDate: new Date(`${date}T00:00:00Z`),
      pax: 2,
      leadName: 'Drivers Fixture',
      leadEmail: 'fixture@example.test',
      leadPhone: '09170000000',
      status: 'pending_payment',
      payMode: 'full',
      priceSnapshot: SNAPSHOT,
      subtotalCentavos: 100000,
      totalCentavos: 100000,
    });
  created.bookingIds.push(booking.insertId);
  return booking.insertId;
}

/**
 * Every audit row written against one entity, oldest first. Unlike
 * `admin-vans.test.ts`'s version, this one selects `data` too: the whole
 * point of this suite's audit tests is that the PIN never appears in that
 * column, and a test that never fetched the column could never see it fail.
 */
async function auditRowsFor(entity: string, entityId: number) {
  return getDb()
    .select({
      action: auditLog.action,
      actorType: auditLog.actorType,
      actorId: auditLog.actorId,
      data: auditLog.data,
    })
    .from(auditLog)
    .where(and(eq(auditLog.entity, entity), eq(auditLog.entityId, entityId)))
    .orderBy(asc(auditLog.id));
}

/** The current `pin_hash` for one driver. */
async function pinHashFor(driverId: number): Promise<string> {
  const [row] = await getDb()
    .select({ pinHash: drivers.pinHash })
    .from(drivers)
    .where(eq(drivers.id, driverId));
  if (!row) throw new Error(`no driver ${driverId}`);
  return row.pinHash;
}

let ownerId = 0;
let dispatcherId = 0;
let financeId = 0;
let driverId = 0;
let tourId = 0;
let bookingId = 0;

const idFor = (role: 'owner' | 'dispatcher' | 'finance') =>
  role === 'owner' ? ownerId : role === 'dispatcher' ? dispatcherId : financeId;

/** Every `driverLeaveInputSchema` field present — `.strict()` requires all of them. */
let VALID_LEAVE: {
  driverId: number;
  startDate: string;
  endDate: string;
  reason: string | null;
};

beforeAll(async () => {
  ownerId = await makeStaff('owner');
  dispatcherId = await makeStaff('dispatcher');
  financeId = await makeStaff('finance');
  driverId = await makeDriver();

  const db = getDb();
  const slug = `__drv__${unique()}`;
  const [destination] = await db.insert(destinations).values({ name: slug, slug });
  created.destinationIds.push(destination.insertId);
  const [tour] = await db.insert(tours).values({
    slug,
    title: slug,
    destinationId: destination.insertId,
    groupsPerDay: 1,
    isActive: true,
  });
  tourId = tour.insertId;
  created.tourIds.push(tourId);
  bookingId = await makeBooking(tourId, TOUR_DATE);

  // Dates well clear of the ranges the leave tests below exercise
  // (2026-11-10..14 and TOUR_DATE 2026-12-01), so this fixture can never
  // collide with them even though it is only ever used against the
  // role-refusal gate, which throws before the resolver body runs.
  VALID_LEAVE = { driverId, startDate: '2026-09-01', endDate: '2026-09-03', reason: null };
}, 60_000);

afterAll(async () => {
  const pool = getPool();
  const db = getDb();
  /*
   * Raw parameterized SQL, not `db.delete(bookings)` — `schema-conventions
   * .test.ts` scans the WHOLE server tree (tests included) for the Drizzle
   * form of a bookings/payments hard-delete, with no test-file exemption for
   * it the way the raw-SQL form gets. `capacity.test.ts`'s own teardown uses
   * exactly this shape for its booking fixtures, for the same reason: this
   * is cleanup in `rg_travel_test`, not the production hard-delete the guard
   * exists to catch.
   */
  for (const id of created.bookingIds) {
    await pool.query('DELETE FROM bookings WHERE id = ?', [id]);
  }
  if (created.driverIds.length > 0) {
    await db.delete(driverLeaves).where(inArray(driverLeaves.driverId, created.driverIds));
    await db
      .delete(auditLog)
      .where(and(eq(auditLog.entity, 'driver'), inArray(auditLog.entityId, created.driverIds)));
    await db.delete(drivers).where(inArray(drivers.id, created.driverIds));
  }
  if (created.tourIds.length > 0) {
    await db.delete(tours).where(inArray(tours.id, created.tourIds));
  }
  if (created.destinationIds.length > 0) {
    await db.delete(destinations).where(inArray(destinations.id, created.destinationIds));
  }
  for (const id of created.userIds) {
    await pool.query('DELETE FROM sessions WHERE subject_type = ? AND subject_id = ?', [
      'user',
      id,
    ]);
    await pool.query('DELETE FROM users WHERE id = ?', [id]);
  }
});

describeWithDb('drivers', () => {
  it('generates a six-digit PIN and returns it exactly once', async () => {
    const api = appRouter.createCaller(staffContext(ownerId, 'owner') as never);
    const { pin } = await api.admin.drivers.resetPin({ id: driverId });
    expect(pin).toMatch(/^[0-9]{6}$/);

    const listed = await api.admin.drivers.list();
    const row = listed.find((d) => d.id === driverId)!;
    expect(JSON.stringify(row)).not.toContain(pin);
    expect(row).not.toHaveProperty('pinHash');
  });

  it('never writes the PIN into the audit log', async () => {
    const api = appRouter.createCaller(staffContext(ownerId, 'owner') as never);
    const { pin } = await api.admin.drivers.resetPin({ id: driverId });
    const rows = await auditRowsFor('driver', driverId);
    expect(JSON.stringify(rows)).not.toContain(pin);
    expect(rows.at(-1)?.action).toBe('driver_pin_reset');
  });

  it('stores a scrypt hash that verifies the new PIN and not the old one', async () => {
    const api = appRouter.createCaller(staffContext(ownerId, 'owner') as never);
    const first = await api.admin.drivers.resetPin({ id: driverId });
    const second = await api.admin.drivers.resetPin({ id: driverId });
    const hash = await pinHashFor(driverId);
    expect(hash.startsWith('scrypt$')).toBe(true);
    await expect(verifyPassword(second.pin, hash)).resolves.toBe(true);
    await expect(verifyPassword(first.pin, hash)).resolves.toBe(false);
  });

  it('clears the lockout so a locked-out driver can sign in again', async () => {
    const db = getDb();
    await db
      .update(drivers)
      .set({
        failedAttempts: 5,
        lockedUntil: new Date(Date.now() + 9e5),
        lockoutCount: 3,
        requiresAdminUnlock: true,
      })
      .where(eq(drivers.id, driverId));
    const api = appRouter.createCaller(staffContext(ownerId, 'owner') as never);
    const { pin } = await api.admin.drivers.resetPin({ id: driverId });
    const [row] = await db.select().from(drivers).where(eq(drivers.id, driverId));
    if (!row) throw new Error(`no driver ${driverId}`);
    expect({
      failedAttempts: row.failedAttempts,
      lockedUntil: row.lockedUntil,
      lockoutCount: row.lockoutCount,
      requiresAdminUnlock: row.requiresAdminUnlock,
    }).toEqual({
      failedAttempts: 0,
      lockedUntil: null,
      lockoutCount: 0,
      requiresAdminUnlock: false,
    });

    // Controller ruling: feed the post-reset row into the pure policy
    // function and assert it admits the driver — this is what "can sign in
    // immediately" means at the layer that exists before Week 6's login.
    const decision = evaluatePinAttempt(
      {
        failedAttempts: row.failedAttempts,
        lockedUntil: row.lockedUntil,
        lockoutCount: row.lockoutCount,
        lockoutWindowStartedAt: row.lockoutWindowStartedAt,
        requiresAdminUnlock: row.requiresAdminUnlock,
      },
      new Date(),
      true,
    );
    expect(decision.outcome).toBe('ok');
    await expect(verifyPassword(pin, row.pinHash)).resolves.toBe(true);
  });

  /**
   * ALL SIX procedures, live. An earlier version of this test called three
   * of them while being named "every drivers procedure" — the gate was
   * still proven generically by `procedure-role-metadata.test.ts` and
   * `role-isolation.test.ts`, so nothing was unguarded, but the name
   * claimed coverage the body did not have. §9's matrix is a security
   * boundary and `CLAUDE.md` asks for a test per role per area, so the
   * body now matches the name.
   *
   * None of the ids or payloads has to be valid: `requireRole` runs before
   * the resolver, so a finance session is refused before any of these ever
   * reads the database.
   */
  it('REFUSES finance on every drivers procedure', async () => {
    const api = appRouter.createCaller(staffContext(financeId, 'finance') as never);
    const refusals = await Promise.all([
      api.admin.drivers.list().catch((e: unknown) => e),
      api.admin.drivers
        .create({
          name: 'Finance Should Not Reach This',
          code: `FIN${unique()}`.slice(0, 20),
          phone: '09170000000',
          licenseNo: null,
          licenseExpiry: null,
          languages: null,
          emergencyContact: null,
        })
        .catch((e: unknown) => e),
      api.admin.drivers
        .update({ id: driverId, patch: { name: 'Finance Should Not Reach This' } })
        .catch((e: unknown) => e),
      api.admin.drivers.resetPin({ id: driverId }).catch((e: unknown) => e),
      api.admin.drivers.addLeave(VALID_LEAVE).catch((e: unknown) => e),
      api.admin.drivers.removeLeave({ id: 1 }).catch((e: unknown) => e),
    ]);

    // Exactly six, every one FORBIDDEN — not "at least one refusal".
    expect(refusals).toHaveLength(6);
    for (const refusal of refusals) {
      expect(refusal).toMatchObject({ code: 'FORBIDDEN' });
    }
  });

  it('refuses a backwards leave range at the Zod boundary, before the DB CHECK', async () => {
    const api = appRouter.createCaller(staffContext(ownerId, 'owner') as never);
    await expect(
      api.admin.drivers.addLeave({
        driverId,
        startDate: '2026-11-10',
        endDate: '2026-11-03',
        reason: null,
      }),
    ).rejects.toThrow(/end/i);
  });

  /**
   * `list` must return each driver's leaves (controller fix, 2026-10-14).
   *
   * The plan shipped `addLeave` and `removeLeave` with no way to READ a
   * leave, which broke two things at once: §9 asks the drivers screen to
   * show "on leave (with date ranges)" and it had nothing to show, and
   * `removeLeave` takes a leave id **the client had no way to obtain**.
   * Task 7 had to fake it with a client-only cache to render anything.
   *
   * Exact values, not shapes: a wrong-by-one-day date here is a driver
   * dispatched on a day they booked off.
   */
  it('returns each driver leaves, soonest first, as civil-date strings', async () => {
    const api = appRouter.createCaller(staffContext(ownerId, 'owner') as never);
    const freshDriverId = await makeDriver();

    // Added out of order on purpose — the ordering is the assertion.
    await api.admin.drivers.addLeave({
      driverId: freshDriverId,
      startDate: '2027-03-10',
      endDate: '2027-03-12',
      reason: 'Later leave',
    });
    await api.admin.drivers.addLeave({
      driverId: freshDriverId,
      startDate: '2027-01-05',
      endDate: '2027-01-05',
      reason: 'Single day, earlier',
    });

    const listed = await api.admin.drivers.list();
    const mine = listed.find((d) => d.id === freshDriverId);
    expect(mine, 'the driver just created must be in the list').toBeDefined();
    expect(mine!.leaves).toHaveLength(2);
    expect(mine!.leaves.map((l) => [l.startDate, l.endDate, l.reason])).toEqual([
      ['2027-01-05', '2027-01-05', 'Single day, earlier'],
      ['2027-03-10', '2027-03-12', 'Later leave'],
    ]);
    // Every id is real, so `removeLeave` is actually reachable from a client.
    for (const leave of mine!.leaves) {
      expect(leave.id).toBeGreaterThan(0);
    }
  });

  it('gives a driver with no leaves an empty array, never undefined', async () => {
    const api = appRouter.createCaller(staffContext(ownerId, 'owner') as never);
    const freshDriverId = await makeDriver();
    const listed = await api.admin.drivers.list();
    expect(listed.find((d) => d.id === freshDriverId)!.leaves).toEqual([]);
  });

  it('refuses a leave that overlaps one the driver already has', async () => {
    const api = appRouter.createCaller(staffContext(ownerId, 'owner') as never);
    await api.admin.drivers.addLeave({
      driverId,
      startDate: '2026-11-10',
      endDate: '2026-11-12',
      reason: null,
    });
    await expect(
      api.admin.drivers.addLeave({
        driverId,
        startDate: '2026-11-12',
        endDate: '2026-11-14',
        reason: null,
      }),
    ).rejects.toThrow(/overlap/i);
  });

  it('refuses leave on a date the driver is already assigned to a trip', async () => {
    // Otherwise dispatch and the leave calendar disagree about one day, and
    // the driver finds out on the morning.
    const api = appRouter.createCaller(staffContext(ownerId, 'owner') as never);
    await getDb()
      .update(bookings)
      .set({ driverId, status: 'assigned' })
      .where(eq(bookings.id, bookingId));
    await expect(
      api.admin.drivers.addLeave({
        driverId,
        startDate: TOUR_DATE,
        endDate: TOUR_DATE,
        reason: null,
      }),
    ).rejects.toThrow(/assigned/i);
  });

  it('ALLOWS dispatcher and owner to list drivers', async () => {
    for (const role of ['owner', 'dispatcher'] as const) {
      const api = appRouter.createCaller(staffContext(idFor(role), role) as never);
      await expect(api.admin.drivers.list()).resolves.toBeInstanceOf(Array);
    }
  });
});
