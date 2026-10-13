import { Button } from '@/components/ui/button';
import { describeCheckoutError } from '@/lib/mutation-errors';
import { trpc } from '@/lib/trpc';

type Props = {
  /** The booking's public ref (`RG-XXXXXX`) — the only thing `checkout.startPayment` needs. */
  bookingRef: string;
  /** Defaults to `'Pay now'`; `BookingStatusPage` uses this for its "try paying again" wording. */
  label?: string;
};

/**
 * The one UI trigger for `checkout.startPayment` (Task 7) — Task 8b, the
 * gap a code review found: the hold, the procedure and the status page all
 * existed and were each individually tested, but nothing in the UI joined
 * checkout → payment → status page.
 *
 * Shared by two screens, because both need the exact same action: ask the
 * gateway for a fresh checkout session against an already-held booking,
 * then leave for it.
 *   - `CheckoutPage`, right after a successful `createHold`.
 *   - `BookingStatusPage`, as the "try paying again" affordance after a
 *     cancelled gateway redirect — that page's own module comment explains
 *     why rendering this component there does not reopen the door Task 9
 *     closed: see the note below.
 *
 * **It never confirms anything.** `checkout.startPayment`'s own doc
 * comment: "It starts a payment; it never records one." Only a verified
 * PayMongo webhook or an admin approval may mark a booking paid (CLAUDE.md
 * DO NOT) — this component calls no other procedure, and on success it
 * does nothing but leave the page via `window.location.assign`, a real
 * browser navigation to PayMongo's own domain, not a route change
 * `react-router` could intercept or reason about.
 *
 * On failure, the server's own guest-safe sentence is shown (via
 * `describeCheckoutError` — the same translation rule `CheckoutPage` uses
 * for `createHold`) — amber, never red (CLAUDE.md): a refused payment
 * start ("temporarily unavailable", "this booking can no longer be paid
 * online") is a normal business state, not a system crash. The class
 * pairing (`bg-brand-gold-100` / `text-brand-gold-800`) is the exact one
 * `HoldCountdown.tsx`'s and `BookingStatusPage.tsx`'s own warning tone
 * already use, measured AA by `contrast.test.ts`.
 */
export default function PayNowButton({ bookingRef, label = 'Pay now' }: Props) {
  const startPayment = trpc.checkout.startPayment.useMutation();

  return (
    <div className="space-y-2">
      <Button
        type="button"
        size="lg"
        className="tap-target w-full"
        disabled={startPayment.isPending}
        onClick={() =>
          startPayment.mutate(
            { ref: bookingRef },
            {
              onSuccess: (result) => {
                window.location.assign(result.redirectUrl);
              },
            },
          )
        }
      >
        {startPayment.isPending ? 'Starting payment…' : label}
      </Button>
      {startPayment.isError && (
        <p
          role="alert"
          className="border-brand-warning/30 bg-brand-gold-100 text-brand-gold-800 rounded-lg border p-3 text-sm font-medium"
        >
          {describeCheckoutError(startPayment.error)}
        </p>
      )}
    </div>
  );
}
