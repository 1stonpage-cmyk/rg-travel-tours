/**
 * The manual QR payment screen (BUILD_SPEC §6 steps 1–3, Week 4 Task 8).
 *
 * §6 asks for five things on one screen: the R&G QR image, the **exact
 * amount as text beside it**, the booking reference, instructions to put
 * that reference in the transfer note, and a 15-minute hold countdown with
 * a "Download QR" button. Then the upload control, which is step 3.
 *
 * ## The amount is text, and that is not a styling choice
 *
 * A static QR cannot embed an amount — it encodes an account, not an
 * invoice — so the figure has to be read and typed by the guest. It is the
 * single most important thing on the page, and it comes from the server
 * (`portal.manualPayment` computes it from the booking's own price
 * snapshot). **Nothing here does arithmetic on centavos**; the repo-wide
 * guard would fail the build if it did.
 *
 * ## Behind the guest session, and the page says so rather than guessing
 *
 * The owner's decision (2026-10-14, Q5) is that a booking reference alone
 * reveals nothing: an amount due and an account number are not public
 * facts. So the query is `customerProcedure` and an unauthenticated visitor
 * gets a sign-in prompt with no details on it at all — not a redirect that
 * flashes the page first.
 *
 * ## While R&G have not sent their QR yet
 *
 * `qr` is null until the `payment_qr` settings block is configured (owner
 * decision Q3: nothing is ever invented). The page then shows an amber
 * "payment details pending" notice and **no upload form** — asking a guest
 * to send a receipt for a transfer they could not have made would be worse
 * than saying nothing. The checkout does not offer the option at all in
 * that state either, so this is the belt to that braces.
 *
 * Mobile-first: one column at 360px, the amount and the QR stacked, 44px
 * targets, amber for every warning and no red anywhere.
 */
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Copy, Download, Loader2 } from 'lucide-react';
import { APP_SURFACE_TITLES, formatPeso } from '@rg/shared';
import { useDocumentTitle } from '@/hooks/useDocumentTitle';
import HoldCountdown from '@/components/checkout/HoldCountdown';
import ReceiptUpload from '@/components/portal/ReceiptUpload';
import { Button } from '@/components/ui/button';
import { SITE } from '@/lib/site';
import { trpc } from '@/lib/trpc';

/** The authenticated route that streams the QR; it takes no parameter. */
const QR_SRC = '/api/payment-qr';

/**
 * A value with a copy button — the account number and the booking
 * reference, which are the two things a guest has to retype into another
 * app and the two places a typo costs them money.
 *
 * The button confirms briefly ("Copied"), per the feedback guidance that a
 * silent success is not a success, and reverts on its own. `navigator.
 * clipboard` is absent on an insecure origin and in some in-app browsers,
 * so the control simply does not render there rather than failing on tap.
 */
function CopyableValue({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);
  const canCopy = typeof navigator !== 'undefined' && Boolean(navigator.clipboard);

  return (
    <div className="flex items-start justify-between gap-3">
      <div className="min-w-0">
        <dt className="text-muted-foreground text-xs">{label}</dt>
        <dd className="text-brand-blue-900 break-words font-mono text-sm font-semibold">{value}</dd>
      </div>
      {canCopy ? (
        <button
          type="button"
          onClick={() => {
            void navigator.clipboard.writeText(value).then(() => {
              setCopied(true);
              window.setTimeout(() => setCopied(false), 1800);
            });
          }}
          className="text-brand-blue-700 hover:bg-brand-blue-50 focus-visible:ring-brand-blue-600 tap-target shrink-0 rounded-md px-2 text-xs font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2"
        >
          <span className="flex items-center gap-1">
            <Copy className="size-3.5" aria-hidden="true" />
            {copied ? 'Copied' : 'Copy'}
          </span>
          <span className="sr-only"> {label}</span>
        </button>
      ) : null}
    </div>
  );
}

export default function ManualQrPage() {
  /*
   * The portal has no shared layout component (`App.tsx` mounts its three
   * pages directly), so each one re-asserts the surface's title itself. The
   * words are the server's own (`APP_SURFACE_TITLES['/portal']`,
   * `@rg/shared`), so a guest who walks here from `/booking/:ref` by a
   * client-side navigation stops reading the booking page's tab title.
   */
  useDocumentTitle(APP_SURFACE_TITLES['/portal']);

  const query = trpc.portal.manualPayment.useQuery(undefined, {
    // A refused query means "not signed in", which is a state to render,
    // not an error to retry into a loop.
    retry: false,
  });

  if (query.isPending) {
    return (
      <main className="mx-auto max-w-lg px-4 py-10">
        <p className="text-muted-foreground flex items-center gap-2 text-sm">
          <Loader2 className="size-4 animate-spin" aria-hidden="true" />
          Loading your payment details…
        </p>
      </main>
    );
  }

  if (query.isError || !query.data) {
    return (
      <main className="mx-auto max-w-lg px-4 py-10">
        <h1 className="text-brand-blue-900 text-xl font-bold">Sign in to pay</h1>
        <p className="text-muted-foreground mt-2 text-sm">
          For your security we only show payment details to a signed-in guest. Your booking
          reference on its own is not enough.
        </p>
        <Button asChild className="tap-target mt-4 w-full sm:w-auto">
          <Link to="/portal/login?next=/portal/pay">Sign in to your booking</Link>
        </Button>
      </main>
    );
  }

  const booking = query.data;
  const qr = booking.qr;
  /*
   * At zero this page stops offering to pay (§6 step 2).
   *
   * Evaluated once per render rather than on a ticking clock, which is
   * enough: `HoldCountdown` below does the ticking, and the SERVER is what
   * actually refuses a late receipt (`recordManualReceipt` returns
   * `hold_expired`). A client that decided this on its own would be
   * guessing — the sweep may not have run, or the guest may already have
   * uploaded — so this only hides the controls and says so in amber; it
   * never claims the booking is gone.
   */
  const holdLapsed =
    booking.holdExpiresAt !== null && new Date(booking.holdExpiresAt).getTime() <= Date.now();

  return (
    <main className="mx-auto max-w-lg px-4 py-8">
      <header className="space-y-1">
        <span className="text-brand-gold-700 text-xs font-semibold uppercase tracking-[0.18em]">
          Pay by transfer
        </span>
        <h1 className="text-brand-blue-900 text-2xl font-bold">{booking.tourTitle}</h1>
        <p className="text-muted-foreground text-sm">
          {booking.tourDate} · {booking.pax} {booking.pax === 1 ? 'guest' : 'guests'}
        </p>
      </header>

      {/*
       * The amount, first and largest. `formatPeso` only — no arithmetic
       * here; `amountDueCentavos` arrives computed.
       */}
      <section
        aria-labelledby="amount-heading"
        className="border-brand-blue-200 bg-brand-blue-50 mt-6 rounded-2xl border p-5 text-center"
      >
        <h2 id="amount-heading" className="text-brand-blue-900 text-sm font-semibold">
          Send exactly
        </h2>
        <p className="text-brand-blue-900 mt-1 text-4xl font-bold tabular-nums">
          {formatPeso(booking.amountDueCentavos)}
        </p>
        <dl className="mt-4 text-left">
          <CopyableValue label="Booking reference (put this in the notes)" value={booking.ref} />
        </dl>
      </section>

      {booking.holdExpiresAt && !holdLapsed ? (
        <div className="mt-4">
          <HoldCountdown expiresAt={booking.holdExpiresAt} />
        </div>
      ) : null}

      {holdLapsed ? (
        <section
          aria-labelledby="lapsed-heading"
          className="border-brand-warning/30 bg-brand-gold-100 mt-6 rounded-2xl border p-5"
        >
          <h2 id="lapsed-heading" className="text-brand-gold-800 text-base font-semibold">
            This hold has run out
          </h2>
          <p className="text-brand-gold-800 mt-2 text-sm">
            We can no longer accept a transfer against this booking. Please start a new booking — or
            message us with reference <strong className="font-mono">{booking.ref}</strong> if you
            have already paid and we will sort it out.
          </p>
          <Button asChild variant="outline" className="tap-target mt-3 w-full sm:w-auto">
            <Link to="/">Start a new booking</Link>
          </Button>
        </section>
      ) : null}

      {qr && !holdLapsed ? (
        <section
          aria-labelledby="qr-heading"
          className="border-border bg-background mt-6 space-y-4 rounded-2xl border p-5"
        >
          <h2 id="qr-heading" className="text-brand-blue-900 text-base font-semibold">
            Scan with your banking or e-wallet app
          </h2>

          <img
            src={QR_SRC}
            alt={`Payment QR code for ${SITE.legalOperator}`}
            className="border-border mx-auto block w-full max-w-[260px] rounded-xl border bg-white p-2"
          />

          <Button asChild variant="outline" className="tap-target w-full">
            {/*
             * A real link with `download`, not a script-built blob: the
             * browser fetches it with the session cookie it already has, and
             * a guest who cannot scan from the same device they are reading
             * on gets a file they can open in their banking app.
             */}
            <a href={QR_SRC} download="travelsugbo-payment-qr.png">
              <Download className="mr-2 size-4" aria-hidden="true" />
              Download QR
            </a>
          </Button>

          <dl className="space-y-3 border-t pt-4">
            {qr.accountName ? <CopyableValue label="Account name" value={qr.accountName} /> : null}
            {qr.accountNumber ? (
              <CopyableValue label="Account number" value={qr.accountNumber} />
            ) : null}
          </dl>

          <p className="text-muted-foreground text-sm">
            {qr.instructions ??
              `Put your booking reference ${booking.ref} in the transfer note so we can match your payment.`}
          </p>
        </section>
      ) : holdLapsed ? null : (
        /*
         * Owner decision Q3: never invent an account name or number. This is
         * the same explicit pending state the DOT/DTI permit numbers use.
         */
        <section
          aria-labelledby="pending-heading"
          className="border-brand-warning/30 bg-brand-gold-100 mt-6 rounded-2xl border p-5"
        >
          <h2 id="pending-heading" className="text-brand-gold-800 text-base font-semibold">
            Payment details pending
          </h2>
          <p className="text-brand-gold-800 mt-2 text-sm">
            Our transfer details are not published yet. Please message us and we will send you the
            account details for this booking — your reference is{' '}
            <strong className="font-mono">{booking.ref}</strong>.
          </p>
        </section>
      )}

      {qr && !holdLapsed ? (
        <section className="border-border bg-background mt-6 rounded-2xl border p-5">
          <ReceiptUpload
            uploadsRemaining={booking.uploadsRemaining}
            onUploaded={() => void query.refetch()}
          />
        </section>
      ) : null}

      <p className="text-muted-foreground mt-6 text-xs">
        Paid already? We check transfers by hand, usually within a few hours, and email you the
        moment your booking is confirmed.
      </p>
    </main>
  );
}
