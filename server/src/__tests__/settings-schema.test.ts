import { describe, expect, it } from 'vitest';
import { SETTING_SCHEMAS, upgradeLegacyPermits } from '../content/settings-schema';

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

  describe('permits (accreditation list, Task 1A)', () => {
    const BUILTIN_ITEMS = [
      { key: 'dot', label: 'DOT Accreditation No.', number: null, show: false, builtin: true },
      { key: 'dti', label: 'DTI Registration No.', number: null, show: false, builtin: true },
      { key: 'bir', label: 'BIR TIN', number: null, show: false, builtin: true },
    ];

    it('upgrades the old { dot, dti, bir } shape, defaulting every item to hidden', () => {
      const result = SETTING_SCHEMAS.permits.safeParse({ dot: null, dti: null, bir: null });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toEqual({ items: BUILTIN_ITEMS });
      }
    });

    it('upgrades an old shape with a real value onto the matching builtin, still hidden', () => {
      const result = SETTING_SCHEMAS.permits.safeParse({ dot: 'DOT-123', dti: null, bir: null });
      expect(result.success).toBe(true);
      if (result.success) {
        const dot = result.data.items.find((item) => item.key === 'dot');
        expect(dot).toEqual({
          key: 'dot',
          label: 'DOT Accreditation No.',
          number: 'DOT-123',
          show: false,
          builtin: true,
        });
        expect(result.data.items.every((item) => item.show === false)).toBe(true);
      }
    });

    /**
     * BUG candidate the final review flagged: the OLD schema
     * (`z.string().min(1).nullable()`) allowed a whitespace-only legacy value
     * through with no trim, but the NEW `number` field trims then requires
     * `min(1)`. Without normalizing in `upgradeLegacyPermits`, a legacy row
     * of `{ dot: '   ', ... }` would fail the real validator on every read —
     * and `readSettings()` throwing takes the whole public site down
     * (BUG-023). This must upgrade successfully, with `number: null`, not be
     * refused.
     */
    it('upgrades a legacy row with a whitespace-only value, not refused, number becomes null', () => {
      const result = SETTING_SCHEMAS.permits.safeParse({ dot: '   ', dti: null, bir: null });
      expect(result.success).toBe(true);
      if (result.success) {
        const dot = result.data.items.find((item) => item.key === 'dot');
        expect(dot?.number).toBeNull();
      }
    });

    /**
     * The whitespace TRIM itself. Driven against `upgradeLegacyPermits`
     * directly rather than through `safeParse` — `accreditationNumberSchema`
     * already trims on its own preprocess step, so a round trip through the
     * full schema would pass with or without `upgradeLegacyPermits` doing any
     * trimming of its own, which would make this assertion unable to fail.
     */
    it('upgradeLegacyPermits trims a legacy value surrounded by whitespace', () => {
      const upgraded = upgradeLegacyPermits({ dot: '  DOT-123  ', dti: null, bir: null });
      const dot = upgraded.items.find((item) => item.key === 'dot');
      expect(dot?.number).toBe('DOT-123');
    });

    /**
     * A legacy value stored as a non-string (never producible by the old
     * schema, but not provably impossible from a hand-written `UPDATE`) is an
     * explicit, intentional `null` rather than a refusal.
     */
    it('upgradeLegacyPermits drops a non-string legacy value to null', () => {
      const upgraded = upgradeLegacyPermits({ dot: 123456789, dti: null, bir: null });
      const dot = upgraded.items.find((item) => item.key === 'dot');
      expect(dot?.number).toBeNull();
    });

    /**
     * Review finding: ANY non-array object lacking an `items` key used to be
     * treated as the legacy shape — so `{}` or a typo'd key silently upgraded
     * to three hidden, number-null builtins and reported success, exactly the
     * BUG-118 shape (a write silently wiping real configuration while
     * claiming success). Neither should be treated as legacy; both must be
     * refused outright.
     */
    it('refuses {} rather than silently treating it as three hidden builtins', () => {
      expect(SETTING_SCHEMAS.permits.safeParse({}).success).toBe(false);
    });

    it("refuses a typo'd key ({ itemz: [] }) rather than silently upgrading it", () => {
      expect(SETTING_SCHEMAS.permits.safeParse({ itemz: [] }).success).toBe(false);
    });

    it('refuses an item with show: true and an empty/null number', () => {
      const items = BUILTIN_ITEMS.map((item) =>
        item.key === 'dot' ? { ...item, show: true, number: null } : item,
      );
      expect(SETTING_SCHEMAS.permits.safeParse({ items }).success).toBe(false);

      const itemsEmptyString = BUILTIN_ITEMS.map((item) =>
        item.key === 'dot' ? { ...item, show: true, number: '   ' } : item,
      );
      expect(SETTING_SCHEMAS.permits.safeParse({ items: itemsEmptyString }).success).toBe(false);
    });

    it('refuses a submission missing one of the three builtins', () => {
      const items = BUILTIN_ITEMS.filter((item) => item.key !== 'bir');
      expect(SETTING_SCHEMAS.permits.safeParse({ items }).success).toBe(false);
    });

    it('refuses a builtin with the wrong label', () => {
      const items = BUILTIN_ITEMS.map((item) =>
        item.key === 'dot' ? { ...item, label: 'DOT Permit Number' } : item,
      );
      expect(SETTING_SCHEMAS.permits.safeParse({ items }).success).toBe(false);
    });

    it('refuses a builtin flagged builtin: false', () => {
      const items = BUILTIN_ITEMS.map((item) =>
        item.key === 'dot' ? { ...item, builtin: false } : item,
      );
      expect(SETTING_SCHEMAS.permits.safeParse({ items }).success).toBe(false);
    });

    it('refuses a custom item flagged builtin: true', () => {
      const items = [
        ...BUILTIN_ITEMS,
        { key: 'mayors', label: "Mayor's Permit No.", number: 'MP-1', show: true, builtin: true },
      ];
      expect(SETTING_SCHEMAS.permits.safeParse({ items }).success).toBe(false);
    });

    it('refuses 11 or more items', () => {
      const custom = Array.from({ length: 8 }, (_, i) => ({
        key: `custom-${i}`,
        label: `Custom ${i}`,
        number: 'X',
        show: true,
        builtin: false,
      }));
      expect(
        SETTING_SCHEMAS.permits.safeParse({ items: [...BUILTIN_ITEMS, ...custom] }).success,
      ).toBe(false);
    });

    it('refuses duplicate keys', () => {
      const items = [
        ...BUILTIN_ITEMS,
        { key: 'dot', label: 'Something else', number: null, show: false, builtin: false },
      ];
      // duplicate key "dot" collides with the builtin itself
      expect(SETTING_SCHEMAS.permits.safeParse({ items }).success).toBe(false);
    });

    it('refuses duplicate labels', () => {
      const items = [
        ...BUILTIN_ITEMS,
        { key: 'custom-a', label: 'Mayor', number: 'A', show: true, builtin: false },
        { key: 'custom-b', label: 'Mayor', number: 'B', show: true, builtin: false },
      ];
      expect(SETTING_SCHEMAS.permits.safeParse({ items }).success).toBe(false);
    });

    it('accepts a valid submission with the three builtins plus custom items', () => {
      const items = [
        { ...BUILTIN_ITEMS[0], number: 'DOT-R-123', show: true },
        BUILTIN_ITEMS[1],
        { ...BUILTIN_ITEMS[2], number: 'BIR-999', show: true },
        { key: 'mayors', label: "Mayor's Permit No.", number: 'MP-1', show: true, builtin: false },
        { key: 'sec', label: 'SEC Registration No.', number: null, show: false, builtin: false },
      ];
      expect(SETTING_SCHEMAS.permits.safeParse({ items }).success).toBe(true);
    });

    /**
     * Fix 3 (final review): `label` and `key` used to accept un-trimmed
     * values directly from a raw write — `number` already trimmed via its
     * own preprocess step, and this closed the same gap one field over.
     */
    describe('label/key trimming', () => {
      it('refuses an all-whitespace label (trimming to empty must still fail min(1))', () => {
        const items = [
          ...BUILTIN_ITEMS,
          { key: 'custom-a', label: '   ', number: 'A', show: true, builtin: false },
        ];
        expect(SETTING_SCHEMAS.permits.safeParse({ items }).success).toBe(false);
      });

      it('accepts a label with leading/trailing whitespace but STORES it trimmed', () => {
        const items = [
          ...BUILTIN_ITEMS,
          { key: 'custom-a', label: '  Mayor  ', number: 'A', show: true, builtin: false },
        ];
        const result = SETTING_SCHEMAS.permits.safeParse({ items });
        expect(result.success).toBe(true);
        if (result.success) {
          const custom = result.data.items.find((item) => item.key === 'custom-a');
          expect(custom?.label).toBe('Mayor');
        }
      });

      it('refuses a custom item whose label matches a builtin only after trimming ("BIR TIN ")', () => {
        const items = [
          ...BUILTIN_ITEMS,
          { key: 'custom-a', label: 'BIR TIN ', number: 'A', show: true, builtin: false },
        ];
        // Untrimmed, "BIR TIN " !== "BIR TIN" — if label were not trimmed
        // before the duplicate-label check runs, this would wrongly pass.
        expect(SETTING_SCHEMAS.permits.safeParse({ items }).success).toBe(false);
      });
    });
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

    it('refuses an unconfigured-but-flagged payment_qr with a plain-English message', () => {
      const result = schema.safeParse({
        imagePath: null,
        accountName: null,
        accountNumber: null,
        instructions: null,
        isConfigured: true,
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0]!.message).toBe(
          'Add the QR image, account name and account number before turning on manual transfer.',
        );
      }
    });
  });

  /**
   * `transfer_operations` (transfers-launch plan, Task T7). Four whole,
   * non-negative numbers — and the two zeros that are MEANINGFUL are the
   * reason this block has its own cases: zero buffer and zero transfer jobs per
   * driver are both legitimate owner choices, while a zero-hour staff-quote
   * hold would expire before the guest could be told about it.
   */
  describe('transfer_operations', () => {
    const schema = SETTING_SCHEMAS.transfer_operations;
    /** The owner's defaults, 2026-10-31, as the seed ships them. */
    const SEEDED = {
      bufferMinutes: 60,
      minNoticeHours: 6,
      staffQuoteHoldHours: 48,
      maxTransferJobsPerDriverPerDay: 2,
    };

    it('accepts the block the seed ships', () => {
      expect(schema.safeParse(SEEDED).success).toBe(true);
    });

    it('accepts a zero buffer, zero notice and a zero per-driver cap', () => {
      expect(
        schema.safeParse({
          ...SEEDED,
          bufferMinutes: 0,
          minNoticeHours: 0,
          maxTransferJobsPerDriverPerDay: 0,
        }).success,
      ).toBe(true);
    });

    it('REFUSES a staff-quote hold of zero hours', () => {
      expect(schema.safeParse({ ...SEEDED, staffQuoteHoldHours: 0 }).success).toBe(false);
    });

    it('REFUSES a negative or fractional value in any field', () => {
      for (const field of Object.keys(SEEDED)) {
        expect(schema.safeParse({ ...SEEDED, [field]: -1 }).success, `${field} = -1`).toBe(false);
        expect(schema.safeParse({ ...SEEDED, [field]: 1.5 }).success, `${field} = 1.5`).toBe(false);
        expect(schema.safeParse({ ...SEEDED, [field]: '60' }).success, `${field} = "60"`).toBe(
          false,
        );
      }
    });

    it('REFUSES a block with a field missing', () => {
      for (const field of Object.keys(SEEDED)) {
        const partial: Record<string, unknown> = { ...SEEDED };
        delete partial[field];
        expect(schema.safeParse(partial).success, `without ${field}`).toBe(false);
      }
    });
  });

  /**
   * `whatsapp_message` — the WhatsApp quote-request templates (owner spec,
   * 2026-11-28, Task 1A). The one rule with no analogue elsewhere in this
   * file: an unknown `{{token}}` is refused, so a typo can never reach a
   * guest's chat app as literal, unresolved brace text.
   */
  describe('whatsapp_message', () => {
    const schema = SETTING_SCHEMAS.whatsapp_message;

    it('accepts the block the seed ships, with every allowed token', () => {
      expect(
        schema.safeParse({
          general: "Hi TravelSugbo! I'd like a quote for a private transfer.",
          withDetails:
            'Route: {{route}}\nTrip: {{trip}}\nDate: {{date}}\nPassengers: {{passengers}}\n' +
            'Bags: {{bags}}\nVehicle: {{vehicle}}\nPickup: {{pickup}}',
        }).success,
      ).toBe(true);
    });

    it('accepts a message with no tokens at all', () => {
      expect(schema.safeParse({ general: 'Hi!', withDetails: 'Hi, no tokens here.' }).success).toBe(
        true,
      );
    });

    it('REFUSES an unknown token in either field', () => {
      expect(
        schema.safeParse({ general: 'Hi {{guestName}}!', withDetails: 'Route: {{route}}' }).success,
      ).toBe(false);
      expect(schema.safeParse({ general: 'Hi!', withDetails: 'Phone: {{phone}}' }).success).toBe(
        false,
      );
    });

    it('REFUSES an empty field in either direction', () => {
      expect(schema.safeParse({ general: '', withDetails: 'fine' }).success).toBe(false);
      expect(schema.safeParse({ general: 'fine', withDetails: '' }).success).toBe(false);
    });

    it('REFUSES a field over 1000 characters', () => {
      const tooLong = 'a'.repeat(1001);
      expect(schema.safeParse({ general: tooLong, withDetails: 'fine' }).success).toBe(false);
    });

    it('accepts a field at exactly 1000 characters', () => {
      const atLimit = 'a'.repeat(1000);
      expect(schema.safeParse({ general: atLimit, withDetails: 'fine' }).success).toBe(true);
    });
  });

  /**
   * Fifteen from the dynamic-site plan, plus `booking` (the bookable date
   * window, owner decision 2026-10-13), `payment_qr` (the R&G payment QR and
   * account, owner decision 2026-10-14 Q3), `transfer_operations` (the
   * transfer buffer, notice, staff-quote hold and per-driver job cap, owner
   * decisions 2026-10-31) and `show_tours` (the second visibility gate,
   * transfers-launch plan Task T15). Listed out rather than derived, so ADDING
   * a key is a deliberate edit here: every key is a row `readSettings()`
   * requires, and a key added without a seed row takes the whole public site
   * down until the seed runs — `show_tours` being the one exception, since
   * `readSettings()` resolves it through a fallback rather than throwing.
   */
  it('covers all 21 settings keys — the 15 from the plan, plus booking, payment_qr, transfer_operations, show_tours, signup_coupon and whatsapp_message', () => {
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
      'transfer_operations',
      'show_tours',
      'signup_coupon',
      'whatsapp_message',
    ];
    expect(Object.keys(SETTING_SCHEMAS).sort()).toEqual(expectedKeys.sort());
  });
});
