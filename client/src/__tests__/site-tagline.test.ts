import { describe, expect, it } from 'vitest';
import { siteTagline } from '@/lib/site';

/**
 * Owner decision 2026-11-11, 1C: the public footer tagline must be
 * product-neutral while `show_tours` is off. Same shape as `visibleNav`
 * above it in lib/site.ts — an exported function taking the boolean,
 * `SITE.tagline` itself left untouched for every caller that still reads it
 * unconditionally.
 */
describe('siteTagline', () => {
  it('returns the existing tour-wording tagline when show_tours is on', () => {
    expect(siteTagline(true)).toBe('Cebu day tours and multi-day packages, booked direct.');
  });

  it('returns the transfers-wording tagline when show_tours is off', () => {
    expect(siteTagline(false)).toBe(
      'Private airport and island transfers across Cebu, booked direct.',
    );
  });
});
