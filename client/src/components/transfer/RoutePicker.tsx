import { CheckCircle2, Clock, MapPin, Plane } from 'lucide-react';
import { formatPeso, type TransferDirection, type TransferRoutePublicRow } from '@rg/shared';
import FieldError from '@/components/common/FieldError';
import { Skeleton } from '@/components/common/Skeleton';
import { cn } from '@/lib/utils';

/**
 * Task T13, rebuilt 2026-11-08 for the flexible places/routes/vehicle-types
 * model (owner decision 2026-11-08; see
 * `docs/superpowers/plans/2026-11-08-flexible-routes.md` §4). A route used to
 * be "airport ↔ one fixed destination" (`destinationName`); it is now FROM
 * one admin-managed place TO another (`fromPlace`/`toPlace`), and when
 * `reverseEnabled` is true the SAME route is also bookable the other way
 * round, at the identical price and duration (owner decision 2).
 *
 * **This component therefore selects a `(routeId, direction)` PAIR, never a
 * bare `routeId`.** There is no second route row for the reverse leg — the
 * server's `createHoldTransferInput` carries `routeId` and `direction`
 * separately, and this picker is what decides which direction the guest
 * meant, by which radio they picked. Swapping `fromName`/`toName` for display
 * is purely cosmetic (`legsFor` below); the correctness is entirely in which
 * `direction` value rides along with the chosen row.
 *
 * Presentational only: `routes` arrives already active-filtered from
 * `trpc.transferRoutes.list.useQuery()` (the page's job), and this component
 * does no pricing — just "which of the OFFERED vehicle types' one-way rate is
 * smallest" (`cheapestOneWay` below), read directly off the catalog's own
 * `vehiclePrices` array, never summed with a coupon or a deposit percentage
 * (that only ever happens through `quoteTransfer`, read by
 * `VehicleOptionCard`). Direction does not change the figure — a reversed
 * trip costs and takes exactly as long as the forward one.
 */

export type TransferRouteSelection = { routeId: number; direction: TransferDirection };

type Props = {
  routes: TransferRoutePublicRow[];
  value: TransferRouteSelection | null;
  onChange: (selection: TransferRouteSelection) => void;
  isLoading?: boolean;
  /** Resolved message — see `TransferTypePicker`'s note on this contract. */
  error?: string;
};

const ERROR_ID = 'transfer-route-error';

/** Never present in a route id, so a composite radio `value` cannot collide. */
const RADIO_VALUE_SEPARATOR = ':';

function radioValue(routeId: number, direction: TransferDirection): string {
  return `${routeId}${RADIO_VALUE_SEPARATOR}${direction}`;
}

/**
 * The cheapest OFFERED vehicle type's one-way rate for a route, or `null`
 * when nothing is offered right now (never fabricated — see
 * `TransferRoutePublicVehiclePrice`'s own note: an unlisted type simply isn't
 * in this array).
 */
function cheapestOneWay(route: TransferRoutePublicRow): number | null {
  const prices = route.vehiclePrices.map((price) => price.oneWayPriceCentavos);
  return prices.length > 0 ? Math.min(...prices) : null;
}

/** One selectable row: a route travelled in one particular direction. */
type RouteLeg = {
  direction: TransferDirection;
  fromName: string;
  toName: string;
  touchesAirport: boolean;
};

/**
 * One leg (forward) always; a second (reverse) only when the route allows
 * it. The reverse leg is the SAME route id with its two places swapped for
 * display — never a second row fabricated client-side.
 */
function legsFor(route: TransferRoutePublicRow): RouteLeg[] {
  const forward: RouteLeg = {
    direction: 'forward',
    fromName: route.fromPlace.name,
    toName: route.toPlace.name,
    touchesAirport: route.fromPlace.isAirport || route.toPlace.isAirport,
  };
  if (!route.reverseEnabled) return [forward];
  const reverse: RouteLeg = {
    direction: 'reverse',
    fromName: route.toPlace.name,
    toName: route.fromPlace.name,
    touchesAirport: forward.touchesAirport,
  };
  return [forward, reverse];
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
        {routes.flatMap((route) => {
          const fromPrice = cheapestOneWay(route);
          return legsFor(route).map((leg) => {
            // `value?.routeId === route.id` short-circuits before
            // `value.direction` is ever read, so `value` being null never
            // throws here.
            const selected = value?.routeId === route.id && value.direction === leg.direction;
            return (
              <label
                key={radioValue(route.id, leg.direction)}
                className={cn(
                  'border-input flex min-h-11 cursor-pointer items-center gap-3 rounded-xl border p-4 transition-colors duration-150',
                  selected && 'border-brand-blue-600 bg-brand-blue-50',
                )}
              >
                <input
                  type="radio"
                  name="transferRoute"
                  value={radioValue(route.id, leg.direction)}
                  checked={selected}
                  onChange={() => onChange({ routeId: route.id, direction: leg.direction })}
                  className="accent-brand-blue-600 size-5 shrink-0"
                />
                <div className="min-w-0 flex-1">
                  <span className="text-brand-blue-900 flex min-w-0 flex-wrap items-center gap-1.5 text-sm font-semibold">
                    <MapPin className="size-3.5 shrink-0" aria-hidden="true" />
                    <span className="min-w-0 break-words">
                      {leg.fromName}
                      {' → '}
                      {leg.toName}
                    </span>
                    {leg.touchesAirport && (
                      <span className="inline-flex shrink-0 items-center">
                        <Plane className="size-3.5" aria-hidden="true" />
                        <span className="sr-only">Airport pickup or drop-off</span>
                      </span>
                    )}
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
          });
        })}
      </div>
      <FieldError id={ERROR_ID} message={error} />
    </fieldset>
  );
}
