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
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import {
  RECEIPT_UPLOAD_MAX_PER_BOOKING,
  bookingLookupInput,
  depositCentavos,
  manilaCivilDate,
} from '@rg/shared';
import { readSettingBlock } from '../../content/settings';
import { getDb } from '../../db/client';
import { bookings, payments, tours } from '../../db/schema';
import { clearSessionCookie, setSessionCookie } from '../../middleware/session-cookie';
import { findBookingByCredentials } from '../../services/portal-auth';
import { createSession, revokeSession } from '../../services/sessions';
import { customerProcedure, publicProcedure, router } from '../../trpc';

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

  /**
   * Everything the manual QR screen shows (§6 step 1, Week 4 Task 8).
   *
   * **`customerProcedure`, and it takes NO input.** The booking comes from
   * the session, whose `subject_id` is the booking id — so there is no
   * reference to pass, nothing to tamper with, and a booking reference on
   * its own reveals nothing (owner decision 2026-10-14, Q5). A signed-in
   * guest can reach exactly one booking: their own.
   *
   * ## The amount is computed here, from the booking
   *
   * `amountDueCentavos` is the deposit (or the full total for a `full`
   * booking) less anything already paid — the same arithmetic
   * `recordManualReceipt()` records, from the same price snapshot. The
   * browser is told a number and never asked for one (CLAUDE.md: the server
   * computes all money), which is also why the QR image carries no amount:
   * a static QR cannot embed one, so §6 shows it as text beside it.
   *
   * ## `qr` is null until R&G configure it
   *
   * Owner decision 2026-10-14 (Q3): the account name, number and image are
   * seeded EMPTY and nothing invents them. While `isConfigured` is false
   * this returns `qr: null`, the page shows an amber "payment details
   * pending" state, and the checkout does not offer the option at all —
   * three places agreeing, from one flag.
   */
  manualPayment: customerProcedure.query(async ({ ctx }) => {
    const [booking] = await getDb()
      .select({
        ref: bookings.ref,
        status: bookings.status,
        payMode: bookings.payMode,
        tourTitle: tours.title,
        tourDate: bookings.tourDate,
        pax: bookings.pax,
        totalCentavos: bookings.totalCentavos,
        // Aliased, never `amountPaidCentavos:` — the payment guard in
        // `schema-conventions.test.ts` reads that spelling as a WRITE of the
        // money column, deliberately, and renaming a read is the
        // accommodation it asks for.
        paidCentavos: bookings.amountPaidCentavos,
        priceSnapshot: bookings.priceSnapshot,
        holdExpiresAt: bookings.holdExpiresAt,
      })
      .from(bookings)
      .innerJoin(tours, eq(tours.id, bookings.tourId))
      .where(eq(bookings.id, ctx.session.subjectId))
      .limit(1);

    /*
     * A live session whose booking has vanished. Not reachable today —
     * bookings are never hard-deleted — and it fails closed rather than
     * handing the page an empty object to render payment details from.
     */
    if (!booking) {
      throw new TRPCError({ code: 'NOT_FOUND', message: 'We could not find that booking.' });
    }

    const expected =
      booking.payMode === 'full'
        ? booking.totalCentavos
        : depositCentavos(booking.totalCentavos, booking.priceSnapshot.depositPercent);
    const amountDueCentavos = Math.max(expected - booking.paidCentavos, 0);

    const qrBlock = await readSettingBlock('payment_qr');
    const receipts = await getDb()
      .select({ id: payments.id })
      .from(payments)
      .where(eq(payments.bookingId, ctx.session.subjectId));

    return {
      ref: booking.ref,
      status: booking.status,
      tourTitle: booking.tourTitle,
      /** A civil date, as every tour date is — never a UTC timestamp. */
      tourDate: manilaCivilDate(booking.tourDate),
      pax: booking.pax,
      totalCentavos: booking.totalCentavos,
      paidCentavos: booking.paidCentavos,
      amountDueCentavos,
      holdExpiresAt: booking.holdExpiresAt,
      /**
       * How many more receipts this booking may carry (owner decision Q6).
       * Published so the screen can say so BEFORE a guest picks a file,
       * rather than refusing the upload after they have waited for it.
       */
      uploadsRemaining: Math.max(RECEIPT_UPLOAD_MAX_PER_BOOKING - receipts.length, 0),
      qr: qrBlock.isConfigured
        ? {
            imagePath: qrBlock.imagePath,
            accountName: qrBlock.accountName,
            accountNumber: qrBlock.accountNumber,
            instructions: qrBlock.instructions,
          }
        : null,
    };
  }),
});
