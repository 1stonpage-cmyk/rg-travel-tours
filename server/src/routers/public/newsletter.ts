/**
 * Newsletter signup — now also mints and emails a sign-up coupon (sign-up
 * coupons plan, Task 1B-ii; design note
 * `docs/superpowers/plans/2026-11-13-signup-coupons.md`).
 *
 * Three outcomes, and the response never distinguishes between them beyond
 * `alreadySubscribed` (decision 1 — no row contents, no mail-sent status, no
 * `code`, ever):
 *
 *  1. Brand-new address: insert the subscriber, mint a `WELCOME-` coupon in
 *     the SAME transaction, link it, commit, then (after commit) email the
 *     code.
 *  2. A pre-existing subscriber with no coupon yet (predates this feature,
 *     or lost a mint race): same mint, under a `FOR UPDATE` lock on the
 *     subscriber row rather than a fresh insert — this is read as their
 *     FIRST code, not a second one (design note Ruling 2).
 *  3. A pre-existing subscriber who already has a coupon: resend that exact
 *     code, rate-limited per address, and ONLY if it is still active,
 *     unused and unexpired.
 *
 * Case 2 and 3 share one transaction (`handleRepeatSignup`), entered only
 * when the first-time INSERT above hit the `newsletter_subscribers.email`
 * unique-key duplicate — the existing "duplicate is a success" behaviour,
 * unchanged.
 */
import { newsletterInput } from '@rg/shared';
import { TRPCError } from '@trpc/server';
import { eq } from 'drizzle-orm';
import { readSettingBlock } from '../../content/settings';
import type { Database } from '../../db/client';
import { getDb } from '../../db/client';
import { isDuplicateKeyError } from '../../db/duplicate-key';
import { coupons, newsletterSubscribers } from '../../db/schema';
import {
  isSignupCouponResendThrottled,
  recordSignupCouponResendSent,
  sendSignupCouponEmail,
} from '../../services/notify';
import { mintSignupCoupon } from '../../services/signup-coupons';
import { turnstileRefusedError, verifyTurnstile } from '../../services/turnstile';
import { publicProcedure, router } from '../../trpc';

/**
 * Anything that isn't a recognized duplicate-key error is a server fault,
 * not something to describe to the visitor. MySQL's own duplicate-entry
 * message embeds the submitted value verbatim (e.g.
 * `Duplicate entry '<email>' for key '...'`), and tRPC's default error
 * shape puts `error.message` in the response body — so if this ever stops
 * recognizing the wrapping shape, the fallback must not be "rethrow and let
 * the raw MySQL text reach the client" (round 1 review, I3). `cause` is
 * attached for server-side debugging only; tRPC's default error formatter
 * does not include it in the response sent to the caller.
 */
function toInternalError(err: unknown): TRPCError {
  return new TRPCError({
    code: 'INTERNAL_SERVER_ERROR',
    message: 'Could not complete the request.',
    cause: err,
  });
}

type SignupCouponSettings = { discountPercent: number; expiryDays: number };

type RepeatSignupOutcome =
  { kind: 'minted'; code: string } | { kind: 'resend'; code: string } | { kind: 'none' };

/**
 * The repeat-signup transaction (cases 2 and 3 above). Takes the subscriber
 * row `FOR UPDATE` first — closing the otherwise-real race where two
 * near-simultaneous repeat signups for the same pre-existing, coupon-less
 * address could both see `coupon_id IS NULL` and both mint (design note
 * Ruling 2's race).
 *
 * `usedCount >= 1` is treated as "spent" rather than joining
 * `coupon_redemptions`: a sign-up coupon's `usageLimit` is always 1
 * (`mintSignupCoupon`), so the simpler column check is equivalent here and
 * needs no join.
 */
async function handleRepeatSignup(
  db: Database,
  email: string,
  settings: SignupCouponSettings,
  now: Date,
): Promise<RepeatSignupOutcome> {
  return db.transaction(async (tx) => {
    const [subscriber] = await tx
      .select({ id: newsletterSubscribers.id, couponId: newsletterSubscribers.couponId })
      .from(newsletterSubscribers)
      .where(eq(newsletterSubscribers.email, email))
      .for('update');

    if (!subscriber) {
      // The duplicate-key error that routed us here implies a row exists.
      // Its disappearance between that error and this lock is not a case
      // this function can repair, so it fails closed rather than minting a
      // coupon with nothing to link it to.
      throw new TRPCError({
        code: 'INTERNAL_SERVER_ERROR',
        message: 'Could not complete the request.',
      });
    }

    if (subscriber.couponId === null) {
      const coupon = await mintSignupCoupon(tx, email, settings, now);
      await tx
        .update(newsletterSubscribers)
        .set({ couponId: coupon.id })
        .where(eq(newsletterSubscribers.id, subscriber.id));
      return { kind: 'minted', code: coupon.code };
    }

    const [couponRow] = await tx
      .select({
        isActive: coupons.isActive,
        endsAt: coupons.endsAt,
        usedCount: coupons.usedCount,
        code: coupons.code,
      })
      .from(coupons)
      .where(eq(coupons.id, subscriber.couponId));

    if (!couponRow) return { kind: 'none' };

    const unexpired = couponRow.endsAt === null || couponRow.endsAt > now;
    const unused = couponRow.usedCount < 1;
    if (couponRow.isActive && unused && unexpired) {
      return { kind: 'resend', code: couponRow.code };
    }
    return { kind: 'none' };
  });
}

export const newsletterRouter = router({
  /**
   * Newsletter signup. A duplicate address is a *success* from the
   * visitor's point of view — re-submitting the same email must not look
   * like an error, and the response reveals nothing about the existing
   * subscriber beyond the `alreadySubscribed` flag (no row contents, no
   * timestamps, no coupon code — ever). Never log `input.email`: subscriber
   * addresses are personal data under RA 10173.
   */
  subscribe: publicProcedure.input(newsletterInput).mutation(async ({ input, ctx }) => {
    // Turnstile first, before any write — mirrors `inquiries.create`'s own
    // first line exactly.
    if (!(await verifyTurnstile({ token: input.turnstileToken, remoteIp: ctx.req.ip }))) {
      throw turnstileRefusedError();
    }

    const email = input.email.trim().toLowerCase();
    const signupCoupon = await readSettingBlock('signup_coupon');
    const now = new Date();
    const db = getDb();

    // First-time path: insert the subscriber and mint its coupon in ONE
    // transaction, so the row and the coupon commit together or not at all.
    let firstTimeCode: string | null = null;
    try {
      firstTimeCode = await db.transaction(async (tx) => {
        await tx.insert(newsletterSubscribers).values({ email });
        const coupon = await mintSignupCoupon(tx, email, signupCoupon, now);
        await tx
          .update(newsletterSubscribers)
          .set({ couponId: coupon.id })
          .where(eq(newsletterSubscribers.email, email));
        return coupon.code;
      });
    } catch (err) {
      if (!isDuplicateKeyError(err)) throw toInternalError(err);
      // Duplicate address — fall through to the repeat-signup path below.
    }

    if (firstTimeCode !== null) {
      // AFTER commit, never inside the transaction — a mail failure must
      // never roll back the subscriber row or the coupon it already owns
      // (`notify()`'s own module doc explains why). The throttle entry is
      // recorded here too, not only on the resend branch below: a
      // near-simultaneous repeat-signup request for this same address can
      // land in the gap between this transaction's commit (which already
      // linked the coupon) and this very call, see the coupon as already
      // minted and active, and take the `outcome.kind === 'resend'` branch
      // — which, with no throttle entry yet recorded, would send a second
      // mail for what is really this same first code. Recording it now
      // closes that gap: the SAME throttle entry governs both "first mail"
      // and "any later resend".
      recordSignupCouponResendSent(email, now);
      await sendSignupCouponEmail(
        email,
        firstTimeCode,
        signupCoupon.discountPercent,
        signupCoupon.expiryDays,
      );
      return { ok: true as const, alreadySubscribed: false };
    }

    const outcome = await handleRepeatSignup(db, email, signupCoupon, now);
    if (outcome.kind === 'minted') {
      // Their first code, not a resend, but the same race above applies to
      // this mint too — record the throttle entry before sending.
      recordSignupCouponResendSent(email, now);
      await sendSignupCouponEmail(
        email,
        outcome.code,
        signupCoupon.discountPercent,
        signupCoupon.expiryDays,
      );
    } else if (outcome.kind === 'resend') {
      if (!isSignupCouponResendThrottled(email, now)) {
        recordSignupCouponResendSent(email, now);
        await sendSignupCouponEmail(
          email,
          outcome.code,
          signupCoupon.discountPercent,
          signupCoupon.expiryDays,
        );
      }
    }
    // outcome.kind === 'none' (used/expired/inactive, or throttled above):
    // send nothing. Either way the response below says nothing about it.

    return { ok: true as const, alreadySubscribed: true };
  }),
});
