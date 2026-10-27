/**
 * Week 5 plan, Task 6 — `admin.drivers.*`: CRUD, leaves, PIN reset and
 * (since 2026-10-23) unlock (BUILD_SPEC §9 "Drivers" / §5B, server half).
 *
 * `resetPin` is the one procedure here that touches a credential, so much of
 * this file is about it: the owner's instruction (2026-10-14) that a reset
 * must clear all five lockout columns in the same transaction as the new hash.
 *
 * **`unlock` is the lockout half on its own** (owner decision 2026-10-23, Q1,
 * option C+E), and its block below is about the one thing that separates the
 * two: it must NEVER touch `pin_hash`, and it must refuse rather than succeed
 * quietly on a driver who is not locked.
 *
 * **Test 1, and what it does and does not prove (controller ruling,
 * 2026-10-14).** "Can sign in with the new PIN immediately" has no login
 * endpoint to exercise this week — the driver portal is Week 6, and
 * `evaluatePinAttempt()` is a pure function with no caller yet. So
 * `'clears the lockout so a locked-out driver can sign in again'` below is a
 * composition at the layer that actually exists: put the row into the fully
 * locked state, call `resetPin`, read the row back and assert the five
 * lockout fields are cleared, then feed that state into `evaluatePinAttempt`
 * and assert the outcome is `'ok'` (not `'locked'` — `'needs_admin_unlock'`
 * was the third possibility until owner decision 2026-10-23 retired it from
 * `LockoutOutcome` entirely), and assert the new PIN verifies against the
 * stored hash. That
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
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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
  reviews,
  sessions,
  settings as settingsTable,
  tours,
  users,
} from '../db/schema';
import { generateBookingRef } from '../services/booking-ref';
import { evaluatePinAttempt } from '../services/driver-lockout';
import { verifyPassword } from '../services/password';
import { createSession, readSession } from '../services/sessions';
import { driverCaller, staffContext, testContext } from './helpers/ctx';
import { describeWithDb } from './helpers/db';

/** The tour day the "already assigned" leave test uses. */
const TOUR_DATE = '2026-12-01';

/** Every id this file committed, so teardown removes exactly those rows. */
const created = {
  reviewIds: [] as number[],
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
  /*
   * Reviews BEFORE bookings: `reviews.booking_id` is a foreign key, so the
   * booking delete below fails while a review still points at it. Found by
   * running the suite, not by reading the schema.
   */
  if (created.reviewIds.length > 0) {
    await db.delete(reviews).where(inArray(reviews.id, created.reviewIds));
  }
  for (const id of created.bookingIds) {
    await pool.query('DELETE FROM bookings WHERE id = ?', [id]);
  }
  if (created.driverIds.length > 0) {
    await db.delete(driverLeaves).where(inArray(driverLeaves.driverId, created.driverIds));
    await db
      .delete(sessions)
      .where(
        and(eq(sessions.subjectType, 'driver'), inArray(sessions.subjectId, created.driverIds)),
      );
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

  /**
   * CHANGED 2026-10-23 (owner decision Q1): the staged row still sets the
   * retired `requires_admin_unlock` flag — deliberately, because `resetPin`
   * still zeroes all five columns and this is what proves it — but the policy
   * state fed into `evaluatePinAttempt` no longer carries it, since
   * `LockoutState` no longer has the field. What the test proves is unchanged.
   */
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
      },
      new Date(),
      true,
    );
    expect(decision.outcome).toBe('ok');
    await expect(verifyPassword(pin, row.pinHash)).resolves.toBe(true);
  });

  /**
   * `list`'s locked-out signal (owner decision 2026-10-24, point 1) — the
   * field the Unlock button is gated on.
   *
   * It is a BOOLEAN derived on the server, against the one `now` the request
   * reads, and the raw `locked_until` instant deliberately never reaches the
   * response: the browser compares no clocks and no timezones to decide
   * whether to offer the button, and nothing on the admin screen needs the
   * exact unlock time (the same principle as Q1's "no tier, no banked count
   * and no `locked_until` instant" on the driver's own screen, a different
   * surface).
   */
  it('derives isLockedOut server-side — a live lockout only, never the raw instant', async () => {
    const lockedId = await makeDriver();
    const lapsedId = await makeDriver();
    const neverLockedId = await makeDriver();
    const lockedInactiveId = await makeDriver();
    const db = getDb();
    await db
      .update(drivers)
      .set({ failedAttempts: 5, lockedUntil: new Date(Date.now() + 30 * 60_000) })
      .where(eq(drivers.id, lockedId));
    // Five minutes in the PAST: `failed_attempts` still standing, but the
    // driver can sign in, so the screen must not offer to unlock them.
    await db
      .update(drivers)
      .set({ failedAttempts: 5, lockedUntil: new Date(Date.now() - 5 * 60_000) })
      .where(eq(drivers.id, lapsedId));
    /*
     * Locked AND off the roster (review finding, 2026-10-24). The dashboard's
     * `driverLocked` alert filters these out (`and(eq(drivers.isActive, true),
     * gt(drivers.lockedUntil, now))`), and `unlock` refuses them, so a flag
     * that said `true` here would put an Unlock button on the one row where
     * the card is silent and the mutation answers NOT_FOUND — three surfaces,
     * three answers. The flag asks the alert's question, whole.
     */
    await db
      .update(drivers)
      .set({
        failedAttempts: 5,
        lockedUntil: new Date(Date.now() + 30 * 60_000),
        isActive: false,
      })
      .where(eq(drivers.id, lockedInactiveId));

    const api = appRouter.createCaller(staffContext(ownerId, 'owner') as never);
    const rows = await api.admin.drivers.list();
    const flagFor = (id: number) => rows.find((row) => row.id === id)?.isLockedOut;
    expect(flagFor(lockedId)).toBe(true);
    expect(flagFor(lapsedId)).toBe(false);
    expect(flagFor(neverLockedId)).toBe(false);
    expect(flagFor(lockedInactiveId)).toBe(false);
    // And the row IS in the response — this is a false flag on a listed
    // driver, not a driver the projection dropped.
    expect(rows.some((row) => row.id === lockedInactiveId)).toBe(true);

    // The timestamp itself is not on the wire — not "present but unused".
    expect(rows.find((row) => row.id === lockedId)).not.toHaveProperty('lockedUntil');
    expect(JSON.stringify(rows)).not.toContain('lockedUntil');
  });

  /* ------------------------------------------------------------------ *
   * `unlock` — the lockout half without the PIN half
   * (owner decision 2026-10-23, Q1, option C+E)
   * ------------------------------------------------------------------ */

  describe('unlock', () => {
    /** A live lockout against the REAL clock: `unlock` reads `new Date()`. */
    async function lockOutNow(id: number, minutesLeft = 60) {
      await getDb()
        .update(drivers)
        .set({
          failedAttempts: 5,
          lockedUntil: new Date(Date.now() + minutesLeft * 60_000),
          lockoutCount: 3,
          lockoutWindowStartedAt: new Date(Date.now() - 2 * 3_600_000),
        })
        .where(eq(drivers.id, id));
    }

    async function lockoutColumns(id: number) {
      const [row] = await getDb()
        .select({
          failedAttempts: drivers.failedAttempts,
          lockedUntil: drivers.lockedUntil,
          lockoutCount: drivers.lockoutCount,
          lockoutWindowStartedAt: drivers.lockoutWindowStartedAt,
        })
        .from(drivers)
        .where(eq(drivers.id, id));
      if (!row) throw new Error(`no driver ${id}`);
      return row;
    }

    /**
     * THE TEST THIS MUTATION EXISTS FOR. `resetPin` already cleared a lockout;
     * what it could not do was leave the driver's PIN alone, which is the whole
     * reason a dispatcher ringing a driver at 5am was a bad experience.
     */
    it('clears the lockout and does NOT touch the PIN hash', async () => {
      const id = await makeDriver();
      const before = await pinHashFor(id);
      await lockOutNow(id);

      const api = appRouter.createCaller(staffContext(ownerId, 'owner') as never);
      await expect(api.admin.drivers.unlock({ id })).resolves.toEqual({ ok: true });

      const row = await lockoutColumns(id);
      expect(row.failedAttempts).toBe(0);
      expect(row.lockedUntil).toBeNull();
      expect(await pinHashFor(id), 'unlock changed the PIN hash').toBe(before);
    });

    /**
     * The counters are a fact about the day, not about who ended the lockout.
     * Clearing them would hand an attacker a free reset of the backoff every
     * time a helpful dispatcher unlocked the driver they had just pranked.
     */
    it('leaves the window counters standing, so the backoff keeps its place', async () => {
      const id = await makeDriver();
      await lockOutNow(id);
      const before = await lockoutColumns(id);

      const api = appRouter.createCaller(staffContext(ownerId, 'owner') as never);
      await api.admin.drivers.unlock({ id });

      const after = await lockoutColumns(id);
      expect(after.lockoutCount).toBe(before.lockoutCount);
      expect(after.lockoutWindowStartedAt).toEqual(before.lockoutWindowStartedAt);
    });

    it('REFUSES a driver who is not locked, and changes nothing', async () => {
      const id = await makeDriver();
      const api = appRouter.createCaller(staffContext(ownerId, 'owner') as never);
      await expect(api.admin.drivers.unlock({ id })).rejects.toMatchObject({
        code: 'BAD_REQUEST',
      });
      // No audit row for an unlock that did not happen.
      expect(await auditRowsFor('driver', id)).toEqual([]);
    });

    it('REFUSES a driver whose lockout has already lapsed', async () => {
      const id = await makeDriver();
      // Five minutes in the past: the row still carries `failed_attempts = 5`,
      // but the driver can already sign in, so there is nothing to unlock.
      await lockOutNow(id, -5);
      const api = appRouter.createCaller(staffContext(ownerId, 'owner') as never);
      await expect(api.admin.drivers.unlock({ id })).rejects.toMatchObject({
        code: 'BAD_REQUEST',
      });
      expect((await lockoutColumns(id)).failedAttempts).toBe(5);
    });

    it('answers an unknown id with NOT_FOUND', async () => {
      const api = appRouter.createCaller(staffContext(ownerId, 'owner') as never);
      await expect(api.admin.drivers.unlock({ id: 2_000_000_000 })).rejects.toMatchObject({
        code: 'NOT_FOUND',
      });
    });

    /**
     * Owner decision 2026-10-24, point 3: the row lock filters on
     * `is_active` too, so `unlock` asks the same question the dashboard's
     * `driverLocked` alert asks — a driver off the roster is not a driver the
     * office unlocks; they sign in again by being reactivated.
     *
     * The refusal is the EXISTING `NOT_FOUND`, byte for byte, rather than a
     * distinguishable "exists but is inactive". There is no legitimate reason
     * for this screen to turn a numeric id into an oracle for which drivers
     * exist, and the same reasoning already governs `driverProcedure`'s
     * booking lookup (`CLAUDE.md`, driver portal): one `WHERE`, never a check
     * afterwards.
     */
    it('REFUSES an inactive driver with the SAME refusal an unknown id gets, and changes nothing', async () => {
      const id = await makeDriver();
      await lockOutNow(id);
      await getDb().update(drivers).set({ isActive: false }).where(eq(drivers.id, id));

      const api = appRouter.createCaller(staffContext(ownerId, 'owner') as never);
      const refused = (await api.admin.drivers.unlock({ id }).catch((error: unknown) => error)) as {
        code?: string;
        message?: string;
      };
      const unknown = (await api.admin.drivers
        .unlock({ id: 2_000_000_001 })
        .catch((error: unknown) => error)) as { code?: string; message?: string };

      expect(refused).toMatchObject({ code: 'NOT_FOUND', message: 'No driver with that id.' });
      expect(refused.code).toBe(unknown.code);
      expect(refused.message).toBe(unknown.message);

      // Fails closed: the lockout stands and nothing is logged.
      expect((await lockoutColumns(id)).lockedUntil).not.toBeNull();
      expect(await auditRowsFor('driver', id)).toEqual([]);
    });

    it('writes exactly ONE audit row, naming the staff actor and never a PIN', async () => {
      const id = await makeDriver();
      const hash = await pinHashFor(id);
      await lockOutNow(id);

      const api = appRouter.createCaller(staffContext(ownerId, 'owner') as never);
      await api.admin.drivers.unlock({ id });

      const rows = await auditRowsFor('driver', id);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        action: 'driver.unlocked',
        actorType: 'user',
        actorId: ownerId,
      });
      // `pinReset: false` is the fact that separates this row from
      // `driver_pin_reset` at a glance in the log.
      expect(rows[0]!.data).toMatchObject({ pinReset: false, lockoutCount: 3 });
      const json = JSON.stringify(rows);
      expect(json, 'the audit row carries the PIN hash').not.toContain(hash);
      expect(json).not.toContain('pinHash');
    });

    it('is allowed to a DISPATCHER, like the rest of the vansDrivers area', async () => {
      const id = await makeDriver();
      await lockOutNow(id);
      const api = appRouter.createCaller(staffContext(dispatcherId, 'dispatcher') as never);
      await expect(api.admin.drivers.unlock({ id })).resolves.toEqual({ ok: true });
    });
  });

  /**
   * ALL procedures, live. An earlier version of this test called three
   * of them while being named "every drivers procedure" — the gate was
   * still proven generically by `procedure-role-metadata.test.ts` and
   * `role-isolation.test.ts`, so nothing was unguarded, but the name
   * claimed coverage the body did not have. §9's matrix is a security
   * boundary and `CLAUDE.md` asks for a test per role per area, so the
   * body now matches the name.
   *
   * CHANGED 2026-10-23: `unlock` is the eighth, and it is in here rather than
   * only in `procedure-role-metadata.test.ts` because it clears part of an
   * authentication control — finance must be refused by the gate, not by the
   * resolver finding nothing to do.
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
      api.admin.drivers.unlock({ id: driverId }).catch((e: unknown) => e),
      api.admin.drivers.setActive({ id: driverId, isActive: false }).catch((e: unknown) => e),
      api.admin.drivers.addLeave(VALID_LEAVE).catch((e: unknown) => e),
      api.admin.drivers.removeLeave({ id: 1 }).catch((e: unknown) => e),
    ]);

    // Exactly eight, every one FORBIDDEN — not "at least one refusal".
    expect(refusals).toHaveLength(8);
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

  /*
   * ---------------------------------------------------------------------
   * The derived guide rating (owner-decided 2026-10-15)
   * ---------------------------------------------------------------------
   *
   * DERIVED, never stored. Averaged from `reviews.guide` on published,
   * non-sample reviews of bookings this driver actually drove, and shown only
   * at or above `settings.trust.minReviewsForRating` — the SETTING, read live,
   * not a constant (owner decision 2026-10-23, Q4). The seeded value is 3,
   * which is what every boundary below is written against; the last test in
   * this block is the one that proves the number really comes from the row.
   *
   * The 2 → 3 boundary is the owner's named test, and it is the one that
   * matters: below the threshold the answer is `null`, not a number with a
   * caveat beside it.
   */

  /** A published, non-sample review of `bookingId` with a guide sub-score. */
  async function reviewFor(
    bookingId: number,
    guide: number,
    opts: { status?: 'published' | 'pending' | 'hidden'; isSample?: boolean } = {},
  ) {
    const [row] = await getDb()
      .insert(reviews)
      .values({
        tourId,
        bookingId,
        name: 'Rating Fixture Guest',
        rating: 5,
        guide,
        body: 'Fixture review for the derived driver rating.',
        status: opts.status ?? 'published',
        isSample: opts.isSample ?? false,
      });
    created.reviewIds.push(row.insertId);
    return row.insertId;
  }

  /** A booking this driver drove, so a review of it counts toward them. */
  async function drivenBooking(driverId: number) {
    const id = await makeBooking(tourId, TOUR_DATE);
    await getDb()
      .update(bookings)
      .set({ driverId, status: 'completed' })
      .where(eq(bookings.id, id));
    return id;
  }

  async function ratingOf(driverId: number) {
    const api = appRouter.createCaller(staffContext(ownerId, 'owner') as never);
    const listed = await api.admin.drivers.list();
    const row = listed.find((d) => d.id === driverId);
    if (!row) throw new Error('driver not listed');
    return row.rating;
  }

  it('shows NO rating with two ratings, and a rating with three', async () => {
    const driverId = await makeDriver();
    await reviewFor(await drivenBooking(driverId), 5);
    await reviewFor(await drivenBooking(driverId), 4);

    // TWO: below the threshold, so null — the owner's boundary, lower side.
    expect(await ratingOf(driverId)).toBeNull();

    await reviewFor(await drivenBooking(driverId), 3);

    // THREE: at the threshold, so an average appears. (5+4+3)/3 = 4.
    expect(await ratingOf(driverId)).toEqual({ average: 4, count: 3 });
  });

  it('rounds the average to one decimal place', async () => {
    const driverId = await makeDriver();
    for (const guide of [5, 4, 4]) {
      await reviewFor(await drivenBooking(driverId), guide);
    }
    // 13 / 3 = 4.333… → 4.3, not 4.33 and not 4.
    expect(await ratingOf(driverId)).toEqual({ average: 4.3, count: 3 });
  });

  it('EXCLUDES sample reviews, however many there are', async () => {
    // Seeded reviews are flagged `is_sample`, and CLAUDE.md keeps them out
    // of every rating — a rating built from fixtures is a fabricated number
    // wearing a decimal point.
    const driverId = await makeDriver();
    for (const guide of [5, 5, 5, 5]) {
      await reviewFor(await drivenBooking(driverId), guide, { isSample: true });
    }
    expect(await ratingOf(driverId)).toBeNull();
  });

  it('EXCLUDES unpublished reviews', async () => {
    const driverId = await makeDriver();
    await reviewFor(await drivenBooking(driverId), 5, { status: 'pending' });
    await reviewFor(await drivenBooking(driverId), 5, { status: 'hidden' });
    await reviewFor(await drivenBooking(driverId), 5);
    // Only one of the three counts, so still below the threshold.
    expect(await ratingOf(driverId)).toBeNull();
  });

  it('counts only reviews of trips THIS driver drove', async () => {
    const mine = await makeDriver();
    const theirs = await makeDriver();
    for (const guide of [5, 5, 5]) {
      await reviewFor(await drivenBooking(theirs), guide);
    }
    // Three ratings exist, none of them on a trip `mine` drove.
    expect(await ratingOf(mine)).toBeNull();
    expect(await ratingOf(theirs)).toEqual({ average: 5, count: 3 });
  });

  it('ignores a review that rated the trip but not the guide', async () => {
    const driverId = await makeDriver();
    const bookingId = await drivenBooking(driverId);
    const [row] = await getDb().insert(reviews).values({
      tourId,
      bookingId,
      name: 'No Guide Score',
      rating: 5,
      guide: null,
      body: 'Rated the trip, said nothing about the guide.',
      status: 'published',
      isSample: false,
    });
    created.reviewIds.push(row.insertId);
    for (const guide of [4, 4]) {
      await reviewFor(await drivenBooking(driverId), guide);
    }
    // Three published reviews, but only two said anything about the guide.
    expect(await ratingOf(driverId)).toBeNull();
  });

  /**
   * **The threshold is read from `settings.trust.minReviewsForRating`, not
   * hardcoded** (owner decision 2026-10-23, Q4). It used to be a standalone
   * shared constant, written in Week 6 before that decision existed — so an
   * admin lowering the public tour cards' threshold left this screen quoting
   * the old number.
   *
   * Two ratings is below the seeded 3 and at the edited 2, so the SAME driver
   * answers `null` and then a number with nothing but the settings row
   * changing. The row is restored in `finally`, because every other test in
   * this file is written against the seeded value.
   */
  it('reads the threshold from settings.trust rather than a hardcoded 3', async () => {
    const driverId = await makeDriver();
    await reviewFor(await drivenBooking(driverId), 5);
    await reviewFor(await drivenBooking(driverId), 3);

    expect(await ratingOf(driverId), 'two ratings is below the seeded threshold').toBeNull();

    const db = getDb();
    const [trustRow] = await db.select().from(settingsTable).where(eq(settingsTable.key, 'trust'));
    expect(trustRow).toBeDefined();
    const originalValue = trustRow!.value;

    await db
      .update(settingsTable)
      .set({ value: { ...(originalValue as Record<string, unknown>), minReviewsForRating: 2 } })
      .where(eq(settingsTable.key, 'trust'));

    try {
      expect(
        await ratingOf(driverId),
        'the threshold is hardcoded — editing the setting changed nothing',
      ).toEqual({ average: 4, count: 2 });
    } finally {
      await db
        .update(settingsTable)
        .set({ value: originalValue })
        .where(eq(settingsTable.key, 'trust'));
    }

    // And back to null once the setting is back where it was.
    expect(await ratingOf(driverId)).toBeNull();
  });

  it('never stores the rating on the driver row', async () => {
    // Derived, so there is nothing to drift. If a column ever appears, this
    // fails and the decision gets revisited deliberately.
    const schema = await import('../db/schema');
    const columns = Object.keys(schema.drivers);
    expect(columns.filter((c) => /rating/i.test(c))).toEqual([]);
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

  /*
   * `admin.drivers.setActive` — Week 6.5 Task 4 (D4). The end-to-end session
   * story (a real cookie, over HTTP) is `driver-deactivation.test.ts`; this
   * block owns the procedure's own contract: who may call it, what it
   * audits, what it refuses, and that a refusal changes nothing.
   *
   * Every test makes its OWN driver: the writes under test flip `is_active`,
   * and a shared fixture would leak that state into the next test.
   */
  describe('setActive', () => {
    const NOW = new Date('2026-10-15T04:00:00Z');

    async function stateOf(id: number) {
      const [row] = await getDb()
        .select({ isActive: drivers.isActive })
        .from(drivers)
        .where(eq(drivers.id, id));
      const held = await getDb()
        .select({ id: sessions.id })
        .from(sessions)
        .where(and(eq(sessions.subjectType, 'driver'), eq(sessions.subjectId, id)));
      return { isActive: row?.isActive, sessionRows: held.length };
    }

    /** A driver who is active and signed in, so a refusal has something to leave alone. */
    async function signedInDriver() {
      const id = await makeDriver();
      const { token } = await createSession('driver', id, NOW);
      return { id, token };
    }

    it('ALLOWS the owner: deactivates and ends the sessions', async () => {
      const { id, token } = await signedInDriver();
      const api = appRouter.createCaller(staffContext(ownerId, 'owner') as never);

      await expect(api.admin.drivers.setActive({ id, isActive: false })).resolves.toEqual({
        ok: true,
      });

      expect(await stateOf(id)).toEqual({ isActive: false, sessionRows: 0 });
      expect(await readSession(token, NOW)).toBeNull();
    });

    it('ALLOWS the dispatcher: the same area, the same power', async () => {
      const { id } = await signedInDriver();
      const api = appRouter.createCaller(staffContext(dispatcherId, 'dispatcher') as never);

      await expect(api.admin.drivers.setActive({ id, isActive: false })).resolves.toEqual({
        ok: true,
      });

      expect(await stateOf(id)).toEqual({ isActive: false, sessionRows: 0 });
    });

    it('REFUSES finance with FORBIDDEN and leaves the driver and their sessions untouched', async () => {
      const { id, token } = await signedInDriver();
      const api = appRouter.createCaller(staffContext(financeId, 'finance') as never);

      await expect(api.admin.drivers.setActive({ id, isActive: false })).rejects.toMatchObject({
        code: 'FORBIDDEN',
      });

      expect(await stateOf(id)).toEqual({ isActive: true, sessionRows: 1 });
      expect(await readSession(token, NOW)).not.toBeNull();
      expect(await auditRowsFor('driver', id)).toEqual([]);
    });

    it('REFUSES a driver session with UNAUTHORIZED: a driver cannot deactivate anyone, even themselves', async () => {
      const { id, token } = await signedInDriver();

      await expect(
        driverCaller(id).admin.drivers.setActive({ id, isActive: false }),
      ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });

      expect(await stateOf(id)).toEqual({ isActive: true, sessionRows: 1 });
      expect(await readSession(token, NOW)).not.toBeNull();
      expect(await auditRowsFor('driver', id)).toEqual([]);
    });

    it('REFUSES an anonymous caller with UNAUTHORIZED and changes nothing', async () => {
      const { id, token } = await signedInDriver();
      const api = appRouter.createCaller(testContext(null) as never);

      await expect(api.admin.drivers.setActive({ id, isActive: false })).rejects.toMatchObject({
        code: 'UNAUTHORIZED',
      });

      expect(await stateOf(id)).toEqual({ isActive: true, sessionRows: 1 });
      expect(await readSession(token, NOW)).not.toBeNull();
      expect(await auditRowsFor('driver', id)).toEqual([]);
    });

    it('REFUSES a customer session with UNAUTHORIZED', async () => {
      const { id } = await signedInDriver();
      const api = appRouter.createCaller(
        testContext({ subjectType: 'customer', subjectId: bookingId }) as never,
      );

      await expect(api.admin.drivers.setActive({ id, isActive: false })).rejects.toMatchObject({
        code: 'UNAUTHORIZED',
      });

      expect(await stateOf(id)).toEqual({ isActive: true, sessionRows: 1 });
    });

    it('writes one dotted audit row per change, naming the actor, the code and the count', async () => {
      const { id } = await signedInDriver();
      await createSession('driver', id, NOW);
      const api = appRouter.createCaller(staffContext(dispatcherId, 'dispatcher') as never);

      await api.admin.drivers.setActive({ id, isActive: false });
      await api.admin.drivers.setActive({ id, isActive: true });

      const rows = await auditRowsFor('driver', id);
      expect(rows).toHaveLength(2);
      expect(rows[0]).toMatchObject({
        action: 'driver.deactivated',
        actorType: 'user',
        actorId: dispatcherId,
        data: { isActive: false, sessionsRevoked: 2 },
      });
      expect(rows[1]).toMatchObject({
        action: 'driver.reactivated',
        actorType: 'user',
        actorId: dispatcherId,
        data: { isActive: true, sessionsRevoked: 0 },
      });
      // The code is the stable human label: the audit page can say WHICH
      // driver without a join that a later rename would break.
      expect((rows[0]?.data as { code: string }).code).toMatch(/^ADD/);
    });

    it('never puts the PIN hash in the audit row', async () => {
      const { id } = await signedInDriver();
      await appRouter
        .createCaller(staffContext(ownerId, 'owner') as never)
        .admin.drivers.setActive({ id, isActive: false });
      const [row] = await auditRowsFor('driver', id);
      expect(JSON.stringify(row?.data)).not.toContain('fixture_not_a_pin_hash');
      expect(JSON.stringify(row?.data)).not.toMatch(/pin/i);
    });

    it('answers NOT_FOUND for a driver that does not exist, and audits nothing', async () => {
      const api = appRouter.createCaller(staffContext(ownerId, 'owner') as never);
      const missing = 2_000_000_000;
      // Hermetic: a broken build that audits a missing driver would leave a
      // row behind (there is no fixture row to hang cleanup on), so this test
      // clears its own id first and last rather than inheriting the damage.
      const clear = () =>
        getDb()
          .delete(auditLog)
          .where(and(eq(auditLog.entity, 'driver'), eq(auditLog.entityId, missing)));
      await clear();
      await expect(
        api.admin.drivers.setActive({ id: missing, isActive: false }),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
      const leftBehind = await auditRowsFor('driver', missing);
      await clear();
      expect(leftBehind).toEqual([]);
    });

    it('refuses malformed input at the Zod boundary and changes nothing', async () => {
      const { id } = await signedInDriver();
      const api = appRouter.createCaller(staffContext(ownerId, 'owner') as never);

      // `.strict()`: an extra key is a refusal, not silently ignored, so a
      // caller cannot smuggle a second column through this endpoint.
      await expect(
        api.admin.drivers.setActive({ id, isActive: false, name: 'x' } as never),
      ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
      // A truthy string is not a boolean.
      await expect(
        api.admin.drivers.setActive({ id, isActive: 'false' } as never),
      ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
      await expect(api.admin.drivers.setActive({ id: 0, isActive: false })).rejects.toMatchObject({
        code: 'BAD_REQUEST',
      });

      expect(await stateOf(id)).toEqual({ isActive: true, sessionRows: 1 });
    });

    it('reactivation restores the roster but resurrects no session', async () => {
      const { id, token } = await signedInDriver();
      const api = appRouter.createCaller(staffContext(ownerId, 'owner') as never);

      await api.admin.drivers.setActive({ id, isActive: false });
      await api.admin.drivers.setActive({ id, isActive: true });

      expect(await stateOf(id)).toEqual({ isActive: true, sessionRows: 0 });
      expect(await readSession(token, NOW)).toBeNull();
    });

    it('lists the driver as inactive after deactivation', async () => {
      const { id } = await signedInDriver();
      const api = appRouter.createCaller(staffContext(ownerId, 'owner') as never);
      await api.admin.drivers.setActive({ id, isActive: false });
      const listed = await api.admin.drivers.list();
      expect(listed.find((d) => d.id === id)?.isActive).toBe(false);
    });
  });

  it('ALLOWS dispatcher and owner to list drivers', async () => {
    for (const role of ['owner', 'dispatcher'] as const) {
      const api = appRouter.createCaller(staffContext(idFor(role), role) as never);
      await expect(api.admin.drivers.list()).resolves.toBeInstanceOf(Array);
    }
  });
});
