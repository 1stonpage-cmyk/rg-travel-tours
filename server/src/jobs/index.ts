/**
 * The scheduler (Week 3 checkout plan, Task 11, owner Ruling 11 / Q1).
 *
 * This module is the ONLY place that knows about time passing. Every job it
 * runs takes its clock as a parameter and can be called directly — which is
 * how the tests exercise `expireHolds()` without waiting on a timer, and why
 * no test imports this file.
 *
 * **Importing this module starts nothing.** `startScheduledJobs()` is called
 * once, explicitly, from `server/src/index.ts` — the same discipline as
 * `db/client.ts`, where importing never opens a connection.
 *
 * ## ONE PROCESS. PM2 fork mode, 1 instance.
 *
 * Under cluster mode every worker runs this schedule, so every sweep would
 * fire N times — N transactions racing for the same booking rows once a
 * minute. The sweep is idempotent, so that is survivable rather than
 * corrupting, but it is still N times the work and N times the lock
 * contention for nothing. `docs/LAUNCH_CHECKLIST.md` records fork mode with
 * two independent reasons; this is one of them.
 */
import { schedule } from 'node-cron';
import { expireHolds } from './expire-holds';

/** §5 / §13: the hold-expiry sweep runs every minute. */
const EVERY_MINUTE = '* * * * *';

/**
 * Starts every scheduled job. Called once, from the server entrypoint.
 *
 * `noOverlap` (node-cron's own option) skips a tick while the previous one
 * is still running, so a slow sweep queues nothing up behind it. It is a
 * politeness, not the safety net: `expireHolds()` is idempotent, so two
 * overlapping sweeps would reach the same end state anyway.
 *
 * The callback can never reject into the scheduler: a sweep that throws
 * (a dropped connection, a lock timeout) is logged and the next minute
 * tries again. An unhandled rejection here would take the whole API process
 * down with it, which is a far worse failure than a minute of unreleased
 * capacity.
 */
export function startScheduledJobs(): void {
  schedule(
    EVERY_MINUTE,
    async () => {
      try {
        const { expired } = await expireHolds(new Date());
        // Silent on a no-op: this runs 1,440 times a day.
        if (expired > 0) {
          console.log(`[jobs] expire-holds: released ${expired} lapsed hold(s)`);
        }
      } catch (error) {
        console.error('[jobs] expire-holds failed', error);
      }
    },
    { name: 'expire-holds', noOverlap: true },
  );
}
