/**
 * MySQL deadlock (`ER_LOCK_DEADLOCK`, 1213) detection and a bounded retry.
 *
 * Extracted from `services/create-hold.ts` when `services/dispatch/assign.ts`
 * became its second caller (Task 10 review, F5). The behaviour is unchanged —
 * `create-hold.test.ts`'s two retry tests pin it and stay green — and the
 * point of moving it is that a deadlock retry is a property of "transactions
 * that take the slot locks", not of holds specifically. Both callers take
 * `fleet_date_slots` then `tour_date_slots`, and `capacity.ts` records the
 * measured reason either can be a victim:
 *
 *   when the row does not exist yet, two concurrent `INSERT`s of the same
 *   date can deadlock (the duplicate-key path takes an S lock and then needs
 *   an X lock), which at three or more concurrent requests for one date
 *   becomes likely rather than theoretical.
 *
 * Why the retry lives with the CALLER and not inside `takeSlotLocks`: a
 * deadlocked transaction is already rolled back by InnoDB, so there is
 * nothing to resume from inside it. Only whoever owns the transaction can
 * start a new one.
 */

/** Attempts at the WHOLE transaction before a deadlock is reported as one. */
export const MAX_DEADLOCK_ATTEMPTS = 3;

/** Drizzle wraps the mysql2 error and moves the original onto `.cause`. */
const MAX_CAUSE_DEPTH = 5;

/**
 * True for MySQL's `ER_LOCK_DEADLOCK` (1213) anywhere in the first
 * {@link MAX_CAUSE_DEPTH} links of `err`'s cause chain.
 *
 * Both the numeric `errno` and the string `code` are accepted: mysql2 sets
 * both, and matching on either means a driver that stops decorating one of
 * them does not silently turn the retry off.
 *
 * It must stay NARROW. A lock-wait timeout (1205) is deliberately NOT
 * retried: it means some other transaction is holding a lock for a long
 * time, and re-running a 50-second wait helps nobody.
 */
export function isDeadlockError(err: unknown): boolean {
  let current: unknown = err;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH && current != null; depth += 1) {
    if (typeof current !== 'object') break;
    const candidate = current as { errno?: unknown; code?: unknown; cause?: unknown };
    if (candidate.errno === 1213 || candidate.code === 'ER_LOCK_DEADLOCK') return true;
    current = candidate.cause;
  }
  return false;
}

export interface DeadlockRetryOptions {
  /** Defaults to {@link MAX_DEADLOCK_ATTEMPTS}. */
  attempts?: number;
  /**
   * Called when every attempt deadlocked, with the attempt count and the
   * last error. Must throw — its return type is `never` — so each caller
   * gives up in its own vocabulary (`HoldContentionError` for a guest hold,
   * a `CONFLICT` for a dispatcher) instead of leaking Drizzle's opaque
   * `Failed query`. Omit it to rethrow the MySQL error unchanged.
   */
  onExhausted?: (tries: number, error: unknown) => never;
}

/**
 * Runs `attempt` again from the beginning if InnoDB killed it as a deadlock
 * victim. `attempt` must be the WHOLE transaction — a deadlocked transaction
 * is already rolled back, so there is nothing to resume.
 *
 * Retries immediately, with no backoff: the victim's locks are already gone
 * and somebody is waiting on an HTTP request.
 */
export async function withDeadlockRetry<T>(
  attempt: () => Promise<T>,
  options: DeadlockRetryOptions = {},
): Promise<T> {
  const limit = options.attempts ?? MAX_DEADLOCK_ATTEMPTS;
  for (let tries = 1; ; tries += 1) {
    try {
      return await attempt();
    } catch (error) {
      if (!isDeadlockError(error)) throw error;
      if (tries >= limit) {
        if (options.onExhausted) options.onExhausted(tries, error);
        throw error;
      }
    }
  }
}
