import { keepPreviousData } from '@tanstack/react-query';
import { useMemo, useState, type FormEvent } from 'react';
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
import { getFieldErrors, getFormErrors, hasAnyNestedFieldError } from '@/lib/field-errors';
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
   * `undefined` on either an in-flight load OR a settled error — the one
   * card state T13's `VehicleOptionCard` renders for both (see its own
   * note). `isLoading` reads `isPending`, never `isFetching`: with
   * `keepPreviousData`, a coupon-driven refetch keeps `isPending` false
   * once the first load has settled, so the card keeps showing its
   * previous figure instead of flashing back to a skeleton on every
   * keystroke — which is the whole reason the brief calls for
   * `keepPreviousData` in the first place.
   */
  function quoteFor(type: VehicleType): QuoteTransferResult | undefined {
    const q = quotesByType[type];
    return q.isError ? undefined : q.data;
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
                    isLoading={quotesByType[type].isPending}
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
