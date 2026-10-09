import { describe, expect, it } from 'vitest';
import { manilaParts, manilaTimeHHMM } from './time';

describe('manilaParts', () => {
  it('reads Manila midnight correctly from the equivalent UTC instant', () => {
    // 2026-10-01T16:00:00Z is exactly midnight in Asia/Manila (UTC+8) on
    // 2 Oct 2026 — the same instant task-1.5's schedule tests pin as the
    // start of a promo/announcement window.
    const parts = manilaParts(new Date('2026-10-01T16:00:00.000Z'));
    expect(parts).toEqual({
      year: 2026,
      month: 10,
      day: 2,
      hour: 0,
      minute: 0,
      second: 0,
      weekday: 5, // Friday
    });
  });

  it('converts a UTC instant to the correct Manila clock time and weekday', () => {
    // 2026-10-09T02:00:00Z + 8h = 2026-10-09T10:00 Manila, a Friday.
    const parts = manilaParts(new Date('2026-10-09T02:00:00.000Z'));
    expect(parts.hour).toBe(10);
    expect(parts.minute).toBe(0);
    expect(parts.weekday).toBe(5); // Friday
  });

  it('rolls the Manila calendar day forward across a UTC date boundary', () => {
    // 2026-10-08T22:00:00Z + 8h = 2026-10-09T06:00 Manila — a different
    // calendar day in Manila than in UTC.
    const parts = manilaParts(new Date('2026-10-08T22:00:00.000Z'));
    expect(parts.day).toBe(9);
    expect(parts.hour).toBe(6);
  });

  it('never reports hour 24 for Manila midnight', () => {
    const parts = manilaParts(new Date('2026-10-01T16:00:00.000Z'));
    expect(parts.hour).toBe(0);
  });
});

describe('manilaTimeHHMM', () => {
  it('zero-pads hour and minute', () => {
    expect(manilaTimeHHMM(new Date('2026-10-09T02:00:00.000Z'))).toBe('10:00');
    expect(manilaTimeHHMM(new Date('2026-10-01T16:00:00.000Z'))).toBe('00:00');
  });
});
