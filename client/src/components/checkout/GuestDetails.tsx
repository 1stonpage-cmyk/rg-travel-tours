import { formatPeso, type PayMode } from '@rg/shared';
import FieldError from '@/components/common/FieldError';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import type { FieldErrors } from '@/lib/field-errors';
import { cn } from '@/lib/utils';

type Props = {
  payMode: PayMode;
  onPayModeChange: (mode: PayMode) => void;
  /** `QuoteResult.amountDueNowCentavos` — rendered verbatim per mode, never recomputed. */
  amountDueNowCentavos: { full: number; deposit: number };
  /**
   * `createHold`'s per-field validation messages, keyed by the field name the
   * SERVER reported (`lib/field-errors.ts`). Null when the last submit either
   * succeeded or failed for a reason that is not input validation.
   */
  fieldErrors?: FieldErrors | null;
};

const PAY_MODE_ORDER: readonly PayMode[] = ['deposit', 'full'];
const PAY_MODE_LABELS: Record<PayMode, string> = {
  deposit: 'Pay 30% deposit',
  full: 'Pay in full',
};

/** The ids the inputs name in `aria-describedby`, so each pairing has one spelling. */
const LEAD_ERROR_ID = 'checkout-lead-error';
const PICKUP_ERROR_ID = 'checkout-pickup-error';
const PICKUP_MAP_ERROR_ID = 'checkout-pickup-map-error';
const REQUESTS_ERROR_ID = 'checkout-requests-error';
const PAY_MODE_ERROR_ID = 'checkout-pay-mode-error';

/**
 * §6's checkout-page field list (Task 8): lead guest details, pickup, special
 * requests, and the pay-in-full / 30%-deposit toggle. Plain, uncontrolled
 * inputs read via `FormData` on submit by `CheckoutPage` — same convention
 * as `ContactSection.tsx` — except the pay-mode toggle, which `CheckoutPage`
 * needs as live state to drive `QuoteSummary`'s display, so it is a
 * controlled pair of radios instead.
 *
 * ## Where the server's validation messages land (task A4)
 *
 * `createHold`'s refusals used to arrive as one `error.message` under the
 * submit button — and for a multi-issue `ZodError` that message is a JSON
 * blob of issue objects, which is what guests were actually being shown.
 * Each message now renders beneath the input it belongs to, wired with
 * `aria-describedby` and announced with `role="alert"` (`FieldError`).
 *
 * **`lead` is ONE key, by construction, and so it gets one message for the
 * three inputs.** `createHoldInput.lead` is a nested object, and the server's
 * `flattenError` groups issues by `issue.path[0]` — so a bad phone number
 * arrives as `fieldErrors.lead`, with nothing on the wire to say which of
 * name/email/phone it was. Attributing it to the phone (the only one of the
 * three with a format rule the browser does not enforce itself, and so the
 * likely cause) would be a guess that is sometimes confidently wrong, which
 * is worse than a group message. So the sentence sits directly under the
 * email/phone row, all three inputs point at it, and the message itself
 * ("Enter a valid PH mobile number, like 0917 123 4567") says which field it
 * means. Closing this properly needs the server to publish nested paths,
 * which task A4 is explicitly scoped out of.
 */
export default function GuestDetails({
  payMode,
  onPayModeChange,
  amountDueNowCentavos,
  fieldErrors,
}: Props) {
  const leadError = fieldErrors?.lead;
  const pickupError = fieldErrors?.pickup;
  const pickupMapError = fieldErrors?.pickupMapUrl;
  const requestsError = fieldErrors?.requests;
  const payModeError = fieldErrors?.payMode;

  return (
    <div className="space-y-5">
      <div className="space-y-1.5">
        <Label htmlFor="checkout-name">Full name</Label>
        <Input
          id="checkout-name"
          name="name"
          required
          autoComplete="name"
          aria-describedby={leadError ? LEAD_ERROR_ID : undefined}
          aria-invalid={leadError ? true : undefined}
          className="tap-target"
        />
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="checkout-email">Email</Label>
          <Input
            id="checkout-email"
            name="email"
            type="email"
            required
            autoComplete="email"
            aria-describedby={leadError ? LEAD_ERROR_ID : undefined}
            aria-invalid={leadError ? true : undefined}
            className="tap-target"
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="checkout-phone">Mobile number</Label>
          <Input
            id="checkout-phone"
            name="phone"
            type="tel"
            required
            autoComplete="tel"
            placeholder="09XX XXX XXXX"
            aria-describedby={leadError ? LEAD_ERROR_ID : undefined}
            aria-invalid={leadError ? true : undefined}
            className="tap-target"
          />
        </div>
      </div>
      <FieldError id={LEAD_ERROR_ID} message={leadError} />

      <div className="space-y-1.5">
        <Label htmlFor="checkout-pickup">Pickup location (optional)</Label>
        <Input
          id="checkout-pickup"
          name="pickup"
          aria-describedby={pickupError ? PICKUP_ERROR_ID : undefined}
          aria-invalid={pickupError ? true : undefined}
          className="tap-target"
        />
        <FieldError id={PICKUP_ERROR_ID} message={pickupError} />
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="checkout-pickup-map">Google Maps pin (optional)</Label>
        <Input
          id="checkout-pickup-map"
          name="pickupMapUrl"
          type="url"
          placeholder="https://maps.google.com/..."
          aria-describedby={pickupMapError ? PICKUP_MAP_ERROR_ID : undefined}
          aria-invalid={pickupMapError ? true : undefined}
          className="tap-target"
        />
        <FieldError id={PICKUP_MAP_ERROR_ID} message={pickupMapError} />
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="checkout-requests">Special requests (optional)</Label>
        <textarea
          id="checkout-requests"
          name="requests"
          rows={3}
          aria-describedby={requestsError ? REQUESTS_ERROR_ID : undefined}
          aria-invalid={requestsError ? true : undefined}
          className="border-input bg-background focus-visible:ring-ring w-full rounded-md border px-3 py-2 text-base focus-visible:outline-none focus-visible:ring-2 md:text-sm"
        />
        <FieldError id={REQUESTS_ERROR_ID} message={requestsError} />
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
    </div>
  );
}
