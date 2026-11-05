import { CheckCircle2, Clock, MapPin } from 'lucide-react';
import { formatPeso, VEHICLE_TYPES, type TransferRoutePublicRow } from '@rg/shared';
import FieldError from '@/components/common/FieldError';
import { Skeleton } from '@/components/common/Skeleton';
import { cn } from '@/lib/utils';

/**
 * Task T13 — the route picker, second step of the transfer booking flow.
 * Presentational only: `routes` arrives already destination-active-filtered
 * from `trpc.transferRoutes.list.useQuery()` (Task T14's job), and this
 * component does no pricing — just the one "which of two numbers is
 * smaller" display computation the brief allows (`cheapestOneWay` below).
 *
 * **Not a quote.** The figure shown is `prices[vehicleType].oneWayPriceCentavos`
 * — the catalog's own published rate, read directly off
 * `TransferRoutePublicRow`, never summed with a coupon or a deposit
 * percentage (that only ever happens through `quoteTransfer`, read by
 * `VehicleOptionCard`). One-way is used as the representative figure because
 * it is the cheaper of a route's two products and exists for every bookable
 * route regardless of which `TransferProductType` the guest picked on the
 * previous screen (this component is never told which one).
 */

type Props = {
  routes: TransferRoutePublicRow[];
  value: number | null;
  onChange: (routeId: number) => void;
  isLoading?: boolean;
  /** Resolved message — see `TransferTypePicker`'s note on this contract. */
  error?: string;
};

const ERROR_ID = 'transfer-route-error';

/**
 * The cheaper of the two vehicle types' one-way rate for a route, or `null`
 * when neither vehicle type has a stored price row (never fabricated).
 */
function cheapestOneWay(route: TransferRoutePublicRow): number | null {
  const prices = VEHICLE_TYPES.map((type) => route.prices[type]?.oneWayPriceCentavos).filter(
    (price): price is number => typeof price === 'number',
  );
  return prices.length > 0 ? Math.min(...prices) : null;
}

export default function RoutePicker({ routes, value, onChange, isLoading, error }: Props) {
  if (isLoading) {
    return (
      <div className="space-y-2" aria-busy="true" aria-label="Loading routes">
        {[0, 1, 2].map((key) => (
          <Skeleton key={key} className="h-[76px] w-full rounded-xl" />
        ))}
      </div>
    );
  }

  if (routes.length === 0) {
    return (
      <p className="text-muted-foreground text-sm" role="status">
        No routes are available right now. Please check back later or contact us directly.
      </p>
    );
  }

  return (
    <fieldset className="space-y-2" aria-describedby={error ? ERROR_ID : undefined}>
      <legend className="text-sm font-medium">Choose a route</legend>
      <div className="grid gap-3">
        {routes.map((route) => {
          const selected = value === route.id;
          const fromPrice = cheapestOneWay(route);
          return (
            <label
              key={route.id}
              className={cn(
                'border-input flex min-h-11 cursor-pointer items-center gap-3 rounded-xl border p-4 transition-colors duration-150',
                selected && 'border-brand-blue-600 bg-brand-blue-50',
              )}
            >
              <input
                type="radio"
                name="transferRoute"
                value={route.id}
                checked={selected}
                onChange={() => onChange(route.id)}
                className="accent-brand-blue-600 size-5 shrink-0"
              />
              <div className="min-w-0 flex-1">
                <span className="text-brand-blue-900 flex items-center gap-1.5 text-sm font-semibold">
                  <MapPin className="size-3.5 shrink-0" aria-hidden="true" />
                  {route.destinationName}
                  {selected && (
                    <CheckCircle2
                      className="text-brand-blue-700 size-4 shrink-0"
                      aria-hidden="true"
                    />
                  )}
                </span>
                <span className="text-muted-foreground flex items-center gap-1.5 text-xs">
                  <Clock className="size-3.5 shrink-0" aria-hidden="true" />
                  {`~${route.estimatedDurationMinutes} min`}
                </span>
              </div>
              <span className="shrink-0 text-right text-sm">
                {fromPrice === null ? (
                  <span className="text-muted-foreground">Price unavailable</span>
                ) : (
                  <>
                    <span className="text-muted-foreground">from </span>
                    <span className="text-brand-blue-900 font-bold">{formatPeso(fromPrice)}</span>
                  </>
                )}
              </span>
            </label>
          );
        })}
      </div>
      <FieldError id={ERROR_ID} message={error} />
    </fieldset>
  );
}
