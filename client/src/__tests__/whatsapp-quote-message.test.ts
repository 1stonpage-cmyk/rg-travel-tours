/**
 * WhatsApp quote-message plan (owner spec, 2026-11-28), Task 1A/1C —
 * the shared `{{token}}` substitution helper (`lib/tokens.ts`, CLAUDE.md's
 * "a second token type requires one shared helper" rule) and the
 * `withDetails` builder built on top of it (`lib/whatsapp-message.ts`).
 *
 * Component-level `wa.me` href assertions live beside each component's own
 * existing test file (`floating-whatsapp.test.tsx`, `layout.test.tsx`,
 * `transfer-route-page.test.tsx`, `transfer-booking-page.test.tsx`) rather
 * than being duplicated here.
 */
import { describe, expect, it } from 'vitest';
import { substituteTokens } from '@/lib/tokens';
import { buildWithDetailsMessage, WHATSAPP_MESSAGE_TOKENS } from '@/lib/whatsapp-message';

describe('substituteTokens', () => {
  it('fills a token that sits inline within a sentence (the {{paymentMethods}} shape)', () => {
    expect(
      substituteTokens('We accept {{paymentMethods}} today.', { paymentMethods: 'GCash and Maya' }),
    ).toBe('We accept GCash and Maya today.');
  });

  it('fills tokens that each sit alone on a labelled line (the withDetails shape)', () => {
    const result = substituteTokens('Route: {{route}}\nDate: {{date}}', {
      route: 'Airport to Moalboal',
      date: '2026-12-10',
    });
    expect(result).toBe('Route: Airport to Moalboal\nDate: 2026-12-10');
  });

  it('drops a line whose only token resolves empty — not just the token, the whole line', () => {
    const result = substituteTokens('Route: {{route}}\nBags: {{bags}}\nPlease confirm.', {
      route: 'Airport to Moalboal',
      bags: '',
    });
    expect(result).toBe('Route: Airport to Moalboal\nPlease confirm.');
  });

  it('keeps a line with no token at all, untouched', () => {
    expect(substituteTokens('Please confirm the price and pickup details.', {})).toBe(
      'Please confirm the price and pickup details.',
    );
  });

  it('drops every line when every token is empty, leaving an empty string', () => {
    expect(substituteTokens('Route: {{route}}\nBags: {{bags}}', { route: '', bags: '' })).toBe('');
  });

  /** Proves the test above can fail: a helper that never drops anything would wrongly keep both labels. */
  it('[can-fail check] a no-op substitution would NOT equal the dropped-line result', () => {
    const noDrop = 'Route: {{route}}\nBags: {{bags}}'
      .replace('{{route}}', '')
      .replace('{{bags}}', '');
    expect(noDrop).not.toBe(
      substituteTokens('Route: {{route}}\nBags: {{bags}}', { route: '', bags: '' }),
    );
  });
});

describe('buildWithDetailsMessage', () => {
  const TEMPLATE =
    "Hi TravelSugbo! I'd like a quote for a private transfer.\n\n" +
    'Route: {{route}}\nTrip: {{trip}}\nDate: {{date}}\nPassengers: {{passengers}}\n' +
    'Bags: {{bags}}\nVehicle: {{vehicle}}\nPickup: {{pickup}}\n\n' +
    'Please confirm the price and pickup details.';

  it('fills in whatever is known and drops every line whose token is still blank', () => {
    const result = buildWithDetailsMessage(TEMPLATE, {
      route: 'Mactan-Cebu Airport to Moalboal',
      passengers: '2',
    });
    expect(result).toContain('Route: Mactan-Cebu Airport to Moalboal');
    expect(result).toContain('Passengers: 2');
    expect(result).not.toContain('Trip:');
    expect(result).not.toContain('Bags:');
    expect(result).not.toContain('Vehicle:');
    expect(result).not.toContain('Pickup:');
    // The closing line has no token and always survives.
    expect(result).toContain('Please confirm the price and pickup details.');
  });

  it('trims a value before substituting it', () => {
    expect(buildWithDetailsMessage('Route: {{route}}', { route: '  A to B  ' })).toBe(
      'Route: A to B',
    );
  });

  it('leaves no literal {{token}} braces behind, even for an unfilled token', () => {
    const result = buildWithDetailsMessage('Pickup: {{pickup}}', {});
    expect(result).not.toMatch(/\{\{/);
  });

  /**
   * No guest-identifying field is an allowed token at all — a quote message
   * built from this list can never carry an email or phone number, by
   * construction, regardless of what any caller passes in.
   */
  it('never allows an email or phone token', () => {
    expect(WHATSAPP_MESSAGE_TOKENS).not.toContain('email');
    expect(WHATSAPP_MESSAGE_TOKENS).not.toContain('phone');
    expect(WHATSAPP_MESSAGE_TOKENS).not.toContain('name');
  });

  /**
   * `phone` is not an allowed token (see the test above), so even a template
   * an admin hand-wrote with `{{phone}}` in it can never be filled from a
   * guest's number — the line just drops, exactly like any other unknown
   * token, never rendering the number AND never leaking raw `{{phone}}`
   * brace text to a guest's chat app either.
   */
  it('[can-fail check] an unlisted token like {{phone}} is never filled — its line drops, same as any unknown token', () => {
    const result = buildWithDetailsMessage('Phone: {{phone}}\nRoute: {{route}}', {
      route: 'Airport to Moalboal',
    });
    expect(result).toBe('Route: Airport to Moalboal');
    expect(result).not.toContain('{{phone}}');
    expect(result).not.toContain('+639');
  });
});
