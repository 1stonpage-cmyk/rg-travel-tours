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
import PaymentDecisions from '@/components/admin/PaymentDecisions';
import BookingStatusPill from '@/components/admin/BookingStatusPill';

const CARD = 'border-brand-blue-100 rounded-[14px] border bg-white p-5 text-sm';
const HEADING = 'text-brand-ink text-lg font-bold';
const PRIMARY_BUTTON =
  'tap-target bg-brand-blue-700 hover:bg-brand-blue-800 rounded-[10px] font-semibold text-white transition-colors';
const OUTLINE_BUTTON =
  'tap-target border-brand-blue-200 text-brand-blue-700 hover:bg-brand-blue-50 hover:text-brand-blue-800 rounded-[10px] font-semibold transition-colors';

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

  const addNote = trpc.admin.bookings.addNote.useMutation({
    onSuccess: () => {
      setNoteText('');
      setShareWithDriver(false);
      void query.refetch();
    },
  });

  if (query.isPending) {
    return (
      <div>
        <p className="text-brand-error flex items-center gap-2 text-sm">
          <Loader2 className="size-4 animate-spin" aria-hidden="true" />
          Loading booking…
        </p>
      </div>
    );
  }

  if (query.isError || !query.data) {
    return (
      <div className="flex flex-col items-start gap-3">
        <h1 className="text-brand-ink text-2xl font-bold">Booking not available</h1>
        <p className="text-brand-error text-sm">
          That reference does not match a booking, or your session has ended.
        </p>
        <Button asChild variant="outline" className={OUTLINE_BUTTON}>
          <Link to="/admin/bookings">Back to bookings</Link>
        </Button>
      </div>
    );
  }

  const booking = query.data;
  const mayVerify = me.data ? MAY_VERIFY.includes(me.data.role) : false;
  const mayWriteNotes = me.data ? MAY_WRITE_NOTES.includes(me.data.role) : false;
  const noteIsEmpty = noteText.trim() === '';

  return (
    <div className="flex flex-col gap-6">
      <Link
        to="/admin/bookings"
        className="text-brand-blue-700 hover:text-brand-blue-900 tap-target -mb-3 inline-flex w-fit items-center text-sm font-semibold underline underline-offset-4 transition-colors"
      >
        ← Bookings
      </Link>

      <header className="flex flex-col gap-1">
        <p className="text-brand-gold-700 text-xs font-semibold uppercase tracking-[0.08em]">
          Booking
        </p>
        <h1 className="text-brand-ink font-mono text-2xl font-bold sm:text-3xl">{booking.ref}</h1>
        <p className="text-brand-ink font-semibold">{booking.tourTitle}</p>
        <p className="text-brand-error flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
          <span>
            {booking.tourDate} · {booking.pax} pax
          </span>
          <BookingStatusPill status={booking.status} />
        </p>
      </header>

      <section aria-labelledby="guest-heading" className={CARD}>
        <h2 id="guest-heading" className={HEADING}>
          Guest
        </h2>
        <dl className="mt-3 space-y-1">
          <div className="flex gap-2">
            <dt className="text-brand-error w-24 shrink-0">Name</dt>
            <dd className="text-brand-ink font-medium">{booking.leadName}</dd>
          </div>
          <div className="flex gap-2">
            <dt className="text-brand-error w-24 shrink-0">Email</dt>
            <dd className="text-brand-ink break-all">{booking.leadEmail}</dd>
          </div>
          <div className="flex gap-2">
            <dt className="text-brand-error w-24 shrink-0">Phone</dt>
            <dd className="text-brand-ink">{booking.leadPhone}</dd>
          </div>
        </dl>
      </section>

      {/*
        Task 12: §9 lists "Assign van + driver" under Bookings detail as well
        as on the calendar, so the SAME component mounts here. It renders
        nothing for finance, who can read this page (`bookingsView`) but
        cannot assign (`assignVanDriver`).
      */}
      <section aria-labelledby="assign-heading" className={CARD}>
        <h2 id="assign-heading" className={HEADING}>
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
        className="border-brand-blue-200 bg-brand-blue-50 rounded-[14px] border p-5 text-sm"
      >
        <h2 id="money-heading" className={HEADING}>
          Money
        </h2>
        <dl className="mt-3 space-y-1">
          <div className="flex justify-between">
            <dt className="text-brand-error">Total</dt>
            <dd className="text-brand-ink text-base font-bold tabular-nums">
              {formatPeso(booking.totalCentavos)}
            </dd>
          </div>
          <div className="flex justify-between">
            <dt className="text-brand-error">Paid</dt>
            <dd className="text-brand-ink text-base font-bold tabular-nums">
              {formatPeso(booking.paidCentavos)}
            </dd>
          </div>
        </dl>
        {booking.paymentReviewRequired ? (
          <p
            role="status"
            className="border-brand-warning/30 bg-brand-gold-100 text-brand-gold-800 mt-3 rounded-xl border p-3 font-medium"
          >
            Flagged for payment review: money arrived on a booking that could not accept it.
          </p>
        ) : null}
        {booking.addons.length > 0 ? (
          <ul className="text-brand-error mt-3 space-y-1">
            {booking.addons.map((addon) => (
              <li key={addon.id}>
                {addon.qty} × {addon.name} ({formatPeso(addon.priceCentavos)}
                {addon.perPerson ? ' per person' : ''})
              </li>
            ))}
          </ul>
        ) : null}
      </section>

      <section aria-labelledby="payments-heading" className={CARD}>
        <h2 id="payments-heading" className={HEADING}>
          Payments
        </h2>
        {booking.payments.length === 0 ? (
          <p className="text-brand-error mt-2">Nothing recorded yet.</p>
        ) : (
          <ul className="mt-3 space-y-3">
            {booking.payments.map((payment) => (
              <li
                key={payment.id}
                className="border-brand-blue-100 border-b pb-3 last:border-0 last:pb-0"
              >
                <p className="text-brand-ink font-semibold">
                  {formatPeso(payment.amountCentavos)} · {payment.provider} / {payment.method} ·{' '}
                  {payment.status}
                </p>
                {payment.txnRef ? (
                  <p className="text-brand-error font-mono text-xs">Ref {payment.txnRef}</p>
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
                  <p className="text-brand-error">Collected by {payment.collectedByDriverName}</p>
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
       * The decisions on pending money (a guest's receipt, a driver's cash
       * claim). Offered only to a role §9 allows, and refused by the server
       * regardless - see `PaymentDecisions`.
       */}
      <PaymentDecisions
        payments={booking.payments}
        mayVerify={mayVerify}
        onChanged={() => void query.refetch()}
      />

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
        <section aria-labelledby="notes-heading" className={CARD}>
          <h2 id="notes-heading" className={HEADING}>
            Staff notes
          </h2>
          {booking.notes.length > 0 ? (
            <ul className="mt-3 space-y-3">
              {booking.notes.map((note) => (
                <li
                  key={note.id}
                  className="text-brand-ink border-brand-blue-100 border-b pb-3 last:border-0 last:pb-0"
                >
                  <p>{note.note}</p>
                  {/*
                   * Visibility in WORDS (WCAG 1.4.1): which notes the driver
                   * is reading must not depend on a colour or an icon.
                   */}
                  <p className="text-brand-error mt-0.5 text-xs font-medium">
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
                  className="border-brand-blue-200 focus-visible:ring-brand-blue-600 min-h-24 w-full rounded-[10px] border bg-white px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2"
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
                <p id="booking-note-driver-help" className="text-brand-error text-xs">
                  Notes are office-only unless this is ticked. The driver is not told that
                  office-only notes exist.
                </p>
              </div>

              {addNote.isError ? (
                <p
                  role="alert"
                  className="border-brand-warning/30 bg-brand-gold-100 text-brand-gold-800 rounded-xl border p-3 text-sm font-medium"
                >
                  {addNote.error.message}
                </p>
              ) : null}

              <Button
                type="submit"
                className={PRIMARY_BUTTON}
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

      <section aria-labelledby="audit-heading" className={CARD}>
        <h2 id="audit-heading" className={HEADING}>
          Audit trail
        </h2>
        {booking.audit.length === 0 ? (
          <p className="text-brand-error mt-2">Nothing recorded yet.</p>
        ) : (
          <ul className="mt-3 space-y-1">
            {booking.audit.map((entry) => (
              <li key={entry.id} className="text-brand-error font-mono text-xs">
                {entry.action} · {entry.actorType}
                {entry.actorId === null ? '' : ` #${entry.actorId}`}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
