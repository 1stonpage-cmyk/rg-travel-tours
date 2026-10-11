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

/**
 * The deposit due now, in centavos, rounded UP to the next whole peso.
 *
 * BUILD_SPEC §5 says "ceil(total * deposit_percent / 100) to the nearest
 * whole peso", which is two different instructions: on a ₱568.20 deposit,
 * ceil gives ₱569 and nearest gives ₱568. The owner settled it on
 * 2026-10-11 — **ceil**, so the business is never short.
 *
 * Clamped to the total: at 100% of a non-whole-peso total, ceiling would
 * otherwise produce a deposit larger than the price.
 *
 * Integer arithmetic throughout. No floats touch money — `0.1 + 0.2` is the
 * reason this function exists rather than a one-liner at each call site.
 *
 * **Server-side only.** The browser never sends a deposit and nothing in
 * `/client` may reimplement this (CLAUDE.md: "The server computes all
 * money"). It lives in `/shared` because `/shared` is where the money
 * vocabulary lives, not because the client is invited to call it.
 */
export function depositCentavos(totalCentavos: number, depositPercent: number): number {
  const raw = Math.ceil((totalCentavos * depositPercent) / 100); // centavos, not yet whole pesos
  const wholePesos = Math.ceil(raw / 100) * 100;
  return Math.min(wholePesos, totalCentavos);
}
