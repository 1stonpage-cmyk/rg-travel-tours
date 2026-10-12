import { formatPeso, type PayMode } from '@rg/shared';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { cn } from '@/lib/utils';

type Props = {
  payMode: PayMode;
  onPayModeChange: (mode: PayMode) => void;
  /** `QuoteResult.amountDueNowCentavos` — rendered verbatim per mode, never recomputed. */
  amountDueNowCentavos: { full: number; deposit: number };
};

const PAY_MODE_ORDER: readonly PayMode[] = ['deposit', 'full'];
const PAY_MODE_LABELS: Record<PayMode, string> = {
  deposit: 'Pay 30% deposit',
  full: 'Pay in full',
};

/**
 * §6's checkout-page field list (Task 8): lead guest details, pickup, special
 * requests, and the pay-in-full / 30%-deposit toggle. Plain, uncontrolled
 * inputs read via `FormData` on submit by `CheckoutPage` — same convention
 * as `ContactSection.tsx` — except the pay-mode toggle, which `CheckoutPage`
 * needs as live state to drive `QuoteSummary`'s display, so it is a
 * controlled pair of radios instead.
 */
export default function GuestDetails({ payMode, onPayModeChange, amountDueNowCentavos }: Props) {
  return (
    <div className="space-y-5">
      <div className="space-y-1.5">
        <Label htmlFor="checkout-name">Full name</Label>
        <Input id="checkout-name" name="name" required autoComplete="name" className="tap-target" />
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
            className="tap-target"
          />
        </div>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="checkout-pickup">Pickup location (optional)</Label>
        <Input id="checkout-pickup" name="pickup" className="tap-target" />
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="checkout-pickup-map">Google Maps pin (optional)</Label>
        <Input
          id="checkout-pickup-map"
          name="pickupMapUrl"
          type="url"
          placeholder="https://maps.google.com/..."
          className="tap-target"
        />
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="checkout-requests">Special requests (optional)</Label>
        <textarea
          id="checkout-requests"
          name="requests"
          rows={3}
          className="border-input bg-background focus-visible:ring-ring w-full rounded-md border px-3 py-2 text-base focus-visible:outline-none focus-visible:ring-2 md:text-sm"
        />
      </div>

      <fieldset className="space-y-2">
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
      </fieldset>
    </div>
  );
}
