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
 * where a further alert has no copy and no destination — the same guard the
 * assign panel's refusal map uses. An alert with no route to its fix is a
 * nag, so every entry names where to go.
 */
const ALERT_COPY: Record<
  DashboardAlert['kind'],
  { noun: (n: number) => string; href: string; action: string; detail?: string }
> = {
  payments_to_verify: {
    noun: (n) => (n === 1 ? '1 payment to verify' : `${n} payments to verify`),
    href: '/admin/payments',
    action: 'Open payment checks',
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
  /*
   * Owner decision 2026-10-23 (Q1). The `detail` line says the thing a
   * dispatcher needs to decide with: the lockout ends by itself, so this card
   * is information rather than a job — unless the driver is due out before it
   * does.
   *
   * **It deliberately names no on-screen action** (review finding,
   * 2026-10-24). An earlier wording read "Unlock it only if the driver is due
   * out before then — it does not change their PIN", which promised a button
   * `/admin/drivers` does not have: `admin.drivers.unlock` exists as a
   * procedure, but the drivers screen offers Reset PIN only, because surfacing
   * a driver's locked state there needs a `lockedUntil` on `DriverRow` that no
   * task has added yet. A card that tells an operator to do something the page
   * it links to cannot do is worse than one that only reports. Put the
   * instruction back when the button exists, not before.
   */
  driver_locked: {
    noun: (n) => (n === 1 ? '1 driver is locked out' : `${n} drivers are locked out`),
    href: '/admin/drivers',
    action: 'Open the drivers',
    detail:
      'A lockout clears itself within the hour, and the driver signs in afterwards with the PIN they already have. Nothing here needs doing unless they are due out before then.',
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
  driver_locked: 'Drivers locked out',
};

/**
 * The small label above each card: which part of the business owns it.
 * Words, never colour alone - the amber one also says "Within 48 hours".
 */
const ALERT_PILL: Record<
  DashboardAlert['kind'],
  { text: string; tone: 'amber' | 'blue' | 'grey' }
> = {
  payments_to_verify: { text: 'Finance', tone: 'blue' },
  unassigned_soon: { text: 'Within 48 hours', tone: 'amber' },
  vans_in_repair: { text: 'Fleet', tone: 'grey' },
  service_due: { text: 'Fleet', tone: 'grey' },
  papers_expiring: { text: 'Drivers', tone: 'grey' },
  orphaned_on_trip: { text: 'Fleet', tone: 'grey' },
  // Grey, like its sibling on the drivers screen: a lockout that clears itself
  // within the hour is not the amber "Within 48 hours" kind of urgency.
  driver_locked: { text: 'Drivers', tone: 'grey' },
};

const PILL_TONE = {
  amber: 'border-brand-gold-300 bg-brand-gold-50 text-brand-gold-700 border',
  blue: 'bg-brand-blue-100 text-brand-blue-800',
  grey: 'bg-slate-100 text-brand-error',
} as const;

export default function AlertCard({ alert }: { alert: DashboardAlert }) {
  const copy = ALERT_COPY[alert.kind];
  const pill = ALERT_PILL[alert.kind];
  const clear = alert.count === 0;

  return (
    <article
      data-testid={`alert-${alert.kind}`}
      className={[
        // The whole card is the click target (a stretched link below), so the
        // focus ring is drawn on the card when that link takes focus.
        'has-[a:focus-visible]:ring-brand-gold-500 relative flex flex-col gap-1 rounded-[14px] border bg-white p-5 transition-shadow has-[a:focus-visible]:ring-[3px] has-[a:focus-visible]:ring-offset-2',
        clear
          ? 'border-brand-blue-100'
          : // Amber edge for anything needing attention. Never red -
            // not even for an expired franchise.
            'hover:shadow-brand-blue-900/10 border-amber-200 hover:shadow-md',
      ].join(' ')}
    >
      <span
        className={[
          'inline-flex w-fit items-center rounded-full px-2.5 py-1 text-xs font-semibold',
          PILL_TONE[pill.tone],
        ].join(' ')}
      >
        {pill.text}
      </span>

      <h3 className="text-brand-ink mt-2 text-sm font-semibold">{ALERT_TITLE[alert.kind]}</h3>

      {clear ? (
        <>
          <p aria-hidden="true" className="text-brand-blue-900/40 text-4xl font-bold">
            0
          </p>
          <p className="text-brand-error text-sm">All clear</p>
        </>
      ) : (
        <>
          {/* The sentence below says the number in words; this is the same
              figure at a glance, so screen readers skip it. */}
          <p aria-hidden="true" className="text-brand-ink text-4xl font-bold">
            {alert.count}
          </p>
          <p className="text-brand-error text-sm font-medium">{copy.noun(alert.count)}</p>
          {copy.detail ? <p className="text-brand-error mt-1 text-sm">{copy.detail}</p> : null}
          {alert.examples.length > 0 ? (
            <ul className="text-brand-error mt-2 space-y-0.5 text-xs">
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
            className="text-brand-blue-700 tap-target mt-2 inline-flex items-center text-sm font-semibold underline-offset-4 outline-none after:absolute after:inset-0 after:rounded-[14px] hover:underline"
          >
            {copy.action}
          </Link>
        </>
      )}
    </article>
  );
}
