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

/**
 * The per-IP third of the driver PIN lockout policy (BUILD_SPEC §8, owner
 * decision Q9, task 21): **10 attempts per 15 minutes per IP**.
 *
 * The other two limits are per driver and live in
 * `services/driver-lockout.ts`. This one is what makes a six-digit PIN safe
 * at all: 1,000,000 combinations at 10 attempts per 15 minutes is centuries,
 * and it is the only one of the three that costs an attacker anything when
 * they spread their guesses across every driver code in turn.
 *
 * **A factory, not a module-level handler.** `rateLimit()` allocates a
 * counter store on construction, so a module-level singleton would share one
 * counter across every `createApp()` in the test suite — the kind of
 * cross-test coupling that makes a limiter test pass or fail depending on
 * file order. Every other limiter in this codebase is likewise built inside
 * `createApp`.
 *
 * **Not mounted yet, deliberately.** There is no driver login route — that is
 * Week 6 — and `'driver.login'` below is this task's *proposal* for its name,
 * not an observed fact. Mounting a procedure-scoped limiter against a guessed
 * procedure name would fail OPEN the moment the real name differs, while
 * looking mounted. `driver-lockout.test.ts` carries a guard that fails the
 * build if a driver-login procedure is added to the router without this
 * limiter being mounted in `app.ts`, so the choice is "mount it with the
 * route" rather than "hope someone remembers". Until then the generous
 * unscoped `/trpc` backstop in `app.ts` still applies, so the failure mode is
 * limited-generously, never unlimited.
 */
export const DRIVER_LOGIN_IP_WINDOW_MS = 15 * 60_000;
export const DRIVER_LOGIN_IP_MAX = 10;
/** The procedure name this limiter is scoped to. Confirm it in Week 6. */
export const DRIVER_LOGIN_PROCEDURES = ['driver.login'] as const;

export function createDriverLoginLimiter(): RequestHandler {
  return createProcedureRateLimit([...DRIVER_LOGIN_PROCEDURES], {
    windowMs: DRIVER_LOGIN_IP_WINDOW_MS,
    max: DRIVER_LOGIN_IP_MAX,
  });
}
