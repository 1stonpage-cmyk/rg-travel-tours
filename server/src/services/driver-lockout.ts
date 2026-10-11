/**
 * The driver PIN lockout policy (BUILD_SPEC §8 "Driver portal", owner decision
 * 2026-10-11 Q9, task 21 of the core-schema plan).
 *
 * Three limits stack. Two of them live here, in state the `drivers` table
 * already carries (task 4); the third is per-IP and lives in
 * `middleware/rate-limit.ts`:
 *
 *   per driver              5 consecutive failures -> 15-minute lockout
 *                           (`failed_attempts` / `locked_until`)
 *   per driver, escalating  3 lockouts inside 24 hours -> admin unlock
 *                           (`lockout_count` / `lockout_window_started_at` /
 *                            `requires_admin_unlock`)
 *   per IP                  10 attempts per 15 minutes
 *                           (`createDriverLoginLimiter()`)
 *
 * A six-digit PIN is 1,000,000 combinations; at 10 attempts per IP per 15
 * minutes that is centuries, which is the point of the IP limit. The two
 * per-driver limits exist for the other attacker: the one who knows which
 * driver and only needs the few thousand PINs a human would choose.
 *
 * **This module never sees a PIN.** It takes `pinOk: boolean`. The comparison
 * is a hash verify in the Week 6 login route, and no value derived from the
 * PIN reaches the state, the decision or the audit payload — a lockout audit
 * row that carried the attempted PIN would publish it to every admin who can
 * read `audit_log`.
 *
 * **There is no driver login route yet** — that is Week 6, like the admin
 * procedures task 17's role gate is waiting for. The policy is built and
 * pinned first so the route that arrives later has one to call rather than
 * inventing its own, and so the numbers are argued once.
 */

/** Consecutive wrong PINs that trigger a lockout. */
export const MAX_FAILED_ATTEMPTS = 5;
/** How long that lockout lasts. */
export const LOCKOUT_MINUTES = 15;
/** Lockouts inside one window before an admin has to step in. */
export const MAX_LOCKOUTS_PER_WINDOW = 3;
/** The width of that window. */
export const LOCKOUT_WINDOW_HOURS = 24;

const MINUTE_MS = 60_000;
const LOCKOUT_MS = LOCKOUT_MINUTES * MINUTE_MS;
const WINDOW_MS = LOCKOUT_WINDOW_HOURS * 60 * MINUTE_MS;

/**
 * Exactly the five lockout columns of `drivers`, nothing else. The caller
 * reads them from the row, hands them over, and persists `next`.
 */
export interface LockoutState {
  failedAttempts: number;
  lockedUntil: Date | null;
  lockoutCount: number;
  lockoutWindowStartedAt: Date | null;
  requiresAdminUnlock: boolean;
}

export type LockoutOutcome = 'ok' | 'wrong_pin' | 'locked' | 'needs_admin_unlock';

export interface LockoutDecision {
  outcome: LockoutOutcome;
  next: LockoutState;
  /**
   * Set when something happened that must reach `audit_log` — a lockout, or
   * the lockout that escalates to needing an admin. Never set on an ordinary
   * wrong PIN: one fat-fingered digit is not an audit event, and burying the
   * real lockouts in noise is how a money trail becomes unreadable.
   *
   * `data` carries identifiers and counts only. Never a PIN, never a hash.
   */
  audit?: {
    action: 'driver.locked_out' | 'driver.unlock_required';
    data: {
      lockoutCount: number;
      lockedUntil: string;
      lockoutWindowStartedAt: string;
      failedAttempts: number;
    };
  };
}

/**
 * Pure: state and clock in, decision out. No database, no `new Date()`, no
 * mutation of the state handed in.
 *
 * That is deliberate. It is what lets the 24-hour escalation window be tested
 * in milliseconds instead of waiting a day, and what keeps the policy honest
 * when the login route is finally written in Week 6: the route's job shrinks
 * to "read the row, call this, persist `next` and write `audit` — in one
 * transaction". A policy tangled into a route is a policy nobody can test.
 *
 * The caller MUST persist `next` and write `audit` inside the same
 * transaction. An audit row written outside it survives a rollback and then
 * claims a lockout that never happened (see `services/audit.ts`), and a `next`
 * that is not persisted means the attacker's next attempt starts over.
 *
 * `requiresAdminUnlock` is never cleared here — not by a correct PIN, not by
 * the 24-hour window rolling, not by time at all. Only an admin action clears
 * it, and that action writes its own audit row. A policy an attacker can reset
 * by eventually guessing right is not a policy.
 */
export function evaluatePinAttempt(
  state: LockoutState,
  now: Date,
  pinOk: boolean,
): LockoutDecision {
  // 1. Terminal state, checked before anything else — including before the
  //    15-minute timer, which has nothing to say here. Nothing below this
  //    line can run, so nothing below can clear the flag by accident.
  if (state.requiresAdminUnlock) {
    return { outcome: 'needs_admin_unlock', next: { ...state } };
  }

  // 2. A live lockout refuses the attempt whatever the PIN was, and does NOT
  //    extend itself. Refusing a CORRECT PIN here is intentional: the window
  //    is 15 minutes, and a lockout a correct guess can end is not a lockout.
  //    Not extending it is also intentional — an attacker hammering the
  //    endpoint would otherwise lock the real driver out indefinitely, which
  //    turns the control into the denial of service it was meant to prevent.
  if (state.lockedUntil !== null && now.getTime() < state.lockedUntil.getTime()) {
    return { outcome: 'locked', next: { ...state } };
  }

  // 3. An expired lockout is cleared before the attempt is judged, so the
  //    next failure starts a fresh count of five rather than locking again
  //    immediately. The window counters survive: the escalation limit counts
  //    lockouts, and clearing them here is exactly the bug that would let an
  //    attacker loop forever at five-failures-per-fifteen-minutes.
  const base: LockoutState =
    state.lockedUntil === null ? state : { ...state, lockedUntil: null, failedAttempts: 0 };

  // 4. The right PIN clears the failure counter. It does not clear
  //    `lockoutCount` / `lockoutWindowStartedAt`: three lockouts in a day are
  //    three lockouts in a day whether or not the driver eventually got in.
  if (pinOk) {
    return { outcome: 'ok', next: { ...base, failedAttempts: 0, lockedUntil: null } };
  }

  const failedAttempts = base.failedAttempts + 1;
  if (failedAttempts < MAX_FAILED_ATTEMPTS) {
    return { outcome: 'wrong_pin', next: { ...base, failedAttempts } };
  }

  // 5. The lockout itself, and the rolling window.
  //
  //    The window is anchored at the FIRST lockout in it and rolls once it is
  //    older than 24 hours — which is the whole reason
  //    `lockout_window_started_at` is a column. Without the roll,
  //    `lockout_count` only ever grows, and a driver who fumbles their PIN
  //    once a day is permanently locked out after three ordinary bad days,
  //    for no reason at all.
  const windowStart = base.lockoutWindowStartedAt;
  const lockoutWindowStartedAt =
    windowStart !== null && now.getTime() - windowStart.getTime() < WINDOW_MS
      ? windowStart // the window is still live: keep its anchor
      : new Date(now.getTime()); // no window, or it aged out: open a new one
  const windowRolled = lockoutWindowStartedAt !== windowStart;
  const lockoutCount = windowRolled ? 1 : base.lockoutCount + 1;
  const requiresAdminUnlock = lockoutCount >= MAX_LOCKOUTS_PER_WINDOW;
  const lockedUntil = new Date(now.getTime() + LOCKOUT_MS);

  return {
    outcome: requiresAdminUnlock ? 'needs_admin_unlock' : 'locked',
    next: {
      failedAttempts,
      lockedUntil,
      lockoutCount,
      lockoutWindowStartedAt,
      requiresAdminUnlock,
    },
    // Every lockout is audited (BUILD_SPEC §8). The escalating one gets its
    // own action rather than a second row, because "this driver now needs an
    // admin" is the fact an admin is looking for in the log.
    audit: {
      action: requiresAdminUnlock ? 'driver.unlock_required' : 'driver.locked_out',
      data: {
        lockoutCount,
        lockedUntil: lockedUntil.toISOString(),
        lockoutWindowStartedAt: lockoutWindowStartedAt.toISOString(),
        failedAttempts,
      },
    },
  };
}
