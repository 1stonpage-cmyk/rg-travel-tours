/**
 * The payment seam's errors (plan Tasks 13 and 14).
 *
 * Every one of them is a REFUSAL, not a fallback. The first three are thrown
 * where the alternative would be to guess which gateway a request meant —
 * and guessing, in a payments path, means routing money through the wrong
 * processor or marking a booking paid on an unverified event. The rest
 * (Task 14) are thrown where the alternative would be to move money onto a
 * booking on a number nobody checked.
 *
 * Messages carry a sanitised provider name and never a secret: no API key,
 * no webhook secret, no raw request body, no DATABASE_URL. Centavo amounts
 * ARE quoted — they are already in the audit log an admin reads, and an
 * amount is the one fact that makes a refused payment diagnosable.
 */

/**
 * Provider names reach us from URLs (`/api/webhooks/:provider`) and from
 * settings, so they are untrusted strings by the time an error quotes one.
 * Strip everything but word characters and dashes and cap the length, so a
 * crafted name cannot forge extra lines in a log.
 */
function safeName(name: unknown): string {
  return String(name)
    .replace(/[^\w-]/g, '?')
    .slice(0, 40);
}

/**
 * No implementation is registered under this name.
 *
 * Thrown for a typo (`stripe`), for an empty string, for a prototype key
 * (`__proto__`), and for `manual` — which is a real `payments.provider`
 * value but not a gateway: a QR transfer an admin verified by hand has
 * nothing to call.
 */
export class UnknownProviderError extends Error {
  readonly provider: string;

  constructor(name: unknown) {
    const provider = safeName(name);
    super(`Unknown payment provider: "${provider}"`);
    this.name = 'UnknownProviderError';
    this.provider = provider;
  }
}

/**
 * The implementation exists but is not switched on — currently Xendit, which
 * is planned, not enabled (B1a), and PayMongo until Task 16 fills it in.
 *
 * A stub must be incapable of marking anything paid, so every method of a
 * not-enabled provider throws this rather than returning a neutral-looking
 * value.
 */
export class ProviderNotEnabledError extends Error {
  readonly provider: string;

  constructor(name: unknown) {
    const provider = safeName(name);
    super(`Payment provider "${provider}" is not enabled`);
    this.name = 'ProviderNotEnabledError';
    this.provider = provider;
  }
}

/**
 * No active gateway has been configured in settings, so there is nothing to
 * charge through. Fails closed: `getActiveProvider()` throws this instead of
 * falling back to a default gateway, because a default here would silently
 * send live money somewhere nobody chose.
 */
export class ActiveProviderNotConfiguredError extends Error {
  constructor(detail = 'no active payment provider is configured') {
    super(`Cannot resolve the active payment provider: ${detail}`);
    this.name = 'ActiveProviderNotConfiguredError';
  }
}

/* -------------------------------------------------------------------------
 * Task 14 — the refusals of `recordPayment()`.
 *
 * All five fail CLOSED: each one aborts the transaction before a single row
 * is written, so a refused attempt leaves no payment, no moved
 * `amount_paid_centavos`, no status change and no audit row. A payments path
 * that half-applies is a booking that took money and does not know it.
 * ---------------------------------------------------------------------- */

/**
 * `recordPayment()` was given a booking id that is not in the table.
 *
 * Its own class rather than a bare `Error` so the webhook route (Task 15)
 * can tell "this event names a booking we do not have" — an event to log and
 * acknowledge — apart from "this amount is wrong", which is an alert.
 */
export class BookingNotFoundError extends Error {
  readonly bookingId: number;

  constructor(bookingId: number) {
    super(`No booking with id ${bookingId}`);
    this.name = 'BookingNotFoundError';
    this.bookingId = bookingId;
  }
}

/**
 * BUILD_SPEC §6: "Check the amount matches the booking's expected amount."
 *
 * The expected amount is `total_centavos`, or the deposit when `pay_mode` is
 * `deposit` — computed server-side from the booking row and its frozen
 * `price_snapshot`, never from anything the caller passed in.
 */
export class PaymentAmountMismatchError extends Error {
  readonly expectedCentavos: number;
  readonly receivedCentavos: number;

  constructor(expectedCentavos: number, receivedCentavos: number) {
    super(
      `Payment amount does not match the booking: expected ${expectedCentavos} centavos, ` +
        `got ${receivedCentavos}`,
    );
    this.name = 'PaymentAmountMismatchError';
    this.expectedCentavos = expectedCentavos;
    this.receivedCentavos = receivedCentavos;
  }
}

/**
 * The payment would take `amount_paid_centavos` past `total_centavos`.
 *
 * This is the check that makes the booking row lock worth taking. Two
 * webhook deliveries for the same booking both pass the amount check — each
 * one IS the expected amount — so without this they would simply both apply
 * and the guest would be credited twice. Serialised by the lock, the second
 * one reads the first one's `amount_paid` and is refused here.
 */
export class PaymentOverpaysBookingError extends Error {
  readonly totalCentavos: number;
  readonly alreadyPaidCentavos: number;
  readonly requestedCentavos: number;

  constructor(totalCentavos: number, alreadyPaidCentavos: number, requestedCentavos: number) {
    super(
      `Payment would overpay the booking: ${alreadyPaidCentavos} centavos already paid, ` +
        `${requestedCentavos} offered, total is ${totalCentavos}`,
    );
    this.name = 'PaymentOverpaysBookingError';
    this.totalCentavos = totalCentavos;
    this.alreadyPaidCentavos = alreadyPaidCentavos;
    this.requestedCentavos = requestedCentavos;
  }
}

/**
 * The refund, added to the refunds already recorded, would exceed what the
 * guest actually paid (owner decision 2026-10-11, Q11; BUILD_SPEC §6).
 *
 * Partial refunds are allowed, so a booking may carry several refund rows.
 * Their SUM is what is capped, and it is read inside the transaction under
 * the booking row lock — without the lock two admins each see "nothing
 * refunded yet" and the money leaves twice.
 */
export class RefundExceedsPaidError extends Error {
  readonly amountPaidCentavos: number;
  readonly alreadyRefundedCentavos: number;
  readonly requestedCentavos: number;

  constructor(
    amountPaidCentavos: number,
    alreadyRefundedCentavos: number,
    requestedCentavos: number,
  ) {
    super(
      `Refund would exceed what was paid: ${amountPaidCentavos} centavos paid, ` +
        `${alreadyRefundedCentavos} already refunded, ${requestedCentavos} requested`,
    );
    this.name = 'RefundExceedsPaidError';
    this.amountPaidCentavos = amountPaidCentavos;
    this.alreadyRefundedCentavos = alreadyRefundedCentavos;
    this.requestedCentavos = requestedCentavos;
  }
}

/**
 * A refund was attempted by something other than an admin.
 *
 * BUILD_SPEC §6: "Refunds are admin-only and write to `audit_log` naming the
 * admin. A gateway webhook may _confirm_ a refund the admin initiated; it
 * may never initiate one." So a `refund` row can only be created by an
 * `actor_type` of `user` carrying that admin's id — a `provider` actor (a
 * webhook) and a `system` actor (a cron job) are both refused here.
 */
export class RefundNotAdminInitiatedError extends Error {
  readonly actorType: string;

  constructor(actorType: unknown) {
    const actor = safeName(actorType);
    super(
      `Refunds are admin-only: actor_type "${actor}" may not initiate one. ` +
        'A gateway webhook may confirm a refund an admin started; it may never start one.',
    );
    this.name = 'RefundNotAdminInitiatedError';
    this.actorType = actor;
  }
}

/* -------------------------------------------------------------------------
 * A5b — the refusals of the driver-cash pair.
 *
 * `recordPendingCash()` writes a `pending` row and credits nothing, so its
 * only refusal is a booking that does not exist (`BookingNotFoundError`,
 * above). Everything here belongs to `verifyCashPayment()`, which is the
 * call that actually moves money, and all three fail CLOSED: the transaction
 * aborts before `amount_paid_centavos` is touched, so the pending row stays
 * pending and is still there for the next attempt.
 * ---------------------------------------------------------------------- */

/**
 * `verifyCashPayment()` was given an id that is not a driver-collected cash
 * row.
 *
 * The lookup is scoped to `type='payment' AND provider='manual' AND
 * method='cash'`, so this is also what a GATEWAY payment id gets: a PayMongo
 * charge is not a handful of cash and must not be verifiable through the
 * cash path, however pending its row looks. Its own class so a later admin
 * procedure can answer "that row is not yours to verify" distinctly from
 * "that row has already been verified".
 */
export class CashPaymentNotFoundError extends Error {
  readonly paymentId: number;

  constructor(paymentId: number) {
    super(`No driver-collected cash payment with id ${paymentId}`);
    this.name = 'CashPaymentNotFoundError';
    this.paymentId = paymentId;
  }
}

/**
 * The cash row exists but is no longer `pending` — already verified, or
 * refunded, rejected or failed.
 *
 * **This is the double-credit refusal**, and it is thrown from under the
 * booking row lock. Two finance users clicking "verify" on the same row at
 * once both read `pending` before either commits; serialised by the lock,
 * the second one re-reads the row the first one wrote and lands here. The
 * alternative — treating a second verify as a silent success — credits one
 * handful of cash to `amount_paid_centavos` twice, and the booking total
 * then looks wrong in the one direction nobody notices: too paid.
 *
 * A no-op ERROR rather than a no-op return, because the caller clicked a
 * button and is owed an answer: this money was already counted, by someone.
 */
export class CashPaymentNotPendingError extends Error {
  readonly paymentId: number;
  readonly status: string;

  constructor(paymentId: number, status: unknown) {
    const current = safeName(status);
    super(
      `Cash payment ${paymentId} is "${current}", not "pending", so it cannot be verified again`,
    );
    this.name = 'CashPaymentNotPendingError';
    this.paymentId = paymentId;
    this.status = current;
  }
}

/**
 * Something other than an owner or a finance user tried to verify cash.
 *
 * BUILD_SPEC §9: "Verify payments, record payments — Owner ✅, Dispatcher ❌,
 * Finance ✅", which is `ROLE_MATRIX.verifyPayments`. Modelled on
 * `RefundNotAdminInitiatedError`: only an `actor_type` of `user` carrying a
 * real `users.id` AND a role in that matrix entry gets through, so a driver
 * session, a dispatcher, a webhook, a cron job, an unrecognised role string
 * and a user with no id are all refused.
 *
 * The driver case is the one that matters most. A driver who could verify
 * their own collection could pocket the cash and still leave the booking
 * reading "paid in full" — which is exactly why §8 says the row is "for
 * admin to reconcile" rather than for the driver to settle.
 */
export class PaymentVerificationNotPermittedError extends Error {
  readonly actorType: string;

  constructor(actorType: unknown) {
    const actor = safeName(actorType);
    super(
      `Verifying a payment is owner/finance only: actor_type "${actor}" may not. ` +
        'A driver records the cash as pending; only finance turns it into money received.',
    );
    this.name = 'PaymentVerificationNotPermittedError';
    this.actorType = actor;
  }
}

/* ======================================================================
 * The manual receipt flow (Week 4 plan, Task 6; BUILD_SPEC Section 6
 * steps 3-4). Both of these are shown to the GUEST, through the upload
 * route, so each carries a message that is safe to read in a browser and
 * says what to do next.
 * ====================================================================== */

/**
 * The booking cannot take a receipt right now.
 *
 * One class with a `reason`, rather than five classes: the caller shows the
 * guest a different sentence per reason, and splitting that across a type
 * hierarchy would put the copy in five places. The reasons are deliberately
 * NOT a free string - each is a decision made under the booking row lock.
 *
 * `already_paid` is its own reason rather than a kind of `wrong_status`,
 * because it is the one a guest is most likely to hit by accident: they
 * paid, the webhook landed, and they upload the screenshot anyway. That is
 * not an error they caused, and the message says so.
 */
export type ReceiptRefusalReason =
  'already_paid' | 'booking_cancelled' | 'booking_expired' | 'hold_expired' | 'nothing_due';

const RECEIPT_REFUSAL_MESSAGE: Record<ReceiptRefusalReason, string> = {
  already_paid:
    'This booking is already paid, so there is nothing to upload. Message us if that looks wrong.',
  booking_cancelled:
    'This booking has been cancelled, so a receipt cannot be added to it. Please message us.',
  booking_expired:
    'This booking has expired and its seats have been released. Please book again, or message us.',
  hold_expired:
    'The hold on this booking has run out, so we cannot accept a receipt against it. Please message us and we will check whether the seats are still free.',
  nothing_due: 'There is nothing left to pay on this booking. Message us if that looks wrong.',
};

export class ReceiptNotAcceptedError extends Error {
  readonly bookingId: number;
  readonly reason: ReceiptRefusalReason;
  /** Safe to show a guest: no ids, no internal status names. */
  readonly guestMessage: string;

  constructor(bookingId: number, reason: ReceiptRefusalReason) {
    super(`Booking ${bookingId} cannot accept a receipt: ${reason}`);
    this.name = 'ReceiptNotAcceptedError';
    this.bookingId = bookingId;
    this.reason = reason;
    this.guestMessage = RECEIPT_REFUSAL_MESSAGE[reason];
  }
}

/**
 * Five receipts on one booking is enough (owner decision 2026-10-14, Q6).
 *
 * A cap on rows, not a rate limit - the per-IP limiter handles a flood.
 * This stops a patient guest burying the one receipt an admin needs to
 * look at under forty near-identical ones, and hands the case to a human
 * instead.
 */
export class ReceiptLimitReachedError extends Error {
  readonly bookingId: number;
  readonly count: number;
  readonly guestMessage: string;

  constructor(bookingId: number, count: number, guestMessage: string) {
    super(`Booking ${bookingId} already has ${count} receipts, which is the maximum`);
    this.name = 'ReceiptLimitReachedError';
    this.bookingId = bookingId;
    this.count = count;
    this.guestMessage = guestMessage;
  }
}

/**
 * The id is not a guest receipt row.
 *
 * Its own class rather than reusing `CashPaymentNotFoundError`: the two
 * paths narrow to different rows on purpose, and an admin told "no
 * driver-collected cash payment with id 41" while looking at a receipt
 * screen would go looking for the wrong bug.
 */
export class ReceiptPaymentNotFoundError extends Error {
  readonly paymentId: number;

  constructor(paymentId: number) {
    super(`No pending guest receipt with payment id ${paymentId}`);
    this.name = 'ReceiptPaymentNotFoundError';
    this.paymentId = paymentId;
  }
}

/**
 * The receipt has already been decided - approved, rejected, or superseded
 * by a newer upload.
 *
 * **This is the double-decision refusal**, and like its cash sibling it is
 * thrown from under the booking row lock after a locking re-read. Two
 * admins opening the same receipt both see `pending`; serialised by the
 * lock, the second one reads what the first wrote and lands here. Approving
 * twice would credit one transfer to `amount_paid_centavos` twice, and the
 * booking total would then be wrong in the direction nobody notices.
 *
 * `superseded` reaches here too, which is the owner's Q6 rule enforced
 * rather than described: only the newest pending receipt can be acted on.
 */
export class ReceiptAlreadyDecidedError extends Error {
  readonly paymentId: number;
  readonly status: string;

  constructor(paymentId: number, status: unknown) {
    const current = safeName(status);
    super(`Receipt payment ${paymentId} is "${current}", not "pending", so it cannot be decided`);
    this.name = 'ReceiptAlreadyDecidedError';
    this.paymentId = paymentId;
    this.status = current;
  }
}

/**
 * A rejection with no reason.
 *
 * The reason is not paperwork: §6 shows it to the GUEST, who has to work
 * out what to do differently. A blank one would leave the portal saying
 * "your payment was not accepted" and nothing else, which is the single
 * most frustrating state the booking flow can be in.
 */
export class ReceiptRejectionNeedsReasonError extends Error {
  constructor() {
    super('A rejection needs a reason: the guest is shown it and has to act on it');
    this.name = 'ReceiptRejectionNeedsReasonError';
  }
}
