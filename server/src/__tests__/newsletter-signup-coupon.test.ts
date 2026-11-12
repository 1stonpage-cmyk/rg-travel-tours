/**
 * `newsletter.subscribe` — mints + emails a sign-up coupon (sign-up coupons
 * plan, Task 1B-ii;
 * `docs/superpowers/plans/2026-11-13-signup-coupons.md`).
 *
 * A separate file from `public-mutations.test.ts` rather than an extension
 * of it — same reasoning `inquiry-notify.test.ts`'s own header gives for
 * splitting off from that file: this is specifically about the new mint +
 * email behaviour, so a reviewer can see it all in one place.
 *
 * `signup_coupon` is pinned to a fixed `{discountPercent, expiryDays}` for
 * the life of this suite (restored in `afterAll`) rather than trusted to
 * whatever the seed currently holds — several tests here depend on the
 * exact percent a coupon was minted with, and another settings suite
 * running in the same process must not be able to make this one flaky.
 */
import { afterAll, afterEach, beforeAll, beforeEach, expect, expectTypeOf, it } from 'vitest';
import { eq, like } from 'drizzle-orm';
import { testContext } from './helpers/ctx';
import { describeWithDb } from './helpers/db';
import { appRouter } from '../routers/_app';
import { getDb } from '../db/client';
import { coupons, newsletterSubscribers } from '../db/schema';
import { env } from '../env';
import { writeSettingBlock } from '../content/settings-write';
import { readSettingBlock } from '../content/settings';
import {
  isSignupCouponResendThrottled,
  recordSignupCouponResendSent,
  resetSignupCouponResendThrottleForTests,
  resetTransportForTests,
  setTransportForTests,
  SIGNUP_COUPON_RESEND_WINDOW_MS,
} from '../services/notify';

interface SentMail {
  to: string;
  subject: string;
  html: string;
  text: string;
}

const caller = appRouter.createCaller(testContext());
const MARK = 'vitest+signup-coupon+';

/** Fixed for the whole suite — see the module note. */
const TEST_SETTING = { discountPercent: 5, expiryDays: 60 };

const sent: SentMail[] = [];
let originalSetting: { discountPercent: number; expiryDays: number };

beforeAll(async () => {
  originalSetting = await readSettingBlock('signup_coupon');
  await writeSettingBlock('signup_coupon', TEST_SETTING, { subjectId: 1 }, new Date());
});

afterAll(async () => {
  await writeSettingBlock('signup_coupon', originalSetting, { subjectId: 1 }, new Date());
});

beforeEach(() => {
  sent.length = 0;
  resetSignupCouponResendThrottleForTests();
  setTransportForTests({
    sendMail: async (message) => {
      sent.push(message as unknown as SentMail);
      return { messageId: 'mock' };
    },
  });
});

afterEach(async () => {
  resetTransportForTests();
  resetSignupCouponResendThrottleForTests();
  const db = getDb();
  // Subscribers first — they FK-reference coupons, so deleting coupons first
  // would hit the FK's default RESTRICT.
  await db.delete(newsletterSubscribers).where(like(newsletterSubscribers.email, `${MARK}%`));
  await db.delete(coupons).where(like(coupons.restrictedToEmail, `${MARK}%`));
});

describeWithDb('newsletter.subscribe — sign-up coupon (1B-ii)', () => {
  it('mints exactly one coupon on first-time subscribe, linked and shaped correctly, and emails it', async () => {
    const email = `${MARK}first@example.com`;

    const res = await caller.newsletter.subscribe({ email });
    expect(res.ok).toBe(true);
    expect(res.alreadySubscribed).toBe(false);
    expect(Object.keys(res).sort()).toEqual(['alreadySubscribed', 'ok']);

    const [sub] = await getDb()
      .select()
      .from(newsletterSubscribers)
      .where(eq(newsletterSubscribers.email, email));
    expect(sub?.couponId).not.toBeNull();

    const couponRows = await getDb()
      .select()
      .from(coupons)
      .where(eq(coupons.restrictedToEmail, email));
    expect(couponRows).toHaveLength(1);
    expect(couponRows[0]!.id).toBe(sub!.couponId);
    expect(couponRows[0]!.code.startsWith('WELCOME-')).toBe(true);
    expect(couponRows[0]!.discountType).toBe('percent');
    expect(couponRows[0]!.percentBp).toBe(TEST_SETTING.discountPercent * 100);
    expect(couponRows[0]!.amountCentavos).toBeNull();
    expect(couponRows[0]!.usageLimit).toBe(1);
    expect(couponRows[0]!.usedCount).toBe(0);
    expect(couponRows[0]!.isActive).toBe(true);

    expect(sent).toHaveLength(1);
    expect(sent[0]!.to).toBe(email);
    expect(sent[0]!.text).toContain(couponRows[0]!.code);
  });

  it('a repeat subscribe with the same email (different case) mints no second coupon, and the FIRST subscribe already stores a normalised restrictedToEmail', async () => {
    const email = `${MARK}repeat@example.com`;
    // Subscribe with an UPPERCASE variant first — this is what actually
    // exercises the router's own `.trim().toLowerCase()`: `newsletter_
    // subscribers.email`'s column collation is case-insensitive on its own
    // (same fact `normalizeCouponCode`'s own doc comment names for
    // `coupons.code`), so a count-based assertion alone cannot tell apart
    // "the app normalised it" from "the database did it for free". Reading
    // the stored byte content back by ID and comparing it with a plain JS
    // `===` (never through a `WHERE … = ?` on the column, which would use
    // that same forgiving collation) is what actually tells them apart —
    // and it matters for real: `validateCoupon()`'s email check (1B-i)
    // trusts `restricted_to_email` is ALREADY normalised and does not
    // re-normalise the stored side, so a coupon minted here with the wrong
    // case would refuse its own rightful owner at checkout.
    const first = await caller.newsletter.subscribe({ email: email.toUpperCase() });
    expect(first.alreadySubscribed).toBe(false);

    const [sub] = await getDb()
      .select()
      .from(newsletterSubscribers)
      .where(eq(newsletterSubscribers.email, email));
    const [minted] = await getDb().select().from(coupons).where(eq(coupons.id, sub!.couponId!));
    expect(minted!.restrictedToEmail).toBe(email);

    const res = await caller.newsletter.subscribe({ email: email.toLowerCase() });
    expect(res.alreadySubscribed).toBe(true);

    const couponRows = await getDb()
      .select()
      .from(coupons)
      .where(eq(coupons.restrictedToEmail, email));
    expect(couponRows).toHaveLength(1);

    const subRows = await getDb()
      .select()
      .from(newsletterSubscribers)
      .where(eq(newsletterSubscribers.email, email));
    expect(subRows).toHaveLength(1);
  });

  /**
   * The Ruling-2 race (design note): two near-simultaneous repeat signups
   * for a PRE-EXISTING, coupon-less subscriber (one who predates this
   * feature, or lost an earlier mint race) must still end with exactly one
   * coupon. This is the scenario the `FOR UPDATE` lock in
   * `handleRepeatSignup` exists for — unlike a race on a brand-new address,
   * which the `newsletter_subscribers.email` unique index alone already
   * prevents from double-minting (the loser's INSERT blocks until the
   * winner's whole transaction, coupon mint included, has committed), a
   * race on an EXISTING row with `coupon_id IS NULL` has no unique
   * constraint of its own to fall back on — only the row lock.
   */
  it('two concurrent repeat signups for a pre-existing, coupon-less subscriber still mint exactly one coupon', async () => {
    const email = `${MARK}preexisting-race@example.com`;
    // Simulates a subscriber row that predates this feature: present, but
    // with no coupon linked yet.
    await getDb().insert(newsletterSubscribers).values({ email });

    const [r1, r2] = await Promise.all([
      caller.newsletter.subscribe({ email }),
      caller.newsletter.subscribe({ email }),
    ]);
    expect(r1.alreadySubscribed).toBe(true);
    expect(r2.alreadySubscribed).toBe(true);

    const couponRows = await getDb()
      .select()
      .from(coupons)
      .where(eq(coupons.restrictedToEmail, email));
    expect(couponRows).toHaveLength(1);

    const [sub] = await getDb()
      .select()
      .from(newsletterSubscribers)
      .where(eq(newsletterSubscribers.email, email));
    expect(sub?.couponId).toBe(couponRows[0]!.id);
  });

  it('resend throttle: repeat signups in quick succession resend the mail only once in the window', async () => {
    const email = `${MARK}resend@example.com`;
    await caller.newsletter.subscribe({ email }); // establishes the coupon + first mail
    sent.length = 0; // isolate measurement to the two repeat calls below

    await caller.newsletter.subscribe({ email }); // repeat #1 -> resend (not yet throttled)
    expect(sent).toHaveLength(1);

    await caller.newsletter.subscribe({ email }); // repeat #2, same window -> throttled
    expect(sent).toHaveLength(1);
  });

  it('the resend throttle window actually expires (pure, injected `now` — no router, no real clock)', () => {
    const email = 'throttle-unit-test@example.com';
    const t0 = new Date('2027-01-01T00:00:00.000Z');

    expect(isSignupCouponResendThrottled(email, t0)).toBe(false);
    recordSignupCouponResendSent(email, t0);
    expect(isSignupCouponResendThrottled(email, t0)).toBe(true);

    const stillWithinWindow = new Date(t0.getTime() + SIGNUP_COUPON_RESEND_WINDOW_MS - 1_000);
    expect(isSignupCouponResendThrottled(email, stillWithinWindow)).toBe(true);

    const afterWindow = new Date(t0.getTime() + SIGNUP_COUPON_RESEND_WINDOW_MS + 1_000);
    expect(isSignupCouponResendThrottled(email, afterWindow)).toBe(false);
  });

  it('an already-used existing coupon gets no resend mail', async () => {
    const email = `${MARK}used@example.com`;
    await caller.newsletter.subscribe({ email });
    sent.length = 0;

    await getDb().update(coupons).set({ usedCount: 1 }).where(eq(coupons.restrictedToEmail, email));

    const res = await caller.newsletter.subscribe({ email });
    expect(res.alreadySubscribed).toBe(true);
    expect(sent).toHaveLength(0);
  });

  it('an expired existing coupon gets no resend mail', async () => {
    const email = `${MARK}expired@example.com`;
    await caller.newsletter.subscribe({ email });
    sent.length = 0;

    await getDb()
      .update(coupons)
      .set({ endsAt: new Date(Date.now() - 1_000) })
      .where(eq(coupons.restrictedToEmail, email));

    const res = await caller.newsletter.subscribe({ email });
    expect(res.alreadySubscribed).toBe(true);
    expect(sent).toHaveLength(0);
  });

  it('the resolved value never carries a `code` key, at the type level or at runtime, in either branch', async () => {
    type SubscribeResult = Awaited<ReturnType<typeof caller.newsletter.subscribe>>;
    expectTypeOf<SubscribeResult>().not.toHaveProperty('code');

    const email = `${MARK}no-code@example.com`;
    const first = await caller.newsletter.subscribe({ email });
    expect(Object.keys(first).sort()).toEqual(['alreadySubscribed', 'ok']);
    const second = await caller.newsletter.subscribe({ email });
    expect(Object.keys(second).sort()).toEqual(['alreadySubscribed', 'ok']);
  });

  it('refuses newsletter.subscribe when Turnstile is enabled and the token is missing or garbage, storing nothing', async () => {
    const email = `${MARK}turnstile@example.com`;
    const original = env.TURNSTILE_ENABLED;
    (env as { TURNSTILE_ENABLED?: string }).TURNSTILE_ENABLED = '1';
    try {
      await expect(
        caller.newsletter.subscribe({ email, turnstileToken: 'garbage-token' }),
      ).rejects.toMatchObject({
        code: 'BAD_REQUEST',
        message: 'Please complete the verification and try again.',
      });
    } finally {
      (env as { TURNSTILE_ENABLED?: string }).TURNSTILE_ENABLED = original;
    }
    const rows = await getDb()
      .select()
      .from(newsletterSubscribers)
      .where(eq(newsletterSubscribers.email, email));
    expect(rows, 'a Turnstile refusal must leave no subscriber row').toHaveLength(0);
    expect(sent, 'a Turnstile refusal must send no mail at all').toHaveLength(0);
  });

  it('is unaffected by Turnstile when the feature flag is off (feature-off path, no network call)', async () => {
    const email = `${MARK}turnstile-off@example.com`;
    // env.TURNSTILE_ENABLED left at its current (unset/off) value — the
    // feature-off branch of verifyTurnstile(), no network call.
    const res = await caller.newsletter.subscribe({ email });
    expect(res.ok).toBe(true);
    expect(res.alreadySubscribed).toBe(false);
  });

  it('a later change to signup_coupon does not change an already-minted coupon’s percentBp', async () => {
    const email = `${MARK}percent-snapshot@example.com`;
    await caller.newsletter.subscribe({ email });

    const [before] = await getDb()
      .select()
      .from(coupons)
      .where(eq(coupons.restrictedToEmail, email));
    expect(before?.percentBp).toBe(TEST_SETTING.discountPercent * 100);

    await writeSettingBlock(
      'signup_coupon',
      { discountPercent: 20, expiryDays: 90 },
      { subjectId: 1 },
      new Date(),
    );
    try {
      const [after] = await getDb()
        .select()
        .from(coupons)
        .where(eq(coupons.restrictedToEmail, email));
      expect(after?.percentBp).toBe(TEST_SETTING.discountPercent * 100);
      expect(after?.id).toBe(before?.id);
    } finally {
      await writeSettingBlock('signup_coupon', TEST_SETTING, { subjectId: 1 }, new Date());
    }
  });
});
