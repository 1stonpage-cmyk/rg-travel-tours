/**
 * `admin.bookings.approveReceipt` / `.rejectReceipt` — the verification
 * queue's two buttons (Week 4 plan, Task 7; BUILD_SPEC §6 step 5).
 *
 * **The reject half did not exist anywhere in this codebase before.**
 * `verifyCashPayment()` only ever approved; `payments.reject_reason` was a
 * column nothing wrote and `status='rejected'` a value nothing set. A guest
 * whose transfer could not be matched therefore had no way to be told so
 * and no way to try again, which is the gap this closes.
 *
 * Both procedures are `adminProcedure('verifyPayments')` — §9's "Verify
 * payments, record payments" row, which is **owner and finance only**. A
 * dispatcher may run the day and assign a van; they may not decide that
 * money arrived. The gate is the builder's, not this file's: there is no
 * role check in here to forget to write.
 *
 * ## Two procedures rather than one `decide({ decision })`
 *
 * They are different permissions in spirit even though §9 grants them
 * together — one credits money, the other sets a deadline a guest has to
 * meet — and a single procedure taking a `decision` string makes "who may
 * approve" and "who may reject" one question forever. Two names also keep
 * the audit trail legible from the client side: the mutation a reviewer
 * sees in a log is the thing that happened.
 *
 * ## Nothing here decides anything
 *
 * The resolvers read the session, hand off to `decideManualReceipt()` and
 * send an email. The money, the locks, the audit row and the re-upload
 * deadline are all in `services/payments/` where they can be tested without
 * a transport — and the emails are sent AFTER the service resolves, so a
 * mail failure cannot un-approve a payment.
 */
import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { BOOKING_STATUSES, manilaCivilDate } from '@rg/shared';
import { and, asc, desc, eq, gte, lte, sql } from 'drizzle-orm';
import { getDb } from '../../db/client';
import {
  auditLog,
  bookingAddons,
  bookingNotes,
  bookings,
  drivers,
  payments,
  tours,
  vans,
} from '../../db/schema';
import { notify } from '../../services/notify';
import {
  ReceiptAlreadyDecidedError,
  ReceiptPaymentNotFoundError,
  ReceiptRejectionNeedsReasonError,
} from '../../services/payments/errors';
import { decideManualReceipt } from '../../services/payments/manual-receipt';
import { adminProcedure, router } from '../../trpc';

/**
 * The rejection reason, bounded by its column (`varchar(400)`).
 *
 * `min(1)` after trimming, because the guest is SHOWN this: a blank reason
 * leaves the portal saying "your payment was not accepted" and nothing a
 * guest could act on. The service refuses a blank one too — this is the
 * friendly refusal, that one is the guarantee.
 */
const rejectInput = z
  .object({
    paymentId: z.number().int().positive(),
    reason: z.string().trim().min(1, 'Tell the guest what was wrong, in a sentence.').max(400),
  })
  .strict();

const approveInput = z.object({ paymentId: z.number().int().positive() }).strict();

/**
 * Service errors an admin should see as a sentence rather than a 500.
 *
 * `ReceiptAlreadyDecidedError` is the one that will actually happen: two
 * people working the queue, or one person double-clicking. `CONFLICT`, not
 * `BAD_REQUEST` — nothing was wrong with the request, the row simply moved
 * on, and the UI should refetch rather than ask the admin to correct
 * anything.
 */
function asTrpcError(error: unknown): TRPCError {
  if (error instanceof ReceiptPaymentNotFoundError) {
    return new TRPCError({
      code: 'NOT_FOUND',
      message: 'That receipt is no longer waiting for a decision.',
    });
  }
  if (error instanceof ReceiptAlreadyDecidedError) {
    return new TRPCError({
      code: 'CONFLICT',
      message: `This receipt has already been handled (it is "${error.status}"). Refresh the queue.`,
    });
  }
  if (error instanceof ReceiptRejectionNeedsReasonError) {
    return new TRPCError({
      code: 'BAD_REQUEST',
      message: 'Tell the guest what was wrong, in a sentence.',
    });
  }
  return error instanceof TRPCError
    ? error
    : new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'That did not work.' });
}

/** What the §11 emails need, read once after the decision has committed. */
async function mailPayload(bookingId: number) {
  const [row] = await getDb()
    .select({
      ref: bookings.ref,
      leadEmail: bookings.leadEmail,
      tourTitle: tours.title,
      tourDate: bookings.tourDate,
      totalCentavos: bookings.totalCentavos,
      paidCentavos: bookings.amountPaidCentavos,
    })
    .from(bookings)
    .innerJoin(tours, eq(tours.id, bookings.tourId))
    .where(eq(bookings.id, bookingId))
    .limit(1);
  if (!row) return null;
  return {
    to: row.leadEmail,
    ref: row.ref,
    tourTitle: row.tourTitle,
    // The Manila civil date, never a UTC timestamp sliced into a date — on
    // a UTC+8 box that reads as the day before.
    tourDate: manilaCivilDate(row.tourDate),
    totalCentavos: row.totalCentavos,
    paidCentavos: row.paidCentavos,
  };
}

/**
 * The list query (§9's bookings area).
 *
 * A civil date range rather than a timestamp range: an operations screen
 * asks "what is running on Saturday", and `tour_date` is a DATE column.
 * Both ends are inclusive and both are optional.
 *
 * `limit` is capped at 100 — a page of a thousand bookings is not a page,
 * and an uncapped limit is how one admin screen becomes a way to pull the
 * whole customer table in a single request.
 */
const listInput = z
  .object({
    status: z.enum(BOOKING_STATUSES).optional(),
    /** `YYYY-MM-DD`, inclusive. */
    from: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional(),
    to: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional(),
    /** Needs verifying: a pending manual receipt is waiting on someone. */
    awaitingVerification: z.boolean().optional(),
    limit: z.number().int().min(1).max(100).default(25),
    offset: z.number().int().min(0).default(0),
  })
  .strict();

export const adminBookingsRouter = router({
  /**
   * The bookings list (§9's 4D screen), paginated and filterable.
   *
   * `adminProcedure('bookingsView')` — §9 gives view access to all three
   * admin roles, which is why this is a different area from the
   * approve/reject pair below: a dispatcher runs the day and needs to see
   * the bookings, and must not be able to decide that money arrived.
   *
   * **It returns a row per booking and nothing per payment.** The list is
   * for scanning; the detail view below is where a payment trail lives. A
   * list that joined payments would fan out and would also mean every
   * admin screen-load pulled every receipt path in the system.
   */
  list: adminProcedure('bookingsView')
    .input(listInput)
    .query(async ({ input }) => {
      const where = [
        input.status ? eq(bookings.status, input.status) : undefined,
        input.from ? gte(bookings.tourDate, new Date(`${input.from}T00:00:00Z`)) : undefined,
        input.to ? lte(bookings.tourDate, new Date(`${input.to}T00:00:00Z`)) : undefined,
        /*
         * "Waiting on us": a booking under verification with a pending
         * manual receipt. Expressed as an EXISTS rather than a join so the
         * row count cannot change — a booking with two receipt rows must
         * still be one row in this list.
         */
        input.awaitingVerification
          ? sql`EXISTS (
              SELECT 1 FROM payments p
              WHERE p.booking_id = ${bookings.id}
                AND p.provider = 'manual'
                AND p.type = 'payment'
                AND p.status = 'pending'
                AND p.receipt_path IS NOT NULL
            )`
          : undefined,
      ].filter((clause) => clause !== undefined);

      const condition = where.length > 0 ? and(...where) : undefined;

      const rows = await getDb()
        .select({
          id: bookings.id,
          ref: bookings.ref,
          status: bookings.status,
          tourTitle: tours.title,
          tourDate: bookings.tourDate,
          pax: bookings.pax,
          leadName: bookings.leadName,
          totalCentavos: bookings.totalCentavos,
          paidCentavos: bookings.amountPaidCentavos,
          paymentReviewRequired: bookings.paymentReviewRequired,
          createdAt: bookings.createdAt,
        })
        .from(bookings)
        .innerJoin(tours, eq(tours.id, bookings.tourId))
        .where(condition)
        // Soonest tour first: an operations list is a diary, not a log.
        .orderBy(asc(bookings.tourDate), asc(bookings.id))
        .limit(input.limit)
        .offset(input.offset);

      const [counted] = await getDb()
        .select({ total: sql<number>`COUNT(*)` })
        .from(bookings)
        .innerJoin(tours, eq(tours.id, bookings.tourId))
        .where(condition);

      return {
        items: rows.map((row) => ({ ...row, tourDate: manilaCivilDate(row.tourDate) })),
        /** For the pager. `COUNT(*)` comes back as a string on some drivers. */
        total: Number(counted?.total ?? 0),
        limit: input.limit,
        offset: input.offset,
      };
    }),

  /**
   * One booking, with everything an admin needs to decide about it: its
   * payments (receipt paths included, so the authenticated receipt route
   * can be linked), its add-on lines, its assignment, and its audit trail.
   *
   * Also `bookingsView`: reading a booking is reading a booking, whatever
   * the reader intends to do next. The DECISIONS are gated separately —
   * `approveReceipt` and `rejectReceipt` are `verifyPayments`, so a
   * dispatcher sees this screen and finds no buttons on it.
   */
  detail: adminProcedure('bookingsView')
    .input(z.object({ ref: z.string().min(1).max(20) }).strict())
    .query(async ({ input }) => {
      const [booking] = await getDb()
        .select({
          id: bookings.id,
          ref: bookings.ref,
          status: bookings.status,
          tourId: bookings.tourId,
          tourTitle: tours.title,
          tourDate: bookings.tourDate,
          pax: bookings.pax,
          payMode: bookings.payMode,
          leadName: bookings.leadName,
          leadEmail: bookings.leadEmail,
          leadPhone: bookings.leadPhone,
          subtotalCentavos: bookings.subtotalCentavos,
          discountCentavos: bookings.discountCentavos,
          totalCentavos: bookings.totalCentavos,
          paidCentavos: bookings.amountPaidCentavos,
          paymentReviewRequired: bookings.paymentReviewRequired,
          holdExpiresAt: bookings.holdExpiresAt,
          driverId: bookings.driverId,
          vanId: bookings.vanId,
          createdAt: bookings.createdAt,
        })
        .from(bookings)
        .innerJoin(tours, eq(tours.id, bookings.tourId))
        .where(eq(bookings.ref, input.ref))
        .limit(1);

      if (!booking) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'No booking with that reference.' });
      }

      const paymentRows = await getDb()
        .select({
          id: payments.id,
          type: payments.type,
          provider: payments.provider,
          method: payments.method,
          amountCentavos: payments.amountCentavos,
          status: payments.status,
          txnRef: payments.txnRef,
          /** The filename the authenticated receipt route serves. */
          receiptPath: payments.receiptPath,
          rejectReason: payments.rejectReason,
          verifiedBy: payments.verifiedBy,
          verifiedAt: payments.verifiedAt,
          createdAt: payments.createdAt,
        })
        .from(payments)
        .where(eq(payments.bookingId, booking.id))
        .orderBy(desc(payments.id));

      /*
       * Staff notes live in their own append-only table, not a column on
       * `bookings` — "who wrote this and when" is the point of them (§9),
       * and a single text column cannot answer either.
       */
      const noteRows = await getDb()
        .select({
          id: bookingNotes.id,
          note: bookingNotes.note,
          userId: bookingNotes.userId,
          createdAt: bookingNotes.createdAt,
        })
        .from(bookingNotes)
        .where(eq(bookingNotes.bookingId, booking.id))
        .orderBy(desc(bookingNotes.id));

      const addonRows = await getDb()
        .select({
          id: bookingAddons.id,
          name: bookingAddons.name,
          qty: bookingAddons.qty,
          priceCentavos: bookingAddons.priceCentavos,
          perPerson: bookingAddons.perPerson,
        })
        .from(bookingAddons)
        .where(eq(bookingAddons.bookingId, booking.id))
        .orderBy(asc(bookingAddons.id));

      /*
       * The trail for this booking: rows about the booking itself plus rows
       * about its payments. `audit_log.entity_id` is polymorphic, so the
       * payment ids are gathered from the rows above rather than joined.
       */
      const paymentIds = paymentRows.map((row) => row.id);
      const trail = await getDb()
        .select({
          id: auditLog.id,
          actorType: auditLog.actorType,
          actorId: auditLog.actorId,
          action: auditLog.action,
          entity: auditLog.entity,
          entityId: auditLog.entityId,
          data: auditLog.data,
          createdAt: auditLog.createdAt,
        })
        .from(auditLog)
        .where(
          paymentIds.length > 0
            ? sql`(${auditLog.entity} = 'bookings' AND ${auditLog.entityId} = ${booking.id})
                   OR (${auditLog.entity} = 'payments' AND ${auditLog.entityId} IN (${sql.join(
                     paymentIds.map((id) => sql`${id}`),
                     sql`, `,
                   )}))`
            : sql`${auditLog.entity} = 'bookings' AND ${auditLog.entityId} = ${booking.id}`,
        )
        .orderBy(desc(auditLog.id))
        .limit(100);

      const [assignment] = booking.driverId
        ? await getDb()
            .select({ driverName: drivers.name, driverPhone: drivers.phone })
            .from(drivers)
            .where(eq(drivers.id, booking.driverId))
            .limit(1)
        : [undefined];
      const [van] = booking.vanId
        ? await getDb()
            .select({ model: vans.model, plate: vans.plate })
            .from(vans)
            .where(eq(vans.id, booking.vanId))
            .limit(1)
        : [undefined];

      return {
        ...booking,
        tourDate: manilaCivilDate(booking.tourDate),
        payments: paymentRows,
        addons: addonRows,
        notes: noteRows,
        audit: trail,
        assignment: assignment
          ? {
              driverName: assignment.driverName,
              driverPhone: assignment.driverPhone,
              vanModel: van?.model ?? null,
              vanPlate: van?.plate ?? null,
            }
          : null,
      };
    }),

  /**
   * Approve: the payment becomes `paid`, the booking `confirmed`, and the
   * guest gets §11's confirmation email.
   */
  approveReceipt: adminProcedure('verifyPayments')
    .input(approveInput)
    .mutation(async ({ input, ctx }) => {
      let result;
      try {
        result = await decideManualReceipt({
          paymentId: input.paymentId,
          decision: 'approve',
          verifier: {
            type: 'user',
            id: ctx.session.subjectId,
            // The LIVE role from the session, which `readSession` resolves
            // from `users` on every request — so a demoted admin's open tab
            // cannot approve a payment.
            role: ctx.session.role,
          },
          now: new Date(),
        });
      } catch (error) {
        throw asTrpcError(error);
      }

      const payload = await mailPayload(result.bookingId);
      if (payload) await notify('booking_confirmed', payload);

      return { bookingStatus: result.bookingStatus };
    }),

  /**
   * Reject: the payment becomes `rejected` with the reason, the booking
   * returns to `pending_payment` (owner decision 2026-10-13, Q7), and the
   * guest gets the amber "please re-upload" email carrying that reason.
   */
  rejectReceipt: adminProcedure('verifyPayments')
    .input(rejectInput)
    .mutation(async ({ input, ctx }) => {
      let result;
      try {
        result = await decideManualReceipt({
          paymentId: input.paymentId,
          decision: 'reject',
          reason: input.reason,
          verifier: { type: 'user', id: ctx.session.subjectId, role: ctx.session.role },
          now: new Date(),
        });
      } catch (error) {
        throw asTrpcError(error);
      }

      const payload = await mailPayload(result.bookingId);
      // The admin's own words go to the guest verbatim — escaped in the
      // template, never trusted as HTML.
      if (payload) await notify('payment_rejected', { ...payload, reason: input.reason });

      return { bookingStatus: result.bookingStatus, reuploadBy: result.reuploadBy };
    }),
});
