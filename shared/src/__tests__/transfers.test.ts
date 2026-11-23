import { describe, expect, it } from 'vitest';
import { formatDurationMinutes, reverseTransferRouteSlug } from '../transfers';

describe('formatDurationMinutes', () => {
  it('formats minutes as a human duration', () => {
    expect(formatDurationMinutes(45)).toBe('45 min');
    expect(formatDurationMinutes(60)).toBe('1 hr');
    expect(formatDurationMinutes(90)).toBe('1 hr 30 min');
  });
});

describe('reverseTransferRouteSlug', () => {
  it('swaps the two halves of a "-to-" slug, matching the owner\'s own example', () => {
    expect(reverseTransferRouteSlug('mactan-airport-to-moalboal')).toBe(
      'moalboal-to-mactan-airport',
    );
  });

  it('round-trips: reversing twice returns the original', () => {
    const slug = 'mactan-airport-to-hagnaya-port';
    expect(reverseTransferRouteSlug(reverseTransferRouteSlug(slug))).toBe(slug);
  });

  it('falls back to a -return suffix when the slug has no "-to-" segment', () => {
    expect(reverseTransferRouteSlug('airport-transfer')).toBe('airport-transfer-return');
  });
});
