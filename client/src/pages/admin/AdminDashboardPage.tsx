/**
 * Week 5, Task 14: the admin dashboard (BUILD_SPEC §9 "Dashboard").
 *
 * Seven alert cards from `admin.dashboard.alerts`. §9 gives this screen to all
 * three roles and `ROLE_MATRIX.dashboard` already is that trio, so there is no
 * role gate on the page itself — unlike the assign panel, nothing here is an
 * action finance cannot take.
 *
 * ## One card is not drawn for a dispatcher
 *
 * "Payments to verify" leads to `/admin/payments`, which is §9's
 * `verifyPayments` row — owner and finance. The nav has never offered a
 * dispatcher that link; the card did, and every receipt behind it is already
 * hidden from them (Task 4), so it was a card whose only outcome was a dead
 * end. Owner decision 2026-10-23 removes it, with **no explanation note**:
 * the card simply is not there, the same as any other role-hidden element.
 *
 * **Cosmetic, and only cosmetic.** `admin.dashboard.alerts` still computes
 * and still returns the alert to all three roles, gated exactly as it was —
 * `ROLE_MATRIX.dashboard`. This decides what the page DRAWS with data it
 * already has; the refusal that matters is `admin.payments`'s own.
 *
 * ## One status region for the whole set
 *
 * Not one per card. Seven competing live regions is the named anti-pattern in
 * the `ui-ux-pro-max` live-badge guidance, and a screen reader reading seven
 * numbers in sequence tells an operator less than one sentence does.
 *
 * ## §9's lead panel now exists
 *
 * Until Week 6 this page carried a line of apology where §9's "today's
 * departures with stop-by-stop progress bars" belongs — the panel needed
 * `trip_checkpoints` writes, which arrived with 6C. Task 12 replaced that
 * line with `DeparturesBoard`, which owns its own query, its own
 * fifteen-second poll and its own busy state. The alert cards above it
 * are untouched: they answer "what needs a decision", the board answers
 * "what is happening right now", and they are deliberately not merged into
 * one query.
 *
 * ## Task 1C (owner decision 2026-11-10): Direction B's "Control Room" layout
 *
 * A slim inline stats row, then a two-column body — `DeparturesBoard`
 * (unchanged) on the left, the alert set and the trip-request queue stacked
 * on the right. **The alert cards themselves are UNCHANGED** (`AlertCard`,
 * its copy maps, its "All clear" zero-state): Direction B's mockup draws
 * them as dense one-line ledger rows instead, but that row has no slot for
 * `copy.detail` (the `orphaned_on_trip` consequence sentence, the
 * `driver_locked` ordering) and renders a zero as a bare `—` rather than the
 * DO-NOT's required "visibly stated as clear" — both owner decisions, both
 * pinned by this file's own tests. Named deviation; HANDOVER-17.
 *
 * The stats row's money cell deviates from the mockup's own label too: the
 * mockup shows "To collect today" (an outstanding-balance figure 1B never
 * built), and this reads the two figures 1B actually built instead —
 * "Collected today" and "Pending verification" — both from
 * `admin.dashboard.money`, owner/finance only.
 */
import { Loader2 } from 'lucide-react';
import { Link } from 'react-router-dom';
import type { DashboardAlert } from '@rg/shared';
import { formatPeso } from '@rg/shared';
import AlertCard from '@/components/admin/AlertCard';
import DeparturesBoard from '@/components/admin/DeparturesBoard';
import TripRequestQueue from '@/components/admin/TripRequestQueue';
import AdminPageHeader from '@/components/admin/AdminPageHeader';
import { Button } from '@/components/ui/button';
import { MONEY_ROLES, TRIP_REQUEST_ROLES, roleMay } from '@/lib/roles';
import { trpc } from '@/lib/trpc';

/**
 * The order the cards read in: money first, then today's operations, then
 * upkeep.
 *
 * **Unlike `AlertCard`'s copy maps, this array is NOT compiler-checked** — it
 * is a list of kinds, so a kind missing from it typechecks fine and silently
 * drops that card off the page. `admin-dashboard-page.test.tsx` enumerates the
 * kinds by hand for exactly that reason; keep it doing so rather than mapping
 * `DASHBOARD_ALERT_KINDS`, or nothing guards this list at all.
 */
const ORDER: Array<DashboardAlert['kind']> = [
  'payments_to_verify',
  'unassigned_soon',
  'vans_in_repair',
  'service_due',
  'papers_expiring',
  // Owner decision 2026-10-16 (D5); after the §9 five, so they keep their place.
  'orphaned_on_trip',
  // Owner decision 2026-10-23 (Q1), beside the backing-off PIN lockout.
  'driver_locked',
];

function summarise(alerts: DashboardAlert[]): string {
  const needing = alerts.filter((a) => a.count > 0);
  if (needing.length === 0) return 'Nothing needs attention right now.';
  const total = needing.reduce((sum, a) => sum + a.count, 0);
  return `${total} ${total === 1 ? 'thing needs' : 'things need'} attention across ${needing.length} ${
    needing.length === 1 ? 'alert' : 'alerts'
  }.`;
}

/** "Friday, 23 October" in Manila, whatever zone this browser is set to. */
function manilaToday(): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Manila',
    weekday: 'long',
    day: 'numeric',
    month: 'long',
  }).format(new Date());
}

/**
 * "Good morning/afternoon/evening" by the MANILA clock, not the browser's —
 * an operator checking in from a different timezone must not be told
 * "morning" because their own laptop still thinks it is one.
 */
function manilaGreeting(): string {
  const hour = Number(
    new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Asia/Manila',
      hour: 'numeric',
      hourCycle: 'h23',
    }).format(new Date()),
  );
  if (hour < 12) return 'Good morning';
  if (hour < 18) return 'Good afternoon';
  return 'Good evening';
}

/**
 * One cell of the stats row: a mono numeral over an uppercase label at
 * `sm` and up (Direction B's own layout). Below `sm` the row stacks into
 * single-column rows instead — label left, value right, like Direction B's
 * own mobile `m-stack-stat` treatment — because five cells side by side at
 * 360px clip horizontally rather than shrinking legibly (caught in the 1G
 * Chrome check; see HANDOVER-17). `flex-row-reverse` puts the (DOM-first)
 * value on the visual right on mobile without reordering the markup;
 * `sm:flex-col` drops the reverse and restores value-above-label.
 */
function StatCell({ value, label }: { value: string; label: string }) {
  return (
    <div className="border-brand-blue-100 flex flex-row-reverse items-center justify-between gap-2 border-t px-4 py-3 first:border-t-0 sm:flex-1 sm:flex-col sm:items-start sm:justify-start sm:border-l sm:border-t-0 sm:first:border-l-0">
      <span className="text-brand-ink font-mono text-2xl font-bold">{value}</span>
      <span className="text-brand-error text-[11px] font-bold uppercase tracking-wide">
        {label}
      </span>
    </div>
  );
}

export default function AdminDashboardPage() {
  const query = trpc.admin.dashboard.alerts.useQuery(undefined, { retry: false });
  /*
   * The greeting, and now which cards are drawn. Still never a gate: the
   * alerts work on their own query, independent of whether this one is
   * pending or fails, and a role this page cannot read draws the SMALLER
   * set — the same direction `AdminLayout`'s nav already goes when `me` is
   * pending or has failed.
   */
  const me = trpc.staffAuth.me.useQuery(undefined, { retry: false });
  const mayVerifyPayments = roleMay(me.data?.role, MONEY_ROLES);
  const mayViewTripRequests = roleMay(me.data?.role, TRIP_REQUEST_ROLES);

  const alerts = query.data ?? [];
  const ordered = ORDER.filter((kind) => kind !== 'payments_to_verify' || mayVerifyPayments)
    .map((kind) => alerts.find((a) => a.kind === kind))
    .filter((a): a is DashboardAlert => a !== undefined);

  /*
   * Shares its cache entry with `DeparturesBoard`'s own identical query
   * (same procedure, same input) — this hook does not set `refetchInterval`,
   * so the board's own 15-second poll is what keeps the shared data fresh;
   * this is a second observer on it, not a second network query.
   */
  const departuresQuery = trpc.admin.departures.today.useQuery(undefined, { retry: false });
  const departures = departuresQuery.data ?? [];
  const onRoad = departures.filter((d) => d.status === 'in_progress').length;
  const awaitingDispatch = departures.filter(
    (d) => d.status !== 'in_progress' && d.status !== 'completed',
  ).length;

  const tripRequestsQuery = trpc.admin.dashboard.tripRequests.useQuery(undefined, {
    enabled: mayViewTripRequests,
    retry: false,
  });

  const moneyQuery = trpc.admin.dashboard.money.useQuery(undefined, {
    enabled: mayVerifyPayments,
    retry: false,
  });

  return (
    <div className="flex flex-col gap-6">
      <AdminPageHeader
        eyebrow={`${manilaToday()} · Manila time`}
        title={me.data?.name ? `${manilaGreeting()}, ${me.data.name}` : 'Dashboard'}
        action={
          <Button asChild variant="primary-pill">
            <Link to="/admin/bookings">Find a booking</Link>
          </Button>
        }
      />

      <div
        data-testid="dashboard-stats"
        className="border-brand-blue-100 flex flex-col overflow-hidden rounded-xl border bg-white sm:flex-row"
      >
        <StatCell value={departuresQuery.isPending ? '—' : String(onRoad)} label="On the road" />
        <StatCell
          value={departuresQuery.isPending ? '—' : String(awaitingDispatch)}
          label="Awaiting dispatch"
        />
        {mayViewTripRequests ? (
          <StatCell
            value={tripRequestsQuery.isPending ? '—' : String(tripRequestsQuery.data?.count ?? 0)}
            label="Trip requests"
          />
        ) : null}
        {mayVerifyPayments ? (
          <>
            <StatCell
              value={
                moneyQuery.isPending
                  ? '—'
                  : formatPeso(moneyQuery.data?.collectedTodayCentavos ?? 0)
              }
              label="Collected today"
            />
            <StatCell
              value={
                moneyQuery.isPending
                  ? '—'
                  : formatPeso(moneyQuery.data?.pendingVerificationCentavos ?? 0)
              }
              label="Pending verification"
            />
          </>
        ) : null}
      </div>

      <div className="grid gap-5 lg:grid-cols-[1.6fr_1fr]">
        {/* §9's lead panel. Its own query, its own poll - see the module note. */}
        <DeparturesBoard showBoardLink />

        <div className="flex flex-col gap-5">
          <section aria-labelledby="needs-attention-heading" className="flex flex-col gap-3">
            <h2 id="needs-attention-heading" className="text-brand-ink text-lg font-bold">
              Needs attention
            </h2>

            {query.isPending ? (
              <p className="text-brand-error flex items-center gap-2 text-sm">
                <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                Loading alerts…
              </p>
            ) : null}

            {query.isError ? (
              <p role="alert" className="text-brand-error text-sm">
                The alerts could not load. Reload the page to try again.
              </p>
            ) : null}

            {ordered.length > 0 ? (
              <>
                {/* ONE status region for the set, announced as a sentence. */}
                <p role="status" aria-atomic="true" className="text-brand-error text-sm">
                  {summarise(ordered)}
                </p>

                <div className="grid grid-cols-1 gap-3">
                  {ordered.map((alert) => (
                    <AlertCard key={alert.kind} alert={alert} />
                  ))}
                </div>
              </>
            ) : null}
          </section>

          <TripRequestQueue role={me.data?.role} />
        </div>
      </div>
    </div>
  );
}
