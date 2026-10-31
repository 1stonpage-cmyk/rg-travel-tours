/**
 * **Task T6 — the must-fix audit, as a test.**
 *
 * Migration 0017 (Task T5) made `bookings.tour_id` nullable: a booking is now
 * a tour OR a transfer, and a transfer's `tour_id` is `NULL`. Nineteen queries
 * across `server/src` joined `tours` on that column with an INNER JOIN, each
 * written when "a booking always has a tour" was true. An inner join on a null
 * column does not error — it returns NO ROW — so every one of those sites was
 * one migration away from dropping transfer bookings silently: a guest told
 * their own booking does not exist, a driver whose trip is missing from their
 * phone, an office list with a receipt nobody can see waiting.
 *
 * This file is the inclusion proof for the SURFACES (listings, detail reads,
 * guest and driver screens). The three sites that are cron or alert logic carry
 * their tests in their own suites, where the fixtures and the leftover-row
 * guards already live: `trip-reminders.test.ts`, `review-requests.test.ts` and
 * `dashboard-alerts.test.ts`.
 *
 * ## What is NOT claimed here
 *
 * That a transfer booking RENDERS WELL. It does not yet: there is no route
 * name, no pickup time, no vehicle type on any of these payloads, and the
 * guest-facing copy still says "tour" in places. That is the display work of
 * T18 (reports), T22 (driver portal), T23 (admin screens) and T24 (portal and
 * notification copy). The bar asserted below is T6's own: **never silently
 * dropped, never a crash, never a false statement.**
 *
 * ## The fixture is written directly, because nothing can create one yet
 *
 * `createTransferBooking()` is T9/T10. So the booking is inserted through
 * Drizzle with `tour_id: null`, `product_type: 'transfer_one_way'` and a
 * `vehicle_type_requested` — the only shape the `bookings_product_type_shape`
 * CHECK accepts without a tour, which is exactly what
 * `booking-transfer-schema.test.ts` proves. A TOUR booking is created beside it
 * on the same day in most tests, because "the transfer appears" is only half
 * the claim: the tour must still appear too, with its title intact.
 *
 * ## Every test can fail
 *
 * Restoring any one `leftJoin(tours, …)` to `innerJoin` reddens the test that
 * covers it and nothing else. The per-test notes name which file.
 */
import { afterAll, afterEach, beforeAll, expect, it } from 'vitest';
import { type PriceSnapshot } from '@rg/shared';
import { getDb, getPool } from '../db/client';
import { bookings, destinations, drivers, tours, users } from '../db/schema';
import { appRouter } from '../routers/_app';
import { todayDepartures } from '../routers/admin/departures';
import { driverTripDetail, listDriverTrips } from '../routers/public/driver';
import { generateBookingRef } from '../services/booking-ref';
import { customerContext, staffContext, testContext } from './helpers/ctx';
import { describeWithDb } from './helpers/db';

/**
 * A year no other suite in this tree fixtures on. `trip-reminders.test.ts` owns
 * 2099-11, `review-requests.test.ts` 2099-11/12 and `dashboard-alerts.test.ts`
 * 2026-11, and all three assert exact counts on their own days — so this file
 * stays well clear of them rather than relying on teardown ordering.
 */
const TRIP_DATE = '2098-07-15';
/** 04:00 on `TRIP_DATE` in Manila — so the departures board's "today" is it. */
const NOW = new Date('2098-07-14T20:00:00Z');

const asDate = (civilDate: string) => new Date(`${civilDate}T00:00:00Z`);
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

const created = {
  bookingIds: [] as number[],
  driverIds: [] as number[],
  userIds: [] as number[],
  tourIds: [] as number[],
  destIds: [] as number[],
};

let ownerId = 0;
let driverId = 0;
let tourId = 0;
const TOUR_TITLE = 'T6 Audit Fixture Tour';

interface Fixture {
  id: number;
  ref: string;
  email: string;
}

async function makeBooking(opts: {
  transfer: boolean;
  status?: 'confirmed' | 'assigned' | 'pending_verification';
  assignDriver?: boolean;
}): Promise<Fixture> {
  const ref = generateBookingRef();
  const email = `t6_${unique()}@example.test`;
  const [row] = await getDb()
    .insert(bookings)
    .values({
      ref,
      /*
       * The two legal shapes, and only these two: `tour_id` set with no
       * product fields, or `tour_id` null with a product type AND a requested
       * vehicle. Anything else is refused by the database's own CHECK.
       */
      ...(opts.transfer
        ? ({
            tourId: null,
            productType: 'transfer_one_way',
            vehicleTypeRequested: 'van',
          } as const)
        : { tourId }),
      tourDate: asDate(TRIP_DATE),
      pax: 3,
      leadName: 'T6 Audit Guest',
      leadEmail: email,
      leadPhone: '09170000000',
      status: opts.status ?? 'confirmed',
      payMode: 'full',
      priceSnapshot: SNAPSHOT,
      subtotalCentavos: 400000,
      totalCentavos: 400000,
      amountPaidCentavos: 100000,
      driverId: opts.assignDriver === false ? null : driverId,
    });
  created.bookingIds.push(row.insertId);
  return { id: row.insertId, ref, email };
}

const ownerCaller = () => appRouter.createCaller(staffContext(ownerId, 'owner') as never);
const guestCaller = () => appRouter.createCaller(testContext() as never);
const portalCaller = (bookingId: number) =>
  appRouter.createCaller(customerContext(bookingId) as never);

describeWithDb('T6: no surface silently drops a transfer booking', () => {
  beforeAll(async () => {
    const db = getDb();

    const slug = `__t6__${unique()}`;
    const [destination] = await db.insert(destinations).values({ name: slug, slug });
    created.destIds.push(destination.insertId);
    const [tour] = await db
      .insert(tours)
      .values({ slug, title: TOUR_TITLE, destinationId: destination.insertId });
    created.tourIds.push(tour.insertId);
    tourId = tour.insertId;

    const [owner] = await db.insert(users).values({
      name: `T6 Owner ${slug}`,
      email: `t6_owner_${unique()}@example.test`,
      passwordHash: '__t6_fixture_not_a_hash__',
      role: 'owner',
      isActive: true,
    });
    created.userIds.push(owner.insertId);
    ownerId = owner.insertId;

    const [driver] = await db.insert(drivers).values({
      name: `T6 Driver ${slug}`,
      code: `T6D${unique()}`.slice(0, 20),
      phone: '09170000001',
      pinHash: '__t6_fixture_not_a_pin_hash__',
      isActive: true,
    });
    created.driverIds.push(driver.insertId);
    driverId = driver.insertId;
  }, 30_000);

  /*
   * Bookings are cleared per test because several of these reads count or list
   * everything on `TRIP_DATE`; the staff user, the driver and the tour stay for
   * the file. Nothing is hard-deleted that CLAUDE.md protects in production —
   * this is `rg_travel_test`, and the suite's own convention (see
   * `trip-reminders.test.ts`) is to remove its own fixture rows.
   */
  afterEach(async () => {
    const pool = getPool();
    for (const id of created.bookingIds) {
      await pool.query("DELETE FROM audit_log WHERE entity = 'bookings' AND entity_id = ?", [id]);
      await pool.query('DELETE FROM trip_checkpoints WHERE booking_id = ?', [id]);
      await pool.query('DELETE FROM bookings WHERE id = ?', [id]);
    }
    created.bookingIds.length = 0;
  });

  afterAll(async () => {
    const pool = getPool();
    for (const id of created.driverIds) await pool.query('DELETE FROM drivers WHERE id = ?', [id]);
    for (const id of created.userIds) await pool.query('DELETE FROM users WHERE id = ?', [id]);
    for (const id of created.tourIds) {
      await pool.query('DELETE FROM tour_date_slots WHERE tour_id = ?', [id]);
      await pool.query('DELETE FROM tours WHERE id = ?', [id]);
    }
    for (const id of created.destIds) {
      await pool.query('DELETE FROM destinations WHERE id = ?', [id]);
    }
  });

  /* ------------------------------------------------------------------ *
   * The office: `admin.bookings.list` / `.detail` (routers/admin/bookings.ts)
   * ------------------------------------------------------------------ */

  it('lists a transfer booking beside a tour booking, and pages them as one set', async () => {
    const tourBooking = await makeBooking({ transfer: false });
    const transfer = await makeBooking({ transfer: true });

    const page = await ownerCaller().admin.bookings.list({ from: TRIP_DATE, to: TRIP_DATE });

    const refs = page.items.map((item) => item.ref);
    expect(refs, 'a transfer booking is invisible to the office bookings list').toContain(
      transfer.ref,
    );
    expect(refs).toContain(tourBooking.ref);
    // The pager's own COUNT(*) is joined the same way, or it would promise a
    // different number of rows from the ones on the page.
    expect(page.total).toBe(2);

    const transferRow = page.items.find((item) => item.ref === transfer.ref)!;
    expect(transferRow.tourTitle, 'a transfer has no tour to name').toBeNull();
    const tourRow = page.items.find((item) => item.ref === tourBooking.ref)!;
    expect(tourRow.tourTitle, 'the left join cost the tour side its title').toBe(TOUR_TITLE);
  });

  /**
   * The sharpest of these: an inner join turned a real reference into
   * `NOT_FOUND` on the one screen an admin opens when a guest rings up.
   */
  it('opens a transfer booking by reference instead of answering NOT_FOUND', async () => {
    const transfer = await makeBooking({ transfer: true });

    const detail = await ownerCaller().admin.bookings.detail({ ref: transfer.ref });

    expect(detail.ref).toBe(transfer.ref);
    expect(detail.tourId).toBeNull();
    expect(detail.tourTitle).toBeNull();
    // Nothing downstream of the join crashed on the null: the payment trail,
    // the add-on lines, the notes and the audit tail all resolved.
    expect(detail.totalCentavos).toBe(400000);
    expect(Array.isArray(detail.payments)).toBe(true);
    expect(Array.isArray(detail.notes)).toBe(true);
    expect(Array.isArray(detail.audit)).toBe(true);
  });

  /* ------------------------------------------------------------------ *
   * Dispatch: `admin.calendar.month`, `todayDepartures`
   * ------------------------------------------------------------------ */

  it('puts a transfer on the dispatch calendar, with its assignment state intact', async () => {
    const transfer = await makeBooking({ transfer: true, assignDriver: false });

    const { days } = await ownerCaller().admin.calendar.month({ year: 2098, month: 7 });
    const day = days.find((d) => d.date === TRIP_DATE)!;

    const trip = day.trips.find((t) => t.ref === transfer.ref);
    expect(trip, 'a transfer booking is missing from the dispatch calendar').toBeDefined();
    expect(trip!.tourTitle).toBeNull();
    // With no van and no driver it is exactly what the screen's own counter
    // exists to surface — which it could not do while the row was dropped.
    expect(trip!.needsAssignment).toBe(true);
    expect(day.needsAssignmentCount).toBeGreaterThanOrEqual(1);
  });

  it('shows a transfer on today’s departures board, with real progress', async () => {
    const transfer = await makeBooking({ transfer: true });

    const departures = await todayDepartures(NOW);
    const row = departures.find((d) => d.ref === transfer.ref);

    expect(row, 'a transfer departing today is missing from the departures board').toBeDefined();
    expect(row!.tourTitle).toBeNull();
    /*
     * `tripProgress()` already tolerated a null `tour_id` — it LEFT joins the
     * itinerary stops, so a transfer has the trip-start pseudo-stop and
     * nothing else: `0 of 1`, not a crash and not an empty list. What progress
     * SHOULD mean for a transfer is T22's question.
     */
    expect(row!.progress.total).toBe(1);
    expect(row!.progress.done).toBe(0);
  });

  /* ------------------------------------------------------------------ *
   * The driver: `driver.trips` / `driver.trip` (routers/public/driver.ts)
   * ------------------------------------------------------------------ */

  it('shows a driver their own transfer trip, and lets them open it', async () => {
    const transfer = await makeBooking({ transfer: true, status: 'assigned' });

    const rows = await listDriverTrips(driverId, NOW);
    const row = rows.find((t) => t.ref === transfer.ref);
    expect(row, 'a driver’s own transfer trip is missing from their list').toBeDefined();
    expect(row!.tourTitle).toBeNull();

    /*
     * And the detail read, where the inner join was worse than a missing row:
     * it produced the SAME `NOT_FOUND` another driver's booking gets, so a
     * driver was told their own trip was not theirs — and could neither ring
     * the guest nor record the cash they had just taken.
     */
    const detail = await driverTripDetail(driverId, transfer.id);
    expect(detail.ref).toBe(transfer.ref);
    expect(detail.tourTitle).toBeNull();
    expect(detail.leadPhone).toBe('09170000000');
    // The payment box is still computed: 400000 total, 100000 paid.
    expect(detail.payment).toEqual({ kind: 'collect_cash', amountCentavos: 300000 });
  });

  /* ------------------------------------------------------------------ *
   * The guest: `portal.booking` / `.manualPayment`, `checkout.bookingStatus`
   * / `.bookingLookup`
   * ------------------------------------------------------------------ */

  it('answers My Booking for a signed-in transfer guest', async () => {
    const transfer = await makeBooking({ transfer: true });

    const booking = await portalCaller(transfer.id).portal.booking();
    expect(booking.ref).toBe(transfer.ref);
    expect(booking.tourTitle).toBeNull();
    expect(booking.balanceCentavos).toBe(300000);

    const manual = await portalCaller(transfer.id).portal.manualPayment();
    expect(manual.ref).toBe(transfer.ref);
    expect(manual.tourTitle).toBeNull();
    // `payMode: 'full'` less what is paid — the money math is untouched by
    // the join change, which is the point of asserting it here.
    expect(manual.amountDueCentavos).toBe(300000);
  });

  it('answers the booking-status page and the ref+email lookup for a transfer', async () => {
    const transfer = await makeBooking({ transfer: true });

    const status = await guestCaller().checkout.bookingStatus({ ref: transfer.ref });
    expect(status.ref).toBe(transfer.ref);
    expect(status.tourTitle).toBeNull();
    expect(status.balanceCentavos).toBe(300000);

    const lookup = await guestCaller().checkout.bookingLookup({
      ref: transfer.ref,
      email: transfer.email,
    });
    expect(lookup.ref).toBe(transfer.ref);
    expect(lookup.tourTitle).toBeNull();
  });

  /**
   * A wrong reference must still be refused — the left join widened what the
   * query returns, and this is the check that it did not widen it to
   * everything.
   */
  it('still refuses a reference that does not exist', async () => {
    await makeBooking({ transfer: true });
    await expect(guestCaller().checkout.bookingStatus({ ref: 'RG-ZZZZZZ' })).rejects.toThrow();
  });
});
