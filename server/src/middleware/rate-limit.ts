import { rateLimit } from 'express-rate-limit';
import type { RequestHandler } from 'express';

/**
 * Wraps `express-rate-limit` so it only counts/limits requests that target
 * one of `procedures` — every other tRPC procedure (and any non-tRPC
 * request under the mount path) passes through untouched.
 *
 * ## The path shape — mirrored from tRPC's own derivation, not invented
 *
 * Round 1 of review found that a hand-rolled "strip `/trpc/`" normalization
 * (whatever shape it assumed) kept missing a shape tRPC itself actually
 * produces, which fails the limiter *open* — the exact opposite of safe.
 * So this doesn't normalize independently; it reproduces, line for line,
 * what `@trpc/server`'s Express adapter and `resolveResponse` do before a
 * procedure resolves:
 *
 * 1. `adapters/express.mjs`: `path = req.path.slice(req.path.lastIndexOf('/') + 1)`
 *    — only the segment after the LAST `/` survives. `/trpc/x/inquiries.create`
 *    resolves the same as `/x/inquiries.create` would: tRPC takes
 *    `inquiries.create`, ignoring everything before the last slash. (This
 *    also means the `/trpc` mount prefix is irrelevant either way — tRPC
 *    never looks at anything before the last `/`, so whether Express has
 *    already stripped the mount prefix from `req.path` or not makes no
 *    difference here, which sidesteps the mount-prefix question round 1 got
 *    wrong a different way.)
 * 2. `resolveResponse-*.mjs`: `path: decodeURIComponent(opts.path)` — that
 *    segment is then percent-decoded. `/trpc/inquiries%2Ecreate` and
 *    `/trpc/%69nquiries.create` both decode to `inquiries.create`.
 *
 * `client/src/lib/trpc.ts`'s `httpBatchLink` joins batched procedure names
 * with a comma in that same last segment (confirmed against a real batched
 * call — see task-1.7-report.md), so the decoded segment is split on `,`
 * same as before.
 *
 * A malformed percent-escape (`%zz`) makes `decodeURIComponent` throw a
 * `URIError`. tRPC's own resolveResponse would surface that as a 400 to the
 * caller; an unguarded throw in `skip` would instead crash this middleware
 * into an unhandled 500. Caught and treated as "not skip" (i.e. counted
 * against the limit) — a request too malformed to parse should fail
 * closed, not bypass the limiter.
 *
 * ## Backstop
 *
 * Enumerating every shape tRPC's path resolution can take already missed
 * one real case in round 1. Rather than trust this list is now exhaustive,
 * `createApp` also mounts a generous, unscoped limiter on all of `/trpc`
 * (see app.ts) — so the failure mode for any shape nobody thought of is
 * "limited generously," not "unlimited."
 */
export function createProcedureRateLimit(
  procedures: string[],
  opts: { windowMs: number; max: number },
): RequestHandler {
  return rateLimit({
    windowMs: opts.windowMs,
    limit: opts.max,
    standardHeaders: true,
    legacyHeaders: false,
    skip: (req) => {
      const lastSegment = req.path.slice(req.path.lastIndexOf('/') + 1);
      let decoded: string;
      try {
        decoded = decodeURIComponent(lastSegment);
      } catch {
        return false; // malformed escape: fail CLOSED, count it against the limit
      }
      return !decoded.split(',').some((p) => procedures.includes(p));
    },
  });
}
