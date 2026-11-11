/**
 * Task 1A (admin dashboard + sidebar batch, owner decision 2026-11-10,
 * group 2). The sidebar was REGROUPED and RESTYLED for Direction B, never
 * given a new destination or taken one away — this file originally proved
 * that.
 *
 * `BEFORE_*` below were `navFor(role).map(i => i.to)`, captured against
 * `main` BEFORE that task's edit to `admin-nav.ts` (verified by hand with
 * `npx tsx` against the pre-edit file, not derived from the new code —
 * copying the new output here would have proved nothing).
 *
 * **Demo Polish Round 2, Task 1 ("1A", owner decision 2026-11-11)** then
 * added a REAL new destination — `/admin/trip-requests`, owner and
 * dispatcher, between Bookings and Payment checks — so `BEFORE_OWNER` and
 * `BEFORE_DISPATCHER` below now carry it too (and are no longer literally
 * "before" that change; they stay the arrays this suite compares `navFor`
 * against, updated in place per that task's own instruction).
 * `BEFORE_FINANCE` is unchanged: `packagesInquiries` — the gate behind
 * `admin.inquiries.list`/`.setStatus` — excludes finance, so the nav item
 * must too.
 */
import { describe, expect, it } from 'vitest';
import { groupedNavFor, navFor } from '@/components/layout/admin-nav';

const BEFORE_OWNER = [
  '/admin',
  '/admin/bookings',
  '/admin/trip-requests',
  '/admin/payments',
  '/admin/calendar',
  '/admin/departures',
  '/admin/vans',
  '/admin/drivers',
  '/admin/tours',
  '/admin/vehicle-types',
  '/admin/transfer-places',
  '/admin/transfer-routes',
  '/admin/coupons',
  '/admin/packages',
  '/admin/reviews',
  '/admin/reports',
  '/admin/staff',
  '/admin/settings',
];

const BEFORE_DISPATCHER = [
  '/admin',
  '/admin/bookings',
  '/admin/trip-requests',
  '/admin/calendar',
  '/admin/departures',
  '/admin/vans',
  '/admin/drivers',
  '/admin/packages',
  '/admin/reviews',
];

const BEFORE_FINANCE = [
  '/admin',
  '/admin/bookings',
  '/admin/payments',
  '/admin/calendar',
  '/admin/departures',
  '/admin/reports',
];

function toSet(items: readonly { to: string }[]): Set<string> {
  return new Set(items.map((i) => i.to));
}

describe('navFor — the visible nav SET per role', () => {
  it('owner sees exactly the same 18 destinations as the fixture, Trip requests included', () => {
    expect(toSet(navFor('owner'))).toEqual(new Set(BEFORE_OWNER));
    expect(navFor('owner')).toHaveLength(BEFORE_OWNER.length);
  });

  it('dispatcher sees exactly the same 9 destinations as the fixture, Trip requests included', () => {
    expect(toSet(navFor('dispatcher'))).toEqual(new Set(BEFORE_DISPATCHER));
    expect(navFor('dispatcher')).toHaveLength(BEFORE_DISPATCHER.length);
  });

  it('finance sees exactly the same 6 destinations as before — Trip requests NOT among them', () => {
    expect(toSet(navFor('finance'))).toEqual(new Set(BEFORE_FINANCE));
    expect(navFor('finance')).toHaveLength(BEFORE_FINANCE.length);
    expect(navFor('finance').some((item) => item.to === '/admin/trip-requests')).toBe(false);
  });

  it('an unknown/pending role still gets the dashboard alone', () => {
    expect(navFor(undefined).map((i) => i.to)).toEqual(['/admin']);
  });

  /**
   * Demo Polish Round 2, Task 1 ("1A", owner decision 2026-11-11). This
   * replaces a prior guard from the 2026-11-10 sidebar-restructuring task
   * that asserted the OPPOSITE — that Trip Requests had deliberately NOT
   * been added yet. That premise is now false, so the guard is rewritten
   * rather than left standing against this task's own change.
   *
   * `['owner', 'finance']` is the mutation-testing proof: widening the nav
   * item's `roles` to include finance (temporarily, by hand, while
   * verifying this task) turns this exact assertion red, which is what
   * proves the test can fail.
   */
  it('"Trip requests" was added for owner and dispatcher only, never finance', () => {
    for (const role of ['owner', 'dispatcher'] as const) {
      expect(navFor(role).some((item) => item.to === '/admin/trip-requests')).toBe(true);
    }
    expect(navFor('finance').some((item) => item.to === '/admin/trip-requests')).toBe(false);

    const tripRequests = navFor('owner').find((item) => item.to === '/admin/trip-requests');
    expect(tripRequests?.roles).toEqual(['owner', 'dispatcher']);
    expect(tripRequests?.group).toBe('Bookings');
  });
});

describe('groupedNavFor — regroups navFor(role) without changing its item set', () => {
  it('every item group sums back to navFor(role), for all three roles', () => {
    for (const role of ['owner', 'dispatcher', 'finance'] as const) {
      const grouped = groupedNavFor(role).flatMap((entry) => entry.items);
      expect(toSet(grouped)).toEqual(toSet(navFor(role)));
      expect(grouped).toHaveLength(navFor(role).length);
    }
  });

  it('a group with nothing visible for the role is left out entirely (finance: no Transfers setup, Tours setup, Marketing, or Admin group)', () => {
    const groups = groupedNavFor('finance').map((entry) => entry.group);
    expect(groups).toEqual(['Overview', 'Bookings', 'Operations']);
  });

  /*
   * Demo Polish Round 2, Task 1 ("1A"): dispatcher's Bookings group gained
   * a second item (`/admin/trip-requests`) alongside `/admin/bookings` —
   * it is no longer single-item, unlike Overview, which still is (Reports
   * stays owner/finance only).
   */
  it('dispatcher gets a single-item Overview group but a two-item Bookings group — Reports and Payment checks are finance/owner only', () => {
    const grouped = groupedNavFor('dispatcher');
    const overview = grouped.find((entry) => entry.group === 'Overview');
    const bookings = grouped.find((entry) => entry.group === 'Bookings');
    expect(overview?.items.map((i) => i.to)).toEqual(['/admin']);
    expect(bookings?.items.map((i) => i.to)).toEqual(['/admin/bookings', '/admin/trip-requests']);
  });

  it('owner sees all seven groups, in GROUP_ORDER', () => {
    expect(groupedNavFor('owner').map((entry) => entry.group)).toEqual([
      'Overview',
      'Bookings',
      'Operations',
      'Transfers setup',
      'Tours setup',
      'Marketing',
      'Admin',
    ]);
  });
});

describe('hiddenWhileToursOff — Tours and Packages both carry it (Decision 2 consequence)', () => {
  it('Tours is flagged', () => {
    const tours = navFor('owner').find((i) => i.to === '/admin/tours');
    expect(tours?.hiddenWhileToursOff).toBe(true);
  });

  it('Packages is flagged too — Decision 2 (2026-11-10) put Packages behind the same show_tours gate as Tours on every surface, so the earlier named deviation (HANDOVER-17) no longer holds', () => {
    const packages = navFor('owner').find((i) => i.to === '/admin/packages');
    expect(packages?.hiddenWhileToursOff).toBe(true);
  });

  it('nothing else in the nav carries the flag', () => {
    const flagged = navFor('owner')
      .filter((i) => i.hiddenWhileToursOff)
      .map((i) => i.to);
    expect(flagged).toEqual(['/admin/tours', '/admin/packages']);
  });
});
