import { formatPeso, type PayMode, type TransferProductType } from '@rg/shared';
import ConsentCheckbox from '@/components/checkout/ConsentCheckbox';
import FieldError from '@/components/common/FieldError';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { getFieldErrors, getNestedFieldError } from '@/lib/field-errors';
import { cn } from '@/lib/utils';

/**
 * Task T13 — every field `createHoldTransferInput` (`@rg/shared`,
 * `shared/src/transfers-checkout.ts`) needs beyond `productType`/`routeId`/
 * `vehicleType`, which the three sibling pickers already capture. Modelled
 * directly on `client/src/components/checkout/GuestDetails.tsx` — same
 * uncontrolled-input-read-via-`FormData` convention, same `FieldError`/
 * `aria-describedby` wiring, same `getNestedFieldError` treatment for
 * `lead.*` (BUG-120: `lead` is a nested object, so its three leaves need the
 * dot-path reader, never the grouped `fieldErrors.lead` message split three
 * ways).
 *
 * This component owns no `<form>` tag and no submit button — exactly like
 * `GuestDetails.tsx` — so it is meant to be rendered inside the page's own
 * `<form>` (`TransferBookingPage.tsx`, Task T14), which reads every
 * uncontrolled field off `FormData` on submit.
 *
 * **`dayUseEndTime` is hidden entirely on a one-way request, and
 * `flightNumber`/`airline` are hidden entirely on a day-use one** — not a
 * display nicety, `createHoldTransferInput`'s `superRefine` REFUSES each on
 * the wrong product type, so showing a box the schema will reject is worse
 * than not showing it.
 *
 * **`flightNumber`/`airline` have THREE states, keyed off `flightDetailsRequirement`
 * (owner decision 3, 2026-11-09, narrowing owner decision 5 from
 * 2026-11-08 — see `docs/superpowers/plans/2026-11-08-flexible-routes.md`
 * §2/§6 item 4b and the 2026-11-09 decision log):**
 *
 *  - `'required'` — the guest's PICKUP place is an airport. Fields render,
 *    `required`, no "(optional)" suffix, and the airport banner shows.
 *  - `'optional'` — only the DROP-OFF is an airport. Fields still render
 *    (a guest may still volunteer flight details), but are not `required`
 *    and keep their "(optional)" suffix; no banner.
 *  - `'hidden'` — neither place is an airport. The whole flight-details
 *    block does not render at all on a one-way transfer.
 *
 * **This narrows the 2026-11-08 rule**, which required the fields whenever
 * EITHER end of the route was an airport, regardless of which one was the
 * pickup, and which always rendered the fields on a one-way transfer
 * (never `'hidden'`). Which place counts as "pickup" depends on
 * `direction` — `TransferBookingPage.tsx` resolves that before computing
 * this prop; this component only ever sees the already-resolved
 * three-state answer, never `direction` or the route itself.
 *
 * **This is UX polish, not the control**: `createTransferBooking()`
 * enforces the authoritative REQUIRED/optional half of this rule
 * server-side, after resolving the route (it needs the resolved route's
 * two places and the pickup's direction, which this Zod layer does not
 * have) — see that function's own note and `createHoldTransferInput`'s doc
 * comment on why the check cannot live in Zod. The `'hidden'` half is
 * UX-only through and through: the server never refuses a submitted
 * flight number/airline on a non-airport route, it simply has nowhere to
 * require them from.
 *
 * **Consent.** `ConsentCheckbox` is reused as-is. Unlike `CheckoutPage.tsx`
 * (which renders it as a SIBLING of `GuestDetails` and keeps its own local
 * "please tick before submitting" pre-check state), this component's fixed
 * `error` prop carries only the mutation's raw rejection — there is no
 * channel back to a page-owned pre-check state, and this component owns no
 * `<form>`/submit handler to block on anyway. A guest who submits unticked
 * still gets a correct, worded refusal: `createHoldTransferInput.consent`'s
 * own `.refine()` message ("Consent is required") arrives through `error`
 * exactly like every other field's, one round trip later rather than
 * instantly. `onChange` is therefore a no-op here — there is no local state
 * to clear — kept only because `ConsentCheckbox` requires the prop.
 */

/**
 * Whether flight fields are required, optional-but-shown, or hidden
 * entirely — see this file's header note. Owner decision 3, 2026-11-09.
 */
export type FlightDetailsRequirement = 'required' | 'optional' | 'hidden';

type Props = {
  /** Decides whether `dayUseEndTime` vs `flightNumber`/`airline` render. */
  productType: TransferProductType;
  payMode: PayMode;
  onPayModeChange: (mode: PayMode) => void;
  /** From the SELECTED vehicle's quote — same contract as `GuestDetails.tsx`. */
  amountDueNowCentavos: { full: number; deposit: number };
  /**
   * The already-resolved three-state answer for the SELECTED route and
   * DIRECTION (owner decision 3, 2026-11-09) — see this file's header
   * note. `TransferBookingPage.tsx` is where `direction` and the route's
   * two places actually get turned into one of `'required'`/`'optional'`/
   * `'hidden'`; this component takes the answer, never the inputs.
   */
  flightDetailsRequirement: FlightDetailsRequirement;
  /** `createHoldTransfer`'s raw rejection, read via `field-errors.ts`. */
  error?: unknown;
};

const PAY_MODE_ORDER: readonly PayMode[] = ['deposit', 'full'];
const PAY_MODE_LABELS: Record<PayMode, string> = {
  deposit: 'Pay 30% deposit',
  full: 'Pay in full',
};

/** The ids the inputs name in `aria-describedby`, one spelling per pairing. */
const LEAD_NAME_ERROR_ID = 'transfer-name-error';
const LEAD_EMAIL_ERROR_ID = 'transfer-email-error';
const LEAD_PHONE_ERROR_ID = 'transfer-phone-error';
const DATE_ERROR_ID = 'transfer-date-error';
const PICKUP_TIME_ERROR_ID = 'transfer-pickup-time-error';
const DAY_USE_END_TIME_ERROR_ID = 'transfer-day-use-end-time-error';
const PAX_ERROR_ID = 'transfer-pax-error';
const LUGGAGE_ERROR_ID = 'transfer-luggage-count-error';
const PICKUP_ERROR_ID = 'transfer-pickup-error';
const PICKUP_MAP_ERROR_ID = 'transfer-pickup-map-error';
const DROPOFF_ADDRESS_ERROR_ID = 'transfer-dropoff-address-error';
const DROPOFF_MAP_ERROR_ID = 'transfer-dropoff-map-error';
const FLIGHT_NUMBER_ERROR_ID = 'transfer-flight-number-error';
const AIRLINE_ERROR_ID = 'transfer-airline-error';
const REQUESTS_ERROR_ID = 'transfer-requests-error';
const PAY_MODE_ERROR_ID = 'transfer-pay-mode-error';

export default function TransferGuestDetailsForm({
  productType,
  payMode,
  onPayModeChange,
  amountDueNowCentavos,
  flightDetailsRequirement,
  error,
}: Props) {
  const leadNameError = getNestedFieldError(error, 'lead.name');
  const leadEmailError = getNestedFieldError(error, 'lead.email');
  const leadPhoneError = getNestedFieldError(error, 'lead.phone');
  const fieldErrors = getFieldErrors(error);
  const dateError = fieldErrors?.date;
  const pickupTimeError = fieldErrors?.pickupTime;
  const dayUseEndTimeError = fieldErrors?.dayUseEndTime;
  const paxError = fieldErrors?.pax;
  const luggageCountError = fieldErrors?.luggageCount;
  const pickupError = fieldErrors?.pickup;
  const pickupMapError = fieldErrors?.pickupMapUrl;
  const dropoffAddressError = fieldErrors?.dropoffAddress;
  const dropoffMapError = fieldErrors?.dropoffMapUrl;
  const flightNumberError = fieldErrors?.flightNumber;
  const airlineError = fieldErrors?.airline;
  const requestsError = fieldErrors?.requests;
  const payModeError = fieldErrors?.payMode;
  const consentError = fieldErrors?.consent;

  const isDayUse = productType === 'transfer_day_use';
  const isOneWay = productType === 'transfer_one_way';

  return (
    <div className="space-y-5">
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="transfer-date">Pickup date</Label>
          <Input
            id="transfer-date"
            name="date"
            type="date"
            required
            aria-describedby={dateError ? DATE_ERROR_ID : undefined}
            aria-invalid={dateError ? true : undefined}
            className="tap-target"
          />
          <FieldError id={DATE_ERROR_ID} message={dateError} />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="transfer-pickup-time">Pickup time</Label>
          <Input
            id="transfer-pickup-time"
            name="pickupTime"
            type="time"
            required
            aria-describedby={pickupTimeError ? PICKUP_TIME_ERROR_ID : undefined}
            aria-invalid={pickupTimeError ? true : undefined}
            className="tap-target"
          />
          <FieldError id={PICKUP_TIME_ERROR_ID} message={pickupTimeError} />
        </div>
      </div>

      {/* Day-use only — a one-way request is refused if this field is sent at all. */}
      {isDayUse && (
        <div className="space-y-1.5">
          <Label htmlFor="transfer-day-use-end-time">Vehicle needed until</Label>
          <Input
            id="transfer-day-use-end-time"
            name="dayUseEndTime"
            type="time"
            required
            aria-describedby={dayUseEndTimeError ? DAY_USE_END_TIME_ERROR_ID : undefined}
            aria-invalid={dayUseEndTimeError ? true : undefined}
            className="tap-target"
          />
          <FieldError id={DAY_USE_END_TIME_ERROR_ID} message={dayUseEndTimeError} />
        </div>
      )}

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="transfer-pax">Passengers</Label>
          <Input
            id="transfer-pax"
            name="pax"
            type="number"
            min={1}
            max={30}
            required
            aria-describedby={paxError ? PAX_ERROR_ID : undefined}
            aria-invalid={paxError ? true : undefined}
            className="tap-target"
          />
          <FieldError id={PAX_ERROR_ID} message={paxError} />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="transfer-luggage-count">Bags</Label>
          <Input
            id="transfer-luggage-count"
            name="luggageCount"
            type="number"
            min={0}
            max={200}
            required
            aria-describedby={luggageCountError ? LUGGAGE_ERROR_ID : undefined}
            aria-invalid={luggageCountError ? true : undefined}
            className="tap-target"
          />
          <FieldError id={LUGGAGE_ERROR_ID} message={luggageCountError} />
        </div>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="transfer-pickup">Pickup location (optional)</Label>
        <Input
          id="transfer-pickup"
          name="pickup"
          maxLength={400}
          aria-describedby={pickupError ? PICKUP_ERROR_ID : undefined}
          aria-invalid={pickupError ? true : undefined}
          className="tap-target"
        />
        <FieldError id={PICKUP_ERROR_ID} message={pickupError} />
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="transfer-pickup-map">Pickup Google Maps pin (optional)</Label>
        <Input
          id="transfer-pickup-map"
          name="pickupMapUrl"
          type="url"
          maxLength={500}
          placeholder="https://maps.google.com/..."
          aria-describedby={pickupMapError ? PICKUP_MAP_ERROR_ID : undefined}
          aria-invalid={pickupMapError ? true : undefined}
          className="tap-target"
        />
        <FieldError id={PICKUP_MAP_ERROR_ID} message={pickupMapError} />
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="transfer-dropoff-address">Drop-off address</Label>
        <Input
          id="transfer-dropoff-address"
          name="dropoffAddress"
          required
          maxLength={400}
          aria-describedby={dropoffAddressError ? DROPOFF_ADDRESS_ERROR_ID : undefined}
          aria-invalid={dropoffAddressError ? true : undefined}
          className="tap-target"
        />
        <FieldError id={DROPOFF_ADDRESS_ERROR_ID} message={dropoffAddressError} />
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="transfer-dropoff-map">Drop-off Google Maps pin (optional)</Label>
        <Input
          id="transfer-dropoff-map"
          name="dropoffMapUrl"
          type="url"
          maxLength={500}
          placeholder="https://maps.google.com/..."
          aria-describedby={dropoffMapError ? DROPOFF_MAP_ERROR_ID : undefined}
          aria-invalid={dropoffMapError ? true : undefined}
          className="tap-target"
        />
        <FieldError id={DROPOFF_MAP_ERROR_ID} message={dropoffMapError} />
      </div>

      {/*
       * One-way only — a day-use request is refused if either field is
       * sent. On a one-way transfer, the whole block is additionally
       * hidden when `flightDetailsRequirement === 'hidden'` (neither place
       * is an airport) — see this file's header note, owner decision 3.
       */}
      {isOneWay && flightDetailsRequirement !== 'hidden' && (
        <div className="space-y-2">
          {flightDetailsRequirement === 'required' && (
            <p className="text-muted-foreground text-xs">
              This trip touches the airport, so please share your flight details.
            </p>
          )}
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="transfer-flight-number">
                Flight number{flightDetailsRequirement === 'optional' && ' (optional)'}
              </Label>
              <Input
                id="transfer-flight-number"
                name="flightNumber"
                maxLength={20}
                required={flightDetailsRequirement === 'required'}
                aria-describedby={flightNumberError ? FLIGHT_NUMBER_ERROR_ID : undefined}
                aria-invalid={flightNumberError ? true : undefined}
                className="tap-target"
              />
              <FieldError id={FLIGHT_NUMBER_ERROR_ID} message={flightNumberError} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="transfer-airline">
                Airline{flightDetailsRequirement === 'optional' && ' (optional)'}
              </Label>
              <Input
                id="transfer-airline"
                name="airline"
                maxLength={80}
                required={flightDetailsRequirement === 'required'}
                aria-describedby={airlineError ? AIRLINE_ERROR_ID : undefined}
                aria-invalid={airlineError ? true : undefined}
                className="tap-target"
              />
              <FieldError id={AIRLINE_ERROR_ID} message={airlineError} />
            </div>
          </div>
        </div>
      )}

      <div className="space-y-1.5">
        <Label htmlFor="transfer-requests">Special requests (optional)</Label>
        <textarea
          id="transfer-requests"
          name="requests"
          rows={3}
          maxLength={2000}
          aria-describedby={requestsError ? REQUESTS_ERROR_ID : undefined}
          aria-invalid={requestsError ? true : undefined}
          className="border-input bg-background focus-visible:ring-ring w-full rounded-md border px-3 py-2 text-base focus-visible:outline-none focus-visible:ring-2 md:text-sm"
        />
        <FieldError id={REQUESTS_ERROR_ID} message={requestsError} />
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="transfer-name">Full name</Label>
        <Input
          id="transfer-name"
          name="name"
          required
          maxLength={160}
          autoComplete="name"
          aria-describedby={leadNameError ? LEAD_NAME_ERROR_ID : undefined}
          aria-invalid={leadNameError ? true : undefined}
          className="tap-target"
        />
        <FieldError id={LEAD_NAME_ERROR_ID} message={leadNameError ?? undefined} />
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="transfer-email">Email</Label>
          <Input
            id="transfer-email"
            name="email"
            type="email"
            required
            autoComplete="email"
            aria-describedby={leadEmailError ? LEAD_EMAIL_ERROR_ID : undefined}
            aria-invalid={leadEmailError ? true : undefined}
            className="tap-target"
          />
          <FieldError id={LEAD_EMAIL_ERROR_ID} message={leadEmailError ?? undefined} />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="transfer-phone">Mobile number</Label>
          <Input
            id="transfer-phone"
            name="phone"
            type="tel"
            required
            autoComplete="tel"
            placeholder="09XX XXX XXXX"
            aria-describedby={leadPhoneError ? LEAD_PHONE_ERROR_ID : undefined}
            aria-invalid={leadPhoneError ? true : undefined}
            className="tap-target"
          />
          <FieldError id={LEAD_PHONE_ERROR_ID} message={leadPhoneError ?? undefined} />
        </div>
      </div>

      <fieldset
        className="space-y-2"
        aria-describedby={payModeError ? PAY_MODE_ERROR_ID : undefined}
      >
        <legend className="text-sm font-medium">How would you like to pay?</legend>
        <div className="grid gap-3 sm:grid-cols-2">
          {PAY_MODE_ORDER.map((mode) => (
            <label
              key={mode}
              className={cn(
                'border-input flex min-h-11 cursor-pointer items-center gap-3 rounded-xl border p-3 transition-colors duration-150',
                payMode === mode && 'border-brand-blue-600 bg-brand-blue-50',
              )}
            >
              <input
                type="radio"
                name="payMode"
                value={mode}
                checked={payMode === mode}
                onChange={() => onPayModeChange(mode)}
                className="accent-brand-blue-600 size-5 shrink-0"
              />
              <span>
                <span className="text-brand-blue-900 block text-sm font-semibold">
                  {PAY_MODE_LABELS[mode]}
                </span>
                <span className="text-muted-foreground block text-xs">
                  {formatPeso(amountDueNowCentavos[mode])} due now
                </span>
              </span>
            </label>
          ))}
        </div>
        <FieldError id={PAY_MODE_ERROR_ID} message={payModeError} />
      </fieldset>

      <ConsentCheckbox error={consentError ?? null} onChange={() => {}} />
    </div>
  );
}
