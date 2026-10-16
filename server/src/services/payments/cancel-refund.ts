/**
 * 6F — cancel and refund (Week 6 plan, Task 13; BUILD_SPEC §6 "Refunds &
 * cancellations", §9's "Cancel / refund" row).
 *
 * **This module composes money logic. It contains none of its own.**
 *
 * Everything dangerous about a refund already existed and was tested before
 * this file was written, and all of it lives in `record-payment.ts`: the
 * amount is always POSITIVE (direction comes from `type`, never a sign), the
 * sum of a booking's refunds may never exceed its `amount_paid_centavos`,
 * that sum is read inside the transaction under the booking row lock, only a
 * `user` actor with a real admin id may start a refund, and the audit row
 * names that admin. So there is exactly ONE `payments` insert in this
 * project, exactly one writer of `bookings.amount_paid_centavos`, and
 * neither of them is here. This file decides *which provider to ask* and
 * *whether the booking may be cancelled*, and hands the money to
 * `recordPayment()`.
 *
 * ## The four rules from §6, and where each one is kept
 *
 *  1. **Refund through the provider that TOOK the payment**, read from the
 *     payment ROW — never the currently-active provider. `refundPayment()`
 *     reads `payments.provider` and `payments.provider_ref` off the row it
 *     was given and calls `getProvider(that)`. It never calls
 *     `getActiveProvider()`, and the test file asserts that by scanning this
 *     source: a gateway switch must not send yesterday's refunds to this
 *     week's company.
 *  2. **A refund is never a booking status.** `cancelBooking()` sets
 *     `cancelled` and writes no money; `refundPayment()` writes a `payments`
 *     row and touches no status. They are two procedures because they are two
 *     decisions — §6 lets an admin cancel with no refund, and refund a trip
 *     that already ran without cancelling it.
 *  3. **Partial refunds are allowed**, so the cap is a SUM and it is checked
 *     under the lock — inside `recordPayment()`, which is the only place that
 *     check is authoritative.
 *  4. **A webhook may confirm a refund an admin initiated; it may never
 *     initiate one.** Nothing here is reachable from a webhook: both
 *     functions require an admin `users.id`, and `recordPayment()` refuses a
 *     `provider` or `system` actor on a refund on its own behalf.
 *
 * ## Why the gateway is called BEFORE the row is written
 *
 * §6 fixes the order: "call `provider.refund()` on the provider that took
 * the payment … Then record a `refund` row". The other order is worse, not
 * merely different — a row written first and a gateway that then refuses
 * leaves a booking believing it refunded money which never left, silently.
 * This way round, the failure is loud (`RefundNotRecordedError`) and names
 * the gateway's own reference so a human can reconcile it.
 *
 * The cost of that order is the pre-flight check below, which is the one
 * piece of arithmetic in this file that looks like a money rule and is
 * deliberately NOT one — see `assertRefundFitsBeforePayout()`.
 */
import { and, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { BookingStatus } from '@rg/shared';
import { getDb, type Transaction } from '../../db/client';
import { PAYMENT_METHODS, bookings, payments } from '../../db/schema';
import { writeAudit } from '../audit';
import { releaseVanFromTrip } from '../trips/checkins';
import { getProvider } from './registry';
import { recordPayment } from './record-payment';
import {
  BookingNotCancellableError,
  BookingNotFoundError,
  RefundExceedsPaidError,
  RefundNotPossibleError,
  RefundNotRecordedError,
  RefundSourcePaymentNotFoundError,
} from './errors';

/**
 * The statuses an admin may cancel FROM — an allow-list, in the shape
 * `VAN_STATUS_SELLABLE` and `STARTABLE_STATUSES` established, so a status
 * added to `BOOKING_STATUSES` later is uncancellable until somebody decides
 * otherwise.
 *
 * `in_progress` is in the list on purpose: §13's 6F is explicitly about what
 * a cancel does to a trip already under way, and the answer is that it
 * cancels. What it does NOT do is retract the check-ins already recorded —
 * see the note on `cancelBooking()` and CLAUDE.md's Dispatch section.
 *
 * `completed` is NOT in the list. A trip that ran cannot be un-run, and
 * walking a finished tour backwards through its own lifecycle is the mistake
 * `statusAfterManualVerified()` exists to prevent on the money side. It
 * costs nothing: a refund needs no cancellation, so a completed trip that
 * went badly is still refundable on its own.
 */
const CANCELLABLE_STATUSES: readonly BookingStatus[] = [
  'pending_payment',
  'pending_verification',
  'confirmed',
  'assigned',
  'in_progress',
];

/**
 * Both inputs carry the admin's `users.id` explicitly rather than a whole
 * session: the procedure has already been through `adminProcedure
 * ('cancelRefund')` by the time it calls either function, and a service that
 * took a session would invite a caller to supply one.
 *
 * Not in `/shared`, for the reason `recordPaymentInputSchema` is not:
 * nothing a browser sends reaches these functions directly, and a schema in
 * `/shared` would imply otherwise.
 */
const cancelBookingInputSchema = z.object({
  bookingId: z.number().int().positive(),
  /** Goes in the audit row. Required — "why" is the whole value of the trail. */
  reason: z.string().trim().min(1).max(400),
  /** `users.id` of the owner or finance user doing this. */
  actorUserId: z.number().int().positive(),
});

export type CancelBookingInput = z.input<typeof cancelBookingInputSchema>;

export interface CancelBookingResult {
  /** The public ref, for the admin's confirmation line. */
  ref: string;
  /** What the booking was before this call. `cancelled` is what it is now. */
  previousStatus: BookingStatus;
  /** True when this cancel also put an on-trip van back on sale. */
  vanReleased: boolean;
}

/**
 * Cancels a booking. **Moves no money at all.**
 *
 * One transaction: the booking row lock, the conditional status write, the
 * van release, the audit row. Rejects — writing nothing — when the booking
 * does not exist or its status is not in `CANCELLABLE_STATUSES`.
 *
 * ## What it does to a trip already under way (owner ruling, 2026-10-16)
 *
 * It cancels it, and it leaves every check-in standing. Three things follow,
 * and all three are deliberate:
 *
 *  - `checkInStop`'s `in_progress` gate is a plain read, so a check-in that
 *    was in flight when this committed can still land one checkpoint and one
 *    `trip.checked_in` audit row on a booking that is now `cancelled`. The
 *    van really did reach that stop; erasing the record would be the worse
 *    lie. It cannot complete the trip or move the van —`finishTrip`'s status
 *    write is conditional on `in_progress`.
 *  - `undoLastCheckIn` has no status gate on its non-`completed` path, so a
 *    driver can still retract a tap on a cancelled booking. It writes no
 *    money and moves no van either.
 *  - Neither of those touches money or the fleet, which is why this task
 *    documented them rather than changing `checkins.ts` — a working,
 *    44-test module is not something to rewrite for a residue that is
 *    arguably true.
 *
 * ## The van, though, IS this function's problem
 *
 * `vans.status = 'on_trip'` is set by `startTrip` and cleared by completion,
 * and CLAUDE.md's rule is that whatever sets it must also clear it.
 * Cancelling mid-trip removes the completion that would have cleared it, so
 * this does — through `releaseVanFromTrip()`, the same conditional
 * `on_trip → available` door `checkins.ts` owns, never a write of its own.
 * A van parked in `for_repair` by a dispatcher is left exactly where they
 * put it.
 */
export async function cancelBooking(input: CancelBookingInput): Promise<CancelBookingResult> {
  const parsed = cancelBookingInputSchema.parse(input);

  return getDb().transaction(async (tx: Transaction) => {
    /*
     * THE booking row lock, taken before anything is read or decided — the
     * discipline `recordPayment()` keeps, and the same reason: `status` and
     * `van_id` are both read here and acted on below, so a concurrent
     * change between the read and the write would decide this cancel
     * against a booking that no longer exists in that shape.
     *
     * No slot locks. CLAUDE.md's order is
     * `fleet_date_slots → tour_date_slots → booking`, and it binds anything
     * that CONSUMES a day's capacity; this only ever releases some (the
     * expiry sweep documents the same exemption). Taking the fleet lock to
     * give capacity back would make an admin's cancel contend with every
     * live booking attempt on that date for no correctness gained.
     */
    const [booking] = await tx
      .select({ ref: bookings.ref, status: bookings.status, vanId: bookings.vanId })
      .from(bookings)
      .where(eq(bookings.id, parsed.bookingId))
      .for('update')
      .limit(1);
    if (!booking) throw new BookingNotFoundError(parsed.bookingId);

    /*
     * The gate, repeated in SQL rather than decided in JS off the row above.
     * It is the same belt-and-braces `expireOne()` keeps: an `UPDATE … WHERE`
     * is answered from the latest committed row, so even if the lock above
     * were ever weakened this write could not land on a status the allow-list
     * excludes.
     *
     * `affectedRows` is MATCHED, not changed (mysql2 connects with
     * `CLIENT_FOUND_ROWS`), which is exactly what is wanted here: a booking
     * already `cancelled` matches nothing in the allow-list, so a second
     * cancel is refused rather than writing a second audit row.
     */
    const [result] = await tx
      .update(bookings)
      .set({ status: 'cancelled' })
      .where(
        and(eq(bookings.id, parsed.bookingId), inArray(bookings.status, [...CANCELLABLE_STATUSES])),
      );
    if (result.affectedRows === 0) {
      throw new BookingNotCancellableError(parsed.bookingId, booking.status);
    }

    const vanReleased = booking.status === 'in_progress' && booking.vanId !== null;
    await releaseVanFromTrip(tx, booking.vanId);

    await writeAudit(tx, {
      // An admin cancellation is `user` with that admin's id — §6's own
      // precedent, and never `system` (a cron) or `provider` (a gateway).
      actorType: 'user',
      actorId: parsed.actorUserId,
      action: 'booking.cancelled',
      entity: 'bookings',
      entityId: parsed.bookingId,
      /*
       * Identifiers, the reason, and what the booking was. No guest name,
       * email or phone: audit rows are read by every admin and exported in
       * reports (RA 10173).
       */
      data: {
        ref: booking.ref,
        previousStatus: booking.status,
        reason: parsed.reason,
        vanId: booking.vanId,
        vanReleased,
      },
    });

    return { ref: booking.ref, previousStatus: booking.status, vanReleased };
  });
}

/**
 * §6: "Manual payments: admin records the refund as done offline (method +
 * reference)."
 *
 * `method` is HOW the money went back — the instrument, never the processor
 * — and `reference` is whatever the admin can point at afterwards: a GCash
 * transaction id, a bank reference, "counted out at the office". It lands in
 * `payments.txn_ref`, the same column a guest's manual transfer reference
 * uses.
 */
const offlineRecordSchema = z.object({
  method: z.enum(PAYMENT_METHODS),
  reference: z.string().trim().min(1).max(191),
});

const refundPaymentInputSchema = z.object({
  /** The PAID `payments` row the money came in through. */
  paymentId: z.number().int().positive(),
  /**
   * Centavos, always positive, and the ONE number in this system that
   * legitimately comes from a human rather than from the server's own
   * arithmetic: §6 is "Admin cancels a booking, choosing a refund amount
   * (full, partial, none)". It is not trusted, it is CAPPED — by
   * `recordPayment()` under the booking row lock.
   */
  amountCentavos: z.number().int().positive(),
  /** Why. Goes to the gateway as `notes` and into the audit trail. */
  reason: z.string().trim().min(1).max(400),
  /** Required for a `manual` payment, refused for a gateway one. */
  offline: offlineRecordSchema.optional(),
  actorUserId: z.number().int().positive(),
});

export type RefundPaymentInput = z.input<typeof refundPaymentInputSchema>;

export interface RefundPaymentResult {
  /** The new `refund` row. */
  paymentId: number;
  /** The booking it was recorded against. */
  bookingId: number;
  /** The provider named on the SOURCE row — the one that took the money. */
  provider: string;
  /** False for a `manual` payment, which has no gateway to call. */
  calledGateway: boolean;
}

/**
 * A read-only pre-flight check, and **not the cap**.
 *
 * The cap is in `recordPayment()`, inside the transaction, under the booking
 * row lock, and it is the only check that decides whether a refund row
 * exists. This one runs earlier and for one narrow purpose: §6 has the
 * gateway called BEFORE the row is written, so without it an admin who typed
 * ₱10,000 against a ₱4,000 booking would have real money leave the merchant
 * account and only then be told the row could not be written.
 *
 * It is therefore allowed to be stale — two admins can both pass it — and
 * that is exactly the case `RefundNotRecordedError` exists for. It must
 * never be mistaken for the guarantee: if this function were deleted, no
 * booking could be over-refunded in the database, which is the test of
 * whether a check is load-bearing.
 */
async function assertRefundFitsBeforePayout(
  bookingId: number,
  amountCentavos: number,
): Promise<void> {
  const db = getDb();
  const [booking] = await db
    // NOT aliased `amountPaidCentavos`: `schema-conventions.test.ts` reads
    // that spelling as a WRITE of the column, and this module may not write
    // it. The same reason `admin.bookings.detail` calls it `paidCentavos`.
    .select({ paidCentavos: bookings.amountPaidCentavos })
    .from(bookings)
    .where(eq(bookings.id, bookingId))
    .limit(1);
  if (!booking) throw new BookingNotFoundError(bookingId);

  const [refundsSoFar] = await db
    .select({ refunded: sql<number>`COALESCE(SUM(${payments.amountCentavos}), 0)` })
    .from(payments)
    .where(and(eq(payments.bookingId, bookingId), eq(payments.type, 'refund')));
  const alreadyRefunded = Number(refundsSoFar?.refunded ?? 0);

  if (alreadyRefunded + amountCentavos > booking.paidCentavos) {
    throw new RefundExceedsPaidError(booking.paidCentavos, alreadyRefunded, amountCentavos);
  }
}

/**
 * Refunds money that came in through one `payments` row, and records it.
 *
 * Gateway payments go back through **the provider named on that row** and
 * then get a `refund` row carrying the gateway's own refund id and status.
 * `manual` payments call no gateway at all — there is nothing to call, and
 * `getProvider('manual')` fails closed on purpose — so they are recorded as
 * an offline refund with the admin's method and reference.
 *
 * Rejects, paying out nothing and writing nothing, when the id is not a
 * paid payment, when the form does not match the row (a gateway charge with
 * no `provider_ref`, a manual row with no offline record, or an offline
 * record supplied against a gateway charge), or when the amount would take
 * the booking's refunds past what it was paid.
 *
 * Rejects AFTER paying out — loudly, with `RefundNotRecordedError` — only if
 * the authoritative cap refuses a payout the pre-flight allowed, which takes
 * two admins refunding the same booking in the same instant.
 */
export async function refundPayment(input: RefundPaymentInput): Promise<RefundPaymentResult> {
  const parsed = refundPaymentInputSchema.parse(input);

  /*
   * The SOURCE row, scoped to money that actually arrived: `type='payment'`
   * and `status='paid'`. A pending receipt, a rejected transfer, a driver's
   * unreconciled cash claim and an existing `refund` row are all "not
   * found" here rather than something this path could pay out against.
   *
   * Unlocked, and it does not need to be: nothing about this row is written,
   * and `provider` / `provider_ref` / `method` are immutable once a payment
   * is `paid` — the only UPDATE any path makes to a `payments` row is the
   * `pending → paid/rejected` conversion in `record-payment.ts` and
   * `manual-receipt.ts`, neither of which touches these three columns.
   */
  const [source] = await getDb()
    .select({
      bookingId: payments.bookingId,
      provider: payments.provider,
      method: payments.method,
      providerRef: payments.providerRef,
    })
    .from(payments)
    .where(
      and(
        eq(payments.id, parsed.paymentId),
        eq(payments.type, 'payment'),
        eq(payments.status, 'paid'),
      ),
    )
    .limit(1);
  if (!source) throw new RefundSourcePaymentNotFoundError(parsed.paymentId);

  await assertRefundFitsBeforePayout(source.bookingId, parsed.amountCentavos);

  /** The admin, in `recordPayment()`'s own actor shape. */
  const actor = { type: 'user' as const, id: parsed.actorUserId };

  if (source.provider === 'manual') {
    /*
     * §6's offline half. No gateway is asked, and none exists to ask: a
     * manual payment is a QR transfer or a handful of cash an admin
     * verified, so the money goes back the same way and the record is the
     * admin's word plus a reference.
     */
    if (!parsed.offline) {
      throw new RefundNotPossibleError(parsed.paymentId, 'manual_needs_offline_record');
    }
    const recorded = await recordPayment({
      bookingId: source.bookingId,
      type: 'refund',
      provider: 'manual',
      // The admin's instrument, not the source row's: money that came in as
      // a bank transfer may well go back as GCash.
      method: parsed.offline.method,
      amountCentavos: parsed.amountCentavos,
      providerRef: null,
      providerStatus: null,
      txnRef: parsed.offline.reference,
      actor,
    });
    return {
      paymentId: recorded.paymentId,
      bookingId: source.bookingId,
      provider: 'manual',
      calledGateway: false,
    };
  }

  if (parsed.offline) {
    throw new RefundNotPossibleError(parsed.paymentId, 'gateway_takes_no_offline_record');
  }
  if (source.providerRef === null) {
    throw new RefundNotPossibleError(parsed.paymentId, 'gateway_payment_has_no_reference');
  }

  /*
   * **THE rule this whole function exists for.** The provider comes off the
   * SOURCE ROW — never `getActiveProvider()`, which is what the gateway the
   * business is selling through today would answer. A switch from PayMongo
   * to Xendit must not send last month's refunds to this month's company,
   * and the row is the only record of who actually holds the money.
   */
  const gateway = await getProvider(source.provider).refund({
    providerRef: source.providerRef,
    amountCentavos: parsed.amountCentavos,
    reason: parsed.reason,
  });

  /*
   * The money has left. From here the only acceptable outcomes are "it is
   * recorded" and "a human is told, by name, that it is not".
   */
  try {
    const recorded = await recordPayment({
      bookingId: source.bookingId,
      type: 'refund',
      provider: source.provider,
      // The instrument the guest paid with. A card refund goes back to the
      // card; the gateway decides nothing about that and neither do we.
      method: source.method,
      amountCentavos: parsed.amountCentavos,
      // The GATEWAY's own ids, not the charge's: this row is the refund.
      providerRef: gateway.providerRef,
      providerStatus: gateway.providerStatus,
      actor,
    });
    return {
      paymentId: recorded.paymentId,
      bookingId: source.bookingId,
      provider: source.provider,
      calledGateway: true,
    };
  } catch (error) {
    console.error(
      `[refunds] ${source.provider} refund ${gateway.providerRef} was accepted by the gateway ` +
        `for booking id ${source.bookingId} but could NOT be recorded. Reconcile by hand.`,
      error,
    );
    throw new RefundNotRecordedError(source.provider, gateway.providerRef);
  }
}
