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
 *
 * **The two-connection tests at the bottom are the ones that matter most.**
 * Everything above them passes against a read-then-update sweep that decides
 * from the candidate read instead of from the UPDATE's own WHERE — and such a
 * sweep expires a guest who has just paid. They are driven CONCURRENTLY, with
 * a checkpoint that fails the test if the overlap did not actually happen,
 * following the pattern `create-hold.test.ts` established for its races.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import type { BookingStatus, PriceSnapshot } from '@rg/shared';
import { getDb, getPool } from '../db/client';
import { bookings, couponRedemptions, coupons, destinations, tours } from '../db/schema';
import { generateBookingRef } from '../services/booking-ref';

/**
 * A failure injected into `writeAudit` for ONE booking — the last write an
 * expiry makes — so the "one bad row must not stop the sweep" guarantee can
 * be tested without inventing a database fault.
 *
 * `vi.hoisted` because `vi.mock`'s factory is hoisted above the imports. The
 * mock delegates to the real `writeAudit` for every other booking, so the
 * rest of this file exercises the genuine audit path and a mock that stopped
 * intercepting would make the poison-pill test go red rather than silently
 * pass. Lifted from `record-payment.test.ts`, which does the same thing.
 */
const auditControl = vi.hoisted(() => ({ failForBookingId: null as number | null }));

vi.mock('../services/audit', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/audit')>();
  return {
    ...actual,
    writeAudit: async (...args: Parameters<typeof actual.writeAudit>) => {
      const [, entry] = args;
      if (entry.entityId === auditControl.failForBookingId && entry.entity === 'bookings') {
        throw new Error('__injected_audit_failure__');
      }
      return actual.writeAudit(...args);
    },
  };
});

const { expireHolds, HOLD_SWEEP_BATCH_LIMIT } = await import('../jobs/expire-holds');
const { recordPayment } = await import('../services/payments/record-payment');

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
  // The mirror test records a real late payment through `recordPayment()`.
  (await tableExists('payments')) &&
  (await tableExists('audit_log'));
const dbIt = ready ? it : it.skip;

/** One sweep's result, without restating its shape here. */
type SweepResult = Awaited<ReturnType<typeof expireHolds>>;

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

/** The fixture tour's day, as the civil date the audit row must name. */
const TOUR_DATE = '2099-12-25';

/**
 * Whole seconds, always.
 *
 * `bookings.hold_expires_at` is a bare `datetime` — no fractional-seconds
 * field — and MySQL ROUNDS a value with a fractional part on the way in
 * (`…:00.750` is stored as `…:01`). A fixture seeded with `Date.now()`
 * therefore comes back up to half a second away from what it wrote, which
 * would make both the boundary test below and the exact `holdExpiresAt`
 * assertion in the audit payload flaky in one direction. Flooring makes the
 * value round-trip exactly.
 */
const wholeSecond = (ms: number) => new Date(Math.floor(ms / 1000) * 1000);

/**
 * A committed booking. The defaults are a LAPSED, UNPAID hold — the thing
 * the sweep exists for — and every test overrides only the one fact it is
 * about.
 *
 * Returns the `hold_expires_at` it actually wrote, so a test can assert the
 * audit payload's copy of it rather than approximating.
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
): Promise<{ bookingId: number; ref: string; holdExpiresAt: Date | null }> {
  const ref = generateBookingRef();
  const lapsedMinutesAgo = opts.lapsedMinutesAgo ?? 5;
  const holdExpiresAt =
    opts.holdExpiresAt === undefined
      ? wholeSecond(Date.now() - lapsedMinutesAgo * MINUTE)
      : opts.holdExpiresAt;
  const [row] = await getDb()
    .insert(bookings)
    .values({
      ref,
      tourId,
      tourDate: new Date(`${TOUR_DATE}T00:00:00Z`),
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
      holdExpiresAt,
    });
  created.bookingIds.push(row.insertId);
  return { bookingId: row.insertId, ref, holdExpiresAt };
}

/**
 * Opens `n` pool connections and gives them straight back, so the pool has
 * them live before a concurrency test starts.
 *
 * Not an optimisation — the same measurement `create-hold.test.ts` records:
 * a "concurrent" call that has to open a TCP connection and complete a MySQL
 * handshake while the other side runs sub-millisecond statements on a warm
 * connection is a SEQUENTIAL pair wearing a costume, and a sequential pair
 * passes against a sweep with no serialisation at all.
 */
async function warmPool(n = 4) {
  const held = await Promise.all(Array.from({ length: n }, () => getPool().getConnection()));
  for (const connection of held) connection.release();
}

/** A payment id this file created, so teardown can reach its rows. */
const createdPaymentIds: number[] = [];

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

/** `audit_log.data` comes back as a string on some drivers, an object on others. */
const auditData = (row: AuditRow): Record<string, unknown> =>
  (typeof row.data === 'string' ? JSON.parse(row.data) : row.data) as Record<string, unknown>;

/**
 * The ONE audit row an expiry must have written, with its whole payload
 * checked.
 *
 * Asserting the complete object rather than a two-field `toMatchObject` is
 * deliberate (fix round 1): `reason`, `couponId`, `sweptAt` and
 * `holdExpiresAt` are what let an admin reconstruct what the cron did, and a
 * partial match would let any of them be dropped or mistyped with every test
 * still green.
 */
async function expectOneExpiryAudit(
  booking: { bookingId: number; ref: string; holdExpiresAt: Date | null },
  expected: { sweptAt: Date; couponId?: number | null },
): Promise<void> {
  const audit = await expiryAuditRows(booking.bookingId);
  expect(
    audit,
    `expected exactly one expiry audit row for booking ${booking.bookingId}`,
  ).toHaveLength(1);
  const row = audit[0]!;
  // A cron job is `system`: never `provider` (that means a gateway) and
  // never `user`. `actor_id` is null because a cron is not a row.
  expect(row.actor_type).toBe('system');
  expect(row.actor_id).toBeNull();
  expect(row.action).toBe('booking.expired');
  expect(auditData(row)).toEqual({
    ref: booking.ref,
    previousStatus: 'pending_payment',
    reason: 'hold_expired',
    tourId,
    /*
     * The civil date in Asia/Manila, which is what `bookings.tour_date`
     * means. Note what this does and does not pin: the column is a `date`
     * and the pool runs at `timezone: 'Z'`, so `manilaCivilDate()` and a raw
     * `toISOString().slice(0, 10)` agree for every value this column can
     * hold — the feared off-by-one day is unobservable here. It would stop
     * being unobservable the moment this became a `datetime`, which is why
     * the helper stays; this assertion pins the VALUE.
     */
    tourDate: TOUR_DATE,
    holdExpiresAt: booking.holdExpiresAt?.toISOString() ?? null,
    sweptAt: expected.sweptAt.toISOString(),
    couponId: expected.couponId ?? null,
  });
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
    auditControl.failForBookingId = null;
    const pool = getPool();
    /*
     * Batched `IN (…)` rather than a statement per id: the batch-limit test
     * commits HOLD_SWEEP_BATCH_LIMIT + 1 bookings, and a per-id teardown
     * would be ~600 round trips for one test's fixtures.
     */
    if (created.bookingIds.length > 0) {
      const ids = created.bookingIds;
      // The payments the mirror test created, and their audit rows, first:
      // `payments.booking_id` is a real foreign key.
      if (createdPaymentIds.length > 0) {
        await pool.query('DELETE FROM audit_log WHERE entity = ? AND entity_id IN (?)', [
          'payments',
          createdPaymentIds,
        ]);
        await pool.query('DELETE FROM payments WHERE id IN (?)', [createdPaymentIds]);
      }
      await pool.query('DELETE FROM audit_log WHERE entity = ? AND entity_id IN (?)', [
        'bookings',
        ids,
      ]);
      await pool.query('DELETE FROM coupon_redemptions WHERE booking_id IN (?)', [ids]);
      /*
       * Raw SQL, not `db.delete(bookings)`, deliberately: the convention
       * guard in `schema-conventions.test.ts` scans the whole server tree —
       * tests included — for the Drizzle hard-delete form, and exempts only
       * the raw-SQL form, for exactly this case: a fixture removing its own
       * rows from `rg_travel_test`.
       */
      await pool.query('DELETE FROM bookings WHERE id IN (?)', [ids]);
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
    const hold = await seedHold();
    const now = new Date();

    const result = await expireHolds(now);

    expect(result.expired, 'the sweep did not count the hold it expired').toBe(1);
    expect(await statusOf(hold.bookingId), 'a lapsed hold kept its capacity').toBe('expired');
    await expectOneExpiryAudit(hold, { sweptAt: now });
  });

  /**
   * The boundary of the `lte`-not-`lt` contract, which every other fixture
   * here is minutes away from.
   *
   * A hold is valid UNTIL `hold_expires_at`, and the two other readers of
   * that column agree: `lateMoneyReason()` treats `<= now` as lapsed and
   * `startPayment`'s payable check requires `> now`. A drift to `<` would
   * open a one-second window in which the gateway path calls a hold dead
   * while the sweep still calls it live — and nothing else in this file
   * would notice.
   */
  dbIt('expires a hold at the exact instant it lapses', async () => {
    const at = wholeSecond(Date.now());
    const { bookingId } = await seedHold({ holdExpiresAt: at });

    // The same whole second on both sides: hold_expires_at === now.
    const result = await expireHolds(at);

    expect(result.expired, 'a hold that lapsed exactly now survived the sweep').toBe(1);
    expect(await statusOf(bookingId)).toBe('expired');
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
    /*
     * Measured as a DELTA, not an absolute: this row is skipped for good and
     * so adds 1 to `skippedWithMoney` for every later sweep in this file,
     * and a crashed earlier suite could in principle have left another one
     * behind. The delta is still exact, which is what the mutation proof
     * needs.
     */
    const before = await expireHolds(new Date());
    const { bookingId } = await seedHold({ amountPaid: 60_000, paymentReviewRequired: false });

    const result = await expireHolds(new Date());

    expect(await statusOf(bookingId), 'a booking with money against it was expired').not.toBe(
      'expired',
    );
    expect(result.expired).toBe(0);
    // The spare guard must be VISIBLE, not silent: money sitting on a
    // booking with no review flag is money nobody is looking at.
    expect(
      result.skippedWithMoney - before.skippedWithMoney,
      'the sweep skipped money silently',
    ).toBe(1);
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
    const now = new Date();

    const result = await expireHolds(now);
    expect(result.expired).toBe(2);

    // Exactly one row each, whole payload checked. Two would mean the audit
    // trail double-counted an expiry.
    await expectOneExpiryAudit(first, { sweptAt: now });
    await expectOneExpiryAudit(second, { sweptAt: now });
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
    const hold = await seedHold({ couponId: coupon.id });
    await getDb()
      .insert(couponRedemptions)
      .values({ couponId: coupon.id, bookingId: hold.bookingId });
    const now = new Date();

    await expireHolds(now);

    expect(await statusOf(hold.bookingId)).toBe('expired');
    expect(await usedCount(coupon.id), 'the coupon use was not released').toBe(0);
    expect(await redemptionCount(coupon.id, hold.bookingId), 'the redemption row survived').toBe(0);
    // The audit row names the coupon whose use went back — an admin asking
    // "why is this code's count lower than I expected" reads it here.
    await expectOneExpiryAudit(hold, { sweptAt: now, couponId: coupon.id });
  });

  /**
   * **An integration assertion, and it cannot fail under a single-point
   * mutation of this module** (fix round 1, reviewer's note): the
   * double-decrement is prevented twice over, in two places that are layered
   * rather than entangled, and each layer is already isolated by a test of
   * its own — the sweep's second-pass behaviour by "is idempotent — a second
   * sweep expires nothing" (and its audit-row count), and the decrement
   * itself by `coupons.test.ts`'s "releasing twice decrements used_count
   * exactly once".
   *
   * What this one adds is the end-to-end fact the owner asked for in those
   * words: run the whole sweep twice over a couponed hold and `used_count`
   * is 0, not -1. It is kept for that, not as a claim of new coverage, and
   * it is NOT a reason to mutate a money-path file to produce a red.
   */
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

  /**
   * **One poisoned row must not stop the sweep.**
   *
   * Per-booking transactions preserve committed work; they do NOT give the
   * loop progress. Before fix round 1 a single throw rejected the whole
   * `expireHolds` promise — and because the candidate read is ordered by
   * lapse time, the next tick started again with the same oldest row. A row
   * persistently blocked by a long transaction would therefore abort every
   * NEWER lapsed hold, every minute, re-creating the exact bug this task
   * exists to fix while the cron looked healthy.
   *
   * The failure is injected into `writeAudit` for one booking id — the last
   * write an expiry makes, so the poisoned booking's whole transaction rolls
   * back, which is also asserted here.
   */
  dbIt('keeps sweeping after one booking throws, and retries it next tick', async () => {
    // Older lapse, so the ordered candidate read reaches it FIRST.
    const poison = await seedHold({ lapsedMinutesAgo: 30 });
    const healthy = await seedHold({ lapsedMinutesAgo: 5 });
    auditControl.failForBookingId = poison.bookingId;

    let result;
    try {
      result = await expireHolds(new Date());
    } finally {
      auditControl.failForBookingId = null;
    }

    expect(result.failed, 'the failure was swallowed without being counted').toBe(1);
    expect(result.expired, 'the newer hold was abandoned with the poisoned one').toBe(1);
    expect(await statusOf(healthy.bookingId), 'a newer lapsed hold kept its capacity').toBe(
      'expired',
    );
    // Rolled back whole: no status change, and no half-written audit row.
    expect(await statusOf(poison.bookingId)).toBe('pending_payment');
    expect(await expiryAuditRows(poison.bookingId)).toHaveLength(0);

    // And the next tick picks it up, now that the injected failure is gone.
    const retry = await expireHolds(new Date());
    expect(retry.expired, 'the failed booking was never retried').toBe(1);
    expect(await statusOf(poison.bookingId)).toBe('expired');
  });

  /**
   * The candidate read is capped, so a backlog becomes successive ticks
   * instead of one giant batch — and the tick after it makes progress rather
   * than starting the same batch again.
   */
  dbIt('expires at most one batch per sweep, and the rest on the next tick', async () => {
    const overflow = HOLD_SWEEP_BATCH_LIMIT + 1;
    // One multi-row INSERT, not `overflow` round trips.
    const refs = Array.from({ length: overflow }, () => generateBookingRef());
    const lapsed = wholeSecond(Date.now() - 20 * MINUTE);
    await getDb()
      .insert(bookings)
      .values(
        refs.map((ref) => ({
          ref,
          tourId,
          tourDate: new Date(`${TOUR_DATE}T00:00:00Z`),
          pax: 2,
          leadName: 'Expiry Sweep Batch Fixture',
          leadEmail: 'fixture@example.test',
          leadPhone: '09170000000',
          status: 'pending_payment' as const,
          payMode: 'full' as const,
          priceSnapshot: FIXTURE_SNAPSHOT,
          subtotalCentavos: 200_000,
          totalCentavos: 200_000,
          holdExpiresAt: lapsed,
        })),
      );
    const seeded = await rows<{ id: number }>(
      sql`SELECT id FROM bookings WHERE ref IN (${sql.join(
        refs.map((ref) => sql`${ref}`),
        sql`, `,
      )})`,
    );
    expect(seeded, 'the batch fixture did not commit').toHaveLength(overflow);
    for (const row of seeded) created.bookingIds.push(row.id);

    const first = await expireHolds(new Date());
    expect(first.expired, 'one tick swept more than a batch').toBe(HOLD_SWEEP_BATCH_LIMIT);

    const second = await expireHolds(new Date());
    expect(second.expired, 'the leftovers were not picked up by the next tick').toBe(1);

    const third = await expireHolds(new Date());
    expect(third.expired).toBe(0);
  });

  // -------------------------------------------------------------------------
  // The webhook race, driven with TWO CONNECTIONS. Everything above this
  // point passes against a sweep that decides from its candidate read
  // instead of from the UPDATE's own WHERE — and that sweep expires a guest
  // who has just paid.
  // -------------------------------------------------------------------------

  /**
   * **A webhook credits the booking while the sweep is already waiting for
   * its row.** This is the race `recordPayment()`'s late-money path and this
   * sweep are two halves of, and it is the one thing standing between a
   * refactor and a paid guest being marked `expired`.
   *
   * Connection A takes the booking `FOR UPDATE` — `recordPayment()`'s own
   * first statement, on the same row — and then commits what its late-money
   * path commits: the money, plus `payment_review_required`, with the status
   * left alone. The sweep runs on another connection in between and BLOCKS on
   * the UPDATE, so its decision is forced to be made after A committed.
   *
   * **The overlap is CONSTRUCTED, not hoped for**, and the checkpoint fails
   * the test if the sweep had already finished while A held the lock —
   * otherwise a sequential pair would pass here against a read-then-update
   * sweep, which is precisely the regression this test exists to catch.
   */
  dbIt(
    'does NOT expire a booking a webhook credited while the sweep was waiting (two connections)',
    async () => {
      const { bookingId } = await seedHold();
      await warmPool();

      let settled = false;
      let settledAtCheckpoint = true;
      let sweep: Promise<SweepResult>;
      const holder = await getPool().getConnection();
      try {
        await holder.beginTransaction();
        await holder.query('SELECT id FROM bookings WHERE id = ? FOR UPDATE', [bookingId]);

        sweep = expireHolds(new Date()).finally(() => {
          settled = true;
        });
        // Long enough that a connection handshake cannot explain a stall.
        await new Promise((r) => setTimeout(r, 300));
        settledAtCheckpoint = settled;

        /*
         * What `recordPayment()`'s review path writes for money that lands
         * after the hold lapsed: the payment is real so `amount_paid` moves
         * and the flag goes up, and the STATUS is deliberately left alone
         * for an admin. Written here as raw SQL on the held connection
         * because the point is to hold the lock across the sweep, which
         * `recordPayment()`'s own transaction cannot be made to do.
         */
        await holder.query(
          'UPDATE bookings SET amount_paid_centavos = ?, payment_review_required = 1 WHERE id = ?',
          [200_000, bookingId],
        );
        await holder.commit();
      } finally {
        holder.release();
      }

      const result = await sweep;

      expect(
        settledAtCheckpoint,
        'the sweep finished before the webhook committed — the two never overlapped, so this test proves nothing',
      ).toBe(false);
      expect(result.expired, 'the sweep expired a booking a webhook had just credited').toBe(0);
      expect(await statusOf(bookingId), 'a paid guest was marked expired by the cron').toBe(
        'pending_payment',
      );
      expect(await expiryAuditRows(bookingId)).toHaveLength(0);
    },
  );

  /**
   * The mirror, with the orderings swapped: the sweep commits FIRST and the
   * webhook arrives afterwards. `recordPayment()` must then record the money
   * and raise the review flag **without resurrecting the booking**.
   *
   * This asserts the other side's behaviour, so it is an integration
   * assertion — but it is not unfalsifiable: it reads `reviewReason` out of
   * the payment's own audit row, which is `'booking_expired'` only because
   * this sweep writes exactly that status. Mutating the status this module
   * sets (to `cancelled`, say) turns this test red.
   */
  dbIt('lets a webhook flag money that lands after the sweep has run', async () => {
    const { bookingId, ref } = await seedHold();

    expect((await expireHolds(new Date())).expired).toBe(1);
    expect(await statusOf(bookingId)).toBe('expired');

    const payment = await recordPayment({
      bookingId,
      type: 'payment',
      provider: 'paymongo',
      method: 'gcash',
      amountCentavos: 200_000,
      providerRef: `pi_${Math.random().toString(36).slice(2, 12)}`,
      providerStatus: 'paid',
      // A webhook is `provider` (Q10) — `system` is this cron.
      actor: { type: 'provider', id: null },
    });
    createdPaymentIds.push(payment.paymentId);

    expect(payment.bookingStatus, 'a late payment resurrected an expired booking').toBe('expired');
    expect(payment.paymentReviewRequired, 'nobody will ever look at this money').toBe(true);
    expect(await statusOf(bookingId)).toBe('expired');

    const [audit] = await rows<AuditRow>(
      sql`SELECT action, actor_type, actor_id, data FROM audit_log
          WHERE entity = 'payments' AND entity_id = ${payment.paymentId}`,
    );
    expect(audit, 'the late payment was not audited').toBeDefined();
    expect(auditData(audit!)).toMatchObject({
      bookingRef: ref,
      reviewReason: 'booking_expired',
      priorBookingStatus: 'expired',
      paymentReviewRequired: true,
    });
  });
});
