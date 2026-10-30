import { keepPreviousData } from '@tanstack/react-query';
import { DATE_BLOCKED, DATE_NOT_BOOKABLE, type PayMode } from '@rg/shared';
import { useEffect, useState, type FormEvent } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import QueryBoundary from '@/components/common/QueryBoundary';
import { Skeleton } from '@/components/common/Skeleton';
import CouponField from '@/components/checkout/CouponField';
import GuestDetails from '@/components/checkout/GuestDetails';
import HoldCountdown from '@/components/checkout/HoldCountdown';
import ConsentCheckbox from '@/components/checkout/ConsentCheckbox';
import PayNowButton from '@/components/checkout/PayNowButton';
import QuoteSummary from '@/components/checkout/QuoteSummary';
import { Button } from '@/components/ui/button';
import { getFieldErrors, getFormErrors } from '@/lib/field-errors';
import { describeCheckoutError } from '@/lib/mutation-errors';
import { trpc } from '@/lib/trpc';

/**
 * Task 8, week 3 checkout plan — CLAUDE.md's highest-stakes screen.
 *
 * **This page computes nothing.** It asks `checkout.quote` for a
 * `QuoteResult` and renders exactly those fields (`QuoteSummary`); it
 * collects what the guest types (`GuestDetails`, `CouponField`,
 * `ConsentCheckbox`) and echoes the quote's own `quoteId` back to
 * `checkout.createHold` so the server can refuse a stale price. There is no
 * `*` or `+` anywhere in this file (or any other under `client/`) touching a
 * centavos value — see `checkout-page.test.tsx`'s repo-wide scan.
 *
 * **Route shape.** BUILD_SPEC §4 names `/checkout/:holdId`, written before
 * the Week 3 plan's own owner ruling (Q3): there is no hold, and so no
 * holdId, until THIS form's submit creates one via `createHold`. So the
 * identity carried in the URL is the guest's TOUR SELECTION instead —
 * `/checkout/:tourSlug` plus `date`/`pax`/`addons`/`coupon` query params,
 * exactly what `checkout.quote` needs. Nothing today links here yet (the
 * tour detail page carrying "Book now" is a later task); this is flagged in
 * the task report for the controller to confirm when that CTA is wired.
 *
 * **It now joins checkout → payment (Task 8b).** `checkout.startPayment`
 * (built Task 7) is what actually starts a gateway redirect; a code review
 * of this plan found that nothing in the UI called it, which meant a guest
 * could hold a spot but never pay for it from this page. After a
 * successful `createHold`, `<PayNowButton>` (components/checkout/
 * PayNowButton.tsx) is the one trigger: it calls `checkout.startPayment`
 * with the new booking's `ref` and leaves for the `redirectUrl` it returns.
 * The same component is reused by `BookingStatusPage` as its "try paying
 * again" affordance, so the two screens share one translation of
 * `startPayment`'s guest-safe refusals rather than two copies that could
 * drift.
 *
 * **It also previews the booking window and tour availability — advisory
 * only.** `checkout.availability` (an advisory read, never authoritative —
 * see that procedure's own note) is asked alongside `checkout.quote` for
 * the same tour/date/pax, and an `ok: false` verdict shows an amber banner
 * with its own distinct sentence: `date_not_bookable` ("that date isn't
 * bookable") and `date_blocked` ("this tour isn't running that day") are
 * never worded like a capacity refusal ("that day is full") — the three are
 * different facts about different systems (a date window has no clock
 * dependency on van/driver supply, and a blocked day is an admin's
 * decision that will not free up). `createHold()` remains the one
 * authority; this banner cannot block or skip its own, later, re-check.
 */

const MAX_PAX = 12;

function parsePax(raw: string | null): number {
  const value = Number(raw ?? '1');
  if (!Number.isFinite(value) || value < 1) return 1;
  return Math.min(Math.trunc(value), MAX_PAX);
}

function parseAddonIds(raw: string | null): number[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map((part) => Number(part.trim()))
    .filter((n) => Number.isInteger(n) && n > 0);
}

/**
 * `AVAILABILITY_MESSAGES` — the client's own tiny vocabulary for
 * `checkout.availability`'s advisory `ok: false` verdicts (Task 8b).
 * `DATE_NOT_BOOKABLE` gets its own sentence, keyed off the SHARED constant
 * (`@rg/shared`) rather than a retyped string literal, so a future rename
 * of the wire value fails this file at compile time instead of silently
 * falling through to the capacity fallback below. Every capacity reason
 * (`tour_unavailable`, `tour_sold_out`, `no_van_available`,
 * `no_driver_available`) shares one deliberately different sentence — the
 * server already has its own distinct copy per reason
 * (`CAPACITY_MESSAGES` in checkout.ts) for the AUTHORITATIVE `createHold`
 * refusal a guest sees on submit; this banner is only the early, advisory
 * hint, so one shared "no space" sentence is enough to be honest without
 * duplicating that vocabulary.
 */
const AVAILABILITY_MESSAGES: Record<string, string> = {
  [DATE_NOT_BOOKABLE]:
    "We're not taking online bookings for that date. Please choose a different date.",
  /*
   * `tour_blocked_dates` — an admin closed that day for this tour (final
   * whole-branch review, F4). Its own sentence, keyed off the shared
   * constant like the one above: a blocked day is not coming back, so the
   * capacity fallback's "try a different date, fewer guests" would send a
   * guest round a loop that cannot end, and the booking-window sentence
   * would point at the wrong cause. Amber like every other hint on this
   * page — never red (CLAUDE.md, guarded by `no-red.test.ts`).
   */
  [DATE_BLOCKED]: "This tour isn't running on that date. Please choose a different date.",
};
const CAPACITY_FALLBACK_MESSAGE =
  "This tour doesn't have space for that date and group size. Please try a different date, fewer guests, or contact us.";

function describeAvailability(reason: string): string {
  return AVAILABILITY_MESSAGES[reason] ?? CAPACITY_FALLBACK_MESSAGE;
}

/**
 * Which of `createHoldInput`'s top-level field names this form actually puts
 * an input on screen for (task A4) — the keys `lib/field-errors.ts` can hand
 * to a component that will render them beside their control.
 *
 * It is an ALLOW-LIST of the placed fields, and everything else
 * (`tourSlug`, `date`, `pax`, `addonIds`, `quoteId`) is deliberately absent:
 * those come from the URL and the quote, not from anything a guest typed
 * here, so there is no box to put their message under. A validation message
 * for one of them is shown in the banner above the form instead, because the
 * alternative — a message the code thought it had placed and never rendered
 * — is the silent half of this bug rather than a fix for it.
 *
 * `lead` covers name/email/phone together; see `GuestDetails.tsx` on why
 * that one key cannot be split client-side.
 */
const PLACED_HOLD_FIELDS: ReadonlySet<string> = new Set([
  'lead',
  'pickup',
  'pickupMapUrl',
  'requests',
  'payMode',
  'consent',
  'couponCode',
]);

function CheckoutSkeleton() {
  return (
    <div
      role="status"
      aria-label="Loading checkout"
      className="mt-8 grid gap-8 lg:grid-cols-[1fr_360px]"
    >
      <div className="space-y-4">
        <Skeleton className="h-11 w-full" />
        <Skeleton className="h-11 w-full" />
        <Skeleton className="h-28 w-full" />
        <Skeleton className="h-11 w-full" />
      </div>
      <Skeleton className="h-64 w-full rounded-xl" />
    </div>
  );
}

export default function CheckoutPage() {
  const { tourSlug } = useParams<{ tourSlug: string }>();
  const [searchParams] = useSearchParams();
  const date = searchParams.get('date') ?? '';
  const pax = parsePax(searchParams.get('pax'));
  const addonIds = parseAddonIds(searchParams.get('addons'));
  const initialCoupon = searchParams.get('coupon')?.trim() || undefined;

  const [couponCode, setCouponCode] = useState<string | undefined>(initialCoupon);
  const [couponInput, setCouponInput] = useState(initialCoupon ?? '');
  const [couponError, setCouponError] = useState<string | null>(null);
  const [payMode, setPayMode] = useState<PayMode>('deposit');
  const [consentError, setConsentError] = useState<string | null>(null);

  const hasSelection = Boolean(tourSlug) && date !== '' && pax >= 1;

  const quoteQuery = trpc.checkout.quote.useQuery(
    { tourSlug: tourSlug ?? '', date, pax, addonIds, couponCode },
    { enabled: hasSelection, retry: false, placeholderData: keepPreviousData },
  );
  // Advisory only (see this procedure's own note) — `createHold()` below
  // remains the one authority and re-checks the same two facts itself.
  const availabilityQuery = trpc.checkout.availability.useQuery(
    { tourSlug: tourSlug ?? '', date, pax },
    { enabled: hasSelection, retry: false, placeholderData: keepPreviousData },
  );
  const createHold = trpc.checkout.createHold.useMutation();
  /*
   * Read for ONE boolean: `manualTransferEnabled`, which decides whether the
   * "pay by transfer instead" link is offered after a hold (Week 4 Task 8).
   * The same cache entry every other page's `settings.get` uses — TanStack
   * dedupes by key — so this costs no extra request.
   */
  const settingsQuery = trpc.settings.get.useQuery();

  // An invalid/expired coupon fails the WHOLE quote (couponCode is part of
  // its input), which would otherwise blank the rest of the page. Report
  // the server's own reason next to the coupon field, then drop back to the
  // coupon-free quote so the guest's progress survives a bad code.
  useEffect(() => {
    if (couponCode && quoteQuery.isError) {
      setCouponError(describeCheckoutError(quoteQuery.error));
      setCouponCode(undefined);
    }
  }, [couponCode, quoteQuery.isError, quoteQuery.error]);

  function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!quoteQuery.data || !tourSlug) return;

    const form = e.currentTarget;
    const data = new FormData(form);

    if (data.get('consent') !== 'on') {
      createHold.reset();
      setConsentError(
        'Please agree to the data privacy consent above before we can hold your spot (RA 10173).',
      );
      return;
    }
    setConsentError(null);

    const pickup = String(data.get('pickup') ?? '').trim();
    const pickupMapUrl = String(data.get('pickupMapUrl') ?? '').trim();
    const requests = String(data.get('requests') ?? '').trim();

    createHold.mutate({
      tourSlug,
      date,
      pax,
      addonIds,
      couponCode,
      payMode,
      quoteId: quoteQuery.data.quoteId,
      lead: {
        name: String(data.get('name') ?? ''),
        email: String(data.get('email') ?? ''),
        // Sent exactly as the guest typed it. `phPhoneSchema` normalises PH
        // mobile numbers to `+639XXXXXXXXX` only once the SERVER parses this
        // input — re-normalising (or assuming it already looks normalised)
        // here is the trap carried forward from Task 1's review.
        phone: String(data.get('phone') ?? ''),
      },
      pickup: pickup === '' ? undefined : pickup,
      pickupMapUrl: pickupMapUrl === '' ? undefined : pickupMapUrl,
      requests: requests === '' ? undefined : requests,
      consent: true,
    });
  }

  /*
   * `createHold`'s refusal, split into the two kinds a guest can act on
   * differently (task A4).
   *
   * `holdFieldErrors` is non-null only for an INPUT VALIDATION failure, and
   * its messages go to the inputs below. Everything else — a capacity
   * refusal, a stale quote, a 429, a gateway fault — keeps going through
   * `describeCheckoutError`, which is the router's own carefully-worded
   * sentence for each and must not be collapsed into a field message.
   *
   * `holdBannerMessages` is what is left over after the fields have taken
   * their share: the form-level issues, plus any field the form does not
   * render (see `PLACED_HOLD_FIELDS`), or — when this was not a validation
   * failure at all — the single existing generic/specific sentence.
   */
  const holdFieldErrors = createHold.isError ? getFieldErrors(createHold.error) : null;
  const holdFormErrors = createHold.isError ? getFormErrors(createHold.error) : [];
  const unplacedFieldMessages = Object.entries(holdFieldErrors ?? {})
    .filter(([field]) => !PLACED_HOLD_FIELDS.has(field))
    .map(([, message]) => message);
  const isValidationRefusal = holdFieldErrors !== null || holdFormErrors.length > 0;
  const holdBannerMessages = !createHold.isError
    ? []
    : isValidationRefusal
      ? [...holdFormErrors, ...unplacedFieldMessages]
      : [describeCheckoutError(createHold.error)];

  if (!hasSelection) {
    return (
      <div className="mx-auto max-w-3xl px-4 py-16 text-center sm:px-6">
        <h1 className="text-brand-blue-900 text-2xl font-bold tracking-tight">
          Select a tour first
        </h1>
        <p className="text-muted-foreground mt-3 text-base">
          We need a tour, a date and a group size before we can quote a price.
        </p>
        <Link
          to="/tours"
          className="bg-brand-blue-700 tap-target hover:bg-brand-blue-800 mt-6 inline-flex items-center justify-center rounded-md px-5 font-semibold text-white"
        >
          Browse tours
        </Link>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-5xl px-4 py-10 sm:px-6 lg:px-8">
      <h1 className="text-brand-blue-900 text-2xl font-bold tracking-tight sm:text-3xl">
        Checkout
      </h1>
      <p className="text-muted-foreground mt-2 text-sm">
        Review your trip, enter your details, and we'll hold your spot while you pay.
      </p>

      {availabilityQuery.data && !availabilityQuery.data.ok && (
        <div
          role="alert"
          className="border-brand-warning/30 bg-brand-gold-100 text-brand-gold-800 mt-6 rounded-xl border p-4"
        >
          <p className="text-sm font-medium">
            {describeAvailability(availabilityQuery.data.reason)}
          </p>
        </div>
      )}

      <QueryBoundary
        query={quoteQuery}
        skeleton={<CheckoutSkeleton />}
        errorTitle="Could not load this tour's pricing"
      >
        {(quote) => (
          <div className="mt-8 grid gap-8 lg:grid-cols-[1fr_360px] lg:items-start">
            <div className="order-2 lg:order-1">
              {createHold.isSuccess && createHold.data ? (
                <div className="border-brand-blue-200 bg-background space-y-4 rounded-2xl border p-6">
                  <div className="space-y-3">
                    <p className="text-brand-blue-900 text-lg font-semibold">Your spot is held!</p>
                    <p className="text-muted-foreground text-sm">
                      Booking reference{' '}
                      <span className="text-brand-blue-900 font-semibold">
                        {createHold.data.ref}
                      </span>
                      . We've reserved your spot — pay now to confirm it before the hold below runs
                      out, and keep this reference for your records.
                    </p>
                  </div>
                  <PayNowButton bookingRef={createHold.data.ref} />

                  {/*
                   * The manual transfer alternative (§6, Week 4 Task 8).
                   *
                   * **Offered only when `manualTransferEnabled`** — the
                   * `payment_qr` settings block's own flag, which is false
                   * until R&G's QR and account details are configured
                   * (owner decision 2026-10-14, Q3). Offering it sooner
                   * would send a guest to a screen that could only
                   * apologise.
                   *
                   * It is a LINK, not a mutation. Week 3's checkout router
                   * has exactly two mutations and that is a tested property
                   * (owner decision Q5, option c): paying by transfer
                   * starts nothing on the server, so nothing here calls it.
                   * The link carries the ref to prefill the portal sign-in,
                   * which is where the guest session — and therefore the
                   * amount and the account details — comes from.
                   */}
                  {settingsQuery.data?.manualTransferEnabled ? (
                    <p className="text-center text-sm">
                      <Link
                        to={`/portal/login?ref=${encodeURIComponent(createHold.data.ref)}&next=/portal/pay`}
                        className="text-brand-blue-700 hover:text-brand-blue-900 tap-target inline-flex items-center font-semibold underline transition-colors"
                      >
                        Pay by GCash, Maya or bank transfer instead
                      </Link>
                    </p>
                  ) : null}
                </div>
              ) : (
                <form aria-label="Checkout form" onSubmit={handleSubmit} className="space-y-6">
                  <CouponField
                    value={couponInput}
                    onValueChange={(value) => {
                      setCouponInput(value);
                      setCouponError(null);
                    }}
                    applied={couponCode}
                    onApply={() => setCouponCode(couponInput.trim())}
                    onRemove={() => {
                      setCouponCode(undefined);
                      setCouponInput('');
                      setCouponError(null);
                    }}
                    error={couponError ?? holdFieldErrors?.couponCode ?? null}
                    isChecking={Boolean(couponCode) && quoteQuery.isFetching}
                  />

                  <GuestDetails
                    payMode={payMode}
                    onPayModeChange={setPayMode}
                    amountDueNowCentavos={quote.amountDueNowCentavos}
                    fieldErrors={holdFieldErrors}
                  />

                  {/*
                   * The guest's own un-ticked box takes priority over the
                   * server's `consent` message: the local one is shown
                   * BEFORE anything is sent (the submit handler blocks), so
                   * the two never describe the same submit.
                   */}
                  <ConsentCheckbox
                    error={consentError ?? holdFieldErrors?.consent ?? null}
                    onChange={() => setConsentError(null)}
                  />

                  {holdBannerMessages.map((message) => (
                    <p key={message} role="alert" className="text-brand-error text-sm font-medium">
                      {message}
                    </p>
                  ))}

                  <Button
                    type="submit"
                    size="lg"
                    className="tap-target w-full"
                    disabled={createHold.isPending}
                  >
                    {createHold.isPending ? 'Holding your spot…' : 'Book now, hold my spot'}
                  </Button>
                </form>
              )}
            </div>

            <div className="order-1 space-y-4 lg:sticky lg:top-24 lg:order-2">
              <QuoteSummary quote={quote} pax={pax} payMode={payMode} />
              {createHold.isSuccess && createHold.data && (
                <HoldCountdown expiresAt={createHold.data.holdExpiresAt} />
              )}
            </div>
          </div>
        )}
      </QueryBoundary>
    </div>
  );
}
