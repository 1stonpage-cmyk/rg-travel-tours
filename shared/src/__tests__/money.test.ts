import { describe, expect, it } from 'vitest';
import { depositCentavos, formatPeso } from '../money';

describe('formatPeso', () => {
  it('formats whole pesos from centavos with no space after the sign', () => {
    expect(formatPeso(189_000)).toBe('₱1,890');
    expect(formatPeso(98_000)).toBe('₱980');
    expect(formatPeso(0)).toBe('₱0');
  });

  it('rounds to the nearest peso', () => {
    expect(formatPeso(189_049)).toBe('₱1,890');
    expect(formatPeso(189_050)).toBe('₱1,891');
  });
});

/**
 * Owner decision 2026-10-11 (plan Q4): the deposit rounds UP to the next
 * whole peso, clamped to the total. The boundaries are the whole point, so
 * they are enumerated rather than sampled.
 */
describe('depositCentavos', () => {
  // ₱1,890.00 at 30% = ₱567.00 exactly — already whole, must not move.
  it('leaves an exact whole peso alone', () => {
    expect(depositCentavos(189_000, 30)).toBe(56_700);
  });

  // ₱1,895.00 at 30% = ₱568.50 -> ceil -> ₱569.00
  it('rounds a half peso UP', () => {
    expect(depositCentavos(189_500, 30)).toBe(56_900);
  });

  // ₱1,894.00 at 30% = ₱568.20 -> ceil -> ₱569.00.
  // THE case where "ceil" and "to the nearest whole peso" disagree: nearest
  // would give ₱568.00. The owner chose ceil (2026-10-11).
  it('rounds UP even when the nearest whole peso is DOWN', () => {
    expect(depositCentavos(189_400, 30)).toBe(56_900);
  });

  /**
   * One centavo over a whole peso still rounds up a full peso: 50% of
   * ₱200.02 is ₱100.01, which becomes ₱101.00.
   *
   * The plan wrote this case as `depositCentavos(10_001, 100) === 10_100`,
   * which cannot hold — at 100% the clamp below caps the deposit at the
   * ₱100.01 total, so the expected value is 10_001, and the case would have
   * been testing the clamp a second time rather than the single-centavo
   * round-up it is named for. Same intent, a percent where the clamp does
   * not bind.
   */
  it('rounds up from a single centavo', () => {
    expect(depositCentavos(200_02, 50)).toBe(10_100);
  });

  it('never exceeds the total', () => {
    // 100% of a total that is not a whole peso would ceil ABOVE the total
    // without a clamp, and a deposit larger than the price is nonsense.
    expect(depositCentavos(10_050, 100)).toBe(10_050);
  });

  it('returns 0 for a 0% deposit and the total for 100% of a whole peso', () => {
    expect(depositCentavos(189_000, 0)).toBe(0);
    expect(depositCentavos(189_000, 100)).toBe(189_000);
  });

  it('returns an integer for every percent from 0 to 100', () => {
    for (let pct = 0; pct <= 100; pct += 1) {
      const d = depositCentavos(189_437, pct);
      expect(Number.isInteger(d), `percent ${pct} produced ${d}`).toBe(true);
      expect(d % 100 === 0 || d === 189_437, `percent ${pct} produced ${d}`).toBe(true);
    }
  });

  /**
   * The rule `recordPayment()` enforces, from the opposite direction: the
   * deposit the service expects for a ₱1,890.33 tour. That service used to
   * compute this inline; this test is here so the shared helper is pinned to
   * the value the live payment path already refuses anything else for.
   */
  it('matches the deposit the payment path expects for ₱1,890.33 at 30%', () => {
    expect(depositCentavos(189_033, 30)).toBe(56_800);
  });
});
