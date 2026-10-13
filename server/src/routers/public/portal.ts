/**
 * `portal.login`, `portal.logout` — the customer portal's door (§7).
 *
 * A guest signs in with a **booking reference and an email**, not a
 * password, and gets a session scoped to **that one booking**. The whole
 * surface is two mutations; everything a logged-in guest can then read is
 * Task 9's `portal.booking`.
 *
 * ## Both refusals are the same refusal
 *
 * §7: "Same generic error for wrong ref or wrong email (don't reveal
 * which)." `findBookingByCredentials()` cannot tell the caller which half
 * was wrong — it answers an id or `null` — so this resolver has nothing to
 * leak even by accident. One `REFUSED` constant, thrown from one place.
 *
 * ## The session is the booking
 *
 * `subject_id` is the `bookings.id`. There is no field in the session a
 * resolver could reinterpret to reach a different booking, which is what
 * makes "a portal session reaches exactly one booking" (CLAUDE.md, RA
 * 10173) a structural property rather than a rule every future resolver has
 * to remember.
 *
 * ## Rate limiting is SHARED with `checkout.bookingLookup`
 *
 * Both take the same ref + email pair against the same booking, so they are
 * one attack surface and they share one budget of five failed attempts per
 * IP per fifteen minutes (§7). Giving the login its own limiter would have
 * handed an attacker five guesses here *plus* five on the lookup for the
 * same credential pair — ten against a limit the spec sets at five. See
 * `BOOKING_LOOKUP_PROCEDURES` in `middleware/rate-limit.ts`.
 */
import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { bookingLookupInput } from '@rg/shared';
import { clearSessionCookie, setSessionCookie } from '../../middleware/session-cookie';
import { findBookingByCredentials } from '../../services/portal-auth';
import { createSession, revokeSession } from '../../services/sessions';
import { publicProcedure, router } from '../../trpc';

/**
 * The one refusal. Built fresh per call rather than held as a module
 * constant so the stack is the caller's, but the code and the message are
 * fixed — and a test asserts the wrong-ref and wrong-email cases are
 * byte-identical, because that equality IS the §7 guarantee.
 *
 * `UNAUTHORIZED` rather than `NOT_FOUND`: this is a failed sign-in, and
 * `NOT_FOUND` would itself hint that the ref was the half that missed.
 */
const refused = () =>
  new TRPCError({
    code: 'UNAUTHORIZED',
    message: 'That booking reference and email do not match a booking.',
  });

/**
 * Logout takes the token in its input rather than reading the cookie.
 *
 * The cookie is `httpOnly`, so the browser sends it on every request and
 * the client cannot read it — meaning the client cannot pass it either. The
 * resolver therefore reads `ctx.req.cookies` in practice; the optional
 * `token` field exists so a test can drive revocation directly without
 * assembling a cookie jar. Optional, because logging out with no session at
 * all is a no-op rather than an error.
 */
const logoutInput = z.object({ token: z.string().min(1).optional() }).strict();

export const portalRouter = router({
  login: publicProcedure.input(bookingLookupInput).mutation(async ({ input, ctx }) => {
    const booking = await findBookingByCredentials(input.ref, input.email);
    if (!booking) throw refused();

    const { token, expiresAt } = await createSession('customer', booking.id, new Date());
    setSessionCookie(ctx.res, token, expiresAt);

    return { ok: true as const };
  }),

  /**
   * Revokes the session row AND clears the cookie. Both halves, always:
   * clearing only the cookie would leave a live session that any copy of
   * the token still opens, and revoking only the row would leave a browser
   * sending a token that is refused on every request.
   */
  logout: publicProcedure.input(logoutInput).mutation(async ({ input, ctx }) => {
    const cookies = ctx.req.cookies as Record<string, string | undefined> | undefined;
    const token = input.token ?? cookies?.rg_session;
    if (token) await revokeSession(token);
    clearSessionCookie(ctx.res);
    return { ok: true as const };
  }),
});
