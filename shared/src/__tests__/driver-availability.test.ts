/**
 * §9's driver availability model, which is derived rather than stored.
 * Exact boundaries, not brackets (owner standing rule): the day a leave
 * starts and the day it ends are both ON leave, and the days either side
 * are not. A one-day error here puts a driver on a trip they booked off.
 */
import { describe, expect, it } from 'vitest';
import { driverAvailability, type DriverLeaveRow } from '../dispatch';
import { civilDateFromDate } from '../time';
import type { AssignRefusal } from '../dispatch';

const leave = (startDate: string, endDate: string): DriverLeaveRow => ({
  id: 1,
  startDate,
  endDate,
  reason: null,
});

describe('driverAvailability', () => {
  it('reports inactive first, whatever the leaves say', () => {
    expect(
      driverAvailability(
        { isActive: false, leaves: [leave('2026-11-10', '2026-11-12')] },
        '2026-11-11',
      ),
    ).toEqual({ state: 'inactive' });
    // Soft-deleted and NOT on leave is still inactive.
    expect(driverAvailability({ isActive: false, leaves: [] }, '2026-11-11')).toEqual({
      state: 'inactive',
    });
  });

  it('is on leave on the FIRST day of the range', () => {
    expect(
      driverAvailability(
        { isActive: true, leaves: [leave('2026-11-10', '2026-11-12')] },
        '2026-11-10',
      ),
    ).toEqual({ state: 'on_leave', until: '2026-11-12' });
  });

  it('is on leave on the LAST day of the range', () => {
    expect(
      driverAvailability(
        { isActive: true, leaves: [leave('2026-11-10', '2026-11-12')] },
        '2026-11-12',
      ),
    ).toEqual({ state: 'on_leave', until: '2026-11-12' });
  });

  it('is active the day BEFORE and the day AFTER the range', () => {
    const driver = { isActive: true, leaves: [leave('2026-11-10', '2026-11-12')] };
    expect(driverAvailability(driver, '2026-11-09')).toEqual({ state: 'active' });
    expect(driverAvailability(driver, '2026-11-13')).toEqual({ state: 'active' });
  });

  it('treats a single-day leave as covering exactly that day', () => {
    const driver = { isActive: true, leaves: [leave('2026-11-10', '2026-11-10')] };
    expect(driverAvailability(driver, '2026-11-10')).toEqual({
      state: 'on_leave',
      until: '2026-11-10',
    });
    expect(driverAvailability(driver, '2026-11-11')).toEqual({ state: 'active' });
  });

  it('is active with no leaves at all', () => {
    expect(driverAvailability({ isActive: true, leaves: [] }, '2026-11-11')).toEqual({
      state: 'active',
    });
  });

  it('picks the covering leave when several exist', () => {
    const driver = {
      isActive: true,
      leaves: [leave('2026-01-01', '2026-01-02'), leave('2026-11-10', '2026-11-12')],
    };
    expect(driverAvailability(driver, '2026-11-11')).toEqual({
      state: 'on_leave',
      until: '2026-11-12',
    });
  });
});

/**
 * `civilDateFromDate` — extracted on its third consumer. The behaviour that
 * matters is that a `date` column's UTC-midnight value keeps its calendar
 * day, because the pool is configured `timezone: 'Z'`. A tour date off by
 * one is a van sent on the wrong morning.
 */
describe('civilDateFromDate', () => {
  it('keeps the calendar day of a UTC-midnight date column value', () => {
    expect(civilDateFromDate(new Date('2026-11-10T00:00:00Z'))).toBe('2026-11-10');
  });

  it('passes null through', () => {
    expect(civilDateFromDate(null)).toBeNull();
  });

  it('reads the Manila day, not the UTC day, for a late-evening instant', () => {
    // 2026-11-10 17:00Z is 2026-11-11 01:00 in Manila — a UTC slice would
    // say the 10th and be a day out.
    expect(civilDateFromDate(new Date('2026-11-10T17:00:00Z'))).toBe('2026-11-11');
  });
});

/**
 * `AssignRefusal` is a shared type so the admin UI can map every reason to
 * copy exhaustively. There is nothing to execute, so the guard is a
 * compile-time exhaustiveness check that a reviewer can see and a future
 * reason will break: add a seventh member to the union and this object
 * stops compiling until it gets words.
 */
describe('AssignRefusal', () => {
  it('has copy for every reason, enforced by the compiler', () => {
    const copy: Record<AssignRefusal, string> = {
      booking_not_found: 'That trip is no longer there — reload the day.',
      booking_not_assignable: "This trip's status cannot take a van yet.",
      van_unavailable: 'Someone just took that van. Here is the refreshed list.',
      driver_unavailable: 'That driver is not available on this date.',
      van_too_small: 'That van is too small for this group.',
      reason_required: 'Changing a trip already under way needs a reason.',
    };
    // Six, exactly — a reason added without copy fails the line above, and a
    // reason REMOVED without tidying this leaves an excess key, which
    // `Record` also rejects.
    expect(Object.keys(copy)).toHaveLength(6);
  });
});
