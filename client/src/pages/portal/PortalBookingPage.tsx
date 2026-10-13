/**
 * The customer portal's booking page (BUILD_SPEC §7, Week 4 Task 9).
 *
 * One booking — the one the session names — with §7's five-step tracker,
 * the balance, the rejection reason when there is one, the re-upload form,
 * and the assigned driver while they may still be shown.
 *
 * ## Everything on this page is the server's answer
 *
 * The tracker's five booleans, the balance, the amount due, whether the
 * driver may be shown, and how often to poll all arrive computed. This file
 * formats and arranges them. That is not fastidiousness: §7's tracker table
 * and the money are business rules, and a second copy of either in the
 * browser is a copy that will disagree on the day it matters.
 *
 * ## Auto-refresh, and when it stops
 *
 * §7: "every 20 seconds while `pending_verification`". `portalPollMs()`
 * decides (tested over all eight statuses in `@rg/shared`), so the page
 * polls exactly while an admin might be looking at the receipt and never
 * afterwards — a `completed` booking polling forever is someone's mobile
 * data.
 *
 * ## Mobile-first, amber not red
 *
 * One column at 360px, 44px targets. A rejected receipt is amber with the
 * admin's own reason and a form to try again — it is a "please re-send",
 * not a failure, and red is forbidden anyway.
 */
import { Link } from 'react-router-dom';
import { Loader2, RefreshCw } from 'lucide-react';
import { formatPeso, portalPollMs } from '@rg/shared';
import DriverCard from '@/components/portal/DriverCard';
import ReceiptUpload from '@/components/portal/ReceiptUpload';
import Tracker from '@/components/portal/Tracker';
import { Button } from '@/components/ui/button';
import { trpc } from '@/lib/trpc';

/** What the page says about where the booking stands, in one sentence. */
const STATUS_SENTENCE: Record<string, string> = {
  pending_payment: 'We are holding your spot. Send your payment to confirm it.',
  pending_verification: 'We have your receipt and are checking it now.',
  confirmed: 'Your booking is confirmed. We will assign your driver closer to the day.',
  assigned: 'Your driver is assigned. See their details below.',
  in_progress: 'Your tour is under way. Enjoy!',
  completed: 'Your tour is complete. Thank you for travelling with us.',
  cancelled: 'This booking has been cancelled. Message us if that looks wrong.',
  expired: 'This booking expired before payment, so the seats were released.',
};

export default function PortalBookingPage() {
  const query = trpc.portal.booking.useQuery(undefined, {
    retry: false,
    // §7's twenty seconds, and only where §7 asks for them. The rule lives
    // in @rg/shared so it can be tested over every status.
    refetchInterval: (q) => {
      const status = q.state.data?.status;
      return status ? portalPollMs(status) : false;
    },
  });

  if (query.isPending) {
    return (
      <main className="mx-auto max-w-2xl px-4 py-10">
        <p className="text-muted-foreground flex items-center gap-2 text-sm">
          <Loader2 className="size-4 animate-spin" aria-hidden="true" />
          Loading your booking…
        </p>
      </main>
    );
  }

  if (query.isError || !query.data) {
    return (
      <main className="mx-auto max-w-2xl px-4 py-10">
        <h1 className="text-brand-blue-900 text-xl font-bold">Sign in to your booking</h1>
        <p className="text-muted-foreground mt-2 text-sm">
          For your security we only show a booking to a signed-in guest. Your booking reference on
          its own is not enough.
        </p>
        <Button asChild className="tap-target mt-4 w-full sm:w-auto">
          <Link to="/portal/login?next=/portal/booking">Sign in</Link>
        </Button>
      </main>
    );
  }

  const booking = query.data;
  const rejected = booking.receipt?.status === 'rejected';
  const awaitingCheck = booking.receipt?.status === 'pending';

  return (
    <main className="mx-auto max-w-2xl px-4 py-8">
      <header className="space-y-1">
        <span className="text-brand-gold-700 text-xs font-semibold uppercase tracking-[0.18em]">
          Booking {booking.ref}
        </span>
        <h1 className="text-brand-blue-900 text-2xl font-bold">{booking.tourTitle}</h1>
        <p className="text-muted-foreground text-sm">
          {booking.tourDate} · {booking.pax} {booking.pax === 1 ? 'guest' : 'guests'} ·{' '}
          {booking.leadName}
        </p>
      </header>

      <p role="status" className="text-brand-blue-900 mt-4 text-sm font-medium">
        {STATUS_SENTENCE[booking.status] ?? 'Your booking is being processed.'}
      </p>

      <section
        aria-labelledby="tracker-heading"
        className="border-border bg-background mt-6 rounded-2xl border p-5"
      >
        <h2 id="tracker-heading" className="sr-only">
          Progress
        </h2>
        <Tracker steps={booking.tracker} />
        {awaitingCheck ? (
          <p className="text-muted-foreground mt-4 flex items-center gap-2 text-xs">
            <RefreshCw className="size-3.5" aria-hidden="true" />
            This page updates itself while we check your payment.
          </p>
        ) : null}
      </section>

      {/* The money, all of it read from the server. */}
      <section
        aria-labelledby="money-heading"
        className="border-brand-blue-200 bg-brand-blue-50 mt-6 rounded-2xl border p-5"
      >
        <h2 id="money-heading" className="text-brand-blue-900 text-base font-semibold">
          Payment
        </h2>
        <dl className="mt-3 space-y-2 text-sm">
          <div className="flex justify-between gap-4">
            <dt className="text-muted-foreground">Tour total</dt>
            <dd className="text-brand-blue-900 font-semibold tabular-nums">
              {formatPeso(booking.totalCentavos)}
            </dd>
          </div>
          <div className="flex justify-between gap-4">
            <dt className="text-muted-foreground">Paid</dt>
            <dd className="text-brand-blue-900 font-semibold tabular-nums">
              {formatPeso(booking.paidCentavos)}
            </dd>
          </div>
          <div className="border-brand-blue-200 flex justify-between gap-4 border-t pt-2">
            <dt className="text-brand-blue-900 font-semibold">Balance on tour day</dt>
            <dd className="text-brand-blue-900 font-bold tabular-nums">
              {formatPeso(booking.balanceCentavos)}
            </dd>
          </div>
        </dl>

        {booking.amountDueCentavos > 0 && !awaitingCheck ? (
          <Button asChild className="tap-target mt-4 w-full">
            <Link to="/portal/pay">Pay {formatPeso(booking.amountDueCentavos)} now</Link>
          </Button>
        ) : null}
      </section>

      {rejected ? (
        <section
          aria-labelledby="rejected-heading"
          className="border-brand-warning/30 bg-brand-gold-100 mt-6 space-y-4 rounded-2xl border p-5"
        >
          <h2 id="rejected-heading" className="text-brand-gold-800 text-base font-semibold">
            We could not confirm your payment
          </h2>
          {/*
           * The admin's own words, which §7 says to show. React escapes
           * them; nothing here renders them as HTML.
           */}
          <p role="alert" className="text-brand-gold-800 text-sm font-medium">
            {booking.receipt?.rejectReason ??
              'We could not match your transfer to this booking. Please upload a clearer receipt.'}
          </p>
          <p className="text-brand-gold-800 text-sm">
            Your booking is still held. Please send another receipt and we will check it again.
          </p>
          <div className="bg-background rounded-xl p-4">
            <ReceiptUpload
              uploadsRemaining={booking.uploadsRemaining}
              onUploaded={() => void query.refetch()}
            />
          </div>
        </section>
      ) : null}

      {booking.driver ? (
        <div className="mt-6">
          <DriverCard driver={booking.driver} />
        </div>
      ) : null}

      <p className="text-muted-foreground mt-8 text-xs">
        Need help? Message us and quote <strong className="font-mono">{booking.ref}</strong>.
      </p>
    </main>
  );
}
