import { keepPreviousData } from '@tanstack/react-query';
import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  TRANSFER_PRODUCT_TYPES,
  type PayMode,
  type QuoteTransferResult,
  type TransferDirection,
  type TransferProductType,
  type TransferRoutePublicRow,
} from '@rg/shared';
import CouponField from '@/components/checkout/CouponField';
import PaymentOptions from '@/components/checkout/PaymentOptions';
import HoldCountdown from '@/components/checkout/HoldCountdown';
import RoutePicker, { type TransferRouteSelection } from '@/components/transfer/RoutePicker';
import TransferGuestDetailsForm, {
  type FlightDetailsRequirement,
} from '@/components/transfer/TransferGuestDetailsForm';
import TransferTypePicker, {
  TRANSFER_TYPE_PICKER_ID,
} from '@/components/transfer/TransferTypePicker';
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
 * Task T14, rebuilt 2026-11-08 for the flexible places/routes/vehicle-types
 * model (owner decision 2026-11-08; see
 * `docs/superpowers/plans/2026-11-08-flexible-routes.md`). The guest-facing
 * transfer booking flow, modelled directly on `CheckoutPage.tsx`'s own shape
 * (local selection state, one price query per vehicle option, a
 * coupon/consent/pay-mode dance, and a success swap to `<PaymentOptions>`).
 * This page owns every tRPC call the presentational components
 * (`TransferTypePicker`, `RoutePicker`, `VehicleOptionCard`,
 * `TransferGuestDetailsForm`) do not make themselves.
 *
 * **What changed from the old `van`/`suv` build, and why it had to.**
 * Vehicle types are now an admin-managed list of arbitrary size, and a route
 * is FROM one admin-managed place TO another rather than "airport ↔ one
 * fixed destination" — so this page can no longer hard-code "exactly two
 * vehicle queries" or "one destination name per route":
 *
 *  - **Route selection is a `(routeId, direction)` pair**
 *    (`RoutePicker`'s `TransferRouteSelection`), never a bare `routeId`. When
 *    a route's `reverseEnabled` is true, `RoutePicker` offers the SAME route
 *    id travelled the other way as a second selectable row — this page does
 *    not fabricate a second route, it only carries whichever `direction` the
 *    guest picked straight through to `createHoldTransferInput.direction`.
 *    **This is the one field on the hold input that decides correctness,
 *    not cosmetics**: the quote input (`quoteTransferInput`) has no
 *    `direction` field at all (price and duration do not change by
 *    direction), so only the HOLD payload carries it.
 *  - **Vehicle pricing is a dynamic-length query set**, one `quoteTransfer`
 *    per vehicle type the SELECTED ROUTE actually offers
 *    (`route.vehiclePrices`, already filtered server-side to "priced AND
 *    sellable" — design note §4, this page renders exactly what it is given
 *    and never re-filters). `trpc.useQueries` is used instead of a fixed
 *    pair of named `useQuery` calls, because the count of offered types is
 *    not known until the route is chosen and the Rules of Hooks forbid
 *    calling a variable number of `useQuery` hooks directly.
 *  - **Flight fields have three states — required, optional-but-shown, or
 *    hidden** (`flightDetailsRequirement` below, owner decision 3,
 *    2026-11-09, narrowing owner decision 5 from 2026-11-08). **This IS
 *    direction-dependent**, unlike the superseded 2026-11-08 rule: which of
 *    the route's two places is the PICKUP flips with `direction` (forward
 *    reads `fromPlace`, reverse reads `toPlace`), and only the pickup
 *    being an airport makes the fields required — a drop-off-only airport
 *    makes them merely optional, and neither being an airport hides them
 *    entirely. See `TransferGuestDetailsForm.tsx`'s own header for the full
 *    three-state contract this page resolves into.
 *
 * **The day-use "from ₱X" decision (brief, flow step 1), generalized.**
 * `RoutePicker` has no `productType` prop and always shows the cheapest
 * OFFERED vehicle type's one-way rate (its own fixed contract). On a
 * day-use selection that figure would be the wrong number for the product
 * actually being priced, so `displayRoutes` below swaps every offered
 * type's `dayUsePriceCentavos` into the `oneWayPriceCentavos` slot of a
 * per-render COPY of the route list whenever `productType ===
 * 'transfer_day_use'` — `RoutePicker`'s own "from " label names no unit, so
 * the swapped figure reads correctly with no component change.
 *
 * **A bad coupon must not be mistaken for an unavailable vehicle** (carried
 * over from the original T14 review, Critical 1, generalized to N vehicle
 * types). `quoteTransfer` validates the coupon BEFORE pricing, so a
 * bad/expired code throws the SAME refusal on every offered vehicle's query
 * at once — distinct from a route/vehicle-shape refusal (no price row for
 * one vehicle type), which can only ever hit ONE query. `allQuotesErroring`
 * below is exactly that discriminator: only when `couponCode` is set AND
 * every offered vehicle's query is erroring simultaneously does the effect
 * treat the failure as the coupon's, surface the server's own sentence
 * beside `CouponField`, and revert to a coupon-free quote.
 *
 * **A placeholder (stale) quote must render as loading, never as a
 * selectable but outdated price** (carried over, Critical 2).
 * `keepPreviousData` is scoped to the WHOLE query key, which includes
 * `productType` — so switching one-way → day-use without this would keep
 * showing a card's one-way total, still clickable, until the day-use quote
 * resolves. Each card's `isLoading` therefore reads `isPending ||
 * isPlaceholderData`, not `isPending` alone.
 *
 * This page makes no separate vehicle-type request. Every vehicle type a
 * guest can see is already resolved onto `route.vehiclePrices` (id, display
 * name, both prices) by `transferRoutes.list` itself, so a second request
 * would duplicate data this page already has and invite the two lists to
 * disagree about what "offered" means. (The standalone public
 * `vehicleTypes.list` procedure this comment used to name was removed —
 * owner decision 2026-11-09, decision 4 — as confirmed-unused; the admin
 * `admin.vehicleTypes.*` router is unrelated.)
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
 * `CheckoutPage.tsx`'s `PLACED_HOLD_FIELDS`. Every field here genuinely has
 * a box on screen (the pickers take `productType`/`routeId`/`direction`/
 * `vehicleTypeId`, `CouponField` takes `couponCode`, and
 * `TransferGuestDetailsForm` takes the rest) — so `unplacedFieldMessages`
 * below is expected to stay empty in practice. It is kept anyway as the
 * same defensive leftover-catcher `CheckoutPage` uses, so a field added to
 * the schema later without a matching box still surfaces somewhere rather
 * than vanishing silently.
 */
const PLACED_HOLD_FIELDS: ReadonlySet<string> = new Set([
  'productType',
  'routeId',
  'direction',
  'vehicleTypeId',
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

/**
 * Task 1F (DEMO POLISH). Mirrors `components/home/CatalogPreview.tsx`'s
 * identical guard: jsdom (this project's test environment) implements no
 * `window.matchMedia` at all and throws if called unstubbed, so this checks
 * the function exists before ever calling it.
 */
function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

export default function TransferBookingPage() {
  const [searchParams] = useSearchParams();

  const [productType, setProductType] = useState<TransferProductType | null>(() =>
    readInitialProductType(searchParams.get('productType')),
  );
  const [routeId, setRouteId] = useState<number | null>(() =>
    readInitialRouteId(searchParams.get('routeId')),
  );
  const [direction, setDirection] = useState<TransferDirection>('forward');
  const [vehicleTypeId, setVehicleTypeId] = useState<number | null>(null);
  const [payMode, setPayMode] = useState<PayMode>('deposit');

  const [couponCode, setCouponCode] = useState<string | undefined>(undefined);
  const [couponInput, setCouponInput] = useState('');
  const [couponError, setCouponError] = useState<string | null>(null);
  const [consentError, setConsentError] = useState<string | null>(null);

  /**
   * Task 1F (DEMO POLISH). A guest can click a route card before picking a
   * transfer type above it — natural top-to-bottom reading avoids this, but
   * nothing stopped it. The route selection itself is kept either way (set
   * below in `RoutePicker`'s `onChange`, unconditionally): `routeId` and
   * `productType` are independent pieces of state and `vehiclePricingEnabled`
   * already requires both, so a route picked early just waits, already
   * selected, for the type to catch up — the least surprising behaviour,
   * and the one that costs the guest nothing if they pick type second.
   * This hint rides through `TransferTypePicker`'s existing `error` prop
   * (already wired to its own `FieldError`) rather than inventing new UI,
   * and is cleared the instant a type IS selected (see the effect below).
   */
  const [routeBeforeTypeHint, setRouteBeforeTypeHint] = useState<string | null>(null);

  useEffect(() => {
    if (productType) setRouteBeforeTypeHint(null);
  }, [productType]);

  const routesQuery = trpc.transferRoutes.list.useQuery();

  /*
   * See this file's own header note. A per-render copy, never a mutation of
   * `routesQuery.data` — a type absent from `vehiclePrices` stays absent in
   * the copy, exactly mirroring the server's own "not offered" absence
   * (never guessed at, never backfilled with a null placeholder).
   */
  const displayRoutes = useMemo<TransferRoutePublicRow[]>(() => {
    const routes = routesQuery.data ?? [];
    if (productType !== 'transfer_day_use') return routes;
    return routes.map((route) => ({
      ...route,
      vehiclePrices: route.vehiclePrices.map((price) => ({
        ...price,
        oneWayPriceCentavos: price.dayUsePriceCentavos,
      })),
    }));
  }, [routesQuery.data, productType]);

  const selectedRoute = useMemo(
    () => displayRoutes.find((route) => route.id === routeId) ?? null,
    [displayRoutes, routeId],
  );

  /**
   * Owner decision 3, 2026-11-09, narrowing decision 5 from 2026-11-08.
   * **Direction-DEPENDENT** — which place is pickup flips with `direction`
   * (forward: `fromPlace`; reverse: `toPlace`), unlike the superseded rule
   * this replaces, which read both places regardless of direction. No
   * route selected yet → `'hidden'`, matching `requiresFlightDetails`'s old
   * `false` default (fields do not render until a route exists to ask).
   */
  const flightDetailsRequirement: FlightDetailsRequirement = (() => {
    if (!selectedRoute) return 'hidden';
    const pickupIsAirport =
      direction === 'forward' ? selectedRoute.fromPlace.isAirport : selectedRoute.toPlace.isAirport;
    const dropoffIsAirport =
      direction === 'forward' ? selectedRoute.toPlace.isAirport : selectedRoute.fromPlace.isAirport;
    if (pickupIsAirport) return 'required';
    if (dropoffIsAirport) return 'optional';
    return 'hidden';
  })();

  const vehicleOptions = selectedRoute?.vehiclePrices ?? [];
  const vehiclePricingEnabled = productType !== null && routeId !== null;

  /*
   * One `quoteTransfer` per OFFERED vehicle type on the selected route —
   * see this file's header note on why `useQueries` replaces the old fixed
   * `vanQuote`/`suvQuote` pair. Results come back in the SAME order as
   * `vehicleOptions`, so `quoteResults[i]` always answers for
   * `vehicleOptions[i]`.
   */
  const quoteResults = trpc.useQueries((t) =>
    vehicleOptions.map((option) =>
      t.checkout.quoteTransfer(
        {
          routeId: routeId ?? 0,
          vehicleTypeId: option.vehicleTypeId,
          productType: productType ?? 'transfer_one_way',
          couponCode,
        },
        { enabled: vehiclePricingEnabled, retry: false, placeholderData: keepPreviousData },
      ),
    ),
  );

  /*
   * The last CONFIRMED (non-placeholder) successful quote per vehicle type,
   * for the CURRENT `routeId`/`productType` only — reset the instant either
   * changes, so a value from a different route or product can never be
   * offered as anyone's fallback. See this file's header note (Critical 1):
   * when a bad coupon makes every offered vehicle's query settle to
   * `isError`, each `data` becomes `undefined` for one render before the
   * coupon-recovery effect below clears `couponCode` — without a fallback,
   * `selectedQuote` would go `undefined` for that render, unmounting
   * `<TransferGuestDetailsForm>` and destroying every uncontrolled field the
   * guest had already typed.
   */
  const [lastGoodQuotes, setLastGoodQuotes] = useState<Record<number, QuoteTransferResult>>({});

  useEffect(() => {
    setLastGoodQuotes({});
  }, [routeId, productType]);

  useEffect(() => {
    setLastGoodQuotes((prev) => {
      let changed = false;
      const next = { ...prev };
      vehicleOptions.forEach((option, index) => {
        const result = quoteResults[index];
        if (
          result &&
          result.isSuccess &&
          !result.isPlaceholderData &&
          next[option.vehicleTypeId] !== result.data
        ) {
          next[option.vehicleTypeId] = result.data;
          changed = true;
        }
      });
      return changed ? next : prev;
    });
  }, [vehicleOptions, quoteResults]);

  /** Every offered vehicle's query is erroring at once — the coupon signature, not a per-vehicle shape refusal. */
  const allQuotesErroring =
    quoteResults.length > 0 && quoteResults.every((result) => result.isError);

  /*
   * Critical 1 fix, generalized — see this file's header note. Fires only
   * when a coupon is applied AND every offered vehicle's query is erroring
   * at the SAME time, which is what a bad/expired coupon looks like (it
   * fails validation identically for every vehicle type) and a
   * route/vehicle-shape refusal (no price row for one vehicle) never does.
   * The first query's error is read as the representative message — a
   * coupon refusal is deterministic across every vehicle, so they never
   * actually disagree.
   */
  useEffect(() => {
    if (couponCode && allQuotesErroring) {
      const representative = quoteResults[0];
      setCouponError(
        firstValidationMessage(representative?.error) ??
          describeCheckoutError(representative?.error),
      );
      setCouponCode(undefined);
    }
  }, [couponCode, allQuotesErroring, quoteResults]);

  /*
   * `undefined` on either an in-flight load OR a settled error that is NOT a
   * transient coupon self-heal — the one card state `VehicleOptionCard`
   * renders for both (see its own note). While a coupon is applied and THIS
   * query is anything other than settled-successful, this falls back to
   * `lastGoodQuotes` instead of `undefined` — see Critical 1.
   *
   * **Keyed on "not successful", not "errored" (fix found during this
   * rebuild's own testing).** Measured directly, not assumed: re-keying a
   * `trpc.useQueries` entry's query (changing `couponCode` here) can settle
   * through a genuine `isPending: true` render for that entry — NOT an
   * `isPlaceholderData` one — before it reaches `isError`, even though
   * `placeholderData: keepPreviousData` is set on every entry. Gating the
   * fallback on `result.isError` alone left that intermediate `isPending`
   * render with `selectedQuote: undefined` for one frame, unmounting
   * `<TransferGuestDetailsForm>` and wiping every uncontrolled field the
   * guest had typed — the exact failure Critical 1 exists to prevent,
   * reachable again through a gap `isError` alone didn't cover. Checking
   * `!result.isSuccess` closes it regardless of which non-final state the
   * query is passing through.
   *
   * **Still correctly scoped to "a coupon is applied".** A vehicle with no
   * price row at all (genuinely unavailable, coupon or not) is unaffected:
   * it has no entry in `lastGoodQuotes` to fall back to, coupon applied or
   * not, so it still renders "not available" — see the "permanently
   * unavailable vehicle" test. And with NO coupon applied, this still
   * returns `undefined` exactly as before, so `VehicleOptionCard`'s own
   * loading/unavailable states are unchanged for the common case.
   */
  function quoteFor(typeId: number): QuoteTransferResult | undefined {
    const index = vehicleOptions.findIndex((option) => option.vehicleTypeId === typeId);
    if (index === -1) return undefined;
    const result = quoteResults[index];
    if (!result) return undefined;
    if (result.isSuccess) return result.data;
    if (couponCode) {
      return lastGoodQuotes[typeId];
    }
    return undefined;
  }

  const selectedQuote = vehicleTypeId !== null ? quoteFor(vehicleTypeId) : undefined;

  /*
   * A selected vehicle type that the newly chosen route/product no longer
   * offers is cleared rather than left pointing at nothing — `vehicleOptions`
   * is a dynamic set now (never a fixed `{van, suv}` pair that both always
   * existed), so a route swap can genuinely drop the previously selected
   * type. Direction is deliberately NOT in this dependency list: flipping
   * direction keeps the same `routeId` and therefore the same
   * `vehicleOptions`, so the guest's vehicle choice should survive it.
   */
  useEffect(() => {
    setVehicleTypeId(null);
  }, [routeId, productType]);

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
    if (!productType || !routeId || !vehicleTypeId) return;

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
      vehicleTypeId,
      direction,
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

  const routeSelection: TransferRouteSelection | null =
    routeId !== null ? { routeId, direction } : null;

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
            error={holdFieldErrors?.productType ?? routeBeforeTypeHint ?? undefined}
          />

          <RoutePicker
            routes={displayRoutes}
            value={routeSelection}
            onChange={(selection) => {
              setRouteId(selection.routeId);
              setDirection(selection.direction);
              if (!productType) {
                setRouteBeforeTypeHint('Choose a transfer type above first');
                document.getElementById(TRANSFER_TYPE_PICKER_ID)?.scrollIntoView({
                  behavior: prefersReducedMotion() ? 'auto' : 'smooth',
                  block: 'center',
                });
              }
            }}
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
                isChecking={Boolean(couponCode) && quoteResults.some((result) => result.isFetching)}
              />

              {vehicleOptions.length === 0 ? (
                <p className="text-muted-foreground text-sm" role="status">
                  No vehicles are available for this route right now. Please check back later or
                  contact us directly.
                </p>
              ) : (
                <div className="grid gap-3 sm:grid-cols-2">
                  {vehicleOptions.map((option, index) => {
                    const result = quoteResults[index];
                    return (
                      <VehicleOptionCard
                        key={option.vehicleTypeId}
                        vehicleTypeId={option.vehicleTypeId}
                        vehicleTypeName={option.vehicleTypeName}
                        quote={quoteFor(option.vehicleTypeId)}
                        isLoading={Boolean(result?.isPending || result?.isPlaceholderData)}
                        isSelected={vehicleTypeId === option.vehicleTypeId}
                        onSelect={() => setVehicleTypeId(option.vehicleTypeId)}
                        payMode={payMode}
                        error={holdFieldErrors?.vehicleTypeId}
                      />
                    );
                  })}
                </div>
              )}
            </>
          )}

          {vehicleTypeId !== null && productType !== null && selectedQuote && (
            <>
              <TransferGuestDetailsForm
                productType={productType}
                payMode={payMode}
                onPayModeChange={setPayMode}
                amountDueNowCentavos={selectedQuote.amountDueNowCentavos}
                flightDetailsRequirement={flightDetailsRequirement}
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
