import { rateLimit } from 'express-rate-limit';
import type { NextFunction, Request, RequestHandler, Response } from 'express';

/**
 * `@trpc/server`'s own answer for a BATCH whose results do not share one
 * status: `getHTTPStatusCode` collects every result's status into a `Set`
 * and returns 207 the moment that set holds more than one value
 * (`dist/getErrorShape-B0JBUs-i.mjs`). So 207 means "some of these calls
 * failed and some did not" — never "all fine".
 *
 * It is spelled out here because `express-rate-limit`'s default notion of
 * success is `statusCode < 400` (`dist/index.mjs`), under which 207 reads
 * as a success. For a limiter that counts FAILED attempts only, that
 * reading is the bypass described in `requestWasSuccessful` below.
 */
const MIXED_BATCH_STATUS = 207;

/**
 * How many of a request's procedure calls this limiter is scoped to —
 * **counting occurrences, not distinct names**, because a batch may name
 * the same procedure fifty times and that is fifty attempts.
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
 * caller; an unguarded throw here would instead crash this middleware into
 * an unhandled 500. Caught and counted as ONE attempt — a request too
 * malformed to parse should fail closed, not bypass the limiter.
 */
function countMatchedCalls(path: string, procedures: string[]): number {
  const lastSegment = path.slice(path.lastIndexOf('/') + 1);
  let decoded: string;
  try {
    decoded = decodeURIComponent(lastSegment);
  } catch {
    return 1; // malformed escape: fail CLOSED, count it against the limit
  }
  return decoded.split(',').filter((p) => procedures.includes(p)).length;
}

/**
 * Wraps `express-rate-limit` so it only counts/limits requests that target
 * one of `procedures` — every other tRPC procedure (and any non-tRPC
 * request under the mount path) passes through untouched — and so that it
 * counts one attempt **per matched procedure call**, not per HTTP request.
 *
 * ## Why per CALL (final whole-branch review, F1, second half)
 *
 * Every limit this repo is written against is per attempt: §7's "5 failed
 * attempts per IP per 15 minutes", Ruling 5's "5 hold creations per IP per
 * 15 minutes". A tRPC batch is ONE request carrying N calls, so a limiter
 * that counts requests gave an attacker N attempts per unit of budget — 50
 * failed lookups, or 50 `createHold` calls with a fresh email on each, for
 * one hit. The generous unscoped `/trpc` backstop in `app.ts` bounds
 * requests, not calls, so it did not restore either guarantee.
 *
 * The mechanism is deliberately NOT a cleverer store or a hand-rolled
 * counter: the limiter below is simply RUN once per matched call, so every
 * one of the library's own behaviours (the store, the headers, the 429
 * handler, and the `skipSuccessfulRequests` give-back) applies per attempt
 * exactly as it already did per request. Two consequences worth knowing:
 *
 *  * **The loop is self-bounding.** `express-rate-limit` answers 429 (and
 *    does not call `next`) as soon as `totalHits > limit`, so a batch of a
 *    thousand matched calls stops at `limit + 1` invocations. There is no
 *    unbounded work, and no risk of piling up response listeners.
 *  * **An all-successful batch still costs nothing** under
 *    `skipSuccessfulRequests`: N increments on the way in, N give-backs on
 *    `finish`, net zero.
 *
 * No legitimate client traffic batches two matched calls together: each of
 * `inquiries.create`, `newsletter.subscribe` and `checkout.createHold` is
 * its own form submit, and `checkout.bookingLookup` has one caller. So the
 * unit changing from request to call costs a real guest nothing.
 *
 * `validate: { singleCount: false }` turns off the library's development
 * assertion that one request increments one key at most once. That
 * assertion encodes the very behaviour this limiter must NOT have; it is a
 * dev-time lint, not a guarantee, and it would otherwise log an
 * `ERR_ERL_DOUBLE_COUNT` error for every batched call.
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
  opts: { windowMs: number; max: number; skipSuccessfulRequests?: boolean },
): RequestHandler {
  const limiter = rateLimit({
    windowMs: opts.windowMs,
    limit: opts.max,
    standardHeaders: true,
    legacyHeaders: false,
    // Opt-in, defaulting to `false` so every existing caller (driver login,
    // the checkout-hold cap) keeps counting every matched call exactly as
    // before.
    skipSuccessfulRequests: opts.skipSuccessfulRequests ?? false,
    /*
     * **A 207 is NOT a success.** This override is the first half of the
     * final whole-branch review's F1 fix, and it replaces a comment here
     * that asserted the opposite ("a NOT_FOUND/BAD_REQUEST/... TRPCError
     * always maps to 4xx, so 'skip successes' and 'count failures only' are
     * the same instruction to this library"). That is true of a SINGLE
     * call and false of a batch: `getHTTPStatusCode` answers 207 for mixed
     * results (see MIXED_BATCH_STATUS above), the library's default read
     * `statusCode < 400` classed that as a success, and the hit taken for
     * the failed call in the batch was handed straight back. A batched
     * `checkout.bookingLookup,checkout.quote` carrying one wrong ref and
     * one good quote was therefore free, without limit — a ref oracle on
     * the endpoint §7 caps at five failed attempts. MEASURED against the
     * previous code: twelve consecutive 207s, never a 429.
     *
     * The safe reading of "some of these failed" for a limiter whose job is
     * to count failures is: not a success. It can over-count — a batch
     * whose lookup SUCCEEDED and whose sibling call failed is counted —
     * and that is the correct direction to be wrong in for a security
     * control. The common shapes are both exact: an all-successful batch is
     * 200 (given back), an all-failed batch is the shared 4xx (counted).
     */
    requestWasSuccessful: (_req: Request, res: Response) =>
      res.statusCode < 400 && res.statusCode !== MIXED_BATCH_STATUS,
    // Counted once per matched call by the handler below, deliberately —
    // see this factory's note. The library's one-hit-per-request assertion
    // is the behaviour being fixed, so it is turned off rather than worked
    // around.
    validate: { singleCount: false },
  });

  /*
   * Matching lives here rather than in the library's `skip` option because
   * the number of matches is now the number of times the limiter runs. An
   * unmatched request is passed straight through, exactly as `skip: true`
   * did: no counting, no headers.
   *
   * `limiter` only calls `next` when it let the attempt through, so the
   * first call that exceeds the budget answers 429 and this chain stops —
   * which is also what bounds the loop at `limit + 1` iterations.
   */
  return (req, res, next) => {
    let remaining = countMatchedCalls(req.path, procedures);
    if (remaining === 0) {
      next();
      return;
    }
    const countOne: NextFunction = (err?: unknown) => {
      if (err) {
        next(err);
        return;
      }
      if (remaining === 0) {
        next();
        return;
      }
      remaining -= 1;
      limiter(req, res, countOne);
    };
    countOne();
  };
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

/**
 * Week 3 checkout plan, Task 6, Ruling 5 / owner decision Q4: **5 hold
 * creations per IP per 15 minutes** on `checkout.createHold`.
 *
 * Distinct from `MAX_ACTIVE_HOLDS_PER_GUEST` in `services/create-hold.ts`
 * (two active unpaid holds per email/phone, checked under the lock): that
 * cap is per IDENTITY and only catches a guest who gives a consistent email
 * or phone. This one is per IP and catches a script hammering the endpoint
 * with a fresh email/phone on every call — the case the per-guest cap
 * cannot see at all.
 *
 * **Mounted immediately**, unlike `createDriverLoginLimiter()` above: this
 * task ships the route it guards in the same commit, so there is no
 * "guessed procedure name" problem — see `app.ts`.
 */
export const CHECKOUT_HOLD_WINDOW_MS = 15 * 60_000;
export const CHECKOUT_HOLD_MAX = 5;
export const CHECKOUT_HOLD_PROCEDURES = ['checkout.createHold'] as const;

export function createCheckoutHoldLimiter(): RequestHandler {
  return createProcedureRateLimit([...CHECKOUT_HOLD_PROCEDURES], {
    windowMs: CHECKOUT_HOLD_WINDOW_MS,
    max: CHECKOUT_HOLD_MAX,
  });
}

/**
 * Week 3 checkout plan, Task 10, §7: the guest self-service booking lookup
 * (`checkout.bookingLookup`, ref + email) is capped at **5 FAILED attempts
 * per IP per 15 minutes**.
 *
 * **Failures only — `skipSuccessfulRequests: true`, and that is the one way
 * this limiter differs from `createCheckoutHoldLimiter()` above.** §7 caps
 * "failed attempts", not requests: a guest who keeps re-checking their own
 * real booking (a correct ref + email, answered 200) must never be locked
 * out of reading it. Every wrong pairing resolves to `bookingNotFound()` in
 * `routers/public/checkout.ts`, which tRPC maps to a 4xx — that is what gets
 * counted.
 *
 * **It is "attempts", not requests, in both directions** (final
 * whole-branch review, F1): a mixed-status batch (207) counts rather than
 * being given back, and N failed lookups batched into one request count N
 * times. Both are `createProcedureRateLimit`'s doing, not this function's —
 * see its note and `MIXED_BATCH_STATUS`. This procedure is a QUERY, so the
 * shape that bypass arrived in is a GET batch (`httpBatchLink` POSTs only
 * mutations; a POST here answers 405).
 *
 * **Mounted immediately**, like the hold limiter and unlike the driver-login
 * one: this task ships `checkout.bookingLookup` in the same commit, so there
 * is no "guessed procedure name" problem.
 */
export const BOOKING_LOOKUP_WINDOW_MS = 15 * 60_000;
export const BOOKING_LOOKUP_MAX = 5;
/*
 * BOTH procedures that take a booking ref + email (Week 4, Task 2).
 *
 * `portal.login` is the same credential pair against the same booking as
 * `checkout.bookingLookup`, so they are ONE attack surface and share ONE
 * budget. A separate limiter for the login would have given an attacker
 * five guesses here plus five on the lookup for the same pair — ten
 * against the five §7 sets.
 */
export const BOOKING_LOOKUP_PROCEDURES = ['checkout.bookingLookup', 'portal.login'] as const;

export function createBookingLookupLimiter(): RequestHandler {
  return createProcedureRateLimit([...BOOKING_LOOKUP_PROCEDURES], {
    windowMs: BOOKING_LOOKUP_WINDOW_MS,
    max: BOOKING_LOOKUP_MAX,
    skipSuccessfulRequests: true,
  });
}
