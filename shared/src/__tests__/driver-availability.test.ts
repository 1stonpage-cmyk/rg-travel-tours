/**
 * §9's driver availability model, which is derived rather than stored.
 * Exact boundaries, not brackets (owner standing rule): the day a leave
 * starts and the day it ends are both ON leave, and the days either side
 * are not. A one-day error here puts a driver on a trip they booked off.
 */
import { describe, expect, it } from 'vitest';
import { driverAvailability, type DriverLeaveRow } from '../dispatch';

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
