/**
 * Cancel and refund, on the booking screen (Week 6 Task 13; BUILD_SPEC §6
 * "Refunds & cancellations", §9's "Cancel / refund" row).
 *
 * ## Both controls are irreversible, so both confirm in place
 *
 * A cancel gives a guest's seats away and a refund moves real money out of
 * the merchant account; neither has an undo in this system, and both are one
 * click away from a mis-read figure. So each one is two steps, and the second
 * step **states the amount in figures AND in words** — the discipline the
 * driver's cash box uses for the same reason (`@/lib/peso-words`, shared so
 * the two screens cannot spell an amount differently).
 *
 * Inline, not a modal: nothing vendored provides one, the house pattern is
 * the two-step confirm in `PaymentBox` and `AdminDriversPage`, and "Keep it"
 * calls nothing at all.
 *
 * ## Hiding a button is not access control
 *
 * The panel renders nothing for a dispatcher because there is no point
 * offering an action that will be refused — but the refusal is the SERVER's:
 * `admin.refunds.cancelBooking` and `.refundPayment` are
 * `adminProcedure('cancelRefund')`, owner and finance only, and a dispatcher
 * calling them from a console is refused with `FORBIDDEN`. The role comes
 * from `staffAuth.me`, which resolves it live from `users` on every request.
 *
 * ## Every figure here is a GUIDE; the server decides
 *
 * "Can still go back" is arithmetic on the payment rows this screen was
 * given, so it is a help to an admin choosing an amount — never a
 * permission. The cap that matters is `recordPayment()`'s, computed inside a
 * transaction under the booking row lock, and when the two disagree the
 * server's refusal is what the admin sees. That is also why the amount is an
 * input at all rather than a computed total: §6 is "Admin cancels a booking,
 * choosing a refund amount (full, partial, none)", which makes the figure a
 * human decision — the one number in this system that legitimately comes
 * from a person, and it is capped rather than trusted.
 *
 * ## A refund is never a booking status
 *
 * Which is why the two blocks below are separate and either can be used
 * alone: cancel with no refund (a guest who had paid nothing), or refund
 * without cancelling (a completed trip that went badly). The server refuses
 * to cancel a `completed` or already-`cancelled` booking, and this panel
 * says so in words instead of offering the button.
 */
import { useState } from 'react';
import { Loader2 } from 'lucide-react';
import { formatPeso } from '@rg/shared';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { pesosInWords } from '@/lib/peso-words';
import { trpc } from '@/lib/trpc';

/** §9's "Cancel / refund" row. The server enforces it; see the file note. */
const MAY_CANCEL_REFUND = ['owner', 'finance'];

/**
 * The statuses the server will cancel FROM
 * (`CANCELLABLE_STATUSES`, `services/payments/cancel-refund.ts`). An
 * allow-list here too, and for the same reason: a status added later shows
 * no button until somebody decides it should.
 */
const CANCELLABLE = [
  'pending_payment',
  'pending_verification',
  'confirmed',
  'assigned',
  'in_progress',
];

/** How the money went back, for §6's offline record. Mirrors `PAYMENT_METHODS`. */
const OFFLINE_METHODS = [
  'gcash',
  'maya',
  'bank_transfer',
  'cash',
  'card',
  'grab_pay',
  'qrph',
] as const;

type OfflineMethod = (typeof OFFLINE_METHODS)[number];

/**
 * One refund form's fields, kept PER SOURCE PAYMENT.
 *
 * A booking can carry two payments that arrived differently — a gateway
 * deposit and cash an admin verified on tour day — and each gets its own
 * form. One shared set of fields would have had an amount typed against the
 * deposit appear under the cash row as well, which on a refund screen is
 * exactly the kind of confusion that moves the wrong money.
 */
interface RefundForm {
  amountPesos: string;
  reason: string;
  method: OfflineMethod;
  reference: string;
}

const EMPTY_FORM: RefundForm = { amountPesos: '', reason: '', method: 'gcash', reference: '' };

/** The slice of `admin.bookings.detail`'s payment rows this panel reads. */
export interface RefundablePayment {
  id: number;
  type: string;
  provider: string;
  method: string;
  amountCentavos: number;
  status: string;
}

interface CancelRefundPanelProps {
  bookingId: number;
  /** The public ref, named in both confirmations so nobody cancels the wrong booking. */
  bookingRef: string;
  status: string;
  /** `bookings.amount_paid_centavos` — money IN, which refunds are measured against. */
  paidCentavos: number;
  payments: RefundablePayment[];
  /** Refetch the booking. Called after a cancel or a refund lands. */
  onChanged: () => void;
}

const WARNING_BOX =
  'border-brand-warning/30 bg-brand-gold-100 text-brand-gold-800 rounded-lg border p-3 text-sm font-medium';

const FIELD =
  'border-input bg-background focus-visible:ring-brand-blue-600 w-full rounded-md border p-3 text-sm focus-visible:outline-none focus-visible:ring-2';

export default function CancelRefundPanel({
  bookingId,
  bookingRef,
  status,
  paidCentavos,
  payments,
  onChanged,
}: CancelRefundPanelProps) {
  const me = trpc.staffAuth.me.useQuery(undefined, { retry: false });

  const [cancelReason, setCancelReason] = useState('');
  const [confirmingCancel, setConfirmingCancel] = useState(false);
  /** Which payment's refund form is open on its confirmation step. */
  const [confirmingRefundId, setConfirmingRefundId] = useState<number | null>(null);
  const [forms, setForms] = useState<Record<number, RefundForm>>({});
  const formFor = (paymentId: number): RefundForm => forms[paymentId] ?? EMPTY_FORM;
  const patchForm = (paymentId: number, patch: Partial<RefundForm>) =>
    setForms((previous) => ({
      ...previous,
      [paymentId]: { ...(previous[paymentId] ?? EMPTY_FORM), ...patch },
    }));

  const cancel = trpc.admin.refunds.cancelBooking.useMutation({
    onSuccess: () => {
      setConfirmingCancel(false);
      setCancelReason('');
      onChanged();
    },
  });
  const refund = trpc.admin.refunds.refundPayment.useMutation({
    onSuccess: (_result, variables) => {
      setConfirmingRefundId(null);
      setForms((previous) => ({ ...previous, [variables.paymentId]: EMPTY_FORM }));
      onChanged();
    },
  });

  if (!me.data || !MAY_CANCEL_REFUND.includes(me.data.role)) return null;

  /*
   * The guide figures. `type === 'refund'` rows are money out; everything
   * else is ignored, because `paidCentavos` already IS the money in.
   */
  const refunded = payments
    .filter((payment) => payment.type === 'refund')
    .reduce((sum, payment) => sum + payment.amountCentavos, 0);
  const remaining = Math.max(paidCentavos - refunded, 0);
  /** Only money that actually arrived can go back. */
  const sources = payments.filter(
    (payment) => payment.type === 'payment' && payment.status === 'paid',
  );

  return (
    <section
      aria-labelledby="cancel-refund-heading"
      className="border-brand-blue-200 bg-background mt-6 space-y-5 rounded-2xl border p-5"
    >
      <div>
        <h2 id="cancel-refund-heading" className="text-brand-blue-900 text-base font-semibold">
          Cancel or refund
        </h2>
        <p className="text-muted-foreground mt-1 text-sm">
          Paid {formatPeso(paidCentavos)} · already refunded {formatPeso(refunded)} · can still go
          back {formatPeso(remaining)}. These are a guide — the server checks the figures again
          before any money moves.
        </p>
      </div>

      {/* ------------------------------ cancel ------------------------------ */}
      <div className="border-brand-blue-200 space-y-3 border-t pt-5">
        <h3 className="text-brand-blue-900 text-sm font-semibold">Cancel this booking</h3>

        {CANCELLABLE.includes(status) ? (
          <>
            <div className="space-y-1.5">
              <Label htmlFor="cancel-reason">
                Why is it being cancelled? Staff read this later
              </Label>
              <textarea
                id="cancel-reason"
                rows={2}
                maxLength={400}
                value={cancelReason}
                onChange={(event) => setCancelReason(event.target.value)}
                className={FIELD}
                placeholder="e.g. Typhoon signal 3 — all trips off."
              />
            </div>

            {cancel.error ? (
              <p role="alert" className={WARNING_BOX}>
                {cancel.error.message}
              </p>
            ) : null}

            {confirmingCancel ? (
              /*
               * Step two. It names the booking and states what has been paid
               * in figures and in words, because the thing an admin can get
               * wrong here is cancelling the booking next to the one they
               * meant — and because cancelling sends nothing back on its own.
               */
              <div className="border-brand-blue-200 space-y-3 border-t pt-4">
                <p className="text-brand-blue-900 text-sm font-semibold">
                  Cancel {bookingRef}? The seats go back on sale immediately.
                </p>
                <p className="text-brand-blue-900 text-sm">
                  {formatPeso(paidCentavos)} has been paid on it — {pesosInWords(paidCentavos)}.
                  Cancelling does <strong>not</strong> send that back; record the refund below.
                </p>
                <Button
                  type="button"
                  className="tap-target w-full"
                  disabled={cancel.isPending}
                  onClick={() => cancel.mutate({ bookingId, reason: cancelReason.trim() })}
                >
                  {cancel.isPending ? (
                    <>
                      <Loader2 className="mr-2 size-4 animate-spin" aria-hidden="true" />
                      Cancelling…
                    </>
                  ) : (
                    `Yes — cancel ${bookingRef}`
                  )}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  className="tap-target text-brand-blue-900 w-full"
                  disabled={cancel.isPending}
                  onClick={() => setConfirmingCancel(false)}
                >
                  Keep it
                </Button>
              </div>
            ) : (
              <Button
                type="button"
                variant="outline"
                className="tap-target text-brand-blue-900 w-full"
                disabled={cancelReason.trim().length === 0}
                onClick={() => setConfirmingCancel(true)}
              >
                Cancel this booking
              </Button>
            )}
          </>
        ) : (
          <p className="text-muted-foreground text-sm">
            This booking cannot be cancelled from here — a trip that has finished, or one already
            cancelled, stays as it is. Money can still go back below.
          </p>
        )}
      </div>

      {/* ------------------------------ refund ------------------------------ */}
      <div className="border-brand-blue-200 space-y-3 border-t pt-5">
        <h3 className="text-brand-blue-900 text-sm font-semibold">Send money back</h3>

        {sources.length === 0 ? (
          <p className="text-muted-foreground text-sm">
            No money has arrived on this booking, so there is nothing to refund.
          </p>
        ) : (
          sources.map((source) => {
            const manual = source.provider === 'manual';
            const confirming = confirmingRefundId === source.id;
            const showError = refund.error && refund.variables?.paymentId === source.id;
            const form = formFor(source.id);
            /*
             * Pesos in, centavos out, the one place the conversion happens.
             * Money is centavos everywhere else in this system (CLAUDE.md) —
             * this field exists because an admin types pesos.
             *
             * **WHOLE pesos only** (fix round 1, finding 5). `step={1}` does
             * not stop someone typing `450.75`: that became a 45,075-centavo
             * payout while both `formatPeso` and `pesosInWords` round to
             * whole pesos, so the confirmation read "₱451 / Four hundred
             * fifty-one pesos" for a different amount than the one sent. On a
             * control whose entire defence is that the figures and the words
             * agree with what leaves the account, that cannot stand — and
             * every price in this system is whole pesos anyway, so the
             * refusal costs nothing.
             */
            const typedPesos = Number(form.amountPesos);
            const requestedCentavos = Math.round(typedPesos * 100);
            const amountIsUsable =
              form.amountPesos.trim().length > 0 &&
              Number.isInteger(typedPesos) &&
              requestedCentavos > 0;
            const offlineReady = !manual || form.reference.trim().length > 0;
            const ready = amountIsUsable && form.reason.trim().length > 0 && offlineReady;

            return (
              <div
                key={source.id}
                data-testid={`refund-source-${source.id}`}
                className="border-brand-blue-200 space-y-3 rounded-xl border p-4"
              >
                <p className="text-brand-blue-900 text-sm font-medium">
                  {formatPeso(source.amountCentavos)} came in · {source.provider} / {source.method}
                </p>
                <p className="text-muted-foreground text-sm">
                  {manual
                    ? 'Taken by hand, so there is no gateway to call: send the money back yourself, then record how and its reference.'
                    : 'It goes back through the same gateway that took it.'}
                </p>

                <div className="space-y-1.5">
                  <Label htmlFor={`refund-amount-${source.id}`}>
                    Amount to refund, in whole pesos
                  </Label>
                  <input
                    id={`refund-amount-${source.id}`}
                    type="number"
                    inputMode="numeric"
                    min={1}
                    step={1}
                    value={form.amountPesos}
                    onChange={(event) => patchForm(source.id, { amountPesos: event.target.value })}
                    className={FIELD}
                    placeholder={String(Math.round(remaining / 100))}
                  />
                </div>

                <div className="space-y-1.5">
                  <Label htmlFor={`refund-reason-${source.id}`}>Why</Label>
                  <input
                    id={`refund-reason-${source.id}`}
                    type="text"
                    maxLength={400}
                    value={form.reason}
                    onChange={(event) => patchForm(source.id, { reason: event.target.value })}
                    className={FIELD}
                    placeholder="e.g. requested_by_customer"
                  />
                </div>

                {manual ? (
                  <div className="grid gap-3 sm:grid-cols-2">
                    <div className="space-y-1.5">
                      <Label htmlFor={`refund-method-${source.id}`}>How it went back</Label>
                      <select
                        id={`refund-method-${source.id}`}
                        value={form.method}
                        onChange={(event) =>
                          patchForm(source.id, { method: event.target.value as OfflineMethod })
                        }
                        className={FIELD}
                      >
                        {OFFLINE_METHODS.map((method) => (
                          <option key={method} value={method}>
                            {method.replace('_', ' ')}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div className="space-y-1.5">
                      <Label htmlFor={`refund-reference-${source.id}`}>Reference</Label>
                      <input
                        id={`refund-reference-${source.id}`}
                        type="text"
                        maxLength={191}
                        value={form.reference}
                        onChange={(event) =>
                          patchForm(source.id, { reference: event.target.value })
                        }
                        className={FIELD}
                        placeholder="e.g. GCash ref 0123456789"
                      />
                    </div>
                  </div>
                ) : null}

                {showError ? (
                  <p role="alert" className={WARNING_BOX}>
                    {refund.error?.message}
                  </p>
                ) : null}

                {confirming ? (
                  /*
                   * Step two, and the figures-and-words line is the whole
                   * point of it: a refund cannot be taken back, and a
                   * mistyped zero is the mistake this catches.
                   */
                  <div className="border-brand-blue-200 space-y-3 border-t pt-4">
                    <p className="text-brand-blue-900 text-sm font-semibold">
                      Send {formatPeso(requestedCentavos)} back from {bookingRef}?
                    </p>
                    <p className="text-brand-blue-900 text-sm font-semibold">
                      {pesosInWords(requestedCentavos)}.
                    </p>
                    <p className="text-muted-foreground text-sm">
                      {manual
                        ? 'This records a refund you have already sent. It cannot be undone here.'
                        : 'This asks the gateway to pay the guest. It cannot be undone here.'}
                    </p>
                    <Button
                      type="button"
                      className="tap-target w-full"
                      disabled={refund.isPending}
                      onClick={() =>
                        refund.mutate({
                          paymentId: source.id,
                          amountCentavos: requestedCentavos,
                          reason: form.reason.trim(),
                          ...(manual
                            ? {
                                offline: { method: form.method, reference: form.reference.trim() },
                              }
                            : {}),
                        })
                      }
                    >
                      {refund.isPending ? (
                        <>
                          <Loader2 className="mr-2 size-4 animate-spin" aria-hidden="true" />
                          Refunding…
                        </>
                      ) : (
                        `Yes — refund ${formatPeso(requestedCentavos)}`
                      )}
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      className="tap-target text-brand-blue-900 w-full"
                      disabled={refund.isPending}
                      onClick={() => setConfirmingRefundId(null)}
                    >
                      Keep it
                    </Button>
                  </div>
                ) : (
                  <Button
                    type="button"
                    className="tap-target w-full"
                    disabled={!ready}
                    onClick={() => setConfirmingRefundId(source.id)}
                  >
                    Refund {amountIsUsable ? formatPeso(requestedCentavos) : 'this payment'}
                  </Button>
                )}
              </div>
            );
          })
        )}
      </div>
    </section>
  );
}
