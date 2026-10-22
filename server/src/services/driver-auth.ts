/**
 * Driver sign-in — code + six-digit PIN (Week 6 plan, Task 1; BUILD_SPEC §8).
 *
 * **This file decides nothing about the lockout policy.** That was decided
 * and proven in Week 4: `services/driver-lockout.ts`'s `evaluatePinAttempt()`
 * is pure, complete and tested, and its four constants are imported here
 * rather than retyped. What this file adds is the three things a pure
 * function cannot have — a database row, a transaction, and a lock — plus
 * the credential check and the session.
 *
 * The order is fixed, and every line of it is load-bearing:
 *
 *   1. read the driver row FOR UPDATE by `code`
 *   2. note `is_active = 0` — and refuse NOTHING yet (owner decision D3)
 *   3. `verifyPassword(pin, row.pin_hash)` — ALWAYS, even when locked or
 *      inactive
 *   3b. if inactive: audit `driver.login_inactive`, then answer exactly as
 *      `wrong_credentials` — before the policy, touching no counter
 *   4. `evaluatePinAttempt(state, now, pinOk)`
 *   5. persist `decision.next` onto the row, same transaction
 *   6. `writeAudit` for a lockout or an escalation, same transaction
 *   7. on `'ok'`, mint a session; otherwise map the outcome to a refusal
 *
 * ## The unknown-code dummy hash runs AFTER the commit
 *
 * `FOR UPDATE` against `drivers.code` (a UNIQUE index) with no matching row
 * takes a gap lock for the duration of the statement that found nothing to
 * lock — and if the dummy scrypt hash ran inside that transaction, the gap
 * lock would sit for the ~230ms the hash takes, blocking a concurrent driver
 * insert for a window that buys nothing: there is no row to serialise
 * against. So the transaction returns an `'unknown_code'` sentinel and
 * commits (releasing the gap lock) BEFORE `dummyVerify` runs; the sentinel is
 * mapped to the same `wrong_credentials` refusal afterward. The timing
 * property this exists for is unchanged — the hash is still paid in full,
 * before the caller gets an answer, same as the known-code paths.
 *
 * ## `FOR UPDATE` is not optional (step 1)
 *
 * Two requests with the same wrong PIN read `failed_attempts = 4`, both
 * compute 5, and both write 5 — so the fifth and sixth failures count as
 * one and the lockout never fires. A six-digit PIN against an endpoint whose
 * counter can be made to stand still is a six-digit PIN with no counter.
 * The locking read serialises attempts against one driver, which costs a
 * real driver nothing (they make one at a time) and costs an attacker the
 * whole bypass. `driver-auth.test.ts` asserts two concurrent wrong PINs
 * leave `failed_attempts = 2`, not 1.
 *
 * ## The hash runs even when the driver is locked (step 3)
 *
 * This looks wasteful and is deliberate. Skipping the ~250ms scrypt verify
 * when `locked_until` is in the future makes a locked account answer
 * measurably faster than an unlocked one — a free account-state oracle for
 * anyone probing codes, and one that no generic refusal message can hide.
 * `evaluatePinAttempt` already refuses a correct PIN during a lockout, so
 * nothing is gained by asking it earlier. Same reasoning, same shape as
 * `verifyStaffPassword`'s `dummyVerify()` (`services/staff-auth.ts`), which
 * is also why an unknown CODE hashes before it refuses.
 *
 * ## One refusal for a wrong code and a wrong PIN
 *
 * `wrong_credentials` covers both. A driver code is short, printed inside
 * the van and shared with guests on a manifest; the PIN is the secret. An
 * answer that distinguished "no such code" from "wrong PIN" would confirm
 * which codes are real, which is the only part an attacker needs help with.
 * The test asserts the two responses are DEEPLY equal, not merely similar.
 *
 * ## What this file never does
 *
 * It never logs, returns, throws with, or audits a PIN or a hash. The
 * lockout audit payload comes from `evaluatePinAttempt`, which has never
 * seen the PIN (it takes a boolean), and nothing here adds to it.
 */
import { eq } from 'drizzle-orm';
import type { DriverLoginRefusal } from '@rg/shared';
import { getDb } from '../db/client';
import { drivers } from '../db/schema';
import { writeAudit } from './audit';
import { type LockoutState, evaluatePinAttempt } from './driver-lockout';
import { dummyVerify, verifyPassword } from './password';
import { createSession } from './sessions';

export interface DriverLoginSuccess {
  ok: true;
  token: string;
  /**
   * When the session cookie must stop being sent, so the router does not
   * have to re-derive it from the TTL map. The cookie and the `sessions`
   * row then agree on one instant — see `setSessionCookie`.
   */
  expiresAt: Date;
  driver: { id: number; name: string; code: string };
}

export interface DriverLoginRefused {
  ok: false;
  reason: DriverLoginRefusal;
}

export type DriverLoginResult = DriverLoginSuccess | DriverLoginRefused;

/** Built once, so a refused call cannot accidentally carry anything extra. */
function refuse(reason: DriverLoginRefusal): DriverLoginRefused {
  return { ok: false, reason };
}

/** Exactly the five lockout columns, in the shape the policy expects. */
function stateFrom(row: {
  failedAttempts: number;
  lockedUntil: Date | null;
  lockoutCount: number;
  lockoutWindowStartedAt: Date | null;
  requiresAdminUnlock: boolean;
}): LockoutState {
  return {
    failedAttempts: row.failedAttempts,
    lockedUntil: row.lockedUntil,
    lockoutCount: row.lockoutCount,
    lockoutWindowStartedAt: row.lockoutWindowStartedAt,
    requiresAdminUnlock: row.requiresAdminUnlock,
  };
}

/**
 * What the transaction decided, before a session exists. Kept separate from
 * `DriverLoginResult` because minting the session is deliberately the one
 * step that happens AFTER the commit: a token handed out by a transaction
 * that then rolls back is a credential for a login that never happened.
 */
type Verdict =
  | { kind: 'refused'; reason: DriverLoginRefusal }
  | { kind: 'unknown_code' }
  | { kind: 'ok'; driver: { id: number; name: string; code: string } };

/**
 * Verifies a driver's code and PIN, applies §8's lockout policy, and on
 * success mints a 12-hour session (`SESSION_TTL_MS_BY_SUBJECT.driver`).
 *
 * `now` is a parameter, as everywhere in this codebase that makes a
 * time-based decision: the 15-minute lockout and the 24-hour escalation
 * window are then assertable at the boundary instead of depending on when
 * the suite runs, and the procedure takes no time from the client.
 */
export async function attemptDriverLogin(input: {
  code: string;
  pin: string;
  now: Date;
}): Promise<DriverLoginResult> {
  const code = input.code.trim().toUpperCase();

  const verdict: Verdict = await getDb().transaction(async (tx) => {
    // 1. The locking read. `drivers.code` is UNIQUE, so this locks at most
    //    one row, and every concurrent attempt against the same code waits
    //    here rather than racing the counter.
    const [row] = await tx
      .select({
        id: drivers.id,
        name: drivers.name,
        code: drivers.code,
        pinHash: drivers.pinHash,
        isActive: drivers.isActive,
        failedAttempts: drivers.failedAttempts,
        lockedUntil: drivers.lockedUntil,
        lockoutCount: drivers.lockoutCount,
        lockoutWindowStartedAt: drivers.lockoutWindowStartedAt,
        requiresAdminUnlock: drivers.requiresAdminUnlock,
      })
      .from(drivers)
      .where(eq(drivers.code, code))
      .for('update')
      .limit(1);

    if (!row) {
      /*
       * No row to lock, no counter to move, and nothing to persist. The
       * dummy scrypt hash still has to happen or the timing answers the
       * question the message refuses to — but it does NOT happen in here:
       * see the module note. Returning this sentinel lets the transaction
       * commit (releasing the `FOR UPDATE` gap lock on `drivers.code`)
       * before `dummyVerify` pays its ~230ms, after the `tx` call below.
       */
      return { kind: 'unknown_code' };
    }

    // 2. A soft-deleted driver is NOT refused here (owner decision
    //    2026-10-16, D3). Refusing before the hash answered in ~5ms where a
    //    wrong PIN takes ~250ms, and with its own message, so both the body
    //    and the clock told anyone holding a list of driver codes which ones
    //    had left the company. The flag is carried past the hash instead.
    const inactive = !row.isActive;

    // 3. ALWAYS, even when locked, and now also when inactive. See the
    //    module note: this is the cost that makes every refusal cost the
    //    same.
    const pinOk = await verifyPassword(input.pin, row.pinHash);

    if (inactive) {
      /*
       * The real reason goes to `audit_log` and nowhere else: an admin
       * reading the trail can see that a departed driver is still trying to
       * sign in, while the person at the keypad learns only "that did not
       * work". The answer is `wrong_credentials`, the same value the
       * wrong-PIN path returns.
       *
       * The lockout counters are deliberately untouched, which is the one
       * thing the old early return got right: a driver who left must not be
       * able to lock out the code a new hire might later be given. So this
       * returns BEFORE `evaluatePinAttempt` is consulted and writes no
       * `drivers` update at all.
       *
       * KNOWN RESIDUAL: because an active code locks after repeated wrong
       * PINs and an inactive one never does, a patient attacker can still
       * tell the two apart by hammering a code until `locked` appears
       * (bounded by the per-IP limiter, 10 attempts per 15 minutes).
       *
       * `pinCorrect` is recorded because "a departed driver still knows
       * their PIN" and "someone is guessing at a departed driver's code"
       * are different events. It is a boolean; the PIN never reaches this
       * row.
       */
      await writeAudit(tx, {
        actorType: 'driver',
        actorId: row.id,
        action: 'driver.login_inactive',
        entity: 'driver',
        entityId: row.id,
        data: { code: row.code, pinCorrect: pinOk },
      });
      return { kind: 'refused', reason: 'wrong_credentials' };
    }

    // 4. The policy. Nothing here re-decides any part of it.
    const decision = evaluatePinAttempt(stateFrom(row), input.now, pinOk);

    // 5. Persist `next` in the SAME transaction as the read that produced
    //    it. All five columns, never a subset: `evaluatePinAttempt` returns
    //    a whole state, and writing half of one is how a cleared lockout
    //    keeps its counter.
    await tx
      .update(drivers)
      .set({
        failedAttempts: decision.next.failedAttempts,
        lockedUntil: decision.next.lockedUntil,
        lockoutCount: decision.next.lockoutCount,
        lockoutWindowStartedAt: decision.next.lockoutWindowStartedAt,
        requiresAdminUnlock: decision.next.requiresAdminUnlock,
      })
      .where(eq(drivers.id, row.id));

    // 6. Audit, also inside the transaction — an audit row written outside
    //    it survives a rollback and then claims a lockout that never
    //    happened. Only a lockout or an escalation sets `decision.audit`;
    //    an ordinary mistyped digit is not an audit event.
    //
    //    The ACTOR is the driver, not `system`: §8's lockout is something
    //    that happened to one driver's account, and an admin reading the
    //    log is looking for exactly that.
    if (decision.audit) {
      await writeAudit(tx, {
        actorType: 'driver',
        actorId: row.id,
        action: decision.audit.action,
        entity: 'driver',
        entityId: row.id,
        // Straight from the policy, which has never seen the PIN.
        data: decision.audit.data,
      });
    }

    switch (decision.outcome) {
      case 'ok':
        return { kind: 'ok', driver: { id: row.id, name: row.name, code: row.code } };
      case 'wrong_pin':
        return { kind: 'refused', reason: 'wrong_credentials' };
      case 'locked':
        return { kind: 'refused', reason: 'locked' };
      case 'needs_admin_unlock':
        return { kind: 'refused', reason: 'needs_admin_unlock' };
      default: {
        // Exhaustiveness: a new LockoutOutcome with no case here fails
        // `pnpm typecheck` rather than falling through to a login.
        const unreachable: never = decision.outcome;
        throw new Error(`Unhandled lockout outcome: ${String(unreachable)}`);
      }
    }
  });

  if (verdict.kind === 'unknown_code') {
    // Paid AFTER the commit, outside the transaction and its gap lock —
    // see the module note. The cost is still paid in full before the
    // caller gets an answer, so the timing property is unchanged.
    await dummyVerify(input.pin);
    return refuse('wrong_credentials');
  }
  if (verdict.kind === 'refused') return refuse(verdict.reason);

  // 7. After the commit, never inside it. A NEW session every time, like
  //    `staffAuth.login`: an attacker who plants a known cookie in a
  //    driver's browser must not have it become an authenticated one.
  const { token, expiresAt } = await createSession('driver', verdict.driver.id, input.now);
  return { ok: true, token, expiresAt, driver: verdict.driver };
}
