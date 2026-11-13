/**
 * `transferQuoteConvertInput` — the wire shape `admin.transferQuotes.convert`
 * validates a request against (transfers-launch plan, Task T19).
 *
 * Dedicated-review should-fix #3: no test anywhere exercised this schema's
 * `superRefine`, direct or indirect — the server-side tests that exist
 * (`admin-transfer-quotes.test.ts`) only ever send ACCEPTING payloads through
 * the real router. This file proves all four refusal branches, pure and
 * DB-free, the same way `shared/src/__tests__/checkout.test.ts` proves
 * `createHoldInput`'s own cross-field rules.
 */
import { describe, expect, it } from 'vitest';
import { transferQuoteConvertInput } from '../transfers-admin';

/** A minimal, otherwise-valid one-way payload. */
function oneWayPayload(over: Record<string, unknown> = {}) {
  return {
    inquiryId: 1,
    vehicleTypeId: 1,
    productType: 'transfer_one_way' as const,
    date: '2027-06-15',
    pickupTime: '08:00',
    customRouteDurationMinutes: 90,
    pax: 2,
    luggageCount: 1,
    dropoffAddress: 'Mactan-Cebu International Airport',
    leadPhone: '09171234567',
    priceCentavos: 450_000,
    ...over,
  };
}

/** A minimal, otherwise-valid day-use payload. */
function dayUsePayload(over: Record<string, unknown> = {}) {
  return {
    ...oneWayPayload(),
    productType: 'transfer_day_use' as const,
    customRouteDurationMinutes: undefined,
    dayUseEndTime: '18:00',
    ...over,
  };
}

describe('transferQuoteConvertInput', () => {
  it('accepts a minimal one-way request', () => {
    expect(transferQuoteConvertInput.safeParse(oneWayPayload()).success).toBe(true);
  });

  it('accepts a minimal day-use request', () => {
    expect(transferQuoteConvertInput.safeParse(dayUsePayload()).success).toBe(true);
  });

  it('refuses a one-way request with no customRouteDurationMinutes — the mirror of dayUseEndTime', () => {
    const result = transferQuoteConvertInput.safeParse(
      oneWayPayload({ customRouteDurationMinutes: undefined }),
    );
    expect(result.success).toBe(false);
    if (!result.success) {
      const paths = result.error.issues.map((issue) => issue.path.join('.'));
      expect(paths).toContain('customRouteDurationMinutes');
    }
  });

  it('refuses a day-use request with no dayUseEndTime', () => {
    const result = transferQuoteConvertInput.safeParse(dayUsePayload({ dayUseEndTime: undefined }));
    expect(result.success).toBe(false);
    if (!result.success) {
      const paths = result.error.issues.map((issue) => issue.path.join('.'));
      expect(paths).toContain('dayUseEndTime');
    }
  });

  it('refuses a day-use request that also carries customRouteDurationMinutes', () => {
    const result = transferQuoteConvertInput.safeParse(
      dayUsePayload({ customRouteDurationMinutes: 90 }),
    );
    expect(result.success).toBe(false);
    if (!result.success) {
      const paths = result.error.issues.map((issue) => issue.path.join('.'));
      expect(paths).toContain('customRouteDurationMinutes');
    }
  });

  it('refuses a day-use request that carries flight details', () => {
    const result = transferQuoteConvertInput.safeParse(
      dayUsePayload({ flightNumber: 'PR123', airline: 'Philippine Airlines' }),
    );
    expect(result.success).toBe(false);
    if (!result.success) {
      const paths = result.error.issues.map((issue) => issue.path.join('.'));
      expect(paths).toContain('flightNumber');
      expect(paths).toContain('airline');
    }
  });

  /** Task 5 (owner item 1E) — the ferry counterpart of the flight test above. */
  it('refuses a day-use request that carries ferry details', () => {
    const result = transferQuoteConvertInput.safeParse(
      dayUsePayload({ ferryVesselName: 'MV Starlite', ferryArrivalTime: '14:30' }),
    );
    expect(result.success).toBe(false);
    if (!result.success) {
      const paths = result.error.issues.map((issue) => issue.path.join('.'));
      expect(paths).toContain('ferryVesselName');
      expect(paths).toContain('ferryArrivalTime');
    }
  });

  /**
   * Unlike the flight pair, there is no required-on-pier-route counterpart
   * to prove here — a one-way request with ferry details and no route-type
   * gate at all is simply accepted, which this proves by acceptance rather
   * than refusal.
   */
  it('accepts a one-way request carrying ferry details', () => {
    const result = transferQuoteConvertInput.safeParse(
      oneWayPayload({ ferryVesselName: 'MV Starlite', ferryArrivalTime: '14:30' }),
    );
    expect(result.success).toBe(true);
  });

  it('refuses a one-way request that carries a dayUseEndTime', () => {
    const result = transferQuoteConvertInput.safeParse(oneWayPayload({ dayUseEndTime: '18:00' }));
    expect(result.success).toBe(false);
    if (!result.success) {
      const paths = result.error.issues.map((issue) => issue.path.join('.'));
      expect(paths).toContain('dayUseEndTime');
    }
  });

  it('REFUSES any price field name other than priceCentavos — .strict()', () => {
    const withPesos = { ...oneWayPayload(), priceSoPesos: 4500 };
    expect(transferQuoteConvertInput.safeParse(withPesos).success).toBe(false);
  });

  it('refuses a priceCentavos above MAX_CENTAVOS (dedicated-review should-fix #1)', () => {
    const result = transferQuoteConvertInput.safeParse(
      oneWayPayload({ priceCentavos: 2_147_483_648 }),
    );
    expect(result.success).toBe(false);
    if (!result.success) {
      const paths = result.error.issues.map((issue) => issue.path.join('.'));
      expect(paths).toContain('priceCentavos');
    }
  });

  it('refuses a priceCentavos of zero or negative', () => {
    expect(transferQuoteConvertInput.safeParse(oneWayPayload({ priceCentavos: 0 })).success).toBe(
      false,
    );
    expect(transferQuoteConvertInput.safeParse(oneWayPayload({ priceCentavos: -1 })).success).toBe(
      false,
    );
  });
});
