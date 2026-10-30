/**
 * The session cookie's name and flags, in one place (Week 4 plan, Task 1;
 * split into one cookie per surface for BUG-119, Week 7).
 *
 * One place because the flags ARE the security control. A resolver that
 * hand-rolled its own `res.cookie(...)` and forgot `httpOnly` would hand
 * every XSS payload a live session, and nothing would fail — not a test,
 * not a type, not a lint rule. So no resolver writes this cookie directly;
 * they call these two functions.
 *
 * CLAUDE.md and §12: "secure, httpOnly, sameSite=lax cookies."
 *
 *  - **`httpOnly`** is the one that matters most: it keeps the token out of
 *    `document.cookie`, so a script injected into the page cannot read it.
 *  - **`sameSite: 'lax'`** is the CSRF half. The browser will not attach
 *    this cookie to a cross-site POST, which is what stops another origin
 *    from driving a state-changing tRPC mutation as a logged-in guest.
 *    `lax` rather than `strict` deliberately: `strict` would also drop the
 *    cookie on a top-level navigation back from the payment gateway, so a
 *    guest returning from PayMongo would arrive logged out.
 *  - **`secure`** is conditional on `SITE_ENV`, and the condition is not
 *    laziness: a `secure` cookie is never sent over plain HTTP, so setting
 *    it unconditionally would make the portal appear to log in and then be
 *    immediately logged out on the dev server (HTTP, port 5180). Production
 *    is HTTPS-only, where it is always on.
 *
 * ## One cookie per surface (BUG-119)
 *
 * There used to be one cookie, `rg_session`, shared by all three surfaces —
 * so a guest signing into "My Booking" in a browser that also had a live
 * staff session overwrote it, and vice versa. That was never a privilege
 * escalation (each `sessions` row still carries its own `subject_type`, and
 * `requireRole`/`requireDriver`/`requireCustomer` still refuse the wrong
 * kind) but it meant two surfaces could never be signed in at once in the
 * same browser, which a guest helping at the front desk while staff are also
 * signed in will absolutely do.
 *
 * `SESSION_COOKIE_BY_SUBJECT` gives each surface its own cookie NAME, so a
 * browser can hold all three at once. The flags below are unchanged and
 * still identical across all three — only the name differs.
 */
import type { Response } from 'express';
import { env } from '../env';
import type { SessionSubject } from '../services/sessions';

/**
 * One cookie name per `sessions.subject_type`. `user` is the admin/staff
 * surface, `driver` the driver portal, `customer` the guest "My Booking"
 * portal — the same three values `SESSION_TTL_MS_BY_SUBJECT` keys off.
 * Prefixed so none of the three can collide with anything else on the host.
 */
export const SESSION_COOKIE_BY_SUBJECT: Record<SessionSubject, string> = {
  user: 'rg_admin_session',
  driver: 'rg_driver_session',
  customer: 'rg_customer_session',
};

/**
 * `expires` rather than `maxAge`, matching the row's own `expires_at`: the
 * cookie and the database agree on one instant, so a browser does not keep
 * sending a token the server will refuse.
 */
export function setSessionCookie(
  res: Response,
  subjectType: SessionSubject,
  token: string,
  expiresAt: Date,
): void {
  res.cookie(SESSION_COOKIE_BY_SUBJECT[subjectType], token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: env.SITE_ENV === 'production',
    expires: expiresAt,
    path: '/',
  });
}

/**
 * Clears the cookie for one surface only. The matching `revokeSession()`
 * call is what actually ends the session — this only stops the browser
 * sending a token that is already dead. Doing just one of the two would
 * leave either a live session with no cookie (harmless) or a cookie with no
 * session (also harmless, but it makes "am I logged in?" answer wrongly
 * until the next request).
 *
 * `path` must match what `setSessionCookie` used or the browser keeps the
 * original cookie alongside the cleared one. Clearing one surface's cookie
 * never touches the other two — that is the whole point of the split.
 */
export function clearSessionCookie(res: Response, subjectType: SessionSubject): void {
  res.clearCookie(SESSION_COOKIE_BY_SUBJECT[subjectType], { path: '/' });
}
