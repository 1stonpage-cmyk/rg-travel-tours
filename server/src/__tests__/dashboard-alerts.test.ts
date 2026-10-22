/**
 * Week 5, Task 13: BUILD_SPEC §9's five dashboard alerts.
 *
 * The owner named the 48-hour boundary tests (Q7, 2026-10-14) and the reason
 * they are named is that a timezone slip here is invisible: every assertion
 * passes in UTC+0 and the alert is wrong by a tour day in Manila. `atManila`
 * builds a fixed instant from a civil date and a Manila wall-clock time, so
 * these cases do not drift with the day the suite happens to run.
 *
 * `now` is passed in rather than read from the clock (controller Ruling 2) —
 * which is the only reason a boundary test can sit ON the boundary.
 */
import { afterAll, afterEach, beforeAll, expect, it } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import {
  PAPERS_EXPIRING_DAYS,
  SERVICE_DUE_DAYS,
  UNASSIGNED_ALERT_HOURS,
  manilaInstant,
  type DashboardAlert,
  type PriceSnapshot,
} from '@rg/shared';
import { appRouter } from '../routers/_app';
import { getDb, getPool } from '../db/client';
import { bookings, destinations, drivers, payments, tours, users, vans } from '../db/schema';
import { generateBookingRef } from '../services/booking-ref';
import { dashboardAlerts } from '../services/dispatch/alerts';
import { staffContext } from './helpers/ctx';
import { describeWithDb } from './helpers/db';

const created = {
  userIds: [] as number[],
  vanIds: [] as number[],
  driverIds: [] as number[],
  bookingIds: [] as number[],
  paymentIds: [] as number[],
  tourIds: [] as number[],
  destIds: [] as number[],
};

const unique = () => `${Math.floor(Math.random() * 1e9)}_${Date.now()}`;

/** A fixed instant from a Manila wall-clock time — never the test runner's clock. */
const atManila = (civilDate: string, hhmm: string) => manilaInstant(civilDate, hhmm);

/** Manila "now" for every test that does not care about the boundary. */
const NOW = atManila('2026-11-10', '08:00');

function plusDays(civilDate: string, days: number): string {
  const [y, m, d] = civilDate.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

const TODAY = '2026-11-10';
const asDate = (civilDate: string) => new Date(`${civilDate}T00:00:00Z`);

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

let ownerId = 0;
let dispatcherId = 0;
let financeId = 0;
let tourId = 0;

async function makeStaff(role: 'owner' | 'dispatcher' | 'finance') {
  const suffix = unique();
  const [row] = await getDb()
    .insert(users)
    .values({
      name: `Dash ${role} ${suffix}`,
      email: `dash_${role}_${suffix}@example.test`,
      passwordHash: '__dash_fixture_not_a_hash__',
      role,
      isActive: true,
    });
  created.userIds.push(row.insertId);
  return row.insertId;
}

async function makeVan(opts: {
  status?: 'available' | 'for_repair' | 'parked' | 'on_trip';
  isActive?: boolean;
  nextService?: string | null;
  orcrExpiry?: string | null;
  franchiseExpiry?: string | null;
  repairNotes?: string | null;
}) {
  const suffix = unique();
  const [van] = await getDb()
    .insert(vans)
    .values({
      plate: `DSH${suffix}`.slice(0, 20),
      model: 'Dashboard Fixture Van',
      capacity: 10,
      status: opts.status ?? 'available',
      isActive: opts.isActive ?? true,
      nextService: opts.nextService ? asDate(opts.nextService) : null,
      orcrExpiry: opts.orcrExpiry ? asDate(opts.orcrExpiry) : null,
      franchiseExpiry: opts.franchiseExpiry ? asDate(opts.franchiseExpiry) : null,
      repairNotes: opts.repairNotes ?? null,
    });
  created.vanIds.push(van.insertId);
  return van.insertId;
}

async function makeDriver(opts: { licenseExpiry?: string | null; isActive?: boolean } = {}) {
  const suffix = unique();
  const [driver] = await getDb()
    .insert(drivers)
    .values({
      name: `Dash Driver ${suffix}`,
      code: `DSH${suffix}`.slice(0, 20),
      phone: '09170000000',
      pinHash: '__dash_fixture_not_a_pin_hash__',
      isActive: opts.isActive ?? true,
      licenseExpiry: opts.licenseExpiry ? asDate(opts.licenseExpiry) : null,
    });
  created.driverIds.push(driver.insertId);
  return driver.insertId;
}

async function makeBooking(opts: {
  tourDate: string;
  status?: 'confirmed' | 'assigned' | 'pending_payment' | 'pending_verification' | 'cancelled';
  vanId?: number | null;
  driverId?: number | null;
}) {
  const [booking] = await getDb()
    .insert(bookings)
    .values({
      ref: generateBookingRef(),
      tourId,
      tourDate: asDate(opts.tourDate),
      pax: 2,
      leadName: 'Dashboard Fixture',
      leadEmail: 'fixture@example.test',
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

async function makeManualPendingPayment(bookingId: number) {
  const [payment] = await getDb().insert(payments).values({
    bookingId,
    type: 'payment',
    provider: 'manual',
    method: 'bank_transfer',
    amountCentavos: 100000,
    status: 'pending',
  });
  created.paymentIds.push(payment.insertId);
  return payment.insertId;
}

/** The alerts as the service computes them, at a chosen Manila instant. */
async function callAlerts(opts: { now?: Date } = {}): Promise<DashboardAlert[]> {
  return await getDb().transaction((tx) => dashboardAlerts(tx, opts.now ?? NOW));
}

const alertFor = (alerts: DashboardAlert[], kind: string) => {
  const found = alerts.find((a) => a.kind === kind);
  if (!found) throw new Error(`no alert of kind ${kind}`);
  return found;
};

describeWithDb('vans', () => {
  beforeAll(async () => {
    ownerId = await makeStaff('owner');
    dispatcherId = await makeStaff('dispatcher');
    financeId = await makeStaff('finance');

    const db = getDb();
    const slug = `__dash__${unique()}`;
    const [destination] = await db.insert(destinations).values({ name: slug, slug });
    created.destIds.push(destination.insertId);
    const [tour] = await db.insert(tours).values({
      slug,
      title: 'Dashboard Fixture Tour',
      destinationId: destination.insertId,
      groupsPerDay: 5,
      isActive: true,
    });
    tourId = tour.insertId;
    created.tourIds.push(tourId);
  });

  /*
   * Per-test teardown of everything except the staff and the tour, because
   * these alerts COUNT rows and one leftover changes another test's number.
   * The suite-wide leak detector catches what this misses.
   */
  afterEach(async () => {
    const pool = getPool();
    for (const id of created.paymentIds) {
      await pool.query('DELETE FROM payments WHERE id = ?', [id]);
    }
    created.paymentIds.length = 0;
    for (const id of created.bookingIds) {
      await pool.query('DELETE FROM bookings WHERE id = ?', [id]);
    }
    created.bookingIds.length = 0;
    for (const id of created.vanIds) await pool.query('DELETE FROM vans WHERE id = ?', [id]);
    created.vanIds.length = 0;
    for (const id of created.driverIds) {
      // `setActive` audits; the audit rows go with the driver they describe.
      await pool.query("DELETE FROM audit_log WHERE entity = 'driver' AND entity_id = ?", [id]);
      await pool.query('DELETE FROM sessions WHERE subject_type = ? AND subject_id = ?', [
        'driver',
        id,
      ]);
      await pool.query('DELETE FROM drivers WHERE id = ?', [id]);
    }
    created.driverIds.length = 0;
  });

  afterAll(async () => {
    const pool = getPool();
    for (const id of created.tourIds) await pool.query('DELETE FROM tours WHERE id = ?', [id]);
    for (const id of created.destIds) {
      await pool.query('DELETE FROM destinations WHERE id = ?', [id]);
    }
    if (created.userIds.length > 0) {
      await getDb().delete(users).where(inArray(users.id, created.userIds));
    }
  });

  it('always returns all five alerts, including the empty ones', async () => {
    const alerts = await callAlerts();
    expect(alerts.map((a) => a.kind).sort()).toEqual([
      'papers_expiring',
      'payments_to_verify',
      'service_due',
      'unassigned_soon',
      'vans_in_repair',
    ]);
    expect(alerts.every((a) => typeof a.count === 'number')).toBe(true);
  });

  it('counts a confirmed trip inside the window with no driver', async () => {
    const vanId = await makeVan({});
    await makeBooking({ tourDate: plusDays(TODAY, 1), vanId, driverId: null });
    expect(alertFor(await callAlerts(), 'unassigned_soon').count).toBe(1);
  });

  it('counts a trip with a driver but NO van — OR, not AND', async () => {
    const driverId = await makeDriver();
    await makeBooking({ tourDate: plusDays(TODAY, 1), vanId: null, driverId });
    expect(alertFor(await callAlerts(), 'unassigned_soon').count).toBe(1);
  });

  it('does NOT count a fully staffed trip', async () => {
    const vanId = await makeVan({});
    const driverId = await makeDriver();
    await makeBooking({ tourDate: plusDays(TODAY, 1), status: 'assigned', vanId, driverId });
    expect(alertFor(await callAlerts(), 'unassigned_soon').count).toBe(0);
  });

  it('does NOT count an unpaid hold as an unassigned trip', async () => {
    await makeBooking({ tourDate: plusDays(TODAY, 1), status: 'pending_payment' });
    await makeBooking({ tourDate: plusDays(TODAY, 1), status: 'pending_verification' });
    expect(alertFor(await callAlerts(), 'unassigned_soon').count).toBe(0);
  });

  /* ---- D4: a deactivated driver's future trips need assigning (2026-10-16) ---- */

  /** Deactivates through the real procedure, so the alert is tested against the real write. */
  const deactivate = (driverId: number) =>
    appRouter
      .createCaller(staffContext(ownerId, 'owner') as never)
      .admin.drivers.setActive({ id: driverId, isActive: false });

  it('counts an ASSIGNED trip whose driver has been deactivated', async () => {
    const vanId = await makeVan({});
    const driverId = await makeDriver();
    await makeBooking({ tourDate: plusDays(TODAY, 1), status: 'assigned', vanId, driverId });
    expect(alertFor(await callAlerts(), 'unassigned_soon').count).toBe(0);

    await deactivate(driverId);

    expect(alertFor(await callAlerts(), 'unassigned_soon').count).toBe(1);
  });

  it('counts a CONFIRMED trip whose driver was deactivated, once and not twice', async () => {
    // Confirmed with both ids set is not a state assignment produces, but a
    // hand edit can; it must count once however many terms match.
    const vanId = await makeVan({});
    const driverId = await makeDriver({ isActive: false });
    await makeBooking({ tourDate: plusDays(TODAY, 1), status: 'confirmed', vanId, driverId });
    expect(alertFor(await callAlerts(), 'unassigned_soon').count).toBe(1);
  });

  it('keeps bookings.driver_id on deactivation: the alert reads the driver, not the column', async () => {
    const vanId = await makeVan({});
    const driverId = await makeDriver();
    const bookingId = await makeBooking({
      tourDate: plusDays(TODAY, 1),
      status: 'assigned',
      vanId,
      driverId,
    });
    await deactivate(driverId);
    const [row] = await getDb()
      .select({ driverId: bookings.driverId, status: bookings.status })
      .from(bookings)
      .where(eq(bookings.id, bookingId));
    expect(row).toEqual({ driverId, status: 'assigned' });
  });

  it('does NOT count a deactivated driver’s trip that already departed, or lies past 48 hours', async () => {
    const vanId = await makeVan({});
    const driverId = await makeDriver({ isActive: false });
    await makeBooking({ tourDate: plusDays(TODAY, -1), status: 'assigned', vanId, driverId });
    await makeBooking({ tourDate: plusDays(TODAY, 5), status: 'assigned', vanId, driverId });
    expect(alertFor(await callAlerts(), 'unassigned_soon').count).toBe(0);
  });

  it('does NOT count a deactivated driver’s cancelled or unpaid trips', async () => {
    const vanId = await makeVan({});
    const driverId = await makeDriver({ isActive: false });
    // The widening is to `assigned` and nothing else: a trip that is cancelled
    // or still unpaid is not something a dispatcher can assign.
    await makeBooking({ tourDate: plusDays(TODAY, 1), status: 'cancelled', vanId, driverId });
    await makeBooking({ tourDate: plusDays(TODAY, 1), status: 'pending_payment', vanId, driverId });
    expect(alertFor(await callAlerts(), 'unassigned_soon').count).toBe(0);
  });

  it('changes NO count on a healthy fleet: widening the status filter only admits the inactive-driver case', async () => {
    const vanA = await makeVan({});
    const vanB = await makeVan({});
    const driverA = await makeDriver();
    const driverB = await makeDriver();
    // Fully staffed, both statuses, all with ACTIVE drivers: none may count.
    await makeBooking({ tourDate: TODAY, status: 'assigned', vanId: vanA, driverId: driverA });
    await makeBooking({
      tourDate: plusDays(TODAY, 1),
      status: 'assigned',
      vanId: vanB,
      driverId: driverB,
    });
    await makeBooking({
      tourDate: plusDays(TODAY, 2),
      status: 'confirmed',
      vanId: vanA,
      driverId: driverA,
    });
    // ...and the same two original cases still count exactly as before.
    await makeBooking({ tourDate: TODAY, status: 'confirmed', vanId: vanA, driverId: null });
    await makeBooking({
      tourDate: plusDays(TODAY, 1),
      status: 'confirmed',
      vanId: null,
      driverId: driverB,
    });

    expect(alertFor(await callAlerts(), 'unassigned_soon').count).toBe(2);
  });

  it('still counts a confirmed trip with NO driver (the left join must not drop it)', async () => {
    const vanId = await makeVan({});
    await makeBooking({ tourDate: plusDays(TODAY, 1), status: 'confirmed', vanId, driverId: null });
    await makeBooking({ tourDate: plusDays(TODAY, 1), status: 'assigned', vanId, driverId: null });
    expect(alertFor(await callAlerts(), 'unassigned_soon').count).toBe(2);
  });

  /* ---- Q7: the boundary, in Manila time (owner-decided 2026-10-14) ---- */

  it('counts a trip just INSIDE 48 hours, Manila', async () => {
    // Manila "now" 2026-11-10 08:00; a tour on the 12th is inside the window.
    await makeBooking({ tourDate: '2026-11-12', vanId: null, driverId: null });
    expect(
      alertFor(await callAlerts({ now: atManila('2026-11-10', '08:00') }), 'unassigned_soon').count,
    ).toBe(1);
  });

  it('does NOT count a trip just OUTSIDE 48 hours, Manila', async () => {
    await makeBooking({ tourDate: '2026-11-13', vanId: null, driverId: null });
    expect(
      alertFor(await callAlerts({ now: atManila('2026-11-10', '08:00') }), 'unassigned_soon').count,
    ).toBe(0);
  });

  it('does not shift the boundary across Manila midnight', async () => {
    /*
     * 23:30 Manila on the 10th is 15:30 UTC on the 10th. A UTC-based window
     * would place "now" on a different civil day and move the boundary by a
     * whole tour date. The 12th must still be inside; the 13th must not.
     */
    await makeBooking({ tourDate: '2026-11-12', vanId: null, driverId: null });
    await makeBooking({ tourDate: '2026-11-13', vanId: null, driverId: null });
    expect(
      alertFor(await callAlerts({ now: atManila('2026-11-10', '23:30') }), 'unassigned_soon').count,
    ).toBe(1);
  });

  it('counts a trip departing TODAY that is still unstaffed', async () => {
    // The most urgent case, and the one a strict `> now` window drops.
    await makeBooking({ tourDate: '2026-11-10', vanId: null, driverId: null });
    expect(
      alertFor(await callAlerts({ now: atManila('2026-11-10', '06:00') }), 'unassigned_soon').count,
    ).toBe(1);
  });

  /**
   * THE TEST THE OTHER FOUR WERE MISSING, found by mutation (2026-10-15).
   *
   * Substituting a UTC window — `new Date(now + days * 86_400_000)` instead
   * of Manila calendar arithmetic — left every one of the four boundary
   * tests above GREEN. The reason is that Manila is UTC+8, so the two agree
   * whenever the Manila wall clock reads 08:00 or later: 08:00 and 23:30
   * Manila are both still the same UTC calendar day.
   *
   * They diverge only between **00:00 and 07:59 Manila**, which is UTC's
   * previous day — and that is exactly when a dispatcher checks the board.
   * At 06:00 Manila a UTC window ends a day EARLY, so the far edge of the
   * 48 hours silently drops out of the count on the morning it matters
   * most.
   *
   * So this test sits at 06:00 and asserts the FAR EDGE, not the near one.
   * The four above assert the right boundary at the wrong hour; this one
   * puts the hour and the edge together.
   */
  it('keeps the far edge of the window at 06:00 Manila, when UTC is still yesterday', async () => {
    const now = atManila('2026-11-10', '06:00');
    // 06:00 Manila on the 10th is 22:00 UTC on the NINTH. A UTC-based
    // window would end on the 11th and lose this trip.
    await makeBooking({ tourDate: '2026-11-12', vanId: null, driverId: null });
    expect(alertFor(await callAlerts({ now }), 'unassigned_soon').count).toBe(1);
  });

  it('does NOT count a trip that already departed unstaffed', async () => {
    // Yesterday is not something a dispatcher can fix, and leaving it in
    // makes the number grow forever.
    await makeBooking({ tourDate: '2026-11-09', vanId: null, driverId: null });
    expect(
      alertFor(await callAlerts({ now: atManila('2026-11-10', '08:00') }), 'unassigned_soon').count,
    ).toBe(0);
  });

  /* ---- the fleet-paperwork alerts ---- */

  it('counts a van whose service is due inside the window, and not one past it', async () => {
    await makeVan({ nextService: plusDays(TODAY, SERVICE_DUE_DAYS) });
    await makeVan({ nextService: plusDays(TODAY, SERVICE_DUE_DAYS + 1) });
    const alert = alertFor(await callAlerts(), 'service_due');
    expect(alert.count).toBe(1);
    expect(alert.examples).toHaveLength(1);
  });

  it('counts an OVERDUE service as well as an upcoming one', async () => {
    // A van whose service date has passed is more urgent, not less. A naive
    // BETWEEN(today, today+14) silently drops it.
    await makeVan({ nextService: plusDays(TODAY, -3) });
    expect(alertFor(await callAlerts(), 'service_due').count).toBe(1);
  });

  it('counts a van in repair, and names the reason if there is one', async () => {
    await makeVan({ status: 'for_repair', repairNotes: 'Clutch' });
    const alert = alertFor(await callAlerts(), 'vans_in_repair');
    expect(alert.count).toBe(1);
    expect(alert.examples[0]!.label).toMatch(/Clutch/);
  });

  it('counts licence, OR/CR and franchise expiries in one alert', async () => {
    await makeDriver({ licenseExpiry: plusDays(TODAY, 10) });
    await makeVan({ orcrExpiry: plusDays(TODAY, 20) });
    await makeVan({ franchiseExpiry: plusDays(TODAY, PAPERS_EXPIRING_DAYS - 1) });
    expect(alertFor(await callAlerts(), 'papers_expiring').count).toBe(3);
  });

  it('counts a van needing TWO documents once, naming both', async () => {
    // §9's alert counts things to chase. Counting documents would tell the
    // operator to chase one van twice.
    await makeVan({ orcrExpiry: plusDays(TODAY, 5), franchiseExpiry: plusDays(TODAY, 6) });
    const alert = alertFor(await callAlerts(), 'papers_expiring');
    expect(alert.count).toBe(1);
    expect(alert.examples[0]!.label).toMatch(/OR\/CR and franchise/);
  });

  it('ignores an inactive van and an inactive driver everywhere', async () => {
    await makeVan({
      status: 'for_repair',
      isActive: false,
      nextService: plusDays(TODAY, 1),
      orcrExpiry: plusDays(TODAY, 1),
    });
    await makeDriver({ licenseExpiry: plusDays(TODAY, 1), isActive: false });
    const alerts = await callAlerts();
    expect(alertFor(alerts, 'vans_in_repair').count).toBe(0);
    expect(alertFor(alerts, 'service_due').count).toBe(0);
    expect(alertFor(alerts, 'papers_expiring').count).toBe(0);
  });

  it('caps examples at five however many rows match', async () => {
    for (let i = 0; i < 9; i += 1) await makeVan({ status: 'for_repair' });
    const alert = alertFor(await callAlerts(), 'vans_in_repair');
    expect(alert.count).toBe(9);
    expect(alert.examples).toHaveLength(5);
  });

  /* ---- payments to verify ---- */

  it('counts a booking with a pending manual receipt', async () => {
    const bookingId = await makeBooking({
      tourDate: plusDays(TODAY, 5),
      status: 'pending_verification',
    });
    await makeManualPendingPayment(bookingId);
    expect(alertFor(await callAlerts(), 'payments_to_verify').count).toBe(1);
  });

  it('counts a booking with TWO pending receipts once', async () => {
    // A guest who uploaded twice is one trip needing one decision.
    const bookingId = await makeBooking({
      tourDate: plusDays(TODAY, 5),
      status: 'pending_verification',
    });
    await makeManualPendingPayment(bookingId);
    await makeManualPendingPayment(bookingId);
    expect(alertFor(await callAlerts(), 'payments_to_verify').count).toBe(1);
  });

  /* ---- the thresholds, and the roles ---- */

  it('reads its thresholds from /shared, so the screen cannot disagree', () => {
    expect(UNASSIGNED_ALERT_HOURS).toBe(48);
    expect(SERVICE_DUE_DAYS).toBe(14);
    expect(PAPERS_EXPIRING_DAYS).toBe(30);
  });

  it('is readable by all three roles — §9 gives Dashboard to everyone', async () => {
    for (const [role, id] of [
      ['owner', ownerId],
      ['dispatcher', dispatcherId],
      ['finance', financeId],
    ] as const) {
      const api = appRouter.createCaller(staffContext(id, role) as never);
      await expect(api.admin.dashboard.alerts()).resolves.toHaveLength(5);
    }
  });

  it('IGNORES any client-supplied time, so nobody can move the alert window', async () => {
    /*
     * An earlier version of this test expected a supplied `now` to be
     * REJECTED. It is not: a tRPC procedure with no `.input()` validator
     * silently ignores extra input rather than throwing. The security
     * property is the same and the test now asserts the real mechanism
     * rather than a guessed one — ignoring is in fact the stronger
     * behaviour, because there is no parsing step to get wrong.
     *
     * Why it matters: the 48-hour window decides which unstaffed trips an
     * operator is warned about. A client that could pass `now` could make
     * the count say anything — including zero, on the morning it mattered.
     */
    const api = appRouter.createCaller(staffContext(ownerId, 'owner') as never);
    const vanId = await makeVan({});
    await makeBooking({ tourDate: plusDays(TODAY, 1), vanId, driverId: null });

    const honest = await api.admin.dashboard.alerts();
    const withSuppliedTime = await (
      api.admin.dashboard as unknown as { alerts: (i: unknown) => Promise<DashboardAlert[]> }
    ).alerts({ now: '2030-01-01T00:00:00Z' });

    // Same answer, and specifically the SERVER's answer — a 2030 clock
    // would have put today's trip far outside the window.
    expect(withSuppliedTime).toEqual(honest);
  });

  it('refuses a caller with no session', async () => {
    const api = appRouter.createCaller({} as never);
    await expect(api.admin.dashboard.alerts()).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  });
});
