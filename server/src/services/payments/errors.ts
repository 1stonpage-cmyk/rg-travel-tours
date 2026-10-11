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
