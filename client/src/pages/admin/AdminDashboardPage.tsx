/**
 * Week 5, Task 14: the admin dashboard (BUILD_SPEC §9 "Dashboard").
 *
 * Five alert cards, always all five, from `admin.dashboard.alerts`. §9 gives
 * this screen to all three roles and `ROLE_MATRIX.dashboard` already is that
 * trio, so there is no role gate here — unlike the assign panel, nothing on
 * this page is an action finance cannot take.
 *
 * ## One status region for the whole set
 *
 * Not one per card. Five competing live regions is the named anti-pattern in
 * the `ui-ux-pro-max` live-badge guidance, and a screen reader reading five
 * numbers in sequence tells an operator less than one sentence does.
 *
 * ## §9's lead panel now exists
 *
 * Until Week 6 this page carried a line of apology where §9's "today's
 * departures with stop-by-stop progress bars" belongs — the panel needed
 * `trip_checkpoints` writes, which arrived with 6C. Task 12 replaced that
 * line with `DeparturesBoard`, which owns its own query, its own
 * fifteen-second poll and its own busy state. The five alert cards above it
 * are untouched: they answer "what needs a decision", the board answers
 * "what is happening right now", and they are deliberately not merged into
 * one query.
 */
import { Loader2 } from 'lucide-react';
import type { DashboardAlert } from '@rg/shared';
import AlertCard from '@/components/admin/AlertCard';
import DeparturesBoard from '@/components/admin/DeparturesBoard';
import { trpc } from '@/lib/trpc';

/** The order the cards read in: money first, then today's operations, then upkeep. */
const ORDER: Array<DashboardAlert['kind']> = [
  'payments_to_verify',
  'unassigned_soon',
  'vans_in_repair',
  'service_due',
  'papers_expiring',
];

function summarise(alerts: DashboardAlert[]): string {
  const needing = alerts.filter((a) => a.count > 0);
  if (needing.length === 0) return 'Nothing needs attention right now.';
  const total = needing.reduce((sum, a) => sum + a.count, 0);
  return `${total} ${total === 1 ? 'thing needs' : 'things need'} attention across ${needing.length} ${
    needing.length === 1 ? 'alert' : 'alerts'
  }.`;
}

export default function AdminDashboardPage() {
  const query = trpc.admin.dashboard.alerts.useQuery(undefined, { retry: false });

  const alerts = query.data ?? [];
  const ordered = ORDER.map((kind) => alerts.find((a) => a.kind === kind)).filter(
    (a): a is DashboardAlert => a !== undefined,
  );

  return (
    <div>
      <h1 className="text-brand-blue-900 text-2xl font-bold">Dashboard</h1>

      {query.isPending ? (
        <p className="text-muted-foreground mt-4 flex items-center gap-2 text-sm">
          <Loader2 className="size-4 animate-spin" aria-hidden="true" />
          Loading alerts…
        </p>
      ) : null}

      {query.isError ? (
        <p role="alert" className="text-brand-error mt-4 text-sm">
          The alerts could not load. Reload the page to try again.
        </p>
      ) : null}

      {ordered.length > 0 ? (
        <>
          {/* ONE status region for the set, announced as a sentence. */}
          <p role="status" aria-atomic="true" className="text-muted-foreground mt-2 text-sm">
            {summarise(ordered)}
          </p>

          <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {ordered.map((alert) => (
              <AlertCard key={alert.kind} alert={alert} />
            ))}
          </div>
        </>
      ) : null}

      {/* §9's lead panel. Its own query, its own poll — see the module note. */}
      <DeparturesBoard />
    </div>
  );
}
