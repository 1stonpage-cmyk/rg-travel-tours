/**
 * `admin.bookings.approveReceipt` / `.rejectReceipt` / `.approveCash` /
 * `.rejectCash` — the verification queue's buttons (Week 4 plan, Task 7;
 * Week 6 plan, Task 11; Week 6.5 D2; BUILD_SPEC §6 step 5, §8 item 5,
 * §13's 6E).
 *
 * **Two things wait in this queue.** A guest's uploaded receipt, and cash a
 * driver recorded on tour day. Week 4 built the receipt half; Week 6 Task 11
 * added the cash half, which until then had a service
 * (`verifyCashPayment()`) nothing called and a claim the queue filter could
 * not see.
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
import { BOOKING_STATUSES, addBookingNoteInputSchema, manilaCivilDate } from '@rg/shared';
import { and, asc, desc, eq, gte, lte, sql } from 'drizzle-orm';
import { getDb } from '../../db/client';
import {
  PAYMENT_METHODS,
  auditLog,
  bookingAddons,
  bookingNotes,
  bookings,
  drivers,
  payments,
  tours,
  vans,
} from '../../db/schema';
import { writeAudit } from '../../services/audit';
import { notify } from '../../services/notify';
import {
  CashPaymentNotFoundError,
  CashPaymentNotPendingError,
  CashRejectionNeedsReasonError,
  PaymentOverpaysBookingError,
  PaymentVerificationNotPermittedError,
  ReceiptAlreadyDecidedError,
  ReceiptPaymentNotFoundError,
  ReceiptRejectionNeedsReasonError,
} from '../../services/payments/errors';
import { decideManualReceipt } from '../../services/payments/manual-receipt';
import { rejectCashPayment, verifyCashPayment } from '../../services/payments/record-payment';
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

/**
 * The cash-refusal reason, bounded by the same column — and its own schema
 * rather than `rejectInput` above (D2).
 *
 * The shape is identical; the MESSAGE is not, and the message is the point.
 * `rejectInput`'s says "Tell the guest what was wrong" because §6 mails a
 * receipt rejection to the guest. A cash refusal is told to nobody outside
 * the office: it is an internal finding about a driver, so the sentence an
 * admin sees when they leave the box empty has to ask for that instead.
 */
const rejectCashInput = z
  .object({
    paymentId: z.number().int().positive(),
    reason: z.string().trim().min(1, 'Say why the cash was not received.').max(400),
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
  /*
   * The cash half (Week 6 Task 11). Same two shapes as the receipt pair and
   * for the same reasons — a wrong id is `NOT_FOUND`, a row that moved on is
   * `CONFLICT` — plus two the receipt path cannot produce.
   */
  if (error instanceof CashPaymentNotFoundError) {
    return new TRPCError({
      code: 'NOT_FOUND',
      message: 'That cash collection is no longer waiting for a decision.',
    });
  }
  if (error instanceof CashPaymentNotPendingError) {
    return new TRPCError({
      code: 'CONFLICT',
      message: `This cash has already been handled (it is "${error.status}"). Refresh the queue.`,
    });
  }
  /*
   * The cash refusal's own needs-a-reason (D2). `BAD_REQUEST`, like the
   * receipt one, and with the same sentence `rejectCashInput` carries — the
   * schema is the friendly refusal and the service is the guarantee, and an
   * admin who somehow reaches the second should not be told something
   * different from the first.
   */
  if (error instanceof CashRejectionNeedsReasonError) {
    return new TRPCError({
      code: 'BAD_REQUEST',
      message: 'Say why the cash was not received.',
    });
  }
  /*
   * `FORBIDDEN`, and it should be unreachable through tRPC: the
   * `verifyPayments` gate has already refused anyone but an owner or a
   * finance user before the resolver runs. It is mapped anyway because the
   * service keeps its own gate (it is callable from a job or a script) and a
   * fail-closed refusal must not surface as a 500 if the two ever disagree.
   */
  if (error instanceof PaymentVerificationNotPermittedError) {
    return new TRPCError({ code: 'FORBIDDEN', message: 'Not permitted for this account.' });
  }
  /*
   * The overpay cap. `BAD_REQUEST`: unlike the conflicts above, nothing has
   * moved on — the figures genuinely do not add up, and crediting this would
   * leave the booking reading as more than paid.
   */
  if (error instanceof PaymentOverpaysBookingError) {
    return new TRPCError({
      code: 'BAD_REQUEST',
      message: 'That amount is more than this booking still owes. Check the figures first.',
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
/**
 * `payments.method`, in words — Task 15 (7L). One map, reused everywhere a
 * method needs a human label, rather than an ad-hoc string transform at
 * each call site. Exhaustive over `PAYMENT_METHODS` (TypeScript enforces
 * it below), so a value added to the enum fails to compile here until this
 * map is given a label for it too.
 */
const PAYMENT_METHOD_LABELS: Record<(typeof PAYMENT_METHODS)[number], string> = {
  card: 'Card',
  gcash: 'GCash',
  maya: 'Maya',
  grab_pay: 'GrabPay',
  qrph: 'QR Ph',
  bank_transfer: 'Bank transfer',
  cash: 'Cash',
};

/**
 * Falls back to the raw value for anything the map does not recognise —
 * defensive only; `PAYMENT_METHOD_LABELS` is exhaustive over the real enum,
 * so this branch exists for a value read out of a raw SQL subquery (typed
 * `string`, not the enum) rather than anything expected to happen.
 */
export function paymentMethodLabel(method: string): string {
  return (PAYMENT_METHOD_LABELS as Record<string, string>)[method] ?? method;
}

/**
 * The guest's phone, masked to its last four characters — Task 15 (7L).
 * Personal data under RA 10173, so this runs ON THE SERVER and the real
 * number is never put in a response: the caller must mask before it ever
 * reaches a `.select()`'s mapped output.
 *
 * Reveals at most the last four characters, however the number is
 * formatted (`+639171234567` normalised, or an older `0917...` row that
 * predates the checkout schema's transform) — never more, never a
 * substring that could be combined with other fields to reconstruct it.
 */
export function maskPhone(phone: string): string {
  const visible = phone.slice(-4);
  const hidden = Math.max(phone.length - visible.length, 0);
  return '•'.repeat(hidden) + visible;
}

/**
 * A raw `datetime` column read back through a hand-written `sql` fragment —
 * never a typed Drizzle column, so none of Drizzle's own driver-value
 * mapping runs on it (`MySqlDateTime.mapFromDriverValue` only fires for a
 * real column reference). mysql2 hands this pool's `datetime`/`timestamp`
 * values back as a bare `'YYYY-MM-DD HH:MM:SS'` string with no timezone
 * marker, and this pool stores everything as UTC (`timezone: 'Z'` in
 * `db/client.ts`) — so appending `Z` after swapping the separator is exactly
 * what Drizzle's own column class does, reproduced here for a value that
 * never passed through one. Without it, `new Date(rawValue)` in the caller
 * parses the space-separated string as LOCAL time instead of UTC, which is
 * silent and wrong everywhere this server is not itself running in UTC.
 */
function parseRawDatetime(value: string | null): Date | null {
  if (value === null) return null;
  return new Date(`${value.replace(' ', 'T')}Z`);
}

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
         * "Waiting on us": a booking holding a pending manual payment of
         * EITHER kind — a guest's uploaded receipt, or cash a driver says
         * they took (Week 6 Task 11). The two-arm disjunction is the same
         * pair `verifyPendingManualPayment()` scopes itself to: a receipt
         * is `receipt_path IS NOT NULL`, cash is `method = 'cash'`. Before
         * this the clause required a receipt path, so every driver-collected
         * peso was invisible to the one screen whose job is to reconcile it
         * — the claim sat `pending` with nobody told to look at it.
         *
         * Expressed as an EXISTS rather than a join so the row count cannot
         * change — a booking with a receipt AND a cash row must still be
         * one row in this list.
         */
        input.awaitingVerification
          ? sql`EXISTS (
              SELECT 1 FROM payments p
              WHERE p.booking_id = ${bookings.id}
                AND p.provider = 'manual'
                AND p.type = 'payment'
                AND p.status = 'pending'
                AND (p.receipt_path IS NOT NULL OR p.method = 'cash')
            )`
          : undefined,
      ].filter((clause) => clause !== undefined);

      const condition = where.length > 0 ? and(...where) : undefined;

      /*
       * The one pending manual payment a queue card is about — Task 15
       * (7L). Same two-arm match as the `awaitingVerification` clause above
       * (a receipt, or cash), so the row these scalars read is the same row
       * that put the booking in the queue in the first place. When a
       * booking somehow carries both at once, the receipt wins (matching
       * the detail pane's own `findPendingReceipt() ?? cash[0]` rule) and
       * ties break on the newest id — deterministic, not "whichever MySQL
       * happens to return first".
       *
       * Scalar correlated subqueries, not a join: a join against `payments`
       * would fan this list out to one row per payment, and the comment on
       * the `awaitingVerification` clause above already explains why that
       * must not happen to this query.
       */
      const pendingPaymentMatch = sql`
        p.provider = 'manual'
        AND p.type = 'payment'
        AND p.status = 'pending'
        AND (p.receipt_path IS NOT NULL OR p.method = 'cash')
      `;
      const pendingPaymentOrder = sql`ORDER BY (p.receipt_path IS NULL) ASC, p.id DESC LIMIT 1`;

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
          /** The guest's phone, masked below — never sent to the client as-is. */
          leadPhone: bookings.leadPhone,
          /**
           * The pending payment's OWN `created_at` — not the booking's.
           * Named unambiguously so it cannot be confused with the booking's
           * `createdAt` two lines up.
           */
          pendingPaymentCreatedAt: sql<string | null>`(
            SELECT p.created_at FROM payments p
            WHERE p.booking_id = ${bookings.id} AND ${pendingPaymentMatch}
            ${pendingPaymentOrder}
          )`,
          /** The raw enum value; translated to words in the map below. */
          pendingPaymentMethod: sql<string | null>`(
            SELECT p.method FROM payments p
            WHERE p.booking_id = ${bookings.id} AND ${pendingPaymentMatch}
            ${pendingPaymentOrder}
          )`,
          /**
           * "2nd try" — every `type = 'payment'` row this booking has ever
           * had, superseded and rejected ones included, because each one
           * really was an attempt at paying (a refund is not). Counted
           * rather than ranked: the pending row, being the booking's
           * latest payment-type row by construction, is always the last
           * attempt, so its count IS its ordinal.
           */
          attemptNumber: sql<number>`(
            SELECT COUNT(*) FROM payments p
            WHERE p.booking_id = ${bookings.id} AND p.type = 'payment'
          )`,
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
        items: rows.map((row) => {
          // `leadPhone` never leaves this function: masked below, and the
          // real value is deliberately not in the object this returns
          // (RA 10173 — CLAUDE.md Security).
          const { leadPhone, pendingPaymentMethod, ...rest } = row;
          return {
            ...rest,
            tourDate: manilaCivilDate(row.tourDate),
            pendingPaymentCreatedAt: parseRawDatetime(row.pendingPaymentCreatedAt),
            attemptNumber: Number(row.attemptNumber),
            method: pendingPaymentMethod ? paymentMethodLabel(pendingPaymentMethod) : null,
            phoneMasked: maskPhone(leadPhone),
          };
        }),
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

      /*
       * The driver is LEFT-joined, not looked up afterwards: `drivers` is
       * only reachable for a cash row (`collected_by_driver_id`), and a
       * gateway charge or a guest receipt must still come back with the
       * name `null` rather than be dropped from the trail.
       *
       * Why the name is on the payment at all: "who says they took this
       * money" is the question finance is answering on a cash row, and an
       * id is not an answer anybody can act on. The PHONE is deliberately
       * not here — this screen reconciles a claim, and the dispatch block
       * above already carries the assigned driver's number for the day
       * somebody needs to ring them.
       */
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
          /** Set only on a driver's cash claim; `null` on every other row. */
          collectedByDriverId: payments.collectedByDriverId,
          collectedByDriverName: drivers.name,
          createdAt: payments.createdAt,
        })
        .from(payments)
        .leftJoin(drivers, eq(drivers.id, payments.collectedByDriverId))
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
          /*
           * Whether the driver on this trip can read it (D6). The admin
           * needs this per note — it is the only way to tell at a glance
           * which of the office's words are riding in a van.
           */
          visibleToDriver: bookingNotes.visibleToDriver,
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
            id: ctx.adminSession.subjectId,
            // The LIVE role from the session, which `readSession` resolves
            // from `users` on every request — so a demoted admin's open tab
            // cannot approve a payment.
            role: ctx.adminSession.role,
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
          verifier: { type: 'user', id: ctx.adminSession.subjectId, role: ctx.adminSession.role },
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

  /**
   * Finance confirms that cash a driver claimed was actually handed over
   * (BUILD_SPEC §8 item 5, §13's 6E).
   *
   * **A driver's tap is a claim; this is the reconciliation**, and the
   * separation is the whole point: a driver who could verify their own
   * collection could pocket the cash and leave the booking reading "paid in
   * full". So `driver.recordCash` writes one `pending` row and touches
   * nothing on `bookings`, and this converts THAT SAME ROW to `paid` and
   * credits `amount_paid_centavos` once, under the booking lock, inside
   * `verifyCashPayment()`. **Nothing here inserts a payment.** One handful
   * of cash is one `payments` row for its whole life.
   *
   * `adminProcedure('verifyPayments')` — owner and finance, never a
   * dispatcher, and a driver session is not an admin identity at all. The
   * `verifier` is built from the gate's validated session, so the role
   * cannot arrive in the payload.
   *
   * **No email.** The receipt pair above mails the guest because a receipt
   * decision is news they are waiting on; cash is the balance handed over at
   * the end of a trip that has already run, and a "booking confirmed" note
   * hours after the fact would be a confusing one. §11's email set is the
   * owner's to extend, not this task's.
   */
  approveCash: adminProcedure('verifyPayments')
    .input(approveInput)
    .mutation(async ({ input, ctx }) => {
      try {
        const result = await verifyCashPayment({
          paymentId: input.paymentId,
          verifier: {
            type: 'user',
            id: ctx.adminSession.subjectId,
            // The LIVE role from the session, as the receipt pair does.
            role: ctx.adminSession.role,
          },
        });
        return {
          bookingStatus: result.bookingStatus,
          paymentReviewRequired: result.paymentReviewRequired,
        };
      } catch (error) {
        throw asTrpcError(error);
      }
    }),

  /**
   * Finance or the owner records that cash a driver claimed never arrived
   * (owner decision 2026-10-16, D2).
   *
   * **The counterpart `approveCash` had no counterpart to.** Before this,
   * one mistaken tap in a van left a `pending` row nothing could close: it
   * sat in the verification queue as a claim nobody could refuse, and it
   * put the driver's payment box into `unverified_do_not_collect` — so
   * `driver.recordCash` answered `CONFLICT` on that booking forever.
   * Refusing the row closes the claim AND unblocks the driver, in that
   * order of importance.
   *
   * **It moves no money**, because none ever moved: a driver's tap credits
   * nothing, so a refusal has nothing to take back. `rejectCashPayment()`
   * writes `payments.status` and `payments.reject_reason` and touches no
   * column on `bookings` at all.
   *
   * `adminProcedure('verifyPayments')` — the same gate as `approveCash` and
   * the receipt pair, because refusing a claim is that permission being
   * exercised just as much as approving one. Never a dispatcher, and a
   * driver session is not an admin identity at all.
   *
   * **No email.** Nothing is owed to the guest here: the money either never
   * existed or is a conversation with the driver. §11's email set is the
   * owner's to extend, not this task's.
   */
  rejectCash: adminProcedure('verifyPayments')
    .input(rejectCashInput)
    .mutation(async ({ input, ctx }) => {
      try {
        const result = await rejectCashPayment({
          paymentId: input.paymentId,
          reason: input.reason,
          // The LIVE role from the session, as every other decision here.
          verifier: { type: 'user', id: ctx.adminSession.subjectId, role: ctx.adminSession.role },
        });
        return { ref: result.ref };
      } catch (error) {
        throw asTrpcError(error);
      }
    }),

  /**
   * Write one office note on a booking, and state whether the driver may
   * read it (owner decision 2026-10-16, D6).
   *
   * **The first writer `booking_notes` has ever had.** The table was built
   * in Week 1 and read by `detail` and `driver.trip` from Week 4 and 6, but
   * nothing inserted into it — the office had no way to record anything.
   *
   * `adminProcedure('bookingsView')`: `ROLE_MATRIX` transcribes §9's
   * "Bookings: view, notes" row, which is owner, dispatcher AND finance.
   * Notes are part of the booking record, not a payment decision, so this
   * is deliberately not `verifyPayments`.
   *
   * One transaction: the booking is checked inside it, the note is inserted
   * with the author taken from the session (never the payload), and the
   * audit row commits or rolls back with it. The audit `data` carries the
   * note's id and its visibility and NOT its text — the text is already
   * stored, and audit rows are exported in reports.
   *
   * `entity: 'bookings'`, plural: the booking detail's trail reads
   * `entity = 'bookings'`, and a singular here would write a row that
   * screen can never show.
   */
  addNote: adminProcedure('bookingsView')
    .input(addBookingNoteInputSchema)
    .mutation(async ({ input, ctx }) => {
      return getDb().transaction(async (tx) => {
        const [booking] = await tx
          .select({ id: bookings.id })
          .from(bookings)
          .where(eq(bookings.id, input.bookingId))
          .limit(1);
        if (!booking) {
          throw new TRPCError({ code: 'NOT_FOUND', message: 'No booking with that id.' });
        }

        const [inserted] = await tx.insert(bookingNotes).values({
          bookingId: booking.id,
          userId: ctx.adminSession.subjectId,
          note: input.note,
          visibleToDriver: input.visibleToDriver,
        });
        const id = inserted.insertId;

        await writeAudit(tx, {
          actorType: 'user',
          actorId: ctx.adminSession.subjectId,
          action: 'booking.note_added',
          entity: 'bookings',
          entityId: booking.id,
          data: { noteId: id, visibleToDriver: input.visibleToDriver },
        });

        return { id };
      });
    }),
});
