/**
 * The session cookie's name and flags, in one place (Week 4 plan, Task 1).
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
 */
import type { Response } from 'express';
import { env } from '../env';

/** The cookie name. Prefixed so it cannot collide with anything else on the host. */
export const SESSION_COOKIE = 'rg_session';

/**
 * `expires` rather than `maxAge`, matching the row's own `expires_at`: the
 * cookie and the database agree on one instant, so a browser does not keep
 * sending a token the server will refuse.
 */
export function setSessionCookie(res: Response, token: string, expiresAt: Date): void {
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: env.SITE_ENV === 'production',
    expires: expiresAt,
    path: '/',
  });
}

/**
 * Clears the cookie. The matching `revokeSession()` call is what actually
 * ends the session — this only stops the browser sending a token that is
 * already dead. Doing just one of the two would leave either a live session
 * with no cookie (harmless) or a cookie with no session (also harmless, but
 * it makes "am I logged in?" answer wrongly until the next request).
 *
 * `path` must match what `setSessionCookie` used or the browser keeps the
 * original cookie alongside the cleared one.
 */
export function clearSessionCookie(res: Response): void {
  res.clearCookie(SESSION_COOKIE, { path: '/' });
}
