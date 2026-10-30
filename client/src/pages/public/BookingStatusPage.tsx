import { Link, useParams, useSearchParams } from 'react-router-dom';
import { formatPeso, type BookingStatus } from '@rg/shared';
import PaymentOptions from '@/components/checkout/PaymentOptions';
import QueryBoundary from '@/components/common/QueryBoundary';
import { Skeleton } from '@/components/common/Skeleton';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { cn } from '@/lib/utils';
import { trpc } from '@/lib/trpc';

/**
 * Task 9, week 3 checkout plan — the booking-status / payment-redirect page.
 *
 * **This page only reads — it confirms nothing itself.** §6: "The success
 * redirect page only reads status (polls until the webhook lands). It
 * never confirms anything itself." This file itself calls no mutation hook
 * — no `checkout.createHold`, no `checkout.startPayment` — directly: its
 * own hooks are `useParams`, `useSearchParams` and
 * `checkout.bookingStatus.useQuery`, nothing else. Only a verified
 * PayMongo webhook or an admin approval ever marks a booking paid (CLAUDE.md
 * DO NOT); this page's entire job is to keep asking what that webhook
 * already decided, and render exactly what comes back.
 *
 * **Task 8b's one addition: a real "try paying again" affordance.** A
 * cancelled gateway redirect used to land here with copy that *claimed* a
 * retry was possible ("you can try paying again") with no actual way to do
 * it — a lie by omission CLAUDE.md's bug-tracking spirit does not allow
 * once the real trigger (`checkout.startPayment`) exists. The fix is
 * `<PaymentOptions>` (components/checkout/PaymentOptions.tsx) — the SAME
 * component `CheckoutPage` uses after a fresh `createHold` — rendered only
 * inside the cancelled notice below. It wraps `<PayNowButton>` and shows it
 * only when the server says online payment is actually possible (task A5),
 * falling back to the manual transfer or to contacting the office. It does
 * not weaken the rule above:
 * `checkout.startPayment` "starts a payment; it never records one" (its
 * own doc comment) — nothing reachable from this page can mark a booking
 * paid, cancelled, or anything else. `server/src/routers/public/
 * checkout.ts`'s own enumeration test (`exposes no mutation that could
 * confirm a booking`) is what makes "nothing on this router can confirm a
 * booking" a checked property of the ROUTER, independent of what any page
 * calls.
 *
 * **Route shape (Ruling 25).** `checkout.startPayment` sends PayMongo a
 * success URL of `${PUBLIC_BASE_URL}${bookingPagePath(ref)}` and a cancel
 * URL of the same with `?cancelled=1`. `App.tsx` mounts this page at
 * `BOOKING_PAGE_ROUTE` (`@rg/shared`) rather than a retyped `/booking/:ref`,
 * so the two cannot drift apart without `BOOKING_PAGE_ROUTE` itself
 * changing — see `booking-status.test.tsx`'s own route-contract test, which
 * renders the real `<App />` at `bookingPagePath()`'s output and asserts
 * this page is what actually mounts there.
 *
 * **Polling, not pushing.** `checkout.bookingStatus` is polled on an
 * interval while the booking is still "live" (`pending_payment` /
 * `pending_verification`) and the interval stops once the status is
 * anything terminal — there is no server push here, just React Query's
 * `refetchInterval`, which is a read on a timer, nothing more.
 *
 * **It computes no money.** Every centavos figure below is rendered exactly
 * as `checkout.bookingStatus` returned it; `balanceCentavos` is computed
 * SERVER-side (see that procedure's own note on why that is allowed) and
 * never recomputed here. The repo-wide `*Centavos` arithmetic guard
 * (`checkout-page.test.tsx`) scans this file along with every other file
 * under `client/`.
 */

/** How often this page re-asks while the booking is still waiting on a verdict. */
const POLL_MS = 1500;

/** The two statuses still worth polling for — everything else is terminal. */
const LIVE_STATUSES: readonly BookingStatus[] = ['pending_payment', 'pending_verification'];

type Tone = 'calm' | 'warning';

/** Mirrors `HoldCountdown.tsx`'s own `TONE_CLASSES` — the only two tones this UI ever uses, and no red in either (CLAUDE.md). */
const TONE_CLASSES: Record<Tone, string> = {
  calm: 'border-brand-blue-200 bg-brand-blue-50 text-brand-blue-900',
  warning: 'bg-brand-gold-100 text-brand-gold-800 border-brand-warning/30',
};

const STATUS_COPY: Record<BookingStatus, { heading: string; body: string; tone: Tone }> = {
  pending_payment: {
    heading: 'Waiting for your payment',
    body: "We're confirming your payment with the gateway. This page updates on its own — no need to refresh.",
    tone: 'warning',
  },
  pending_verification: {
    heading: 'Payment under review',
    body: "We've received your payment details and an admin is verifying them. This page will update once it's confirmed.",
    tone: 'warning',
  },
  confirmed: {
    heading: 'Booking confirmed',
    body: "You're all set — we've reserved your spot.",
    tone: 'calm',
  },
  assigned: {
    heading: 'Booking confirmed — driver assigned',
    body: 'Your trip now has a driver and vehicle assigned.',
    tone: 'calm',
  },
  in_progress: {
    heading: 'Your tour is underway',
    body: 'Enjoy your trip!',
    tone: 'calm',
  },
  completed: {
    heading: 'Tour completed',
    body: 'Thanks for travelling with us — we hope you had a great time.',
    tone: 'calm',
  },
  cancelled: {
    heading: 'Booking cancelled',
    body: 'This booking was cancelled.',
    tone: 'warning',
  },
  expired: {
    heading: 'Hold expired',
    body: 'This hold ran out before payment was completed, and the spot was released.',
    tone: 'warning',
  },
};

/** `'2026-12-25'` → a readable Asia/Manila date, display only — no money, no arithmetic. */
function formatTourDate(civilDate: string): string {
  return new Date(`${civilDate}T00:00:00Z`).toLocaleDateString('en-PH', {
    timeZone: 'Asia/Manila',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
}

function StatusSkeleton() {
  return (
    <div role="status" aria-label="Loading booking status" className="mt-6 space-y-4">
      <Skeleton className="h-20 w-full rounded-xl" />
      <Skeleton className="h-40 w-full rounded-xl" />
    </div>
  );
}

export default function BookingStatusPage() {
  const { ref } = useParams<{ ref: string }>();
  const [searchParams] = useSearchParams();
  const cancelled = searchParams.get('cancelled') === '1';

  const statusQuery = trpc.checkout.bookingStatus.useQuery(
    { ref: ref ?? '' },
    {
      enabled: Boolean(ref),
      retry: false,
      // Keep polling only while the booking is still waiting on a verdict;
      // a confirmed/cancelled/expired/etc. booking has nothing left to wait
      // for, so the interval stops rather than polling forever.
      refetchInterval: (query) => {
        const status = query.state.data?.status;
        if (!status) return POLL_MS;
        return LIVE_STATUSES.includes(status) ? POLL_MS : false;
      },
    },
  );

  return (
    <div className="mx-auto max-w-2xl px-4 py-10 sm:px-6">
      <h1 className="text-brand-blue-900 text-2xl font-bold tracking-tight sm:text-3xl">
        Booking status
      </h1>

      {!ref ? (
        <div role="alert" className={cn('mt-6 rounded-xl border p-5', TONE_CLASSES.warning)}>
          <p className="text-base font-semibold">We couldn't load this booking</p>
          <p className="mt-1 text-sm">No booking reference was given.</p>
        </div>
      ) : (
        <QueryBoundary
          query={statusQuery}
          skeleton={<StatusSkeleton />}
          errorTitle="We couldn't load this booking"
        >
          {(data) => {
            const copy = STATUS_COPY[data.status];
            const stillLive = LIVE_STATUSES.includes(data.status);
            const showCancelledNotice = cancelled && data.status === 'pending_payment';

            return (
              <div className="mt-6 space-y-4">
                {showCancelledNotice && (
                  <div className={cn('space-y-3 rounded-xl border p-4', TONE_CLASSES.calm)}>
                    <div role="status">
                      <p className="text-sm font-semibold">Payment cancelled</p>
                      <p className="mt-1 text-sm">
                        You cancelled before finishing payment. Your spot may still be held — here's
                        how to pay, or contact us if you need help.
                      </p>
                    </div>
                    {/*
                     * The same three-way choice the checkout makes (task
                     * A5). The retry used to be `<PayNowButton>` outright,
                     * which on a box with no PayMongo key offered a button
                     * that could only throw — and this is the page a guest
                     * reaches precisely BECAUSE a payment did not finish,
                     * so a second dead button here is the worst place for
                     * one. `<PaymentOptions>` answers from the server's own
                     * booleans and falls back to the manual transfer, or to
                     * the office, exactly as the checkout does.
                     */}
                    <PaymentOptions bookingRef={data.ref} payLabel="Try paying again" />
                  </div>
                )}

                <div role="status" className={cn('rounded-xl border p-5', TONE_CLASSES[copy.tone])}>
                  <p className="text-xs font-semibold uppercase tracking-wide opacity-80">
                    Booking <span>{data.ref}</span>
                  </p>
                  <p className="mt-1 text-lg font-semibold">{copy.heading}</p>
                  <p className="mt-1 text-sm">{copy.body}</p>
                  {stillLive && (
                    <p className="mt-2 text-xs opacity-80">Checking again automatically…</p>
                  )}
                </div>

                <Card className="bg-background">
                  <CardContent className="space-y-3 p-5">
                    <h2 className="text-brand-blue-900 text-base font-semibold">
                      {data.tourTitle}
                    </h2>
                    <dl className="space-y-2 text-sm">
                      <div className="flex items-center justify-between gap-3">
                        <dt className="text-muted-foreground">Tour date</dt>
                        <dd className="text-brand-blue-900 font-medium">
                          {formatTourDate(data.date)}
                        </dd>
                      </div>
                      <div className="flex items-center justify-between gap-3">
                        <dt className="text-muted-foreground">Guests</dt>
                        <dd className="text-brand-blue-900 font-medium">{data.pax}</dd>
                      </div>
                      <div className="border-brand-blue-100 flex items-center justify-between gap-3 border-t pt-2">
                        <dt className="text-brand-blue-900 font-semibold">Total</dt>
                        <dd className="text-brand-blue-900 font-semibold">
                          {formatPeso(data.totalCentavos)}
                        </dd>
                      </div>
                      <div className="flex items-center justify-between gap-3">
                        <dt className="text-muted-foreground">Paid so far</dt>
                        <dd className="text-brand-blue-900 font-medium">
                          {formatPeso(data.paidCentavos)}
                        </dd>
                      </div>
                      {data.balanceCentavos > 0 && (
                        <div className="flex items-center justify-between gap-3">
                          <dt className="text-muted-foreground">Balance</dt>
                          <dd className="text-brand-blue-900 font-medium">
                            {formatPeso(data.balanceCentavos)}
                          </dd>
                        </div>
                      )}
                    </dl>
                  </CardContent>
                </Card>

                <Button asChild variant="outline" className="tap-target w-full">
                  <Link to="/tours">Browse tours</Link>
                </Button>
              </div>
            );
          }}
        </QueryBoundary>
      )}
    </div>
  );
}
