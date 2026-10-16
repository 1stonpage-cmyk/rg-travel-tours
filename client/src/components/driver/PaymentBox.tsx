/**
 * §8's payment box — **the single most consequential thing in the driver
 * portal**, because it is what tells a driver whether to take money from a
 * guest (Week 6 plan, Task 10).
 *
 * The three states come from the SERVER, already decided
 * (`PaymentBoxState` in `@rg/shared`, computed by `driver.trip`). This file
 * renders them and computes nothing: a second derivation in the browser is
 * a second chance to get it wrong, and getting it wrong either takes a
 * guest's money twice or lets them ride for free.
 *
 * ## Five rules, and each one is a test
 *
 * 1. **Only `COLLECTABLE_STATUSES` may show a collection instruction**
 *    (ruling 2026-10-15, from Task 4's review; corrected 2026-10-16, D1).
 *    `PaymentBoxState` is computed from the money alone and deliberately
 *    ignores `bookings.status`, so a `cancelled` booking with an
 *    outstanding balance still resolves to `collect_cash` with a real
 *    amount on it. The server is right to report the money truth — but this
 *    screen must not turn that truth into an instruction for `cancelled` or
 *    `expired`, where the booking should not have been driven at all.
 *    `completed` moved INTO the allow-list on 2026-10-16 (D1): cash is the
 *    BALANCE, handed over at the end of a trip, so a finished trip that
 *    still owes money must still say so — the box used to claim "nothing to
 *    collect here" over a real balance, which was false. When the status is
 *    not on the allow-list, the booking's STATE is rendered in words and the
 *    amount is not rendered at all.
 * 2. **Text first, in all three states.** `unverified_do_not_collect` is
 *    amber *and* carries the words "Do not collect — call the office."
 *    Colour alone is a WCAG 1.4.1 failure, and this is the state where a
 *    misread costs real money. (Amber, never red — CLAUDE.md.)
 * 3. **The amount is stated in figures AND in words**, so a mis-read digit
 *    is caught by a driver glancing at a phone through a windscreen. The
 *    words come from `@/lib/peso-words`, where Task 13 moved them so the
 *    admin's irreversible refund confirmation spells an amount the same way
 *    this screen does.
 * 4. **The cash button is today-only and confirms in place.** The server
 *    refuses a non-today trip (`FORBIDDEN`) and a second claim (`CONFLICT`)
 *    — `isToday` here only stops the UI offering an action it knows will be
 *    refused, because hiding a button is not access control. Confirmation
 *    is two-step INLINE rather than a modal: no `dialog` primitive is
 *    vendored, and a modal in a moving van is worse than a second tap.
 * 5. **This box fails CLOSED on its own union** (fix round 1, 2026-10-16).
 *    Every branch below is explicit and `assertHandled` closes them, so a
 *    fourth `PaymentBoxState` member stops the build rather than falling
 *    through to "Collect ₱X cash". See that function.
 */
import { useState } from 'react';
import { BanknoteArrowDown, CircleCheckBig, Loader2, TriangleAlert } from 'lucide-react';
import { TRPCClientError } from '@trpc/client';
import { formatPeso, type BookingStatus, type PaymentBoxState } from '@rg/shared';
import { Button } from '@/components/ui/button';
import { pesosInWords } from '@/lib/peso-words';
import { trpc } from '@/lib/trpc';

/* ------------------------------------------------------------------ *
 * Ruling 1: which statuses may show a collection instruction at all
 * ------------------------------------------------------------------ */

/**
 * The statuses on which this box may show a collection instruction at all.
 *
 * An ALLOW-LIST, in the spirit of `VAN_STATUS_SELLABLE`: a status added
 * later shows no instruction until somebody decides it should.
 *
 * **`completed` is here, and that is a correction** (owner-decided
 * 2026-10-16, D1). It was excluded while the list was called
 * `LIVE_STATUSES`, on the reasoning that a finished trip is not a trip a
 * driver is standing in front of a guest for. That reasoning was wrong in
 * the one case that matters: cash is the BALANCE, handed over at the END of
 * a trip, and a driver who taps Complete before the guest has paid — or
 * whose last check-in completed the trip automatically — then read "There
 * is nothing to collect here" over PHP 4,500 that was owed. The sentence
 * was not merely unhelpful; it was false, and it told a driver not to ask
 * for money the company is owed.
 *
 * The server never suppressed any of this: `driver.trip` answers
 * `collect_cash` on a completed trip and `driver.recordCash` accepts the
 * claim (both measured over HTTP, 2026-10-16). This file was the only
 * refusal, which is exactly the asymmetry the decision closes.
 *
 * `cancelled` and `expired` stay out, and for a different reason than
 * "the trip is over": those two mean the booking should not have been
 * driven at all, so money against them is an office matter.
 */
const COLLECTABLE_STATUSES = [
  'confirmed',
  'pending_verification',
  'assigned',
  'in_progress',
  'completed',
] as const;
type CollectableStatus = (typeof COLLECTABLE_STATUSES)[number];

function showsBox(status: BookingStatus): status is CollectableStatus {
  return (COLLECTABLE_STATUSES as readonly BookingStatus[]).includes(status);
}

/**
 * What a driver reads instead of the box when the booking is not
 * collectable at all.
 *
 * `Record<Exclude<BookingStatus, CollectableStatus>, …>` so the COMPILER
 * refuses a build where a new booking status has no words here — the same
 * discipline `AssignPanel`'s `REFUSAL_COPY` established. Falling through to
 * a generic sentence on this box is exactly the failure that would turn a
 * cancelled booking back into "collect ₱1,500".
 *
 * `tone` is `'warn' | 'neutral'`, not narrowed to `'warn'`, even though
 * every entry below is `warn` now that `completed` (the one `neutral`
 * entry) moved to `COLLECTABLE_STATUSES` (D1, 2026-10-16): the neutral
 * rendering branch stays in the component for whichever status needs it
 * next, rather than being deleted and rebuilt.
 */
const NOT_COLLECTABLE_COPY: Record<
  Exclude<BookingStatus, CollectableStatus>,
  { tone: 'warn' | 'neutral'; heading: string; body: string }
> = {
  pending_payment: {
    tone: 'warn',
    heading: 'Not paid — this booking is not confirmed',
    body: 'Nobody has paid for this booking yet. Do not collect anything — ring the office.',
  },
  cancelled: {
    tone: 'warn',
    heading: 'Booking cancelled',
    body: 'This booking was cancelled. Do not collect anything — ring the office.',
  },
  expired: {
    tone: 'warn',
    heading: 'Booking expired',
    body: 'This booking expired before it was confirmed. Do not collect anything — ring the office.',
  },
};

/* ------------------------------------------------------------------ *
 * The box
 * ------------------------------------------------------------------ */

/**
 * The shared frame. `border-4` and the heading size are what make this the
 * loudest element on the trip screen; the TONE is carried by the words
 * inside it, never by the colour on its own.
 */
const FRAME = 'rounded-xl border-4 p-4';
const TONES = {
  collect: 'border-brand-blue-900 bg-background',
  calm: 'border-brand-blue-200 bg-background',
  warn: 'border-amber-600 bg-amber-50',
} as const;

const HEADING = 'text-xl font-bold leading-tight';

/**
 * What a refused cash claim is allowed to say — **and why there are three
 * sentences rather than one** (fix round 1, 2026-10-16).
 *
 * `driver.recordCash` refuses exactly two ways
 * (`server/src/routers/public/driver.ts`): `FORBIDDEN` when the trip is not
 * today, and `CONFLICT` when there is nothing to collect — which is also
 * what a **second** claim looks like, because the first claim's `pending`
 * row moves the box to `unverified_do_not_collect`.
 *
 * One sentence for all of them told a driver whose claim had COMMITTED but
 * whose refetch failed that the money was not recorded, and invited a
 * retry; the retry is refused, says the same thing again, and the plausible
 * next step is the office recording the same cash twice. So the `CONFLICT`
 * wording must not say "did not save" — it says close to the opposite, and
 * sends the driver to a reload rather than to another tap.
 *
 * `error.data.code` is reliable here: `lib/trpc.ts`'s
 * `fetchWithNormalizedErrors` normalises the status before tRPC parses
 * anything, and `mockTrpcError` carries the code so each branch is
 * testable.
 */
const CASH_CONFLICT =
  'That may already be recorded. Reload this trip before trying again, or ring the office.';
const CASH_NOT_TODAY = 'Cash can only be recorded on the day of the trip.';
const CASH_UNKNOWN =
  'That cash record did not save. Check your signal and try again, or ring the office.';

function describeCashError(error: unknown): string {
  const code =
    error instanceof TRPCClientError && typeof error.data?.code === 'string' ? error.data.code : '';
  if (code === 'CONFLICT') return CASH_CONFLICT;
  if (code === 'FORBIDDEN') return CASH_NOT_TODAY;
  return CASH_UNKNOWN;
}

/**
 * Makes this component fail CLOSED on its own union.
 *
 * The three states used to be an `if` chain whose FALLTHROUGH was "Collect
 * ₱X cash", so a fourth `PaymentBoxState` added server-side compiled
 * cleanly and rendered as an instruction to take money, with no author
 * involved (fix round 1, 2026-10-16). `payment` is handed to this function
 * after the last explicit branch: add a member to the union and this call
 * stops compiling, and until someone decides what a driver reads, the
 * RUNTIME renders "do not collect" rather than a peso figure.
 *
 * A function rather than `const _exhaustive: never = payment`, because
 * `noUnusedLocals` is on across this repo (tsconfig.base.json) and a
 * discarded local would not survive `pnpm typecheck`. It deliberately does
 * not throw: a thrown error inside a render blanks the screen a driver is
 * holding at a pickup, which is a worse answer than an amber box.
 */
function assertHandled(value: never): void {
  void value;
}

export interface PaymentBoxProps {
  bookingId: number;
  /** REQUIRED and never derived here — ruling 1 above depends on it. */
  status: BookingStatus;
  payment: PaymentBoxState;
  /**
   * Whether the tour date is today in Manila, **as resolved by the server**
   * (`driver.trips` sends each row's `bucket`) — or `null` when nobody has
   * established it yet: an unresolved list, or a trip that is not on the
   * list this screen was handed.
   *
   * Never computed from the handset's clock: for the whole 00:00-07:59
   * Manila window the device's UTC day is still yesterday.
   *
   * Three states rather than two because `false` is a CLAIM. Collapsing
   * "not today" into "not known yet" printed "Cash can only be recorded on
   * the day of the trip" over a trip that may well be today (fix round 1,
   * 2026-10-16). Hiding the button in both cases is the right fail-closed
   * direction; asserting a fact nobody has established is not.
   */
  isToday: boolean | null;
  /** Called after a successful cash claim so the caller can refetch. */
  onCollected: () => void;
}

export default function PaymentBox({
  bookingId,
  status,
  payment,
  isToday,
  onCollected,
}: PaymentBoxProps) {
  const [confirming, setConfirming] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const [recorded, setRecorded] = useState<string | null>(null);

  const recordCash = trpc.driver.recordCash.useMutation({
    /*
     * The acknowledged amount comes from the SERVER's own answer, not from
     * the figure that happened to be on screen, so the claim and the
     * receipt cannot disagree. A receipt is owed here for the same reason
     * the PIN screen owes one — silent success reads as a dead button and
     * produces a second tap, and a second tap at THIS button is a second
     * cash record.
     */
    onSuccess: (result) => {
      setConfirming(false);
      setFailed(null);
      setRecorded(
        `Recorded: ${formatPeso(result.amountCentavos)} taken in cash. The office will verify it.`,
      );
      onCollected();
    },
    onError: (error) => {
      setRecorded(null);
      setFailed(describeCashError(error));
    },
  });

  /**
   * ONE notice for the box, rendered in every live branch — including
   * `unverified_do_not_collect`, which is exactly where a successful claim
   * lands the box once `driver.trip` has been refetched. A receipt that
   * vanished on the refetch would be no receipt at all.
   */
  const notice =
    failed !== null ? (
      <p
        role="alert"
        className="text-brand-error border-brand-error mt-3 border-l-4 py-1 pl-3 text-base font-medium"
      >
        {failed}
      </p>
    ) : recorded !== null ? (
      <p
        role="status"
        className="text-brand-blue-900 border-brand-blue-700 mt-3 border-l-4 py-1 pl-3 text-base font-semibold"
      >
        {recorded}
      </p>
    ) : null;

  /* Ruling 1. The amount is not rendered at all — not greyed, not struck. */
  if (!showsBox(status)) {
    const copy = NOT_COLLECTABLE_COPY[status];
    return (
      <section
        aria-labelledby="payment-box-heading"
        className={`${FRAME} ${copy.tone === 'warn' ? TONES.warn : TONES.calm}`}
      >
        <h2
          id="payment-box-heading"
          className={`${HEADING} ${copy.tone === 'warn' ? 'text-amber-900' : 'text-brand-blue-900'}`}
        >
          {copy.heading}
        </h2>
        <p
          className={`mt-2 text-base font-medium ${
            copy.tone === 'warn' ? 'text-amber-900' : 'text-brand-blue-900'
          }`}
        >
          {copy.body}
        </p>
      </section>
    );
  }

  if (payment.kind === 'fully_paid') {
    return (
      <section aria-labelledby="payment-box-heading" className={`${FRAME} ${TONES.calm}`}>
        <h2 id="payment-box-heading" className={`${HEADING} text-brand-blue-900`}>
          <CircleCheckBig className="mr-2 inline size-6 align-[-5px]" aria-hidden="true" />
          Paid in full — collect nothing.
        </h2>
        <p className="text-brand-blue-900 mt-2 text-base font-medium">
          The office has this trip paid for. Take no money from the guest.
        </p>
        {notice}
      </section>
    );
  }

  if (payment.kind === 'unverified_do_not_collect') {
    return (
      <section aria-labelledby="payment-box-heading" className={`${FRAME} ${TONES.warn}`}>
        {/*
         * The WORDS, not the amber. A driver glancing at a phone must not
         * be able to read this state as "collect" — see rule 2.
         */}
        <h2 id="payment-box-heading" className={`${HEADING} text-amber-900`}>
          <TriangleAlert className="mr-2 inline size-6 align-[-5px]" aria-hidden="true" />
          Do not collect — call the office.
        </h2>
        <p className="mt-2 text-base font-medium text-amber-900">
          Payment for this trip has not been verified. Do not take money from the guest.
        </p>
        {notice}
      </section>
    );
  }

  if (payment.kind === 'collect_cash') {
    const figures = formatPeso(payment.amountCentavos);
    const words = pesosInWords(payment.amountCentavos);

    return (
      <section aria-labelledby="payment-box-heading" className={`${FRAME} ${TONES.collect}`}>
        <h2 id="payment-box-heading" className={`${HEADING} text-brand-blue-900`}>
          Collect {figures} cash
        </h2>
        {/* Figures above, words below. Rule 3. */}
        <p className="text-brand-blue-900 mt-1 text-lg font-semibold">{words}</p>

        {isToday === true ? (
          confirming ? (
            /*
             * Step two, IN PLACE. Not a modal: nothing vendored provides
             * one, and a driver one-handed in a van should not have to
             * dismiss a layer. Cancel calls nothing at all.
             */
            <div className="border-brand-blue-200 mt-4 space-y-3 border-t pt-4">
              <p className="text-brand-blue-900 text-base font-semibold">
                Only confirm once the guest has handed you {figures}.
              </p>
              <Button
                type="button"
                onClick={() => {
                  setFailed(null);
                  recordCash.mutate({ bookingId });
                }}
                disabled={recordCash.isPending}
                className="tap-target h-14 w-full text-base font-semibold"
              >
                {recordCash.isPending ? (
                  <>
                    <Loader2 className="mr-2 size-5 animate-spin" aria-hidden="true" />
                    Saving…
                  </>
                ) : (
                  `Yes — I have taken ${figures}`
                )}
              </Button>
              <Button
                type="button"
                variant="outline"
                onClick={() => setConfirming(false)}
                disabled={recordCash.isPending}
                className="tap-target text-brand-blue-900 h-14 w-full text-base font-semibold"
              >
                Cancel
              </Button>
            </div>
          ) : (
            <Button
              type="button"
              onClick={() => {
                setFailed(null);
                setConfirming(true);
              }}
              className="tap-target mt-4 h-14 w-full text-base font-semibold"
            >
              <BanknoteArrowDown className="mr-2 size-5" aria-hidden="true" />
              Record cash collected
            </Button>
          )
        ) : (
          /*
           * No button either way, which is the fail-closed direction — but
           * only ONE of these two sentences is a statement of fact. The
           * server refuses a non-today claim outright (`FORBIDDEN`); when
           * the day is merely unknown, saying so and asking for a reload is
           * the honest answer (fix round 1, 2026-10-16).
           */
          <p className="text-brand-blue-900 mt-4 text-base font-medium">
            {isToday === false ? CASH_NOT_TODAY : 'Reload this trip to record cash.'}
          </p>
        )}

        {notice}
      </section>
    );
  }

  /*
   * Rule 5 — fails CLOSED. See `assertHandled`: a state this file does not
   * know renders "do not collect", never a peso figure.
   */
  assertHandled(payment);
  return (
    <section aria-labelledby="payment-box-heading" className={`${FRAME} ${TONES.warn}`}>
      <h2 id="payment-box-heading" className={`${HEADING} text-amber-900`}>
        <TriangleAlert className="mr-2 inline size-6 align-[-5px]" aria-hidden="true" />
        Do not collect — call the office.
      </h2>
      <p className="mt-2 text-base font-medium text-amber-900">
        This screen cannot read this trip&apos;s payment state. Do not take money from the guest.
      </p>
      {notice}
    </section>
  );
}
