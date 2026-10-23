/** What the payment-decision panels need to know about a booking's pending money. */
/** The slice of `admin.bookings.detail`'s payment rows these panels read. */
export interface DecidablePayment {
  id: number;
  type: string;
  provider: string;
  method: string;
  amountCentavos: number;
  status: string;
  receiptPath: string | null;
  collectedByDriverName?: string | null;
}

/**
 * The receipt the guest uploaded and the cash claims a driver recorded, among
 * a booking's payments. The same finders the booking screen has always used.
 */
export function findPendingReceipt<P extends DecidablePayment>(payments: readonly P[]) {
  return payments.find((payment) => payment.status === 'pending' && payment.receiptPath !== null);
}

/**
 * All four conditions, matching the server's clause (`verifyPendingManualPayment()`
 * scopes to `type='payment' AND provider='manual' AND method='cash'`), and
 * `filter` rather than `find`: `recordPendingCash()` deliberately does NOT merge
 * two taps, so a `find` would silently hide the second claim.
 */
export function findPendingCash<P extends DecidablePayment>(payments: readonly P[]) {
  return payments.filter(
    (payment) =>
      payment.status === 'pending' &&
      payment.type === 'payment' &&
      payment.provider === 'manual' &&
      payment.method === 'cash',
  );
}
