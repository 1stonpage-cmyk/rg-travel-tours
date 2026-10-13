import { describe, expect, it } from 'vitest';
import { SETTING_SCHEMAS } from '../content/settings-schema';

describe('settings schemas', () => {
  it('rejects business hours that are not exactly seven days', () => {
    const six = Array.from({ length: 6 }, (_, i) => ({
      weekday: i,
      opensAt: '07:00',
      closesAt: '21:00',
      isClosed: false,
    }));
    expect(SETTING_SCHEMAS.business_hours.safeParse(six).success).toBe(false);
  });

  it('rejects a malformed clock time', () => {
    const bad = Array.from({ length: 7 }, (_, i) => ({
      weekday: i,
      opensAt: '7am',
      closesAt: '21:00',
      isClosed: false,
    }));
    expect(SETTING_SCHEMAS.business_hours.safeParse(bad).success).toBe(false);
  });

  it('accepts exactly seven well-formed days', () => {
    const seven = Array.from({ length: 7 }, (_, i) => ({
      weekday: i,
      opensAt: '07:00',
      closesAt: '21:00',
      isClosed: false,
    }));
    expect(SETTING_SCHEMAS.business_hours.safeParse(seven).success).toBe(true);
  });

  it('only allows info and warning announcement styles — never an error/red style', () => {
    const base = { message: 'x', href: null, startsAt: null, endsAt: null, isActive: true };
    expect(SETTING_SCHEMAS.announcement.safeParse({ ...base, style: 'info' }).success).toBe(true);
    expect(SETTING_SCHEMAS.announcement.safeParse({ ...base, style: 'warning' }).success).toBe(
      true,
    );
    expect(SETTING_SCHEMAS.announcement.safeParse({ ...base, style: 'error' }).success).toBe(false);
    expect(SETTING_SCHEMAS.announcement.safeParse({ ...base, style: 'danger' }).success).toBe(
      false,
    );
  });

  it('permits may be null but never an empty string pretending to be a number', () => {
    expect(SETTING_SCHEMAS.permits.safeParse({ dot: null, dti: null, bir: null }).success).toBe(
      true,
    );
    expect(SETTING_SCHEMAS.permits.safeParse({ dot: '', dti: null, bir: null }).success).toBe(
      false,
    );
  });

  it('accepts a real permit string', () => {
    expect(
      SETTING_SCHEMAS.permits.safeParse({ dot: 'DOT-R-123', dti: null, bir: null }).success,
    ).toBe(true);
  });

  it('requires startsAt/endsAt to be ISO-8601 datetimes or null, never bare dates', () => {
    const base = {
      code: 'EARLYBIRD',
      discountLabel: '10% off',
      headline: 'Book early',
      body: 'Save on your next trip',
      isActive: true,
    };
    expect(
      SETTING_SCHEMAS.promo.safeParse({
        ...base,
        startsAt: '2026-10-01T16:00:00.000Z',
        endsAt: null,
      }).success,
    ).toBe(true);
    expect(
      SETTING_SCHEMAS.promo.safeParse({ ...base, startsAt: '2026-10-01', endsAt: null }).success,
    ).toBe(false);
  });

  it('trust.minReviewsForRating (Task 1.9, R1) must be a positive integer', () => {
    const base = {
      ratingAverage: 4.9,
      ratingCount: 120,
      guestsServed: 15000,
      dotAccredited: true,
      depositPercent: 30,
    };
    expect(SETTING_SCHEMAS.trust.safeParse({ ...base, minReviewsForRating: 3 }).success).toBe(true);
    expect(SETTING_SCHEMAS.trust.safeParse({ ...base, minReviewsForRating: 0 }).success).toBe(
      false,
    );
    expect(SETTING_SCHEMAS.trust.safeParse({ ...base, minReviewsForRating: 2.5 }).success).toBe(
      false,
    );
    expect(SETTING_SCHEMAS.trust.safeParse(base).success).toBe(false); // missing entirely
  });

  it('rejects content_unverified when it is not a boolean', () => {
    expect(SETTING_SCHEMAS.content_unverified.safeParse(true).success).toBe(true);
    expect(SETTING_SCHEMAS.content_unverified.safeParse('true').success).toBe(false);
  });

  /**
   * The `booking` block (owner decision 2026-10-13, pending R&G), and in
   * particular the refinement that `maxAdvanceDays` cannot sit below
   * `minLeadDays`.
   *
   * That combination is a typo rather than a policy: it leaves NO bookable
   * date at all, so the site would quietly sell nothing. `isDateBookable()`
   * also fails closed on such a window, which is the second of the two layers
   * — but a layer with no test is an unproven control, and this is the one
   * that stops the bad value being stored in the first place.
   */
  it('accepts a well-formed booking window', () => {
    expect(
      SETTING_SCHEMAS.booking.safeParse({
        minLeadDays: 1,
        nextDayCutoffTime: '18:00',
        maxAdvanceDays: 180,
      }).success,
    ).toBe(true);
    // A zero lead (same-day booking allowed) is a legitimate policy too.
    expect(
      SETTING_SCHEMAS.booking.safeParse({
        minLeadDays: 0,
        nextDayCutoffTime: '00:00',
        maxAdvanceDays: 1,
      }).success,
    ).toBe(true);
  });

  it('refuses a booking window that cannot contain a single date', () => {
    expect(
      SETTING_SCHEMAS.booking.safeParse({
        minLeadDays: 5,
        nextDayCutoffTime: '18:00',
        maxAdvanceDays: 1,
      }).success,
      'maxAdvanceDays below minLeadDays leaves no bookable date',
    ).toBe(false);
  });

  it('refuses a cutoff that is not a zero-padded 24-hour HH:MM', () => {
    for (const nextDayCutoffTime of ['6pm', '18:00:00', '8:00', '24:00', '18.00', '']) {
      expect(
        SETTING_SCHEMAS.booking.safeParse({
          minLeadDays: 1,
          nextDayCutoffTime,
          maxAdvanceDays: 180,
        }).success,
        `"${nextDayCutoffTime}" was accepted as a cutoff`,
      ).toBe(false);
    }
  });

  it('refuses a fractional or negative lead, and a zero-day window', () => {
    const base = { nextDayCutoffTime: '18:00', maxAdvanceDays: 180 };
    expect(SETTING_SCHEMAS.booking.safeParse({ ...base, minLeadDays: 1.5 }).success).toBe(false);
    expect(SETTING_SCHEMAS.booking.safeParse({ ...base, minLeadDays: -1 }).success).toBe(false);
    expect(
      SETTING_SCHEMAS.booking.safeParse({
        minLeadDays: 0,
        nextDayCutoffTime: '18:00',
        maxAdvanceDays: 0,
      }).success,
      'a zero-day window is not a window',
    ).toBe(false);
  });

  /**
   * `payment_qr` (Week 4 Task 8; owner decision 2026-10-14, Q3).
   *
   * The refinement is the part worth testing: `isConfigured` is a claim
   * about three other fields, and a true flag with nothing behind it would
   * turn the manual-transfer option on at checkout and then show a guest an
   * empty account number. So it fails closed.
   */
  describe('payment_qr', () => {
    const schema = SETTING_SCHEMAS.payment_qr;
    const EMPTY = {
      imagePath: null,
      accountName: null,
      accountNumber: null,
      instructions: null,
      isConfigured: false,
    };

    it('accepts the EMPTY shape the seed ships', () => {
      expect(schema.safeParse(EMPTY).success).toBe(true);
    });

    it('accepts a fully configured block', () => {
      expect(
        schema.safeParse({
          imagePath: 'a1b2c3d4e5f60718293a4b5c6d7e8f90.png',
          accountName: 'R&G Travel and Tours',
          accountNumber: '0917 000 0000',
          instructions: 'Put your booking reference in the notes.',
          isConfigured: true,
        }).success,
      ).toBe(true);
    });

    /** The whole point of the refinement. */
    it('REFUSES isConfigured: true with nothing behind it', () => {
      expect(schema.safeParse({ ...EMPTY, isConfigured: true }).success).toBe(false);
      expect(
        schema.safeParse({
          ...EMPTY,
          imagePath: 'a1b2c3d4e5f60718293a4b5c6d7e8f90.png',
          isConfigured: true,
        }).success,
        'an image with no account name or number is not a payment instruction',
      ).toBe(false);
      expect(
        schema.safeParse({
          imagePath: 'a1b2c3d4e5f60718293a4b5c6d7e8f90.png',
          accountName: '   ',
          accountNumber: '0917 000 0000',
          instructions: null,
          isConfigured: true,
        }).success,
        'whitespace is not an account name',
      ).toBe(false);
    });

    it('allows instructions to be absent on a configured block', () => {
      expect(
        schema.safeParse({
          imagePath: 'a1b2c3d4e5f60718293a4b5c6d7e8f90.png',
          accountName: 'R&G Travel and Tours',
          accountNumber: '0917 000 0000',
          instructions: null,
          isConfigured: true,
        }).success,
      ).toBe(true);
    });
  });

  /**
   * Fifteen from the dynamic-site plan, plus `booking` (the bookable date
   * window, owner decision 2026-10-13) and `payment_qr` (the R&G payment QR
   * and account, owner decision 2026-10-14 Q3). Listed out rather than
   * derived, so ADDING a key is a deliberate edit here: every key is a row
   * `readSettings()` requires, and a key added without a seed row takes the
   * whole public site down until the seed runs.
   */
  it('covers all 17 settings keys — the 15 from the plan, plus booking and payment_qr', () => {
    const expectedKeys = [
      'content_unverified',
      'site_seo',
      'trust',
      'hero',
      'announcement',
      'promo',
      'business_hours',
      'payment_methods',
      'permits',
      'how_it_works',
      'why_book_direct',
      'faqs',
      'contact',
      'legal_privacy',
      'legal_terms',
      'booking',
      'payment_qr',
    ];
    expect(Object.keys(SETTING_SCHEMAS).sort()).toEqual(expectedKeys.sort());
  });
});
