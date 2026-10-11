/**
 * "Was that a UNIQUE violation?" — asked of an error Drizzle has wrapped.
 *
 * mysql2 puts `code: 'ER_DUP_ENTRY'` on the error it throws, but Drizzle
 * wraps that in its own `DrizzleQueryError` and moves the original onto
 * `.cause` — so reading `error.code` one level up finds `undefined`. That is
 * not hypothetical: it has already broken a retry path in this codebase
 * once (`services/booking-ref.ts`, where the gated "retries when the
 * generated ref is already taken" test failed exactly this way before the
 * walk was added).
 *
 * It matters more here than anywhere else: the webhook route's idempotency
 * gate (plan Task 15) IS this check. A duplicate delivery whose
 * `ER_DUP_ENTRY` goes unrecognised falls through to `recordPayment()` and
 * double-pays a booking.
 *
 * NOTE: `services/booking-ref.ts` and `routers/public/newsletter.ts` each
 * carry a private copy of this predicate, written before there was a shared
 * home for it. This module is that home; folding those two into it is a
 * small refactor of two paths outside Task 15's scope, so it is reported as
 * a follow-up rather than done here. Do not add a fourth copy.
 */

/**
 * How many `.cause` links to walk looking for the MySQL error code.
 *
 * A bounded chain rather than one fixed level: the wrapping depth has
 * already changed once in this codebase's lifetime, and a bound stops a
 * cyclic `.cause` from looping forever.
 */
const MAX_CAUSE_DEPTH = 5;

/**
 * True for a MySQL duplicate-key error anywhere in the first
 * {@link MAX_CAUSE_DEPTH} links of `err`'s cause chain.
 *
 * Narrowed by hand rather than `instanceof`: neither mysql2 nor Drizzle
 * exports a class for this, only a `.code`-decorated `Error`.
 */
export function isDuplicateKeyError(err: unknown): boolean {
  let current: unknown = err;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH && current != null; depth += 1) {
    if (typeof current !== 'object') break;
    if ((current as { code?: unknown }).code === 'ER_DUP_ENTRY') return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}
