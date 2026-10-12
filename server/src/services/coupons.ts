/**
 * Coupon rules (Week 3 checkout plan, Task 3).
 *
 * `validateCoupon()` is the EARLY, friendly refusal: a guest typing a code
 * into the checkout form gets back a specific reason — "that code expired",
 * not "that code is invalid" — because §6 requires each rule (active,
 * within dates, under usage limit, minimum spend) to be checked and
 * reported separately. It reads through `getDb()` (the pool), not a
 * transaction, because nothing here writes.
 *
 * The AUTHORITATIVE re-check of the same rules happens later, under a row
 * lock, inside `createHold()` (a later task) — this module's job is only to
 * save a guest a round trip for a mistake the lock would catch anyway.
 *
 * `recordRedemption()` and `releaseRedemption()` are the two writers, and
 * neither opens its own transaction: `createHold()` and the expiry sweep
 * each call them from inside a transaction they already hold (the same
 * discipline as `writeAudit(tx, …)` in `services/audit.ts`), so both take a
 * `Transaction` handle rather than `getDb()`.
 *
 * Owner decision Q7/Q8: an active hold reserves coupon usage, not just
 * capacity, so `recordRedemption` does both writes (the redemption row and
 * the `used_count` bump) and `releaseRedemption` undoes both.
 */
import { and, eq, sql } from 'drizzle-orm';
import type { CouponDiscount } from '@rg/shared';
import { getDb } from '../db/client';
import type { Transaction } from '../db/client';
import { coupons, couponRedemptions } from '../db/schema';

/**
 * The one normaliser for a coupon code: trim, then uppercase.
 *
 * `coupons.code` is `utf8mb4_unicode_ci` in the live test database, so a
 * plain `WHERE code = ?` already matches a stored `SAVE10` against a typed
 * `save10` — but that is a collation fact, not a contract, and a future
 * migration to a case-sensitive collation would break lookup silently if
 * nothing here normalised explicitly. Comparison stays a plain `=` (never
 * `UPPER(code)` in SQL, which would make the column's own index unusable).
 */
export function normalizeCouponCode(code: string): string {
  return code.trim().toUpperCase();
}

/** A validated coupon, ready to hand to `priceQuote()` as its `coupon` input. */
export type ValidCoupon = { id: number; code: string } & CouponDiscount;

/** The coupon named does not exist (any case, any whitespace, once normalised). */
export class CouponNotFoundError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(`No coupon found for code "${code}"`);
    this.name = 'CouponNotFoundError';
    this.code = code;
  }
}

/** The coupon exists but has been switched off (`is_active = false`). */
export class CouponInactiveError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(`Coupon "${code}" is not active`);
    this.name = 'CouponInactiveError';
    this.code = code;
  }
}

/** `now` is still before the coupon's `starts_at`. */
export class CouponNotStartedError extends Error {
  readonly code: string;
  readonly startsAt: Date;

  constructor(code: string, startsAt: Date) {
    super(`Coupon "${code}" does not start until ${startsAt.toISOString()}`);
    this.name = 'CouponNotStartedError';
    this.code = code;
    this.startsAt = startsAt;
  }
}

/** `now` is already past the coupon's `ends_at`. */
export class CouponExpiredError extends Error {
  readonly code: string;
  readonly endsAt: Date;

  constructor(code: string, endsAt: Date) {
    super(`Coupon "${code}" expired at ${endsAt.toISOString()}`);
    this.name = 'CouponExpiredError';
    this.code = code;
    this.endsAt = endsAt;
  }
}

/**
 * `used_count >= usage_limit`. This is the EARLY, friendly refusal — the
 * authoritative re-check happens again under a row lock in `createHold()`,
 * because this one is not taken under any lock and two guests could both
 * read "one use left" at once.
 */
export class CouponUsageLimitReachedError extends Error {
  readonly code: string;
  readonly usageLimit: number;

  constructor(code: string, usageLimit: number) {
    super(`Coupon "${code}" has reached its usage limit of ${usageLimit}`);
    this.name = 'CouponUsageLimitReachedError';
    this.code = code;
    this.usageLimit = usageLimit;
  }
}

/**
 * The subtotal is below the coupon's `min_spend_centavos`. Carries the
 * shortfall so the checkout UI can say "spend ₱500 more" rather than a bare
 * refusal.
 */
export class CouponMinimumSpendNotMetError extends Error {
  readonly code: string;
  readonly minSpendCentavos: number;
  readonly subtotalCentavos: number;
  readonly shortfallCentavos: number;

  constructor(code: string, minSpendCentavos: number, subtotalCentavos: number) {
    const shortfallCentavos = minSpendCentavos - subtotalCentavos;
    super(
      `Coupon "${code}" needs a minimum spend of ${minSpendCentavos} centavos; ` +
        `subtotal is ${subtotalCentavos}, short by ${shortfallCentavos}`,
    );
    this.name = 'CouponMinimumSpendNotMetError';
    this.code = code;
    this.minSpendCentavos = minSpendCentavos;
    this.subtotalCentavos = subtotalCentavos;
    this.shortfallCentavos = shortfallCentavos;
  }
}

/**
 * §6: "server-validated: active, within dates, under usage limit, minimum
 * spend" — checked IN THAT ORDER, each its own typed error, so the checkout
 * UI can tell a guest which rule they failed.
 *
 * `now` is a parameter and this function never calls `new Date()` itself,
 * so the window checks (`starts_at`/`ends_at`) run in milliseconds in a
 * test and are not at the mercy of the real clock.
 */
export async function validateCoupon(
  code: string,
  subtotalCentavos: number,
  now: Date,
): Promise<ValidCoupon> {
  const normalized = normalizeCouponCode(code);
  const db = getDb();
  const [row] = await db
    .select({
      id: coupons.id,
      code: coupons.code,
      discountType: coupons.discountType,
      percentBp: coupons.percentBp,
      amountCentavos: coupons.amountCentavos,
      minSpendCentavos: coupons.minSpendCentavos,
      startsAt: coupons.startsAt,
      endsAt: coupons.endsAt,
      usageLimit: coupons.usageLimit,
      usedCount: coupons.usedCount,
      isActive: coupons.isActive,
    })
    .from(coupons)
    .where(eq(coupons.code, normalized));

  if (!row) throw new CouponNotFoundError(normalized);
  if (!row.isActive) throw new CouponInactiveError(normalized);
  if (row.startsAt && now < row.startsAt) throw new CouponNotStartedError(normalized, row.startsAt);
  if (row.endsAt && now > row.endsAt) throw new CouponExpiredError(normalized, row.endsAt);
  if (row.usageLimit !== null && row.usedCount >= row.usageLimit) {
    throw new CouponUsageLimitReachedError(normalized, row.usageLimit);
  }
  if (row.minSpendCentavos !== null && subtotalCentavos < row.minSpendCentavos) {
    throw new CouponMinimumSpendNotMetError(normalized, row.minSpendCentavos, subtotalCentavos);
  }

  if (row.discountType === 'percent') {
    return {
      id: row.id,
      code: row.code,
      discountType: 'percent',
      percentBp: row.percentBp!,
      amountCentavos: null,
    };
  }
  return {
    id: row.id,
    code: row.code,
    discountType: 'fixed',
    percentBp: null,
    amountCentavos: row.amountCentavos!,
  };
}

/**
 * Reserves a coupon's use for one booking: inserts the `coupon_redemptions`
 * row AND increments `coupons.used_count`, inside the caller's transaction
 * (owner decision Q7/Q8 — an active hold reserves coupon usage, not just
 * capacity).
 *
 * Relies on the `UNIQUE (coupon_id, booking_id)` index rather than checking
 * first: the insert is attempted directly, and a duplicate (the same
 * booking redeeming the same coupon twice) fails on the constraint rather
 * than on a read-then-write race. The duplicate-key error is left to
 * PROPAGATE, never swallowed — the caller's transaction (which both writes
 * share) then rolls back as a whole on that throw, so a rejected duplicate
 * leaves `used_count` exactly where it was, not incremented a second time.
 */
export async function recordRedemption(
  tx: Transaction,
  couponId: number,
  bookingId: number,
): Promise<void> {
  await tx.insert(couponRedemptions).values({ couponId, bookingId });
  await tx
    .update(coupons)
    .set({ usedCount: sql`${coupons.usedCount} + 1` })
    .where(eq(coupons.id, couponId));
}

/**
 * Releases a coupon slot a hold had reserved (owner decision Q7/Q8 — expiry
 * releases the coupon slot as well as the capacity). Deletes the
 * `coupon_redemptions` row and decrements `coupons.used_count`, inside the
 * caller's transaction.
 *
 * **Idempotent by construction**: the decrement runs only when the delete
 * actually removed a row (checked via the delete's affected-row count, not
 * a prior read), so calling this twice for the same (coupon, booking) pair
 * decrements `used_count` once, not twice.
 */
export async function releaseRedemption(
  tx: Transaction,
  couponId: number,
  bookingId: number,
): Promise<void> {
  const [result] = await tx
    .delete(couponRedemptions)
    .where(
      and(eq(couponRedemptions.couponId, couponId), eq(couponRedemptions.bookingId, bookingId)),
    );

  if (result.affectedRows > 0) {
    await tx
      .update(coupons)
      .set({ usedCount: sql`${coupons.usedCount} - 1` })
      .where(eq(coupons.id, couponId));
  }
}
