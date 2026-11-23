import { useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import {
  GUEST_PHONE_PLACEHOLDER,
  formatPeso,
  isLikelyInternationalPhone,
  type PayMode,
} from '@rg/shared';
import FieldError from '@/components/common/FieldError';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { getFieldErrors, getNestedFieldError } from '@/lib/field-errors';
import { cn } from '@/lib/utils';

/**
 * The amber "something's wrong here" chrome a Task 6 pre-submit (or server)
 * refusal puts on an invalid field — an amber border plus a small warning
 * glyph inside the input's own wrapper, never red (CLAUDE.md). This is
 * ATTENTION chrome, distinct from the MESSAGE beneath the field, which stays
 * `text-brand-error`/`FieldError`'s own dark blue-grey — see
 * `ErrorSummary.tsx`'s header note on why amber-for-attention and
 * blue-grey-for-the-sentence are two different jobs, not a contradiction.
 */
function invalidInputClassName(hasError: boolean): string {
  return cn('tap-target', hasError && 'border-brand-warning pr-9');
}

function WarningIcon({ show }: { show: boolean }) {
  if (!show) return null;
  return (
    <AlertTriangle
      aria-hidden="true"
      className="text-brand-warning pointer-events-none absolute right-3 top-1/2 size-4 -translate-y-1/2"
    />
  );
}

type Props = {
  payMode: PayMode;
  onPayModeChange: (mode: PayMode) => void;
  /** `QuoteResult.amountDueNowCentavos` — rendered verbatim per mode, never recomputed. */
  amountDueNowCentavos: { full: number; deposit: number };
  /**
   * `createHold`'s rejection, raw — `null` when the last submit either
   * succeeded or has not happened yet. Passed through rather than
   * pre-flattened so this component can read BOTH the top-level map
   * (`pickup`, `payMode`, …) and, since BUG-120, the `lead.name` /
   * `lead.email` / `lead.phone` leaf messages — `lib/field-errors.ts` is
   * the one place that knows how to read either shape off it.
   */
  error?: unknown;
};

const PAY_MODE_ORDER: readonly PayMode[] = ['deposit', 'full'];
const PAY_MODE_LABELS: Record<PayMode, string> = {
  deposit: 'Pay 30% deposit',
  full: 'Pay in full',
};

/** The ids the inputs name in `aria-describedby`, so each pairing has one spelling. */
const LEAD_NAME_ERROR_ID = 'checkout-name-error';
const LEAD_EMAIL_ERROR_ID = 'checkout-email-error';
const LEAD_PHONE_ERROR_ID = 'checkout-phone-error';
const LEAD_PHONE_NOTE_ID = 'checkout-phone-intl-note';
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
 * ## Where the server's validation messages land (task A4, then BUG-120)
 *
 * `createHold`'s refusals used to arrive as one `error.message` under the
 * submit button — and for a multi-issue `ZodError` that message is a JSON
 * blob of issue objects, which is what guests were actually being shown.
 * Each message now renders beneath the input it belongs to, wired with
 * `aria-describedby` and announced with `role="alert"` (`FieldError`).
 *
 * **`lead` used to be ONE key, by construction, so a bad phone number alone
 * marked all three of name/email/phone invalid.** `createHoldInput.lead` is
 * a nested object, and the server's top-level `flattenError` groups issues
 * by `issue.path[0]` — so every issue inside `lead`, whichever of the three
 * sub-fields it actually named, arrived as one `fieldErrors.lead` entry with
 * no sub-key. BUG-120 taught the server's `errorFormatter` to ALSO publish a
 * dot-path map (`data.zodError.nestedFieldErrors`, e.g. `'lead.phone'` →
 * message) alongside that top-level one, so `getNestedFieldError` below can
 * resolve each of the three inputs to its own leaf message — falling back
 * to the old grouped `lead` message only if the server ever answers without
 * the nested map (an older deploy, say), so this component is never worse
 * off than it was.
 */
export default function GuestDetails({
  payMode,
  onPayModeChange,
  amountDueNowCentavos,
  error,
}: Props) {
  const [phoneValue, setPhoneValue] = useState('');
  const showIntlNote = isLikelyInternationalPhone(phoneValue);

  const leadNameError = getNestedFieldError(error, 'lead.name');
  const leadEmailError = getNestedFieldError(error, 'lead.email');
  const leadPhoneError = getNestedFieldError(error, 'lead.phone');
  const fieldErrors = getFieldErrors(error);
  const pickupError = fieldErrors?.pickup;
  const pickupMapError = fieldErrors?.pickupMapUrl;
  const requestsError = fieldErrors?.requests;
  const payModeError = fieldErrors?.payMode;

  return (
    <div className="space-y-5">
      <div className="space-y-1.5">
        <Label htmlFor="checkout-name">Full name</Label>
        <div className="relative">
          <Input
            id="checkout-name"
            name="name"
            required
            autoComplete="name"
            aria-describedby={leadNameError ? LEAD_NAME_ERROR_ID : undefined}
            aria-invalid={leadNameError ? true : undefined}
            className={invalidInputClassName(Boolean(leadNameError))}
          />
          <WarningIcon show={Boolean(leadNameError)} />
        </div>
        <FieldError id={LEAD_NAME_ERROR_ID} message={leadNameError ?? undefined} />
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="checkout-email">Email</Label>
          <div className="relative">
            <Input
              id="checkout-email"
              name="email"
              type="email"
              required
              autoComplete="email"
              aria-describedby={leadEmailError ? LEAD_EMAIL_ERROR_ID : undefined}
              aria-invalid={leadEmailError ? true : undefined}
              className={invalidInputClassName(Boolean(leadEmailError))}
            />
            <WarningIcon show={Boolean(leadEmailError)} />
          </div>
          <FieldError id={LEAD_EMAIL_ERROR_ID} message={leadEmailError ?? undefined} />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="checkout-phone">WhatsApp / mobile number</Label>
          <div className="relative">
            <Input
              id="checkout-phone"
              name="phone"
              type="tel"
              required
              autoComplete="tel"
              placeholder={GUEST_PHONE_PLACEHOLDER}
              value={phoneValue}
              onChange={(e) => setPhoneValue(e.target.value)}
              aria-describedby={
                [
                  leadPhoneError ? LEAD_PHONE_ERROR_ID : null,
                  showIntlNote ? LEAD_PHONE_NOTE_ID : null,
                ]
                  .filter(Boolean)
                  .join(' ') || undefined
              }
              aria-invalid={leadPhoneError ? true : undefined}
              className={invalidInputClassName(Boolean(leadPhoneError))}
            />
            <WarningIcon show={Boolean(leadPhoneError)} />
          </div>
          <FieldError id={LEAD_PHONE_ERROR_ID} message={leadPhoneError ?? undefined} />
          {showIntlNote && (
            <p id={LEAD_PHONE_NOTE_ID} className="text-muted-foreground text-xs">
              Please have WhatsApp or Viber installed before your trip day so we can reach you.
            </p>
          )}
        </div>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="checkout-pickup">Pickup location (optional)</Label>
        <div className="relative">
          <Input
            id="checkout-pickup"
            name="pickup"
            aria-describedby={pickupError ? PICKUP_ERROR_ID : undefined}
            aria-invalid={pickupError ? true : undefined}
            className={invalidInputClassName(Boolean(pickupError))}
          />
          <WarningIcon show={Boolean(pickupError)} />
        </div>
        <FieldError id={PICKUP_ERROR_ID} message={pickupError} />
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="checkout-pickup-map">Google Maps pin (optional)</Label>
        <div className="relative">
          <Input
            id="checkout-pickup-map"
            name="pickupMapUrl"
            type="url"
            placeholder="https://maps.google.com/..."
            aria-describedby={pickupMapError ? PICKUP_MAP_ERROR_ID : undefined}
            aria-invalid={pickupMapError ? true : undefined}
            className={invalidInputClassName(Boolean(pickupMapError))}
          />
          <WarningIcon show={Boolean(pickupMapError)} />
        </div>
        <FieldError id={PICKUP_MAP_ERROR_ID} message={pickupMapError} />
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="checkout-requests">Special requests (optional)</Label>
        <div className="relative">
          <textarea
            id="checkout-requests"
            name="requests"
            rows={3}
            aria-describedby={requestsError ? REQUESTS_ERROR_ID : undefined}
            aria-invalid={requestsError ? true : undefined}
            className={cn(
              'border-input bg-background focus-visible:ring-ring w-full rounded-md border px-3 py-2 text-base focus-visible:outline-none focus-visible:ring-2 md:text-sm',
              requestsError && 'border-brand-warning pr-9',
            )}
          />
          {requestsError && (
            <AlertTriangle
              aria-hidden="true"
              className="text-brand-warning pointer-events-none absolute right-3 top-3 size-4"
            />
          )}
        </div>
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
