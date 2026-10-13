/**
 * Staff authentication (Week 4 plan, Task 5 — Week 1's 1C, pulled in by
 * owner decision 2026-10-13 because Task 7's approve/reject needs a human
 * who can actually sign in).
 *
 * Narrow on purpose, as approved: verify a password, and throttle guessing.
 * No password reset, no invitations, no user management — those arrive with
 * the admin weeks.
 *
 * ## Every failure is the same failure
 *
 * Unknown email, wrong password, deactivated account, a role that is not an
 * admin role: all `null`, no reason. §7 applies the same rule to the portal
 * login, and the reasoning is identical — two distinguishable answers make
 * the pair an oracle, here for "which staff emails exist".
 *
 * **And identical in TIME, not only in text.** An unknown email that skipped
 * hashing would answer in a millisecond where a real account takes ~250ms,
 * which enumerates the staff list regardless of what the message says. So
 * the no-user path runs `dummyVerify()`, which does the same scrypt work
 * against a throwaway hash. That is also why the deactivated-user check
 * happens AFTER the hash rather than before it: an early return on
 * `is_active` would restore exactly the timing difference the dummy exists
 * to remove.
 *
 * ## The per-email throttle, and why it is in memory
 *
 * Per-IP limiting is `createProcedureRateLimit` in `middleware/rate-limit.ts`
 * and is mounted in `app.ts`. It does not help against an attacker spreading
 * guesses for ONE account across many addresses, which is the shape that
 * matters when there are perhaps four staff accounts in total — so there is
 * a second counter, keyed by email.
 *
 * It is an in-process `Map` rather than a table, for three reasons: the
 * launch checklist already requires PM2 **fork mode, a single instance**
 * (so there is exactly one counter), `express-rate-limit`'s own store is
 * in-memory for the same reason, and a `users` table column would make
 * every failed guess a write. The cost is that a restart forgives
 * outstanding attempts — acceptable, because the per-IP limiter survives
 * nothing either and the real protection against sustained guessing is the
 * 250ms scrypt cost.
 *
 * **If PM2 is ever switched to cluster mode, this and the IP limiter both
 * become N times weaker.** The checklist says not to; this note is here for
 * whoever ignores it.
 */
import { eq, sql } from 'drizzle-orm';
import { ADMIN_ROLES, type AdminRole } from '@rg/shared';
import { getDb } from '../db/client';
import { users } from '../db/schema';
import { dummyVerify, verifyPassword } from './password';

/** Owner instruction: rate limit per email as well as per IP. */
export const STAFF_LOGIN_MAX_PER_EMAIL = 5;
export const STAFF_LOGIN_WINDOW_MS = 15 * 60_000;

interface Attempts {
  count: number;
  resetAt: number;
}

const byEmail = new Map<string, Attempts>();

/** Lowercased and trimmed, so the throttle cannot be dodged by casing. */
function emailKey(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * True when this email has spent its budget. Checked BEFORE the password is
 * hashed — the point of the throttle is to stop paying 250ms and 128MB for
 * an attacker's guesses, so checking after would defeat it.
 */
export function isEmailThrottled(email: string, now: Date): boolean {
  const entry = byEmail.get(emailKey(email));
  if (!entry) return false;
  if (entry.resetAt <= now.getTime()) {
    byEmail.delete(emailKey(email));
    return false;
  }
  return entry.count >= STAFF_LOGIN_MAX_PER_EMAIL;
}

function recordFailure(email: string, now: Date): void {
  const key = emailKey(email);
  const entry = byEmail.get(key);
  if (!entry || entry.resetAt <= now.getTime()) {
    byEmail.set(key, { count: 1, resetAt: now.getTime() + STAFF_LOGIN_WINDOW_MS });
    return;
  }
  entry.count += 1;
}

/** A success clears the counter: a staff member who mistypes twice then
 * succeeds should not be three failures from a lockout. */
function clearFailures(email: string): void {
  byEmail.delete(emailKey(email));
}

/** Test-only: the counter is process-global, so a suite must be able to reset it. */
export function resetEmailThrottleForTests(): void {
  byEmail.clear();
}

export interface StaffIdentity {
  userId: number;
  role: AdminRole;
}

/**
 * Verifies staff credentials. `null` for every failure, with no reason and
 * no timing difference.
 *
 * `now` is a parameter, as everywhere else in this codebase that makes a
 * time-based decision, so the throttle window is assertable rather than
 * dependent on when the suite runs.
 */
export async function verifyStaffPassword(
  email: string,
  password: string,
  now: Date = new Date(),
): Promise<StaffIdentity | null> {
  if (isEmailThrottled(email, now)) return null;

  const [user] = await getDb()
    .select({
      id: users.id,
      role: users.role,
      isActive: users.isActive,
      passwordHash: users.passwordHash,
    })
    .from(users)
    // Case-insensitively, because an email is not case-sensitive in practice
    // and a staff member typing `Owner@` must not be told "no such user".
    .where(sql`LOWER(${users.email}) = ${emailKey(email)}`)
    .limit(1);

  if (!user) {
    // The work, deliberately. See the module note on timing.
    await dummyVerify(password);
    recordFailure(email, now);
    return null;
  }

  const ok = await verifyPassword(password, user.passwordHash);

  /*
   * Everything below is checked AFTER the hash so that every path costs the
   * same. A deactivated account with the right password and a deactivated
   * account with the wrong one are also indistinguishable, which is correct:
   * a former employee should not be able to confirm their password still
   * works.
   */
  if (!ok || !user.isActive || !(ADMIN_ROLES as readonly string[]).includes(user.role)) {
    recordFailure(email, now);
    return null;
  }

  clearFailures(email);
  return { userId: user.id, role: user.role };
}

/**
 * Records the successful login on the row, for the admin UI's "last seen".
 * Separate from verification so a failed attempt never writes, and so the
 * caller decides whether a login it refused for another reason (an origin
 * check, say) should still stamp the row. It should not.
 */
export async function markStaffLogin(userId: number, now: Date): Promise<void> {
  await getDb().update(users).set({ lastLoginAt: now }).where(eq(users.id, userId));
}
