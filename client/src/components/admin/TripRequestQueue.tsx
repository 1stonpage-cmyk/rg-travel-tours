/**
 * Task 1C (admin dashboard batch, owner decision 2026-11-10): the dashboard's
 * trip-request mini-queue, Direction B's "Control Room".
 *
 * Reads `admin.dashboard.tripRequests` (Task 1B) — `adminProcedure('packagesInquiries')`,
 * so owner and dispatcher, never finance; `TRIP_REQUEST_ROLES` is the client's
 * cosmetic mirror of that same gate. Finance is not shown this panel at all,
 * the same direction `AlertCard`'s `payments_to_verify` card takes for a
 * dispatcher.
 *
 * ## "Quote" vs "View only"
 *
 * An owner can act on a custom-trip request — `transferQuoting` is owner+finance
 * today (`TRANSFER_QUOTING_ROLES`), so the only role that sees this queue AND
 * can quote is the owner. A dispatcher may read the queue (`packagesInquiries`)
 * but cannot price or convert it, so their row carries a non-interactive
 * "View only" label instead of a button whose only outcome on the server
 * would be a refusal.
 *
 * **"Quote" links to `/admin/trip-requests`** (Demo Polish Round 2, Task 1 /
 * "1A", 2026-11-11) — the dedicated inquiries inbox, not `/admin/packages`'s
 * Enquiries section it used to point at (recorded in HANDOVER-17 as a named
 * deviation; the dedicated page now exists, so that deviation is resolved).
 * **Still no per-request deep link**, though: neither page accepts a hash
 * or an id param, so the owner still opens the inbox and finds the named
 * request there rather than landing on it directly. That narrower gap is
 * unchanged by this task.
 *
 * ## No guest contact details on the wire
 *
 * `TripRequestSummary` (`@rg/shared`) already narrows to name/pax/route/date —
 * no email, no phone, no message — per RA 10173; this component only renders
 * what the server sends, so there is nothing further to withhold here.
 */
import { Link } from 'react-router-dom';
import type { TripRequestSummary } from '@rg/shared';
import { Button } from '@/components/ui/button';
import { TRIP_REQUEST_ROLES, roleMay } from '@/lib/roles';
import { trpc } from '@/lib/trpc';

/** `"6 pax"` / `""` when the inquiry carried no party size. */
function paxLabel(pax: number | null): string {
  return pax === null ? '' : `${pax} pax`;
}

function TripRequestRow({
  request,
  canQuote,
}: {
  request: TripRequestSummary['items'][number];
  canQuote: boolean;
}) {
  return (
    <li
      data-testid={`trip-request-${request.id}`}
      className="border-brand-blue-50 flex flex-col gap-1.5 border-t px-4 py-3 text-sm first:border-t-0"
    >
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-brand-ink font-semibold">{request.name}</span>
        <span className="text-brand-error text-xs">{paxLabel(request.pax)}</span>
      </div>
      <p className="text-brand-error text-xs">
        {request.routeDescription ?? 'Custom route'}
        {request.requestedDate === null ? '' : ` · wants ${request.requestedDate}`}
      </p>
      {canQuote ? (
        <Button asChild variant="row" className="mt-1 self-start">
          <Link to="/admin/trip-requests">Quote</Link>
        </Button>
      ) : (
        <span className="text-brand-error mt-1 self-start text-xs font-semibold opacity-70">
          View only
        </span>
      )}
    </li>
  );
}

export default function TripRequestQueue({ role }: { role: string | undefined }) {
  const mayView = roleMay(role, TRIP_REQUEST_ROLES);
  const mayQuote = role === 'owner';

  const query = trpc.admin.dashboard.tripRequests.useQuery(undefined, {
    enabled: mayView,
    retry: false,
  });

  // Neither a money figure nor a disabled-looking placeholder for a role
  // that cannot see this data at all (finance, or a pending/failed `me`).
  if (!mayView) return null;

  const items = query.data?.items ?? [];

  return (
    <section
      aria-labelledby="trip-requests-heading"
      data-testid="trip-request-queue"
      className="border-brand-blue-100 overflow-hidden rounded-xl border bg-white"
    >
      <div className="border-brand-blue-100 flex items-baseline justify-between gap-2 border-b px-4 py-3">
        <h2 id="trip-requests-heading" className="text-brand-ink text-sm font-bold">
          Trip requests
        </h2>
      </div>

      {query.isPending ? (
        <p className="text-brand-error px-4 py-3 text-sm">Loading trip requests…</p>
      ) : null}

      {query.isError ? (
        <p role="alert" className="text-brand-error px-4 py-3 text-sm">
          Trip requests could not load. Reload the page to try again.
        </p>
      ) : null}

      {!query.isPending && !query.isError && items.length === 0 ? (
        <p className="text-brand-error px-4 py-3 text-sm">No new trip requests.</p>
      ) : null}

      {items.length > 0 ? (
        <ul>
          {items.map((item) => (
            <TripRequestRow key={item.id} request={item} canQuote={mayQuote} />
          ))}
        </ul>
      ) : null}
    </section>
  );
}
