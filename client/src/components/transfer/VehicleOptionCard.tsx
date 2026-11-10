import { Car, CheckCircle2 } from 'lucide-react';
import { formatPeso, type PayMode, type QuoteTransferResult } from '@rg/shared';
import FieldError from '@/components/common/FieldError';
import { Skeleton } from '@/components/common/Skeleton';
import { cn } from '@/lib/utils';

/**
 * Placeholder vehicle-card imagery (Task T26). Keyed by `vehicleTypeSlug` —
 * today's seeded types (`SEED_VEHICLE_TYPES`, server/src/db/seed-data.ts).
 * An admin-added type's slug is never in this map by construction, and that
 * is deliberate: it falls through to `vehicle-generic` rather than a path
 * this script never generated, preserving this component's own documented
 * promise (see file header) that an unknown type degrades, never breaks.
 */
const VEHICLE_IMAGE_SLUGS: ReadonlySet<string> = new Set(['van', 'suv', 'mpv']);
const GENERIC_VEHICLE_IMAGE = '/placeholders/vehicle-generic.svg';

function vehicleImageSrc(vehicleTypeSlug: string | undefined): string {
  if (vehicleTypeSlug && VEHICLE_IMAGE_SLUGS.has(vehicleTypeSlug)) {
    return `/placeholders/vehicle-${vehicleTypeSlug}.svg`;
  }
  return GENERIC_VEHICLE_IMAGE;
}

/**
 * Task T13, rebuilt 2026-11-08 for the admin-managed vehicle-types model
 * (owner decision 2026-11-08; see
 * `docs/superpowers/plans/2026-11-08-flexible-routes.md` §4). Vehicle types
 * used to be a hard-coded `van`/`suv` pair with a dedicated icon and label
 * each; they are now an admin-managed list of arbitrary size, so this card
 * renders ONE entry straight off a route's own `vehiclePrices` array
 * (`TransferRoutePublicVehiclePrice`, `@rg/shared`'s `transfers.ts`) — which
 * already carries the type's id and its display NAME — rather than looking
 * either up in a fixed table. There is nothing left here to hard-code: one
 * generic vehicle icon stands for every type, because a type the admin adds
 * tomorrow (a "Coaster", say) has no icon this component could have known to
 * draw.
 *
 * **The component that must never compute money.** The parent page fetches
 * one `quoteTransfer` per OFFERED vehicle type (the route's own `vehiclePrices`
 * array — already filtered server-side to "priced AND sellable", design note
 * §4) and hands the whole result in; nothing here sums, discounts or derives
 * a figure.
 *
 * `quote: undefined` covers two different server outcomes on purpose (see
 * `Props.quote`'s own note) and this component does not need to tell them
 * apart — both render the same "not available for this route" state,
 * distinct from `isLoading`.
 */

type Props = {
  vehicleTypeId: number;
  /** The catalog's own display name (`TransferRoutePublicVehiclePrice.vehicleTypeName`) — never a hard-coded label. */
  vehicleTypeName: string;
  /**
   * The catalog's own slug (`TransferRoutePublicVehiclePrice.slug`), used
   * only to pick a placeholder thumbnail — optional because a caller that
   * omits it (or passes a slug this component doesn't recognise) still
   * renders correctly via the generic fallback image.
   */
  vehicleTypeSlug?: string;
  /**
   * `undefined` while loading, OR when unavailable: a vehicle type below the
   * ₱100 gateway floor, or with no price row at all for this route, makes
   * `quoteTransfer` throw — the page passes `quote: undefined, isLoading:
   * false` for either case, and this card renders one "not available" state
   * for both.
   */
  quote: QuoteTransferResult | undefined;
  isLoading: boolean;
  isSelected: boolean;
  onSelect: () => void;
  /**
   * Which of `quote.amountDueNowCentavos.{full,deposit}` the "due now" line
   * shows — driven by the page's own pay-mode state, the same figure
   * `GuestDetails.tsx`'s pay-mode radios already show. The total line above
   * it is unconditional: `quote.totalCentavos` is the one figure that never
   * changes with pay mode.
   */
  payMode: PayMode;
  /** Resolved message — see `TransferTypePicker`'s own note on this contract. */
  error?: string;
};

export default function VehicleOptionCard({
  vehicleTypeId,
  vehicleTypeName,
  vehicleTypeSlug,
  quote,
  isLoading,
  isSelected,
  onSelect,
  payMode,
  error,
}: Props) {
  const unavailable = !isLoading && quote === undefined;
  const errorId = `transfer-vehicle-${vehicleTypeId}-error`;

  return (
    <div className="space-y-1.5">
      <label
        className={cn(
          'border-input flex min-h-11 w-full cursor-pointer flex-col gap-3 rounded-xl border p-4 transition-colors duration-150',
          isSelected && !unavailable && 'border-brand-blue-600 bg-brand-blue-50',
          (isLoading || unavailable) && 'cursor-not-allowed opacity-60',
        )}
      >
        <img
          src={vehicleImageSrc(vehicleTypeSlug)}
          alt=""
          data-testid={`vehicle-option-${vehicleTypeId}-image`}
          className="h-20 w-full rounded-lg object-cover"
        />
        <span className="flex items-center justify-between gap-2">
          <span className="text-brand-blue-900 flex items-center gap-2 text-sm font-semibold">
            <Car className="text-brand-blue-700 size-5 shrink-0" aria-hidden="true" />
            {vehicleTypeName}
            {isSelected && !unavailable && (
              <CheckCircle2 className="text-brand-blue-700 size-4 shrink-0" aria-hidden="true" />
            )}
          </span>
          <input
            type="radio"
            name="transferVehicleType"
            value={vehicleTypeId}
            checked={isSelected}
            disabled={isLoading || unavailable}
            onChange={() => onSelect()}
            aria-describedby={error ? errorId : undefined}
            className="accent-brand-blue-600 size-5 shrink-0"
          />
        </span>

        {isLoading ? (
          <div className="space-y-1.5" data-testid={`vehicle-option-${vehicleTypeId}-skeleton`}>
            <Skeleton className="h-6 w-24" />
            <Skeleton className="h-3.5 w-32" />
          </div>
        ) : unavailable ? (
          <p className="text-muted-foreground text-sm">Not available for this route</p>
        ) : (
          <div>
            <p className="text-brand-blue-900 text-lg font-bold">
              {formatPeso(quote!.totalCentavos)}
            </p>
            <p className="text-muted-foreground text-xs">
              {formatPeso(quote!.amountDueNowCentavos[payMode])} due now
            </p>
          </div>
        )}
      </label>
      <FieldError id={errorId} message={error} />
    </div>
  );
}
