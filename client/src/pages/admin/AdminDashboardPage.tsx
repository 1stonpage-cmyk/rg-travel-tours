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
 */
import { Loader2 } from 'lucide-react';
import { Link } from 'react-router-dom';
import type { DashboardAlert } from '@rg/shared';
import AlertCard from '@/components/admin/AlertCard';
import DeparturesBoard from '@/components/admin/DeparturesBoard';
import { MONEY_ROLES, roleMay } from '@/lib/roles';
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

  const alerts = query.data ?? [];
  const ordered = ORDER.filter((kind) => kind !== 'payments_to_verify' || mayVerifyPayments)
    .map((kind) => alerts.find((a) => a.kind === kind))
    .filter((a): a is DashboardAlert => a !== undefined);

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div className="flex flex-col gap-1">
          <p className="text-brand-gold-700 text-xs font-semibold uppercase tracking-[0.08em]">
            {manilaToday()} · Manila time
          </p>
          <h1 className="text-brand-ink text-2xl font-bold sm:text-3xl">
            {me.data?.name ? `${manilaGreeting()}, ${me.data.name}` : 'Dashboard'}
          </h1>
        </div>
        <Link
          to="/admin/bookings"
          className="bg-brand-blue-700 hover:bg-brand-blue-800 tap-target inline-flex items-center rounded-[10px] px-5 text-sm font-semibold text-white transition-colors"
        >
          Find a booking
        </Link>
      </header>

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

            <div className="grid gap-3 [grid-template-columns:repeat(auto-fit,minmax(220px,1fr))]">
              {ordered.map((alert) => (
                <AlertCard key={alert.kind} alert={alert} />
              ))}
            </div>
          </>
        ) : null}
      </section>

      {/* §9's lead panel. Its own query, its own poll - see the module note. */}
      <DeparturesBoard showBoardLink />
    </div>
  );
}
