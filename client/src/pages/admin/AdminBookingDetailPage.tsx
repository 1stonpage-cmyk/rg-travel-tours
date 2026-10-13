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
                {payment.rejectReason ? (
                  <p className="text-brand-gold-800">Rejected: {payment.rejectReason}</p>
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
