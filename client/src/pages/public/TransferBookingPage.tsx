import { keepPreviousData } from '@tanstack/react-query';
import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  formatPeso,
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
import FieldError from '@/components/common/FieldError';
import TurnstileWidget from '@/components/common/TurnstileWidget';
import RoutePicker, { type TransferRouteSelection } from '@/components/transfer/RoutePicker';
import TransferGuestDetailsForm, {
  type FlightDetailsRequirement,
} from '@/components/transfer/TransferGuestDetailsForm';
import TransferTypePicker, {
  TRANSFER_TYPE_PICKER_ID,
} from '@/components/transfer/TransferTypePicker';
import VehicleOptionCard from '@/components/transfer/VehicleOptionCard';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
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
 * **`pax`/`luggageCount` live here, as page-level state, not as fields
 * inside `TransferGuestDetailsForm`** (owner decision 2026-11-18,
 * per-person pricing plan, Task 5/2E). They render between `RoutePicker`
 * and the vehicle-option grid — a per-person route's price, and the
 * seat-fit check against each option's `defaultSeats`, both need a head
 * count before a vehicle is even chosen, so `pax` has to exist before this
 * page's `quoteTransfer` queries can run. Submitted the same way
 * `routeId`/`direction`/`vehicleTypeId` already are: merged directly from
 * state into the hold payload in `handleSubmit`, never read back off
 * `FormData` (there is no need to — the state IS the value).
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

/**
 * Task 7 (1D): general `direction` URL support, so a deep link can
 * preselect which way a reversible route is travelled, not only which
 * route. Anything other than the literal `'reverse'` — missing, malformed,
 * or any other string — reads as `'forward'`, the same permissive default
 * `readInitialProductType`/`readInitialRouteId` use for their own bad input.
 */
function readInitialDirection(raw: string | null): TransferDirection {
  return raw === 'reverse' ? 'reverse' : 'forward';
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
  'ferryVesselName',
  'ferryArrivalTime',
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

/** Ids for the page-level Passengers/Luggage fields' error messages — see this file's header note. */
const PAGE_PAX_ERROR_ID = 'transfer-page-pax-error';
const PAGE_LUGGAGE_ERROR_ID = 'transfer-page-luggage-count-error';

export default function TransferBookingPage() {
  const [searchParams] = useSearchParams();

  const [productType, setProductType] = useState<TransferProductType | null>(() =>
    readInitialProductType(searchParams.get('productType')),
  );
  const [routeId, setRouteId] = useState<number | null>(() =>
    readInitialRouteId(searchParams.get('routeId')),
  );
  const [direction, setDirection] = useState<TransferDirection>(() =>
    readInitialDirection(searchParams.get('direction')),
  );
  const [vehicleTypeId, setVehicleTypeId] = useState<number | null>(null);
  const [payMode, setPayMode] = useState<PayMode>('deposit');
  /**
   * Lifted from `TransferGuestDetailsForm` (owner decision 2026-11-18,
   * per-person pricing plan) — see this file's header note.
   */
  const [pax, setPax] = useState(1);
  const [luggageCount, setLuggageCount] = useState(0);

  const [couponCode, setCouponCode] = useState<string | undefined>(undefined);
  const [couponInput, setCouponInput] = useState('');
  const [couponError, setCouponError] = useState<string | null>(null);
  const [consentError, setConsentError] = useState<string | null>(null);
  const [turnstileToken, setTurnstileToken] = useState<string | undefined>(undefined);
  // A Turnstile token is single-use — bump this to remount the widget (and
  // get a fresh one) after any failed attempt, not only a Turnstile refusal.
  const [turnstileResetKey, setTurnstileResetKey] = useState(0);

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
      direction === 'forward'
        ? selectedRoute.fromPlace.placeType === 'airport'
        : selectedRoute.toPlace.placeType === 'airport';
    const dropoffIsAirport =
      direction === 'forward'
        ? selectedRoute.toPlace.placeType === 'airport'
        : selectedRoute.fromPlace.placeType === 'airport';
    if (pickupIsAirport) return 'required';
    if (dropoffIsAirport) return 'optional';
    return 'hidden';
  })();

  /**
   * Direction-dependent the same way `flightDetailsRequirement` is above —
   * the PICKUP place flips with `direction` — but a plain boolean, since
   * ferry details are never required (owner spec, 1E): always optional,
   * shown only when the pickup is a pier.
   */
  const ferryDetailsVisible =
    selectedRoute !== null &&
    (direction === 'forward'
      ? selectedRoute.fromPlace.placeType
      : selectedRoute.toPlace.placeType) === 'pier';

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
          pax,
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
    /*
     * **Deliberately NOT `pax` here (disclosed deviation from this task's
     * brief, owner decision 2026-11-18).** The brief's own text asks for
     * `pax` to join `routeId`/`productType` in this dependency list,
     * "mirroring the existing routeId/productType reset" — but that mirror
     * is exactly what breaks: a `routeId`/`productType` change ALSO resets
     * `vehicleTypeId` to `null` (the effect below), which makes
     * `selectedQuote` moot before `quoteFor`'s fallback is ever consulted
     * for the selected vehicle. `pax` resets neither — the whole point of
     * lifting it here is that the guest's already-selected vehicle survives
     * a passenger-count edit — so clearing this map the instant `pax`
     * changes removes the ONLY thing standing between a transient
     * non-success render (re-keying `quoteTransfer` on `pax`, same
     * measured-not-assumed one-tick gap `quoteFor`'s own note documents for
     * a coupon change) and `<TransferGuestDetailsForm>` unmounting and
     * wiping every field the guest already typed — reproduced directly by
     * writing this task's own re-query test. Leaving `pax` out keeps this
     * map's entries alive across a pax edit so `quoteFor`'s (now
     * unconditional, see its own note) fallback can serve the last good
     * quote for exactly as long as the new pax's quote takes to resolve —
     * self-healing the instant it does, via the merge effect below.
     */
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
   * transient self-heal — the one card state `VehicleOptionCard` renders
   * for both (see its own note). Whenever THIS query is anything other than
   * settled-successful, this falls back to `lastGoodQuotes` instead of
   * `undefined` — see Critical 1.
   *
   * **Keyed on "not successful", not "errored" (fix found during this
   * rebuild's own testing).** Measured directly, not assumed: re-keying a
   * `trpc.useQueries` entry's query (changing `couponCode`, or — owner
   * decision 2026-11-18 — changing `pax`) can settle through a genuine
   * `isPending: true` render for that entry — NOT an `isPlaceholderData`
   * one — before it reaches success or error, even though
   * `placeholderData: keepPreviousData` is set on every entry. Gating the
   * fallback on `result.isError` alone left that intermediate `isPending`
   * render with `selectedQuote: undefined` for one frame, unmounting
   * `<TransferGuestDetailsForm>` and wiping every uncontrolled field the
   * guest had typed — the exact failure Critical 1 exists to prevent,
   * reachable again through a gap `isError` alone didn't cover. Checking
   * `!result.isSuccess` closes it regardless of which non-final state the
   * query is passing through.
   *
   * **No longer gated on "a coupon is applied" (owner decision 2026-11-18,
   * widened from Critical 1's original scope).** A `pax` edit re-keys every
   * offered vehicle's query exactly the same way a coupon edit does, and
   * the selected vehicle's form must survive that transition too — see the
   * `lastGoodQuotes` reset effect's own note on why `pax` is deliberately
   * NOT one of the triggers that clears this map, which is what makes an
   * unconditional fallback here safe rather than a route/product mix-up.
   * A vehicle with no price row at all (genuinely unavailable) is
   * unaffected either way: it has no entry in `lastGoodQuotes` to fall back
   * to, so it still renders "not available" — see the "permanently
   * unavailable vehicle" test.
   */
  function quoteFor(typeId: number): QuoteTransferResult | undefined {
    const index = vehicleOptions.findIndex((option) => option.vehicleTypeId === typeId);
    if (index === -1) return undefined;
    const result = quoteResults[index];
    if (!result) return undefined;
    if (result.isSuccess) return result.data;
    return lastGoodQuotes[typeId];
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

  const createHoldTransfer = trpc.checkout.createHoldTransfer.useMutation({
    onError: () => {
      setTurnstileToken(undefined);
      setTurnstileResetKey((key) => key + 1);
    },
  });

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
      pax,
      luggageCount,
      pickup: optionalField(data, 'pickup'),
      pickupMapUrl: optionalField(data, 'pickupMapUrl'),
      dropoffAddress: String(data.get('dropoffAddress') ?? ''),
      dropoffMapUrl: optionalField(data, 'dropoffMapUrl'),
      flightNumber: optionalField(data, 'flightNumber'),
      airline: optionalField(data, 'airline'),
      ferryVesselName: optionalField(data, 'ferryVesselName'),
      ferryArrivalTime: optionalField(data, 'ferryArrivalTime'),
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
      turnstileToken,
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
              {/*
               * Passengers/Luggage — lifted here from `TransferGuestDetailsForm`
               * (owner decision 2026-11-18, per-person pricing plan; see this
               * file's header note). Rendered between the route picker and the
               * vehicle-option cards, matching the plan's mockup: a per-person
               * route's price, and each option's seat-fit check, both need a
               * head count before a vehicle is even chosen.
               */}
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label htmlFor="transfer-pax">Passengers</Label>
                  <Input
                    id="transfer-pax"
                    type="number"
                    min={1}
                    max={30}
                    required
                    value={pax}
                    onChange={(e) => setPax(Number(e.target.value))}
                    aria-describedby={holdFieldErrors?.pax ? PAGE_PAX_ERROR_ID : undefined}
                    aria-invalid={holdFieldErrors?.pax ? true : undefined}
                    className="tap-target"
                  />
                  <FieldError id={PAGE_PAX_ERROR_ID} message={holdFieldErrors?.pax} />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="transfer-luggage-count">Luggage (bags)</Label>
                  <Input
                    id="transfer-luggage-count"
                    type="number"
                    min={0}
                    max={200}
                    required
                    value={luggageCount}
                    onChange={(e) => setLuggageCount(Number(e.target.value))}
                    aria-describedby={
                      holdFieldErrors?.luggageCount ? PAGE_LUGGAGE_ERROR_ID : undefined
                    }
                    aria-invalid={holdFieldErrors?.luggageCount ? true : undefined}
                    className="tap-target"
                  />
                  <FieldError id={PAGE_LUGGAGE_ERROR_ID} message={holdFieldErrors?.luggageCount} />
                </div>
              </div>

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
                    const isLoadingOption = Boolean(result?.isPending || result?.isPlaceholderData);
                    const quote = quoteFor(option.vehicleTypeId);
                    /*
                     * Owner decision 2026-11-18 (per-person pricing plan,
                     * Decision 6): a vehicle the party doesn't fit stays
                     * VISIBLE and disabled, with a reason — never silently
                     * removed from the list. Seat cap is checked first, so a
                     * party too big for this vehicle sees "Seats up to N"
                     * rather than the generic "Not available for this
                     * route" the undefined-quote branch would also produce
                     * (the server itself refuses the same quote once pax
                     * exceeds the cap, so both branches would otherwise
                     * agree on "unavailable" — this just picks the more
                     * useful of the two sentences).
                     */
                    const unavailableReason: string | null = isLoadingOption
                      ? null
                      : option.defaultSeats !== null && pax > option.defaultSeats
                        ? `Seats up to ${option.defaultSeats}`
                        : quote === undefined
                          ? 'Not available for this route'
                          : null;
                    return (
                      <VehicleOptionCard
                        key={option.vehicleTypeId}
                        vehicleTypeId={option.vehicleTypeId}
                        vehicleTypeName={option.vehicleTypeName}
                        vehicleTypeSlug={option.slug}
                        quote={quote}
                        isLoading={isLoadingOption}
                        isSelected={vehicleTypeId === option.vehicleTypeId}
                        onSelect={() => setVehicleTypeId(option.vehicleTypeId)}
                        payMode={payMode}
                        unavailableReason={unavailableReason}
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
              {/*
               * Owner decision 2026-11-18 (per-person pricing plan). Every
               * figure here is a server field, never a client multiplication
               * — `unitPrice` is the catalog's own already-known per-person
               * rate (a display of a known rate, not a computed total), and
               * `paxCharged`/`subtotalCentavos` come straight off the quote.
               * A `per_vehicle` route renders nothing extra here: its total/
               * due-now figures already show unchanged on the selected
               * `VehicleOptionCard` and the pay-mode radios below.
               */}
              {selectedQuote.pricingMode === 'per_person' &&
                (() => {
                  const selectedOption = vehicleOptions.find(
                    (option) => option.vehicleTypeId === vehicleTypeId,
                  );
                  if (!selectedOption) return null;
                  // `selectedOption` comes from `vehicleOptions`, which is
                  // read off `displayRoutes` — this file's own `useMemo`
                  // already swapped `dayUsePriceCentavos` into this same
                  // `oneWayPriceCentavos` slot whenever `productType ===
                  // 'transfer_day_use'`, so this is always the correct
                  // per-head catalog rate for whichever product is active.
                  const unitPriceCentavos = selectedOption.oneWayPriceCentavos;
                  return (
                    <p className="text-brand-blue-900 text-sm font-semibold">
                      {formatPeso(unitPriceCentavos)} × {selectedQuote.paxCharged} pax ={' '}
                      {formatPeso(selectedQuote.subtotalCentavos)}
                    </p>
                  );
                })()}

              <TransferGuestDetailsForm
                productType={productType}
                payMode={payMode}
                onPayModeChange={setPayMode}
                amountDueNowCentavos={selectedQuote.amountDueNowCentavos}
                flightDetailsRequirement={flightDetailsRequirement}
                ferryDetailsVisible={ferryDetailsVisible}
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

              {/*
               * Renders nothing when Turnstile is not configured (local dev,
               * or switched off) — see the component's own note. Remounted
               * via `key` after any failed submit, since a token is
               * single-use.
               */}
              <TurnstileWidget
                key={turnstileResetKey}
                onVerify={setTurnstileToken}
                onError={() => setTurnstileToken(undefined)}
              />

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
