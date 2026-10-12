import { describe, expect, it } from 'vitest';
import { bookingLookupInput, createHoldInput, phPhoneSchema, quoteInput } from '../checkout';

/** A valid quoteId shape for fixtures that don't test the quoteId rule itself. */
const QUOTE_ID = 'a'.repeat(32);

describe('quoteInput', () => {
  it('accepts a minimal quote request', () => {
    expect(
      quoteInput.safeParse({
        tourSlug: 'oslob-whale-shark-tumalog-falls',
        date: '2026-12-25',
        pax: 4,
      }).success,
    ).toBe(true);
  });

  it('REFUSES any money field the browser tries to send', () => {
    const withMoney = {
      tourSlug: 'oslob-whale-shark-tumalog-falls',
      date: '2026-12-25',
      pax: 4,
      totalCentavos: 1,
    };
    // .strict(): an unknown key is a rejection, not a silently dropped field.
    // The server computes all money (CLAUDE.md); a client that sends a price
    // should get an error, not have it quietly ignored.
    expect(quoteInput.safeParse(withMoney).success).toBe(false);
  });

  it('refuses a pax count outside 1..12', () => {
    const base = { tourSlug: 'x', date: '2026-12-25' };
    expect(quoteInput.safeParse({ ...base, pax: 0 }).success).toBe(false);
    expect(quoteInput.safeParse({ ...base, pax: 13 }).success).toBe(false);
  });

  it('refuses a date that is not a civil YYYY-MM-DD', () => {
    const base = { tourSlug: 'x', pax: 2 };
    expect(quoteInput.safeParse({ ...base, date: '25/12/2026' }).success).toBe(false);
    expect(quoteInput.safeParse({ ...base, date: '2026-12-25T00:00:00Z' }).success).toBe(false);
  });
});

/**
 * Owner decision 2026-10-12 (delta (a)): the PH mobile rule is now decided.
 * One schema, exported, so checkout and booking lookup cannot drift on what
 * counts as a valid Philippine mobile number.
 */
describe('phPhoneSchema', () => {
  it('accepts the 09XXXXXXXXX form', () => {
    const result = phPhoneSchema.safeParse('09171234567');
    expect(result.success).toBe(true);
  });

  it('accepts the +639XXXXXXXXX form', () => {
    const result = phPhoneSchema.safeParse('+639171234567');
    expect(result.success).toBe(true);
  });

  it('accepts a spaced form, like the seed data uses', () => {
    const result = phPhoneSchema.safeParse('0908 469 6246');
    expect(result.success).toBe(true);
  });

  it('accepts a dashed form', () => {
    const result = phPhoneSchema.safeParse('0908-469-6246');
    expect(result.success).toBe(true);
  });

  it('normalises every accepted form to +639XXXXXXXXX', () => {
    expect(phPhoneSchema.parse('09171234567')).toBe('+639171234567');
    expect(phPhoneSchema.parse('+639171234567')).toBe('+639171234567');
    expect(phPhoneSchema.parse('0908 469 6246')).toBe('+639084696246');
    expect(phPhoneSchema.parse('0908-469-6246')).toBe('+639084696246');
  });

  it('rejects a landline-shaped number (wrong prefix)', () => {
    expect(phPhoneSchema.safeParse('02812345678').success).toBe(false);
  });

  it('rejects a number with the wrong length', () => {
    expect(phPhoneSchema.safeParse('0917123456').success).toBe(false); // 10 digits
    expect(phPhoneSchema.safeParse('091712345678').success).toBe(false); // 12 digits
  });

  it('rejects a non-PH country code', () => {
    expect(phPhoneSchema.safeParse('+14155552671').success).toBe(false);
  });

  it('rejects letters', () => {
    expect(phPhoneSchema.safeParse('0917abc4567').success).toBe(false);
  });
});

describe('createHoldInput', () => {
  it('requires the data-privacy consent to be true', () => {
    const base = {
      tourSlug: 'x',
      date: '2026-12-25',
      pax: 2,
      payMode: 'deposit',
      quoteId: QUOTE_ID,
      lead: { name: 'A', email: 'a@b.com', phone: '09171234567' },
    };
    expect(createHoldInput.safeParse({ ...base, consent: false }).success).toBe(false);
    expect(createHoldInput.safeParse({ ...base }).success).toBe(false);
    expect(createHoldInput.safeParse({ ...base, consent: true }).success).toBe(true);
  });

  /**
   * Owner decision Q3 (delta (b)): the quote carries a short-lived
   * server-side quote id so a price cannot be replayed after an admin edits
   * a price tier. It must be exactly 32 lowercase hex characters (a
   * truncated SHA-256 digest) — Task 2 produces it, this task only pins its
   * shape.
   */
  it('refuses a malformed quoteId', () => {
    const base = {
      tourSlug: 'x',
      date: '2026-12-25',
      pax: 2,
      payMode: 'deposit',
      lead: { name: 'A', email: 'a@b.com', phone: '09171234567' },
      consent: true,
    };
    expect(createHoldInput.safeParse({ ...base, quoteId: QUOTE_ID }).success).toBe(true);
    expect(createHoldInput.safeParse({ ...base, quoteId: 'too-short' }).success).toBe(false);
    expect(createHoldInput.safeParse({ ...base, quoteId: 'A'.repeat(32) }).success).toBe(false); // uppercase
    expect(createHoldInput.safeParse({ ...base }).success).toBe(false); // missing
  });
});

describe('bookingLookupInput', () => {
  it('accepts a booking ref and email', () => {
    expect(bookingLookupInput.safeParse({ ref: 'RG-7KQ4M9', email: 'a@b.com' }).success).toBe(true);
  });

  it('REFUSES any money field the browser tries to send', () => {
    expect(
      bookingLookupInput.safeParse({
        ref: 'RG-7KQ4M9',
        email: 'a@b.com',
        totalCentavos: 1,
      }).success,
    ).toBe(false);
  });
});
