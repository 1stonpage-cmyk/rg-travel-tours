import { keepPreviousData } from '@tanstack/react-query';
import { TRPCClientError } from '@trpc/client';
import type { PayMode } from '@rg/shared';
import { useEffect, useState, type FormEvent } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import QueryBoundary from '@/components/common/QueryBoundary';
import { Skeleton } from '@/components/common/Skeleton';
import CouponField from '@/components/checkout/CouponField';
import GuestDetails from '@/components/checkout/GuestDetails';
import HoldCountdown from '@/components/checkout/HoldCountdown';
import ConsentCheckbox from '@/components/checkout/ConsentCheckbox';
import QuoteSummary from '@/components/checkout/QuoteSummary';
import { Button } from '@/components/ui/button';
import { describeMutationError } from '@/lib/mutation-errors';
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
 * **Why it stops at `createHold`.** `checkout.startPayment` (already built,
 * Task 7) is what actually starts a gateway redirect, and wiring a "pay
 * now" trigger to it is a real payment-flow decision this task's brief does
 * not list (Interfaces: `checkout.quote`, `checkout.createHold` only) — the
 * plan's own mapping (`§6 online payment → Task 7`) never assigns a client
 * trigger to any task in this plan. CLAUDE.md: stop and ask before touching
 * payment flow outside the given task. So this page ends at a held booking
 * plus its countdown, exactly §6's bullet list for "Checkout page" (lead
 * details, pay toggle, coupon, countdown, consent) — nothing about an
 * online-payment button is in that list either.
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
 * `describeMutationError` (lib/mutation-errors.ts) only ever returns one of
 * two fixed strings — a deliberate scope for `inquiries.create`, which has
 * no other guest-safe message to preserve. `checkout.quote` and
 * `checkout.createHold` are different: their router
 * (`server/src/routers/public/checkout.ts`) crafts a SPECIFIC guest-safe
 * sentence for every 4xx it can throw ("This tour is fully booked for that
 * date.", "That coupon code has already been fully claimed.", "The price
 * for this quote has changed.") — that router's own doc comment calls
 * picking that sentence its whole job. Collapsing every one of those into
 * one generic line would throw the work away. So: a 429 (and anything 5xx)
 * still goes through `describeMutationError`'s two approved strings, but
 * every other 4xx's OWN message passes through untouched.
 */
function describeCheckoutError(error: unknown): string {
  if (
    error instanceof TRPCClientError &&
    typeof error.data?.httpStatus === 'number' &&
    error.data.httpStatus < 500 &&
    error.data.httpStatus !== 429
  ) {
    return error.message;
  }
  return describeMutationError(error);
}

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
  const createHold = trpc.checkout.createHold.useMutation();

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

      <QueryBoundary
        query={quoteQuery}
        skeleton={<CheckoutSkeleton />}
        errorTitle="Could not load this tour's pricing"
      >
        {(quote) => (
          <div className="mt-8 grid gap-8 lg:grid-cols-[1fr_360px] lg:items-start">
            <div className="order-2 lg:order-1">
              {createHold.isSuccess && createHold.data ? (
                <div className="border-brand-blue-200 bg-background space-y-3 rounded-2xl border p-6">
                  <p className="text-brand-blue-900 text-lg font-semibold">Your spot is held!</p>
                  <p className="text-muted-foreground text-sm">
                    Booking reference{' '}
                    <span className="text-brand-blue-900 font-semibold">{createHold.data.ref}</span>
                    . We've reserved your spot — please complete payment before the hold below runs
                    out, and keep this reference for your records.
                  </p>
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
                    error={couponError}
                    isChecking={Boolean(couponCode) && quoteQuery.isFetching}
                  />

                  <GuestDetails
                    payMode={payMode}
                    onPayModeChange={setPayMode}
                    amountDueNowCentavos={quote.amountDueNowCentavos}
                  />

                  <ConsentCheckbox error={consentError} onChange={() => setConsentError(null)} />

                  {createHold.isError && (
                    <p role="alert" className="text-brand-error text-sm font-medium">
                      {describeCheckoutError(createHold.error)}
                    </p>
                  )}

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
