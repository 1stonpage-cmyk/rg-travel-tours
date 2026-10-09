import { describe, expect, it } from 'vitest';
import { isWithinWindow } from '../services/schedule';

// Manila is UTC+8 with no DST. Midnight on 2 Oct 2026 in Manila is
// 2026-10-01T16:00:00Z — the window must open exactly then, not at 00:00 UTC.
const MANILA_MIDNIGHT_OCT_2 = '2026-10-01T16:00:00.000Z';
const MANILA_END_OCT_5 = '2026-10-05T15:59:59.000Z';

describe('promo and announcement windows', () => {
  it('is closed one second before Manila midnight', () => {
    expect(
      isWithinWindow(MANILA_MIDNIGHT_OCT_2, MANILA_END_OCT_5, new Date('2026-10-01T15:59:59.000Z')),
    ).toBe(false);
  });

  it('opens exactly at Manila midnight', () => {
    expect(
      isWithinWindow(MANILA_MIDNIGHT_OCT_2, MANILA_END_OCT_5, new Date('2026-10-01T16:00:00.000Z')),
    ).toBe(true);
  });

  it('is still open at the last second of the final Manila day', () => {
    expect(
      isWithinWindow(MANILA_MIDNIGHT_OCT_2, MANILA_END_OCT_5, new Date('2026-10-05T15:59:59.000Z')),
    ).toBe(true);
  });

  it('closes once the window has passed', () => {
    expect(
      isWithinWindow(MANILA_MIDNIGHT_OCT_2, MANILA_END_OCT_5, new Date('2026-10-05T16:00:00.000Z')),
    ).toBe(false);
  });

  it('treats a null bound as open-ended', () => {
    expect(isWithinWindow(null, null, new Date())).toBe(true);
    expect(isWithinWindow(null, MANILA_END_OCT_5, new Date('2020-01-01T00:00:00Z'))).toBe(true);
    expect(isWithinWindow(MANILA_MIDNIGHT_OCT_2, null, new Date('2030-01-01T00:00:00Z'))).toBe(
      true,
    );
  });
});
