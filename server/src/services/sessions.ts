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
import { and, eq, gt, lte, ne } from 'drizzle-orm';
import { getDb, type Transaction } from '../db/client';
import { sessions, users } from '../db/schema';

/** The three things a session can belong to — `sessions.subject_type`. */
export type SessionSubject = 'user' | 'customer' | 'driver';

/**
 * How long a session lives, by subject type (owner-decided 2026-10-15, Q1).
 *
 * §8: a DRIVER session lasts 12 hours — a driver's phone spends its day in
 * a van that other people get into, so the window is the working day and
 * not the calendar one. Staff and guests keep the 24 hours they have had
 * since Week 4: §7 logs a guest in with a booking ref and an email rather
 * than a password, so the session is the weaker credential of the two and
 * should not outlive the visit by much; a day covers "check it again this
 * evening" without leaving a usable cookie on a shared phone next week.
 *
 * The map is the single source of truth, and it REPLACED a single
 * `SESSION_TTL_MS` that was 24 hours for all three (nothing outside this
 * file ever imported it). `createSession` reads the map by subject; there
 * is deliberately NO per-call override, because an override that is
 * forgotten produces a session that looks fine and lives too long.
 *
 * `Record<SessionSubject, number>` so a fourth subject type cannot be added
 * to the union without a TTL being decided for it here.
 */
export const SESSION_TTL_MS_BY_SUBJECT: Record<SessionSubject, number> = {
  user: 24 * 60 * 60 * 1000,
  customer: 24 * 60 * 60 * 1000,
  driver: 12 * 60 * 60 * 1000,
};

export interface ResolvedSession {
  subjectType: string;
  subjectId: number;
  /**
   * The staff role, for `subject_type = 'user'` sessions only, read LIVE
   * from the `users` row rather than stored in the session. See
   * `readSession` for why that matters.
   */
  role?: string;
  /**
   * For `subject_type = 'user'` only, and live like `role`: a reset made
   * while the staff member is mid-session takes effect on their next request.
   */
  mustChangePassword?: boolean;
  /**
   * The staff member's display name, for `subject_type = 'user'` only and
   * read LIVE from the `users` row for the same reason as `role`: a rename
   * made mid-session must show up on the very next request rather than
   * waiting out the session. `users.name` is `NOT NULL`, so this is never an
   * empty string for a session that resolves at all.
   */
  name?: string;
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
 *
 * The lifetime comes from `SESSION_TTL_MS_BY_SUBJECT` and from nowhere
 * else — there is no `ttlMs` parameter, on purpose. See that map's note.
 */
export async function createSession(
  subjectType: SessionSubject,
  subjectId: number,
  now: Date,
): Promise<{ token: string; expiresAt: Date }> {
  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(now.getTime() + SESSION_TTL_MS_BY_SUBJECT[subjectType]);

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
      mustChangePassword: users.mustChangePassword,
      name: users.name,
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
    return {
      subjectType: row.subjectType,
      subjectId: row.subjectId,
      role: row.role,
      mustChangePassword: row.mustChangePassword === true,
      name: row.name ?? undefined,
    };
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

/**
 * Ends every session one subject holds — "log this driver out everywhere"
 * (owner decision 2026-10-16, D4).
 *
 * How it differs from `revokeSession`: that one is a LOGOUT, keyed on the
 * token, deleting one row and leaving a sibling device signed in. This is a
 * REVOCATION, keyed on the subject, deleting all of them.
 *
 * Takes the CALLER'S transaction rather than opening its own, which is the
 * whole point: the revocation and the state change that justifies it commit
 * together or not at all. A revocation in its own transaction would log a
 * driver out of a deactivation that then rolled back — and a driver locked
 * out of a job they still hold, at a pier, is a worse failure than the one
 * this closes.
 *
 * `subject_id` is polymorphic (`schema.ts`), so the TYPE is half of the key:
 * `drivers.id = 7` and `users.id = 7` are different subjects, and
 * `sessions_subject_idx` is on the pair for exactly this query.
 *
 * Returns the count so the caller can audit it. `affectedRows` is a true
 * count here, unlike on an UPDATE: `CLIENT_FOUND_ROWS` changes what an UPDATE
 * reports (matched, not changed — see the note beside `getPool()`) and has no
 * bearing on a DELETE. Zero is an ordinary answer: a driver who was not
 * signed in anywhere.
 */
export async function revokeSessionsForSubject(
  tx: Transaction,
  subjectType: SessionSubject,
  subjectId: number,
): Promise<number> {
  const [result] = await tx
    .delete(sessions)
    .where(and(eq(sessions.subjectType, subjectType), eq(sessions.subjectId, subjectId)));
  return result.affectedRows;
}

/**
 * Ends every session one subject holds EXCEPT the one whose token is given —
 * the "change password" rule: the device that changed it stays signed in, every
 * other device is signed out. Same transaction discipline as
 * `revokeSessionsForSubject`. Returns how many were ended, for the audit row.
 */
export async function revokeOtherSessionsForSubject(
  tx: Transaction,
  subjectType: SessionSubject,
  subjectId: number,
  keepToken: string,
): Promise<number> {
  const [result] = await tx
    .delete(sessions)
    .where(
      and(
        eq(sessions.subjectType, subjectType),
        eq(sessions.subjectId, subjectId),
        ne(sessions.tokenHash, hashToken(keepToken)),
      ),
    );
  return result.affectedRows;
}

/**
 * Deletes every session whose `expires_at` has passed, and returns how many.
 * Its own transaction — nothing else needs to commit with it. The daily
 * `prune-sessions` job (`jobs/prune-sessions.ts`) is the only caller.
 *
 * Until this existed nothing deleted an expired row: `revokeSession` removes
 * one on sign-out, and a session that simply lapsed stayed forever, harmless
 * (`readSession` refuses it) and permanent. This is the sweep the schema was
 * written expecting — `sessions_expiry_idx` is documented there as "The sweep
 * that deletes expired rows (a §13 cron job)", so the delete is an index range
 * scan rather than a table scan.
 *
 * **`lte`, not `lt`, and the reason is `readSession`.** It resolves a session
 * with `gt(expiresAt, now)` and its note says the expiry instant itself is
 * already past ("`gt(expiresAt, now)` is strict, so the expiry instant itself
 * is already expired"). The sweep must agree to the instant: with `lt` a row
 * expiring exactly at `now` would be dead to the reader and live to the sweep,
 * and a row both of them disagree about is a row nobody ever removes.
 *
 * **Deleting here is not a soft-delete violation.** The standing rule
 * ("never hard-delete bookings or payments") names records. A session is a
 * credential whose whole purpose has ended; keeping it is a liability, not a
 * record. The trail of who signed in, and when, lives in `audit_log` and this
 * touches none of it. Every subject type is swept — `user`, `customer` and
 * `driver` alike — because the condition is the clock and nothing else.
 *
 * Idempotent: a second run, or two overlapping runs, find nothing new to
 * delete. (A DELETE's `affectedRows` is a true count; `CLIENT_FOUND_ROWS`
 * only changes what an UPDATE reports — see `revokeSessionsForSubject`.)
 */
export async function deleteExpiredSessions(now: Date): Promise<number> {
  return getDb().transaction(async (tx) => {
    const [result] = await tx.delete(sessions).where(lte(sessions.expiresAt, now));
    return result.affectedRows;
  });
}
