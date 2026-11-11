/**
 * Task 1A (admin dashboard + sidebar batch, owner decision 2026-11-10,
 * group 2). The sidebar was REGROUPED and RESTYLED for Direction B, never
 * given a new destination or taken one away — this file is what proves
 * that.
 *
 * `BEFORE_*` below are `navFor(role).map(i => i.to)`, captured against
 * `main` BEFORE this task's edit to `admin-nav.ts` (verified by hand with
 * `npx tsx` against the pre-edit file, not derived from the new code —
 * copying the new output here would prove nothing).
 */
import { describe, expect, it } from 'vitest';
import { groupedNavFor, navFor } from '@/components/layout/admin-nav';

const BEFORE_OWNER = [
  '/admin',
  '/admin/bookings',
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

describe('navFor — the visible nav SET per role is unchanged by the 1A regroup', () => {
  it('owner sees exactly the same 17 destinations as before', () => {
    expect(toSet(navFor('owner'))).toEqual(new Set(BEFORE_OWNER));
    expect(navFor('owner')).toHaveLength(BEFORE_OWNER.length);
  });

  it('dispatcher sees exactly the same 8 destinations as before', () => {
    expect(toSet(navFor('dispatcher'))).toEqual(new Set(BEFORE_DISPATCHER));
    expect(navFor('dispatcher')).toHaveLength(BEFORE_DISPATCHER.length);
  });

  it('finance sees exactly the same 6 destinations as before', () => {
    expect(toSet(navFor('finance'))).toEqual(new Set(BEFORE_FINANCE));
    expect(navFor('finance')).toHaveLength(BEFORE_FINANCE.length);
  });

  it('an unknown/pending role still gets the dashboard alone', () => {
    expect(navFor(undefined).map((i) => i.to)).toEqual(['/admin']);
  });

  it('no "Trip requests" or any other destination not already reachable was added', () => {
    const allTo = new Set([...BEFORE_OWNER]);
    for (const role of ['owner', 'dispatcher', 'finance'] as const) {
      for (const item of navFor(role)) {
        expect(allTo.has(item.to)).toBe(true);
      }
    }
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

  it('dispatcher gets single-item Overview and Bookings groups, not empty ones — Reports and Payment checks are finance/owner only', () => {
    const grouped = groupedNavFor('dispatcher');
    const overview = grouped.find((entry) => entry.group === 'Overview');
    const bookings = grouped.find((entry) => entry.group === 'Bookings');
    expect(overview?.items.map((i) => i.to)).toEqual(['/admin']);
    expect(bookings?.items.map((i) => i.to)).toEqual(['/admin/bookings']);
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
