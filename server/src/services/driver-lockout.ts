/**
 * The driver PIN lockout policy (BUILD_SPEC §8 "Driver portal", owner decision
 * 2026-10-11 Q9, task 21 of the core-schema plan; the escalation **superseded
 * by owner decision 2026-10-23, Q1, option C+E**).
 *
 * Three limits stack. Two of them live here, in state the `drivers` table
 * already carries (task 4); the third is per-IP and lives in
 * `middleware/rate-limit.ts`:
 *
 *   per driver              5 consecutive failures -> a lockout
 *                           (`failed_attempts` / `locked_until`)
 *   per driver, backing off each further lockout inside 24 hours lasts longer:
 *                           15 -> 30 -> 60 minutes, capped at 60
 *                           (`lockout_count` / `lockout_window_started_at`)
 *   per IP                  10 attempts per 15 minutes
 *                           (`createDriverLoginLimiter()`)
 *
 * A six-digit PIN is 1,000,000 combinations; at 10 attempts per IP per 15
 * minutes that is centuries, which is the point of the IP limit. The two
 * per-driver limits exist for the other attacker: the one who knows which
 * driver and only needs the few thousand PINs a human would choose.
 *
 * ## What 2026-10-23 changed, and why
 *
 * The second limit used to END: three lockouts inside 24 hours set
 * `requires_admin_unlock`, which nothing here ever cleared — not time, not a
 * correct PIN — and only `admin.drivers.resetPin` could lift, by issuing a new
 * PIN. The argument for it (2026-10-16) was that a policy an attacker can
 * reset by eventually guessing right is not a policy.
 *
 * It turned out to be a better weapon than a defence. **A driver code is
 * short, printed inside the van and shared with guests on a manifest** — so
 * anyone at all can spend fifteen wrong PINs on a code and park that driver
 * out of the portal until a dispatcher is awake to reset it. A 5am pickup is
 * exactly when nobody is. The attacker's cost was fifteen guesses; the
 * driver's cost was their shift.
 *
 * So the escalation is replaced by a BACKOFF. The guessing cost is kept — the
 * 24-hour window still counts lockouts, and the third onward costs an hour
 * each, which holds one code to 130 attempts a day (pinned in
 * `driver-lockout.test.ts`, which computes it from this policy) — while the
 * driver always has a way back in that needs no human: waiting. The cure for
 * the one case where waiting is not good enough is now a dedicated admin
 * action, `admin.drivers.unlock`, which clears the lockout WITHOUT touching
 * the PIN — so the office can help without the driver learning a new PIN over
 * the phone at dawn.
 *
 * `requires_admin_unlock` still exists as a COLUMN (no migration was taken)
 * but nothing reads it any more. Do not reintroduce a terminal state here
 * without a new owner decision.
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

/**
 * How long the 1st, 2nd and 3rd lockout inside one window last, in minutes —
 * and the last entry is the CEILING for every lockout after it (owner decision
 * 2026-10-23, Q1).
 *
 * A schedule rather than a single constant, and a capped one rather than a
 * doubling one: an unbounded backoff is the terminal state again, wearing a
 * clock. Sixty minutes is long enough that walking a PIN space is hopeless and
 * short enough that a driver pranked before a dawn pickup is driving within the
 * hour.
 */
export const LOCKOUT_SCHEDULE_MINUTES = [15, 30, 60] as const;

/** The width of the rolling window the schedule is indexed by. */
export const LOCKOUT_WINDOW_HOURS = 24;

const MINUTE_MS = 60_000;
const WINDOW_MS = LOCKOUT_WINDOW_HOURS * 60 * MINUTE_MS;

/**
 * The length of the `lockoutCount`-th lockout in a window, in minutes, capped
 * at the last tier. `lockoutCount` is 1-based, as the column is; anything
 * below 1 cannot name a lockout and is clamped to the first tier rather than
 * indexing off the front of the array.
 */
export function lockoutMinutesFor(lockoutCount: number): number {
  const tier = Math.min(Math.max(lockoutCount, 1), LOCKOUT_SCHEDULE_MINUTES.length) - 1;
  return LOCKOUT_SCHEDULE_MINUTES[tier]!;
}

/**
 * Exactly the four lockout columns of `drivers` this policy reads, nothing
 * else. The caller reads them from the row, hands them over, and persists
 * `next`.
 *
 * **`requiresAdminUnlock` is deliberately absent** (owner decision 2026-10-23).
 * The column survives in the database; the policy has no field for it, which
 * is the strongest available statement that nothing here can consult it, set
 * it, or be reached by it.
 */
export interface LockoutState {
  failedAttempts: number;
  lockedUntil: Date | null;
  lockoutCount: number;
  lockoutWindowStartedAt: Date | null;
}

/**
 * Three outcomes, and there is no fourth. `'needs_admin_unlock'` was retired
 * on 2026-10-23: a type that cannot express the terminal state is the strongest
 * proof it is gone, and `attemptDriverLogin`'s exhaustive `switch` plus
 * `asTrpcError`'s mean a reintroduction cannot compile quietly anywhere.
 */
export type LockoutOutcome = 'ok' | 'wrong_pin' | 'locked';

export interface LockoutDecision {
  outcome: LockoutOutcome;
  next: LockoutState;
  /**
   * Set when something happened that must reach `audit_log` — a lockout, any
   * lockout. Never set on an ordinary wrong PIN: one fat-fingered digit is not
   * an audit event, and burying the real lockouts in noise is how a money
   * trail becomes unreadable.
   *
   * ONE action, since 2026-10-23: there is no escalating lockout to give its
   * own verb to, and `lockoutCount` in the payload already says which tier
   * this one served. (`driver.unlocked` is written by
   * `admin.drivers.unlock`, not from here — an admin unlock has no PIN attempt
   * behind it, so it is not a decision this function could ever return.)
   *
   * `data` carries identifiers and counts only. Never a PIN, never a hash.
   */
  audit?: {
    action: 'driver.locked_out';
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
 * **Nothing here is terminal, by decision** (2026-10-23). Every state this
 * returns is left by the clock alone: the longest `lockedUntil` it can write
 * is `now` plus the last tier of `LOCKOUT_SCHEDULE_MINUTES`. The policy's teeth
 * are in how long an attacker is made to wait, never in a door that stays shut.
 */
export function evaluatePinAttempt(
  state: LockoutState,
  now: Date,
  pinOk: boolean,
): LockoutDecision {
  // 1. A live lockout refuses the attempt whatever the PIN was, and does NOT
  //    extend itself. Refusing a CORRECT PIN here is intentional: a lockout a
  //    correct guess can end is not a lockout. Not extending it is also
  //    intentional — an attacker hammering the endpoint would otherwise lock
  //    the real driver out indefinitely, which turns the control into the
  //    denial of service it was meant to prevent.
  if (state.lockedUntil !== null && now.getTime() < state.lockedUntil.getTime()) {
    return { outcome: 'locked', next: { ...state } };
  }

  // 2. An expired lockout is cleared before the attempt is judged, so the
  //    next failure starts a fresh count of five rather than locking again
  //    immediately. The window counters survive: the backoff schedule is
  //    indexed by them, and clearing them here is exactly the bug that would
  //    let an attacker loop forever at five-failures-per-fifteen-minutes.
  const base: LockoutState =
    state.lockedUntil === null ? state : { ...state, lockedUntil: null, failedAttempts: 0 };

  // 3. The right PIN clears the failure counter. It does not clear
  //    `lockoutCount` / `lockoutWindowStartedAt`: three lockouts in a day are
  //    three lockouts in a day whether or not the driver eventually got in —
  //    so the next lockout today still costs the attacker an hour.
  if (pinOk) {
    return { outcome: 'ok', next: { ...base, failedAttempts: 0, lockedUntil: null } };
  }

  const failedAttempts = base.failedAttempts + 1;
  if (failedAttempts < MAX_FAILED_ATTEMPTS) {
    return { outcome: 'wrong_pin', next: { ...base, failedAttempts } };
  }

  // 4. The lockout itself, its length, and the rolling window.
  //
  //    The window is anchored at the FIRST lockout in it and rolls once it is
  //    older than 24 hours — which is the whole reason
  //    `lockout_window_started_at` is a column. Without the roll,
  //    `lockout_count` only ever grows, and a driver who fumbles their PIN
  //    once a day is serving hour-long lockouts for ordinary bad days.
  //
  //    What the count now decides is the LENGTH (owner decision 2026-10-23):
  //    1st -> 15 minutes, 2nd -> 30, 3rd and after -> 60. It no longer decides
  //    whether the policy ends, because it no longer does.
  const windowStart = base.lockoutWindowStartedAt;
  const lockoutWindowStartedAt =
    windowStart !== null && now.getTime() - windowStart.getTime() < WINDOW_MS
      ? windowStart // the window is still live: keep its anchor
      : new Date(now.getTime()); // no window, or it aged out: open a new one
  const windowRolled = lockoutWindowStartedAt !== windowStart;
  const lockoutCount = windowRolled ? 1 : base.lockoutCount + 1;
  const lockedUntil = new Date(now.getTime() + lockoutMinutesFor(lockoutCount) * MINUTE_MS);

  return {
    outcome: 'locked',
    next: { failedAttempts, lockedUntil, lockoutCount, lockoutWindowStartedAt },
    // Every lockout is audited (BUILD_SPEC §8), all of them under one action:
    // `lockoutCount` and `lockedUntil` together already say which tier this
    // one served, so a second verb would add no fact an admin is looking for.
    audit: {
      action: 'driver.locked_out',
      data: {
        lockoutCount,
        lockedUntil: lockedUntil.toISOString(),
        lockoutWindowStartedAt: lockoutWindowStartedAt.toISOString(),
        failedAttempts,
      },
    },
  };
}
