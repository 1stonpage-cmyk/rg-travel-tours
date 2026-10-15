/**
 * Week 6 plan, Task 4 — `driver.trip`, and §8's payment box (BUILD_SPEC §8
 * "Trip detail").
 *
 * **The payment box is the subject of this file.** It is the one screen in
 * the system that tells a human whether to take money from another human,
 * and deriving it wrongly either charges a guest twice or gives a trip
 * away. So every state is asserted with the EXACT centavo figure, not
 * "something is owed", and the two states that are both true at once have
 * their precedence pinned deliberately rather than left to whichever branch
 * happened to be written first:
 *
 *  1. **`fully_paid` wins over the review flag.** §8's copy for the
 *     unverified state begins "Not paid", and saying that about a booking
 *     whose balance is zero is a lie the office would have to unpick over
 *     the phone while a van waits. Nothing is collected in either state, so
 *     no money moves on this choice — only the words do.
 *  2. **A `pending` payment beats the arithmetic.** A receipt nobody has
 *     approved leaves `amount_paid_centavos` at zero, so the subtraction
 *     says "collect" while the guest has already transferred. That is the
 *     double-charge, and it is the whole reason the middle state exists.
 *  3. **A `rejected` or `superseded` payment does NOT.** Those are dead
 *     rows (a transfer that failed, a receipt the guest replaced), and a box
 *     held in "do not collect" by one would mean no driver could ever take
 *     the balance from that guest again.
 *
 * **The second subject is RA 10173.** This payload carries the lead guest's
 * phone number, deliberately — §8 gives the driver call/text/WhatsApp
 * buttons. That makes `NOT_FOUND` for another driver's booking a security
 * property and not a nicety: `FORBIDDEN` would confirm the booking exists,
 * which is an enumeration oracle over every booking id on the system. The
 * message is asserted to name neither the id nor the ref, and the payload
 * is asserted to carry nothing §8 did not ask for.
 *
 * Fixtures are rebuilt per test and deleted in `afterEach` — the test
 * database keeps an EMPTY fleet (`capacity.test.ts` counts the whole
 * fleet), so every van and driver created here goes again.
 */
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import {
  TRIP_START_STOP_NAME,
  manilaCivilDate,
  type PaymentBoxState,
  type PriceSnapshot,
} from '@rg/shared';
import { getDb, getPool } from '../db/client';
import {
  bookingNotes,
  bookings,
  destinations,
  drivers,
  payments,
  tourItineraryStops,
  tours,
  users,
  vans,
} from '../db/schema';
import { generateBookingRef } from '../services/booking-ref';
import { tripProgress } from '../services/trips/progress';
import { driverCaller } from './helpers/ctx';
import { describeWithDb } from './helpers/db';

/** Random first, timestamp second — same discipline as capacity.test.ts. */
const unique = () => `${Math.floor(Math.random() * 1e9)}_${Date.now()}`;

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

const LEAD_PHONE = '09171234567';
const LEAD_EMAIL = 'trip-detail-lead@example.test';

/** The trip's price, in centavos. Every payment figure below is against it. */
const TOTAL = 400_000;
/** A 30% deposit on `TOTAL`, so the balance is an exact, non-round number. */
const DEPOSIT = 120_000;

const created = {
  bookingIds: [] as number[],
  tourIds: [] as number[],
  destIds: [] as number[],
  vanIds: [] as number[],
  driverIds: [] as number[],
  userIds: [] as number[],
};

async function count(statement: Parameters<ReturnType<typeof getDb>['execute']>[0]) {
  const [rows] = (await getDb().execute(statement)) as unknown as [Array<{ n: number }>, unknown];
  return Number(rows[0]?.n ?? -1);
}

async function makeDriver(label: string) {
  const suffix = unique();
  const [driver] = await getDb()
    .insert(drivers)
    .values({
      name: `Trip Detail ${label} ${suffix}`,
      code: `TD${suffix}`.slice(0, 20),
      phone: '09170000001',
      // Not a real hash: nothing here logs in, it arrives with a session
      // already (which is what `driverCaller` is).
      pinHash: '__tripdetail_not_a_pin_hash__',
      isActive: true,
    });
  created.driverIds.push(driver.insertId);
  return driver.insertId;
}

interface BookingOpts {
  driverId: number;
  vanId?: number | null;
  paidCentavos?: number;
  reviewRequired?: boolean;
  pickup?: string | null;
  pickupMapUrl?: string | null;
}

async function makeBooking(opts: BookingOpts) {
  const ref = generateBookingRef();
  const [booking] = await getDb()
    .insert(bookings)
    .values({
      ref,
      tourId,
      tourDate: new Date(`${TOUR_DATE}T00:00:00Z`),
      pax: 4,
      leadName: 'Trip Detail Lead Guest',
      leadEmail: LEAD_EMAIL,
      leadPhone: LEAD_PHONE,
      // `=== undefined`, not `??`: a test that asks for a null pickup must
      // GET a null one, and `??` would hand it the default instead.
      pickup: opts.pickup === undefined ? 'Radisson Blu lobby' : opts.pickup,
      pickupMapUrl:
        opts.pickupMapUrl === undefined ? 'https://maps.example.test/radisson' : opts.pickupMapUrl,
      status: 'assigned',
      payMode: 'deposit',
      priceSnapshot: { ...SNAPSHOT, subtotalCentavos: TOTAL, totalCentavos: TOTAL },
      subtotalCentavos: TOTAL,
      totalCentavos: TOTAL,
      // Fixtures set the column directly because only the payments service
      // may move it in application code (CLAUDE.md, A5b) and this file is
      // not that service — it is describing a booking that already exists.
      amountPaidCentavos: opts.paidCentavos ?? 0,
      paymentReviewRequired: opts.reviewRequired ?? false,
      vanId: opts.vanId === undefined ? vanId : opts.vanId,
      driverId: opts.driverId,
    });
  created.bookingIds.push(booking.insertId);
  return { id: booking.insertId, ref };
}

/** A `payments` row in whatever state the test needs it in. */
async function makePayment(opts: {
  bookingId: number;
  status: 'pending' | 'paid' | 'rejected' | 'superseded' | 'failed';
  method?: 'cash' | 'bank_transfer' | 'gcash';
  amountCentavos?: number;
  collectedByDriverId?: number;
}) {
  const [row] = await getDb()
    .insert(payments)
    .values({
      bookingId: opts.bookingId,
      type: 'payment',
      provider: 'manual',
      method: opts.method ?? 'bank_transfer',
      amountCentavos: opts.amountCentavos ?? TOTAL,
      status: opts.status,
      collectedByDriverId: opts.collectedByDriverId ?? null,
    });
  return Number(row.insertId);
}

let TOUR_DATE = '';
let tourId = 0;
let vanId = 0;
let plate = '';
let tourTitle = '';
let driverA = 0;
let driverB = 0;
let officeUserId = 0;
let stopIds: number[] = [];

describeWithDb('driver.trip', () => {
  beforeAll(async () => {
    const suffix = unique();
    const [row] = await getDb()
      .insert(users)
      .values({
        name: `Trip Detail Office ${suffix}`,
        email: `tripdetail_${suffix}@example.test`,
        passwordHash: '__tripdetail_not_a_hash__',
        role: 'owner',
        isActive: true,
      });
    created.userIds.push(row.insertId);
    officeUserId = row.insertId;
  }, 30_000);

  afterAll(async () => {
    const pool = getPool();
    for (const id of created.userIds) {
      await pool.query('DELETE FROM users WHERE id = ?', [id]);
    }
    created.userIds = [];
  });

  beforeEach(async () => {
    const db = getDb();
    // Any civil date: nothing in this procedure buckets or expires, so the
    // date is data rather than a clock question (there is no `now` here).
    TOUR_DATE = manilaCivilDate(new Date());

    expect(await count(sql`SELECT COUNT(*) n FROM vans`), 'leftover vans in rg_travel_test').toBe(
      0,
    );
    expect(
      await count(sql`SELECT COUNT(*) n FROM drivers`),
      'leftover drivers in rg_travel_test',
    ).toBe(0);

    const slug = `__tripdetail__${unique()}`;
    const [destination] = await db.insert(destinations).values({ name: slug, slug });
    created.destIds.push(destination.insertId);
    tourTitle = `Trip Detail Tour ${slug}`;
    const [tour] = await db
      .insert(tours)
      .values({ slug, title: tourTitle, destinationId: destination.insertId, isActive: true });
    created.tourIds.push(tour.insertId);
    tourId = tour.insertId;

    // Three stops, so `progress.total` is four with trip start — the
    // pseudo-stop Task 3 counts and this task must NOT adjust.
    stopIds = [];
    for (const [name, sortOrder] of [
      ['Simala Shrine', 1],
      ['Kawasan Falls', 2],
      ['Lunch stop', 3],
    ] as const) {
      const [stop] = await db
        .insert(tourItineraryStops)
        .values({ tourId: tour.insertId, sortOrder, name });
      stopIds.push(stop.insertId);
    }

    plate = `TDV${unique()}`.slice(0, 20);
    const [van] = await db.insert(vans).values({
      plate,
      model: 'Trip Detail Fixture Van',
      capacity: 12,
      status: 'available',
      isActive: true,
    });
    created.vanIds.push(van.insertId);
    vanId = van.insertId;

    driverA = await makeDriver('A');
    driverB = await makeDriver('B');
  }, 30_000);

  afterEach(async () => {
    const pool = getPool();
    for (const id of created.bookingIds) {
      await pool.query('DELETE FROM payments WHERE booking_id = ?', [id]);
      await pool.query('DELETE FROM booking_notes WHERE booking_id = ?', [id]);
      await pool.query('DELETE FROM trip_checkpoints WHERE booking_id = ?', [id]);
      await pool.query('DELETE FROM bookings WHERE id = ?', [id]);
    }
    for (const id of created.tourIds) {
      await pool.query('DELETE FROM tour_itinerary_stops WHERE tour_id = ?', [id]);
      await pool.query('DELETE FROM tours WHERE id = ?', [id]);
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

  /* ---------------------------------------------------------------- *
   * §8's payment box — three states, exact centavos.
   * ---------------------------------------------------------------- */

  it('says FULLY PAID when the booking owes nothing', async () => {
    const booking = await makeBooking({ driverId: driverA, paidCentavos: TOTAL });
    const detail = await driverCaller(driverA).driver.trip({ bookingId: booking.id });
    expect(detail.payment).toEqual<PaymentBoxState>({ kind: 'fully_paid' });
  });

  it('says COLLECT the exact balance when a deposit was paid and nothing is pending', async () => {
    const booking = await makeBooking({ driverId: driverA, paidCentavos: DEPOSIT });
    const detail = await driverCaller(driverA).driver.trip({ bookingId: booking.id });
    // ₱4,000.00 total less a ₱1,200.00 deposit is ₱2,800.00 — the figure,
    // not "greater than zero". A box that is out by a peso is a box that
    // sends a driver back to the van to argue.
    expect(detail.payment).toEqual<PaymentBoxState>({
      kind: 'collect_cash',
      amountCentavos: TOTAL - DEPOSIT,
    });
  });

  it('says DO NOT COLLECT while a manual receipt is still pending, though the arithmetic says otherwise', async () => {
    // The double-charge case: the guest transferred the whole amount and
    // uploaded the receipt, so `amount_paid_centavos` is still zero and the
    // subtraction alone would send the driver to collect ₱4,000 again.
    const booking = await makeBooking({ driverId: driverA, paidCentavos: 0 });
    await makePayment({ bookingId: booking.id, status: 'pending', method: 'bank_transfer' });
    const detail = await driverCaller(driverA).driver.trip({ bookingId: booking.id });
    expect(detail.payment).toEqual<PaymentBoxState>({ kind: 'unverified_do_not_collect' });
  });

  it('says DO NOT COLLECT when cash a driver already recorded is awaiting finance', async () => {
    // §8 item 5: a driver's tap writes one `pending` `provider=manual`,
    // `method=cash` row and moves NOTHING on the booking. A second driver
    // screen (or the same one after a refresh) must not ask for the money
    // again before finance has reconciled it.
    const booking = await makeBooking({ driverId: driverA, paidCentavos: DEPOSIT });
    await makePayment({
      bookingId: booking.id,
      status: 'pending',
      method: 'cash',
      amountCentavos: TOTAL - DEPOSIT,
      collectedByDriverId: driverA,
    });
    const detail = await driverCaller(driverA).driver.trip({ bookingId: booking.id });
    expect(detail.payment).toEqual<PaymentBoxState>({ kind: 'unverified_do_not_collect' });
  });

  it('says DO NOT COLLECT when payment_review_required is set, with no pending row at all', async () => {
    // The other half of the middle state, and a different cause: money
    // landed on a booking whose hold had lapsed, so it was credited and
    // flagged for an admin instead of re-confirming the trip. Nothing is
    // `pending` here — the flag alone must hold the box.
    const booking = await makeBooking({
      driverId: driverA,
      paidCentavos: DEPOSIT,
      reviewRequired: true,
    });
    const detail = await driverCaller(driverA).driver.trip({ bookingId: booking.id });
    expect(detail.payment).toEqual<PaymentBoxState>({ kind: 'unverified_do_not_collect' });
  });

  /**
   * The deliberate precedence, pinned: **`fully_paid` wins.**
   *
   * No money moves either way — neither state collects — so this is a
   * choice about words, made for §8's own copy: the unverified state reads
   * "Not paid — don't collect, call office", and a booking with a zero
   * balance is not "not paid". Telling a driver it is produces a phone call
   * whose answer is "they're paid, go", while the van waits.
   *
   * If this is ever reversed, reverse it here first and say why.
   */
  it('prefers FULLY PAID over the review flag when a settled booking is also flagged', async () => {
    const booking = await makeBooking({
      driverId: driverA,
      paidCentavos: TOTAL,
      reviewRequired: true,
    });
    const detail = await driverCaller(driverA).driver.trip({ bookingId: booking.id });
    expect(detail.payment).toEqual<PaymentBoxState>({ kind: 'fully_paid' });
  });

  /**
   * The state machine's sharp edge. `rejected` and `superseded` are dead
   * rows — a transfer that failed, and a receipt the guest replaced — and
   * neither is in any decision path any more (schema: "only a `pending` row
   * can be approved or rejected"). A box held in "do not collect" by one
   * would mean the balance could never be taken from that guest again.
   */
  it('still says COLLECT the exact balance when the only payment rows are rejected or superseded', async () => {
    const booking = await makeBooking({ driverId: driverA, paidCentavos: DEPOSIT });
    await makePayment({ bookingId: booking.id, status: 'superseded' });
    await makePayment({ bookingId: booking.id, status: 'rejected' });
    const detail = await driverCaller(driverA).driver.trip({ bookingId: booking.id });
    expect(detail.payment).toEqual<PaymentBoxState>({
      kind: 'collect_cash',
      amountCentavos: TOTAL - DEPOSIT,
    });
  });

  it('is not held by a rejected row when a pending one also exists', async () => {
    // Both at once is the real receipt flow: the first upload was rejected,
    // the guest sent another. The live row is what counts.
    const booking = await makeBooking({ driverId: driverA, paidCentavos: 0 });
    await makePayment({ bookingId: booking.id, status: 'rejected' });
    await makePayment({ bookingId: booking.id, status: 'pending' });
    const detail = await driverCaller(driverA).driver.trip({ bookingId: booking.id });
    expect(detail.payment).toEqual<PaymentBoxState>({ kind: 'unverified_do_not_collect' });
  });

  /* ---------------------------------------------------------------- *
   * The payload §8 asks for, and nothing else.
   * ---------------------------------------------------------------- */

  it('carries the trip, the lead guest phone, the pickup, the van and the office notes', async () => {
    const booking = await makeBooking({ driverId: driverA, paidCentavos: DEPOSIT });
    const db = getDb();
    // Oldest first is the order a driver reads instructions in, so the two
    // notes are inserted with timestamps that disagree with nothing else.
    await db.insert(bookingNotes).values({
      bookingId: booking.id,
      userId: officeUserId,
      note: 'Guest waiting at the second gate, not the lobby.',
      createdAt: new Date('2026-11-01T01:00:00Z'),
    });
    await db.insert(bookingNotes).values({
      bookingId: booking.id,
      userId: officeUserId,
      note: 'One guest is in a wheelchair; front seat.',
      createdAt: new Date('2026-11-01T02:00:00Z'),
    });

    const detail = await driverCaller(driverA).driver.trip({ bookingId: booking.id });

    expect(detail.bookingId).toBe(booking.id);
    expect(detail.ref).toBe(booking.ref);
    expect(detail.tourTitle).toBe(tourTitle);
    expect(detail.tourDate).toBe(TOUR_DATE);
    expect(detail.pax).toBe(4);
    expect(detail.status).toBe('assigned');
    expect(detail.leadName).toBe('Trip Detail Lead Guest');
    // §8: the driver calls or texts the lead guest. This is the field that
    // makes the NOT_FOUND test below a security property.
    expect(detail.leadPhone).toBe(LEAD_PHONE);
    expect(detail.pickup).toBe('Radisson Blu lobby');
    expect(detail.pickupMapsUrl).toBe('https://maps.example.test/radisson');
    expect(detail.vanPlate).toBe(plate);
    expect(detail.officeNotes).toEqual([
      'Guest waiting at the second gate, not the lobby.',
      'One guest is in a wheelchair; front seat.',
    ]);
  });

  it('renders a trip with no van, no pickup and no notes rather than hiding it', async () => {
    // `van_id`, `pickup` and `pickup_map_url` are all nullable, and a trip
    // can be confirmed before dispatch assigns a van. A screen that needed
    // them would be a driver with no manifest.
    const booking = await makeBooking({
      driverId: driverA,
      vanId: null,
      pickup: null,
      pickupMapUrl: null,
      paidCentavos: TOTAL,
    });
    const detail = await driverCaller(driverA).driver.trip({ bookingId: booking.id });
    expect(detail.vanPlate).toBeNull();
    expect(detail.pickup).toBeNull();
    expect(detail.pickupMapsUrl).toBeNull();
    expect(detail.officeNotes).toEqual([]);
  });

  /**
   * RA 10173, and the inverse of the test above: what is NOT on the wire.
   *
   * Asserted over the SERIALISED payload, the way `portal-booking.test.ts`
   * does, because that is what actually leaves the server — a field nested
   * two levels down inside `progress` would slip past a key check on the
   * top-level object.
   */
  it('puts no e-mail, no totals and no review flag on the wire', async () => {
    const booking = await makeBooking({
      driverId: driverA,
      paidCentavos: DEPOSIT,
      reviewRequired: true,
    });
    const detail = await driverCaller(driverA).driver.trip({ bookingId: booking.id });
    const serialised = JSON.stringify(detail);

    expect(serialised).not.toContain(LEAD_EMAIL);
    expect(serialised).not.toContain('leadEmail');
    // The box is the answer; its inputs are not a driver's business, and a
    // client that cannot see them cannot re-derive a different answer.
    expect(serialised).not.toContain('totalCentavos');
    expect(serialised).not.toContain('paidCentavos');
    expect(serialised).not.toContain('amountPaid');
    expect(serialised).not.toContain('paymentReviewRequired');
    expect(serialised).not.toContain('priceSnapshot');
    // The guest's own free-text requests are an admin field, not one §8
    // lists on this screen.
    expect(serialised).not.toContain('requests');
  });

  /* ---------------------------------------------------------------- *
   * `progress` is Task 3's answer, unchanged.
   * ---------------------------------------------------------------- */

  it('returns tripProgress unchanged, trip-start pseudo-stop and all', async () => {
    const booking = await makeBooking({ driverId: driverA, paidCentavos: TOTAL });
    const detail = await driverCaller(driverA).driver.trip({ bookingId: booking.id });
    const direct = await tripProgress(getDb(), booking.id);

    expect(detail.progress).toEqual(direct);
    // Three itinerary stops read 0 / 4: trip start is counted (Task 3's
    // rule, which this task must not adjust).
    expect(detail.progress.total).toBe(4);
    expect(detail.progress.done).toBe(0);
    expect(detail.progress.stops.map((stop) => stop.name)).toEqual([
      TRIP_START_STOP_NAME,
      'Simala Shrine',
      'Kawasan Falls',
      'Lunch stop',
    ]);
    expect(detail.progress.stops.map((stop) => stop.stopId)).toEqual([null, ...stopIds]);
  });

  /* ---------------------------------------------------------------- *
   * Another driver's trip: NOT_FOUND, never FORBIDDEN.
   * ---------------------------------------------------------------- */

  /**
   * The enumeration oracle, and the reason the code is `NOT_FOUND`: a 403
   * means "this exists and is not yours", which over a numeric id is a tool
   * for walking every booking on the system — and what it would be walking
   * towards is a page carrying a guest's phone number.
   */
  it('answers NOT_FOUND, never FORBIDDEN, for another driver trip', async () => {
    const theirs = await makeBooking({ driverId: driverB, paidCentavos: DEPOSIT });
    await expect(driverCaller(driverA).driver.trip({ bookingId: theirs.id })).rejects.toMatchObject(
      { code: 'NOT_FOUND' },
    );
  });

  it('tells a driver asking for another driver trip nothing about it', async () => {
    const theirs = await makeBooking({ driverId: driverB, paidCentavos: DEPOSIT });
    const refusal = await driverCaller(driverA)
      .driver.trip({ bookingId: theirs.id })
      .then(
        () => null,
        (error: { message?: string }) => error,
      );
    expect(refusal, 'the call resolved instead of being refused').not.toBeNull();
    const message = String(refusal?.message ?? '');
    expect(message).not.toContain(String(theirs.id));
    expect(message).not.toContain(theirs.ref);
    expect(message).not.toContain(LEAD_PHONE);
    expect(message.toLowerCase()).not.toContain('driver');
  });

  it('answers the SAME refusal for a booking id that does not exist', async () => {
    // Indistinguishable from the test above, which is the property: the
    // two answers must not let a caller tell "not yours" from "not there".
    const theirs = await makeBooking({ driverId: driverB, paidCentavos: DEPOSIT });
    const codeAndMessage = async (bookingId: number) =>
      await driverCaller(driverA)
        .driver.trip({ bookingId })
        .then(
          () => null,
          (error: { code?: string; message?: string }) => ({
            code: error.code,
            message: error.message,
          }),
        );

    const missing = await codeAndMessage(2_000_000_000);
    const notMine = await codeAndMessage(theirs.id);
    expect(missing).not.toBeNull();
    expect(missing).toEqual(notMine);
    expect(missing?.code).toBe('NOT_FOUND');
  });

  it('refuses an input that names a driver at all', async () => {
    // `.strict()`: a request carrying a `driverId` is refused rather than
    // silently ignored, because a field quietly dropped is a field somebody
    // will one day decide to honour.
    const mine = await makeBooking({ driverId: driverA, paidCentavos: TOTAL });
    await expect(
      driverCaller(driverA).driver.trip({ bookingId: mine.id, driverId: driverB } as never),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });
});
