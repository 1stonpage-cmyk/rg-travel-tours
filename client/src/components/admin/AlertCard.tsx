/**
 * Week 5, Task 14: one dashboard alert card (BUILD_SPEC §9 "Dashboard").
 *
 * ## Every card states its number in words
 *
 * `2 payments to verify`, never a bare `2` beside an icon. The
 * `ui-ux-pro-max` live-badge guidance is explicit about this — "announce a
 * meaningful contextual status", not a bare number — and it is the same
 * rule as the calendar's gold dot: the count is information, so it has to
 * be readable rather than inferred from position.
 *
 * ## A zero card looks settled, not alarming
 *
 * It is still PRESENT. A dashboard that hides its empty alerts teaches an
 * operator that an absent card means "fine", which is indistinguishable
 * from "the query broke" — so zero gets a quiet card saying `All clear`
 * rather than no card at all.
 *
 * ## Amber, never red
 *
 * `CLAUDE.md` is absolute, and a dashboard of warnings is exactly where an
 * implementer reaches for red. Amber ground, dark-blue ink, and the count
 * carries the urgency through weight rather than hue.
 */
import { Link } from 'react-router-dom';
import type { DashboardAlert } from '@rg/shared';

/**
 * The words for each alert, and the screen that resolves it.
 *
 * Typed `Record<DashboardAlert['kind'], …>` so the COMPILER refuses a build
 * where a sixth alert has no copy and no destination — the same guard the
 * assign panel's refusal map uses. An alert with no route to its fix is a
 * nag, so every entry names where to go.
 */
const ALERT_COPY: Record<
  DashboardAlert['kind'],
  { noun: (n: number) => string; href: string; action: string; detail?: string }
> = {
  payments_to_verify: {
    noun: (n) => (n === 1 ? '1 payment to verify' : `${n} payments to verify`),
    href: '/admin/bookings?filter=pending_verification',
    action: 'Open the verification queue',
  },
  unassigned_soon: {
    noun: (n) =>
      n === 1
        ? '1 trip within 48 hours has no van or driver'
        : `${n} trips within 48 hours have no van or driver`,
    href: '/admin/calendar',
    action: 'Open the calendar',
  },
  vans_in_repair: {
    noun: (n) => (n === 1 ? '1 van is in repair' : `${n} vans are in repair`),
    href: '/admin/vans',
    action: 'Open the fleet',
  },
  service_due: {
    noun: (n) =>
      n === 1
        ? '1 van is due for service within 14 days'
        : `${n} vans are due for service within 14 days`,
    href: '/admin/vans',
    action: 'Open the fleet',
  },
  papers_expiring: {
    noun: (n) =>
      n === 1
        ? '1 licence, OR/CR or franchise expires within 30 days'
        : `${n} licences, OR/CRs or franchises expire within 30 days`,
    href: '/admin/drivers',
    action: 'Open the drivers',
  },
  /*
   * Owner decision 2026-10-16 (D5). The `detail` line carries the consequence
   * in words, because the count alone ("1 van is marked on trip") does not
   * say why anyone should care: the van is refused on EVERY future date, and
   * the cure is a person completing or correcting the trip — the system
   * deliberately frees nothing by itself. Meaning is in the sentence, not in
   * the amber ground.
   */
  orphaned_on_trip: {
    noun: (n) =>
      n === 1
        ? '1 van is marked on trip, but no trip is running'
        : `${n} vans are marked on trip, but no trip is running`,
    href: '/admin/vans',
    action: 'Open the fleet',
    detail:
      'A van in this state is refused on every future date until someone completes or corrects the trip.',
  },
};

/** The heading each card carries whatever its count. */
const ALERT_TITLE: Record<DashboardAlert['kind'], string> = {
  payments_to_verify: 'Payments to verify',
  unassigned_soon: 'Unassigned trips',
  vans_in_repair: 'Vans in repair',
  service_due: 'Service due',
  papers_expiring: 'Papers expiring',
  orphaned_on_trip: 'Vans stuck on a trip',
};

export default function AlertCard({ alert }: { alert: DashboardAlert }) {
  const copy = ALERT_COPY[alert.kind];
  const clear = alert.count === 0;

  return (
    <article
      data-testid={`alert-${alert.kind}`}
      className={[
        'rounded-2xl border p-4',
        clear
          ? 'border-border bg-background'
          : // Amber ground for anything needing attention. Never red —
            // not even for an expired franchise.
            'border-amber-200 bg-amber-50',
      ].join(' ')}
    >
      <h3 className="text-brand-blue-900 text-sm font-semibold">{ALERT_TITLE[alert.kind]}</h3>

      {clear ? (
        <p className="text-muted-foreground mt-1 text-sm">All clear</p>
      ) : (
        <>
          <p className="text-brand-blue-900 mt-1 text-sm font-semibold">{copy.noun(alert.count)}</p>
          {copy.detail ? <p className="text-brand-blue-900 mt-1 text-sm">{copy.detail}</p> : null}
          {alert.examples.length > 0 ? (
            <ul className="text-muted-foreground mt-2 space-y-0.5 text-xs">
              {alert.examples.map((example) => (
                <li key={`${alert.kind}-${example.id}`}>
                  {example.label}
                  {example.date === null ? '' : ` · ${example.date}`}
                </li>
              ))}
            </ul>
          ) : null}
          <Link
            to={copy.href}
            className="text-brand-blue-700 tap-target mt-2 inline-flex items-center text-sm font-medium underline-offset-4 hover:underline"
          >
            {copy.action}
          </Link>
        </>
      )}
    </article>
  );
}
