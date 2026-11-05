import { keepPreviousData } from '@tanstack/react-query';
import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  TRANSFER_PRODUCT_TYPES,
  VEHICLE_TYPES,
  type PayMode,
  type QuoteTransferResult,
  type TransferProductType,
  type TransferRoutePublicRow,
  type VehicleType,
} from '@rg/shared';
import CouponField from '@/components/checkout/CouponField';
import PaymentOptions from '@/components/checkout/PaymentOptions';
import HoldCountdown from '@/components/checkout/HoldCountdown';
import RoutePicker from '@/components/transfer/RoutePicker';
import TransferGuestDetailsForm from '@/components/transfer/TransferGuestDetailsForm';
import TransferTypePicker from '@/components/transfer/TransferTypePicker';
import VehicleOptionCard from '@/components/transfer/VehicleOptionCard';
import { Button } from '@/components/ui/button';
import {
  firstValidationMessage,
  getFieldErrors,
  getFormErrors,
  hasAnyNestedFieldError,
} from '@/lib/field-errors';
import { describeCheckoutError } from '@/lib/mutation-errors';
import { trpc } from '@/lib/trpc';

/**
 * Task T14 — the guest-facing transfer booking flow, modelled directly on
 * `CheckoutPage.tsx`'s own shape (local selection state, one query per price
 * surface, a coupon/consent/pay-mode dance, and a success swap to
 * `<PaymentOptions>`). This page owns every tRPC call the four T13
 * presentational components (`TransferTypePicker`, `RoutePicker`,
 * `VehicleOptionCard`, `TransferGuestDetailsForm`) do not make themselves.
 *
 * **Step order:** type + route (both always on screen, independent of
 * selection — a guest can change either at any time and the vehicle prices
 * below re-key automatically) → one `quoteTransfer` query per vehicle type,
 * rendered as two `VehicleOptionCard`s once a route is chosen → the guest
 * details form, once a vehicle is chosen and still priced. There is no
 * separate "select a transfer first" gate the way `CheckoutPage` has for a
 * missing `tourSlug`: every step is reachable from this one page, with no
 * URL param required to start.
 *
 * **The day-use "from ₱X" decision (brief, flow step 1).** `RoutePicker`
 * has no `productType` prop and always shows the cheaper ONE-WAY rate
 * (T13's own fixed contract). On a day-use selection that figure would be
 * the wrong number for the product actually being priced, and this
 * codebase's rule is that a wrong price is worse than an unavailable one.
 * Rather than touching `RoutePicker` (out of scope) or suppressing the
 * figure, `displayRoutes` below swaps each vehicle's `dayUsePriceCentavos`
 * into the `oneWayPriceCentavos` slot of a per-render COPY of the route list
 * whenever `productType === 'transfer_day_use'` — `RoutePicker`'s own
 * "from " label names no unit, so the swapped figure reads correctly with
 * no component change. Ledgered in the task report.
 *
 * **Query-param prefill gap (brief, "optional prefill").** `productType`
 * and `routeId` are read from the URL once, at mount, because this page
 * owns that state. `date` and `pax` are NOT prefillable: both live as
 * plain uncontrolled inputs inside `TransferGuestDetailsForm`, whose fixed
 * T13 Props carry no `defaultValue` channel, and this task may not touch
 * that component's internals. A guest arriving with `?date=...&pax=...`
 * reaches a working flow and simply re-types those two fields at step 3 —
 * ledgered in the report rather than worked around with a DOM query.
 *
 * **A bad coupon must not be mistaken for an unavailable vehicle (T14 review
 * fix, Critical 1).** `quoteTransfer` validates the coupon BEFORE pricing, so
 * a bad/expired code throws the SAME refusal on both the van and the suv
 * query at once — distinct from a route/vehicle-shape refusal (no price row
 * for one vehicle type), which can only ever hit ONE of the two queries. The
 * `useEffect` below uses exactly that discriminator: only when `couponCode`
 * is set AND both queries are erroring simultaneously does it treat the
 * failure as the coupon's, surface the server's own sentence beside
 * `CouponField` (mirroring `CheckoutPage.tsx`'s own coupon-recovery effect),
 * and revert to a coupon-free quote. A single query erroring alone is left
 * exactly as before — that one vehicle is unavailable, and the coupon is
 * untouched.
 *
 * **A placeholder (stale) quote must render as loading, never as a
 * selectable but outdated price (T14 review fix, Critical 2).**
 * `keepPreviousData` is scoped to the WHOLE query key, which includes
 * `productType` — so switching one-way → day-use without this would keep
 * showing the van card's one-way total, still clickable, until the day-use
 * quote resolves. Each card's `isLoading` therefore reads
 * `isPending || isPlaceholderData`, not `isPending` alone: a placeholder
 * result is "stale", and this codebase treats a stale price as strictly
 * worse than an unavailable one. `keepPreviousData` itself stays — dropping
 * it would reintroduce the coupon-recovery blanking it was added to prevent.
 */

function readInitialProductType(raw: string | null): TransferProductType | null {
  return raw && (TRANSFER_PRODUCT_TYPES as readonly string[]).includes(raw)
    ? (raw as TransferProductType)
    : null;
}

function readInitialRouteId(raw: string | null): number | null {
  if (!raw) return null;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

/** Mirrors `CheckoutPage.tsx`'s `String(data.get(x) ?? '').trim()` convention
 * — but checked for `null` FIRST. `TransferGuestDetailsForm` conditionally
 * renders `dayUseEndTime`/`flightNumber`/`airline` on `productType`, so a
 * field that is not on screen is not in `FormData` at all; stringifying a
 * missing `FormDataEntryValue` (`null`) with `String()` before checking
 * produces the literal text `'null'`, which is truthy and would send the
 * server a value it then refuses for the wrong reason. */
function optionalField(data: FormData, name: string): string | undefined {
  const raw = data.get(name);
  if (raw === null) return undefined;
  const value = String(raw).trim();
  return value === '' ? undefined : value;
}

/**
 * Every top-level field name `createHoldTransferInput` can name, mirroring
 * `CheckoutPage.tsx`'s `PLACED_HOLD_FIELDS`. Unlike that page, every single
 * field here genuinely has a box on screen (the three pickers take
 * `productType`/`routeId`/`vehicleType`, `CouponField` takes `couponCode`,
 * and `TransferGuestDetailsForm` takes the rest) — so `unplacedFieldMessages`
 * below is expected to stay empty in practice. It is kept anyway as the same
 * defensive leftover-catcher `CheckoutPage` uses, so a field added to the
 * schema later without a matching box still surfaces somewhere rather than
 * vanishing silently.
 */
const PLACED_HOLD_FIELDS: ReadonlySet<string> = new Set([
  'productType',
  'routeId',
  'vehicleType',
  'couponCode',
  'date',
  'pickupTime',
  'dayUseEndTime',
  'pax',
  'luggageCount',
  'pickup',
  'pickupMapUrl',
  'dropoffAddress',
  'dropoffMapUrl',
  'flightNumber',
  'airline',
  'requests',
  'payMode',
  'consent',
  'lead',
]);

/** See `CheckoutPage.tsx`'s own `LEAD_LEAF_PATHS` note (final-review finding 1). */
const LEAD_LEAF_PATHS = ['lead.name', 'lead.email', 'lead.phone'] as const;

export default function TransferBookingPage() {
  const [searchParams] = useSearchParams();

  const [productType, setProductType] = useState<TransferProductType | null>(() =>
    readInitialProductType(searchParams.get('productType')),
  );
  const [routeId, setRouteId] = useState<number | null>(() =>
    readInitialRouteId(searchParams.get('routeId')),
  );
  const [vehicleType, setVehicleType] = useState<VehicleType | null>(null);
  const [payMode, setPayMode] = useState<PayMode>('deposit');

  const [couponCode, setCouponCode] = useState<string | undefined>(undefined);
  const [couponInput, setCouponInput] = useState('');
  const [couponError, setCouponError] = useState<string | null>(null);
  const [consentError, setConsentError] = useState<string | null>(null);

  const routesQuery = trpc.transferRoutes.list.useQuery();

  /*
   * See this file's own header note. A per-render copy, never a mutation of
   * `routesQuery.data` — `prices[type]` may be `null` (no stored row), and
   * that absence is preserved rather than guessed at.
   */
  const displayRoutes = useMemo<TransferRoutePublicRow[]>(() => {
    const routes = routesQuery.data ?? [];
    if (productType !== 'transfer_day_use') return routes;
    return routes.map((route) => ({
      ...route,
      prices: {
        van: route.prices.van
          ? { ...route.prices.van, oneWayPriceCentavos: route.prices.van.dayUsePriceCentavos }
          : null,
        suv: route.prices.suv
          ? { ...route.prices.suv, oneWayPriceCentavos: route.prices.suv.dayUsePriceCentavos }
          : null,
      },
    }));
  }, [routesQuery.data, productType]);

  const vehiclePricingEnabled = productType !== null && routeId !== null;

  const vanQuote = trpc.checkout.quoteTransfer.useQuery(
    {
      routeId: routeId ?? 0,
      vehicleType: 'van',
      productType: productType ?? 'transfer_one_way',
      couponCode,
    },
    { enabled: vehiclePricingEnabled, retry: false, placeholderData: keepPreviousData },
  );
  const suvQuote = trpc.checkout.quoteTransfer.useQuery(
    {
      routeId: routeId ?? 0,
      vehicleType: 'suv',
      productType: productType ?? 'transfer_one_way',
      couponCode,
    },
    { enabled: vehiclePricingEnabled, retry: false, placeholderData: keepPreviousData },
  );
  const quotesByType: Record<VehicleType, typeof vanQuote> = { van: vanQuote, suv: suvQuote };

  /*
   * The last CONFIRMED (non-placeholder) successful quote per vehicle type,
   * for the CURRENT `routeId`/`productType` only — reset the instant either
   * changes, so a value from a different route or product can never be
   * offered as anyone's fallback. This exists for one reason: when a bad
   * coupon makes both queries settle to `isError`, React Query's own `data`
   * for each becomes `undefined` (placeholderData only covers the PENDING
   * phase, not a settled error) — without something to fall back to,
   * `selectedQuote` below would go `undefined` for one render, unmounting
   * `<TransferGuestDetailsForm>` and destroying every uncontrolled field the
   * guest had already typed, before the effect two lines down even gets a
   * chance to clear the coupon (Critical 1).
   */
  const [lastGoodQuotes, setLastGoodQuotes] = useState<
    Partial<Record<VehicleType, QuoteTransferResult>>
  >({});

  useEffect(() => {
    setLastGoodQuotes({});
  }, [routeId, productType]);

  useEffect(() => {
    if (vanQuote.isSuccess && !vanQuote.isPlaceholderData) {
      setLastGoodQuotes((prev) =>
        prev.van === vanQuote.data ? prev : { ...prev, van: vanQuote.data },
      );
    }
  }, [vanQuote.data, vanQuote.isSuccess, vanQuote.isPlaceholderData]);

  useEffect(() => {
    if (suvQuote.isSuccess && !suvQuote.isPlaceholderData) {
      setLastGoodQuotes((prev) =>
        prev.suv === suvQuote.data ? prev : { ...prev, suv: suvQuote.data },
      );
    }
  }, [suvQuote.data, suvQuote.isSuccess, suvQuote.isPlaceholderData]);

  /*
   * Critical 1 fix — see this file's own header note. Fires only when a
   * coupon is applied AND both queries are erroring at the SAME time, which
   * is what a bad/expired coupon looks like (it fails validation identically
   * for both vehicle types) and a route/vehicle-shape refusal (no price row
   * for one vehicle) never does. `vanQuote.error` is read as the
   * representative message — a coupon refusal is deterministic across both
   * queries, so the two never actually disagree.
   */
  useEffect(() => {
    if (couponCode && vanQuote.isError && suvQuote.isError) {
      setCouponError(
        firstValidationMessage(vanQuote.error) ?? describeCheckoutError(vanQuote.error),
      );
      setCouponCode(undefined);
    }
  }, [couponCode, vanQuote.isError, suvQuote.isError, vanQuote.error]);

  /*
   * `undefined` on either an in-flight load OR a settled error that is NOT a
   * transient coupon self-heal — the one card state T13's `VehicleOptionCard`
   * renders for both (see its own note). The card's own `isLoading` prop
   * (below, where this is called) reads `isPending || isPlaceholderData`,
   * not `isPending` alone — see the Critical 2 fix in this file's header
   * note: `isPlaceholderData` is what catches a STALE quote left over from a
   * different query key (a product-type switch) so it renders as loading
   * rather than as a selectable, outdated price. A coupon-only refetch still
   * keeps `isPending` false and shows its previous figure without flashing
   * to a skeleton — `isPlaceholderData` only lasts for the brief window
   * until the new key's real data lands, same as it would for any key
   * change.
   *
   * While BOTH queries are erroring with a coupon applied, this falls back
   * to `lastGoodQuotes` (above) instead of `undefined` — see Critical 1.
   * The fallback is scoped to exactly that condition: a vehicle that is
   * genuinely unavailable for the current route (no coupon involved, or
   * only one query erroring) still returns `undefined` here, unchanged.
   */
  function quoteFor(type: VehicleType): QuoteTransferResult | undefined {
    const q = quotesByType[type];
    if (!q.isError) return q.data;
    if (couponCode && vanQuote.isError && suvQuote.isError) {
      return lastGoodQuotes[type];
    }
    return undefined;
  }

  const selectedQuote = vehicleType ? quoteFor(vehicleType) : undefined;

  const createHoldTransfer = trpc.checkout.createHoldTransfer.useMutation();

  const holdFieldErrors = createHoldTransfer.isError
    ? getFieldErrors(createHoldTransfer.error)
    : null;
  const holdFormErrors = createHoldTransfer.isError ? getFormErrors(createHoldTransfer.error) : [];
  const leadGroupUnresolved =
    (holdFieldErrors?.lead ?? undefined) !== undefined &&
    !hasAnyNestedFieldError(createHoldTransfer.error, LEAD_LEAF_PATHS);
  const unplacedFieldMessages = Object.entries(holdFieldErrors ?? {})
    .filter(
      ([field]) => !PLACED_HOLD_FIELDS.has(field) || (field === 'lead' && leadGroupUnresolved),
    )
    .map(([, message]) => message);
  const isValidationRefusal = holdFieldErrors !== null || holdFormErrors.length > 0;
  const holdBannerMessages = !createHoldTransfer.isError
    ? []
    : isValidationRefusal
      ? [...holdFormErrors, ...unplacedFieldMessages]
      : [describeCheckoutError(createHoldTransfer.error)];

  function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!productType || !routeId || !vehicleType) return;

    const form = e.currentTarget;
    const data = new FormData(form);

    if (data.get('consent') !== 'on') {
      createHoldTransfer.reset();
      setConsentError(
        'Please agree to the data privacy consent above before we can hold your spot (RA 10173).',
      );
      return;
    }
    setConsentError(null);

    createHoldTransfer.mutate({
      productType,
      routeId,
      vehicleType,
      couponCode,
      date: String(data.get('date') ?? ''),
      pickupTime: String(data.get('pickupTime') ?? ''),
      dayUseEndTime: optionalField(data, 'dayUseEndTime'),
      pax: Number(data.get('pax')),
      luggageCount: Number(data.get('luggageCount')),
      pickup: optionalField(data, 'pickup'),
      pickupMapUrl: optionalField(data, 'pickupMapUrl'),
      dropoffAddress: String(data.get('dropoffAddress') ?? ''),
      dropoffMapUrl: optionalField(data, 'dropoffMapUrl'),
      flightNumber: optionalField(data, 'flightNumber'),
      airline: optionalField(data, 'airline'),
      requests: optionalField(data, 'requests'),
      payMode,
      lead: {
        name: String(data.get('name') ?? ''),
        email: String(data.get('email') ?? ''),
        // Sent exactly as typed — the SERVER normalises a PH mobile number,
        // never the client (same trap `CheckoutPage.tsx` documents).
        phone: String(data.get('phone') ?? ''),
      },
      consent: true,
    });
  }

  return (
    <div className="mx-auto max-w-5xl px-4 py-10 sm:px-6 lg:px-8">
      <h1 className="text-brand-blue-900 text-2xl font-bold tracking-tight sm:text-3xl">
        Book a transfer
      </h1>
      <p className="text-muted-foreground mt-2 text-sm">
        Airport transfers and day-use vehicle hire across Cebu. We'll hold your spot while you pay.
      </p>

      {createHoldTransfer.isSuccess && createHoldTransfer.data ? (
        <div className="border-brand-blue-200 bg-background mt-8 max-w-xl space-y-4 rounded-2xl border p-6">
          <div className="space-y-3">
            <p className="text-brand-blue-900 text-lg font-semibold">Your spot is held!</p>
            <p className="text-muted-foreground text-sm">
              Booking reference{' '}
              <span className="text-brand-blue-900 font-semibold">
                {createHoldTransfer.data.ref}
              </span>
              . We've reserved your spot — it's confirmed once we've received payment, so please
              arrange that before the hold below runs out, and keep this reference for your records.
            </p>
          </div>
          <PaymentOptions bookingRef={createHoldTransfer.data.ref} />
          <HoldCountdown expiresAt={createHoldTransfer.data.holdExpiresAt} />
        </div>
      ) : (
        <form
          aria-label="Transfer booking form"
          onSubmit={handleSubmit}
          className="mt-8 max-w-2xl space-y-6"
        >
          <TransferTypePicker
            value={productType}
            onChange={setProductType}
            error={holdFieldErrors?.productType}
          />

          <RoutePicker
            routes={displayRoutes}
            value={routeId}
            onChange={setRouteId}
            isLoading={routesQuery.isPending}
            error={holdFieldErrors?.routeId}
          />

          {vehiclePricingEnabled && (
            <>
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
                isChecking={Boolean(couponCode) && (vanQuote.isFetching || suvQuote.isFetching)}
              />

              <div className="grid gap-3 sm:grid-cols-2">
                {VEHICLE_TYPES.map((type) => (
                  <VehicleOptionCard
                    key={type}
                    vehicleType={type}
                    quote={quoteFor(type)}
                    isLoading={quotesByType[type].isPending || quotesByType[type].isPlaceholderData}
                    isSelected={vehicleType === type}
                    onSelect={() => setVehicleType(type)}
                    payMode={payMode}
                    error={holdFieldErrors?.vehicleType}
                  />
                ))}
              </div>
            </>
          )}

          {vehicleType !== null && productType !== null && selectedQuote && (
            <>
              <TransferGuestDetailsForm
                productType={productType}
                payMode={payMode}
                onPayModeChange={setPayMode}
                amountDueNowCentavos={selectedQuote.amountDueNowCentavos}
                error={createHoldTransfer.isError ? createHoldTransfer.error : null}
              />

              {consentError && (
                <p role="alert" className="text-brand-error text-sm font-medium">
                  {consentError}
                </p>
              )}

              {holdBannerMessages.map((message) => (
                <p key={message} role="alert" className="text-brand-error text-sm font-medium">
                  {message}
                </p>
              ))}

              <Button
                type="submit"
                size="lg"
                className="tap-target w-full"
                disabled={createHoldTransfer.isPending}
              >
                {createHoldTransfer.isPending ? 'Holding your spot…' : 'Book now, hold my spot'}
              </Button>
            </>
          )}
        </form>
      )}
    </div>
  );
}
