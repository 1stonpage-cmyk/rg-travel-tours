/**
 * The two decisions a verifier can make on a booking's pending money: a
 * guest's uploaded receipt (approve, or reject with a reason the guest reads)
 * and cash a driver says they collected (confirm, or record that it never
 * arrived). One component so the booking screen and the payment-checks
 * screen offer exactly the same controls with exactly the same safeguards.
 *
 * Moved out of `AdminBookingDetailPage` unchanged in behaviour: same
 * procedures (`approveReceipt`, `rejectReceipt`, `approveCash`,
 * `rejectCash`), same required reasons, same button wording that names the
 * amount (and, for cash, the driver) in place of an "are you sure" dialog.
 *
 * ## Hiding a button is not access control
 *
 * `mayVerify` only decides whether to draw the controls. All four procedures
 * are `adminProcedure('verifyPayments')` (owner and finance), and the server
 * refuses everyone else regardless of what is drawn.
 *
 * ## Two things wait here, and they ask different questions
 *
 * A receipt asks "does this screenshot match the amount". Cash asks "did this
 * person actually hand the money over" — so it keeps its own panel, naming
 * the driver, and ONE PANEL PER CLAIM: two taps of the driver's button are two
 * rows by design, each approved on its own.
 */
import { useState } from 'react';
import { formatPeso } from '@rg/shared';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { trpc } from '@/lib/trpc';
import { findPendingCash, findPendingReceipt, type DecidablePayment } from './pending-payments';

const PANEL = 'border-brand-blue-200 flex flex-col gap-4 rounded-[14px] border bg-white p-5';
const ALERT =
  'border-brand-warning/30 bg-brand-gold-100 text-brand-gold-800 rounded-lg border p-3 text-sm font-medium';
const TEXTAREA =
  'border-input bg-background focus-visible:ring-brand-blue-600 w-full rounded-md border p-3 text-sm transition-shadow focus-visible:outline-none focus-visible:ring-2';

export default function PaymentDecisions({
  payments,
  mayVerify,
  onChanged,
  className = '',
}: {
  payments: readonly DecidablePayment[];
  mayVerify: boolean;
  onChanged: () => void;
  className?: string;
}) {
  const [reason, setReason] = useState('');
  /** One refusal reason per pending cash claim, keyed by `payments.id`. */
  const [cashReasons, setCashReasons] = useState<Record<number, string>>({});

  const approve = trpc.admin.bookings.approveReceipt.useMutation({ onSuccess: onChanged });
  const reject = trpc.admin.bookings.rejectReceipt.useMutation({
    onSuccess: () => {
      setReason('');
      onChanged();
    },
  });
  const approveCash = trpc.admin.bookings.approveCash.useMutation({ onSuccess: onChanged });
  /*
   * The refusal half. Its reason is per-claim state keyed by `payments.id`,
   * not one shared string: two claims are two rows, each refused on its own
   * evidence, and a single box would put one claim's reason onto the other's
   * audit row.
   */
  const rejectCash = trpc.admin.bookings.rejectCash.useMutation({
    onSuccess: (_data, variables) => {
      setCashReasons((previous) => {
        const next = { ...previous };
        delete next[variables.paymentId];
        return next;
      });
      onChanged();
    },
  });

  const pendingReceipt = findPendingReceipt(payments);
  const pendingCash = findPendingCash(payments);
  const decisionError = approve.error?.message ?? reject.error?.message ?? null;

  if (!mayVerify || (!pendingReceipt && pendingCash.length === 0)) return null;

  return (
    <div className={['flex flex-col gap-6', className].join(' ')}>
      {pendingReceipt ? (
        <section aria-labelledby="decide-heading" className={PANEL}>
          <h2 id="decide-heading" className="text-brand-ink text-lg font-bold">
            Verify this receipt
          </h2>

          {decisionError ? (
            <p role="alert" className={ALERT}>
              {decisionError}
            </p>
          ) : null}

          <Button
            type="button"
            className="tap-target w-full"
            disabled={approve.isPending}
            onClick={() => approve.mutate({ paymentId: pendingReceipt.id })}
          >
            {approve.isPending
              ? 'Approving…'
              : `Approve ${formatPeso(pendingReceipt.amountCentavos)}`}
          </Button>

          <div className="border-brand-blue-100 space-y-1.5 border-t pt-4">
            <Label htmlFor="reject-reason">
              Reason, if you are rejecting it — the guest reads this
            </Label>
            <textarea
              id="reject-reason"
              rows={3}
              maxLength={400}
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              className={TEXTAREA}
              placeholder="e.g. The amount is short by ₱500."
            />
            <Button
              type="button"
              variant="outline"
              className="tap-target w-full"
              disabled={reject.isPending || reason.trim().length === 0}
              onClick={() => reject.mutate({ paymentId: pendingReceipt.id, reason: reason.trim() })}
            >
              {reject.isPending ? 'Rejecting…' : 'Reject and ask for another receipt'}
            </Button>
          </div>
        </section>
      ) : null}

      {/*
       * A driver's tap is a CLAIM; this button is the reconciliation. The two
       * are deliberately different people — a driver who could verify their
       * own collection could pocket the cash and leave the booking reading
       * "paid in full" — so the heading says "says they collected" and the
       * driver is named in the button itself. That is the fact being
       * confirmed. The refusal needs a typed reason and the button names the
       * driver and the amount: a stronger deliberateness gate than a dialog
       * nobody reads.
       */}
      {pendingCash.map((claim) => (
        <section
          key={claim.id}
          aria-labelledby={`cash-heading-${claim.id}`}
          data-testid={`cash-claim-${claim.id}`}
          className={PANEL}
        >
          <h2 id={`cash-heading-${claim.id}`} className="text-brand-ink text-lg font-bold">
            Cash a driver says they collected
          </h2>
          <p className="text-brand-error text-sm">
            {claim.collectedByDriverName ?? 'A driver'} recorded {formatPeso(claim.amountCentavos)}{' '}
            on tour day. Approve it once the money is in hand — that is what credits this booking.
          </p>

          {/* SCOPED to the claim whose mutation failed. Amber, never red. */}
          {approveCash.error && approveCash.variables?.paymentId === claim.id ? (
            <p role="alert" className={ALERT}>
              {approveCash.error.message}
            </p>
          ) : null}

          <Button
            type="button"
            className="tap-target w-full"
            disabled={approveCash.isPending}
            onClick={() => approveCash.mutate({ paymentId: claim.id })}
          >
            {approveCash.isPending && approveCash.variables?.paymentId === claim.id
              ? 'Confirming…'
              : `Confirm ${formatPeso(claim.amountCentavos)} received`}
          </Button>

          {/* STACKED under the approve button: at 360px two half-width targets would sit side by side, and these two mean opposite things. */}
          <div className="border-brand-blue-100 space-y-1.5 border-t pt-4">
            <Label htmlFor={`cash-reject-reason-${claim.id}`}>
              Why the cash was not received — required
            </Label>
            <textarea
              id={`cash-reject-reason-${claim.id}`}
              rows={2}
              maxLength={400}
              value={cashReasons[claim.id] ?? ''}
              onChange={(event) =>
                setCashReasons((previous) => ({ ...previous, [claim.id]: event.target.value }))
              }
              aria-describedby={`cash-reject-hint-${claim.id}`}
              className={TEXTAREA}
              placeholder="e.g. The driver never handed this in."
            />
            <p id={`cash-reject-hint-${claim.id}`} className="text-brand-error text-sm">
              The office reads this, not the guest. Nothing is credited either way — refusing closes
              the claim and lets the driver record the cash again.
            </p>

            {rejectCash.error && rejectCash.variables?.paymentId === claim.id ? (
              <p role="alert" className={ALERT}>
                {rejectCash.error.message}
              </p>
            ) : null}

            <Button
              type="button"
              variant="outline"
              className="tap-target w-full"
              disabled={rejectCash.isPending || (cashReasons[claim.id] ?? '').trim().length === 0}
              onClick={() =>
                rejectCash.mutate({
                  paymentId: claim.id,
                  reason: (cashReasons[claim.id] ?? '').trim(),
                })
              }
            >
              {rejectCash.isPending && rejectCash.variables?.paymentId === claim.id
                ? 'Recording…'
                : `Record that ${claim.collectedByDriverName ?? 'the driver'}’s ${formatPeso(
                    claim.amountCentavos,
                  )} never arrived`}
            </Button>
          </div>
        </section>
      ))}
    </div>
  );
}
