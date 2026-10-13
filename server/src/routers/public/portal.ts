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
import { and, desc, eq, isNotNull } from 'drizzle-orm';
import { z } from 'zod';
import {
  RECEIPT_UPLOAD_MAX_PER_BOOKING,
  bookingLookupInput,
  depositCentavos,
  isDriverVisible,
  manilaCivilDate,
  portalTracker,
} from '@rg/shared';
import { readSettingBlock } from '../../content/settings';
import { getDb } from '../../db/client';
import { bookings, drivers, payments, tours, vans } from '../../db/schema';
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

  /**
   * The whole booking page (§7, Week 4 Task 9): the five-step tracker, the
   * balance, the rejection reason if there is one, and the assigned driver
   * while they may still be shown.
   *
   * **`customerProcedure`, no input** — the same structural rule
   * `manualPayment` above follows: the session names the booking, so there
   * is no reference to pass and no way to ask for another guest's.
   *
   * ## Every number comes from here
   *
   * `balanceCentavos` and `amountDueCentavos` are computed on the server
   * from the booking's own price snapshot. The page formats and never
   * calculates — CLAUDE.md's first DO NOT, and the client-side arithmetic
   * guard would fail the build if it tried.
   *
   * ## The tracker is §7's table, not this resolver's opinion
   *
   * `portalTracker()` in `@rg/shared` implements the table verbatim and is
   * exhaustively tested there over all eight statuses. It is called HERE
   * rather than in the browser so that the server and the page can never
   * disagree about which steps are lit.
   *
   * ## The driver's number is withheld rather than hidden
   *
   * `isDriverVisible()` decides, and when it says no the details are not in
   * the response at all — not merely unrendered. A driver's mobile is
   * personal data (RA 10173) and "the component does not show it" is not
   * the same as "the guest cannot read it in the network tab".
   */
  booking: customerProcedure.query(async ({ ctx }) => {
    const [row] = await getDb()
      .select({
        ref: bookings.ref,
        status: bookings.status,
        payMode: bookings.payMode,
        tourTitle: tours.title,
        tourDate: bookings.tourDate,
        pax: bookings.pax,
        leadName: bookings.leadName,
        totalCentavos: bookings.totalCentavos,
        // Aliased — see the note in `manualPayment` on the payment guard.
        paidCentavos: bookings.amountPaidCentavos,
        priceSnapshot: bookings.priceSnapshot,
        holdExpiresAt: bookings.holdExpiresAt,
        driverId: bookings.driverId,
        vanId: bookings.vanId,
      })
      .from(bookings)
      .innerJoin(tours, eq(tours.id, bookings.tourId))
      .where(eq(bookings.id, ctx.session.subjectId))
      .limit(1);

    if (!row) {
      throw new TRPCError({ code: 'NOT_FOUND', message: 'We could not find that booking.' });
    }

    /*
     * Every receipt this booking has, newest first. The newest is the one
     * the guest is waiting on; a `rejected` one carries the reason §7 says
     * to show them.
     */
    const receipts = await getDb()
      .select({
        id: payments.id,
        status: payments.status,
        rejectReason: payments.rejectReason,
        createdAt: payments.createdAt,
      })
      .from(payments)
      .where(
        and(
          eq(payments.bookingId, ctx.session.subjectId),
          eq(payments.provider, 'manual'),
          eq(payments.type, 'payment'),
          isNotNull(payments.receiptPath),
        ),
      )
      .orderBy(desc(payments.id));

    const latest = receipts[0];
    const expected =
      row.payMode === 'full'
        ? row.totalCentavos
        : depositCentavos(row.totalCentavos, row.priceSnapshot.depositPercent);
    const tourDate = manilaCivilDate(row.tourDate);
    const now = new Date();

    /*
     * The driver and the van, read only when they may be shown. Two
     * queries rather than a join on the main read, because the usual answer
     * is "no driver yet" and a join would pay for the lookup on every call.
     */
    let driver: {
      name: string;
      phone: string;
      vanModel: string | null;
      vanPlate: string | null;
    } | null = null;
    if (row.driverId !== null && isDriverVisible(row.status, tourDate, now)) {
      const [assigned] = await getDb()
        .select({ name: drivers.name, phone: drivers.phone })
        .from(drivers)
        .where(eq(drivers.id, row.driverId))
        .limit(1);
      if (assigned) {
        const [van] = row.vanId
          ? await getDb()
              .select({ model: vans.model, plate: vans.plate })
              .from(vans)
              .where(eq(vans.id, row.vanId))
              .limit(1)
          : [undefined];
        driver = {
          name: assigned.name,
          phone: assigned.phone,
          vanModel: van?.model ?? null,
          vanPlate: van?.plate ?? null,
        };
      }
    }

    return {
      ref: row.ref,
      status: row.status,
      leadName: row.leadName,
      tourTitle: row.tourTitle,
      tourDate,
      pax: row.pax,
      totalCentavos: row.totalCentavos,
      paidCentavos: row.paidCentavos,
      /** What is still owed on the whole booking — the "balance due on tour day" of §7. */
      balanceCentavos: Math.max(row.totalCentavos - row.paidCentavos, 0),
      /** What to pay NOW: the deposit (or the full total), less anything paid. */
      amountDueCentavos: Math.max(expected - row.paidCentavos, 0),
      holdExpiresAt: row.holdExpiresAt,
      tracker: portalTracker({
        status: row.status,
        paidCentavos: row.paidCentavos,
        hasReceipt: receipts.length > 0,
      }),
      receipt: latest
        ? {
            status: latest.status,
            /** Only ever set on a rejection, and §7 says to show it. */
            rejectReason: latest.status === 'rejected' ? latest.rejectReason : null,
            submittedAt: latest.createdAt,
          }
        : null,
      uploadsRemaining: Math.max(RECEIPT_UPLOAD_MAX_PER_BOOKING - receipts.length, 0),
      driver,
      /** §7: the review form appears after `completed`. Task 10 owns the form. */
      canReview: row.status === 'completed',
    };
  }),
});
