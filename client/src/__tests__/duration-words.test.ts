import { describe, expect, it } from 'vitest';
import { friendlyDuration } from '@/lib/duration-words';

/**
 * Owner decision 2026-11-10 (Decision 6): a transfer's estimated duration is
 * an estimate, and the copy must say so — "about 45 min", not "~45 min" or a
 * bare number. Three shapes, matching the owner's own three examples.
 */
describe('friendlyDuration', () => {
  it('formats under an hour as "about N min"', () => {
    expect(friendlyDuration(45)).toBe('about 45 min');
  });

  it('formats an exact number of hours as "about N hr"', () => {
    expect(friendlyDuration(180)).toBe('about 3 hr');
  });

  it('formats hours plus minutes as "about N hr M min"', () => {
    expect(friendlyDuration(210)).toBe('about 3 hr 30 min');
  });

  it('formats a single minute without a plural mismatch in the surrounding words', () => {
    expect(friendlyDuration(1)).toBe('about 1 min');
  });
});
