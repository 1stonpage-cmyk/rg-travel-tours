/**
 * Percent <-> basis points at the form boundary.
 *
 * `coupons.percent_bp` is integer BASIS POINTS — 1000 = 10%, 250 = 2.5% — so
 * an owner typing "2.5" into a discount field has to arrive at the API as the
 * integer 250. No float reaches a discount calculation (CLAUDE.md), and this is
 * the one tested place the conversion happens.
 *
 * It DELEGATES to `pesosToCentavos` rather than carrying a second copy of the
 * regex, because the parse is identical: a decimal string with at most two
 * decimal places, to an integer number of hundredths. Two copies of that rule
 * is two places for "accept a third decimal digit" to drift apart, and this
 * project already extracted `pesosToCentavos` for exactly that reason. The
 * naming is kept honest in both directions — basis points are a ratio, not
 * money, which is why these two functions live here and not in
 * `money-input.ts`.
 *
 * Neither function has an opinion about RANGE. `couponDiscountSchema` in
 * `@rg/shared` bounds basis points to 1..10000, and the screen runs that schema
 * before it posts, so a bound repeated here would be a second copy of the rule
 * that the database's `coupons_percent_bp_range` CHECK already mirrors.
 */
import { centavosToPesosInput, pesosToCentavos } from './money-input';

/** `'2.5'` -> `250` basis points. `null` for anything unparseable or blank. */
export function percentToBasisPoints(raw: string): number | null {
  return pesosToCentavos(raw);
}

/** `250` -> `'2.50'` — the inverse, for pre-filling an edit form. */
export function basisPointsToPercentInput(basisPoints: number): string {
  return centavosToPesosInput(basisPoints);
}

/**
 * `1000` -> `'10%'`, `250` -> `'2.5%'`, `125` -> `'1.25%'` — for READING.
 *
 * The trailing zeros are trimmed because this is the string an owner scans a
 * list of coupons with, and "10.00% off" reads like a number that was
 * calculated rather than one that was chosen.
 */
export function basisPointsToPercentLabel(basisPoints: number): string {
  const whole = Math.floor(basisPoints / 100);
  const hundredths = basisPoints % 100;
  if (hundredths === 0) return `${whole}%`;
  const decimals = String(hundredths).padStart(2, '0').replace(/0$/, '');
  return `${whole}.${decimals}%`;
}
