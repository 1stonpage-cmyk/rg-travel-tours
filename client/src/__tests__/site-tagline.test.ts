import { describe, expect, it } from 'vitest';
import { siteTagline, phoneWhatsappLink, phoneViberLink } from '@/lib/site';

/**
 * Owner decision 2026-11-11, 1C: the public footer tagline must be
 * product-neutral while `show_tours` is off. Same shape as `visibleNav`
 * above it in lib/site.ts — an exported function taking the boolean,
 * `SITE.tagline` itself left untouched for every caller that still reads it
 * unconditionally.
 */
describe('siteTagline', () => {
  // Task 6 (3C): `SITE.tagline` was generalised from tour-only wording to
  // transfers wording, so both branches currently return the identical
  // string — not a bug (see the comment above `TRANSFERS_TAGLINE` in
  // lib/site.ts), just no longer two DIFFERENT strings to tell apart.
  it('returns SITE.tagline when show_tours is on', () => {
    expect(siteTagline(true)).toBe(
      'Private airport and island transfers across Cebu, booked direct.',
    );
  });

  it('returns the transfers-wording tagline when show_tours is off', () => {
    expect(siteTagline(false)).toBe(
      'Private airport and island transfers across Cebu, booked direct.',
    );
  });
});

describe('phoneWhatsappLink', () => {
  it('builds a wa.me link from an E.164 phone number', () => {
    expect(phoneWhatsappLink('+15551234567')).toBe('https://wa.me/15551234567');
  });

  it('encodes an optional message', () => {
    const link = phoneWhatsappLink('+15551234567', 'Hello World');
    expect(link).toContain('https://wa.me/15551234567?text=');
    expect(link).toContain('Hello%20World');
  });

  it('handles PH numbers', () => {
    expect(phoneWhatsappLink('+639171234567')).toBe('https://wa.me/639171234567');
  });
});

describe('phoneViberLink', () => {
  it('builds a viber:// link from an E.164 phone number', () => {
    expect(phoneViberLink('+15551234567')).toBe('viber://chat?number=%2B15551234567');
  });

  it('percent-encodes the plus sign', () => {
    const link = phoneViberLink('+639171234567');
    expect(link).toContain('%2B');
    expect(link).toContain('639171234567');
  });
});
