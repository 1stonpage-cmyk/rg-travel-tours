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

/**
 * The smallest amount PayMongo will accept for one charge: **₱100**
 * (BUG-110, owner decision 2026-10-23 Q10). Its own API refuses anything
 * below with `amount must be at least 10000`.
 *
 * It belongs beside {@link depositCentavos} because the two together are the
 * rule: a 30% deposit is under this floor for any tour priced below ₱334, so
 * a cheap tour (or a deeply couponed one) produces an `amount_due_now` no
 * gateway will take. The SERVER refuses that at hold time
 * (`server/src/services/create-hold.ts`) and again before the gateway call
 * (`checkout.startPayment`) — never the browser, which computes no money at
 * all.
 *
 * A gateway's own limit, not a business rule: it is NOT a minimum tour price,
 * a minimum booking value or a minimum deposit percent, and nothing but the
 * amount handed to an online payment may be measured against it. Cash and the
 * manual QR / bank-transfer flows are unaffected — they never touch PayMongo.
 */
export const PAYMONGO_MIN_CENTAVOS = 10000;
