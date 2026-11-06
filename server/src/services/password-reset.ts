/**
 * Self-service staff password reset — the token, the clock and the throttle
 * (§12's third door; owner decision 2026-11-06, task 1C).
 *
 * `staffAuth.requestPasswordReset` and `staffAuth.resetPassword` are the two
 * resolvers; everything security-shaped about them that is not SQL lives
 * here, exactly as `services/staff-auth.ts` holds the login's refusal and
 * throttle. The mail itself is `services/notify/staff-password-reset.ts`.
 *
 * ## SHA-256, not scrypt — and the reason is the entropy, not a shortcut
 *
 * A reviewer should ask why a *credential* is hashed with a fast digest when
 * `services/password.ts` goes to 128MB and 250ms for a password. The answer
 * is that the two secrets are not the same kind of thing:
 *
 *  * A password is **human-chosen**: perhaps 40 bits of real entropy, inside
 *    a dictionary an attacker already has. A memory-hard KDF exists to make
 *    searching that space expensive, and that is the whole of its job.
 *  * This token is `randomBytes(32)` — **256 bits with no structure**, no
 *    dictionary and nothing to guess. There is no search to slow down, so
 *    scrypt would add a quarter-second and 128MB to every click of a reset
 *    link and buy exactly nothing. Worse: it would hand an *unauthenticated*
 *    endpoint the memory-exhaustion lever `password.ts` already warns about,
 *    which is a real downgrade rather than a neutral one.
 *
 * Hashing at all is still essential, and for one specific reason: a database
 * leak must hand over a list of digests rather than a folder of live reset
 * links. That is the same trade `sessions.token_hash` already records for
 * the session cookie, which is likewise 32 random bytes behind a SHA-256.
 *
 * ## Every time-based decision takes `now`
 *
 * The 30-minute window and the throttle window are both assertable to the
 * millisecond because nothing here reads a clock — the resolver reads one
 * `now` at the request boundary and passes it down, as `verifyStaffPassword`,
 * `createSession` and `validateCoupon` all do.
 *
 * ## Nothing here logs, returns or throws with a raw token
 *
 * `hashResetToken` is the only function that sees one besides
 * `passwordResetUrl`, and neither writes anywhere.
 */
import { createHash } from 'node:crypto';
import { env } from '../env';

/**
 * How long a reset link lives (BUILD_SPEC §12: "valid 30 minutes").
 *
 * Short on purpose. The link arrives in an inbox, which is a place this
 * system does not control and cannot revoke from — so the window is the time
 * a person needs to read a mail and type a password, not the time they might
 * get round to it.
 */
export const RESET_TOKEN_TTL_MS = 30 * 60_000;

/**
 * The per-EMAIL half of the rate limit, keyed by lowercased address.
 *
 * In an in-process `Map` rather than a table, for the three reasons
 * `services/staff-auth.ts` sets out at length and which apply here
 * unchanged: PM2 runs fork mode with a single instance, `express-rate-limit`
 * is in-memory for the same reason, and a column on `users` would make every
 * request a write. **If PM2 is ever switched to cluster mode this and the IP
 * limiter both become N times weaker.**
 *
 * It differs from the login throttle in ONE way, and the difference is the
 * point: the login counts **failures**, because a staff member who signs in
 * correctly should never spend budget. This counts **every request**,
 * successful ones included, because a successful request is precisely the
 * thing being rationed — it puts an email in someone else's inbox and costs
 * us an outbound send. A limiter that only counted the misses would leave
 * "spam the owner's inbox" unlimited.
 *
 * Three per fifteen minutes: a staff member who did not get the first mail
 * can ask twice more, and nobody can turn the endpoint into a mail cannon.
 */
export const RESET_MAX_PER_EMAIL = 3;
export const RESET_WINDOW_MS = 15 * 60_000;

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
 * True when this address has spent its budget for the window.
 *
 * A throttled request still returns the SAME generic response as every other
 * one — see the resolver. Answering differently here would turn the throttle
 * into the oracle the generic message exists to prevent.
 */
export function isResetThrottled(email: string, now: Date): boolean {
  const key = emailKey(email);
  const entry = byEmail.get(key);
  if (!entry) return false;
  if (entry.resetAt <= now.getTime()) {
    byEmail.delete(key);
    return false;
  }
  return entry.count >= RESET_MAX_PER_EMAIL;
}

/**
 * Counts one request against this address.
 *
 * Called for EVERY request that gets past the throttle, before the account
 * lookup and whether or not an account turns out to exist. Recording only
 * the matches would give an attacker unlimited probes of addresses that do
 * not exist, which is the enumeration this whole procedure is shaped around
 * preventing.
 */
export function recordResetRequest(email: string, now: Date): void {
  const key = emailKey(email);
  const entry = byEmail.get(key);
  if (!entry || entry.resetAt <= now.getTime()) {
    byEmail.set(key, { count: 1, resetAt: now.getTime() + RESET_WINDOW_MS });
    return;
  }
  entry.count += 1;
}

/** Test-only: the counter is process-global, so a suite must be able to reset it. */
export function resetPasswordResetThrottleForTests(): void {
  byEmail.clear();
}

/**
 * The one-way form of a reset token, and the only form that is ever stored.
 *
 * Hex rather than base64, matching `sessions.ts`'s `hashToken` and the
 * `varchar(64)` the column is declared as.
 */
export function hashResetToken(rawToken: string): string {
  return createHash('sha256').update(rawToken).digest('hex');
}

/**
 * The absolute link that goes in the email.
 *
 * Built from `PUBLIC_BASE_URL`, which is this project's one base-URL setting
 * — `checkout.startPayment` builds the gateway return URLs from it and
 * `notify/templates.ts` builds the portal sign-in link from it. Never a
 * hardcoded host and never a new env var.
 *
 * Absolute, not relative: a mail client resolves a relative href against
 * nothing at all.
 */
export function passwordResetUrl(rawToken: string): string {
  const base = env.PUBLIC_BASE_URL.replace(/\/+$/, '');
  return `${base}/admin/reset-password?token=${encodeURIComponent(rawToken)}`;
}

/** What stands in for the part of an address a log line must not carry. */
const MASK = '•••';

/**
 * An address reduced to something a log line can carry: `j•••@example.com`.
 *
 * Used by the unconfigured-SMTP path, which says that a reset mail WOULD
 * have gone out. That line has to be useful to a developer staring at a
 * terminal and useless to anyone reading logs later — logs are read by
 * anyone with server access and are routinely shipped to a third-party
 * aggregator, so a full staff address in one is an RA 10173 disclosure
 * waiting for a breach of the aggregator.
 *
 * **Pure, total, and it never emits the whole address.** Three edges, each
 * with its own test:
 *
 *  * **No `@` at all** — not an address shape, so nothing is recognisable
 *    enough to keep. The whole value is replaced.
 *  * **An empty local part** (`@example.com`) — there is no first character
 *    to show, and `local[0]` would be `undefined`.
 *  * **A one-character local part** (`j@example.com`) — showing the first
 *    character here would print the ENTIRE address, so this case masks the
 *    local part completely. That is the case the obvious implementation gets
 *    wrong.
 *
 * The domain is kept, as in the brief's own example: it is what makes the
 * line useful ("so it did try the office address"), and it is shared by
 * every staff member rather than identifying one.
 *
 * `lastIndexOf` rather than `indexOf`, so a local part containing an `@`
 * cannot shift the split and leak the real local part into the "domain".
 */
export function maskEmail(email: string): string {
  const at = email.lastIndexOf('@');
  if (at < 0) return MASK;

  const local = email.slice(0, at);
  // Includes the '@', so the two cases below concatenate without re-adding it.
  const domain = email.slice(at);

  if (local.length <= 1) return `${MASK}${domain}`;
  return `${local[0]}${MASK}${domain}`;
}
