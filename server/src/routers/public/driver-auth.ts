/**
 * `driver.login` / `driver.logout` — the driver portal's door (Week 6 plan,
 * Task 1; BUILD_SPEC §8).
 *
 * **The procedure name is `driver.login`, exactly, and it is a contract.**
 * `DRIVER_LOGIN_PROCEDURES` in `middleware/rate-limit.ts` has reserved that
 * string since Week 4, and `driver-lockout.test.ts` fails the build if any
 * public driver-login procedure it can find is not in that list. The reason
 * is worth restating: a procedure-scoped rate limiter aimed at a name that
 * does not exist **fails OPEN while looking mounted**, which is the worst
 * shape a security control can take. So the name is not a style choice.
 *
 * Under `routers/public/` and in a `driver` namespace rather than under
 * `admin.*`, for the same reason `staffAuth` is: a login cannot require a
 * session, and `procedure-role-metadata.test.ts` holds everything in an
 * admin namespace to `adminProcedure`.
 *
 * ## Thin on purpose
 *
 * `attemptDriverLogin` (services/driver-auth.ts) owns the lock, the hash,
 * §8's lockout policy and the session; `setSessionCookie` owns the cookie
 * flags; the per-IP limit is mounted in `app.ts`; the origin check is
 * middleware. What is left here is translating a refusal into a
 * `TRPCError` — which is all a resolver should be.
 */
import { TRPCError } from '@trpc/server';
import { type DriverLoginRefusal, driverLoginSchema } from '@rg/shared';
import {
  SESSION_COOKIE,
  clearSessionCookie,
  setSessionCookie,
} from '../../middleware/session-cookie';
import { attemptDriverLogin } from '../../services/driver-auth';
import { revokeSession } from '../../services/sessions';
import { publicProcedure, router } from '../../trpc';

/**
 * Every refusal becomes a `TRPCError` whose `message` IS the reason string,
 * verbatim — the same convention `admin.dispatch.assign`'s `asTrpcError`
 * established in Week 5, so Task 9's login screen can match the reason and
 * pick its copy from `Record<DriverLoginRefusal, string>` rather than
 * parsing prose.
 *
 * The codes differ because the driver's next action differs, and only the
 * first of these three is a guess:
 *
 *  - `UNAUTHORIZED` — the pair did not match. Nothing distinguishes a wrong
 *    code from a wrong PIN here, because the service does not distinguish
 *    them either.
 *  - `FORBIDDEN` — the credential may well be right, and the account is
 *    closed to them anyway: the lockout is running. (A deactivated driver is
 *    NOT here: they are answered as `wrong_credentials`, owner decision D3.)
 *
 * Deliberately NOT `TOO_MANY_REQUESTS` for `locked`: 429 is what the per-IP
 * limiter answers, and `client/src/lib/mutation-errors.ts` reads that status
 * as "the network told you to slow down". A per-driver lockout is a
 * different fact with a different remedy.
 *
 * ## What a refused login does NOT carry, before and after 2026-10-23
 *
 * `needs_admin_unlock` was the third case here until the lockout stopped
 * being terminal (owner decision 2026-10-23, Q1); it shared this `FORBIDDEN`
 * branch and is simply gone, leaving `locked` on its own.
 *
 * What did NOT change, and must not: a refusal's body is the bare reason
 * string and nothing else. The backoff schedule gave the server three new
 * facts about a locked driver — which tier they are on, how many lockouts they
 * have banked today, and the exact instant `locked_until` falls — and **none
 * of the three is in the response.** Each would tell an attacker probing a
 * code how much pressure they have already applied, and a driver can act on
 * none of them beyond "try again later", which the screen says already.
 */
function asTrpcError(reason: DriverLoginRefusal): TRPCError {
  switch (reason) {
    case 'wrong_credentials':
      return new TRPCError({ code: 'UNAUTHORIZED', message: reason });
    case 'locked':
      return new TRPCError({ code: 'FORBIDDEN', message: reason });
    default: {
      // Exhaustiveness: a third refusal with no case here fails
      // `pnpm typecheck` instead of surfacing as an unexplained 500.
      const unreachable: never = reason;
      throw new Error(`Unhandled DriverLoginRefusal: ${String(unreachable)}`);
    }
  }
}

export const driverAuthRouter = router({
  /**
   * Code + PIN in, a 12-hour session cookie out (§8).
   *
   * `now` is taken HERE, at the request boundary, and passed down — the
   * same exception `context.ts` documents. The client sends no time, so a
   * caller cannot ask for a lockout to be evaluated against yesterday.
   */
  login: publicProcedure.input(driverLoginSchema).mutation(async ({ input, ctx }) => {
    const result = await attemptDriverLogin({
      code: input.code,
      pin: input.pin,
      now: new Date(),
    });

    if (!result.ok) throw asTrpcError(result.reason);

    setSessionCookie(ctx.res, result.token, result.expiresAt);

    // The token is in the httpOnly cookie and nowhere else: it is never in
    // this payload, so no script on the page can read it back.
    return { driver: result.driver };
  }),

  /**
   * Revokes the session row AND clears the cookie — both, always. Clearing
   * only the cookie leaves a live session any copy of the token still
   * opens; revoking only the row leaves a browser sending a dead token.
   *
   * `publicProcedure` rather than `driverProcedure`, exactly as
   * `staffAuth.logout` is public: logging out with an expired or
   * already-revoked session must succeed quietly, or a driver whose
   * 12 hours lapsed mid-trip can never clear the cookie.
   */
  logout: publicProcedure.mutation(async ({ ctx }) => {
    const cookies = ctx.req.cookies as Record<string, string | undefined> | undefined;
    const token = cookies?.[SESSION_COOKIE];
    if (token) await revokeSession(token);
    clearSessionCookie(ctx.res);
    return { ok: true as const };
  }),
});
