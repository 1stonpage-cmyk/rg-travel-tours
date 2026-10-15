/**
 * `driverTripBucket` — the pure half of the driver portal's trip list
 * (Week 6 plan, Task 2; BUILD_SPEC §8).
 *
 * **It lives in `/shared` so the tabs and the server cannot disagree about
 * which day it is, and so its test belongs here** — moved out of
 * `server/src/__tests__/driver-trips.test.ts` (review finding, Task 2),
 * where `pnpm --filter @rg/shared test` never saw it. The server suite
 * keeps the half that needs a server: which Manila civil date the resolver
 * picks to bucket against.
 */
import { describe, expect, it } from 'vitest';
import { driverTripBucket } from './driver';
import { manilaCivilDate } from './time';

describe('driverTripBucket', () => {
  it('buckets by the MANILA civil date, not the UTC one', () => {
    // 2026-11-10 23:30 Manila is 15:30 UTC the same day; 00:30 Manila on the
    // 11th is 16:30 UTC on the 10th, and a UTC-based bucket would put that
    // driver on yesterday's trips while they are standing next to the van.
    expect(driverTripBucket('2026-11-11', '2026-11-11')).toBe('today');
    expect(driverTripBucket('2026-11-12', '2026-11-11')).toBe('upcoming');
    expect(driverTripBucket('2026-11-10', '2026-11-11')).toBe('history');
    // The boundary the civil date exists for: 16:30 UTC on the 10th IS the
    // 11th in Manila, so a trip on the 11th is TODAY at that instant.
    expect(driverTripBucket('2026-11-11', manilaCivilDate(new Date('2026-11-10T16:30:00Z')))).toBe(
      'today',
    );
    // And one minute earlier it is still the 10th there, so the same trip is
    // upcoming. A `toISOString().slice(0, 10)` bucket gets both of these wrong.
    expect(driverTripBucket('2026-11-11', manilaCivilDate(new Date('2026-11-10T15:59:00Z')))).toBe(
      'upcoming',
    );
  });
});
