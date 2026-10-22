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
import { BOOKING_NOTE_MAX_LENGTH, formatPeso } from '@rg/shared';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { trpc } from '@/lib/trpc';
import AssignPanel from '@/components/admin/AssignPanel';
import CancelRefundPanel from '@/components/admin/CancelRefundPanel';

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

/**
 * §9 "Bookings: view, notes": every staff role that can open this page may
 * also write a note on it (`bookingsView`). The server enforces it; this only
 * decides whether to draw the form.
 */
const MAY_WRITE_NOTES = ['owner', 'dispatcher', 'finance'];

export default function AdminBookingDetailPage() {
  const { ref = '' } = useParams();
  const [reason, setReason] = useState('');
  /** One refusal reason per pending cash claim, keyed by `payments.id`. */
  const [cashReasons, setCashReasons] = useState<Record<number, string>>({});
  /*
   * The note form (Week 6.5 D6). `shareWithDriver` starts false and is put
   * back to false after every write: the safe direction is the one the form
   * returns to, so a note is never shown to a driver by leftover state from
   * the note before it.
   */
  const [noteText, setNoteText] = useState('');
  const [shareWithDriver, setShareWithDriver] = useState(false);

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
  /*
   * The refusal half (Week 6.5 D2). Its reason is per-claim state keyed by
   * `payments.id`, not one shared string: two taps of the driver's button
   * are two rows by design, each refused on its own evidence, and a single
   * box would put one claim's reason onto the other's audit row.
   */
  const rejectCash = trpc.admin.bookings.rejectCash.useMutation({
    onSuccess: (_data, variables) => {
      setCashReasons((previous) => {
        const next = { ...previous };
        delete next[variables.paymentId];
        return next;
      });
      void query.refetch();
    },
  });

  const addNote = trpc.admin.bookings.addNote.useMutation({
    onSuccess: () => {
      setNoteText('');
      setShareWithDriver(false);
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
  const mayWriteNotes = me.data ? MAY_WRITE_NOTES.includes(me.data.role) : false;
  const noteIsEmpty = noteText.trim() === '';
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
       * **And the refusal, since D2.** `rejectCash` closes a claim whose
       * money never arrived: the row becomes `rejected` with the reason,
       * nothing moves on the booking — a claim credited nothing, so there
       * is nothing to take back — and the driver's payment box returns to
       * `collect_cash`, which is what unblocks a booking a mistaken tap had
       * frozen. It is NOT the receipt rejection's shape: no guest is
       * emailed and no re-upload deadline is set, because this is an
       * internal finding about a driver.
       *
       * The reason is REQUIRED and the button names the driver and the
       * amount, in place of an "are you sure" modal. Typing a sentence is a
       * stronger deliberateness gate than a dialog nobody reads, and a
       * refusal is a finding about a person: a vague button is how the
       * wrong claim gets refused.
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

              {/*
                SCOPED to the claim whose mutation failed — the pattern
                `approveCash` established. Two claims on one booking each
                have their own button, so an unscoped error would raise an
                alert under both and leave the verifier guessing which one
                was refused. Amber, never red (CLAUDE.md).
              */}
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

              {/*
                The refusal (D2). STACKED under the approve button rather
                than beside it — at 360px two buttons in a row are two
                half-width targets, and these two mean opposite things.
                `border-t` separates them so the destructive one is not
                mistaken for part of the approval.
              */}
              <div className="border-border space-y-1.5 border-t pt-4">
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
                  className="border-input bg-background focus-visible:ring-brand-blue-600 w-full rounded-md border p-3 text-sm focus-visible:outline-none focus-visible:ring-2"
                  placeholder="e.g. The driver never handed this in."
                />
                <p id={`cash-reject-hint-${claim.id}`} className="text-muted-foreground text-sm">
                  The office reads this, not the guest. Nothing is credited either way — refusing
                  closes the claim and lets the driver record the cash again.
                </p>

                {rejectCash.error && rejectCash.variables?.paymentId === claim.id ? (
                  <p
                    role="alert"
                    className="border-brand-warning/30 bg-brand-gold-100 text-brand-gold-800 rounded-lg border p-3 text-sm font-medium"
                  >
                    {rejectCash.error.message}
                  </p>
                ) : null}

                <Button
                  type="button"
                  variant="outline"
                  className="tap-target w-full"
                  disabled={
                    rejectCash.isPending || (cashReasons[claim.id] ?? '').trim().length === 0
                  }
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
          ))
        : null}

      {/*
       * Cancel and refund (Week 6 Task 13, §13's 6F). Its own component with
       * its own role gate — §9 gives this to owner and finance
       * (`cancelRefund`), which is a different row from the `bookingsView`
       * that lets a dispatcher read this page, so it renders nothing for
       * them. The server refuses them either way.
       *
       * Below the payments list on purpose: an admin should have read the
       * money trail before being offered a button that moves it.
       */}
      <CancelRefundPanel
        bookingId={booking.id}
        bookingRef={booking.ref}
        status={booking.status}
        paidCentavos={booking.paidCentavos}
        payments={booking.payments}
        onChanged={() => void query.refetch()}
      />

      {booking.notes.length > 0 || mayWriteNotes ? (
        <section
          aria-labelledby="notes-heading"
          className="border-border bg-background mt-6 rounded-2xl border p-5 text-sm"
        >
          <h2 id="notes-heading" className="text-brand-blue-900 text-base font-semibold">
            Staff notes
          </h2>
          {booking.notes.length > 0 ? (
            <ul className="mt-3 space-y-3">
              {booking.notes.map((note) => (
                <li key={note.id} className="text-brand-blue-900">
                  <p>{note.note}</p>
                  {/*
                   * Visibility in WORDS (WCAG 1.4.1): which notes the driver
                   * is reading must not depend on a colour or an icon.
                   */}
                  <p className="text-muted-foreground mt-0.5 text-xs font-medium">
                    {note.visibleToDriver ? 'Driver can see this' : 'Office only'}
                  </p>
                </li>
              ))}
            </ul>
          ) : null}

          {mayWriteNotes ? (
            <form
              className="mt-4 space-y-3"
              onSubmit={(event) => {
                event.preventDefault();
                if (noteIsEmpty || addNote.isPending) return;
                addNote.mutate({
                  bookingId: booking.id,
                  note: noteText.trim(),
                  visibleToDriver: shareWithDriver,
                });
              }}
            >
              <div className="space-y-1.5">
                <Label htmlFor="booking-note">Add a note</Label>
                <textarea
                  id="booking-note"
                  value={noteText}
                  maxLength={BOOKING_NOTE_MAX_LENGTH}
                  rows={3}
                  onChange={(event) => setNoteText(event.target.value)}
                  className="border-input bg-background focus-visible:ring-ring min-h-24 w-full rounded-md border px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2"
                />
              </div>

              <div>
                <label
                  htmlFor="booking-note-driver"
                  className="tap-target flex cursor-pointer items-center gap-2 text-sm font-medium"
                >
                  <input
                    id="booking-note-driver"
                    type="checkbox"
                    checked={shareWithDriver}
                    onChange={(event) => setShareWithDriver(event.target.checked)}
                    className="accent-brand-blue-600 size-5 shrink-0"
                    aria-describedby="booking-note-driver-help"
                  />
                  Show this note to the driver
                </label>
                <p id="booking-note-driver-help" className="text-muted-foreground text-xs">
                  Notes are office-only unless this is ticked. The driver is not told that
                  office-only notes exist.
                </p>
              </div>

              {addNote.isError ? (
                <p
                  role="alert"
                  className="border-brand-warning/30 bg-brand-gold-100 text-brand-gold-800 rounded-lg border p-3 text-sm font-medium"
                >
                  {addNote.error.message}
                </p>
              ) : null}

              <Button
                type="submit"
                className="tap-target"
                disabled={noteIsEmpty || addNote.isPending}
              >
                {addNote.isPending ? (
                  <>
                    <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                    Saving note…
                  </>
                ) : (
                  'Save note'
                )}
              </Button>
            </form>
          ) : null}
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
