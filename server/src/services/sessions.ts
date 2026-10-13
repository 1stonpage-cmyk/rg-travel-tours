/**
 * Session lifecycle — mint, resolve, revoke (Week 4 plan, Task 1).
 *
 * **This is the layer that did not exist.** `app.ts` mounted tRPC with no
 * `createContext`, so `ctx.session` was always `undefined` and every
 * `adminProcedure` refused every call. Nothing was broken by that — it
 * failed closed — but nothing above it had ever run with a real session
 * either. Both the customer portal (§7, ref + email) and the staff login
 * (§13's 1C, pulled into Week 4) resolve through here.
 *
 * ## The token is the credential; the database never holds it
 *
 * `createSession` returns a token that goes into an httpOnly cookie and is
 * never stored. What is stored is its SHA-256. A leaked database dump is
 * then a list of hashes rather than a list of live logins — the same reason
 * `users.password_hash` and `drivers.pin_hash` exist.
 *
 * SHA-256 and not argon2, deliberately, and the difference matters: a
 * password is low-entropy and human-chosen, so it needs a slow hash to make
 * guessing expensive. These tokens are 32 random bytes from the CSPRNG —
 * there is nothing to guess, so the only job of the hash is to be one-way,
 * and a fast one-way hash is correct for a value read on every request.
 *
 * ## `now` is always a parameter
 *
 * Nothing here calls `new Date()` for a decision. The expiry boundary is
 * then assertable to the millisecond in a test instead of depending on when
 * the suite runs — the discipline `validateCoupon()`, `createHold()` and
 * `expireHolds()` all follow.
 *
 * ## Sessions are rows, so revocation is real
 *
 * A signed stateless token cannot be withdrawn before it expires. A row
 * can: `revokeSession` deletes it and the next request resolves to `null`.
 * That is what makes logout mean something, and it is why the `sessions`
 * table is worth a query per request.
 */
import { createHash, randomBytes } from 'node:crypto';
import { and, eq, gt } from 'drizzle-orm';
import { getDb } from '../db/client';
import { sessions, users } from '../db/schema';

/**
 * A day. §7 logs a guest in with a booking ref and an email rather than a
 * password, so the session is the weaker credential of the two and should
 * not outlive the visit by much; a day covers "check it again this evening"
 * without leaving a usable cookie on a shared phone next week.
 */
export const SESSION_TTL_MS = 24 * 60 * 60 * 1000;

/** The three things a session can belong to — `sessions.subject_type`. */
export type SessionSubject = 'user' | 'customer' | 'driver';

export interface ResolvedSession {
  subjectType: string;
  subjectId: number;
  /**
   * The staff role, for `subject_type = 'user'` sessions only, read LIVE
   * from the `users` row rather than stored in the session. See
   * `readSession` for why that matters.
   */
  role?: string;
}

/** One-way, fast, and the only form the token takes at rest. */
function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * Mints a session and returns the token exactly once — the caller puts it
 * in the cookie, and no later call can retrieve it.
 *
 * `subjectId` is polymorphic and carries no foreign key: for `'customer'`
 * it is a `bookings.id` (§7 scopes a portal session to ONE booking), for
 * `'user'` a `users.id`, for `'driver'` a `drivers.id`.
 */
export async function createSession(
  subjectType: SessionSubject,
  subjectId: number,
  now: Date,
): Promise<{ token: string; expiresAt: Date }> {
  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(now.getTime() + SESSION_TTL_MS);

  await getDb()
    .insert(sessions)
    .values({
      subjectType,
      subjectId,
      tokenHash: hashToken(token),
      expiresAt,
      createdAt: now,
    });

  return { token, expiresAt };
}

/**
 * Resolves a cookie's token to its subject, or `null`.
 *
 * `null` for every failure — unknown, revoked, expired — and never a reason:
 * the caller cannot act differently on "this token was never real" versus
 * "this token has lapsed", and telling them apart would only ever leak.
 *
 * `gt(expiresAt, now)` is strict, so the expiry instant itself is already
 * past. The filtering happens in SQL rather than in JS on purpose: a row
 * that has expired is never loaded, so there is no window in which a caller
 * holds an expired session object and forgets to check it.
 */
export async function readSession(token: string, now: Date): Promise<ResolvedSession | null> {
  /*
   * A LEFT JOIN onto `users`, because a staff session needs the ROLE and
   * `requireRole` reads it off the session. Two consequences, and both are
   * the reason this is a join rather than a column on `sessions`:
   *
   *  1. **The role is live.** A staff member demoted from `owner` to
   *     `dispatcher` loses the owner's permissions on their very next
   *     request, instead of keeping them until their 24-hour session
   *     expires. A role copied into the session row at login would be a
   *     stale capability with a day-long tail.
   *  2. **Deactivation is immediate.** `is_active = false` makes this
   *     resolve to `null`, so a staff member who is switched off is signed
   *     out everywhere at once — which is the whole point of having the flag
   *     rather than deleting the row.
   *
   * The join is `LEFT`: a `customer` or `driver` session has no `users` row
   * and must still resolve. Only a `user` session is held to the extra
   * conditions below.
   */
  const [row] = await getDb()
    .select({
      subjectType: sessions.subjectType,
      subjectId: sessions.subjectId,
      role: users.role,
      isActive: users.isActive,
    })
    .from(sessions)
    .leftJoin(users, and(eq(sessions.subjectType, 'user'), eq(users.id, sessions.subjectId)))
    .where(and(eq(sessions.tokenHash, hashToken(token)), gt(sessions.expiresAt, now)))
    .limit(1);

  if (!row) return null;

  if (row.subjectType === 'user') {
    // A staff session whose user is gone or switched off is not a session.
    // Fails closed, and silently: the caller gets the same `null` as an
    // expired token, because it cannot act on the difference.
    if (!row.role || row.isActive !== true) return null;
    return { subjectType: row.subjectType, subjectId: row.subjectId, role: row.role };
  }

  return { subjectType: row.subjectType, subjectId: row.subjectId };
}

/**
 * Logout. Deletes the one row whose hash matches and nothing else — a
 * sibling session for the same subject (the same guest on a second device)
 * survives, which is why this keys on the token and not on `subject_id`.
 *
 * Idempotent: revoking an already-revoked or never-existing token deletes
 * nothing and resolves. Browsers send a logout twice more often than one
 * would think.
 */
export async function revokeSession(token: string): Promise<void> {
  await getDb()
    .delete(sessions)
    .where(eq(sessions.tokenHash, hashToken(token)));
}
