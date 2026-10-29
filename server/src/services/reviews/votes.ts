/**
 * "Was this helpful?" — the anonymous identity behind one helpful vote
 * (BUILD_SPEC §4: "one per browser via cookie + IP rate limit"; Week 7 plan,
 * Task 10).
 *
 * ## Why there is a second cookie at all
 *
 * Every cookie this server set before today belonged to a SESSION — a staff
 * login, a driver's twelve hours, a guest's one booking
 * (`middleware/session-cookie.ts`). A helpful vote has no session: the reader
 * is an anonymous visitor who has never signed in and never will, and §4 still
 * asks for one vote per browser. So this mints a long-lived, meaningless
 * identifier — `rg_vid`, a v4 UUID — and that identifier is the "browser" in
 * §4's rule.
 *
 * **It is NOT `SESSION_COOKIE` and must never become it.** A different name, a
 * different lifetime and a different meaning: `rg_session` is a credential and
 * revoking it signs someone out, while this is an opaque tag that authenticates
 * nothing and grants nothing. Reusing the session cookie here would make a
 * logged-out guest's vote and a logged-in guest's identity the same string.
 *
 * ## `voter_hash` is a hash, and the raw IP never reaches the database
 *
 * `review_helpful_votes.voter_hash` is `SHA-256(cookie id + IP)`, exactly as
 * the column's own doc comment says. A raw address is personal data under RA
 * 10173, and this table has no admin screen, no retention rule and no
 * subject-access path behind it — all it is ever asked is "has this browser
 * already voted here?", which a hash answers. The IP is in the hash rather
 * than absent so that clearing the cookie does not immediately buy a second
 * vote from the same place.
 *
 * ## What this does NOT claim to be
 *
 * It is not an identity control. A caller can send any `rg_vid` it likes (the
 * cookie is `httpOnly`, so a page script cannot — but `curl` can), so vote
 * counts are bounded by the per-IP rate limiter in `app.ts`, which is why §4
 * names the two together. The validation below only keeps the column honest:
 * a value that is not a well-formed minted id is replaced rather than hashed,
 * so `voter_hash` is always the hash of an identifier this server recognises.
 *
 * `app.ts` does not set `trust proxy`, so behind a reverse proxy `req.ip` is
 * the proxy's address rather than the visitor's — a pre-existing, documented
 * limitation (`docs/LAUNCH_CHECKLIST.md` carries it as a launch item). The
 * consequence here is that visitors behind one proxy share the IP half of the
 * hash; the cookie half still separates them.
 */
import { createHash, randomUUID } from 'node:crypto';
import type { Request, Response } from 'express';
import { env } from '../../env';

/**
 * The cookie name. Prefixed like `rg_session` so it cannot collide with
 * anything else on the host, and deliberately a different name.
 */
export const VOTER_COOKIE = 'rg_vid';

/**
 * A year. Long, because the thing it identifies is "this browser" and a tag
 * that expired every fortnight would hand the same reader a fresh vote on
 * every review they had already voted on.
 */
export const VOTER_COOKIE_MAX_AGE_MS = 365 * 24 * 60 * 60 * 1000;

/** The shape `randomUUID()` produces, and the only shape accepted back. */
const MINTED_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * `SHA-256(cookieId + ':' + ip)`, hex. The separator is part of the contract
 * — without it `('ab', 'c')` and `('a', 'bc')` would hash identically — and
 * `review-votes.test.ts` computes the same digest independently rather than
 * calling this function, so the shape cannot drift silently.
 */
export function voterHashFrom(cookieId: string, ip: string): string {
  return createHash('sha256').update(`${cookieId}:${ip}`).digest('hex');
}

/**
 * The voter id this request carries, minting and setting one if it does not.
 *
 * The flags mirror `setSessionCookie`'s reasoning, and for the same reasons:
 * `httpOnly` keeps the tag out of `document.cookie`, `sameSite: 'lax'` keeps
 * it off cross-site requests, and `secure` is conditional on `SITE_ENV`
 * because a `secure` cookie is never sent over the plain-HTTP dev server.
 */
function readOrMintVoterId(req: Request, res: Response): string {
  const cookies = req.cookies as Record<string, string | undefined> | undefined;
  const existing = cookies?.[VOTER_COOKIE];
  if (existing !== undefined && MINTED_ID.test(existing)) return existing;

  const minted = randomUUID();
  res.cookie(VOTER_COOKIE, minted, {
    httpOnly: true,
    sameSite: 'lax',
    secure: env.SITE_ENV === 'production',
    maxAge: VOTER_COOKIE_MAX_AGE_MS,
    path: '/',
  });
  /*
   * Written back onto THIS request's own cookie jar, not only onto the
   * response (7N, Task 10). tRPC batches: a browser with no `rg_vid` yet
   * that fires two `reviews.voteHelpful` calls in one batched HTTP request
   * runs both resolvers against the SAME `req`/`res` pair, and `res.cookie`
   * only reaches the BROWSER on the response that has not been sent yet —
   * it never updates `req.cookies` for a second resolver already running
   * inside this request. Without this line the second call's `existing` is
   * still `undefined`, so it mints a SECOND id and hashes a second voter
   * out of one browser's one batch. Writing back here is what makes the
   * second call see the first call's own mint.
   */
  if (cookies) cookies[VOTER_COOKIE] = minted;
  return minted;
}

/**
 * The `voter_hash` for this request — the one value the vote mutation writes.
 *
 * `req.ip` is absent on a context assembled without Express (and would be
 * absent on a socket with no remote address), so it falls back to the empty
 * string: the cookie half still separates browsers, and a missing address must
 * never throw on a public endpoint.
 */
export function voterHashForRequest(req: Request, res: Response): string {
  return voterHashFrom(readOrMintVoterId(req, res), req.ip ?? '');
}
