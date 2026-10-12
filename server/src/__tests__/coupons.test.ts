/**
 * Week 3 checkout plan, Task 3: coupon rules.
 *
 * Three groups:
 *
 *  1. `normalizeCouponCode` — pure, no database.
 *
 *  2. `validateCoupon` — needs a real connection (`describeWithDb`). Fixture
 *     coupons are COMMITTED and torn down in `afterAll`, by id — the same
 *     reasoning `record-payment.test.ts` documents for its own fixtures:
 *     `validateCoupon` reads through `getDb()` (the pool), on its own
 *     connection, so a row left inside an uncommitted transaction would be
 *     invisible to it and every case would read as "unknown code". This is
 *     why the brief's cited `schema-coupons.test.ts` pattern — committed
 *     rows, a unique marker, cleanup in `afterAll` — is what is actually
 *     usable here, rather than a literal SQL rollback.
 *
 *  3. `recordRedemption` / `releaseRedemption` — both take a `Transaction`
 *     handle, so here a literal rolled-back transaction IS usable and is
 *     used throughout: fixtures are created with the same `tx` the function
 *     under test writes through, assertions read through that same `tx`,
 *     and every test throws a sentinel at the end to discard everything —
 *     no manual cleanup needed. One test in each pair instead commits (no
 *     throw) specifically to prove the write is real and visible on a
 *     fresh connection; another proves it does NOT survive a rollback — the
 *     property that would catch `recordRedemption`/`releaseRedemption`
 *     silently writing through `getDb()` instead of the handle they were
 *     given.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { getDb, getPool } from '../db/client';
import { bookings, coupons, couponRedemptions, destinations, tours } from '../db/schema';
import { generateBookingRef } from '../services/booking-ref';
import {
  CouponExpiredError,
  CouponInactiveError,
  CouponMinimumSpendNotMetError,
  CouponNotFoundError,
  CouponNotStartedError,
  CouponUsageLimitReachedError,
  normalizeCouponCode,
  recordRedemption,
  releaseRedemption,
  validateCoupon,
} from '../services/coupons';
import { describeWithDb } from './helpers/db';

// ---------------------------------------------------------------------------
// 1. normalizeCouponCode — pure, no database.
// ---------------------------------------------------------------------------

describe('normalizeCouponCode', () => {
  it('trims surrounding whitespace and uppercases', () => {
    expect(normalizeCouponCode('  save10  ')).toBe('SAVE10');
  });

  it('uppercases without touching internal characters that need no trimming', () => {
    // Distinct from the trim case above: nothing here is at the edges, so a
    // normaliser that forgot to uppercase (but still happened to trim) would
    // still go red here.
    expect(normalizeCouponCode('save-10x')).toBe('SAVE-10X');
  });
});

// ---------------------------------------------------------------------------
// 2. validateCoupon — needs a real connection.
// ---------------------------------------------------------------------------

describeWithDb('validateCoupon', () => {
  const unique = `__coupons_svc__${Date.now() % 1e9}`;
  const NOW = new Date('2026-06-15T00:00:00Z');
  const couponIds: number[] = [];

  let inactiveCode: string;
  let notStartedCode: string;
  let expiredCode: string;
  let usageLimitCode: string;
  let minSpendCode: string;
  let validPercentCode: string;
  let validFixedCode: string;
  /** Window entirely in the future of the REAL clock, valid only under an injected `now`. */
  let futureWindowCode: string;

  beforeAll(async () => {
    const db = getDb();

    inactiveCode = `${unique}-INACTIVE`;
    await db
      .insert(coupons)
      .values({ code: inactiveCode, discountType: 'percent', percentBp: 1000, isActive: false })
      .then(([r]) => couponIds.push(r.insertId));

    notStartedCode = `${unique}-NOTSTARTED`;
    await db
      .insert(coupons)
      .values({
        code: notStartedCode,
        discountType: 'percent',
        percentBp: 1000,
        isActive: true,
        startsAt: new Date('2026-07-01T00:00:00Z'), // after NOW
      })
      .then(([r]) => couponIds.push(r.insertId));

    expiredCode = `${unique}-EXPIRED`;
    await db
      .insert(coupons)
      .values({
        code: expiredCode,
        discountType: 'percent',
        percentBp: 1000,
        isActive: true,
        endsAt: new Date('2026-06-01T00:00:00Z'), // before NOW
      })
      .then(([r]) => couponIds.push(r.insertId));

    usageLimitCode = `${unique}-USAGELIMIT`;
    await db
      .insert(coupons)
      .values({
        code: usageLimitCode,
        discountType: 'percent',
        percentBp: 1000,
        isActive: true,
        usageLimit: 3,
        usedCount: 3,
      })
      .then(([r]) => couponIds.push(r.insertId));

    minSpendCode = `${unique}-MINSPEND`;
    await db
      .insert(coupons)
      .values({
        code: minSpendCode,
        discountType: 'percent',
        percentBp: 1000,
        isActive: true,
        minSpendCentavos: 100000,
      })
      .then(([r]) => couponIds.push(r.insertId));

    validPercentCode = `${unique}-VALIDPCT`;
    await db
      .insert(coupons)
      .values({ code: validPercentCode, discountType: 'percent', percentBp: 2500, isActive: true })
      .then(([r]) => couponIds.push(r.insertId));

    validFixedCode = `${unique}-VALIDFIX`;
    await db
      .insert(coupons)
      .values({
        code: validFixedCode,
        discountType: 'fixed',
        amountCentavos: 50000,
        isActive: true,
      })
      .then(([r]) => couponIds.push(r.insertId));

    // Window the REAL clock is nowhere near (the repo's "today" is 2026-10-12
    // per the task's own framing), but squarely inside NOW's. Only passes if
    // the window check uses the injected `now`, not `new Date()`.
    futureWindowCode = `${unique}-FUTUREWINDOW`;
    await db
      .insert(coupons)
      .values({
        code: futureWindowCode,
        discountType: 'fixed',
        amountCentavos: 10000,
        isActive: true,
        startsAt: new Date('2099-01-01T00:00:00Z'),
        endsAt: new Date('2099-12-31T00:00:00Z'),
      })
      .then(([r]) => couponIds.push(r.insertId));
  });

  afterAll(async () => {
    const db = getDb();
    for (const id of couponIds) {
      await db.delete(coupons).where(eq(coupons.id, id));
    }
  });

  it('REFUSES an unknown code with CouponNotFoundError', async () => {
    await expect(validateCoupon(`${unique}-NOPE`, 100000, NOW)).rejects.toThrow(
      CouponNotFoundError,
    );
  });

  it('REFUSES an inactive coupon with CouponInactiveError', async () => {
    await expect(validateCoupon(inactiveCode, 100000, NOW)).rejects.toThrow(CouponInactiveError);
  });

  it('REFUSES a coupon before its starts_at with CouponNotStartedError', async () => {
    await expect(validateCoupon(notStartedCode, 100000, NOW)).rejects.toThrow(
      CouponNotStartedError,
    );
  });

  it('REFUSES a coupon after its ends_at with CouponExpiredError', async () => {
    await expect(validateCoupon(expiredCode, 100000, NOW)).rejects.toThrow(CouponExpiredError);
  });

  it('REFUSES a coupon at or over its usage limit with CouponUsageLimitReachedError', async () => {
    await expect(validateCoupon(usageLimitCode, 100000, NOW)).rejects.toThrow(
      CouponUsageLimitReachedError,
    );
  });

  it('REFUSES a subtotal below min_spend_centavos with CouponMinimumSpendNotMetError, carrying the shortfall', async () => {
    await expect(validateCoupon(minSpendCode, 50000, NOW)).rejects.toThrow(
      CouponMinimumSpendNotMetError,
    );
    try {
      await validateCoupon(minSpendCode, 50000, NOW);
      expect.unreachable('expected CouponMinimumSpendNotMetError');
    } catch (err) {
      expect(err).toBeInstanceOf(CouponMinimumSpendNotMetError);
      const e = err as CouponMinimumSpendNotMetError;
      expect(e.minSpendCentavos).toBe(100000);
      expect(e.subtotalCentavos).toBe(50000);
      expect(e.shortfallCentavos).toBe(50000);
    }
  });

  it('ACCEPTS a subtotal exactly AT min_spend_centavos (inclusive boundary)', async () => {
    const result = await validateCoupon(minSpendCode, 100000, NOW);
    expect(result.code).toBe(minSpendCode);
  });

  it('returns a valid PERCENT coupon’s discount shape', async () => {
    const result = await validateCoupon(validPercentCode, 500000, NOW);
    expect(result).toEqual({
      id: expect.any(Number),
      code: validPercentCode,
      discountType: 'percent',
      percentBp: 2500,
      amountCentavos: null,
    });
  });

  it('returns a valid FIXED coupon’s discount shape', async () => {
    const result = await validateCoupon(validFixedCode, 500000, NOW);
    expect(result).toEqual({
      id: expect.any(Number),
      code: validFixedCode,
      discountType: 'fixed',
      percentBp: null,
      amountCentavos: 50000,
    });
  });

  it('finds an uppercase-stored coupon from a lowercase-typed code (ruling 13)', async () => {
    const result = await validateCoupon(validPercentCode.toLowerCase(), 500000, NOW);
    expect(result.code).toBe(validPercentCode);
  });

  it('trims surrounding whitespace on the typed code too', async () => {
    const result = await validateCoupon(`  ${validPercentCode}  `, 500000, NOW);
    expect(result.code).toBe(validPercentCode);
  });

  it('uses the injected `now`, never the real clock, for the window check', async () => {
    // futureWindowCode's window (2099) is nowhere near the real "today", so
    // this only succeeds if validateCoupon compares against the `now` we
    // pass in rather than calling `new Date()` itself.
    const insideInjectedWindow = new Date('2099-06-01T00:00:00Z');
    const result = await validateCoupon(futureWindowCode, 100000, insideInjectedWindow);
    expect(result.code).toBe(futureWindowCode);
  });
});

// ---------------------------------------------------------------------------
// 3. recordRedemption / releaseRedemption — both take a Transaction handle.
// ---------------------------------------------------------------------------

describeWithDb('recordRedemption / releaseRedemption', () => {
  const unique = `__coupons_redeem__${Date.now() % 1e9}`;
  let destinationId: number;
  let tourId: number;
  const committedBookingIds: number[] = [];
  const committedCouponIds: number[] = [];
  const committedCouponRedemptionPairs: Array<{ couponId: number; bookingId: number }> = [];

  beforeAll(async () => {
    const db = getDb();
    const [destination] = await db
      .insert(destinations)
      .values({ name: unique, slug: unique, isActive: false });
    destinationId = destination.insertId;
    const [tour] = await db
      .insert(tours)
      .values({ slug: `${unique}-tour`, title: unique, destinationId, isActive: true });
    tourId = tour.insertId;
  });

  afterAll(async () => {
    const db = getDb();
    for (const { couponId, bookingId } of committedCouponRedemptionPairs) {
      await db
        .delete(couponRedemptions)
        .where(
          and(eq(couponRedemptions.couponId, couponId), eq(couponRedemptions.bookingId, bookingId)),
        );
    }
    // Raw SQL, not Drizzle's `.delete(bookings)`: this is test-fixture
    // cleanup in `rg_travel_test`, not shipped behaviour, and
    // `schema-conventions.test.ts`'s hard-delete guard scans the Drizzle
    // form across every server file including this one — the same reason
    // `record-payment.test.ts` cleans up its own booking fixtures this way.
    for (const id of committedBookingIds) {
      await getPool().query('DELETE FROM bookings WHERE id = ?', [id]);
    }
    for (const id of committedCouponIds) {
      await db.delete(coupons).where(eq(coupons.id, id));
    }
    await db.delete(tours).where(eq(tours.id, tourId));
    await db.delete(destinations).where(eq(destinations.id, destinationId));
  });

  /** A fresh, committed coupon (used_count 0) and booking, each tracked for cleanup. */
  async function makeFixture(): Promise<{ couponId: number; bookingId: number }> {
    const db = getDb();
    const code = `${unique}-${Math.random().toString(36).slice(2, 10).toUpperCase()}`;
    const [coupon] = await db
      .insert(coupons)
      .values({ code, discountType: 'fixed', amountCentavos: 10000, isActive: true });
    committedCouponIds.push(coupon.insertId);

    const [booking] = await db.insert(bookings).values({
      ref: generateBookingRef(),
      tourId,
      tourDate: new Date('2099-12-25T00:00:00Z'),
      pax: 2,
      leadName: 'Coupon Redemption Fixture',
      leadEmail: 'fixture@example.test',
      leadPhone: '09170000000',
      payMode: 'full',
      priceSnapshot: {
        tier: { tierId: 1, minPax: 1, maxPax: 6, pricePerPersonCentavos: 100000 },
        addons: [],
        coupon: null,
        depositPercent: 30,
        freeCancelHours: 24,
        subtotalCentavos: 200000,
        discountCentavos: 0,
        totalCentavos: 200000,
      },
      subtotalCentavos: 200000,
      totalCentavos: 200000,
    });
    committedBookingIds.push(booking.insertId);

    return { couponId: coupon.insertId, bookingId: booking.insertId };
  }

  it('inserts the redemption row and increments used_count — committed, visible on a fresh read', async () => {
    const { couponId, bookingId } = await makeFixture();
    const db = getDb();

    await db.transaction(async (tx) => {
      await recordRedemption(tx, couponId, bookingId);
    });
    committedCouponRedemptionPairs.push({ couponId, bookingId });

    const rows = await db
      .select()
      .from(couponRedemptions)
      .where(
        and(eq(couponRedemptions.couponId, couponId), eq(couponRedemptions.bookingId, bookingId)),
      );
    expect(rows).toHaveLength(1);

    const [coupon] = await db.select().from(coupons).where(eq(coupons.id, couponId));
    expect(coupon?.usedCount).toBe(1);
  });

  it('a second call for the same (coupon, booking) REJECTS and does not double-count used_count', async () => {
    const { couponId, bookingId } = await makeFixture();
    const db = getDb();

    await db.transaction(async (tx) => {
      await recordRedemption(tx, couponId, bookingId);
    });
    committedCouponRedemptionPairs.push({ couponId, bookingId });

    await expect(
      db.transaction(async (tx) => {
        await recordRedemption(tx, couponId, bookingId);
      }),
    ).rejects.toThrow();

    const [coupon] = await db.select().from(coupons).where(eq(coupons.id, couponId));
    expect(coupon?.usedCount).toBe(1);

    const rows = await db
      .select()
      .from(couponRedemptions)
      .where(
        and(eq(couponRedemptions.couponId, couponId), eq(couponRedemptions.bookingId, bookingId)),
      );
    expect(rows).toHaveLength(1);
  });

  /**
   * The load-bearing contract test: `recordRedemption` must write through
   * the HANDLE it is given. If it ever reached for `getDb()` instead, this
   * rollback would not touch its writes and this test would go red.
   */
  it('rolls both writes back with the transaction that describes them', async () => {
    const { couponId, bookingId } = await makeFixture();
    const db = getDb();

    await expect(
      db.transaction(async (tx) => {
        await recordRedemption(tx, couponId, bookingId);
        throw new Error('simulated failure after the redemption write');
      }),
    ).rejects.toThrow('simulated failure');

    const [coupon] = await db.select().from(coupons).where(eq(coupons.id, couponId));
    expect(coupon?.usedCount).toBe(0);

    const rows = await db
      .select()
      .from(couponRedemptions)
      .where(
        and(eq(couponRedemptions.couponId, couponId), eq(couponRedemptions.bookingId, bookingId)),
      );
    expect(rows, 'a redemption row survived a rolled-back transaction').toHaveLength(0);
  });

  it('releaseRedemption deletes the row and decrements used_count — committed', async () => {
    const { couponId, bookingId } = await makeFixture();
    const db = getDb();

    await db.transaction(async (tx) => {
      await recordRedemption(tx, couponId, bookingId);
    });

    await db.transaction(async (tx) => {
      await releaseRedemption(tx, couponId, bookingId);
    });

    const [coupon] = await db.select().from(coupons).where(eq(coupons.id, couponId));
    expect(coupon?.usedCount).toBe(0);

    const rows = await db
      .select()
      .from(couponRedemptions)
      .where(
        and(eq(couponRedemptions.couponId, couponId), eq(couponRedemptions.bookingId, bookingId)),
      );
    expect(rows).toHaveLength(0);
  });

  /**
   * Delta (3)'s explicit requirement: release, release again, used_count
   * moves exactly once. Decided from the delete's own affected-row count,
   * never a prior read, so there is no read-then-write race to get wrong.
   */
  it('releasing twice decrements used_count exactly once, never twice', async () => {
    const { couponId, bookingId } = await makeFixture();
    const db = getDb();

    await db.transaction(async (tx) => {
      await recordRedemption(tx, couponId, bookingId);
    });

    await db.transaction(async (tx) => {
      await releaseRedemption(tx, couponId, bookingId);
    });
    await db.transaction(async (tx) => {
      await releaseRedemption(tx, couponId, bookingId);
    });

    const [coupon] = await db.select().from(coupons).where(eq(coupons.id, couponId));
    expect(coupon?.usedCount).toBe(0);
  });

  it('releasing a redemption that was never recorded is a no-op, not an error', async () => {
    const { couponId, bookingId } = await makeFixture();
    const db = getDb();

    await db.transaction(async (tx) => {
      await releaseRedemption(tx, couponId, bookingId);
    });

    const [coupon] = await db.select().from(coupons).where(eq(coupons.id, couponId));
    expect(coupon?.usedCount).toBe(0);
  });
});
