/**
 * Money helpers. Integer centavos everywhere in the DB, API and logic —
 * format only at display, per the project-wide convention.
 */

const pesoFormatter = new Intl.NumberFormat('en-PH', {
  style: 'currency',
  currency: 'PHP',
  minimumFractionDigits: 0,
  maximumFractionDigits: 0,
});

/** Formats integer centavos as whole pesos, e.g. 150000 -> "₱1,500". */
export function formatPeso(centavos: number) {
  return pesoFormatter.format(Math.round(centavos / 100)).replace(/ /g, '');
}
