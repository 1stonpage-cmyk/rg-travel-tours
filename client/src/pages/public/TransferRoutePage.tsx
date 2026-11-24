import { useEffect, useRef } from 'react';
import { useParams, Link } from 'react-router-dom';
import {
  formatPeso,
  formatDurationMinutes,
  reverseTransferRouteSlug,
  type TransferDirection,
  type TransferRoutePublicRow,
} from '@rg/shared';
import { useRawDocumentTitle } from '@/hooks/useDocumentTitle';
import { EmptyState } from '@/components/common/QueryBoundary';
import { Skeleton } from '@/components/common/Skeleton';
import { Button } from '@/components/ui/button';
import { trackEvent } from '@/lib/consent/scripts';
import { trpc } from '@/lib/trpc';

/**
 * `/transfers/:slug` — a direction-specific transfer route landing page
 * (SEO fixes, 2026-11-24, Task 9). One route pattern serves BOTH directions
 * of a reversible route: `matchRouteDirection` below decides which.
 *
 * Modelled on `TourDetailPage.tsx`'s shape (a `trpc` query, a loading
 * skeleton, a `NOT_FOUND`-shaped empty state, `useRawDocumentTitle` fed the
 * server's own already-complete string). The one real addition is the
 * match/view-model step: `transferRoutes.list` returns every ACTIVE route
 * once, forward-shaped, and this page itself tries a forward match and then
 * a reverse one — the SAME two-step order, and the SAME pure
 * `reverseTransferRouteSlug`, that `loadTransferRouteSeo` (Task 8,
 * `server/src/seo/resolvers.ts`) uses server-side. Keeping both sides on the
 * identical formula is what stops a slug this page accepts from ever being
 * one the server's resolver would have 404'd, and vice versa — see that
 * file's own header note on why a second formula here would be a drift risk,
 * not a convenience.
 */

interface RouteDirectionView {
  route: TransferRoutePublicRow;
  direction: TransferDirection;
  pickupPlace: TransferRoutePublicRow['fromPlace'];
  dropoffPlace: TransferRoutePublicRow['toPlace'];
  pageTitle: string | null;
  /** This direction's OWN URL slug (echoes the requested param, always). */
  slug: string;
  /** The OTHER direction's slug, present only when `reverseEnabled`. */
  otherSlug: string | null;
}

/**
 * Tries a FORWARD match (`route.slug === requestedSlug`), then a REVERSE one
 * — the SAME two-step order and the SAME pure `reverseTransferRouteSlug`
 * `loadTransferRouteSeo` (Task 8) uses server-side, so a slug this page
 * accepts is never one the server's resolver would have 404'd, and vice
 * versa. A reverse match against a `reverseEnabled: false` route is
 * impossible by construction (the filter below), mirroring the server.
 */
function matchRouteDirection(
  routes: TransferRoutePublicRow[],
  requestedSlug: string,
): RouteDirectionView | null {
  const forward = routes.find((r) => r.slug === requestedSlug);
  if (forward) {
    return {
      route: forward,
      direction: 'forward',
      pickupPlace: forward.fromPlace,
      dropoffPlace: forward.toPlace,
      pageTitle: forward.pageTitle,
      slug: requestedSlug,
      otherSlug: forward.reverseEnabled ? reverseTransferRouteSlug(forward.slug) : null,
    };
  }

  const reverse = routes.find(
    (r) => r.reverseEnabled && reverseTransferRouteSlug(r.slug) === requestedSlug,
  );
  if (reverse) {
    return {
      route: reverse,
      direction: 'reverse',
      pickupPlace: reverse.toPlace,
      dropoffPlace: reverse.fromPlace,
      pageTitle: reverse.reversePageTitle,
      slug: requestedSlug,
      otherSlug: reverse.slug,
    };
  }

  return null;
}

function cheapestOffer(route: TransferRoutePublicRow) {
  return (
    route.vehiclePrices.slice().sort((a, b) => a.oneWayPriceCentavos - b.oneWayPriceCentavos)[0] ??
    null
  );
}

/**
 * Direction-specific guidance (owner decision 2026-11-24) — describes the
 * REAL booking-form mechanism (flight/ferry fields, free-typed pickup/
 * drop-off addresses), never an invented route fact. No hour figure is
 * named anywhere here; the only numbers on this page come from
 * `route.estimatedDurationMinutes`/`freeCancelHours`/prices.
 */
function pickupGuidance(
  pickupType: TransferRoutePublicRow['fromPlace']['placeType'],
): string | null {
  if (pickupType === 'airport') {
    return 'Your driver meets you at the arrivals area with a name sign. Tell us your flight number and airline when you book so your driver can time your pickup around your actual arrival.';
  }
  if (pickupType === 'pier') {
    return "We'll ask for your ferry name and arrival time when you book, so your driver is waiting when you dock.";
  }
  return null;
}

function dropoffGuidance(
  dropoffType: TransferRoutePublicRow['toPlace']['placeType'],
): string | null {
  if (dropoffType === 'airport') {
    return 'We pick you up from your hotel or accommodation. Tell us your flight number and departure time when you book so we can plan a pickup that gets you to the airport with time to check in.';
  }
  if (dropoffType === 'pier') {
    return "We'll drop you right at the pier in time for your ferry — tell us your departure time when you book.";
  }
  return null;
}

export default function TransferRoutePage() {
  const { slug } = useParams<{ slug: string }>();
  const routesQuery = trpc.transferRoutes.list.useQuery();
  const view = routesQuery.data ? matchRouteDirection(routesQuery.data, slug ?? '') : null;

  // `view.pageTitle` is the server's own `transferRouteTitle()` output for
  // THIS direction (Task 9, Step 0) — read verbatim, never recomposed here.
  // Same rule `TourDetailPage.tsx` follows for `query.data.pageTitle`:
  // "never build meta in a surface" applies to the SPA's own re-assertion
  // of a title on client-side nav, not only to the server's two injection
  // surfaces.
  useRawDocumentTitle(view?.pageTitle ?? null);

  /*
   * `view_route` (Task 12, SEO fixes, 2026-11-24) — fired once per
   * direction-specific slug, not once per route id. A reversible route's
   * forward and reverse pages share one `route.id` but have swapped
   * pickup/dropoff places, so keying the fire-once guard on `view.slug` (the
   * REQUESTED slug, which differs between the two directions) is what keeps
   * a guest who navigates forward→reverse from being silently skipped, and
   * `view.pickupPlace`/`view.dropoffPlace` (already direction-resolved by
   * `matchRouteDirection`, not the route's own raw `fromPlace`/`toPlace`) is
   * what keeps a reverse-direction view from reporting the forward names.
   */
  const trackedViewSlugRef = useRef<string | null>(null);
  useEffect(() => {
    if (!view) return;
    if (trackedViewSlugRef.current === view.slug) return;
    trackedViewSlugRef.current = view.slug;
    trackEvent('view_route', {
      routeId: view.route.id,
      fromPlace: view.pickupPlace.name,
      toPlace: view.dropoffPlace.name,
      direction: view.direction,
    });
  }, [view]);

  if (routesQuery.isPending) {
    return (
      <div className="mx-auto max-w-4xl px-4 py-10">
        <Skeleton className="h-8 w-2/3" />
        <Skeleton className="mt-4 h-48 w-full" />
      </div>
    );
  }

  if (!view) {
    return (
      <div className="mx-auto max-w-4xl px-4 py-16 text-center">
        <EmptyState
          title="This route isn't available"
          body="It may have been retired. See every route we offer below."
        />
        <Button asChild className="tap-target mt-6">
          <Link to="/transfer">See all transfers</Link>
        </Button>
      </div>
    );
  }

  const { route, direction, pickupPlace, dropoffPlace, otherSlug } = view;
  const cheapest = cheapestOffer(route);
  // Matched on `pickupPlace` ONLY (final review fix 1) — the heading below
  // reads "Other transfers from {pickupPlace.name}", so a route that shares
  // only `dropoffPlace` genuinely has nothing to do with the named place and
  // must not be listed under it.
  const relatedRoutes = routesQuery.data!.filter(
    (r) =>
      r.id !== route.id && (r.fromPlace.id === pickupPlace.id || r.toPlace.id === pickupPlace.id),
  );
  const pickupNote = pickupGuidance(pickupPlace.placeType);
  const dropoffNote = dropoffGuidance(dropoffPlace.placeType);

  return (
    <div className="mx-auto max-w-4xl px-4 py-10 sm:px-6 lg:px-8">
      <h1 className="text-brand-blue-900 text-2xl font-bold sm:text-3xl">
        Private transfer from {pickupPlace.name} to {dropoffPlace.name}
      </h1>
      <p className="text-muted-foreground mt-2 text-sm">
        {formatDurationMinutes(route.estimatedDurationMinutes)} · Free cancellation up to{' '}
        {route.freeCancelHours} hours before pickup
      </p>

      <section className="mt-6 grid gap-3 sm:grid-cols-2">
        {route.vehiclePrices.map((v) => (
          <div key={v.vehicleTypeId} className="border-brand-blue-100 rounded-xl border p-4">
            <p className="font-semibold">{v.vehicleTypeName}</p>
            <p className="text-brand-blue-900 text-lg font-bold">
              {formatPeso(v.oneWayPriceCentavos)}
              {route.pricingMode === 'per_person' ? ' / person' : ''}
            </p>
            {v.defaultSeats !== null && (
              <p className="text-muted-foreground text-xs">Seats up to {v.defaultSeats}</p>
            )}
          </div>
        ))}
      </section>

      {(route.inclusionsText || route.exclusionsText) && (
        <section className="mt-6 grid gap-6 sm:grid-cols-2">
          {route.inclusionsText && (
            <div>
              <h2 className="font-semibold">What's included</h2>
              <p className="whitespace-pre-line text-sm">{route.inclusionsText}</p>
            </div>
          )}
          {route.exclusionsText && (
            <div>
              <h2 className="font-semibold">Not included</h2>
              <p className="whitespace-pre-line text-sm">{route.exclusionsText}</p>
            </div>
          )}
        </section>
      )}

      {(pickupNote || dropoffNote) && (
        <section className="text-muted-foreground mt-4 space-y-2 text-sm">
          {pickupNote && <p>{pickupNote}</p>}
          {dropoffNote && <p>{dropoffNote}</p>}
        </section>
      )}

      <section className="mt-8">
        <h2 className="font-semibold">Frequently asked questions</h2>
        <dl className="mt-3 space-y-4 text-sm">
          <div>
            <dt className="font-medium">How much does this transfer cost?</dt>
            <dd className="text-muted-foreground mt-1">
              {cheapest
                ? `From ${formatPeso(cheapest.oneWayPriceCentavos)}${route.pricingMode === 'per_person' ? ' per person' : ' for the vehicle'}${
                    route.vehiclePrices.length > 1
                      ? ', depending on which vehicle you choose.'
                      : '.'
                  }`
                : 'Contact us for current pricing.'}
            </dd>
          </div>
          <div>
            <dt className="font-medium">How long does it take?</dt>
            <dd className="text-muted-foreground mt-1">
              About {formatDurationMinutes(route.estimatedDurationMinutes)}, door to door.
            </dd>
          </div>
          <div>
            <dt className="font-medium">Can I cancel for free?</dt>
            <dd className="text-muted-foreground mt-1">
              Yes, up to {route.freeCancelHours} hours before your pickup time.
            </dd>
          </div>
          {otherSlug && (
            <div>
              <dt className="font-medium">
                Need the return trip, {dropoffPlace.name} to {pickupPlace.name}?
              </dt>
              <dd className="text-muted-foreground mt-1">
                Yes — see our{' '}
                <Link
                  to={`/transfers/${otherSlug}`}
                  className="text-brand-blue-700 underline underline-offset-2"
                >
                  {dropoffPlace.name} to {pickupPlace.name} transfer page
                </Link>
                .
              </dd>
            </div>
          )}
        </dl>
      </section>

      <div className="mt-8 flex flex-wrap gap-3">
        <Button asChild size="lg" className="tap-target">
          <Link
            to={`/transfer?productType=transfer_one_way&routeId=${route.id}&direction=${direction}`}
          >
            Book this transfer
          </Link>
        </Button>
      </div>

      {relatedRoutes.length > 0 && (
        <section className="mt-10">
          <h2 className="font-semibold">Other transfers from {pickupPlace.name}</h2>
          <ul className="mt-3 space-y-1 text-sm">
            {relatedRoutes.map((r) => (
              <li key={r.id}>
                <Link
                  to={`/transfers/${r.slug}`}
                  className="text-brand-blue-700 underline underline-offset-2"
                >
                  {r.fromPlace.name} to {r.toPlace.name}
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
