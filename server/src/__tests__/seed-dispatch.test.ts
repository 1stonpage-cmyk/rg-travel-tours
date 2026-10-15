/**
 * Week 5, Task 15: the dispatcher's seed data.
 *
 * ## This suite tests the seed DEFINITION, not a seeded database
 *
 * The fleet is seeded into `rg_travel` only (controller ruling,
 * 2026-10-15): `capacity.test.ts` asserts that `rg_travel_test` holds
 * exactly zero vans and zero drivers, because those tests count the whole
 * fleet and one seeded van would change every number in that file — the file
 * that guards the booking path's capacity arithmetic.
 *
 * So these tests assert properties of `SEED_VANS` / `SEED_DRIVERS` /
 * `SEED_UNASSIGNED_TRIPS` and of the gate itself, rather than querying a
 * seeded fleet that deliberately is not there. What they CAN check is the
 * thing that actually goes wrong: a demo whose dashboard is empty, or a seed
 * that invents a franchise number.
 */
import { describe, expect, it } from 'vitest';
import { PAPERS_EXPIRING_DAYS, SERVICE_DUE_DAYS, UNASSIGNED_ALERT_HOURS } from '@rg/shared';
import { SEED_DRIVERS, SEED_UNASSIGNED_TRIPS, SEED_VANS } from '../db/seed-data';

describe('the dispatcher seed', () => {
  it('seeds a fleet with a mix of sizes and one van in repair', () => {
    expect(SEED_VANS.length).toBeGreaterThanOrEqual(4);
    expect(new Set(SEED_VANS.map((v) => v.capacity)).size).toBeGreaterThanOrEqual(3);
    expect(SEED_VANS.filter((v) => v.status === 'for_repair')).toHaveLength(1);
  });

  it('gives the service-due alert a row INSIDE its window', () => {
    const due = SEED_VANS.filter(
      (v) => v.nextServiceInDays !== null && v.nextServiceInDays <= SERVICE_DUE_DAYS,
    );
    expect(due.length).toBeGreaterThan(0);
  });

  it('gives the service-due alert an OVERDUE row too', () => {
    // The case a BETWEEN-based window silently drops. A demo that only ever
    // shows upcoming services would hide the bug rather than expose it.
    expect(SEED_VANS.some((v) => v.nextServiceInDays !== null && v.nextServiceInDays < 0)).toBe(
      true,
    );
  });

  it('gives the papers-expiring alert both a van and a driver row', () => {
    const vanPapers = SEED_VANS.some(
      (v) =>
        (v.orcrExpiryInDays !== null && v.orcrExpiryInDays <= PAPERS_EXPIRING_DAYS) ||
        (v.franchiseExpiryInDays !== null && v.franchiseExpiryInDays <= PAPERS_EXPIRING_DAYS),
    );
    const driverPapers = SEED_DRIVERS.some((d) => d.licenseExpiryInDays <= PAPERS_EXPIRING_DAYS);
    // §9 folds three documents into one alert, so a demo that only had one
    // of the two sources would leave half of it untested by eye.
    expect(vanPapers).toBe(true);
    expect(driverPapers).toBe(true);
  });

  it('gives the unassigned-trips alert rows inside the 48-hour window', () => {
    const windowDays = Math.ceil(UNASSIGNED_ALERT_HOURS / 24);
    expect(SEED_UNASSIGNED_TRIPS.length).toBeGreaterThan(0);
    for (const trip of SEED_UNASSIGNED_TRIPS) {
      expect(trip.inDays).toBeGreaterThanOrEqual(0);
      expect(trip.inDays).toBeLessThanOrEqual(windowDays);
    }
  });

  it('gives the drivers screen a leave range to render', () => {
    const withLeave = SEED_DRIVERS.filter((d) => d.leave !== undefined);
    expect(withLeave.length).toBeGreaterThan(0);
    for (const driver of withLeave) {
      // Inclusive both ends and forward-running, like every leave in this
      // codebase — a backwards range satisfies no availability query and
      // would silently do nothing.
      expect(driver.leave!.endInDays).toBeGreaterThanOrEqual(driver.leave!.startInDays);
    }
  });

  it('uses day OFFSETS, not fixed calendar dates', () => {
    // A fixed `2026-11-20` stops being "within 14 days" when the month
    // turns, and a demo whose alerts are all empty teaches the owner that
    // the dashboard does not work. The types enforce this; the test says
    // why out loud.
    for (const van of SEED_VANS) {
      expect(typeof van.nextServiceInDays === 'number' || van.nextServiceInDays === null).toBe(
        true,
      );
    }
  });

  it('uses obviously fake franchise numbers', () => {
    // CLAUDE.md: never invent an accreditation number. A plausible-looking
    // one could reach a screenshot and be taken for R&G's real franchise.
    for (const van of SEED_VANS) {
      if (van.franchiseNo !== null) expect(van.franchiseNo).toMatch(/SEED/);
    }
  });

  it('seeds no plaintext PIN anywhere in the seed data', () => {
    // The PIN is generated at seed time, hashed, and never printed. Nothing
    // in the data file may carry one.
    const serialised = JSON.stringify(SEED_DRIVERS);
    expect(serialised).not.toMatch(/\bpin\b/i);
    expect(serialised).not.toMatch(/\b\d{6}\b/);
  });

  it('gives every driver a licence number that is obviously a fixture', () => {
    for (const driver of SEED_DRIVERS) {
      expect(driver.licenseNo).toMatch(/SEED/);
    }
  });
});
