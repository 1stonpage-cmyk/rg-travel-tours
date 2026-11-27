import { keepPreviousData } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { AlertTriangle } from 'lucide-react';
import { Link, useSearchParams } from 'react-router-dom';
import {
  createHoldTransferInput,
  formatPeso,
  quoteTransferInput,
  reverseTransferRouteSlug,
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
import ErrorSummary, { type ErrorSummaryItem } from '@/components/common/ErrorSummary';
import FieldError from '@/components/common/FieldError';
import TurnstileWidget from '@/components/common/TurnstileWidget';
import RoutePicker, {
  ROUTE_PICKER_ID,
  type TransferRouteSelection,
} from '@/components/transfer/RoutePicker';
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
import { WhatsAppGlyph } from '@/components/common/BrandGlyphs';
import { trackEvent } from '@/lib/consent/scripts';
import {
  clientSideErrors,
  firstValidationMessage,
  getFieldErrors,
  getFormErrors,
  getNestedFieldError,
  hasAnyNestedFieldError,
} from '@/lib/field-errors';
import { describeCheckoutError } from '@/lib/mutation-errors';
import { scrollToAndFocus } from '@/lib/scroll-to-field';
import { cn } from '@/lib/utils';
import { whatsappLink } from '@/lib/site';
import { TRANSFER_PRODUCT_TYPE_LABELS } from '@/lib/transfer-product-labels';
import { trpc } from '@/lib/trpc';
import { buildWithDetailsMessage } from '@/lib/whatsapp-message';

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
 * every offered vehicle that COULD have answered is erroring simultaneously
 * does the effect treat the failure as the coupon's, surface the server's
 * own sentence beside `CouponField`, and revert to a coupon-free quote.
 *
 * **"Could have answered" is load-bearing, and is the correction the final
 * whole-branch review made (Finding 1).** This branch introduced two
 * refusals that also hit every vehicle at once and are not the coupon's
 * fault — the universal seat cap (`pax` over a vehicle type's
 * `defaultSeats`, which on a single-vehicle route is trivially "every
 * vehicle") and a `pax` outside the quote input's own bounds (clearing the
 * Passengers box makes it `0`). Taking the vote over ALL the results let
 * either of those delete a coupon the guest had applied and pin someone
 * else's sentence on it. `couponCandidateResults` below therefore excludes
 * the vehicles whose refusal the browser can already explain for itself.
 *
 * **A placeholder (stale) quote must render as loading, never as a
 * selectable but outdated price** (carried over, Critical 2; narrowed back
 * to that exact claim by the final review's Finding 2 — see `quoteFor`).
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

/**
 * Bug 1A fix: `/transfers/:slug`'s "Book this transfer" CTA used to link to
 * `/transfer?routeId=<id>&direction=<dir>` with no `productType` at all, so
 * the route arrived preselected but the Airport Transfer product type never
 * did — and the whole date/pax/vehicle/guest section stays hidden on
 * `vehiclePricingEnabled` (`productType !== null && routeId !== null`) below
 * until a guest re-picks a type by hand. That CTA now sends `productType`
 * too (`TransferRoutePage.tsx`), but this reads a `routeId` as the signal to
 * default `productType` defensively, for any other caller — present or
 * future — that forgets the param the same way. Only "routeId present,
 * productType absent/invalid" gets the new default: a URL with no `routeId`
 * at all keeps falling through to `null`, same as before.
 */
function readInitialProductType(
  rawProductType: string | null,
  rawRouteId: string | null,
): TransferProductType | null {
  if (rawProductType && (TRANSFER_PRODUCT_TYPES as readonly string[]).includes(rawProductType)) {
    return rawProductType as TransferProductType;
  }
  return readInitialRouteId(rawRouteId) !== null ? 'transfer_one_way' : null;
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
 * `vehicleTypeId`, `CouponField` takes `couponCode`, this page's own
 * Passengers/Luggage block takes `pax`/`luggageCount` — page-level state
 * merged straight into the hold payload since Task 5, not form fields
 * `TransferGuestDetailsForm` owns any more — and that form takes the rest of
 * the guest-detail fields) — so `unplacedFieldMessages`
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

/** The vehicle-option grid's own id, so Task 6's scroll+focus has a target for `vehicleTypeId` (no literal `<input>` to focus — a grid of cards). */
const VEHICLE_GRID_ID = 'transfer-vehicle-grid';

/**
 * Task 6 — client-side pre-submit validation against `createHoldTransferInput`,
 * the transfer counterpart of `CheckoutPage.tsx`'s own `FIELD_LABELS`/
 * `FIELD_ORDER`/`FIELD_IDS`/`buildErrorSummaryItems`. See that file's header
 * note on why `payMode`/`consent` (and here, `productType`/`routeId`/
 * `vehicleTypeId`, each guarded by `handleSubmit`'s own early return) are
 * kept out of `FIELD_ORDER` even though a label exists for them — they
 * cannot actually carry a client-side message by the time a payload is
 * built, so there is nothing for the summary to show.
 */
const FIELD_LABELS: Record<string, string> = {
  productType: 'Transfer type',
  routeId: 'Route',
  pax: 'Passengers',
  luggageCount: 'Luggage',
  date: 'Pickup date',
  pickupTime: 'Pickup time',
  dayUseEndTime: 'Vehicle needed until',
  pickup: 'Pickup location',
  pickupMapUrl: 'Pickup Google Maps pin',
  dropoffAddress: 'Drop-off address',
  dropoffMapUrl: 'Drop-off Google Maps pin',
  flightNumber: 'Flight number',
  airline: 'Airline',
  ferryVesselName: 'Ferry / vessel name',
  ferryArrivalTime: 'Ferry arrival time',
  requests: 'Special requests',
  couponCode: 'Coupon code',
  'lead.name': 'Full name',
  'lead.email': 'Email',
  'lead.phone': 'WhatsApp / mobile number',
  vehicleTypeId: 'Vehicle',
};
/** Field order on screen, top to bottom — the summary and the scroll target both follow it. */
const FIELD_ORDER = [
  'productType',
  'routeId',
  'pax',
  'luggageCount',
  'date',
  'pickupTime',
  'dayUseEndTime',
  'pickup',
  'pickupMapUrl',
  'dropoffAddress',
  'dropoffMapUrl',
  'flightNumber',
  'airline',
  'ferryVesselName',
  'ferryArrivalTime',
  'requests',
  'lead.name',
  'lead.email',
  'lead.phone',
  'vehicleTypeId',
];
/** Maps a dot-path to the invalid control's (or picker's) own id, for scroll+focus. */
const FIELD_IDS: Record<string, string> = {
  productType: TRANSFER_TYPE_PICKER_ID,
  routeId: ROUTE_PICKER_ID,
  pax: 'transfer-pax',
  luggageCount: 'transfer-luggage-count',
  date: 'transfer-date',
  pickupTime: 'transfer-pickup-time',
  dayUseEndTime: 'transfer-day-use-end-time',
  pickup: 'transfer-pickup',
  pickupMapUrl: 'transfer-pickup-map',
  dropoffAddress: 'transfer-dropoff-address',
  dropoffMapUrl: 'transfer-dropoff-map',
  flightNumber: 'transfer-flight-number',
  airline: 'transfer-airline',
  ferryVesselName: 'transfer-ferry-vessel-name',
  ferryArrivalTime: 'transfer-ferry-arrival-time',
  requests: 'transfer-requests',
  'lead.name': 'transfer-name',
  'lead.email': 'transfer-email',
  'lead.phone': 'transfer-phone',
  vehicleTypeId: VEHICLE_GRID_ID,
};

function buildErrorSummaryItems(error: unknown): ErrorSummaryItem[] {
  const items: ErrorSummaryItem[] = [];
  for (const path of FIELD_ORDER) {
    const message = path.includes('.')
      ? getNestedFieldError(error, path)
      : (getFieldErrors(error)?.[path] ?? null);
    const id = FIELD_IDS[path];
    if (message && id) items.push({ id, label: FIELD_LABELS[path] ?? path, message });
  }
  return items;
}

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
/** The minimum-paying-passengers note's own id — see `minPayingPaxNote` below. */
const PAGE_MIN_PAX_NOTE_ID = 'transfer-page-min-paying-pax';

/**
 * Owner decision 2026-11-18 (per-person pricing plan, Decision 6), shared by
 * the per-option `unavailableReason` computation below, the vehicle-reset
 * effect, and the submit-time guard — one formula, so the three can never
 * disagree about what "over capacity" means.
 */
function isOverSeatCap(defaultSeats: number | null, currentPax: number): boolean {
  return defaultSeats !== null && currentPax > defaultSeats;
}

/**
 * Is this head count one `checkout.quoteTransfer` will even accept?
 *
 * Asked of the REAL input schema's own `pax` field rather than against two
 * numbers copied over here (final whole-branch review, Finding 1) — a
 * duplicated `1`/`30` pair would answer this question differently from the
 * server the day either bound moves. The one caller that matters is the
 * coupon-recovery discriminator below: a `pax` the wire refuses is a refusal
 * about the Passengers box, never about the code the guest typed. It is
 * reachable from the box itself — `Number('')` is `0`, so clearing it to
 * retype a number passes through an out-of-bounds value every time.
 */
function isQuotablePax(currentPax: number): boolean {
  return quoteTransferInput.shape.pax.safeParse(currentPax).success;
}

export default function TransferBookingPage() {
  const [searchParams] = useSearchParams();

  const [productType, setProductType] = useState<TransferProductType | null>(() =>
    readInitialProductType(searchParams.get('productType'), searchParams.get('routeId')),
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
  /** Task 6 — see `CheckoutPage.tsx`'s identical `preSubmitError` note. */
  const [preSubmitError, setPreSubmitError] = useState<unknown>(null);
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

  /*
   * `begin_booking` (Task 12, SEO fixes, 2026-11-24) — fired once per visit,
   * the instant `productType` first becomes non-null, never again on a
   * later re-render or re-selection. A `hasFiredRef` guard (same shape
   * `FloatingWhatsApp.tsx`'s own one-shot pulse uses, minus the
   * cross-reload `sessionStorage` persistence that component needs and this
   * one-mount event does not) rather than an effect dependency alone,
   * because `productType` toggling between two non-null values must NOT
   * re-fire this. `productType` itself carries no personal data, so it is
   * the one param worth sending.
   *
   * Deliberately also fires on first mount when a deep link already sets
   * `?productType=...` (read into the initial `useState` above) — that is
   * still "booking begun", just begun by a link instead of a click.
   */
  const hasFiredBeginBookingRef = useRef(false);
  useEffect(() => {
    if (productType && !hasFiredBeginBookingRef.current) {
      hasFiredBeginBookingRef.current = true;
      trackEvent('begin_booking', { productType });
    }
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
  /**
   * Why the pax count in the total can exceed the one the guest typed
   * (final whole-branch review, Finding 5).
   *
   * The server already charges `max(pax, minPayingPax)` on a per-person
   * route and the summary line already shows that figure — "₱800 × 2 pax =
   * ₱1,600" for a party of one — but nothing said WHY. This is copy only:
   * the number comes from the route, nothing is computed here, and the note
   * disappears the moment the typed party reaches the minimum.
   *
   * Gated on `per_person` as well as on the number, deliberately. A
   * `per_vehicle` route can still carry a `min_paying_pax` above 1 — the
   * column is independent, and `mergeTransferRoutePatch()` keeps the stored
   * value when an admin switches a route back to per-vehicle without
   * mentioning it — and on such a route the sentence would be actively
   * false, because a flat rate charges for no particular number of heads.
   */
  const minPayingPaxNote =
    selectedRoute !== null &&
    selectedRoute.pricingMode === 'per_person' &&
    selectedRoute.minPayingPax > 1 &&
    pax < selectedRoute.minPayingPax
      ? `This route has a minimum of ${selectedRoute.minPayingPax} paying passengers, ` +
        `so the total charges for ${selectedRoute.minPayingPax}.`
      : null;

  const ferryDetailsVisible =
    selectedRoute !== null &&
    (direction === 'forward'
      ? selectedRoute.fromPlace.placeType
      : selectedRoute.toPlace.placeType) === 'pier';

  const vehicleOptions = selectedRoute?.vehiclePrices ?? [];
  const vehiclePricingEnabled = productType !== null && routeId !== null;

  /**
   * Whether the typed head count is one the quote procedure can answer at
   * all — see `isQuotablePax`. Read by the `enabled` gate below and by the
   * coupon discriminator further down, so the two cannot disagree.
   */
  const paxQuotable = isQuotablePax(pax);

  /*
   * One `quoteTransfer` per OFFERED vehicle type on the selected route —
   * see this file's header note on why `useQueries` replaces the old fixed
   * `vanQuote`/`suvQuote` pair. Results come back in the SAME order as
   * `vehicleOptions`, so `quoteResults[i]` always answers for
   * `vehicleOptions[i]`.
   *
   * **A query the client already knows the server will refuse is never
   * sent** (final whole-branch review, bundled fix B): a vehicle the typed
   * party cannot fit (`defaultSeats` says so, the same number the server
   * caps on) and a `pax` outside the input's own bounds both refuse on every
   * keystroke and every retry, for reasons the browser can see without
   * asking. Not sending them costs the guest nothing — the seat-capped card
   * renders its own "Seats up to N" reason without a quote, and an
   * unquotable `pax` is a half-typed number — and it keeps a doomed,
   * permanently-`isError` result from standing in for a real answer in the
   * two places that read these results collectively (the coupon
   * discriminator and `quoteFor`'s fallback).
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
        {
          enabled: vehiclePricingEnabled && paxQuotable && !isOverSeatCap(option.defaultSeats, pax),
          retry: false,
          placeholderData: keepPreviousData,
        },
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
     * map's entries alive across a pax edit so `quoteFor`'s fallback (no
     * longer gated on a coupon, but no longer covering a SETTLED error
     * either — see its own note, final review Finding 2) can serve the last
     * good quote for exactly as long as the new pax's quote takes to
     * resolve — self-healing the instant it does, via the merge effect
     * below.
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

  /**
   * The queries whose refusal could actually BE the coupon's (final
   * whole-branch review, Finding 1).
   *
   * "Every offered vehicle is erroring at once" was a sound coupon
   * signature while a bad coupon was the ONLY thing that could refuse every
   * vehicle simultaneously. This branch added two more, neither of them the
   * coupon's fault: the universal seat cap — trivially "every vehicle" on a
   * single-vehicle route — and a `pax` the quote input itself refuses. So
   * the vehicles whose refusal the browser can already explain are excluded
   * from the vote, instead of the vote being taken over all of them:
   *
   *  - an out-of-bounds `pax` disqualifies EVERY vehicle at once (nothing
   *    can answer the coupon question while the head count is unusable), and
   *  - a seat-capped vehicle disqualifies only itself, so a route with one
   *    fitting vehicle and one over-capacity one still reports a genuinely
   *    bad coupon rather than going quiet.
   *
   * These are the same questions the `enabled` gate above asks, deliberately
   * re-asked here rather than inferred from the results: a disqualified
   * query is idle, and "idle" must not read as "it answered".
   */
  const couponCandidateResults = paxQuotable
    ? quoteResults.filter((_result, index) => {
        const option = vehicleOptions[index];
        return option !== undefined && !isOverSeatCap(option.defaultSeats, pax);
      })
    : [];

  /** Every vehicle that COULD have answered is erroring at once — the coupon signature. */
  const allQuotesErroring =
    couponCandidateResults.length > 0 && couponCandidateResults.every((result) => result.isError);

  /*
   * Critical 1 fix, generalized — see this file's header note. Fires only
   * when a coupon is applied AND every offered vehicle that could answer is
   * erroring at the SAME time, which is what a bad/expired coupon looks
   * like (it fails validation identically for every vehicle type) and a
   * route/vehicle-shape refusal (no price row for one vehicle) never does.
   * The first candidate's error is read as the representative message — a
   * coupon refusal is deterministic across every vehicle, so they never
   * actually disagree.
   */
  useEffect(() => {
    if (couponCode && allQuotesErroring) {
      const representative = couponCandidateResults[0];
      setCouponError(
        firstValidationMessage(representative?.error) ??
          describeCheckoutError(representative?.error),
      );
      setCouponCode(undefined);
    }
  }, [couponCode, allQuotesErroring, couponCandidateResults]);

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
   * **Not gated on "a coupon is applied" for the IN-FLIGHT case (owner
   * decision 2026-11-18, widened from Critical 1's original scope).** A
   * `pax` edit re-keys every offered vehicle's query exactly the same way a
   * coupon edit does, and the selected vehicle's form must survive that
   * transition too — see the `lastGoodQuotes` reset effect's own note on why
   * `pax` is deliberately NOT one of the triggers that clears this map,
   * which is what makes a fallback here safe rather than a route/product
   * mix-up. A vehicle with no price row at all (genuinely unavailable) is
   * unaffected either way: it has no entry in `lastGoodQuotes` to fall back
   * to, so it still renders "not available" — see the "permanently
   * unavailable vehicle" test.
   *
   * **But a SETTLED error ends the fallback (final whole-branch review,
   * Finding 2).** The widening above covered one state too many. `retry:
   * false` means an `isError` result will not resolve on its own: nothing is
   * in flight, there is no newer answer coming, and serving the last good
   * quote there publishes a stale price as a current, selectable one —
   * exactly what this file's header forbids. So the fallback now covers
   * only "not settled yet" (pending or placeholder), plus the one settled
   * case that genuinely self-heals: a coupon refusal, which the effect above
   * answers by dropping `couponCode`, re-keying every query within a render
   * or two. Once no coupon is applied, a settled error means unavailable,
   * full stop.
   */
  function quoteFor(typeId: number): QuoteTransferResult | undefined {
    const index = vehicleOptions.findIndex((option) => option.vehicleTypeId === typeId);
    if (index === -1) return undefined;
    const result = quoteResults[index];
    if (!result) return undefined;
    if (result.isSuccess) return result.data;
    if (result.isError && !couponCode) return undefined;
    return lastGoodQuotes[typeId];
  }

  const selectedQuote = vehicleTypeId !== null ? quoteFor(vehicleTypeId) : undefined;

  /**
   * The selected vehicle's own catalog row — also read by the per-person
   * summary line below (its unit rate), so this is computed once and
   * shared rather than re-looked-up in two places (review fix, Minor
   * finding: a plain variable over an inline IIFE).
   */
  const selectedOption =
    vehicleTypeId !== null
      ? vehicleOptions.find((option) => option.vehicleTypeId === vehicleTypeId)
      : undefined;

  /**
   * Review fix (Important finding #2, same decision as the effect below):
   * defense in depth, not a substitute for it. The effect above clears
   * `vehicleTypeId` the instant the selection becomes seat-capped, which
   * already makes `selectedQuote` `undefined` on the very next render — but
   * React runs effects AFTER the render that triggered them, so this guard
   * catches the one render in between (and anything else that might select
   * an already-over-capacity option) by re-deriving the same seat-cap
   * question the options loop below answers for every card, instead of
   * trusting that the effect has already run.
   */
  const selectedVehicleSeatCapped = isOverSeatCap(selectedOption?.defaultSeats ?? null, pax);

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

  /**
   * Review fix (Important finding #2, per-person pricing plan review,
   * 2026-11-18): a `pax` RAISE that pushes the already-selected vehicle over
   * its own `defaultSeats` must deselect it, the same way a `routeId`/
   * `productType` change already does above — otherwise the guest can fill
   * out the entire guest-details form against a stale, now-contradictory
   * total and only be refused by the server at submit time. Deliberately a
   * SEPARATE effect from the one above (not merged into its dependency
   * array): that effect's job is "the vehicle this route even offers
   * changed", this one's is "the vehicle offered is still the same, but no
   * longer fits" — different trigger, same `setVehicleTypeId(null)` action.
   * Guarded on `vehicleTypeId !== null` so it is a no-op once nothing is
   * selected, which is what keeps it from looping: clearing the selection
   * makes `selectedOption` undefined on the next run, after which
   * `isOverSeatCap` is never consulted again until something is reselected.
   */
  useEffect(() => {
    if (vehicleTypeId === null) return;
    const selectedOption = vehicleOptions.find((option) => option.vehicleTypeId === vehicleTypeId);
    if (selectedOption && isOverSeatCap(selectedOption.defaultSeats, pax)) {
      setVehicleTypeId(null);
    }
  }, [pax, vehicleOptions, vehicleTypeId]);

  const createHoldTransfer = trpc.checkout.createHoldTransfer.useMutation({
    // `hold_created` (Task 12) — a mutation's `onSuccess` fires exactly once
    // per successful mutation by construction, so no ref/effect guard is
    // needed here. `ref` only — never `lead`/email/phone (CLAUDE.md).
    onSuccess: (data) => {
      trackEvent('hold_created', { ref: data.ref });
    },
    onError: () => {
      setTurnstileToken(undefined);
      setTurnstileResetKey((key) => key + 1);
    },
  });

  /*
   * Task 6 — see `CheckoutPage.tsx`'s identical block for the full note on
   * `activeError`: a pre-submit client-side refusal (`preSubmitError`) takes
   * priority over the mutation's own, and every read below degrades to
   * exactly what it was before this task once both are `null`.
   */
  const activeError =
    preSubmitError ?? (createHoldTransfer.isError ? createHoldTransfer.error : null);
  const holdFieldErrors = getFieldErrors(activeError);
  const holdFormErrors = getFormErrors(activeError);
  const leadGroupUnresolved =
    (holdFieldErrors?.lead ?? undefined) !== undefined &&
    !hasAnyNestedFieldError(activeError, LEAD_LEAF_PATHS);
  const unplacedFieldMessages = Object.entries(holdFieldErrors ?? {})
    .filter(
      ([field]) => !PLACED_HOLD_FIELDS.has(field) || (field === 'lead' && leadGroupUnresolved),
    )
    .map(([, message]) => message);
  const isValidationRefusal = holdFieldErrors !== null || holdFormErrors.length > 0;
  const holdBannerMessages =
    activeError === null
      ? []
      : isValidationRefusal
        ? [...holdFormErrors, ...unplacedFieldMessages]
        : [describeCheckoutError(activeError)];

  function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!productType || !routeId || !vehicleTypeId) return;

    const form = e.currentTarget;
    const data = new FormData(form);

    if (data.get('consent') !== 'on') {
      createHoldTransfer.reset();
      setPreSubmitError(null);
      setConsentError(
        'Please agree to the data privacy consent above before we can hold your spot (RA 10173).',
      );
      return;
    }
    setConsentError(null);

    const payload = {
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
    };

    /*
     * Task 6 — see `CheckoutPage.tsx`'s identical block for the full note.
     * Same payload, same schema the server enforces, before the mutation
     * ever fires.
     */
    const validationError = clientSideErrors(createHoldTransferInput, payload);
    if (validationError) {
      createHoldTransfer.reset();
      setPreSubmitError(validationError);
      const firstItem = buildErrorSummaryItems(validationError)[0];
      if (firstItem) scrollToAndFocus(firstItem.id);
      return;
    }
    setPreSubmitError(null);
    createHoldTransfer.mutate(payload);
  }

  const routeSelection: TransferRouteSelection | null =
    routeId !== null ? { routeId, direction } : null;

  /*
   * "Prefer to chat? Ask on WhatsApp" (owner spec, 2026-11-28, Task 1C) —
   * filled in from whatever the guest has typed so far. `pax`/`luggageCount`/
   * `productType`/`routeId`/`direction`/`vehicleTypeId` are all page-level
   * React state already; `date` and `pickup` live as plain uncontrolled
   * inputs inside `TransferGuestDetailsForm` (no second source of truth
   * added here just for this link), so `formRef` reads them straight off the
   * DOM at the moment the token values are built.
   */
  const formRef = useRef<HTMLFormElement>(null);
  const settingsQuery = trpc.settings.get.useQuery();

  function whatsappTokenValues() {
    const data = formRef.current ? new FormData(formRef.current) : null;
    const routeName =
      selectedRoute && direction === 'forward'
        ? `${selectedRoute.fromPlace.name} to ${selectedRoute.toPlace.name}`
        : selectedRoute
          ? `${selectedRoute.toPlace.name} to ${selectedRoute.fromPlace.name}`
          : '';
    const otherVehicles = vehicleOptions
      .filter((option) => option.vehicleTypeId !== vehicleTypeId)
      .map((option) => option.vehicleTypeName);
    const vehicleValue = selectedOption
      ? otherVehicles.length > 0
        ? `${selectedOption.vehicleTypeName} (also send me the price for ${otherVehicles.join(' and ')})`
        : selectedOption.vehicleTypeName
      : '';
    return {
      route: routeName,
      trip: productType ? TRANSFER_PRODUCT_TYPE_LABELS[productType] : '',
      date: String(data?.get('date') ?? ''),
      passengers: vehiclePricingEnabled ? String(pax) : '',
      bags: vehiclePricingEnabled ? String(luggageCount) : '',
      vehicle: vehicleValue,
      pickup: String(data?.get('pickup') ?? ''),
    };
  }

  const whatsappHref = whatsappLink(
    buildWithDetailsMessage(
      settingsQuery.data?.whatsappMessage.withDetails ?? '',
      whatsappTokenValues(),
    ),
  );

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
          <PaymentOptions bookingRef={createHoldTransfer.data.ref} justHeld />
          <HoldCountdown expiresAt={createHoldTransfer.data.holdExpiresAt} />
        </div>
      ) : (
        <form
          ref={formRef}
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
                  <div className="relative">
                    <Input
                      id="transfer-pax"
                      type="number"
                      min={1}
                      max={30}
                      required
                      value={pax}
                      onChange={(e) => setPax(Number(e.target.value))}
                      aria-describedby={
                        [
                          holdFieldErrors?.pax ? PAGE_PAX_ERROR_ID : null,
                          minPayingPaxNote ? PAGE_MIN_PAX_NOTE_ID : null,
                        ]
                          .filter(Boolean)
                          .join(' ') || undefined
                      }
                      aria-invalid={holdFieldErrors?.pax ? true : undefined}
                      className={cn(
                        'tap-target',
                        holdFieldErrors?.pax && 'border-brand-warning pr-9',
                      )}
                    />
                    {holdFieldErrors?.pax && (
                      <AlertTriangle
                        aria-hidden="true"
                        className="text-brand-warning pointer-events-none absolute right-3 top-1/2 size-4 -translate-y-1/2"
                      />
                    )}
                  </div>
                  <FieldError id={PAGE_PAX_ERROR_ID} message={holdFieldErrors?.pax} />
                  {/*
                   * Finding 5 — the same `text-muted-foreground text-xs`
                   * hint shape `TransferGuestDetailsForm` already uses for
                   * its "this trip touches the airport" line, not a new
                   * visual pattern.
                   */}
                  {minPayingPaxNote && (
                    <p id={PAGE_MIN_PAX_NOTE_ID} className="text-muted-foreground text-xs">
                      {minPayingPaxNote}
                    </p>
                  )}
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="transfer-luggage-count">Luggage (bags)</Label>
                  <div className="relative">
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
                      className={cn(
                        'tap-target',
                        holdFieldErrors?.luggageCount && 'border-brand-warning pr-9',
                      )}
                    />
                    {holdFieldErrors?.luggageCount && (
                      <AlertTriangle
                        aria-hidden="true"
                        className="text-brand-warning pointer-events-none absolute right-3 top-1/2 size-4 -translate-y-1/2"
                      />
                    )}
                  </div>
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
                <div id={VEHICLE_GRID_ID} className="grid gap-3 sm:grid-cols-2">
                  {vehicleOptions.map((option, index) => {
                    const result = quoteResults[index];
                    /*
                     * Owner decision 2026-11-18 (per-person pricing plan,
                     * Decision 6): a vehicle the party doesn't fit stays
                     * VISIBLE and disabled, with a reason — never silently
                     * removed from the list. Seat cap is checked BEFORE the
                     * loading state, not after (final whole-branch review,
                     * bundled fix B): this option's query is not sent at all
                     * while the party is over its cap, which leaves the
                     * result sitting on `keepPreviousData`'s placeholder —
                     * i.e. reading as "loading" forever — so a capped card
                     * would show an endless skeleton instead of the reason
                     * the guest needs. Checking the cap first also picks the
                     * more useful of two true sentences: the server refuses
                     * the same quote once pax exceeds the cap, so the
                     * undefined-quote branch would otherwise say the vaguer
                     * "Not available for this route".
                     */
                    const seatCapped = isOverSeatCap(option.defaultSeats, pax);
                    const isLoadingOption =
                      !seatCapped && Boolean(result?.isPending || result?.isPlaceholderData);
                    const quote = quoteFor(option.vehicleTypeId);
                    const unavailableReason: string | null = seatCapped
                      ? `Seats up to ${option.defaultSeats}`
                      : isLoadingOption
                        ? null
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

          {vehicleTypeId !== null &&
            productType !== null &&
            selectedQuote &&
            !selectedVehicleSeatCapped && (
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
                {/*
                 * `selectedOption` (computed once, above, and shared with
                 * the seat-cap guard) comes from `vehicleOptions`, which is
                 * read off `displayRoutes` — this file's own `useMemo`
                 * already swapped `dayUsePriceCentavos` into this same
                 * `oneWayPriceCentavos` slot whenever `productType ===
                 * 'transfer_day_use'`, so `oneWayPriceCentavos` is always
                 * the correct per-head catalog rate for whichever product
                 * is active.
                 */}
                {selectedQuote.pricingMode === 'per_person' && selectedOption && (
                  <p className="text-brand-blue-900 text-sm font-semibold">
                    {formatPeso(selectedOption.oneWayPriceCentavos)} × {selectedQuote.paxCharged}{' '}
                    pax = {formatPeso(selectedQuote.subtotalCentavos)}
                  </p>
                )}

                <TransferGuestDetailsForm
                  productType={productType}
                  payMode={payMode}
                  onPayModeChange={setPayMode}
                  amountDueNowCentavos={selectedQuote.amountDueNowCentavos}
                  flightDetailsRequirement={flightDetailsRequirement}
                  ferryDetailsVisible={ferryDetailsVisible}
                  error={activeError}
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

                <ErrorSummary items={buildErrorSummaryItems(activeError)} />

                <Button
                  type="submit"
                  size="lg"
                  className="tap-target w-full"
                  disabled={createHoldTransfer.isPending}
                >
                  {createHoldTransfer.isPending ? 'Holding your spot…' : 'Book now, hold my spot'}
                </Button>

                {/*
                 * "Prefer to chat? Ask on WhatsApp" (owner spec, 2026-11-28,
                 * Task 1C). `type="button"` — never a submit, and outside
                 * `handleSubmit`'s own validation. Brand-colour exception
                 * (CLAUDE.md): the circle is icon-only/decorative, the
                 * visible wording sits outside it in brand ink. The href is
                 * refreshed on click (`onClick`, synchronously, before the
                 * browser follows it) so `date`/`pickup` — plain uncontrolled
                 * inputs above, not page state — are read at the moment the
                 * guest actually taps rather than from a stale render.
                 */}
                <p className="text-center">
                  <a
                    href={whatsappHref}
                    target="_blank"
                    rel="noreferrer noopener"
                    onClick={(event) => {
                      event.currentTarget.href = whatsappLink(
                        buildWithDetailsMessage(
                          settingsQuery.data?.whatsappMessage.withDetails ?? '',
                          whatsappTokenValues(),
                        ),
                      );
                    }}
                    className="text-brand-ink tap-target inline-flex min-h-11 items-center gap-2 text-sm font-semibold"
                  >
                    <span
                      aria-hidden="true"
                      className="bg-whatsapp hover:bg-whatsapp-pressed flex size-9 shrink-0 items-center justify-center rounded-full text-white transition-colors"
                    >
                      <WhatsAppGlyph className="size-4" />
                    </span>
                    Prefer to chat? Ask on WhatsApp
                  </a>
                </p>
              </>
            )}
        </form>
      )}

      {/*
       * Task 9, Step 7 (SEO fixes, 2026-11-24) — "All transfer routes": one
       * plain link per FORWARD slug, plus (only where `reverseEnabled`) a
       * second link per derived reverse slug. Reads `routesQuery.data`
       * directly, never `displayRoutes` — that copy's day-use price swap is
       * irrelevant to a plain route-link list.
       */}
      {routesQuery.data && routesQuery.data.length > 0 && (
        <section className="mt-12 border-t pt-8">
          <h2 className="text-brand-blue-900 text-lg font-bold">All transfer routes</h2>
          <ul className="mt-3 grid gap-2 sm:grid-cols-2">
            {routesQuery.data.map((route) => (
              <li key={route.id}>
                <Link
                  to={`/transfers/${route.slug}`}
                  className="text-brand-blue-700 underline underline-offset-2"
                >
                  {route.fromPlace.name} to {route.toPlace.name}
                </Link>
                {route.reverseEnabled && (
                  <>
                    {' · '}
                    <Link
                      to={`/transfers/${reverseTransferRouteSlug(route.slug)}`}
                      className="text-brand-blue-700 underline underline-offset-2"
                    >
                      {route.toPlace.name} to {route.fromPlace.name}
                    </Link>
                  </>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
