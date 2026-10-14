/**
 * Week 5 Dispatch, Task 2: §9's fourth van status (`parked`), and Gate 2 of
 * `assessCapacity()` as an ALLOW-LIST (owner decision 2026-10-14, Q1) —
 * `status = VAN_STATUS_SELLABLE` replacing the old deny-list
 * `status <> 'for_repair'`. The reasoning lives beside `VAN_STATUSES` and
 * `VAN_STATUS_SELLABLE` in `server/src/db/schema.ts` and beside Gate 2 in
 * `server/src/services/capacity.ts`; this file is only the proof.
 *
 * The DB-backed block mirrors `capacity.test.ts`'s fixture style: one tour
 * with room, one van, one driver, built fresh in `beforeEach` and torn down
 * in `afterEach` — the fleet is not scoped to a date, so every count here
 * depends on exactly what this file built.
 */
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { getDb, getPool } from '../db/client';
import {
  destinations,
  drivers,
  tours,
  vans,
  VAN_STATUSES,
  VAN_STATUS_SELLABLE,
} from '../db/schema';
import { assessCapacity, takeSlotLocks } from '../services/capacity';
import { describeWithDb } from './helpers/db';

/** Far enough out that no seed or fixture owns it. */
const DATE = '2099-12-09';

/** Random first, timestamp second — see capacity.test.ts for why. */
const unique = () => `${Math.floor(Math.random() * 1e9)}_${Date.now()}`;

it('names all four statuses from BUILD_SPEC §9', () => {
  expect([...VAN_STATUSES].sort()).toEqual(['available', 'for_repair', 'on_trip', 'parked']);
});

it('allow-lists exactly one status as sellable', () => {
  expect(VAN_STATUS_SELLABLE).toBe('available');
});

it('exports no deny-list for anyone to filter on by mistake', async () => {
  const schema = await import('../db/schema');
  expect(Object.keys(schema)).not.toContain('VAN_STATUSES_UNAVAILABLE');
});

describeWithDb('vans', () => {
  let tourId: number;
  let destinationId: number;
  let onlyVanId: number;
  let driverId: number;

  beforeEach(async () => {
    const db = getDb();
    const slug = `__vanstatus__${unique()}`;
    const [destination] = await db.insert(destinations).values({ name: slug, slug });
    destinationId = destination.insertId;

    const [tour] = await db.insert(tours).values({
      slug,
      title: slug,
      destinationId,
      groupsPerDay: 1,
      isActive: true,
    });
    tourId = tour.insertId;

    const [van] = await db.insert(vans).values({
      plate: `VST${unique()}`.slice(0, 20),
      model: 'Van Status Fixture',
      capacity: 12,
      status: 'available',
      isActive: true,
    });
    onlyVanId = van.insertId;

    const [driver] = await db.insert(drivers).values({
      name: 'Van Status Fixture Driver',
      code: `VST${unique()}`.slice(0, 20),
      phone: '09170000000',
      // Not a real hash and not a real PIN: nothing here logs in.
      pinHash: '__van_status_not_a_pin_hash__',
      isActive: true,
    });
    driverId = driver.insertId;
  });

  afterEach(async () => {
    const pool = getPool();
    await pool.query('DELETE FROM tour_date_slots WHERE tour_id = ?', [tourId]);
    await pool.query('DELETE FROM fleet_date_slots WHERE date = ?', [DATE]);
    await pool.query('DELETE FROM tours WHERE id = ?', [tourId]);
    await pool.query('DELETE FROM destinations WHERE id = ?', [destinationId]);
    await pool.query('DELETE FROM vans WHERE id = ?', [onlyVanId]);
    await pool.query('DELETE FROM drivers WHERE id = ?', [driverId]);
  });

  /**
   * The call under test, as `createHold()` makes it: both locks first, then
   * the verdict, through the same transaction.
   */
  function assess(pax: number) {
    return getDb().transaction(async (tx) => {
      await takeSlotLocks(tx, tourId, DATE);
      return assessCapacity(tx, tourId, DATE, pax);
    });
  }

  /**
   * The owner's first named test: EVERY non-available status is excluded.
   * Written as a loop over `VAN_STATUSES` rather than three hand-written
   * cases, so a fifth status added later is covered the day it is added
   * instead of the day someone remembers this file.
   */
  it.each(VAN_STATUSES.filter((s) => s !== VAN_STATUS_SELLABLE))(
    'does not count a %s van as sellable fleet',
    async (status) => {
      const db = getDb();
      await db.update(vans).set({ status }).where(eq(vans.id, onlyVanId));
      const verdict = await assess(2);
      expect(verdict).toEqual({ ok: false, reason: 'no_van_available' });
    },
  );

  it('counts an available van as sellable fleet', async () => {
    const db = getDb();
    await db.update(vans).set({ status: 'available' }).where(eq(vans.id, onlyVanId));
    const verdict = await assess(2);
    expect(verdict).toEqual({ ok: true });
  });
});
