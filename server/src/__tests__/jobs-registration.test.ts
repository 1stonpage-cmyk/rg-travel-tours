/**
 * What `startScheduledJobs()` actually registers (7N item 8).
 *
 * `jobs/index.ts` is the ONE module that knows about time passing, and until
 * now **no test imported it at all** — every job was tested by calling it
 * directly with an injected clock, which is right for the job and says
 * nothing about the schedule. So the five expressions, the five names and
 * the four timezones were unguarded: a typo'd `'0 7 * * *'` would simply run
 * the orphaned-van check at a different hour, forever, silently, and the
 * first symptom would be a dispatcher not seeing an alert they were never
 * told to expect.
 *
 * ## Why the expressions are written out rather than imported
 *
 * `EVERY_MINUTE` and the `DAILY_*` constants are module-private, and
 * deliberately not exported for this test: a test that asserts
 * `DAILY_0700 === DAILY_0700` cannot fail. The literals here are
 * transcribed from the decisions, not from the code — 07:00 for the
 * orphaned-van check and the review sweep (D5 2026-10-16; Q5 2026-10-23),
 * 16:00 for the day-before reminder (Task 14), 03:30 for the session prune
 * (C3 2026-10-16), every minute for the hold sweep (§5 / §13).
 *
 * ## The timezone asymmetry is asserted in both directions
 *
 * The four daily jobs each pass `timezone: 'Asia/Manila'` explicitly, never
 * trusting the server's own zone — CLAUDE.md stores UTC and computes
 * business dates in Manila, and a VPS that comes back from a rebuild in UTC
 * must not move a 07:00 Manila job to 15:00. `expire-holds` passes NO
 * timezone, and that is intended rather than an oversight: it runs every
 * minute, so no zone can change when it fires. Both halves are pinned,
 * because "every job has a zone" and "this one deliberately does not" are
 * different claims and only one of them is true.
 */
import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

vi.mock('node-cron', () => ({ schedule: vi.fn() }));

import { schedule } from 'node-cron';
import { startScheduledJobs } from '../jobs';

const MANILA = 'Asia/Manila';

interface Registration {
  expression: string;
  callback: () => Promise<void>;
  options: { name?: string; timezone?: string; noOverlap?: boolean };
}

function registrations(): Registration[] {
  const calls = (schedule as unknown as Mock).mock.calls as unknown as [
    string,
    () => Promise<void>,
    Registration['options'] | undefined,
  ][];
  return calls.map(([expression, callback, options]) => ({
    expression,
    callback,
    options: options ?? {},
  }));
}

function byName(name: string): Registration {
  const found = registrations().find((r) => r.options.name === name);
  if (!found) throw new Error(`no job registered under the name ${name}`);
  return found;
}

beforeEach(() => {
  (schedule as unknown as Mock).mockClear();
  startScheduledJobs();
});

describe('startScheduledJobs', () => {
  it('registers exactly five jobs, by name and expression, in reading order', () => {
    expect(
      registrations().map((r) => ({
        name: r.options.name,
        expression: r.expression,
        timezone: r.options.timezone,
      })),
    ).toStrictEqual([
      { name: 'expire-holds', expression: '* * * * *', timezone: undefined },
      { name: 'orphaned-vans', expression: '0 7 * * *', timezone: MANILA },
      { name: 'prune-sessions', expression: '30 3 * * *', timezone: MANILA },
      { name: 'trip-reminders', expression: '0 16 * * *', timezone: MANILA },
      { name: 'review-requests', expression: '0 7 * * *', timezone: MANILA },
    ]);
  });

  it('names every job, so a log line and PM2 both have something to call it', () => {
    const names = registrations().map((r) => r.options.name);
    expect(names.filter((n) => n === undefined)).toEqual([]);
    // No two jobs share a name, even where two share an expression.
    expect(new Set(names).size).toBe(names.length);
  });

  it('passes Asia/Manila EXPLICITLY on every daily job, never the server zone', () => {
    for (const name of ['orphaned-vans', 'prune-sessions', 'trip-reminders', 'review-requests']) {
      expect(byName(name).options.timezone, `${name} must name its zone`).toBe(MANILA);
    }
  });

  it('passes NO timezone on the per-minute sweep, which is intended, not an omission', () => {
    const options = byName('expire-holds').options;
    // `hasOwn`, not `=== undefined`: the claim is that the key is absent.
    expect(Object.hasOwn(options, 'timezone')).toBe(false);
  });

  /**
   * Q5 (2026-10-23), pinned because it is the thing a later tidy-up would
   * "simplify" away: the review sweep shares `orphaned-vans`'s hour but is
   * its OWN `schedule()` call, so one of them throwing cannot stop the
   * other from running.
   */
  it('gives the two 07:00 jobs separate registrations rather than one callback', () => {
    const atSeven = registrations().filter((r) => r.expression === '0 7 * * *');
    expect(atSeven).toHaveLength(2);
    expect(atSeven.map((r) => r.options.name)).toEqual(['orphaned-vans', 'review-requests']);
    expect(atSeven[0]!.callback).not.toBe(atSeven[1]!.callback);
  });

  it('asks node-cron to skip a tick while the previous one is still running', () => {
    for (const r of registrations()) {
      expect(r.options.noOverlap, `${r.options.name} must set noOverlap`).toBe(true);
    }
  });

  /**
   * Every callback catches its own job's failure. An unhandled rejection
   * inside a node-cron tick takes the whole API process down with it, which
   * is a far worse failure than a missed sweep — `jobs/index.ts` says so at
   * every one of the five try/catch blocks, and nothing tested it.
   *
   * The jobs themselves are mocked to REJECT, so this drives the catch and
   * not the happy path. Mocked at the module boundary rather than by
   * breaking a database, because the point is the scheduler's contract, not
   * any one job's.
   */
  it('never lets a failing job reject into the scheduler', async () => {
    const boom = new Error('the database went away');
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});

    /*
     * A fresh module graph, so the five `doMock`s below are in place before
     * `../jobs` is evaluated. Without the reset the cached `../jobs` keeps
     * the REAL job modules — which would reach `rg_travel_test`, succeed,
     * and leave this test asserting nothing while looking green.
     *
     * The `node-cron` mock SURVIVES the reset (the factory at the top of
     * this file is registered once, and the fresh `../jobs` resolves to the
     * same `schedule` spy), so the file-scope helpers still read the right
     * calls — they just need clearing of what `beforeEach` registered.
     */
    vi.resetModules();
    vi.doMock('../jobs/expire-holds', () => ({ expireHolds: vi.fn().mockRejectedValue(boom) }));
    vi.doMock('../jobs/orphaned-vans', () => ({
      checkOrphanedVans: vi.fn().mockRejectedValue(boom),
    }));
    vi.doMock('../jobs/prune-sessions', () => ({ pruneSessions: vi.fn().mockRejectedValue(boom) }));
    vi.doMock('../jobs/trip-reminders', () => ({
      sendTripReminders: vi.fn().mockRejectedValue(boom),
    }));
    vi.doMock('../jobs/review-requests', () => ({
      sendReviewRequests: vi.fn().mockRejectedValue(boom),
    }));

    try {
      const { startScheduledJobs: start } = await import('../jobs');
      (schedule as unknown as Mock).mockClear();
      start();

      const failing = registrations();
      expect(failing).toHaveLength(5);
      for (const r of failing) {
        await expect(r.callback(), `${r.options.name} must swallow its own failure`).resolves.toBe(
          undefined,
        );
      }
      // Each one reported its own failure rather than passing it upwards.
      expect(errors).toHaveBeenCalledTimes(5);
    } finally {
      for (const path of [
        '../jobs/expire-holds',
        '../jobs/orphaned-vans',
        '../jobs/prune-sessions',
        '../jobs/trip-reminders',
        '../jobs/review-requests',
      ]) {
        vi.doUnmock(path);
      }
      vi.resetModules();
      errors.mockRestore();
    }
  });
});
