/**
 * One booking, and the verification queue's working screen (BUILD_SPEC §9,
 * Week 4 Task 11).
 *
 * The guest, the money, the payments with their receipts, the add-on
 * lines, the staff notes and the audit trail — and, for an owner or a
 * finance user, the two buttons that approve or reject the pending
 * receipt.
 *
 * ## Hiding a button is not access control
 *
 * CLAUDE.md says so, and this screen is the example. The buttons are
 * hidden from a dispatcher as a courtesy — there is no point offering an
 * action that will be refused — but the refusal is the SERVER's:
 * `approveReceipt` and `rejectReceipt` are `adminProcedure
 * ('verifyPayments')`, which is owner and finance only, and a dispatcher
 * who called them from the console would still be refused. The role comes
 * from `staffAuth.me`, which resolves it live from `users` on every
 * request, so a demotion takes effect on the next page load rather than
 * whenever a tab is closed.
 *
 * ## The receipt is a link, not an embedded image
 *
 * `/api/receipts/<name>` is authenticated and answers bytes; an `<img>`
 * would work, but a verifier needs to zoom into a blurry screenshot, so a
 * link that opens the file in its own tab is the better tool. Either way
 * the route is what checks the session.
 *
 * ## Two things wait in this queue, and they ask different questions
 *
 * A guest's uploaded receipt asks "does this screenshot match the amount".
 * Cash a driver recorded on tour day (Week 6 Task 11) asks "did this person
 * actually hand the money over" — so it gets its own panel, naming the
 * driver, and `approveCash` rather than `approveReceipt`. Both are the same
 * `verifyPayments` permission and both credit the booking inside
 * `record-payment.ts`, which is the only module that may.
 *
 * ## A rejection needs a reason, and the guest reads it
 *
 * The reason field is required here because §7 shows it to the guest and
 * the server refuses a blank one. The copy says so, rather than letting an
 * admin discover it from an error.
 */
import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ExternalLink, Loader2 } from 'lucide-react';
import { formatPeso } from '@rg/shared';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { trpc } from '@/lib/trpc';
import AssignPanel from '@/components/admin/AssignPanel';

const STATUS_LABELS: Record<string, string> = {
  pending_payment: 'Awaiting payment',
  pending_verification: 'Checking receipt',
  confirmed: 'Confirmed',
  assigned: 'Driver assigned',
  in_progress: 'On tour',
  completed: 'Completed',
  cancelled: 'Cancelled',
  expired: 'Expired',
};

/** §9: verify payments is owner and finance. The server enforces it. */
const MAY_VERIFY = ['owner', 'finance'];

export default function AdminBookingDetailPage() {
  const { ref = '' } = useParams();
  const [reason, setReason] = useState('');

  const me = trpc.staffAuth.me.useQuery(undefined, { retry: false });
  const query = trpc.admin.bookings.detail.useQuery({ ref }, { retry: false, enabled: ref !== '' });

  const approve = trpc.admin.bookings.approveReceipt.useMutation({
    onSuccess: () => void query.refetch(),
  });
  const reject = trpc.admin.bookings.rejectReceipt.useMutation({
    onSuccess: () => {
      setReason('');
      void query.refetch();
    },
  });
  const approveCash = trpc.admin.bookings.approveCash.useMutation({
    onSuccess: () => void query.refetch(),
  });

  if (query.isPending) {
    return (
      <main className="mx-auto max-w-3xl px-4 py-10">
        <p className="text-muted-foreground flex items-center gap-2 text-sm">
          <Loader2 className="size-4 animate-spin" aria-hidden="true" />
          Loading booking…
        </p>
      </main>
    );
  }

  if (query.isError || !query.data) {
    return (
      <main className="mx-auto max-w-3xl px-4 py-10">
        <h1 className="text-brand-blue-900 text-xl font-bold">Booking not available</h1>
        <p className="text-muted-foreground mt-2 text-sm">
          That reference does not match a booking, or your session has ended.
        </p>
        <Button asChild variant="outline" className="tap-target mt-4">
          <Link to="/admin/bookings">Back to bookings</Link>
        </Button>
      </main>
    );
  }

  const booking = query.data;
  const pendingReceipt = booking.payments.find(
    (payment) => payment.status === 'pending' && payment.receiptPath !== null,
  );
  /*
   * The driver's claims (Week 6 Task 11). The same two-arm split the server
   * scopes itself to: a receipt is a file, cash is `method === 'cash'`. Kept
   * as its own panel rather than folded into the receipt one, because the
   * question is a different question — not "does this screenshot match the
   * amount" but "did this driver actually hand over this money".
   *
   * **All four conditions, matching the server's clause** (Task 11 review):
   * `verifyPendingManualPayment()` scopes to `type='payment' AND
   * provider='manual' AND method='cash'`, and this finder omitted the first
   * two. Nothing writes a non-manual cash row today and the server fails
   * closed either way, so this was no live risk — but two halves of one
   * rule that disagree is how the screen comes to offer a button the server
   * then refuses.
   *
   * **`filter`, not `find`** (Task 11 review): `recordPendingCash()`
   * deliberately does NOT merge two taps of the driver's button — "two
   * genuinely separate claims of cash, which finance must see as two rows
   * and resolve". A `find` here showed one of them and silently hid the
   * other, which is the money going missing from the screen rather than
   * from the till.
   */
  const pendingCash = booking.payments.filter(
    (payment) =>
      payment.status === 'pending' &&
      payment.type === 'payment' &&
      payment.provider === 'manual' &&
      payment.method === 'cash',
  );
  const mayVerify = me.data ? MAY_VERIFY.includes(me.data.role) : false;
  const decisionError = approve.error?.message ?? reject.error?.message ?? null;

  return (
    <main className="mx-auto max-w-3xl px-4 py-8">
      <Link to="/admin/bookings" className="text-brand-blue-700 text-sm underline">
        ← Bookings
      </Link>

      <header className="mt-4">
        <h1 className="text-brand-blue-900 font-mono text-2xl font-bold">{booking.ref}</h1>
        <p className="text-brand-blue-900 mt-1 font-medium">{booking.tourTitle}</p>
        <p className="text-muted-foreground text-sm">
          {booking.tourDate} · {booking.pax} pax · {STATUS_LABELS[booking.status] ?? booking.status}
        </p>
      </header>

      <section
        aria-labelledby="guest-heading"
        className="border-border bg-background mt-6 rounded-2xl border p-5 text-sm"
      >
        <h2 id="guest-heading" className="text-brand-blue-900 text-base font-semibold">
          Guest
        </h2>
        <dl className="mt-3 space-y-1">
          <div className="flex gap-2">
            <dt className="text-muted-foreground w-24">Name</dt>
            <dd className="text-brand-blue-900">{booking.leadName}</dd>
          </div>
          <div className="flex gap-2">
            <dt className="text-muted-foreground w-24">Email</dt>
            <dd className="text-brand-blue-900 break-all">{booking.leadEmail}</dd>
          </div>
          <div className="flex gap-2">
            <dt className="text-muted-foreground w-24">Phone</dt>
            <dd className="text-brand-blue-900">{booking.leadPhone}</dd>
          </div>
        </dl>
      </section>

      {/*
        Task 12: §9 lists "Assign van + driver" under Bookings detail as well
        as on the calendar, so the SAME component mounts here. It renders
        nothing for finance, who can read this page (`bookingsView`) but
        cannot assign (`assignVanDriver`).
      */}
      <section
        aria-labelledby="assign-heading"
        className="border-border mt-6 rounded-2xl border p-5"
      >
        <h2 id="assign-heading" className="text-brand-blue-900 text-base font-semibold">
          Dispatch
        </h2>
        <AssignPanel
          bookingId={booking.id}
          pax={booking.pax}
          status={booking.status}
          currentVanId={booking.vanId}
          currentDriverId={booking.driverId}
          onAssigned={() => void query.refetch()}
        />
      </section>

      <section
        aria-labelledby="money-heading"
        className="border-brand-blue-200 bg-brand-blue-50 mt-6 rounded-2xl border p-5 text-sm"
      >
        <h2 id="money-heading" className="text-brand-blue-900 text-base font-semibold">
          Money
        </h2>
        <dl className="mt-3 space-y-1">
          <div className="flex justify-between">
            <dt className="text-muted-foreground">Total</dt>
            <dd className="text-brand-blue-900 font-semibold tabular-nums">
              {formatPeso(booking.totalCentavos)}
            </dd>
          </div>
          <div className="flex justify-between">
            <dt className="text-muted-foreground">Paid</dt>
            <dd className="text-brand-blue-900 font-semibold tabular-nums">
              {formatPeso(booking.paidCentavos)}
            </dd>
          </div>
        </dl>
        {booking.paymentReviewRequired ? (
          <p
            role="status"
            className="border-brand-warning/30 bg-brand-gold-100 text-brand-gold-800 mt-3 rounded-lg border p-3 font-medium"
          >
            Flagged for payment review: money arrived on a booking that could not accept it.
          </p>
        ) : null}
        {booking.addons.length > 0 ? (
          <ul className="text-muted-foreground mt-3 space-y-1">
            {booking.addons.map((addon) => (
              <li key={addon.id}>
                {addon.qty} × {addon.name} ({formatPeso(addon.priceCentavos)}
                {addon.perPerson ? ' per person' : ''})
              </li>
            ))}
          </ul>
        ) : null}
      </section>

      <section
        aria-labelledby="payments-heading"
        className="border-border bg-background mt-6 rounded-2xl border p-5 text-sm"
      >
        <h2 id="payments-heading" className="text-brand-blue-900 text-base font-semibold">
          Payments
        </h2>
        {booking.payments.length === 0 ? (
          <p className="text-muted-foreground mt-2">Nothing recorded yet.</p>
        ) : (
          <ul className="mt-3 space-y-3">
            {booking.payments.map((payment) => (
              <li key={payment.id} className="border-b pb-3 last:border-0 last:pb-0">
                <p className="text-brand-blue-900 font-medium">
                  {formatPeso(payment.amountCentavos)} · {payment.provider} / {payment.method} ·{' '}
                  {payment.status}
                </p>
                {payment.txnRef ? (
                  <p className="text-muted-foreground font-mono text-xs">Ref {payment.txnRef}</p>
                ) : null}
                {/*
                  Who says they took this money. On the trail as well as in
                  the panel below, because the name has to survive the
                  approval — afterwards this line is the only record on the
                  screen of whose collection was counted.
                */}
                {payment.rejectReason ? (
                  <p className="text-brand-gold-800">Rejected: {payment.rejectReason}</p>
                ) : null}
                {payment.collectedByDriverName ? (
                  <p className="text-muted-foreground">
                    Collected by {payment.collectedByDriverName}
                  </p>
                ) : null}
                {payment.receiptPath ? (
                  <a
                    href={`/api/receipts/${payment.receiptPath}`}
                    target="_blank"
                    rel="noreferrer noopener"
                    className="text-brand-blue-700 hover:text-brand-blue-900 tap-target inline-flex items-center gap-1 underline transition-colors"
                  >
                    <ExternalLink className="size-3.5" aria-hidden="true" />
                    Open receipt
                  </a>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </section>

      {/*
       * The decision. Offered only to a role §9 allows, and refused by the
       * server regardless — see the file note.
       */}
      {pendingReceipt && mayVerify ? (
        <section
          aria-labelledby="decide-heading"
          className="border-brand-blue-200 bg-background mt-6 space-y-4 rounded-2xl border p-5"
        >
          <h2 id="decide-heading" className="text-brand-blue-900 text-base font-semibold">
            Verify this receipt
          </h2>

          {decisionError ? (
            <p
              role="alert"
              className="border-brand-warning/30 bg-brand-gold-100 text-brand-gold-800 rounded-lg border p-3 text-sm font-medium"
            >
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

          <div className="space-y-1.5">
            <Label htmlFor="reject-reason">
              Reason, if you are rejecting it — the guest reads this
            </Label>
            <textarea
              id="reject-reason"
              rows={3}
              maxLength={400}
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              className="border-input bg-background focus-visible:ring-brand-blue-600 w-full rounded-md border p-3 text-sm focus-visible:outline-none focus-visible:ring-2"
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
       * The cash panel (Week 6 Task 11, §8 item 5).
       *
       * A driver's tap is a CLAIM; this button is the reconciliation. The
       * two are deliberately different people — a driver who could verify
       * their own collection could pocket the cash and leave the booking
       * reading "paid in full" — so the heading says "says they collected"
       * rather than "collected", and the driver is named in the button
       * itself. That is the fact being confirmed.
       *
       * There is no reject button here. Nothing in the service can refuse a
       * cash claim yet (the receipt path's rejection is a re-upload deadline
       * for the guest, which makes no sense for money a driver is holding),
       * and a button that cannot do its job is worse than its absence. The
       * copy sends the verifier to a person instead.
       *
       * ONE PANEL PER CLAIM. Two taps of the driver's button are two rows
       * by design, each approved on its own — so each gets its own heading,
       * its own amount and its own button. A single panel would make the
       * second claim invisible and un-approvable.
       */}
      {mayVerify
        ? pendingCash.map((claim) => (
            <section
              key={claim.id}
              aria-labelledby={`cash-heading-${claim.id}`}
              data-testid={`cash-claim-${claim.id}`}
              className="border-brand-blue-200 bg-background mt-6 space-y-4 rounded-2xl border p-5"
            >
              <h2
                id={`cash-heading-${claim.id}`}
                className="text-brand-blue-900 text-base font-semibold"
              >
                Cash a driver says they collected
              </h2>
              <p className="text-muted-foreground text-sm">
                {claim.collectedByDriverName ?? 'A driver'} recorded{' '}
                {formatPeso(claim.amountCentavos)} on tour day. Approve it once the money is in hand
                — that is what credits this booking.
              </p>

              {approveCash.error && approveCash.variables?.paymentId === claim.id ? (
                <p
                  role="alert"
                  className="border-brand-warning/30 bg-brand-gold-100 text-brand-gold-800 rounded-lg border p-3 text-sm font-medium"
                >
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
              <p className="text-muted-foreground text-sm">
                If the money has not arrived, leave this and speak to the driver — nothing is
                credited until someone confirms it here.
              </p>
            </section>
          ))
        : null}

      {booking.notes.length > 0 ? (
        <section
          aria-labelledby="notes-heading"
          className="border-border bg-background mt-6 rounded-2xl border p-5 text-sm"
        >
          <h2 id="notes-heading" className="text-brand-blue-900 text-base font-semibold">
            Staff notes
          </h2>
          <ul className="mt-3 space-y-2">
            {booking.notes.map((note) => (
              <li key={note.id} className="text-brand-blue-900">
                {note.note}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section
        aria-labelledby="audit-heading"
        className="border-border bg-background mt-6 rounded-2xl border p-5 text-sm"
      >
        <h2 id="audit-heading" className="text-brand-blue-900 text-base font-semibold">
          Audit trail
        </h2>
        {booking.audit.length === 0 ? (
          <p className="text-muted-foreground mt-2">Nothing recorded yet.</p>
        ) : (
          <ul className="mt-3 space-y-1">
            {booking.audit.map((entry) => (
              <li key={entry.id} className="text-muted-foreground font-mono text-xs">
                {entry.action} · {entry.actorType}
                {entry.actorId === null ? '' : ` #${entry.actorId}`}
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}
