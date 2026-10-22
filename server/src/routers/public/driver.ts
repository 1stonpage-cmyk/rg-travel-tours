/**
 * `driver.trips` — the driver portal's trip list (Week 6 plan, Task 2;
 * BUILD_SPEC §8 "Driver sees their assigned trips: today, upcoming,
 * history").
 *
 * **The first `driverProcedure` ever mounted on `appRouter`.** Task 1 built
 * the gate and could only prove it against a test-local router, because
 * `procedure-role-metadata.test.ts` did not yet recognise the `driver`
 * access kind. This task taught that guard the kind, so every driver
 * procedure from here on is enumerated and must refuse an anonymous, a
 * staff and a customer caller — see the `driver` branch in that file.
 *
 * ## The filter comes from the session and nowhere else
 *
 * `ctx.driver.driverId` is the whole `WHERE`. There is no input on this
 * procedure, so there is no field through which to ask for another
 * driver's day — not a `driverId`, not a `ref`, not a date. That is the
 * control, and it is structural rather than remembered: `requireDriver`
 * put the id there, and a resolver that reached for one anywhere else
 * would have to invent it.
 *
 * ## One query, not one per row
 *
 * `tours` is joined for the title and `vans` left-joined for the plate —
 * `bookings.van_id` is nullable (a trip can be confirmed before dispatch
 * assigns a van) and such a trip must still appear, so `leftJoin` and a
 * `null` plate rather than an inner join that would silently drop it.
 *
 * ## "Today" is the Manila civil date, and `now` is explicit
 *
 * The clock is read ONCE, in the resolver, at the request boundary — the
 * same place `driver.login` reads it — and passed into `listDriverTrips`
 * as an argument. CLAUDE.md's rule, and the reason for it: a clock read
 * inside the query could not be tested at the 16:00 UTC boundary without
 * faking timers globally, which is how a timezone bug survives its own
 * suite. The client sends no time either way, so a driver cannot ask to be
 * shown yesterday's work as today's.
 *
 * `manilaCivilDate(now)` then feeds the pure `driverTripBucket` from
 * `@rg/shared` — the same function the tabs use, which is why the client
 * cannot disagree with this list. The 00:00-07:59 Manila window, where the
 * UTC calendar day is still yesterday, answers correctly without anyone
 * having to remember it exists.
 */
import { and, asc, eq } from 'drizzle-orm';
import { TRPCError } from '@trpc/server';
import {
  driverStopCheckInSchema,
  driverTripBucket,
  driverTripInputSchema,
  driverUndoCheckInSchema,
  manilaCivilDate,
  type CashClaimResult,
  type CheckInResult,
  type CheckInUndoResult,
  type DriverTripRow,
  type PaymentBoxState,
  type TripDetail,
} from '@rg/shared';
import { getDb } from '../../db/client';
import { bookingNotes, bookings, payments, tours, vans } from '../../db/schema';
import { recordPendingCash } from '../../services/payments/record-payment';
import {
  checkInStop,
  completeTrip,
  runCheckIn,
  startTrip,
  undoLastCheckIn,
} from '../../services/trips/checkins';
import { tripProgress } from '../../services/trips/progress';
import { driverProcedure, router } from '../../trpc';

/**
 * Every trip assigned to ONE driver, oldest first, each carrying the bucket
 * it belongs in as of `now`.
 *
 * ALL of them, not just today's: §8's three tabs are one request, and a
 * driver with no signal at a pier has whatever the last load gave them.
 * Ordered `tour_date` ascending (then `id`, so two trips on one day have a
 * stable order rather than whatever the engine returns).
 *
 * No status filter. A cancelled or expired trip the driver was assigned to
 * still belongs in their history — hiding it would leave a driver who drove
 * to a pickup unable to see the trip that sent them there.
 *
 * `driverId` is a plain argument because the only caller passes
 * `ctx.driver.driverId`; `now` is a plain argument so a test can stand on
 * the 16:00 UTC boundary without faking the clock. Exported for that test
 * and for no other reason — nothing else may call it with a driver id it
 * did not get from a driver's own session.
 */
export async function listDriverTrips(driverId: number, now: Date): Promise<DriverTripRow[]> {
  const todayManila = manilaCivilDate(now);

  const rows = await getDb()
    .select({
      bookingId: bookings.id,
      ref: bookings.ref,
      tourTitle: tours.title,
      tourDate: bookings.tourDate,
      pax: bookings.pax,
      status: bookings.status,
      vanPlate: vans.plate,
    })
    .from(bookings)
    .innerJoin(tours, eq(tours.id, bookings.tourId))
    .leftJoin(vans, eq(vans.id, bookings.vanId))
    .where(eq(bookings.driverId, driverId))
    .orderBy(asc(bookings.tourDate), asc(bookings.id));

  return rows.map((row) => {
    /*
     * `bookings.tour_date` is a `date()` column, so Drizzle hands back a
     * `Date` and every consumer wants the civil string — the same
     * conversion `admin/bookings.ts` and the expiry job apply, through the
     * same helper. A `toISOString().slice(0, 10)` here would be the UTC
     * day, which is the one bug this whole feature is shaped around.
     */
    const tourDate = manilaCivilDate(row.tourDate);
    return { ...row, tourDate, bucket: driverTripBucket(tourDate, todayManila) };
  });
}

/* ------------------------------------------------------------------ *
 * `driver.trip` — one trip, and §8's payment box (Week 6 plan, Task 4)
 * ------------------------------------------------------------------ */

/**
 * §8's payment box, decided **here and only here**.
 *
 * Pure, and taking four plain values rather than a booking row, so the one
 * decision that tells a human whether to take money from another human can
 * be read in full in eight lines. The client receives the ANSWER
 * (`PaymentBoxState`) and never these inputs: a second derivation in the
 * browser is a second chance to get it wrong, and the browser is also the
 * one place whose numbers cannot be trusted (CLAUDE.md — the server
 * computes all money).
 *
 * ## The order of these three branches is the whole function
 *
 * **1. `fully_paid` first.** `amount_paid_centavos >= total_centavos` means
 * nothing is owed, and nothing owed is the end of the question. It is also
 * checked ahead of the review flag deliberately: §8's copy for the
 * unverified state begins "Not paid", and saying that about a booking whose
 * balance is zero is a phone call to the office whose answer is "they're
 * paid, go" — made while a van waits. No money moves on this choice (the
 * driver collects in neither state), so it is a choice about words, and the
 * true words win. `driver-trip-detail.test.ts` pins it.
 *
 * **2. `unverified_do_not_collect` next, and BEFORE the arithmetic.** A
 * `pending` payment is money a guest says they have sent that nobody has
 * verified — a receipt awaiting an admin (§6) or cash a driver already
 * recorded (§8 item 5). Neither moves `amount_paid_centavos`, so the
 * subtraction in branch 3 would cheerfully send the driver to collect a
 * balance that has already been handed over. That is the double charge, and
 * it is the reason this branch exists. `payment_review_required` joins it
 * for a different reason: that flag means money landed on a booking the
 * system would not re-confirm by itself, so an admin — not a driver at a
 * pickup — decides what happens next.
 *
 * **3. `collect_cash` last, for exactly the difference.** Integers in
 * centavos, subtracted on the server. Reachable only when the booking is
 * short AND nothing is pending AND nothing is flagged, so `amountCentavos`
 * is always positive here.
 *
 * `hasPendingPayment` is deliberately NOT narrowed to `provider='manual'`,
 * even though both writers of a `pending` row today are manual
 * (`recordPendingCash`, the receipt upload — `recordPayment` writes `paid`
 * or `refunded` and never `pending`). The safe direction for an unknown
 * pending row is "do not collect, call office": a provider added later is
 * held by this branch until someone decides otherwise, rather than falling
 * through to a driver asking for money twice.
 */
function paymentBox(input: {
  totalCentavos: number;
  paidCentavos: number;
  reviewRequired: boolean;
  hasPendingPayment: boolean;
}): PaymentBoxState {
  if (input.paidCentavos >= input.totalCentavos) return { kind: 'fully_paid' };
  if (input.hasPendingPayment || input.reviewRequired) {
    return { kind: 'unverified_do_not_collect' };
  }
  return { kind: 'collect_cash', amountCentavos: input.totalCentavos - input.paidCentavos };
}

/**
 * The trip row and §8's payment box — the two things BOTH driver-facing
 * money surfaces need, read once, here.
 *
 * Extracted in Task 8 so that `driver.recordCash` derives what is owed from
 * the SAME two statements and the SAME `paymentBox` as `driver.trip`. A
 * second `total_centavos - amount_paid_centavos` in the mutation would be a
 * second chance for the figure on the screen and the figure in the claim to
 * disagree, and a cash claim that disagrees with what the driver was shown
 * is an argument at a pier that the audit trail cannot settle.
 *
 * ## `driverId` is half of the WHERE, not a check afterwards
 *
 * `WHERE id = ? AND driver_id = ?`. A booking that belongs to another
 * driver and a booking id that does not exist return the same zero rows and
 * therefore the same refusal, which is the point: a `FORBIDDEN` would
 * confirm the booking exists, and over a numeric id that is a tool for
 * walking every booking on the system — towards a payload that carries a
 * guest's phone number (RA 10173). The message names neither the id nor the
 * ref, and says nothing about drivers.
 *
 * ## No `now`
 *
 * Nothing here is bucketed, expired or compared against the clock —
 * `tourDate` is read straight out of the row and `paymentBox` compares two
 * integers. Callers that DO need the clock (the cash claim's today-only
 * rule) take their own explicit `now`, so this stays a pure read.
 */
async function loadDriverTrip(driverId: number, bookingId: number) {
  const db = getDb();

  const [trip] = await db
    .select({
      bookingId: bookings.id,
      ref: bookings.ref,
      tourTitle: tours.title,
      tourDate: bookings.tourDate,
      pax: bookings.pax,
      status: bookings.status,
      leadName: bookings.leadName,
      leadPhone: bookings.leadPhone,
      pickup: bookings.pickup,
      pickupMapsUrl: bookings.pickupMapUrl,
      vanPlate: vans.plate,
      /*
       * The payment box's three inputs, read here and consumed by
       * `paymentBox` below — none of them reaches the client.
       *
       * Aliased `paidCentavos`, never `amountPaidCentavos:`, exactly as
       * `portal.ts` and `manual-receipt.ts` are: `schema-conventions.test.ts`
       * reads any `amountPaidCentavos:` in the server tree as a WRITE of
       * that column, and only the payments service may write it.
       */
      totalCentavos: bookings.totalCentavos,
      paidCentavos: bookings.amountPaidCentavos,
      reviewRequired: bookings.paymentReviewRequired,
    })
    .from(bookings)
    .innerJoin(tours, eq(tours.id, bookings.tourId))
    .leftJoin(vans, eq(vans.id, bookings.vanId))
    .where(and(eq(bookings.id, bookingId), eq(bookings.driverId, driverId)))
    .limit(1);

  if (!trip) {
    throw new TRPCError({ code: 'NOT_FOUND', message: 'No trip with that id.' });
  }

  /*
   * Does ONE unverified payment row exist? `limit(1)` and no aggregate: the
   * question is existence, and a count would read every row to answer a
   * yes/no. `type = 'payment'` because a refund is never `pending` and a
   * refund is not money a driver would be asked to collect either way.
   */
  const [pending] = await db
    .select({ id: payments.id })
    .from(payments)
    .where(
      and(
        eq(payments.bookingId, bookingId),
        eq(payments.type, 'payment'),
        eq(payments.status, 'pending'),
      ),
    )
    .limit(1);

  return {
    trip,
    payment: paymentBox({
      totalCentavos: trip.totalCentavos,
      paidCentavos: trip.paidCentavos,
      reviewRequired: trip.reviewRequired,
      hasPendingPayment: pending !== undefined,
    }),
  };
}

/**
 * One trip, for the driver driving it — §8's "Trip detail" screen.
 *
 * ## Four statements, whatever the trip
 *
 * `loadDriverTrip`'s two (the trip row, the pending-payment probe), the
 * office notes, and `tripProgress()`'s own two. Nothing loops over a query.
 *
 * Exported for the test that drives it directly and for nothing else:
 * nothing may call it with a driver id it did not get from a driver's own
 * session.
 */
export async function driverTripDetail(driverId: number, bookingId: number): Promise<TripDetail> {
  const db = getDb();
  const { trip, payment } = await loadDriverTrip(driverId, bookingId);

  /*
   * §8's "Office notes" — `booking_notes`, oldest first, the TEXT only. The
   * driver needs the instruction ("guest waiting at the second gate"), not
   * who typed it or when; the admin surface has that, and this payload is
   * the most sensitive one in the portal.
   *
   * `created_at` then `id`, so two notes written in the same second have a
   * stable order rather than whatever the engine returns.
   */
  const notes = await db
    .select({ note: bookingNotes.note })
    .from(bookingNotes)
    .where(
      and(
        eq(bookingNotes.bookingId, bookingId),
        /*
         * §8's "Office notes", and ONLY the ones the office marked for the
         * driver (owner decision 2026-10-16, D6). The filter is in the
         * WHERE, not a `.filter()` on the result: a note the driver may not
         * read must not travel to the browser at all, where it would sit in
         * a network response and a React cache regardless of what renders.
         */
        eq(bookingNotes.visibleToDriver, true),
      ),
    )
    .orderBy(asc(bookingNotes.createdAt), asc(bookingNotes.id));

  return {
    bookingId: trip.bookingId,
    ref: trip.ref,
    tourTitle: trip.tourTitle,
    /*
     * `bookings.tour_date` is a `date()` column, so Drizzle hands back a
     * `Date` and every consumer wants the civil string — through the same
     * helper `listDriverTrips` uses. A `toISOString().slice(0, 10)` here
     * would be the UTC day.
     */
    tourDate: manilaCivilDate(trip.tourDate),
    pax: trip.pax,
    status: trip.status,
    leadName: trip.leadName,
    leadPhone: trip.leadPhone,
    pickup: trip.pickup,
    pickupMapsUrl: trip.pickupMapsUrl,
    vanPlate: trip.vanPlate,
    officeNotes: notes.map((row) => row.note),
    payment,
    /** Task 3's answer, unchanged — `total` counts the trip-start stop. */
    progress: await tripProgress(db, bookingId),
  };
}

/* ------------------------------------------------------------------ *
 * §8 item 5 — cash collected (Week 6 plan, Task 8)
 * ------------------------------------------------------------------ */

/**
 * A driver records that a guest handed them cash — **a claim, not a
 * reconciliation** (BUILD_SPEC §8 item 5).
 *
 * ## This function writes nothing itself
 *
 * `recordPendingCash()` does, and it is the only thing in the system that
 * may: one `payments` row (`provider='manual'`, `method='cash'`,
 * `status='pending'`, `collected_by_driver_id` set) plus its
 * `payment.cash_collected` audit row, and **nothing on `bookings`**. Not
 * `amount_paid_centavos`, not `status`, not `payment_review_required`.
 * Everything here is the decision of WHETHER to let that happen.
 *
 * The reason the split exists is a fraud path: a driver who could verify
 * their own collection could pocket the cash and leave the booking reading
 * "paid in full". So finance or the owner converts that same row from
 * `pending` to `paid` and credits the booking under its lock
 * (`verifyCashPayment()`, which refuses a `driver` actor outright). One row
 * for its whole life, two people.
 *
 * ## The amount is derived, never received
 *
 * There is no amount on the input. `loadDriverTrip` hands back the very
 * `PaymentBoxState` the trip screen was given, and `collect_cash` carries
 * the balance in centavos — computed on the server from
 * `total_centavos - amount_paid_centavos`. The browser cannot name a figure
 * (CLAUDE.md: the server computes all money), and the figure claimed is by
 * construction the figure the driver was shown.
 *
 * Any other box state is a refusal rather than a claim of zero:
 * `fully_paid` means nothing is owed, and `unverified_do_not_collect` means
 * money is already claimed and unverified — which is also what a second tap
 * of this button looks like, because the first tap's `pending` row puts the
 * box there. `recordPendingCash()` is right not to merge two claims
 * silently; refusing the second one loudly is not merging it.
 *
 * ## Today only, and decided on the server
 *
 * Owner-accepted 2026-10-15 (Q9). A trip whose tour date is not today in
 * **Manila** is refused here, not merely hidden by Task 10's screen —
 * hiding a button is not access control. A driver tapping "collect cash" on
 * next week's trip is almost certainly a mis-tap, and the refusal is what
 * makes it harmless.
 *
 * `now` is an explicit argument, read once at the request boundary like
 * every other clock read in this file: a `new Date()` inside this function
 * could not be tested at 00:30 Manila — inside the 00:00-07:59 window where
 * the UTC calendar day is still yesterday — without faking timers globally,
 * which is how a timezone bug survives its own suite.
 *
 * Exported for the test that stands on that boundary and for nothing else:
 * nothing may call it with a driver id it did not get from a driver's own
 * session.
 */
export async function recordDriverCash(
  driverId: number,
  bookingId: number,
  now: Date,
): Promise<CashClaimResult> {
  const { trip, payment } = await loadDriverTrip(driverId, bookingId);

  /*
   * Both sides through `manilaCivilDate`: `bookings.tour_date` is a `date()`
   * column, so Drizzle hands back a `Date`, and a civil date is a string
   * (CLAUDE.md). Comparing either side's UTC day would accept the wrong
   * trip for the first eight hours of every Manila day.
   */
  if (manilaCivilDate(trip.tourDate) !== manilaCivilDate(now)) {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'Cash can only be recorded on the day of the trip.',
    });
  }

  if (payment.kind !== 'collect_cash') {
    throw new TRPCError({
      code: 'CONFLICT',
      message: 'There is nothing to collect on this trip right now. Please call the office.',
    });
  }

  const { paymentId } = await recordPendingCash({
    bookingId,
    amountCentavos: payment.amountCentavos,
    collectedByDriverId: driverId,
  });

  return { paymentId, amountCentavos: payment.amountCentavos };
}

export const driverTripsRouter = router({
  /**
   * The signed-in driver's trips. **No input at all**, by design: the
   * driver id comes from `ctx.driver`, so there is no field through which
   * to ask for another driver's day, and `now` is this server's clock.
   */
  trips: driverProcedure.query(
    async ({ ctx }): Promise<DriverTripRow[]> =>
      await listDriverTrips(ctx.driver.driverId, new Date()),
  ),

  /**
   * One trip's detail, including §8's payment box.
   *
   * The input is a `bookingId` and **nothing else** — `.strict()`, so a
   * request carrying a `driverId` is refused rather than silently ignored.
   * The driver still comes from `ctx.driver.driverId`, which NARROWS the
   * booking id; it is never widened by anything the caller sends.
   */
  trip: driverProcedure
    .input(driverTripInputSchema)
    .query(
      async ({ ctx, input }): Promise<TripDetail> =>
        await driverTripDetail(ctx.driver.driverId, input.bookingId),
    ),

  /* ---------------------------------------------------------------- *
   * §8's check-ins (Week 6 plan, Task 5)
   *
   * Three mutations, one transaction each, and the SAME two rules on all
   * three: the driver comes from `ctx.driver.driverId` and the clock from
   * this server. The inputs are `.strict()` and carry neither a driver nor
   * a timestamp — `trip_checkpoints.checked_at` is server time, so there is
   * no field through which a handset three hours out of sync, or a driver
   * who would rather the record said 06:00, can say when a stop happened.
   *
   * `new Date()` is read HERE, once, at the request boundary — the same
   * place `driver.trips` and `driver.login` read it — and passed down as an
   * argument (CLAUDE.md: time-dependent code takes an explicit `now`).
   *
   * A refusal comes back as `{ ok: false, reason }` rather than a thrown
   * error, the contract `assignVanAndDriver` carries: "you already tapped
   * that" is an ordinary outcome of a van with one bar of signal, and a
   * `TRPCError` would reach the screen as a failure instead of as a shrug.
   *
   * `runCheckIn()` (in `services/trips/checkins.ts`) owns the transaction:
   * one per call, retried if InnoDB kills it as a deadlock victim, and a
   * refusal discovered after a write comes back as a verdict with the write
   * rolled back. The reasoning for all three lives with the locking it
   * protects rather than here — see that function.
   * ---------------------------------------------------------------- */

  /** §8 item 1 — Start trip: booking `in_progress`, van `on_trip`. */
  startTrip: driverProcedure.input(driverTripInputSchema).mutation(
    async ({ ctx, input }): Promise<CheckInResult> =>
      await runCheckIn(
        async (tx) =>
          await startTrip(tx, {
            bookingId: input.bookingId,
            driverId: ctx.driver.driverId,
            now: new Date(),
          }),
      ),
  ),

  /** §8 item 2 — one stop, on arrival. The last one completes the trip. */
  checkIn: driverProcedure.input(driverStopCheckInSchema).mutation(
    async ({ ctx, input }): Promise<CheckInResult> =>
      await runCheckIn(
        async (tx) =>
          await checkInStop(tx, {
            bookingId: input.bookingId,
            stopId: input.stopId,
            driverId: ctx.driver.driverId,
            now: new Date(),
          }),
      ),
  ),

  /** §8 item 3 — Complete trip: booking `completed`, van freed. */
  completeTrip: driverProcedure.input(driverTripInputSchema).mutation(
    async ({ ctx, input }): Promise<CheckInResult> =>
      await runCheckIn(
        async (tx) =>
          await completeTrip(tx, {
            bookingId: input.bookingId,
            driverId: ctx.driver.driverId,
          }),
      ),
  ),

  /**
   * §8 item 4 — Undo the last check-in, or reopen a trip that was completed
   * by mistake (owner decisions 2026-10-15, Q4 and Q5).
   *
   * The ONLY input on the four that carries a second field, and it is a
   * **required `reason`** — `driverUndoCheckInSchema`, so an empty or
   * whitespace-only reason is a `BAD_REQUEST` at the input stage and never
   * reaches the service. An undo rewrites what the system says happened on a
   * trip; the reason is the one part of it a column cannot infer, so it is
   * refused rather than defaulted.
   *
   * Still no timestamp and still no driver: `undone_at` is this server's
   * clock, read here at the request boundary like the other three, and
   * `undone_by` is `ctx.driver.driverId` — a DRIVER, which is what that
   * column means.
   */
  /**
   * §8 item 5 — the guest paid cash. **A claim, never a settlement.**
   *
   * `driverTripInputSchema`, the same `.strict()` `{ bookingId }` the other
   * four take: **no amount and no driver**. The amount is derived on the
   * server from the booking, and the driver is `ctx.driver.driverId` —
   * which also NARROWS the booking id, so another driver's booking is a
   * `NOT_FOUND` rather than a claim against someone else's trip.
   *
   * `new Date()` is read HERE, at the request boundary, and passed down: the
   * today-only rule is decided against this server's clock and never
   * against a handset's, so a driver cannot claim next week's trip by
   * winding their phone forward.
   */
  recordCash: driverProcedure
    .input(driverTripInputSchema)
    .mutation(
      async ({ ctx, input }): Promise<CashClaimResult> =>
        await recordDriverCash(ctx.driver.driverId, input.bookingId, new Date()),
    ),

  undoCheckIn: driverProcedure.input(driverUndoCheckInSchema).mutation(
    async ({ ctx, input }): Promise<CheckInUndoResult> =>
      await runCheckIn(
        async (tx) =>
          await undoLastCheckIn(tx, {
            bookingId: input.bookingId,
            driverId: ctx.driver.driverId,
            reason: input.reason,
            now: new Date(),
          }),
      ),
  ),
});
