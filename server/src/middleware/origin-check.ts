/**
 * The origin check (Week 4 plan, Task 5; owner instruction 2026-10-14).
 *
 * CLAUDE.md and §12 require "CSRF protection on state-changing requests
 * (sameSite + origin check)". The cookie already carries `sameSite=lax`,
 * which is the first half; this is the second, and it is built **once as
 * middleware for every state-changing request** rather than per resolver,
 * because a CSRF defence that each new mutation has to remember to opt into
 * is a CSRF defence that the fifteenth mutation will not have.
 *
 * ## Why two halves rather than one
 *
 * `sameSite=lax` already stops a cross-site POST from carrying the session
 * cookie, so in a current browser a forged request arrives unauthenticated
 * and fails anyway. The origin check is the belt to that braces, and it
 * earns its place because `lax` has real gaps: a top-level form submission
 * is exempt from `lax` for GET, a browser predating the attribute ignores
 * it entirely, and a future resolver might authenticate by something other
 * than the cookie. Two independent mechanisms, neither of which depends on
 * the other being right.
 *
 * ## A MISSING Origin is refused, not allowed
 *
 * This is the decision that matters, and the owner made it explicitly.
 * Every browser sends `Origin` on a cross-origin request and on any POST,
 * so "no Origin" means a non-browser client — curl, a script, a server. Our
 * only state-changing callers are browsers, so refusing is correct and
 * fails CLOSED. The cost is that a `curl -X POST` against `/trpc` now 403s
 * unless it sets the header, which is exactly the trade worth making.
 *
 * ## Webhooks are exempt, and that is not a hole
 *
 * A payment gateway is not a browser: it sends no `Origin`, so a check that
 * applied to `/api/webhooks/*` would reject every real webhook and leave
 * bookings unpaid. They are not unprotected — they are protected by
 * something stronger than an origin header, namely **HMAC signature
 * verification** over the raw body (`verifyWebhook`, the
 * `PaymentProvider` seam), plus idempotency on
 * `(provider, provider_event_id)`. An attacker who forges a webhook without
 * the signing secret is refused there; one who has the secret would not be
 * stopped by an `Origin` header either.
 */
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { env } from '../env';

/** Methods that change nothing, so nothing to protect. */
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Paths exempt from the check. Only the gateway webhooks, and only because
 * they are signature-verified — see the module note.
 */
const EXEMPT_PREFIXES = ['/api/webhooks'];

/**
 * The origins allowed to make a state-changing request.
 *
 * `APP_ORIGIN` is the deployed site (`https://travelsugbo.com`). The Vite
 * dev server on 5180 is added only outside production, so a misconfigured
 * production box cannot accidentally accept requests forged from a
 * developer's machine.
 */
export function allowedOrigins(): string[] {
  const origins = [env.APP_ORIGIN];
  if (env.SITE_ENV !== 'production') origins.push('http://localhost:5180');
  return origins.filter((origin, index, all) => all.indexOf(origin) === index);
}

/** Whether this request is one the check applies to. */
export function isStateChanging(method: string, path: string): boolean {
  if (SAFE_METHODS.has(method.toUpperCase())) return false;
  return !EXEMPT_PREFIXES.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
}

/**
 * Refuses a state-changing request whose `Origin` is missing or not ours.
 *
 * 403 rather than 401: this is not "who are you", it is "this request did
 * not come from our site", and no credential would change the answer.
 */
export function createOriginCheck(): RequestHandler {
  const allowed = new Set(allowedOrigins());

  return (req: Request, res: Response, next: NextFunction) => {
    if (!isStateChanging(req.method, req.path)) {
      next();
      return;
    }

    const origin = req.get('origin');
    if (!origin || !allowed.has(origin)) {
      res.status(403).json({ error: 'Forbidden' });
      return;
    }

    next();
  };
}
