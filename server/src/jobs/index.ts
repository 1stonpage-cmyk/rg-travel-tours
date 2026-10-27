/**
 * The scheduler (Week 3 checkout plan, Task 11, owner Ruling 11 / Q1).
 *
 * This module is the ONLY place that knows about time passing. Every job it
 * runs takes its clock as a parameter and can be called directly — which is
 * how the tests exercise `expireHolds()` without waiting on a timer.
 *
 * That left the SCHEDULE itself unguarded: for a long time no test imported
 * this file at all, so the five expressions, the five names and the four
 * timezones were only ever read by node-cron. `jobs-registration.test.ts`
 * (7N item 8) now drives `startScheduledJobs()` against a stubbed `schedule`
 * and pins all of it, including that `expire-holds` deliberately passes no
 * timezone and that no job's failure rejects into the scheduler.
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
import { checkOrphanedVans } from './orphaned-vans';
import { pruneSessions } from './prune-sessions';
import { sendReviewRequests } from './review-requests';
import { sendTripReminders } from './trip-reminders';

/** §5 / §13: the hold-expiry sweep runs every minute. */
const EVERY_MINUTE = '* * * * *';

/**
 * D5 (2026-10-16): the orphaned-van check, 07:00 Manila — before the first
 * departures, so a dispatcher starting the day sees it. The zone is passed
 * to node-cron explicitly below; the server's own zone is not assumed.
 *
 * Q5 (2026-10-23): the review-request sweep runs on this same expression, as
 * **its own `schedule()` call** below rather than as logic inside
 * `orphaned-vans` — "so neither job's failure touches the other". The hour
 * suits it for a second reason: the trips it asks about finished yesterday,
 * and 07:00 is before today's departures take anyone's attention.
 */
const DAILY_0700 = '0 7 * * *';

/**
 * Task 14 (7E): the day-before trip reminder, 16:00 Manila.
 *
 * Not 07:00 like the two jobs above, and the reason is who the email is for.
 * The orphaned-van check and the review sweep are read by staff; this one is
 * read by a guest who has to act on it — be awake, be packed, and have the
 * balance ready for a pickup that is often before dawn. Late afternoon the day
 * before is when that is still actionable: it arrives while the guest is up,
 * it leaves the office reachable for an hour or two if they have a question,
 * and it is close enough to the trip to be remembered. A 07:00 send would be
 * twenty-five hours early and compete with a working day; an evening send
 * would arrive after the office has gone home.
 *
 * Zone passed explicitly below, like every job here.
 */
const DAILY_1600 = '0 16 * * *';

/**
 * C3 (2026-10-16): the expired-session sweep, 03:30 Manila — off-peak, the
 * quietest hour for a day-tour operator. Zone passed explicitly below, as above.
 */
const DAILY_0330 = '30 3 * * *';

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
        const { expired, failed } = await expireHolds(new Date());
        // Silent on a no-op: this runs 1,440 times a day. `skippedWithMoney`
        // logs itself, loudly, from inside the sweep.
        if (expired > 0 || failed > 0) {
          console.log(
            `[jobs] expire-holds: released ${expired} lapsed hold(s)` +
              (failed > 0 ? `, ${failed} could not be expired and will be retried` : ''),
          );
        }
      } catch (error) {
        console.error('[jobs] expire-holds failed', error);
      }
    },
    { name: 'expire-holds', noOverlap: true },
  );

  /*
   * A look, never a fix: this job changes no van status (see its header).
   * Same try/catch as above, for the same reason — a throw into the scheduler
   * takes the API process down with it.
   */
  schedule(
    DAILY_0700,
    async () => {
      try {
        await checkOrphanedVans(new Date());
      } catch (error) {
        console.error('[jobs] orphaned-vans failed', error);
      }
    },
    { name: 'orphaned-vans', timezone: 'Asia/Manila', noOverlap: true },
  );

  /*
   * Deletes lapsed `sessions` rows (see `deleteExpiredSessions`). Same
   * try/catch as the jobs above, for the same reason — a throw into the
   * scheduler takes the API process down, and a missed night is harmless:
   * tomorrow's run deletes everything this one would have.
   */
  schedule(
    DAILY_0330,
    async () => {
      try {
        await pruneSessions(new Date());
      } catch (error) {
        console.error('[jobs] prune-sessions failed', error);
      }
    },
    { name: 'prune-sessions', timezone: 'Asia/Manila', noOverlap: true },
  );

  /*
   * §11's day-before reminder (Task 14). Same try/catch as every job above —
   * a throw into the scheduler takes the API process down — and a missed
   * afternoon costs one email, never a booking: the sweep claims each booking
   * with an audit row before it mails, so tomorrow's run will not send twice.
   */
  schedule(
    DAILY_1600,
    async () => {
      try {
        const { sent, failed } = await sendTripReminders(new Date());
        if (sent > 0 || failed > 0) {
          console.log(
            `[jobs] trip-reminders: reminded ${sent} guest(s) about tomorrow` +
              (failed > 0 ? `, ${failed} could not be claimed` : ''),
          );
        }
      } catch (error) {
        console.error('[jobs] trip-reminders failed', error);
      }
    },
    { name: 'trip-reminders', timezone: 'Asia/Manila', noOverlap: true },
  );

  /*
   * §11's review request (Q5, 2026-10-23). Its OWN registration on the same
   * expression as `orphaned-vans`, deliberately not folded into that job's
   * callback: one of them throwing must not stop the other from running.
   */
  schedule(
    DAILY_0700,
    async () => {
      try {
        const { sent, failed } = await sendReviewRequests(new Date());
        if (sent > 0 || failed > 0) {
          console.log(
            `[jobs] review-requests: asked ${sent} guest(s) for a review` +
              (failed > 0 ? `, ${failed} could not be claimed` : ''),
          );
        }
      } catch (error) {
        console.error('[jobs] review-requests failed', error);
      }
    },
    { name: 'review-requests', timezone: 'Asia/Manila', noOverlap: true },
  );
}
