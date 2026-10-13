/**
 * Task 11 of the Week 3 checkout plan: `expireHolds()`, the sweep that gives
 * a lapsed hold's capacity back.
 *
 * **Nothing here waits on a timer, and nothing here starts a cron.**
 * `expireHolds(now)` takes the clock as a parameter precisely so the sweep is
 * testable without a scheduler; `node-cron` is wired up in
 * `server/src/jobs/index.ts`, which this file never imports.
 *
 * **Why the fixtures are COMMITTED.** `expireHolds()` opens its own
 * transaction on its own pooled connection, so a booking left uncommitted is
 * a booking the sweep cannot see and every test would sweep nothing — green
 * against broken code. Fixtures are therefore committed and torn down in
 * `afterAll`, by id, against `rg_travel_test` only (`per-file-setup.ts`
 * proves the connection with a real `SELECT DATABASE()` before the first
 * test here runs). Bookings are built here rather than read out of the seed,
 * which has none: "find any pending booking" would find nothing and pass
 * vacuously.
 *
 * **Why `beforeAll` drains first.** The sweep is deliberately global — it
 * scans every booking, not a list this file hands it — so a stray lapsed
 * hold left behind by another suite would be swept too and the `expired`
 * counts below would not be exact. One drain sweep before the first test
 * expires whatever was already lapsed in `rg_travel_test`, so from then on
 * the only candidates are the ones these tests create. Every status, audit
 * and coupon assertion is still scoped to this file's own ids regardless.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import type { BookingStatus, PriceSnapshot } from '@rg/shared';
import { getDb, getPool } from '../db/client';
import { bookings, couponRedemptions, coupons, destinations, tours } from '../db/schema';
import { generateBookingRef } from '../services/booking-ref';
import { expireHolds } from '../jobs/expire-holds';

/** Every id this file committed, so `afterAll` removes exactly those rows. */
const created = {
  bookingIds: [] as number[],
  tourIds: [] as number[],
  destinationIds: [] as number[],
  couponIds: [] as number[],
};

/**
 * The same runtime probe the sibling DB-backed suites use: a missing
 * migration or an unreachable MySQL reports as SKIPPED rather than silently
 * passing.
 */
async function tableExists(name: string): Promise<boolean> {
  try {
    const [rows] = (await getPool().query(
      'SELECT 1 FROM information_schema.tables WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?',
      [name],
    )) as [unknown[], unknown];
    return rows.length > 0;
  } catch {
    return false;
  }
}

const ready =
  (await tableExists('bookings')) &&
  (await tableExists('coupons')) &&
  (await tableExists('coupon_redemptions')) &&
  (await tableExists('audit_log'));
const dbIt = ready ? it : it.skip;

const unique = () => `${Date.now()}_${Math.floor(Math.random() * 1e9)}`;

/** The minimum snapshot `bookings.price_snapshot` accepts. No test reads it. */
const FIXTURE_SNAPSHOT: PriceSnapshot = {
  tier: { tierId: 1, minPax: 1, maxPax: 6, pricePerPersonCentavos: 100_000 },
  addons: [],
  coupon: null,
  depositPercent: 30,
  freeCancelHours: 48,
  subtotalCentavos: 200_000,
  discountCentavos: 0,
  totalCentavos: 200_000,
};

/** One tour (and its destination) for the whole file — the FKs need them. */
let tourId = 0;

async function makeTour(): Promise<number> {
  const slug = `__expire__${unique()}`;
  const [destination] = await getDb().insert(destinations).values({ name: slug, slug });
  created.destinationIds.push(destination.insertId);
  const [tour] = await getDb()
    .insert(tours)
    .values({ slug, title: slug, destinationId: destination.insertId });
  created.tourIds.push(tour.insertId);
  return tour.insertId;
}

/** A coupon with one use already reserved, the way an active hold leaves it. */
async function makeCouponWithOneUse(): Promise<{ id: number; code: string }> {
  const code = `__EXPIRE__${unique()}`.toUpperCase().slice(0, 40);
  const [row] = await getDb()
    .insert(coupons)
    .values({ code, discountType: 'percent', percentBp: 1000, usedCount: 1, isActive: true });
  created.couponIds.push(row.insertId);
  return { id: row.insertId, code };
}

const MINUTE = 60_000;

/**
 * A committed booking. The defaults are a LAPSED, UNPAID hold — the thing
 * the sweep exists for — and every test overrides only the one fact it is
 * about.
 */
async function seedHold(
  opts: {
    status?: BookingStatus;
    /** Minutes BEFORE `now` the hold lapsed. Negative for a hold still live. */
    lapsedMinutesAgo?: number;
    holdExpiresAt?: Date | null;
    paymentReviewRequired?: boolean;
    amountPaid?: number;
    couponId?: number | null;
  } = {},
): Promise<{ bookingId: number; ref: string }> {
  const ref = generateBookingRef();
  const lapsedMinutesAgo = opts.lapsedMinutesAgo ?? 5;
  const [row] = await getDb()
    .insert(bookings)
    .values({
      ref,
      tourId,
      tourDate: new Date('2099-12-25T00:00:00Z'),
      pax: 2,
      leadName: 'Expiry Sweep Fixture',
      leadEmail: 'fixture@example.test',
      leadPhone: '09170000000',
      status: opts.status ?? 'pending_payment',
      payMode: 'full',
      priceSnapshot: FIXTURE_SNAPSHOT,
      subtotalCentavos: 200_000,
      totalCentavos: 200_000,
      amountPaidCentavos: opts.amountPaid ?? 0,
      paymentReviewRequired: opts.paymentReviewRequired ?? false,
      couponId: opts.couponId ?? null,
      holdExpiresAt:
        opts.holdExpiresAt === undefined
          ? new Date(Date.now() - lapsedMinutesAgo * MINUTE)
          : opts.holdExpiresAt,
    });
  created.bookingIds.push(row.insertId);
  return { bookingId: row.insertId, ref };
}

type Statement = Parameters<ReturnType<typeof getDb>['execute']>[0];

async function rows<T>(statement: Statement): Promise<T[]> {
  const [result] = (await getDb().execute(statement)) as unknown as [T[], unknown];
  return result;
}

async function statusOf(bookingId: number): Promise<string> {
  const found = await rows<{ status: string }>(
    sql`SELECT status FROM bookings WHERE id = ${bookingId}`,
  );
  const row = found[0];
  if (!row) throw new Error(`fixture booking ${bookingId} is not there`);
  return row.status;
}

interface AuditRow {
  action: string;
  actor_type: string;
  actor_id: number | null;
  data: unknown;
}

const expiryAuditRows = (bookingId: number) =>
  rows<AuditRow>(
    sql`SELECT action, actor_type, actor_id, data FROM audit_log
        WHERE entity = 'bookings' AND entity_id = ${bookingId} AND action = 'booking.expired'`,
  );

async function usedCount(couponId: number): Promise<number> {
  const found = await rows<{ used_count: number }>(
    sql`SELECT used_count FROM coupons WHERE id = ${couponId}`,
  );
  const row = found[0];
  if (!row) throw new Error(`fixture coupon ${couponId} is not there`);
  return Number(row.used_count);
}

async function redemptionCount(couponId: number, bookingId: number): Promise<number> {
  const found = await rows<{ n: number }>(
    sql`SELECT COUNT(*) n FROM coupon_redemptions
        WHERE coupon_id = ${couponId} AND booking_id = ${bookingId}`,
  );
  return Number(found[0]?.n ?? -1);
}

describe('expireHolds (Task 11)', () => {
  beforeAll(async () => {
    if (!ready) return;
    tourId = await makeTour();
    // See the file note: drain anything another suite left lapsed, so the
    // `expired` counts below count only this file's fixtures.
    await expireHolds(new Date());
  });

  afterAll(async () => {
    if (!ready) return;
    const pool = getPool();
    for (const bookingId of created.bookingIds) {
      await pool.query('DELETE FROM audit_log WHERE entity = ? AND entity_id = ?', [
        'bookings',
        bookingId,
      ]);
      await pool.query('DELETE FROM coupon_redemptions WHERE booking_id = ?', [bookingId]);
      /*
       * Raw SQL, not `db.delete(bookings)`, deliberately: the convention
       * guard in `schema-conventions.test.ts` scans the whole server tree —
       * tests included — for the Drizzle hard-delete form, and exempts only
       * the raw-SQL form, for exactly this case: a fixture removing its own
       * rows from `rg_travel_test`.
       */
      await pool.query('DELETE FROM bookings WHERE id = ?', [bookingId]);
    }
    for (const couponId of created.couponIds) {
      await pool.query('DELETE FROM coupons WHERE id = ?', [couponId]);
    }
    for (const id of created.tourIds) {
      await pool.query('DELETE FROM tours WHERE id = ?', [id]);
    }
    for (const id of created.destinationIds) {
      await pool.query('DELETE FROM destinations WHERE id = ?', [id]);
    }
  });

  dbIt('expires a lapsed unpaid hold', async () => {
    const { bookingId, ref } = await seedHold();

    const result = await expireHolds(new Date());

    expect(result.expired, 'the sweep did not count the hold it expired').toBe(1);
    expect(await statusOf(bookingId), 'a lapsed hold kept its capacity').toBe('expired');

    const audit = await expiryAuditRows(bookingId);
    expect(audit, 'an expiry with no audit row').toHaveLength(1);
    const data = typeof audit[0]!.data === 'string' ? JSON.parse(audit[0]!.data) : audit[0]!.data;
    expect(data).toMatchObject({ ref, previousStatus: 'pending_payment' });
  });

  /**
   * The carry-forward case, and the one that carries real money.
   * `recordPayment()` deliberately leaves `hold_expires_at` SET when money
   * lands after the hold lapsed — it records the payment, raises
   * `payment_review_required` and leaves the status alone for an admin — so
   * this booking matches a naive `WHERE status = 'pending_payment' AND
   * hold_expires_at < NOW()`. Expiring it would bury a guest who has already
   * paid in exactly the queue meant to surface them.
   *
   * **This row is protected TWICE over** — it carries the review flag AND
   * money — which is what a real late payment looks like and is the reason
   * the two tests after it exist: each isolates one of the two conditions,
   * so neither can be deleted without a red test. Removing both is what
   * turns this one red.
   */
  dbIt('does NOT expire a lapsed hold that has been PAID and flagged for review', async () => {
    const { bookingId } = await seedHold({ paymentReviewRequired: true, amountPaid: 200_000 });

    const result = await expireHolds(new Date());

    expect(await statusOf(bookingId), 'a paid booking was expired by the cron').not.toBe('expired');
    expect(result.expired, 'the sweep counted a booking it must not touch').toBe(0);
    expect(await expiryAuditRows(bookingId), 'a paid booking was audited as expired').toHaveLength(
      0,
    );
  });

  /**
   * The review flag ON ITS OWN is enough to keep the sweep away — nothing
   * else about this row protects it, so this is the test that goes red if
   * `payment_review_required` leaves the WHERE clause.
   *
   * No path produces this exact row today (late money moves
   * `amount_paid_centavos` as it raises the flag), which is the point: the
   * flag is the rule, and it must not depend on the money column happening
   * to agree with it. The admin review surface of a later week will raise
   * and clear this flag on its own.
   */
  dbIt('does NOT expire a hold flagged for review, flag alone', async () => {
    const { bookingId } = await seedHold({ paymentReviewRequired: true, amountPaid: 0 });

    const result = await expireHolds(new Date());

    expect(await statusOf(bookingId), 'a booking in the review queue was expired').not.toBe(
      'expired',
    );
    expect(result.expired).toBe(0);
    expect(await expiryAuditRows(bookingId)).toHaveLength(0);
  });

  /**
   * Defence in depth, and the other half of the pair: the sweep refuses to
   * expire ANY booking with money against it, flag or no flag. If a future
   * path ever credits `amount_paid_centavos` without raising the review
   * flag, this is what stops the sweep from hiding it.
   */
  dbIt('does NOT expire a lapsed hold that has money against it, flag or no flag', async () => {
    const { bookingId } = await seedHold({ amountPaid: 60_000, paymentReviewRequired: false });

    const result = await expireHolds(new Date());

    expect(await statusOf(bookingId), 'a booking with money against it was expired').not.toBe(
      'expired',
    );
    expect(result.expired).toBe(0);
  });

  /**
   * `status` is a gate of its own, and `cancelled` is the case that proves
   * it: an admin-cancelled hold that was never paid is protected by nothing
   * else — no money, no review flag, and `hold_expires_at` still sitting in
   * the past. §5 keeps `cancelled` and `expired` as separate terminal
   * states because "an admin cancelled this" and "the hold ran out" are
   * different events and refunds only ever attach to the first, so a sweep
   * that relabelled one as the other would destroy that distinction.
   */
  dbIt('does NOT expire a booking that is no longer pending payment', async () => {
    const { bookingId } = await seedHold({ status: 'cancelled', amountPaid: 0 });

    const result = await expireHolds(new Date());

    expect(await statusOf(bookingId), 'a cancelled booking was relabelled expired').toBe(
      'cancelled',
    );
    expect(result.expired).toBe(0);
  });

  dbIt('leaves a hold that has not lapsed yet', async () => {
    const { bookingId } = await seedHold({ lapsedMinutesAgo: -10 });

    const result = await expireHolds(new Date());

    expect(await statusOf(bookingId), 'a live hold was expired early').toBe('pending_payment');
    expect(result.expired).toBe(0);
  });

  dbIt('writes one audit row per expiry, actor_type system', async () => {
    const first = await seedHold();
    const second = await seedHold();

    const result = await expireHolds(new Date());
    expect(result.expired).toBe(2);

    for (const { bookingId, ref } of [first, second]) {
      const audit = await expiryAuditRows(bookingId);
      // Exactly one. Two would mean the audit trail double-counted an expiry.
      expect(audit, `expected one audit row for booking ${bookingId}`).toHaveLength(1);
      const row = audit[0]!;
      // A cron job is `system`: never `provider` (that is a gateway) and
      // never `user`. `actor_id` is null because a cron is not a row.
      expect(row.actor_type).toBe('system');
      expect(row.actor_id).toBeNull();
      const data = typeof row.data === 'string' ? JSON.parse(row.data) : row.data;
      expect(data).toMatchObject({ ref, previousStatus: 'pending_payment' });
    }
  });

  dbIt('is idempotent — a second sweep expires nothing', async () => {
    const { bookingId } = await seedHold();

    const first = await expireHolds(new Date());
    expect(first.expired).toBe(1);

    const second = await expireHolds(new Date());

    expect(second.expired, 'a second sweep expired the same hold again').toBe(0);
    expect(await statusOf(bookingId)).toBe('expired');
    expect(await expiryAuditRows(bookingId), 'a second audit row for one expiry').toHaveLength(1);
  });

  /**
   * Owner decision Q7/Q8: an active hold reserves the coupon's use, not just
   * the capacity — so expiring the hold has to give the use back, or a code
   * limited to ten uses is spent by ten abandoned checkouts.
   */
  dbIt('releases the coupon usage the hold had reserved', async () => {
    const coupon = await makeCouponWithOneUse();
    const { bookingId } = await seedHold({ couponId: coupon.id });
    await getDb().insert(couponRedemptions).values({ couponId: coupon.id, bookingId });

    await expireHolds(new Date());

    expect(await statusOf(bookingId)).toBe('expired');
    expect(await usedCount(coupon.id), 'the coupon use was not released').toBe(0);
    expect(await redemptionCount(coupon.id, bookingId), 'the redemption row survived').toBe(0);
  });

  dbIt('never decrements a coupon used_count twice for one hold', async () => {
    const coupon = await makeCouponWithOneUse();
    const { bookingId } = await seedHold({ couponId: coupon.id });
    await getDb().insert(couponRedemptions).values({ couponId: coupon.id, bookingId });

    await expireHolds(new Date());
    await expireHolds(new Date());

    expect(await usedCount(coupon.id), 'used_count went below the truth').toBe(0);
    expect(await redemptionCount(coupon.id, bookingId)).toBe(0);
    expect(await expiryAuditRows(bookingId)).toHaveLength(1);
  });

  dbIt('leaves the lapse timestamp on the expired row for the audit trail', async () => {
    const { bookingId } = await seedHold();
    await expireHolds(new Date());

    const found = await rows<{ hold_expires_at: Date | null }>(
      sql`SELECT hold_expires_at FROM bookings WHERE id = ${bookingId}`,
    );
    expect(found[0]?.hold_expires_at, 'when the hold lapsed was thrown away').not.toBeNull();
  });
});
