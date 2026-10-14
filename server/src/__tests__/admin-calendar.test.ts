/**
 * Week 5 "Dispatch" plan, Task 8 — `admin.calendar.month` and
 * `admin.calendar.dayOptions` (BUILD_SPEC §5C / §9 "Calendar", server half).
 *
 * The owner's Q2 ruling (2026-10-14) is the core of this file: a
 * `pending_verification` trip appears on the calendar, is labelled in TEXT
 * via `awaitingPaymentCheck` rather than colour, and never counts toward
 * `needsAssignmentCount` — all four parts are asserted here. The controller
 * ruling the same day settles the harder question the plan left ambiguous:
 * cancelled and expired trips are absent from the month ENTIRELY, not
 * merely uncounted, because Task 10 refuses to assign either one.
 *
 * Role refusals are asserted on `code`, never on the message — `code` is
 * the contract, the message is copy (same pattern as
 * `admin-bookings.test.ts:256-272` and `admin-drivers.test.ts`).
 *
 * `tour_date` is a `date` column: fixtures convert the civil-date STRING to
 * a `Date` at UTC midnight on insert (`makeBooking`'s job), and the router
 * under test never compares it with `eq()` — only the raw-`sql` `BETWEEN`
 * this suite exercises indirectly through `admin.calendar.month`.
 */
import { afterAll, beforeAll, expect, it } from 'vitest';
import { inArray } from 'drizzle-orm';
import type { BookingStatus, PriceSnapshot } from '@rg/shared';
import { appRouter } from '../routers/_app';
import { getDb, getPool } from '../db/client';
import { bookings, destinations, tours, users, vans } from '../db/schema';
import { generateBookingRef } from '../services/booking-ref';
import { staffContext, testContext } from './helpers/ctx';
import { describeWithDb } from './helpers/db';

const unique = () => `${Math.floor(Math.random() * 1e9)}_${Date.now()}`;

/** Every id this file committed, so teardown removes exactly those rows. */
const created = {
  bookingIds: [] as number[],
  tourIds: [] as number[],
  destIds: [] as number[],
  vanIds: [] as number[],
  userIds: [] as number[],
};

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

async function makeStaff(role: 'owner' | 'dispatcher' | 'finance') {
  const suffix = unique();
  const [row] = await getDb()
    .insert(users)
    .values({
      name: `Admin ${role} ${suffix}`,
      email: `admcal_${role}_${suffix}@example.test`,
      passwordHash: '__admcal_fixture_not_a_hash__',
      role,
      isActive: true,
    });
  created.userIds.push(row.insertId);
  return row.insertId;
}

async function makeVan() {
  const suffix = unique();
  const [van] = await getDb()
    .insert(vans)
    .values({
      plate: `CAL${suffix}`.slice(0, 20),
      model: 'Calendar Fixture Van',
      capacity: 12,
      status: 'available',
      isActive: true,
    });
  created.vanIds.push(van.insertId);
  return van.insertId;
}

/**
 * A committed booking, each on its own fresh tour/destination — the same
 * shape `admin-bookings.test.ts`'s `makeBooking` uses, so this suite never
 * has to thread a shared `tourId` through every fixture. `tourDate` is the
 * civil-date STRING the whole project uses; this is the one place it is
 * converted to the `Date` the `date()` column wants
 * (`admin-drivers.test.ts`'s shape).
 */
async function makeBooking(opts: {
  tourDate: string;
  status?: BookingStatus;
  vanId?: number | null;
  driverId?: number | null;
  leadEmail?: string;
  leadPhone?: string;
}) {
  const db = getDb();
  const slug = `__admcal__${unique()}`;
  const [dest] = await db.insert(destinations).values({ name: slug, slug });
  created.destIds.push(dest.insertId);
  const [tour] = await db
    .insert(tours)
    .values({ slug, title: `Tour ${slug}`, destinationId: dest.insertId });
  created.tourIds.push(tour.insertId);

  const ref = generateBookingRef();
  const [booking] = await db.insert(bookings).values({
    ref,
    tourId: tour.insertId,
    tourDate: new Date(`${opts.tourDate}T00:00:00Z`),
    pax: 2,
    leadName: 'Calendar Fixture',
    leadEmail: opts.leadEmail ?? `admcal_${slug}@example.test`,
    leadPhone: opts.leadPhone ?? '09170000000',
    status: opts.status ?? 'pending_payment',
    payMode: 'full',
    priceSnapshot: SNAPSHOT,
    subtotalCentavos: SNAPSHOT.totalCentavos,
    totalCentavos: SNAPSHOT.totalCentavos,
    vanId: opts.vanId ?? null,
    driverId: opts.driverId ?? null,
  });
  created.bookingIds.push(booking.insertId);
  return { bookingId: booking.insertId, ref, tourTitle: `Tour ${slug}` };
}

let ownerId = 0;
let dispatcherId = 0;
let financeId = 0;
let vanId = 0;
/** A real but unrelated booking id — used only to prove finance is refused
 *  before the resolver ever reads it. */
let bookingId = 0;

beforeAll(async () => {
  ownerId = await makeStaff('owner');
  dispatcherId = await makeStaff('dispatcher');
  financeId = await makeStaff('finance');
  vanId = await makeVan();
  // Far from every date the tests below query, so it can never change a
  // November 2026 count.
  const fixture = await makeBooking({ tourDate: '2030-01-01', status: 'pending_payment' });
  bookingId = fixture.bookingId;
}, 60_000);

afterAll(async () => {
  const pool = getPool();
  const db = getDb();
  for (const id of created.bookingIds) {
    await pool.query('DELETE FROM bookings WHERE id = ?', [id]);
  }
  if (created.tourIds.length > 0) {
    await db.delete(tours).where(inArray(tours.id, created.tourIds));
  }
  if (created.destIds.length > 0) {
    await db.delete(destinations).where(inArray(destinations.id, created.destIds));
  }
  if (created.vanIds.length > 0) {
    await db.delete(vans).where(inArray(vans.id, created.vanIds));
  }
  for (const id of created.userIds) {
    await pool.query('DELETE FROM sessions WHERE subject_type = ? AND subject_id = ?', [
      'user',
      id,
    ]);
    await pool.query('DELETE FROM users WHERE id = ?', [id]);
  }
});

describeWithDb('admin.calendar', () => {
  it('returns every day of the month, including empty ones', async () => {
    const api = appRouter.createCaller(staffContext(ownerId, 'owner') as never);
    const { days } = await api.admin.calendar.month({ year: 2026, month: 11 });
    expect(days).toHaveLength(30);
    // `noUncheckedIndexedAccess` wants the assertion spelled out: `toHaveLength(30)`
    // above is what makes this index safe.
    expect(days[0]!.date).toBe('2026-11-01');
    expect(days.at(-1)!.date).toBe('2026-11-30');
  });

  it('does not bleed a trip from an adjacent month', async () => {
    const api = appRouter.createCaller(staffContext(ownerId, 'owner') as never);
    await makeBooking({ tourDate: '2026-12-01', status: 'confirmed' });
    const { days } = await api.admin.calendar.month({ year: 2026, month: 11 });
    expect(days.flatMap((d) => d.trips)).toHaveLength(0);
  });

  it('marks a confirmed trip with no van as needing assignment', async () => {
    const api = appRouter.createCaller(staffContext(ownerId, 'owner') as never);
    await makeBooking({ tourDate: '2026-11-10', status: 'confirmed', vanId: null, driverId: null });
    const { days } = await api.admin.calendar.month({ year: 2026, month: 11 });
    const day = days.find((d) => d.date === '2026-11-10')!;
    expect(day.needsAssignmentCount).toBe(1);
    expect(day.trips[0]!.needsAssignment).toBe(true);
  });

  it('marks a trip with a van but no driver as STILL needing assignment', async () => {
    const api = appRouter.createCaller(staffContext(ownerId, 'owner') as never);
    await makeBooking({ tourDate: '2026-11-11', status: 'confirmed', vanId, driverId: null });
    const { days } = await api.admin.calendar.month({ year: 2026, month: 11 });
    expect(days.find((d) => d.date === '2026-11-11')!.needsAssignmentCount).toBe(1);
  });

  it('does NOT mark an unpaid hold as needing assignment, but still SHOWS it', async () => {
    const api = appRouter.createCaller(staffContext(ownerId, 'owner') as never);
    await makeBooking({ tourDate: '2026-11-12', status: 'pending_payment' });
    await makeBooking({ tourDate: '2026-11-12', status: 'pending_verification' });
    const { days } = await api.admin.calendar.month({ year: 2026, month: 11 });
    const day = days.find((d) => d.date === '2026-11-12')!;
    // Both are visible — a dispatcher planning a week needs to see probable
    // trips — and neither counts. Q2.
    expect(day.trips).toHaveLength(2);
    expect(day.needsAssignmentCount).toBe(0);
  });

  it('flags a pending_verification trip as awaiting a payment check', async () => {
    const api = appRouter.createCaller(staffContext(ownerId, 'owner') as never);
    await makeBooking({ tourDate: '2026-11-14', status: 'pending_verification' });
    await makeBooking({ tourDate: '2026-11-14', status: 'confirmed' });
    const { days } = await api.admin.calendar.month({ year: 2026, month: 11 });
    const day = days.find((d) => d.date === '2026-11-14')!;
    expect(day.trips.filter((t) => t.awaitingPaymentCheck)).toHaveLength(1);
    expect(day.trips.find((t) => t.status === 'confirmed')!.awaitingPaymentCheck).toBe(false);
    // It is awaiting a payment check AND unstaffed, and still counts zero.
    expect(day.needsAssignmentCount).toBe(1);
  });

  /**
   * Controller ruling, 2026-10-14: cancelled and expired trips are **absent
   * from the month view entirely**, not merely uncounted.
   *
   * The old version of this test asserted only `needsAssignmentCount === 0`,
   * which an implementation passes whether it omits those trips or lists
   * them. Deciding it:
   *
   *  - They hold no capacity (§5's status table), so they are not work.
   *  - **Task 10 REFUSES to assign a cancelled or expired booking.** Showing
   *    one in the dispatch calendar therefore offers a dispatcher an action
   *    that can only ever fail, which is worse than hiding it.
   *  - §9 gives cancellation history its own home: the bookings list, with a
   *    status filter. The calendar answers "what is running, and what needs
   *    staffing".
   *
   * So the assertion is emptiness, and the fixtures prove the day existed to
   * be looked at.
   */
  it('leaves a cancelled or expired trip out of the month entirely', async () => {
    const api = appRouter.createCaller(staffContext(ownerId, 'owner') as never);
    await makeBooking({ tourDate: '2026-11-13', status: 'cancelled' });
    await makeBooking({ tourDate: '2026-11-13', status: 'expired' });
    const { days } = await api.admin.calendar.month({ year: 2026, month: 11 });

    const day = days.find((d) => d.date === '2026-11-13');
    expect(day, 'the 13th must still be present as an empty day').toBeDefined();
    expect(day!.trips).toEqual([]);
    expect(day!.needsAssignmentCount).toBe(0);
  });

  it('never exposes a guest email or phone through the calendar', async () => {
    const api = appRouter.createCaller(staffContext(dispatcherId, 'dispatcher') as never);
    await makeBooking({
      tourDate: '2026-11-18',
      status: 'confirmed',
      leadEmail: 'guest@example.com',
      leadPhone: '+639081234567',
    });
    const { days } = await api.admin.calendar.month({ year: 2026, month: 11 });

    // VACUITY GUARD, and it is the whole test. A "no email appears" assertion
    // over an empty month passes perfectly while proving nothing, so the
    // booking above is seeded with a known address and number, and this line
    // insists the payload actually contains trips before the absence below
    // means anything.
    /*
     * VACUITY GUARD, and the exactness is scoped to the DAY this test owns
     * rather than the whole month — which is the honest boundary here.
     *
     * An earlier draft asserted `toHaveLength(1)` across the month and
     * failed: other tests in this file seed their own November bookings, and
     * they all share one database, so the month-wide count depends on test
     * order and is not knowable. The day is: this test seeds exactly one
     * booking on the 18th, so that is where an exact assertion can be made
     * truthfully. `> 0` on the month stays as the floor, because the absence
     * assertions below are about the WHOLE payload and need it to be
     * non-empty to mean anything.
     */
    const seededDay = days.find((d) => d.date === '2026-11-18');
    expect(seededDay, 'the day this test seeded must be in the month').toBeDefined();
    expect(seededDay!.trips).toHaveLength(1);

    const trips = days.flatMap((d) => d.trips);
    expect(trips.length).toBeGreaterThan(0);

    const payload = JSON.stringify(days);
    expect(payload).not.toContain('guest@example.com');
    expect(payload).not.toContain('+639081234567');
    expect(payload).not.toMatch(/@|\+639/);
  });

  it('lets finance READ the month but not the dropdown options', async () => {
    const api = appRouter.createCaller(staffContext(financeId, 'finance') as never);
    await expect(api.admin.calendar.month({ year: 2026, month: 11 })).resolves.toBeTruthy();
    await expect(api.admin.calendar.dayOptions({ bookingId })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });

  /**
   * `dayOptions`'s NOT_FOUND branch had no coverage either way (Task 8
   * review). It matters because this is the procedure Task 12's dropdown
   * calls on every day selection: a stale booking id — a trip cancelled in
   * another tab, a bookmarked URL — must produce a clean refusal rather
   * than a 500 or an empty dropdown that looks like "nothing is free".
   */
  it('refuses dayOptions for a booking id that does not exist', async () => {
    const api = appRouter.createCaller(staffContext(dispatcherId, 'dispatcher') as never);
    await expect(api.admin.calendar.dayOptions({ bookingId: 99_999_999 })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('rejects a month outside 1..12 and a year outside 2020..2100', async () => {
    const api = appRouter.createCaller(staffContext(ownerId, 'owner') as never);
    await expect(api.admin.calendar.month({ year: 2026, month: 13 })).rejects.toThrow();
    await expect(api.admin.calendar.month({ year: 1999, month: 1 })).rejects.toThrow();
  });

  /**
   * Not in the brief's verbatim list, but the gap it warned about by name:
   * `dayOptions` is covered above only for its role gate, never for
   * whether it actually calls the Task 3 availability module correctly. A
   * procedure Task 12's dropdown can't actually consume would be exactly
   * the defect class this plan has been losing time to. `excludeBookingId`
   * is the whole reason `dayOptions` takes a booking rather than a bare
   * date — this proves that wiring, not just the role gate around it.
   */
  it('returns the van and driver this booking already holds, via excludeBookingId', async () => {
    const api = appRouter.createCaller(staffContext(ownerId, 'owner') as never);
    const { bookingId: mineId } = await makeBooking({
      tourDate: '2026-11-20',
      status: 'assigned',
      vanId,
    });
    const { vans: freeVans } = await api.admin.calendar.dayOptions({ bookingId: mineId });
    expect(freeVans.map((v) => v.id)).toContain(vanId);
  });

  it('REFUSES a caller with no session on both procedures', async () => {
    const api = appRouter.createCaller(testContext() as never);
    await expect(api.admin.calendar.month({ year: 2026, month: 11 })).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    });
    await expect(api.admin.calendar.dayOptions({ bookingId })).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    });
  });
});
