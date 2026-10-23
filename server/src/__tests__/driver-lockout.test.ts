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
 * Layer 5  the backoff is reachable, bounded, and never terminal (C7, rewritten
 *          2026-10-23) — the ONLY layer that needs MySQL, so it is
 *          `describeWithDb` and the four above still run on a machine without
 *          a database
 *
 * ## The terminal state is gone (owner decision 2026-10-23, Q1, option C+E)
 *
 * This file used to pin the opposite policy: three lockouts inside 24 hours
 * reached `requires_admin_unlock`, which nothing but an admin PIN reset ever
 * cleared, and several tests here asserted that by name. That rule
 * (owner decision 2026-10-16, reading the 2026-10-11 Q9 policy) is
 * **superseded**: a lockout now BACKS OFF — 15 minutes, then 30, then 60 for
 * the third and every one after — and is never terminal. Which tests changed,
 * and why, is recorded on each of them rather than only in the commit message.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { and, eq } from 'drizzle-orm';
import express from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getDb } from '../db/client';
import { auditLog, drivers, sessions } from '../db/schema';
import {
  createDriverLoginLimiter,
  DRIVER_LOGIN_IP_MAX,
  DRIVER_LOGIN_IP_WINDOW_MS,
  DRIVER_LOGIN_PROCEDURES,
} from '../middleware/rate-limit';
import { appRouter } from '../routers/_app';
import { attemptDriverLogin } from '../services/driver-auth';
import {
  evaluatePinAttempt,
  lockoutMinutesFor,
  LOCKOUT_SCHEDULE_MINUTES,
  LOCKOUT_WINDOW_HOURS,
  MAX_FAILED_ATTEMPTS,
  type LockoutDecision,
  type LockoutOutcome,
  type LockoutState,
} from '../services/driver-lockout';
import { hashPassword } from '../services/password';
import { describeWithDb } from './helpers/db';

const FRESH: LockoutState = {
  failedAttempts: 0,
  lockedUntil: null,
  lockoutCount: 0,
  lockoutWindowStartedAt: null,
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

/** A lockout timing out: its minutes pass and nothing else changes. */
const afterLockoutExpires = (s: LockoutState): LockoutState => ({
  ...s,
  lockedUntil: null,
  failedAttempts: 0,
});

/** How long, in minutes, the lockout a decision just imposed actually lasts. */
function lockedMinutes(decision: LockoutDecision, lockedAtMs: number): number {
  const until = decision.next.lockedUntil;
  if (until === null) throw new Error('that decision imposed no lockout');
  return (until.getTime() - at(lockedAtMs).getTime()) / MIN;
}

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
    expect(LOCKOUT_SCHEDULE_MINUTES[0]).toBe(Number(m![2]));
  });

  /**
   * REPLACES `'3 lockouts inside 24 hours'` (owner decision 2026-10-23, Q1).
   * That test parsed `MAX_LOCKOUTS_PER_WINDOW` out of the spec's escalation
   * sentence; there is no such constant any more, because there is no count of
   * lockouts that ends the policy. What the spec now states, and what this
   * reads back, is the SCHEDULE — and the window it is indexed by, which is
   * the one number that survived unchanged.
   */
  it('the backoff schedule and its 24-hour window, read off the spec', () => {
    const m =
      /Per driver, backing off:\*\*[^.]*?inside (\d+) hours[^.]*?(\d+) minutes, then (\d+), then (\d+)/.exec(
        section,
      );
    expect(
      m,
      'the backoff schedule is not stated in section 8 in the expected shape',
    ).not.toBeNull();
    expect(LOCKOUT_WINDOW_HOURS).toBe(Number(m![1]));
    expect([...LOCKOUT_SCHEDULE_MINUTES]).toEqual([Number(m![2]), Number(m![3]), Number(m![4])]);
  });

  it('10 attempts per 15 minutes per IP', () => {
    const m = /Per IP:\*\*\s*(\d+) attempts per (\d+) minutes/.exec(section);
    expect(m, 'the per-IP limit is not stated in section 8 in the expected shape').not.toBeNull();
    expect(DRIVER_LOGIN_IP_MAX).toBe(Number(m![1]));
    expect(DRIVER_LOGIN_IP_WINDOW_MS).toBe(Number(m![2]) * MIN);
  });

  /**
   * REPLACES `'a correct PIN does not clear the admin-unlock requirement, per
   * the spec'`, which asserted the spec still carried the sentence
   * *"A correct PIN does **not** clear this; only an admin action does"*. It
   * does not: owner decision 2026-10-23 struck it. Both dates have to stay
   * visible in §8 — a reader who finds the new rule needs to know what it
   * replaced and why, or the next person re-introduces the old one.
   */
  it('says the lockout is never terminal, and dates the decision it supersedes', () => {
    expect(section).toMatch(/\*\*Never terminal\.\*\*/);
    expect(section).toContain('2026-10-23');
    expect(section).toContain('2026-10-11');
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

  /* ---- the backoff schedule (owner decision 2026-10-23, Q1, option C+E) ---- */

  /**
   * Each step gets its own test, so a flattened schedule names which step
   * broke instead of failing one combined assertion. The lockout happens on
   * the fifth failure, which `failFiveFrom` puts at `baseMs + 5000`.
   */
  it('the FIRST lockout in the window lasts 15 minutes', () => {
    const { last } = failFiveFrom(FRESH, 0);
    expect(last.next.lockoutCount).toBe(1);
    expect(lockedMinutes(last, 5000)).toBe(15);
  });

  it('the SECOND lockout in the window lasts 30 minutes', () => {
    const first = afterLockoutExpires(failFiveFrom(FRESH, 0).state);
    const { last } = failFiveFrom(first, 60 * MIN);
    expect(last.next.lockoutCount).toBe(2);
    expect(lockedMinutes(last, 60 * MIN + 5000)).toBe(30);
  });

  it('the THIRD lockout in the window lasts 60 minutes', () => {
    let s = FRESH;
    let last!: LockoutDecision;
    for (let lockout = 1; lockout <= 3; lockout += 1) {
      const round = failFiveFrom(s, (lockout - 1) * 2 * 60 * MIN);
      last = round.last;
      s = afterLockoutExpires(round.state);
    }
    expect(last.next.lockoutCount).toBe(3);
    expect(lockedMinutes(last, 2 * 2 * 60 * MIN + 5000)).toBe(60);
  });

  /**
   * The cap is the whole point of the decision: the FOURTH lockout is not 120
   * minutes and not terminal, it is 60 again. A schedule that kept doubling
   * would park a driver for a whole shift, which is the prankster's goal.
   */
  it('the FOURTH lockout is still 60 minutes — capped, not escalating', () => {
    let s = FRESH;
    let last!: LockoutDecision;
    for (let lockout = 1; lockout <= 4; lockout += 1) {
      const round = failFiveFrom(s, (lockout - 1) * 2 * 60 * MIN);
      last = round.last;
      s = afterLockoutExpires(round.state);
    }
    expect(last.next.lockoutCount).toBe(4);
    expect(lockedMinutes(last, 3 * 2 * 60 * MIN + 5000)).toBe(60);
    expect(last.outcome).toBe('locked');
  });

  it('never locks for longer than the ceiling, however many lockouts are banked', () => {
    let s = FRESH;
    for (let lockout = 1; lockout <= 12; lockout += 1) {
      const round = failFiveFrom(s, (lockout - 1) * 2 * 60 * MIN);
      expect(
        lockedMinutes(round.last, (lockout - 1) * 2 * 60 * MIN + 5000),
        `lockout ${lockout} exceeded the ceiling`,
      ).toBeLessThanOrEqual(LOCKOUT_SCHEDULE_MINUTES[LOCKOUT_SCHEDULE_MINUTES.length - 1]!);
      expect(round.last.outcome, `lockout ${lockout} was not an ordinary lockout`).toBe('locked');
      s = afterLockoutExpires(round.state);
    }
  });

  it('exposes the schedule as a function of the lockout count, capped at the last tier', () => {
    expect(lockoutMinutesFor(1)).toBe(15);
    expect(lockoutMinutesFor(2)).toBe(30);
    expect(lockoutMinutesFor(3)).toBe(60);
    expect(lockoutMinutesFor(4)).toBe(60);
    expect(lockoutMinutesFor(99)).toBe(60);
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

  /**
   * REPLACES `'requires an admin unlock after the THIRD lockout inside 24
   * hours'` (owner decision 2026-10-23, Q1). That test asserted the third
   * lockout produced `'needs_admin_unlock'` and that a CORRECT PIN did not
   * clear it. Both halves are now wrong by decision: the third lockout is an
   * ordinary one that happens to last an hour, and the driver gets back in by
   * waiting it out — which is exactly what this asserts instead.
   *
   * **The prankster scenario, in full.** Somebody who is not the driver —
   * anyone who can read a code off the side of a van — burns three lockouts on
   * it before a 5am pickup. Under the old rule the real driver arrived to an
   * account only a dispatcher could open, at an hour when no dispatcher is
   * awake. Now the worst anyone can do costs the driver the ceiling, once, and
   * nothing a human has to do.
   */
  it('frees a driver pranked into THREE lockouts by time alone, with no admin action', () => {
    let s = FRESH;
    for (let lockout = 1; lockout <= 3; lockout += 1) {
      // Two hours apart, well inside the 24h window.
      s = failFiveFrom(s, (lockout - 1) * 2 * 60 * MIN).state;
      if (lockout < 3) s = afterLockoutExpires(s);
    }
    expect(s.lockoutCount).toBe(3);

    const lockedAt = at(2 * 2 * 60 * MIN + 5000).getTime();
    const ceiling = LOCKOUT_SCHEDULE_MINUTES[LOCKOUT_SCHEDULE_MINUTES.length - 1]!;
    expect(s.lockedUntil).toEqual(new Date(lockedAt + ceiling * MIN));

    // One minute short of the ceiling: still shut out, as intended.
    const during = evaluatePinAttempt(s, new Date(lockedAt + (ceiling - 1) * MIN), true);
    expect(during.outcome).toBe('locked');

    // The ceiling passes. The driver's OWN PIN, and nobody was rung.
    const after = evaluatePinAttempt(s, new Date(lockedAt + ceiling * MIN), true);
    expect(after.outcome, 'the driver needed a human to get back in').toBe('ok');
    expect(after.next.lockedUntil).toBeNull();
    expect(after.next.failedAttempts).toBe(0);
  });

  it('starts the backoff over at 15 minutes when the lockouts straddle more than 24 hours', () => {
    // The window must roll, or a driver who fumbles their PIN once a day is
    // serving hour-long lockouts for ordinary bad days.
    let s = failFiveFrom(FRESH, 0).state;
    s = afterLockoutExpires(s);
    const { state: rolled, last } = failFiveFrom(s, 25 * 60 * MIN);
    expect(rolled.lockoutCount, 'the 24h window did not roll').toBe(1);
    expect(lockedMinutes(last, 25 * 60 * MIN + 5000)).toBe(15);
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

  /**
   * CHANGED (2026-10-23): the boundary itself is untouched — what the two
   * halves now read is the BACKOFF TIER rather than `requiresAdminUnlock`. One
   * millisecond inside the window is the third lockout, so sixty minutes;
   * exactly on it is a new window's first, so fifteen. Reading the tier is
   * strictly stronger than reading the old boolean: the tier is what the
   * window's count is now FOR.
   */
  it('rolls the window at exactly 24 hours, and not a millisecond earlier', () => {
    const first = failFiveFrom(FRESH, 0).state;
    const windowStart = first.lockoutWindowStartedAt!.getTime() - T0.getTime();
    const twoBanked = afterLockoutExpires({ ...first, lockoutCount: 2 });

    // One millisecond short of 24h: still the same window, so this is the
    // third lockout in it and serves the ceiling.
    const justInsideAt = windowStart + LOCKOUT_WINDOW_HOURS * 60 * MIN - 5000 - 1;
    const justInside = failFiveFrom(twoBanked, justInsideAt);
    expect(justInside.state.lockoutCount).toBe(3);
    expect(lockedMinutes(justInside.last, justInsideAt + 5000)).toBe(60);

    // Exactly 24h: a new window, so the count restarts at 1 and so does the
    // schedule.
    const atBoundaryAt = windowStart + LOCKOUT_WINDOW_HOURS * 60 * MIN - 5000;
    const atBoundary = failFiveFrom(twoBanked, atBoundaryAt);
    expect(atBoundary.state.lockoutCount).toBe(1);
    expect(lockedMinutes(atBoundary.last, atBoundaryAt + 5000)).toBe(15);
  });

  /**
   * REPLACES `'audits the escalating lockout under its own action'`, which
   * asserted the third lockout wrote `driver.unlock_required`. There is no
   * such action any more — there is no escalation to name — so every lockout,
   * the tenth included, is one `driver.locked_out` row. §8 still asks for
   * every lockout to be audited, and the payload still carries the count and
   * the instant so an admin can see the backoff in the log.
   */
  it('audits EVERY lockout under one action, however many are banked', () => {
    let s = FRESH;
    for (let lockout = 1; lockout <= 4; lockout += 1) {
      const round = failFiveFrom(s, (lockout - 1) * 2 * 60 * MIN);
      expect(round.last.audit?.action, `lockout ${lockout}`).toBe('driver.locked_out');
      expect(round.last.audit?.data.lockoutCount).toBe(lockout);
      s = afterLockoutExpires(round.state);
    }
  });

  it('writes no audit row for an ordinary wrong PIN, or for a correct one', () => {
    expect(evaluatePinAttempt(FRESH, at(1000), false).audit).toBeUndefined();
    expect(evaluatePinAttempt(FRESH, at(1000), true).audit).toBeUndefined();
  });

  /**
   * REPLACES `'never leaves the admin-unlock state, whatever the attempt or
   * the clock'` — the test that pinned the terminal state as deliberate. The
   * replacement pins its absence, from both ends.
   *
   * **The compile-time half is the stronger one.** `LockoutOutcome` no longer
   * HAS a terminal member, so a path that tried to return one would not
   * compile; this `Record` is the reviewer-visible form of that, and it fails
   * `pnpm typecheck` in both directions — a member added without a key here,
   * and a key here with no member to match it.
   */
  it('cannot express a terminal outcome at all — the type has three members', () => {
    const outcomes: Record<LockoutOutcome, true> = { ok: true, wrong_pin: true, locked: true };
    expect(Object.keys(outcomes).sort()).toEqual(['locked', 'ok', 'wrong_pin']);
  });

  it('never returns a terminal outcome, whatever the sequence or the clock', () => {
    let s = FRESH;
    const seen = new Set<string>();
    // Ten lockouts inside one window, each probed with both PINs while live
    // and once more after it lapses. Under the old policy the third round
    // would answer `needs_admin_unlock` and never stop.
    for (let lockout = 1; lockout <= 10; lockout += 1) {
      const baseMs = (lockout - 1) * 2 * 60 * MIN;
      const round = failFiveFrom(s, baseMs);
      seen.add(round.last.outcome);
      for (const pinOk of [true, false]) {
        seen.add(evaluatePinAttempt(round.state, at(baseMs + 6000), pinOk).outcome);
      }
      s = afterLockoutExpires(round.state);
      // Both PINs again once the lockout has lapsed, discarding the result:
      // this probes the outcome, not the counters the next round needs.
      for (const pinOk of [true, false]) {
        seen.add(evaluatePinAttempt(s, at(baseMs + 2 * 60 * MIN - 1000), pinOk).outcome);
      }
    }
    // All three appear and nothing else does — a fourth value, whatever it was
    // called, would show up in this list.
    expect([...seen].sort()).toEqual(['locked', 'ok', 'wrong_pin']);
  });

  /**
   * The guesser scenario, costed rather than asserted by adjective. The clock
   * is the attacker's: they attempt the moment they are allowed to and never
   * waste one on a live lockout.
   *
   * The number comes out of the real policy, not out of arithmetic in a
   * comment — but it is derivable, and here is the derivation so a change that
   * raises it is visible as a change to this number: five failures buy a
   * lockout, lockouts in one window last 15, 30, 60, 60 … minutes, so the nth
   * lockout starts at 0, 15, 45, 105, 165 … minutes and the 26th starts at
   * 1425 — the last one that fits inside the 24-hour window. 26 lockouts x 5
   * attempts = 130 attempts a day against one driver's code, before the per-IP
   * limiter is even consulted.
   *
   * A six-digit PIN is 1,000,000 combinations, so walking the space costs
   * over twenty years of continuous attack on a single code.
   */
  it('costs an attacker 130 attempts per 24 hours against one driver — over 20 years for the PIN space', () => {
    const WINDOW_MS = LOCKOUT_WINDOW_HOURS * 60 * MIN;
    let s = FRESH;
    let t = 0;
    let attempts = 0;
    while (t < WINDOW_MS) {
      const until = s.lockedUntil;
      if (until !== null && t < until.getTime() - T0.getTime()) {
        // Shut out: an attacker waits rather than burning attempts on it.
        t = until.getTime() - T0.getTime();
        continue;
      }
      // Attempts themselves are free and instant — the clock only moves when
      // a lockout makes it move. That is the attacker's best case.
      s = evaluatePinAttempt(s, at(t), false).next;
      attempts += 1;
      if (attempts > 10_000) throw new Error('the policy stopped bounding the attempt rate');
    }

    expect(attempts, 'the attempt budget per 24 hours changed').toBe(130);
    const yearsForWholeSpace = 1_000_000 / attempts / 365;
    expect(yearsForWholeSpace).toBeGreaterThan(20);
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

// ---------------------------------------------------------------------------
// Layer 5 — the backoff is reachable, bounded, and never terminal
// ---------------------------------------------------------------------------

/**
 * C7 (owner-decided 2026-10-16: keep both limits), **rewritten for owner
 * decision 2026-10-23 (Q1, option C+E)**.
 *
 * What this block used to prove was that the terminal escalation was NOT dead
 * code: fifteen counted failures cannot fit under a per-IP ceiling of ten, so
 * the obvious reading was that three lockouts could never be reached and the
 * `requires_admin_unlock` branch should be deleted — and the answer was that it
 * was reachable across IPs and across windows. There is no escalation left to
 * defend. What survives unchanged is everything that argument was BUILT on, and
 * it is still worth three tests, because the backoff now rests on exactly the
 * same two facts:
 *
 *  1. HTTP + the real limiter, ONE IP: the 429 ceiling, and that the driver is
 *     locked ONCE inside one window — ten attempts cannot buy a second lockout.
 *     Proves what the limiter does.
 *  2. HTTP + the real limiter, THREE IPs: 15 attempts across three client
 *     addresses are not limited, because each address has its own budget.
 *     Proves the limiter's KEY, which is the `trust proxy` dependency.
 *  3. `attemptDriverLogin` called directly with an ADVANCING `now`, against the
 *     real `drivers` row: three rounds of five failures lengthen the lockout
 *     15 → 30 → 60 minutes in the `locked_until` COLUMN, and then the driver's
 *     own PIN gets them back in once the hour has passed. Proves the
 *     per-driver policy end to end, including the persistence the pure tests
 *     above cannot see. A supertest request cannot inject `now` (the router
 *     reads the clock at the request boundary), and a locked driver's attempts
 *     count toward nothing, so an HTTP-only test cannot reach the second
 *     lockout inside one test run; test 3 therefore does not claim an IP at
 *     all — the policy keys on the driver, never the address — and tests 1 and
 *     2 do not claim the backoff.
 *
 * Test 3 is where the decision is visible: the old version of it ended at
 * `reason: 'needs_admin_unlock'` with a correct PIN still refused. It now ends
 * with a successful login, which is the whole point of the change.
 */
describeWithDb('the backoff is reachable, bounded and never terminal (C7)', () => {
  const unique = () => `${Math.floor(Math.random() * 1e9)}_${Date.now()}`;

  /*
   * The numbers the argument rests on, written out as LITERALS rather than
   * imported. Layer 1 pins the real constants to BUILD_SPEC §8; restating them
   * here is what lets this block go red when one drifts, where importing them
   * would let every assertion quietly follow the change (measured: with the
   * old escalation constant raised to 4 the escalation test stayed green until
   * it stopped reading the import).
   */
  const IP_CEILING = 10; // attempts per IP per window before a 429
  const FAILURES_TO_LOCK = 5; // consecutive failures that lock a driver
  const BACKOFF_MINUTES = [15, 30, 60]; // the 1st, 2nd and 3rd+ lockout in a window

  let driverId = 0;
  let code = '';
  let realPin = '';
  /** Never the real PIN, whatever the random draw was. */
  let wrongPin = '';

  beforeEach(async () => {
    const suffix = unique();
    code = `DL${suffix}`.slice(0, 20);
    realPin = String(Math.floor(Math.random() * 1_000_000)).padStart(6, '0');
    wrongPin = realPin === '000000' ? '111111' : '000000';
    const [row] = await getDb()
      .insert(drivers)
      .values({
        name: `Lockout Reach Fixture ${suffix}`,
        code,
        phone: '09170000000',
        pinHash: await hashPassword(realPin),
        isActive: true,
      });
    driverId = row.insertId;
  }, 30_000);

  // The fixture driver, every audit row its lockouts wrote, and — since the
  // backoff test now ends in a SUCCESSFUL login — the session that login
  // minted. Deleting the driver also discards the lockout columns, which is
  // the reset.
  afterEach(async () => {
    if (driverId === 0) return;
    await getDb()
      .delete(auditLog)
      .where(and(eq(auditLog.entity, 'driver'), eq(auditLog.entityId, driverId)));
    await getDb()
      .delete(sessions)
      .where(and(eq(sessions.subjectType, 'driver'), eq(sessions.subjectId, driverId)));
    await getDb().delete(drivers).where(eq(drivers.id, driverId));
    driverId = 0;
  });

  async function lockoutColumns() {
    const [row] = await getDb()
      .select({
        failedAttempts: drivers.failedAttempts,
        lockedUntil: drivers.lockedUntil,
        lockoutCount: drivers.lockoutCount,
      })
      .from(drivers)
      .where(eq(drivers.id, driverId));
    if (!row) throw new Error(`no driver ${driverId}`);
    return row;
  }

  /**
   * The login path behind the real limiter: the real limiter, the real
   * `attemptDriverLogin`, the real `drivers` row. Only the tRPC envelope is
   * missing, and the router's status mapping is copied (`wrong_credentials`
   * 401, the other refusals 403) so the assertions can read a status.
   *
   * `trust proxy` is the DEPLOYED configuration, not a test convenience:
   * `docs/LAUNCH_CHECKLIST.md` (the `trust proxy` item under "Deployment
   * requirements") makes it a launch item because the app sits behind nginx,
   * and without it `req.ip` is nginx's own address for every request — which
   * turns this per-IP limiter into one global one. It is set HERE, on the
   * test's own app, so the test can present distinct client addresses to one
   * limiter the way several real phones would. `app.ts` deliberately does not
   * set it: that is the deployment's decision and the checklist owns it.
   *
   * `'loopback'` rather than `true`: nginx proxies from the same host, so it
   * is the hop to trust, and `true` makes the leftmost `X-Forwarded-For`
   * entry believable from anyone — `express-rate-limit` says as much at
   * runtime (`ERR_ERL_PERMISSIVE_TRUST_PROXY`). The deployed value should be
   * as narrow as this one.
   */
  function appBehindProxy() {
    const app = express();
    app.set('trust proxy', 'loopback');
    app.use(createDriverLoginLimiter());
    app.use(express.json());
    app.post('/trpc/driver.login', async (req, res) => {
      const result = await attemptDriverLogin({
        code: req.body.code,
        pin: req.body.pin,
        now: new Date(),
      });
      res.status(result.ok ? 200 : result.reason === 'wrong_credentials' ? 401 : 403).json(result);
    });
    return app;
  }

  const attemptFrom = (app: express.Express, ip: string, pin: string) =>
    request(app).post('/trpc/driver.login').set('X-Forwarded-For', ip).send({ code, pin });

  // Layer: HTTP + the real limiter. Proves the ceiling, not the backoff.
  it('ONE IP is stopped by the limiter inside a window, and the driver is locked exactly once', async () => {
    const app = appBehindProxy();
    const statuses: number[] = [];
    for (let i = 0; i < IP_CEILING + 3; i += 1) {
      statuses.push((await attemptFrom(app, '203.0.113.10', wrongPin)).status);
    }

    // The ceiling, exactly: ten reach the login, the eleventh onwards do not.
    expect(statuses.slice(0, IP_CEILING)).not.toContain(429);
    expect(statuses.slice(IP_CEILING)).toEqual([429, 429, 429]);

    // Those ten were four wrong credentials, the fifth failure that locks, and
    // five refusals against the live lockout, which count toward nothing. Ten
    // attempts cannot buy a second lockout, so the backoff stays on tier one.
    const driver = await lockoutColumns();
    expect(driver.lockoutCount).toBe(1);
    expect(driver.failedAttempts).toBe(FAILURES_TO_LOCK);
  }, 60_000);

  // Layer: HTTP + the real limiter. Proves the limiter's KEY, nothing about
  // the policy — the driver is still on its first lockout afterwards, which is
  // exactly why the backoff test below has to move the clock.
  it('THREE IPs each keep their own budget: fifteen attempts, none limited', async () => {
    const app = appBehindProxy();
    const statuses: number[] = [];
    for (const ip of ['203.0.113.10', '203.0.113.11', '203.0.113.12']) {
      for (let i = 0; i < FAILURES_TO_LOCK; i += 1) {
        statuses.push((await attemptFrom(app, ip, wrongPin)).status);
      }
    }

    expect(statuses).toHaveLength(FAILURES_TO_LOCK * 3);
    expect(
      statuses,
      'a 429 here means the three client addresses collapsed onto one limiter key — `trust proxy` not honoured',
    ).not.toContain(429);

    // The HTTP path alone has moved the backoff nowhere: real time has not
    // moved, so the first lockout is still running and the later attempts
    // bounced off it. Reaching the second tier needs the clock — next test.
    expect((await lockoutColumns()).lockoutCount).toBe(1);
  }, 60_000);

  /**
   * Layer: `attemptDriverLogin` + the real row, with `now` advancing. Proves
   * the per-driver policy and says nothing about IPs, because the policy has no
   * notion of one.
   *
   * REPLACES `'the escalation fires on the third lockout, and a correct PIN
   * does not clear it'` (owner decision 2026-10-23). Same staging, opposite
   * ending: the third lockout is an hour rather than a dead end, and the last
   * assertion is a SUCCESSFUL login with the driver's own PIN.
   */
  it('lengthens the lockout 15 → 30 → 60 minutes in the column, then lets the driver back in', async () => {
    let now = new Date('2026-10-23T02:00:00.000Z');

    for (const [index, minutes] of BACKOFF_MINUTES.entries()) {
      // Five wrong PINs: the first four are `wrong_credentials`, the fifth
      // locks — whichever tier that lockout is on.
      let last: Awaited<ReturnType<typeof attemptDriverLogin>> | undefined;
      let lockedAt = now;
      for (let i = 0; i < FAILURES_TO_LOCK; i += 1) {
        lockedAt = now;
        last = await attemptDriverLogin({ code, pin: wrongPin, now });
        now = new Date(now.getTime() + 1000);
      }
      // Always the SAME refusal, whatever the tier. The response carries no
      // tier, no count and no timestamp — see `asTrpcError`.
      expect(last).toEqual({ ok: false, reason: 'locked' });

      const driver = await lockoutColumns();
      expect(driver.lockoutCount).toBe(index + 1);
      expect(driver.lockedUntil, `lockout ${index + 1} did not last ${minutes} minutes`).toEqual(
        new Date(lockedAt.getTime() + minutes * MIN),
      );

      // The lockout has to lapse before the next five can count. One minute
      // past its own length, and nowhere near the 24-hour window.
      now = new Date(driver.lockedUntil!.getTime() + MIN);
    }

    // The driver's OWN PIN, after waiting out the hour. No admin was involved,
    // and this is the assertion the superseded test did not have.
    expect(await attemptDriverLogin({ code, pin: realPin, now })).toMatchObject({ ok: true });
    const settled = await lockoutColumns();
    expect(settled.lockedUntil).toBeNull();
    expect(settled.failedAttempts).toBe(0);
    // Three lockouts in a day are still three lockouts in a day.
    expect(settled.lockoutCount).toBe(BACKOFF_MINUTES.length);
  }, 120_000);
});
