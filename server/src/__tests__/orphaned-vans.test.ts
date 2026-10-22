/**
 * Week 6.5, Task 5 (owner decision D5, 2026-10-16): a daily LOOK at vans left
 * `on_trip` by a trip nobody completed — and, just as importantly, a proof
 * that the look never touches them.
 *
 * `vans.status` is not date-scoped, so such a van is refused on every future
 * date at once. The owner chose to make the state visible (a dashboard alert
 * and a 07:00 Manila log line) and explicitly NOT to free the van
 * automatically: on the day a trip genuinely overruns past midnight, a sweep
 * would put a van with guests in it back on sale.
 *
 * The orphan is built the way it happens: a real `startTrip` (which sets
 * `on_trip`), then the booking is moved on WITHOUT the van being released,
 * written directly because no code path produces it. That is the gap.
 *
 * The test database keeps an EMPTY fleet, asserted in `beforeEach` exactly as
 * `trip-van-status.test.ts` does, so `found: 0` below means the fleet is
 * healthy rather than that someone else's rows are absent.
 *
 * This file never imports `jobs/index.ts` (it would start a scheduler); the
 * job is called directly with an explicit `now`, like `expireHolds`.
 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import type { PriceSnapshot } from '@rg/shared';
import { getDb, getPool } from '../db/client';
import { bookings, destinations, drivers, tours, vans } from '../db/schema';
import { checkOrphanedVans } from '../jobs/orphaned-vans';
import { generateBookingRef } from '../services/booking-ref';
import { orphanedOnTripVans } from '../services/dispatch/alerts';
import { vansFreeOn } from '../services/dispatch/availability';
import { driverCaller } from './helpers/ctx';
import { describeWithDb } from './helpers/db';

const unique = () => `${Math.floor(Math.random() * 1e9)}_${Date.now()}`;

const SNAPSHOT: PriceSnapshot = {
  tier: { tierId: 1, minPax: 1, maxPax: 12, pricePerPersonCentavos: 100000 },
  addons: [],
  coupon: null,
  depositPercent: 30,
  freeCancelHours: 48,
  subtotalCentavos: 400000,
  discountCentavos: 0,
  totalCentavos: 400000,
};

const NOW = new Date('2026-11-10T07:00:00+08:00');

const created = {
  bookingIds: [] as number[],
  tourIds: [] as number[],
  destIds: [] as number[],
  vanIds: [] as number[],
  driverIds: [] as number[],
};

let TOUR_DATE = '';
let FUTURE_DATE = '';
let tourId = 0;

async function count(statement: Parameters<ReturnType<typeof getDb>['execute']>[0]) {
  const [rows] = (await getDb().execute(statement)) as unknown as [Array<{ n: number }>, unknown];
  return Number(rows[0]?.n ?? -1);
}

const alertOf = () => getDb().transaction((tx) => orphanedOnTripVans(tx));

async function vanRow(id: number) {
  const [row] = await getDb()
    .select({ status: vans.status, updatedAt: vans.updatedAt })
    .from(vans)
    .where(eq(vans.id, id));
  if (!row) throw new Error(`no van ${id}`);
  return row;
}

async function setVanStatus(id: number, status: 'available' | 'on_trip' | 'parked' | 'for_repair') {
  await getPool().query('UPDATE vans SET status = ? WHERE id = ?', [status, id]);
}

/**
 * Written with raw SQL on purpose: `updated_at` is advanced by Drizzle's
 * `$onUpdateFn`, which raw SQL does not fire. Backdating it also puts the
 * row well outside the same-second window in which a rewrite could leave the
 * timestamp looking untouched.
 */
async function backdateVan(id: number, isoSeconds: string) {
  await getPool().query('UPDATE vans SET updated_at = ? WHERE id = ?', [isoSeconds, id]);
}

/** A van, a driver and an assigned booking, all this file's own. */
async function makeAssignedBooking(plateTag: string) {
  const db = getDb();
  const [van] = await db.insert(vans).values({
    plate: `ORP${plateTag}${unique()}`.slice(0, 20),
    model: 'Orphaned Van Fixture',
    capacity: 12,
    status: 'available',
    isActive: true,
  });
  created.vanIds.push(van.insertId);
  const [driver] = await db.insert(drivers).values({
    name: `Orphaned Van Driver ${unique()}`,
    code: `ORP${unique()}`.slice(0, 20),
    phone: '09170000004',
    pinHash: '__orphaned_vans_not_a_pin_hash__',
    isActive: true,
  });
  created.driverIds.push(driver.insertId);
  const ref = generateBookingRef();
  const [booking] = await db.insert(bookings).values({
    ref,
    tourId,
    tourDate: new Date(`${TOUR_DATE}T00:00:00Z`),
    pax: 4,
    leadName: 'Orphaned Van Lead Guest',
    leadEmail: `orphan_${unique()}@example.test`,
    leadPhone: '09171234567',
    pickup: 'Radisson Blu lobby',
    status: 'assigned',
    payMode: 'deposit',
    priceSnapshot: SNAPSHOT,
    subtotalCentavos: 400000,
    totalCentavos: 400000,
    amountPaidCentavos: 0,
    vanId: van.insertId,
    driverId: driver.insertId,
  });
  created.bookingIds.push(booking.insertId);
  return { bookingId: booking.insertId, vanId: van.insertId, driverId: driver.insertId, ref };
}

/** A running trip: the real `startTrip`, so the van is legitimately `on_trip`. */
async function startedTrip(plateTag = 'A') {
  const made = await makeAssignedBooking(plateTag);
  const result = await driverCaller(made.driverId).driver.startTrip({ bookingId: made.bookingId });
  expect(result.ok, JSON.stringify(result)).toBe(true);
  expect((await vanRow(made.vanId)).status).toBe('on_trip');
  return made;
}

/** The orphan: the booking moves on, the van is never released. */
async function orphanedTrip(plateTag = 'A') {
  const made = await startedTrip(plateTag);
  await getPool().query('UPDATE bookings SET status = ? WHERE id = ?', [
    'completed',
    made.bookingId,
  ]);
  return made;
}

async function auditCount() {
  return count(sql`SELECT COUNT(*) n FROM audit_log`);
}

describeWithDb('the orphaned-van check', () => {
  beforeEach(async () => {
    const db = getDb();
    TOUR_DATE = new Date().toISOString().slice(0, 10);
    FUTURE_DATE = new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10);

    expect(await count(sql`SELECT COUNT(*) n FROM vans`), 'leftover vans in rg_travel_test').toBe(
      0,
    );
    expect(
      await count(sql`SELECT COUNT(*) n FROM drivers`),
      'leftover drivers in rg_travel_test',
    ).toBe(0);

    const slug = `__orphanvan__${unique()}`;
    const [destination] = await db.insert(destinations).values({ name: slug, slug });
    created.destIds.push(destination.insertId);
    const [tour] = await db.insert(tours).values({
      slug,
      title: `Orphaned Van Tour ${slug}`,
      destinationId: destination.insertId,
      groupsPerDay: 1,
      isActive: true,
    });
    created.tourIds.push(tour.insertId);
    tourId = tour.insertId;
  }, 30_000);

  afterEach(async () => {
    vi.restoreAllMocks();
    const pool = getPool();
    for (const id of created.bookingIds) {
      await pool.query('DELETE FROM trip_checkpoints WHERE booking_id = ?', [id]);
      await pool.query("DELETE FROM audit_log WHERE entity_id = ? AND action LIKE 'trip.%'", [id]);
      await pool.query('DELETE FROM bookings WHERE id = ?', [id]);
    }
    for (const id of created.tourIds) {
      await pool.query('DELETE FROM tour_date_slots WHERE tour_id = ?', [id]);
      await pool.query('DELETE FROM tours WHERE id = ?', [id]);
    }
    for (const day of [TOUR_DATE, FUTURE_DATE]) {
      if (day) await pool.query('DELETE FROM fleet_date_slots WHERE date = ?', [day]);
    }
    for (const id of created.destIds) {
      await pool.query('DELETE FROM destinations WHERE id = ?', [id]);
    }
    for (const id of created.driverIds) await pool.query('DELETE FROM drivers WHERE id = ?', [id]);
    for (const id of created.vanIds) await pool.query('DELETE FROM vans WHERE id = ?', [id]);
    created.bookingIds = [];
    created.tourIds = [];
    created.destIds = [];
    created.driverIds = [];
    created.vanIds = [];
  });

  it('finds a van left on_trip by a trip nobody completed', async () => {
    const { bookingId, vanId, ref } = await startedTrip();
    // The trip is in_progress, so the van is legitimately on_trip.
    expect((await alertOf()).count).toBe(0);

    // The booking moves on without the van being released — exactly what a
    // dead phone at the last stop leaves behind. Written directly, because no
    // code path produces it: that is the gap.
    await getPool().query('UPDATE bookings SET status = ? WHERE id = ?', ['completed', bookingId]);

    const alert = await alertOf();
    expect(alert.kind).toBe('orphaned_on_trip');
    expect(alert.count).toBe(1);
    expect(alert.examples.map((e) => e.id)).toEqual([vanId]);
    // The plate and the last trip are carried in the label: the shared alert
    // shape has no field for them and does not grow one.
    expect(alert.examples[0]!.label).toContain(ref);
    expect(alert.examples[0]!.label).toContain(TOUR_DATE);
    expect(alert.examples[0]!.date).toBeNull();
  });

  it('leaves a van on a RUNNING trip alone', async () => {
    await startedTrip();
    expect(await alertOf()).toMatchObject({ count: 0, examples: [] });
  });

  it('ignores vans in every other status', async () => {
    const { vanId } = await orphanedTrip();
    expect((await alertOf()).count).toBe(1);
    for (const status of ['available', 'for_repair', 'parked'] as const) {
      await setVanStatus(vanId, status);
      expect((await alertOf()).count, `status ${status}`).toBe(0);
    }
  });

  it('ignores a soft-deleted van', async () => {
    const { vanId } = await orphanedTrip();
    await getPool().query('UPDATE vans SET is_active = 0 WHERE id = ?', [vanId]);
    expect((await alertOf()).count).toBe(0);
  });

  it('lists the longest-stranded van first and counts them all', async () => {
    const newer = await orphanedTrip('N');
    const older = await orphanedTrip('O');
    await backdateVan(older.vanId, '2026-10-01 08:00:00');
    await backdateVan(newer.vanId, '2026-11-01 08:00:00');

    const alert = await alertOf();
    expect(alert.count).toBe(2);
    expect(alert.examples.map((e) => e.id)).toEqual([older.vanId, newer.vanId]);
  });

  it('names a van that has no booking at all by its plate alone', async () => {
    const { vanId } = await orphanedTrip();
    await getPool().query('UPDATE bookings SET van_id = NULL WHERE van_id = ?', [vanId]);
    const alert = await alertOf();
    expect(alert.count).toBe(1);
    expect(alert.examples[0]!.label).not.toContain('last trip');
  });

  it('CHANGES NOTHING — the van is still on_trip after the check', async () => {
    const { vanId } = await orphanedTrip();
    await backdateVan(vanId, '2026-10-01 08:00:00');
    const before = await vanRow(vanId);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const result = await checkOrphanedVans(NOW);
    expect(result).toEqual({ found: 1 });

    const after = await vanRow(vanId);
    expect(after.status).toBe('on_trip');
    // `updated_at` has `$onUpdateFn`, so it advances whenever a write MATCHES
    // the row: an unchanged timestamp is positive proof no UPDATE landed,
    // which a status re-read alone would not give (a write of 'on_trip' over
    // 'on_trip' would read back identically).
    expect(after.updatedAt).toEqual(before.updatedAt);
    // And dispatch still refuses it a month out: the column is not the rule,
    // availability is.
    const free = await getDb().transaction((tx) => vansFreeOn(tx, FUTURE_DATE, 2));
    expect(free.map((v) => v.id)).not.toContain(vanId);
  });

  it('writes no audit row: an observation is not an event', async () => {
    await orphanedTrip();
    const before = await auditCount();
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await checkOrphanedVans(NOW);
    expect(await auditCount()).toBe(before);
  });

  it('warns once with the plate and the do-nothing wording, and no guest detail', async () => {
    const { ref } = await orphanedTrip();
    const warned = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await checkOrphanedVans(NOW);
    expect(warned).toHaveBeenCalledTimes(1);
    const line = String(warned.mock.calls[0]![0]);
    expect(line).toContain('orphaned-vans');
    expect(line).toContain(NOW.toISOString());
    expect(line).toContain(ref);
    expect(line).toContain('Nothing has been changed');
    expect(line).not.toContain('Orphaned Van Lead Guest');
  });

  it('reports zero on a healthy fleet, and says nothing', async () => {
    const warned = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(await checkOrphanedVans(NOW)).toEqual({ found: 0 });
    expect(warned).not.toHaveBeenCalled();
  });
});
