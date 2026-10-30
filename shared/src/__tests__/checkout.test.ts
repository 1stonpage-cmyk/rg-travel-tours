import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  AMOUNT_BELOW_GATEWAY_MINIMUM,
  bookingLookupInput,
  createHoldInput,
  DATE_BLOCKED,
  DATE_NOT_BOOKABLE,
  gatewayMinimumMessage,
  NOTHING_TO_PAY_ONLINE,
  phPhoneSchema,
  quoteInput,
  TOTAL_BELOW_GATEWAY_MINIMUM,
} from '../checkout';
import { PAYMONGO_MIN_CENTAVOS } from '../money';

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

/**
 * Task A4 fix round 1, I2 — **every message that can arrive under the
 * grouped `lead` key names its own field.**
 *
 * `z.flattenError` keys by `issue.path[0]`, so `lead`'s name, email and
 * phone all report under one `fieldErrors.lead` entry. That is deliberate
 * (the client cannot tell which of the three boxes a grouped message belongs
 * to, so `GuestDetails.tsx` renders it against the whole name/email/phone
 * group) and it is only honest while every message the group can carry says
 * which field it is about. Part 1 gave `phone` such a sentence; `name`'s
 * bounds and the email's `.max()` were left as Zod's defaults ("Too big:
 * expected string to have <=160 characters"), which rendered underneath the
 * email and phone rows naming no field at all.
 *
 * So each case asserts THREE things: the grouping still holds (`lead` and
 * nothing else), exactly one message came back (so the assertion cannot pass
 * on a sibling's sentence), and that message names its field in words a
 * guest can act on rather than restating the bound.
 */
describe('createHoldInput.lead — grouped messages still name their field', () => {
  const base = {
    tourSlug: 'oslob-whale-shark-tumalog-falls',
    date: '2026-12-25',
    pax: 2,
    payMode: 'deposit',
    quoteId: QUOTE_ID,
    consent: true,
  };

  /** The messages `server/src/trpc.ts` would publish as `fieldErrors.lead`. */
  function leadMessages(lead: unknown): string[] {
    const result = createHoldInput.safeParse({ ...base, lead });
    expect(result.success, 'the fixture must actually be refused').toBe(false);
    const flat = z.flattenError(result.error!);
    // The grouping is Part 2's design and this fix does not change it.
    expect(Object.keys(flat.fieldErrors)).toEqual(['lead']);
    expect(flat.formErrors).toEqual([]);
    return (flat.fieldErrors as { lead?: string[] }).lead ?? [];
  }

  /** Zod's own bound wording — what must NOT be what a guest reads. */
  const ZOD_BOUND_DEFAULT = /expected string to have/i;

  it('names the NAME field for an over-long name', () => {
    const messages = leadMessages({
      name: 'A'.repeat(161),
      email: 'juan@example.com',
      phone: '09171234567',
    });
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatch(/name/i);
    expect(messages[0]).not.toMatch(ZOD_BOUND_DEFAULT);
  });

  it('names the NAME field for an empty name too', () => {
    const messages = leadMessages({
      name: '',
      email: 'juan@example.com',
      phone: '09171234567',
    });
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatch(/name/i);
  });

  /** The format refusal, which Part 1 already worded. */
  const EMAIL_FORMAT_MESSAGE = 'Enter a valid email address.';

  /**
   * The BOUND and the FORMAT are different facts about the same field, and
   * this is the assertion that keeps them apart.
   *
   * It is not the defect the review expected to find. In Zod 4 the string a
   * format constructor is given is a SCHEMA-level error inherited by every
   * check added after it, so `z.email(msg).max(200)` answered an over-long
   * but perfectly well-formed address with `msg` — "Enter a valid email
   * address." — rather than with Zod's `Too big: expected string to have
   * <=200 characters`. Field-naming, but untrue: nothing is wrong with the
   * address except its length, and a guest told it is invalid will retype a
   * valid address and be refused again. So the bound needs its own sentence,
   * and a test that only asked "does it say email" could not tell the two
   * apart — this one must.
   */
  it('names the EMAIL field, and its LENGTH, for an over-long address', () => {
    // Well-formed (z.email() alone accepts it — measured) and 202 characters,
    // so the `.max(200)` bound is the only thing refusing it.
    const email = `${'a'.repeat(190)}@example.com`;
    expect(email).toHaveLength(202);
    const messages = leadMessages({ name: 'Juan Dela Cruz', email, phone: '09171234567' });

    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatch(/email/i);
    expect(messages[0]).not.toMatch(ZOD_BOUND_DEFAULT);
    expect(
      messages[0],
      'the bound must not inherit the FORMAT sentence — this address is valid, just too long',
    ).not.toBe(EMAIL_FORMAT_MESSAGE);
    expect(messages[0]).toMatch(/200 characters/);
  });

  it('names the EMAIL field for a malformed address', () => {
    const messages = leadMessages({
      name: 'Juan Dela Cruz',
      email: 'nope',
      phone: '09171234567',
    });
    expect(messages).toHaveLength(1);
    expect(messages[0]).toBe(EMAIL_FORMAT_MESSAGE);
  });

  /** Part 1's phone sentence, unchanged — the pattern the other two follow. */
  it('still names the MOBILE field for a bad phone number', () => {
    const messages = leadMessages({
      name: 'Juan Dela Cruz',
      email: 'juan@example.com',
      phone: '02812345678',
    });
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatch(/mobile number/i);
  });
});

/**
 * C1's half of the same rule. `couponCode` is the one field on `quoteInput`
 * a guest types, it is rendered in the coupon field's own error line by
 * `CheckoutPage`, and its bound was reachable with a 41-character
 * `?coupon=` — so its refusal had to stop being written for whoever wrote
 * the bound.
 */
describe('quoteInput.couponCode — the one bound a guest can trip', () => {
  function couponMessages(couponCode: string): string[] {
    const result = quoteInput.safeParse({
      tourSlug: 'oslob-whale-shark-tumalog-falls',
      date: '2026-12-25',
      pax: 2,
      couponCode,
    });
    expect(result.success).toBe(false);
    const flat = z.flattenError(result.error!);
    expect(Object.keys(flat.fieldErrors)).toEqual(['couponCode']);
    return (flat.fieldErrors as { couponCode?: string[] }).couponCode ?? [];
  }

  it('names the coupon code for a code past 40 characters', () => {
    const messages = couponMessages('R'.repeat(41));
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatch(/coupon code/i);
    expect(messages[0]).not.toMatch(/expected string to have/i);
  });

  it('leaves the bound itself exactly where it was', () => {
    const base = { tourSlug: 'x', date: '2026-12-25', pax: 2 };
    expect(quoteInput.safeParse({ ...base, couponCode: 'R'.repeat(40) }).success).toBe(true);
    expect(quoteInput.safeParse({ ...base, couponCode: 'R'.repeat(41) }).success).toBe(false);
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

/**
 * BUG-110 fix round 1. One sentence used to answer three different situations
 * and was wrong in two of them: it told a guest to "pay in full instead" when
 * the full total was ALSO under the floor (the same refusal again), and told a
 * guest whose total was exactly nothing to pay it by bank transfer (there is
 * nothing to pay, by any method).
 *
 * The rule this pins: **the message never names an alternative that does not
 * exist for the guest reading it.** The total is what decides that, because
 * `amount_due_now` for `full` IS the total.
 */
describe('gatewayMinimumMessage (BUG-110 fix round 1)', () => {
  it('offers pay-in-full when the total really does clear the floor', () => {
    // Case 1, the original BUG-110 shape: a ₱300 tour's 30% deposit is ₱90,
    // and the ₱300 total genuinely goes through in one charge.
    const message = gatewayMinimumMessage(30000);

    expect(message).toBe(AMOUNT_BELOW_GATEWAY_MINIMUM);
    expect(message).toMatch(/in full/i);
    expect(message).toMatch(/contact us/i);
    expect(message).toContain('₱100');
  });

  it('does NOT offer pay-in-full when the total is itself under the floor', () => {
    // Case 2: a 90%-off coupon on a ₱900 tour leaves ₱90 to pay. BOTH modes
    // are refused, so "pay in full instead" is the same refusal reworded.
    const message = gatewayMinimumMessage(9000);

    expect(message).toBe(TOTAL_BELOW_GATEWAY_MINIMUM);
    expect(message, 'both pay modes are refused — paying in full is not a way out').not.toMatch(
      /in full/i,
    );
    expect(message).toMatch(/contact us/i);
    expect(message).toMatch(/bank transfer|QR code/i);
    expect(message).toContain('₱100');
  });

  it('offers NEITHER payment route when the total is nothing at all', () => {
    // Case 3: a 100%-off coupon, or a fixed discount at or above the subtotal.
    const message = gatewayMinimumMessage(0);

    expect(message).toBe(NOTHING_TO_PAY_ONLINE);
    expect(message).toMatch(/nothing to pay/i);
    expect(message).toMatch(/contact us/i);
    expect(message, 'there is no amount to pay in full').not.toMatch(/in full/i);
    expect(message, 'there is no amount to transfer either').not.toMatch(/bank transfer|QR code/i);
    expect(message, 'a floor is meaningless when the total is zero').not.toContain('₱100');
  });

  it('bands on the floor itself, and treats an impossible total as nothing to pay', () => {
    expect(gatewayMinimumMessage(PAYMONGO_MIN_CENTAVOS)).toBe(AMOUNT_BELOW_GATEWAY_MINIMUM);
    expect(gatewayMinimumMessage(PAYMONGO_MIN_CENTAVOS - 1)).toBe(TOTAL_BELOW_GATEWAY_MINIMUM);
    expect(gatewayMinimumMessage(1)).toBe(TOTAL_BELOW_GATEWAY_MINIMUM);
    // Should be unreachable; it still must not get a sentence that lies.
    expect(gatewayMinimumMessage(-1)).toBe(NOTHING_TO_PAY_ONLINE);
  });

  it.each([
    ['deposit short', AMOUNT_BELOW_GATEWAY_MINIMUM],
    ['total short', TOTAL_BELOW_GATEWAY_MINIMUM],
    ['nothing to pay', NOTHING_TO_PAY_ONLINE],
  ])('names no gateway, provider or internal unit: %s', (_band, message) => {
    expect(message).not.toMatch(/paymongo|gateway|centavos/i);
  });
});

/**
 * Final whole-branch review, F4: the availability reason strings are WIRE
 * contracts with one definition each, and this is the guard that keeps them
 * that way.
 *
 * It is here because the typechecker structurally cannot catch the failure:
 * two independent `export const X = 'date_blocked' as const` declarations
 * produce the identical literal type, so a duplicate compiles, passes every
 * test, and then drifts the first time either side is renamed — at which
 * point one surface tells a guest the wrong thing. This week fixed that
 * exact defect twice by hand (`date_not_bookable` was defined in both
 * `shared/src/checkout.ts` and `server/src/services/create-hold.ts`);
 * a scan is cheaper than a third round of it.
 *
 * Scoped to a DECLARATION of the literal (`= 'date_blocked'`), not to any
 * mention: the server and client are expected to IMPORT and compare these
 * constants freely, and the tests that assert the wire value (this file's
 * siblings in `server/` and `client/`) legitimately spell the literal out.
 */
describe('one definition per availability reason (wire contracts)', () => {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

  function collectSourceFiles(dir: string): string[] {
    return readdirSync(dir).flatMap((entry) => {
      if (entry === 'node_modules' || entry === 'dist' || entry === '__tests__') return [];
      const p = join(dir, entry);
      if (statSync(p).isDirectory()) return collectSourceFiles(p);
      return extname(p) === '.ts' || extname(p) === '.tsx' ? [p] : [];
    });
  }

  const sources = ['shared/src', 'server/src', 'client/src'].flatMap((d) =>
    collectSourceFiles(join(repoRoot, d)),
  );

  it.each([
    ['date_not_bookable', DATE_NOT_BOOKABLE],
    ['date_blocked', DATE_BLOCKED],
  ])('declares %s exactly once, in @rg/shared', (literal, value) => {
    expect(value, 'the constant must carry the literal this test scans for').toBe(literal);

    // `= 'date_blocked'` — an assignment of the literal, which is what a
    // second definition looks like however it is exported. All three quote
    // styles, because a duplicate would not be courteous enough to match
    // this file's own formatting.
    const spellings = [`= '${literal}'`, `= "${literal}"`, '= `' + literal + '`'];
    const declaringFiles = sources
      .filter((file) => {
        const text = readFileSync(file, 'utf8');
        return spellings.some((spelling) => text.includes(spelling));
      })
      .map((file) =>
        file
          .slice(repoRoot.length + 1)
          .split(sep)
          .join('/'),
      );

    expect(
      declaringFiles,
      `"${literal}" is a wire contract with ONE definition. Import it from @rg/shared ` +
        `instead of declaring it again — the typechecker cannot tell two identical ` +
        `literal types apart, so a duplicate would drift silently.`,
    ).toEqual(['shared/src/checkout.ts']);
  });
});
