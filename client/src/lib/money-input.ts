/**
 * Pesos <-> centavos at the form boundary.
 *
 * CLAUDE.md: integers in centavos everywhere — DB, API, logic — formatted
 * only at display. The admin tour screen (Week 7 Task 7) is the first place
 * an owner TYPES a price rather than only reading one, so this is the one
 * tested conversion boundary every money input on that screen goes through,
 * rather than each price-tier/add-on field inventing its own parsing.
 */

/**
 * `'1,999.00'` -> `199900`. Accepts an optional thousands separator and up
 * to two decimal digits. Returns `null` for anything else — blank, letters,
 * a third decimal digit, a leading minus — so the caller turns a bad peso
 * string into a field error instead of silently rounding or coercing it
 * into a wrong price.
 */
export function pesosToCentavos(raw: string): number | null {
  const cleaned = raw.replace(/,/g, '').trim();
  if (!/^\d+(\.\d{1,2})?$/.test(cleaned)) return null;
  const [pesos, decimals = ''] = cleaned.split('.');
  const centavos = decimals.padEnd(2, '0').slice(0, 2);
  return Number(pesos) * 100 + Number(centavos);
}

/** `199900` -> `'1999.00'` — the inverse, for pre-filling an edit form. */
export function centavosToPesosInput(centavos: number): string {
  const pesos = Math.floor(centavos / 100);
  const remainder = Math.abs(centavos % 100);
  return `${pesos}.${String(remainder).padStart(2, '0')}`;
}
