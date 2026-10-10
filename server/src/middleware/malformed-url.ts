/**
 * Task 4.3b — a malformed percent-escape in the request path is a client
 * mistake, so it gets a 400 and nothing else.
 *
 * `%zz` is not a valid percent-escape. Anything downstream that
 * percent-decodes the path throws `URIError: URI malformed`, and the three
 * consumers this codebase has all handled that differently and all handled
 * it badly (measured, before this guard, against `createApp`):
 *
 *  - **tRPC** (`/trpc/%zz`): `resolveResponse` calls
 *    `decodeURIComponent(opts.path)` and the throw became an
 *    `INTERNAL_SERVER_ERROR` — a **500** whose body carried `"stack":
 *    "URIError: URI malformed\n at ... C:/dev/rg-travel-tours/node_modules/
 *    @trpc/server/..."`. An absolute filesystem path handed to an anonymous
 *    caller.
 *  - **Express's own router / express.static** (`/tours/%zz`, `/%zz`,
 *    `/privacy%`, `/assets/%zz`): the right status, 400, but finalhandler's
 *    development error page, which renders `URIError: Failed to decode param
 *    '%zz'` followed by the full stack.
 *  - **No route at all** (the API-only app the dev server runs): a plain 404,
 *    which is the wrong answer to a request that cannot be parsed.
 *
 * One decode, once, at the top of the stack, replaces all three with the same
 * short answer.
 *
 * ## Only what genuinely cannot be decoded
 *
 * This is NOT a ban on `%`. `decodeURIComponent` is the arbiter: a valid
 * escape decodes and passes through untouched, so `/trpc/%68ealth`,
 * `/assets/app%2Ecss`, `/tours/%20x` and an encoded non-ASCII slug
 * (`/tours/caf%C3%A9`) all behave exactly as they did before. Only an input
 * that no consumer downstream could have decoded either is rejected.
 *
 * The **query string is deliberately not checked.** It was probed too:
 * `qs` (Express's query parser) has a tolerant decoder that returns the raw
 * value rather than throwing, and tRPC's `?input=%zz` / `?batch=1&input=%zz`
 * both answer 200 today. Nothing throws there, so there is nothing to guard,
 * and widening the check to `req.url` would start 400-ing requests that work.
 *
 * ## Why it is mounted above the rate limiters
 *
 * A request this malformed is answered before the `/trpc` backstop limiter,
 * the procedure-scoped limiter, tRPC, the `X-Robots-Tag` settings read and
 * the SEO resolver ever see it — so it reaches no database and no procedure.
 * That makes it the cheapest response the server can produce (cheaper than
 * the 429 it would otherwise eventually get), which is why not counting it
 * against a limit costs nothing.
 *
 * `middleware/rate-limit.ts`'s own `decodeURIComponent` try/catch — which
 * fails CLOSED, counting an undecodable procedure segment against the limit —
 * is untouched and still correct: it guards every decodable path it is
 * actually reached by, and remains the backstop if this guard is ever
 * remounted lower.
 *
 * Nothing is logged. The path is attacker-controlled and the only interesting
 * fact about it ("someone sent a broken URL") is not worth a log line that
 * anonymous traffic can flood.
 */
import type { RequestHandler } from 'express';

/** The whole body. No message, no status text echo, no error detail. */
export const MALFORMED_URL_BODY = { error: 'Bad Request' } as const;

/** True when `pathname` holds a percent-escape nothing can decode. */
export function isMalformedPath(pathname: string): boolean {
  try {
    decodeURIComponent(pathname);
    return false;
  } catch {
    return true; // URIError — a malformed escape, or a lone surrogate pair
  }
}

/** 400s a request whose path cannot be percent-decoded; passes the rest on. */
export function rejectMalformedUrl(): RequestHandler {
  return (req, res, next) => {
    if (isMalformedPath(req.path)) {
      res.status(400).json(MALFORMED_URL_BODY);
      return;
    }
    next();
  };
}
