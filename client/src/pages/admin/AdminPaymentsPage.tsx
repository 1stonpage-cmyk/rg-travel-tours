/**
 * Payment checks: everything waiting on a human to say "yes, that money
 * arrived" (BUILD_SPEC §9's verification queue), on one screen.
 *
 * ## No new data, no new procedure
 *
 * The queue is `admin.bookings.list({ awaitingVerification: true })` - the
 * same filter the Bookings screen's "Waiting for verification" box sends, and
 * the same clause the dashboard's alert counts - and the selected booking is
 * `admin.bookings.detail`. The approve / reject / confirm / refuse controls are
 * `PaymentDecisions`, the very component the booking screen mounts, so the two
 * screens cannot drift apart on a safeguard.
 *
 * ## One queue, not two tabs
 *
 * An uploaded receipt and a driver's cash claim are both just a pending
 * payment on a booking, and a booking can carry both at once. The list does
 * not say which kind a booking is waiting on, and fetching every booking's
 * detail only to sort them into tabs would be N queries for a label, so the
 * queue is a single list and the detail names what is pending.
 *
 * ## Hiding a button is not access control
 *
 * The nav draws this link for owner and finance only, and `PaymentDecisions`
 * draws its buttons for them only - a courtesy. A dispatcher who opens the URL
 * sees the queue read-only; the four decision procedures are
 * `adminProcedure('verifyPayments')` and refuse them regardless.
 *
 * The "Open receipt" link is the same courtesy, for the same two roles since
 * 2026-10-23 (Q2) - and worth more than it sounds, because the dashboard's
 * `payments_to_verify` alert is drawn for all three roles and links straight
 * here, so a dispatcher arrives by clicking their own dashboard rather than by
 * guessing a URL. `/api/receipts/:name` answers them the same 404 it answers a
 * stranger either way; what the gate removes is a dead end, not an exposure.
 */
import { Link, useSearchParams } from 'react-router-dom';
import { ExternalLink, Loader2 } from 'lucide-react';
import { formatPeso } from '@rg/shared';
import PaymentDecisions from '@/components/admin/PaymentDecisions';
import { findPendingCash, findPendingReceipt } from '@/components/admin/pending-payments';
import { pesosInWords } from '@/lib/peso-words';
import { trpc } from '@/lib/trpc';

/** §9: verify payments is owner and finance. The server enforces it. */
const MAY_VERIFY = ['owner', 'finance'];

/** The list endpoint's page cap. A queue longer than this says so. */
const QUEUE_LIMIT = 100;

/**
 * "1st", "2nd", "3rd", "4th try" — Task 15 (7L). `attemptNumber` is the
 * server's count of a booking's payment-type rows (superseded included),
 * so this is purely the English ordinal suffix for it.
 */
function ordinal(n: number): string {
  const remainder = n % 100;
  if (remainder >= 11 && remainder <= 13) return `${n}th`;
  switch (n % 10) {
    case 1:
      return `${n}st`;
    case 2:
      return `${n}nd`;
    case 3:
      return `${n}rd`;
    default:
      return `${n}th`;
  }
}

/**
 * A relative upload age ("2 hours ago") beside the queue card's figures —
 * cosmetic chrome, not money or a business decision, so unlike
 * CLAUDE.md's time-dependent-query rule this reads the viewer's own clock
 * rather than taking an explicit `now` from the server.
 */
function relativeAge(iso: string, now: Date): string {
  const minutes = Math.round((now.getTime() - new Date(iso).getTime()) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} ${minutes === 1 ? 'minute' : 'minutes'} ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} ${hours === 1 ? 'hour' : 'hours'} ago`;
  const days = Math.round(hours / 24);
  return `${days} ${days === 1 ? 'day' : 'days'} ago`;
}

/** A PDF has no inline preview — only an image receipt gets the `<img>`. */
function isImageReceipt(receiptPath: string): boolean {
  return !receiptPath.toLowerCase().endsWith('.pdf');
}

const ALERT =
  'border-brand-warning/30 bg-brand-gold-100 text-brand-gold-800 rounded-lg border p-3 text-sm font-medium';

export default function AdminPaymentsPage() {
  const [params] = useSearchParams();
  const me = trpc.staffAuth.me.useQuery(undefined, { retry: false });
  const queue = trpc.admin.bookings.list.useQuery(
    { awaitingVerification: true, limit: QUEUE_LIMIT, offset: 0 },
    { retry: false },
  );

  const items = queue.data?.items ?? [];
  const wanted = params.get('ref');
  const selectedRef = items.find((item) => item.ref === wanted)?.ref ?? items[0]?.ref ?? '';

  const detail = trpc.admin.bookings.detail.useQuery(
    { ref: selectedRef },
    { retry: false, enabled: selectedRef !== '' },
  );

  const mayVerify = me.data ? MAY_VERIFY.includes(me.data.role) : false;
  const booking = detail.data;
  const receipt = booking ? findPendingReceipt(booking.payments) : undefined;
  const cash = booking ? findPendingCash(booking.payments) : [];
  // What the system expects is the pending receipt's amount; a booking waiting
  // on cash alone has no receipt, so the first claim's amount stands in.
  const expected = receipt ?? cash[0];

  function refresh() {
    void queue.refetch();
    void detail.refetch();
  }

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-1">
        <p className="text-brand-gold-700 text-xs font-semibold uppercase tracking-[0.08em]">
          Finance
        </p>
        <h1 className="text-brand-ink text-2xl font-bold sm:text-3xl">Payment checks</h1>
        <p className="text-brand-error text-sm">
          A booking is only marked paid after someone here approves the receipt.
        </p>
      </header>

      {queue.isPending ? (
        <p className="text-brand-error flex items-center gap-2 text-sm">
          <Loader2 className="size-4 animate-spin" aria-hidden="true" />
          Loading payment checks…
        </p>
      ) : queue.isError || !queue.data ? (
        <p role="alert" className={ALERT}>
          We could not load the payment checks. Sign in again, or try once more in a moment.
        </p>
      ) : items.length === 0 ? (
        <p className="border-brand-blue-100 text-brand-error rounded-[14px] border bg-white p-5 text-sm">
          Nothing is waiting for a payment check.
        </p>
      ) : (
        <div className="flex flex-wrap items-start gap-6">
          <section
            aria-label="Waiting receipts"
            className="flex min-w-0 flex-[1_1_300px] flex-col gap-3"
          >
            <p role="status" className="text-brand-error text-sm">
              {queue.data.total === 1
                ? '1 booking is waiting for a payment check'
                : `${queue.data.total} bookings are waiting for a payment check`}
              {queue.data.total > items.length ? ` (showing the first ${items.length})` : ''}
            </p>
            <ul className="flex flex-col gap-3">
              {items.map((item) => {
                const selected = item.ref === selectedRef;
                return (
                  <li key={item.ref}>
                    <Link
                      to={`/admin/payments?ref=${encodeURIComponent(item.ref)}`}
                      replace
                      aria-current={selected ? 'true' : undefined}
                      className={[
                        'focus-visible:ring-brand-gold-500 tap-target block rounded-xl bg-white p-4 transition-colors focus-visible:outline-none focus-visible:ring-[3px]',
                        selected
                          ? 'border-brand-blue-700 border-2'
                          : 'border-brand-blue-100 hover:border-brand-blue-300 border',
                      ].join(' ')}
                    >
                      <span className="text-brand-ink block font-mono text-sm font-bold">
                        {item.ref}
                      </span>
                      <span className="text-brand-ink mt-1 block text-sm font-semibold">
                        {item.leadName} · {item.tourTitle}
                      </span>
                      <span className="text-brand-error mt-0.5 block text-sm">
                        {item.tourDate} · {item.pax} {item.pax === 1 ? 'guest' : 'guests'}
                      </span>
                      <span className="text-brand-error mt-0.5 block text-sm tabular-nums">
                        {formatPeso(item.paidCentavos)} paid of {formatPeso(item.totalCentavos)}
                      </span>
                      {item.method ? (
                        <span className="text-brand-error mt-0.5 block text-sm">
                          {item.method} · {ordinal(item.attemptNumber)} try
                          {item.pendingPaymentCreatedAt
                            ? ` · uploaded ${relativeAge(item.pendingPaymentCreatedAt, new Date())}`
                            : ''}
                        </span>
                      ) : null}
                      <span className="text-brand-error mt-0.5 block text-sm tabular-nums">
                        {item.phoneMasked}
                      </span>
                    </Link>
                  </li>
                );
              })}
            </ul>
          </section>

          <div className="flex min-w-0 flex-[2_1_520px] flex-col gap-6">
            {detail.isPending ? (
              <p className="text-brand-error flex items-center gap-2 text-sm">
                <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                Loading booking…
              </p>
            ) : detail.isError || !booking ? (
              <p role="alert" className={ALERT}>
                We could not load that booking. Pick another, or try once more in a moment.
              </p>
            ) : (
              <>
                <article
                  aria-labelledby="detail"
                  className="border-brand-blue-100 overflow-hidden rounded-[14px] border bg-white"
                >
                  <header className="border-brand-blue-100 flex flex-wrap items-start justify-between gap-3 border-b px-5 py-4">
                    <div className="flex min-w-0 flex-col gap-0.5">
                      <h2 id="detail" className="text-brand-ink text-xl font-bold">
                        <span className="font-mono">{booking.ref}</span> · {booking.leadName}
                      </h2>
                      <p className="text-brand-error text-sm">
                        {booking.tourTitle} · {booking.tourDate} · {booking.pax}{' '}
                        {booking.pax === 1 ? 'guest' : 'guests'}
                      </p>
                    </div>
                    <p className="text-brand-gold-800 bg-brand-gold-50 rounded-full border border-amber-200 px-3 py-1 text-xs font-semibold">
                      Awaiting payment check
                    </p>
                  </header>

                  <div className="flex flex-col gap-4 p-5">
                    {expected ? (
                      <div className="border-brand-blue-200 bg-brand-blue-50 rounded-xl border p-4">
                        <p className="text-brand-error text-sm font-semibold">
                          Amount the system expects
                        </p>
                        <p className="text-brand-ink mt-1 text-3xl font-bold tabular-nums">
                          {formatPeso(expected.amountCentavos)}
                        </p>
                        <p className="text-brand-error mt-1 text-sm">
                          {pesosInWords(expected.amountCentavos)}
                          {booking.payMode === 'deposit' ? ' · deposit' : ''}
                        </p>
                      </div>
                    ) : null}

                    <dl className="grid gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
                      {expected ? (
                        <div>
                          <dt className="text-brand-error">Method</dt>
                          <dd className="text-brand-ink font-semibold">{expected.method}</dd>
                        </div>
                      ) : null}
                      <div>
                        <dt className="text-brand-error">Paid so far</dt>
                        <dd className="text-brand-ink font-semibold tabular-nums">
                          {formatPeso(booking.paidCentavos)} of {formatPeso(booking.totalCentavos)}
                        </dd>
                      </div>
                      {booking.payments
                        .filter((payment) => payment.status === 'pending' && payment.txnRef)
                        .map((payment) => (
                          <div key={`ref-${payment.id}`}>
                            <dt className="text-brand-error">Payment reference</dt>
                            <dd className="text-brand-ink font-mono font-semibold">
                              {payment.txnRef}
                            </dd>
                          </div>
                        ))}
                    </dl>

                    {/*
                      A receipt is payment data, so only an owner or a finance
                      user is offered it (owner decision 2026-10-23, Q2) — the
                      same `mayVerify` that draws the decision buttons below.
                      COSMETIC: `/api/receipts/:name` answers a dispatcher the
                      same 404 it answers a stranger, and
                      `server/src/__tests__/receipts-route.test.ts` is the
                      guard. It is gated here rather than left dangling
                      because the dashboard's `payments_to_verify` alert links
                      every role straight to this page, so a dispatcher
                      reaches the link by clicking their own dashboard. The
                      payment REFERENCE above stays — that is queue data a
                      dispatcher may read (§9's `bookingsView`).
                    */}
                    {booking.payments
                      .filter(
                        (payment) =>
                          mayVerify && payment.status === 'pending' && payment.receiptPath,
                      )
                      .map((payment) => (
                        <div key={`receipt-${payment.id}`} className="flex flex-col gap-2">
                          {/*
                            An inline preview, Task 15 (7L): the same
                            authenticated route as "Open receipt" below, so
                            it inherits that route's owner/finance gate with
                            nothing new to enforce here. A PDF has no image
                            to render — browsers do not draw one in an
                            `<img>` — so it keeps the link only.
                          */}
                          {isImageReceipt(payment.receiptPath!) ? (
                            <img
                              src={`/api/receipts/${payment.receiptPath}`}
                              alt="Uploaded payment receipt"
                              className="border-brand-blue-200 max-h-64 w-auto self-start rounded-[10px] border object-contain"
                            />
                          ) : null}
                          <a
                            href={`/api/receipts/${payment.receiptPath}`}
                            target="_blank"
                            rel="noreferrer noopener"
                            className="border-brand-blue-200 text-brand-blue-700 hover:bg-brand-blue-50 tap-target inline-flex items-center gap-2 self-start rounded-[10px] border px-4 text-sm font-semibold transition-colors"
                          >
                            <ExternalLink className="size-4" aria-hidden="true" />
                            Open receipt
                          </a>
                        </div>
                      ))}
                  </div>

                  <footer className="border-brand-blue-100 border-t bg-slate-50 px-5 py-3 text-right">
                    <Link
                      to={`/admin/bookings/${booking.ref}`}
                      className="text-brand-blue-700 hover:text-brand-blue-900 tap-target inline-flex items-center text-sm font-semibold underline underline-offset-4 transition-colors"
                    >
                      Open the full booking
                    </Link>
                  </footer>
                </article>

                <PaymentDecisions
                  payments={booking.payments}
                  mayVerify={mayVerify}
                  onChanged={refresh}
                />
                {!mayVerify && me.data ? (
                  <p className="text-brand-error text-sm">
                    Only the owner and finance can approve or reject a payment.
                  </p>
                ) : null}
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
