/**
 * The expired-session sweep (Week 6.5, Task 10 / C3).
 *
 * Same shape as `expire-holds.ts`: the clock is a PARAMETER and scheduling
 * lives next door in `./index.ts`, so importing this starts nothing and the
 * tests call `pruneSessions()` directly without a timer. `index.ts` runs it
 * daily at 03:30 Asia/Manila.
 *
 * It deletes rows; the reasoning (why `lte`, why this is not a soft-delete
 * violation) lives with the query in `deleteExpiredSessions`. It is
 * idempotent, so a double run under PM2 cluster mode would be wasteful, not
 * wrong — `docs/LAUNCH_CHECKLIST.md` lists it with the other jobs.
 *
 * Logs only when it deleted something. It runs once a day, so a line is
 * cheap, but a "deleted 0" line every morning trains people to ignore the log.
 */
import { deleteExpiredSessions } from '../services/sessions';

export async function pruneSessions(now: Date): Promise<{ deleted: number }> {
  const deleted = await deleteExpiredSessions(now);
  if (deleted > 0) {
    console.log(`[jobs] prune-sessions: deleted ${deleted} expired session(s)`);
  }
  return { deleted };
}
