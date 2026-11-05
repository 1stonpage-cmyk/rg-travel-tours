import { CalendarClock, CheckCircle2, Plane } from 'lucide-react';
import type { TransferProductType } from '@rg/shared';
import { TRANSFER_PRODUCT_TYPES } from '@rg/shared';
import FieldError from '@/components/common/FieldError';
import { cn } from '@/lib/utils';

/**
 * Task T13 — the transfer booking flow's first choice: a one-way airport
 * transfer, or a day-use hire. Presentational only — no tRPC call, and the
 * caller (`TransferBookingPage.tsx`, Task T14) owns the `error` LOOKUP
 * (`getFieldErrors(error)?.productType`) and hands this component a plain
 * resolved string, exactly as `RoutePicker`/`VehicleOptionCard` do (see each
 * one's own note on why — only `TransferGuestDetailsForm` reads a raw
 * `unknown` error, because it owns many fields).
 *
 * **Not the plan's full three-product list.** "Custom trip request" is the
 * existing public inquiry form and has nothing to do with this booking flow —
 * `TRANSFER_PRODUCT_TYPES` (`@rg/shared`) is deliberately the two BOOKABLE
 * members only.
 *
 * Styled on the exact radio-as-card pattern `GuestDetails.tsx`'s pay-mode
 * toggle uses: a `<label>` wrapping a native radio, `border-brand-blue-600
 * bg-brand-blue-50` when selected. A `CheckCircle2` is added beside the
 * selected label too — the brand-blue background/border pairing is already a
 * shape change (not merely a hue shift) because the radio's own filled dot
 * already differs, but the brief calls for an explicit non-colour indicator
 * here, so this is it.
 */

type Props = {
  value: TransferProductType | null;
  onChange: (value: TransferProductType) => void;
  /** Resolved message — see the file note above. */
  error?: string;
};

const TYPE_ICONS: Record<TransferProductType, typeof Plane> = {
  transfer_one_way: Plane,
  transfer_day_use: CalendarClock,
};

const TYPE_LABELS: Record<TransferProductType, string> = {
  transfer_one_way: 'Airport transfer',
  transfer_day_use: 'Day use',
};

const TYPE_DESCRIPTIONS: Record<TransferProductType, string> = {
  transfer_one_way: 'One-way trip between the airport and your destination',
  transfer_day_use: 'Vehicle and driver for the day, round trip',
};

const ERROR_ID = 'transfer-type-error';

export default function TransferTypePicker({ value, onChange, error }: Props) {
  return (
    <fieldset className="space-y-2" aria-describedby={error ? ERROR_ID : undefined}>
      <legend className="text-sm font-medium">What kind of transfer do you need?</legend>
      <div className="grid gap-3 sm:grid-cols-2">
        {TRANSFER_PRODUCT_TYPES.map((type) => {
          const Icon = TYPE_ICONS[type];
          const selected = value === type;
          return (
            <label
              key={type}
              className={cn(
                'border-input flex min-h-11 cursor-pointer items-start gap-3 rounded-xl border p-4 transition-colors duration-150',
                selected && 'border-brand-blue-600 bg-brand-blue-50',
              )}
            >
              <input
                type="radio"
                name="transferProductType"
                value={type}
                checked={selected}
                onChange={() => onChange(type)}
                className="accent-brand-blue-600 mt-0.5 size-5 shrink-0"
              />
              <Icon className="text-brand-blue-700 mt-0.5 size-5 shrink-0" aria-hidden="true" />
              <span>
                <span className="text-brand-blue-900 flex items-center gap-1.5 text-sm font-semibold">
                  {TYPE_LABELS[type]}
                  {selected && (
                    <CheckCircle2 className="text-brand-blue-700 size-4" aria-hidden="true" />
                  )}
                </span>
                <span className="text-muted-foreground block text-xs">
                  {TYPE_DESCRIPTIONS[type]}
                </span>
              </span>
            </label>
          );
        })}
      </div>
      <FieldError id={ERROR_ID} message={error} />
    </fieldset>
  );
}
