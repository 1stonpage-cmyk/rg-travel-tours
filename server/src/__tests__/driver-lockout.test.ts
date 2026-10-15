/**
 * Task 21 — the driver PIN lockout policy.
 *
 * No database and no clock: `evaluatePinAttempt` is pure, which is the whole
 * reason the 24-hour escalation window can be tested in milliseconds instead
 * of waiting a day. So this is a plain `describe`, not `describeWithDb` — a
 * DB-less CI run or a fresh clone without MySQL must still exercise a security
 * control, because that is exactly the environment where a silently skipped
 * suite hides a regression.
 *
 * Layer 1  the three limits against BUILD_SPEC §8, parsed from the live spec
 * Layer 2  the per-driver limits (the plan's seven tests)
 * Layer 3  the edges the plan's seven do not reach
 * Layer 4  the per-IP limiter, and the guard that it gets mounted in Week 6
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import {
  createDriverLoginLimiter,
  DRIVER_LOGIN_IP_MAX,
  DRIVER_LOGIN_IP_WINDOW_MS,
  DRIVER_LOGIN_PROCEDURES,
} from '../middleware/rate-limit';
import { appRouter } from '../routers/_app';
import {
  evaluatePinAttempt,
  LOCKOUT_MINUTES,
  LOCKOUT_WINDOW_HOURS,
  MAX_FAILED_ATTEMPTS,
  MAX_LOCKOUTS_PER_WINDOW,
  type LockoutDecision,
  type LockoutState,
} from '../services/driver-lockout';

const FRESH: LockoutState = {
  failedAttempts: 0,
  lockedUntil: null,
  lockoutCount: 0,
  lockoutWindowStartedAt: null,
  requiresAdminUnlock: false,
};
const T0 = new Date('2026-10-11T00:00:00.000Z');
const at = (ms: number) => new Date(T0.getTime() + ms);
const MIN = 60_000;

/** Five consecutive wrong PINs from `state`, the last of which locks. */
function failFiveFrom(state: LockoutState, baseMs: number) {
  let s = state;
  let last!: LockoutDecision;
  for (let i = 1; i <= MAX_FAILED_ATTEMPTS; i += 1) {
    last = evaluatePinAttempt(s, at(baseMs + i * 1000), false);
    s = last.next;
  }
  return { state: s, last };
}

/** A lockout timing out: the 15 minutes pass and nothing else changes. */
const afterLockoutExpires = (s: LockoutState): LockoutState => ({
  ...s,
  lockedUntil: null,
  failedAttempts: 0,
});

// ---------------------------------------------------------------------------
// Layer 1 — the numbers, read off the spec rather than off a second copy
// ---------------------------------------------------------------------------

describe('the lockout numbers match BUILD_SPEC section 8', () => {
  /**
   * Parsed from the live spec, the way `role-isolation.test.ts` parses §9's
   * permission matrix — so the constants are checked against the document
   * the owner decided, not against a hand-copy of themselves. Editing either
   * side alone goes red.
   */
  const spec = readFileSync(resolve(import.meta.dirname, '../../../docs/BUILD_SPEC.md'), 'utf8');
  const start = spec.indexOf('## 8. Driver portal');
  const section = spec.slice(start, spec.indexOf('\n## 9.', start));

  it('finds the driver-portal section at all', () => {
    expect(start, 'BUILD_SPEC section 8 moved or was renamed').toBeGreaterThan(-1);
    expect(section).toContain('Three limits stack');
  });

  it('5 consecutive failures, 15-minute lockout', () => {
    const m = /Per driver:\*\*\s*(\d+) consecutive failed attempts[^\d]*(\d+)-minute lockout/.exec(
      section,
    );
    expect(
      m,
      'the per-driver limit is not stated in section 8 in the expected shape',
    ).not.toBeNull();
    expect(MAX_FAILED_ATTEMPTS).toBe(Number(m![1]));
    expect(LOCKOUT_MINUTES).toBe(Number(m![2]));
  });

  it('3 lockouts inside 24 hours', () => {
    const m = /Per driver, escalating:\*\*\s*(\d+) lockouts inside (\d+) hours/.exec(section);
    expect(
      m,
      'the escalation limit is not stated in section 8 in the expected shape',
    ).not.toBeNull();
    expect(MAX_LOCKOUTS_PER_WINDOW).toBe(Number(m![1]));
    expect(LOCKOUT_WINDOW_HOURS).toBe(Number(m![2]));
  });

  it('10 attempts per 15 minutes per IP', () => {
    const m = /Per IP:\*\*\s*(\d+) attempts per (\d+) minutes/.exec(section);
    expect(m, 'the per-IP limit is not stated in section 8 in the expected shape').not.toBeNull();
    expect(DRIVER_LOGIN_IP_MAX).toBe(Number(m![1]));
    expect(DRIVER_LOGIN_IP_WINDOW_MS).toBe(Number(m![2]) * MIN);
  });

  it('a correct PIN does not clear the admin-unlock requirement, per the spec', () => {
    expect(section).toMatch(/A correct PIN does \*\*not\*\* clear this; only an admin action does/);
  });
});

// ---------------------------------------------------------------------------
// Layer 2 — the plan's seven tests
// ---------------------------------------------------------------------------

describe('driver PIN lockout', () => {
  it('counts a wrong PIN without locking before the fifth', () => {
    let s = FRESH;
    for (let i = 1; i <= 4; i += 1) {
      s = evaluatePinAttempt(s, at(i * 1000), false).next;
      expect(s.lockedUntil, `locked after only ${i} failures`).toBeNull();
      expect(s.failedAttempts).toBe(i);
    }
  });

  it('locks for exactly 15 minutes on the fifth consecutive failure', () => {
    const { state: s } = failFiveFrom(FRESH, 0);
    expect(s.lockedUntil).toEqual(new Date(at(5000).getTime() + 15 * MIN));
    expect(s.lockoutCount).toBe(1);
  });

  it('refuses an attempt while locked, without extending the lockout', () => {
    const { state: s } = failFiveFrom(FRESH, 0);
    const lockedUntil = s.lockedUntil;
    const d = evaluatePinAttempt(s, at(60_000), false);
    expect(d.outcome).toBe('locked');
    expect(d.next.lockedUntil, 'a locked-out attempt extended the lockout').toEqual(lockedUntil);
  });

  it('clears the counter on a correct PIN', () => {
    let s = evaluatePinAttempt(FRESH, at(1000), false).next;
    s = evaluatePinAttempt(s, at(2000), true).next;
    expect(s.failedAttempts).toBe(0);
    expect(s.lockedUntil).toBeNull();
  });

  it('requires an admin unlock after the THIRD lockout inside 24 hours', () => {
    let s = FRESH;
    for (let lockout = 1; lockout <= 3; lockout += 1) {
      // An hour apart, well inside the 24h window.
      s = failFiveFrom(s, (lockout - 1) * 60 * MIN).state;
      if (lockout < 3) s = afterLockoutExpires(s);
    }
    expect(s.lockoutCount).toBe(3);
    expect(s.requiresAdminUnlock).toBe(true);
    // And a correct PIN does NOT clear it — only an admin can.
    const d = evaluatePinAttempt(s, at(25 * 60 * MIN), true);
    expect(d.outcome).toBe('needs_admin_unlock');
    expect(d.next.requiresAdminUnlock).toBe(true);
  });

  it('does NOT escalate when the three lockouts straddle more than 24 hours', () => {
    // The window must roll, or a driver who fumbles once a day every day is
    // eventually locked out permanently for no reason.
    let s = failFiveFrom(FRESH, 0).state;
    s = afterLockoutExpires(s);
    s = failFiveFrom(s, 25 * 60 * MIN).state;
    expect(s.lockoutCount, 'the 24h window did not roll').toBe(1);
    expect(s.requiresAdminUnlock).toBe(false);
  });

  it('reports every lockout so the caller can audit it', () => {
    const { last } = failFiveFrom(FRESH, 0);
    expect(last.audit).toMatchObject({ action: 'driver.locked_out' });
  });
});

// ---------------------------------------------------------------------------
// Layer 3 — the edges the plan's seven do not reach
// ---------------------------------------------------------------------------

describe('driver PIN lockout — edges', () => {
  it('refuses a CORRECT PIN while the lockout is still running', () => {
    const { state: s } = failFiveFrom(FRESH, 0);
    const d = evaluatePinAttempt(s, at(60_000), true);
    expect(d.outcome, 'a correct guess ended the lockout early').toBe('locked');
    expect(d.next.failedAttempts).toBe(MAX_FAILED_ATTEMPTS);
    expect(d.next.lockedUntil).toEqual(s.lockedUntil);
  });

  it('lets the driver back in once the 15 minutes have passed', () => {
    const { state: s } = failFiveFrom(FRESH, 0);
    const d = evaluatePinAttempt(s, at(5000 + 15 * MIN), true);
    expect(d.outcome).toBe('ok');
    expect(d.next.failedAttempts).toBe(0);
    expect(d.next.lockedUntil).toBeNull();
  });

  it('starts a fresh count of five after a lockout expires, not an instant relock', () => {
    const { state: s } = failFiveFrom(FRESH, 0);
    const d = evaluatePinAttempt(s, at(5000 + 15 * MIN), false);
    expect(d.outcome).toBe('wrong_pin');
    expect(d.next.failedAttempts).toBe(1);
    expect(d.next.lockedUntil, 'an expired lockout relocked on the first new failure').toBeNull();
  });

  it('keeps the window counters when a correct PIN clears the failures', () => {
    // Two lockouts already banked; getting in must not forgive them, or the
    // escalation limit can be reset at will by guessing right once.
    let s = failFiveFrom(FRESH, 0).state;
    s = afterLockoutExpires(s);
    s = failFiveFrom(s, 60 * MIN).state;
    s = afterLockoutExpires(s);
    const d = evaluatePinAttempt(s, at(70 * MIN), true);
    expect(d.outcome).toBe('ok');
    expect(d.next.lockoutCount, 'a correct PIN forgave the banked lockouts').toBe(2);
    expect(d.next.lockoutWindowStartedAt).toEqual(at(5000));
  });

  it('rolls the window at exactly 24 hours, and not a millisecond earlier', () => {
    const first = failFiveFrom(FRESH, 0).state;
    const windowStart = first.lockoutWindowStartedAt!.getTime() - T0.getTime();

    // One millisecond short of 24h: still the same window, so this escalates.
    const justInside = failFiveFrom(
      afterLockoutExpires({ ...first, lockoutCount: MAX_LOCKOUTS_PER_WINDOW - 1 }),
      windowStart + LOCKOUT_WINDOW_HOURS * 60 * MIN - 5000 - 1,
    ).state;
    expect(justInside.lockoutCount).toBe(MAX_LOCKOUTS_PER_WINDOW);
    expect(justInside.requiresAdminUnlock).toBe(true);

    // Exactly 24h: a new window, so the count restarts at 1.
    const atBoundary = failFiveFrom(
      afterLockoutExpires({ ...first, lockoutCount: MAX_LOCKOUTS_PER_WINDOW - 1 }),
      windowStart + LOCKOUT_WINDOW_HOURS * 60 * MIN - 5000,
    ).state;
    expect(atBoundary.lockoutCount).toBe(1);
    expect(atBoundary.requiresAdminUnlock).toBe(false);
  });

  it('audits the escalating lockout under its own action', () => {
    let s = FRESH;
    let decision!: LockoutDecision;
    for (let lockout = 1; lockout <= MAX_LOCKOUTS_PER_WINDOW; lockout += 1) {
      const round = failFiveFrom(s, (lockout - 1) * 60 * MIN);
      decision = round.last;
      s = afterLockoutExpires(round.state);
    }
    expect(decision.audit?.action).toBe('driver.unlock_required');
    expect(decision.audit?.data.lockoutCount).toBe(MAX_LOCKOUTS_PER_WINDOW);
  });

  it('writes no audit row for an ordinary wrong PIN, or for a correct one', () => {
    expect(evaluatePinAttempt(FRESH, at(1000), false).audit).toBeUndefined();
    expect(evaluatePinAttempt(FRESH, at(1000), true).audit).toBeUndefined();
  });

  it('never leaves the admin-unlock state, whatever the attempt or the clock', () => {
    const stuck: LockoutState = {
      failedAttempts: 5,
      lockedUntil: at(5000 + 15 * MIN),
      lockoutCount: 3,
      lockoutWindowStartedAt: at(5000),
      requiresAdminUnlock: true,
    };
    // Right PIN, wrong PIN, the lockout expired, the 24h window long rolled.
    for (const pinOk of [true, false]) {
      for (const ms of [6000, 5000 + 15 * MIN, 25 * 60 * MIN, 400 * 24 * 60 * MIN]) {
        const d = evaluatePinAttempt(stuck, at(ms), pinOk);
        expect(d.outcome, `escaped at ${ms}ms with pinOk=${pinOk}`).toBe('needs_admin_unlock');
        expect(d.next.requiresAdminUnlock).toBe(true);
        expect(d.next.lockoutCount).toBe(3);
      }
    }
  });

  it('takes a boolean, never a PIN, and puts nothing PIN-shaped in the audit row', () => {
    // The hash verify happens in the Week 6 route; this module must never be
    // in a position to log, store or audit the attempted PIN.
    expect(evaluatePinAttempt).toHaveLength(3);
    const { last } = failFiveFrom(FRESH, 0);
    expect(Object.keys(last.audit!.data).sort()).toEqual([
      'failedAttempts',
      'lockedUntil',
      'lockoutCount',
      'lockoutWindowStartedAt',
    ]);
  });

  it('does not mutate the state it is given', () => {
    const frozen = Object.freeze({ ...FRESH, failedAttempts: 4 });
    // Frozen in ESM strict mode: a write throws rather than being ignored.
    expect(() => evaluatePinAttempt(frozen, at(1000), false)).not.toThrow();
    expect(frozen.failedAttempts).toBe(4);
    expect(frozen.lockedUntil).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Layer 4 — the per-IP limiter
// ---------------------------------------------------------------------------

describe('driver login per-IP limiter', () => {
  function appWithLimiter() {
    const app = express();
    app.use(createDriverLoginLimiter());
    app.all('/trpc/*splat', (_req, res) => res.json({ ok: true }));
    return app;
  }

  it(`allows ${DRIVER_LOGIN_IP_MAX} attempts and refuses the next one`, async () => {
    const app = appWithLimiter();
    for (let i = 1; i <= DRIVER_LOGIN_IP_MAX; i += 1) {
      await request(app).post(`/trpc/${DRIVER_LOGIN_PROCEDURES[0]}`).expect(200);
    }
    await request(app).post(`/trpc/${DRIVER_LOGIN_PROCEDURES[0]}`).expect(429);
  });

  it('leaves every other procedure alone', async () => {
    const app = appWithLimiter();
    for (let i = 0; i < DRIVER_LOGIN_IP_MAX + 5; i += 1) {
      await request(app).post('/trpc/tours.list').expect(200);
    }
  });

  it('gives each limiter its own counter, so one app cannot exhaust another', async () => {
    const a = appWithLimiter();
    for (let i = 1; i <= DRIVER_LOGIN_IP_MAX; i += 1) {
      await request(a).post(`/trpc/${DRIVER_LOGIN_PROCEDURES[0]}`).expect(200);
    }
    await request(appWithLimiter()).post(`/trpc/${DRIVER_LOGIN_PROCEDURES[0]}`).expect(200);
  });

  /**
   * **Both halves of this are now live** (Week 6, Task 1 — comment
   * corrected in Task 2, as `middleware/rate-limit.ts` already was).
   * `'driver.login'` is no longer a proposed name: `_app.ts` mounts
   * `driverAuthRouter` under the `driver` namespace, so the login's tRPC
   * path IS `driver.login`, and the limiter is mounted against that string
   * in `app.ts`. What was written here when the route did not exist — "the
   * limiter is not mounted today", "a proposed name" — is simply false now,
   * and a false comment on a security guard is worse than none: the next
   * reader would conclude the per-IP limit is still hypothetical.
   *
   * The guard itself is unchanged and still earns its place: it fails the
   * build the moment ANOTHER driver-login procedure appears that
   * `DRIVER_LOGIN_PROCEDURES` does not name, because a procedure-scoped
   * limiter aimed at a name that does not exist fails OPEN while looking
   * mounted. Proven able to fail by adding a second public
   * `login`-shaped procedure to the driver namespace.
   */
  it('requires the limiter to be mounted as soon as a driver login procedure exists', () => {
    const procedures = Object.keys(
      (appRouter as unknown as { _def: { procedures: Record<string, unknown> } })._def.procedures,
    );
    const driverLogin = procedures.filter(
      (p) =>
        // `admin.*` is excluded deliberately (owner-decided 2026-10-14).
        // Week 5's `admin.drivers.resetPin` matches both patterns below —
        // "drivers" and "Pin" — but it is an `adminProcedure('vansDrivers')`,
        // not a login surface: it mints a PIN for a dispatcher who is already
        // signed in, and `procedure-role-metadata.test.ts` separately proves
        // every `admin.*` procedure is role-gated. A per-IP login limiter on
        // it would protect nothing, while the false positive would either
        // block the build or push someone into renaming a procedure §9 calls
        // "PIN reset".
        //
        // The guard keeps its teeth for what it was written for: a PUBLIC
        // driver login. `driver.login`, `driverAuth.verifyPin` and anything
        // else outside `admin.` still trips it.
        !p.startsWith('admin.') &&
        /driver/i.test(p) &&
        /log_?in|sign_?in|authenticate|pin/i.test(p),
    );

    if (driverLogin.length === 0) {
      // Week 6 has not happened. Nothing to mount against yet.
      expect(driverLogin).toEqual([]);
      return;
    }

    const appSource = readFileSync(resolve(import.meta.dirname, '../app.ts'), 'utf8');
    expect(
      appSource,
      `${driverLogin.join(', ')} exists but createDriverLoginLimiter() is not mounted in app.ts — the per-IP limit of BUILD_SPEC section 8 is not enforced`,
    ).toContain('createDriverLoginLimiter');
    for (const p of driverLogin) {
      expect(
        [...DRIVER_LOGIN_PROCEDURES],
        `the limiter is scoped to ${DRIVER_LOGIN_PROCEDURES.join(', ')} and would not count ${p}`,
      ).toContain(p);
    }
  });
});
