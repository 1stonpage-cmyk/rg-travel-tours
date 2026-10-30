import { Link } from 'react-router-dom';
import PayNowButton from '@/components/checkout/PayNowButton';
import { Skeleton } from '@/components/common/Skeleton';
import { Button } from '@/components/ui/button';
import { SITE, telLink, whatsappLink } from '@/lib/site';
import { trpc } from '@/lib/trpc';

/**
 * **What a held booking may actually be paid with — one answer, two screens
 * (task A5).**
 *
 * The checkout used to render `<PayNowButton>` unconditionally after a
 * successful `createHold`, and `BookingStatusPage` did the same for its
 * "try paying again". Neither asked whether online payment was possible, so
 * on a box with no `PAYMONGO_SECRET_KEY` — this project's dev and staging
 * boxes today — a guest clicked Pay now and `startPayment` could only throw.
 *
 * **The decision is the SERVER's**, as `settings.onlinePaymentEnabled` and
 * `settings.manualTransferEnabled`: two booleans, no key, no method list,
 * nothing to re-derive. This component only picks which of three states to
 * draw, and both screens read it from here rather than each branching on
 * its own — two copies of a three-way choice is how one screen keeps
 * offering a button the other has already learned is dead.
 *
 *   1. **Online available** — `<PayNowButton>`, exactly as before, with the
 *      manual transfer offered underneath as an alternative when it is also
 *      configured.
 *   2. **Manual only** — no Pay-now button anywhere in the DOM, and the
 *      transfer is worded as THE way to pay. "…instead" is removed
 *      deliberately: it points at a button that, in this state, was never
 *      rendered.
 *   3. **Neither** — a calm note that payment has to be arranged with the
 *      office, and the site's own WhatsApp and phone line to do it with.
 *
 * **The hold is untouched by all of this.** `createHold` has already run and
 * the spot is really reserved; this changes only what is offered afterwards.
 * A booking a guest has to ring us about is still a booking, which is why
 * state 3 says so rather than apologising.
 *
 * It fails CLOSED while the settings query is still in flight: the button
 * appears only on a `true` it has actually been told, never on an optimistic
 * default. The skeleton is there so that moment is a placeholder of the
 * right height rather than a flash of "you cannot pay".
 */

type Props = {
  /** The booking's public ref (`RG-XXXXXX`) — all three states key off it. */
  bookingRef: string;
  /** `<PayNowButton>`'s wording; the status page's retry says "Try paying again". */
  payLabel?: string;
};

/**
 * Through the portal sign-in, which is where the guest session — and so the
 * amount and the account details — comes from. Unchanged from the link
 * `CheckoutPage` has carried since Week 4 Task 8.
 */
function manualPayPath(bookingRef: string): string {
  return `/portal/login?ref=${encodeURIComponent(bookingRef)}&next=/portal/pay`;
}

/** State 3's fallback: the site's real contact details, never new copy of its own. */
function ContactToPay({ bookingRef }: { bookingRef: string }) {
  const message = `Hi ${SITE.name}! I'd like to pay for booking ${bookingRef}.`;
  return (
    <div
      role="status"
      className="border-brand-blue-200 bg-brand-blue-50 text-brand-blue-900 space-y-2 rounded-xl border p-4"
    >
      <p className="text-sm font-semibold">We'll take your payment directly</p>
      <p className="text-sm">
        Online payment isn't available right now, but your spot is held. Message us with your
        booking reference and we'll sort it out with you.
      </p>
      <p className="text-sm">
        <a
          href={whatsappLink(message)}
          target="_blank"
          rel="noreferrer noopener"
          className="text-brand-blue-700 hover:text-brand-blue-900 tap-target inline-flex items-center font-semibold underline underline-offset-2"
        >
          Message us on WhatsApp
        </a>
        <span className="px-2" aria-hidden="true">
          ·
        </span>
        <a
          href={telLink(SITE.contact.phone.tel)}
          className="text-brand-blue-700 hover:text-brand-blue-900 tap-target inline-flex items-center font-semibold underline underline-offset-2"
        >
          {SITE.contact.phone.display}
        </a>
      </p>
    </div>
  );
}

export default function PaymentOptions({ bookingRef, payLabel }: Props) {
  /*
   * The same cache entry every other page's `settings.get` uses — TanStack
   * dedupes by key — so this costs no extra request on the checkout, which
   * has already asked for it by the time a hold exists.
   */
  const settingsQuery = trpc.settings.get.useQuery();
  const onlineEnabled = settingsQuery.data?.onlinePaymentEnabled === true;
  const manualEnabled = settingsQuery.data?.manualTransferEnabled === true;

  if (onlineEnabled) {
    return (
      <div className="space-y-4">
        <PayNowButton bookingRef={bookingRef} label={payLabel} />
        {manualEnabled ? (
          <p className="text-center text-sm">
            <Link
              to={manualPayPath(bookingRef)}
              className="text-brand-blue-700 hover:text-brand-blue-900 tap-target inline-flex items-center font-semibold underline transition-colors"
            >
              Pay by GCash, Maya or bank transfer instead
            </Link>
          </p>
        ) : null}
      </div>
    );
  }

  if (manualEnabled) {
    return (
      <div className="space-y-3">
        <p className="text-muted-foreground text-sm">
          Pay by GCash, Maya or bank transfer. We'll show you the account details and QR code, and
          you can upload your receipt for us to confirm.
        </p>
        <Button asChild size="lg" className="tap-target w-full">
          <Link to={manualPayPath(bookingRef)}>Pay by GCash, Maya or bank transfer</Link>
        </Button>
      </div>
    );
  }

  // Still asking. Nothing is offered on a guess — see the note above.
  if (settingsQuery.isPending) {
    return <Skeleton className="h-11 w-full rounded-md" />;
  }

  return <ContactToPay bookingRef={bookingRef} />;
}
