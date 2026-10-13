/**
 * The hold-expiry sweep (Week 3 checkout plan, Task 11) — §5: "Cron (every
 * minute) moves expired, unpaid holds to `expired` and frees capacity."
 *
 * Until this existed, an unpaid hold held its capacity forever: one
 * abandoned checkout permanently removed a van-day from sale.
 *
 * ## `expireHolds(now)` knows nothing about cron
 *
 * The clock is a PARAMETER, and scheduling lives next door in `./index.ts`.
 * That is what makes the sweep testable without a scheduler: the tests call
 * this function directly and never wait on a timer. `node-cron` is the only
 * caller that passes the real clock.
 *
 * ## THE RULE THAT CARRIES REAL MONEY: skip `payment_review_required`
 *
 * `recordPayment()` deliberately LEAVES `hold_expires_at` set when money
 * lands after the hold lapsed (schema, `bookings.paymentReviewRequired`;
 * owner decision 2026-10-11, task 16b-3). The money is real, so the payment
 * is recorded and `amount_paid_centavos` moves — but the status is left
 * alone and the review flag goes up, because the capacity has been released
 * and re-confirming could overbook the day. An admin then re-confirms or
 * refunds.
 *
 * So a booking whose guest HAS PAID still matches a naive
 * `WHERE status = 'pending_payment' AND hold_expires_at < NOW()`. Expiring
 * it would bury a paid guest in exactly the queue meant to surface them.
 * Hence `payment_review_required = 0` in both WHERE clauses below — and, as
 * defence in depth, `amount_paid_centavos = 0` as well: **the sweep never
 * expires a booking with money against it**, flag or no flag.
 *
 * ## Why there are no slot locks here (and that is deliberate)
 *
 * `takeSlotLocks()` (`services/capacity.ts`) serialises capacity
 * CONSUMERS — two holds racing for the last van must not both read "one
 * free". This sweep is not a consumer: it only ever RELEASES capacity, so
 * there is no number it could read, act on and have invalidated underneath
 * it in a way that oversells anything. The worst a concurrent `createHold()`
 * can do is count a hold this sweep is about to expire as still holding
 * capacity, and refuse a booking that would in fact have fitted — annoying,
 * self-correcting on the next request, and the safe direction (§5: "never
 * overbook automatically"). Taking the fleet lock for every lapsed date
 * would, by contrast, make a once-a-minute batch job contend with every
 * live booking attempt on those dates, for no correctness gained.
 *
 * What the sweep DOES need is to not race the webhook, and the booking row
 * is what both sides touch: `recordPayment()` decides "late money" under
 * `SELECT … FOR UPDATE` on the booking, and the conditional UPDATE below
 * takes the same row's exclusive lock. Two things follow from using the
 * UPDATE itself as the gate:
 *
 *  - MySQL answers an `UPDATE … WHERE` from the LATEST COMMITTED row, not
 *    from the transaction's REPEATABLE READ snapshot, so the decision cannot
 *    be made against a stale version. The snapshot hazard documented in
 *    `capacity.ts` ("THE PRECONDITION") does not apply, because no plain
 *    `SELECT` inside the transaction decides anything.
 *  - A webhook that commits the review flag first makes the UPDATE match
 *    nothing: `affectedRows === 0`, and the sweep writes nothing at all.
 *
 * ## The locks this takes, and the invariant that keeps them safe
 *
 * In order: the booking row (the conditional UPDATE, by PRIMARY KEY), then
 * the coupon's redemption row and the coupon row (`releaseRedemption`). The
 * coupon is last, which is the tail of the global
 * `fleet_date_slots → tour_date_slots → coupon` order.
 *
 * **But it is NOT the case that the sweep simply follows that order, and the
 * reason it is still deadlock-free is worth stating exactly** (fix round 1,
 * MINOR 6): `createHold()` takes the coupon row `FOR UPDATE`
 * (`reserveCouponUnderLock`, `create-hold.ts`) BEFORE it inserts its
 * booking row — so relative to this sweep, which takes a booking row and
 * then a coupon row, the two orderings are INVERTED. A cycle would need
 * `createHold()` to end up waiting for a booking row this sweep holds, and
 * it cannot, because **the sweep takes no gap locks and no next-key locks**:
 *
 *  - its UPDATE is a primary-key lookup, so InnoDB takes a single record
 *    lock on an existing row and locks no gap around it;
 *  - its candidate read is NON-LOCKING, so the ranged scan over
 *    `bookings_hold_expiry_idx` takes nothing at all.
 *
 * `createHold()` only ever INSERTS into `bookings`, and an insert can only
 * wait on another transaction's gap or next-key lock. There is none to wait
 * on, so the inverted order is harmless.
 *
 * **That is the invariant a future change would break.** Turning the
 * candidate read into a ranged `SELECT … FOR UPDATE` (the obvious-looking
 * "tighten the sweep" refactor) would take gap locks across that index,
 * `createHold()`'s insert would need an insert-intention lock inside one of
 * those gaps, and the inverted coupon/booking order would become a real
 * deadlock between a booking attempt and the cron. If the candidate read
 * ever has to lock, the sweep must take the coupon row FIRST, or not at all.
 * `capacity.ts` records the same measurement for `FOR SHARE` on the capacity
 * counts, and it is the same hazard.
 *
 * ## Idempotency, which is an owner condition
 *
 * A second run, a restart mid-tick or two overlapping ticks must not change
 * the outcome, and that covers the COUPON as well as the capacity (owner
 * Q7/Q8 — a hold reserves a coupon use, so expiry gives it back).
 *
 * Two mechanisms, and it is worth being precise about which does what:
 *
 *  1. **`status = 'pending_payment'`, re-checked by the UPDATE itself.** An
 *     expired booking is no longer pending payment, so the conditional
 *     UPDATE matches no row, `affectedRows` is 0, and nothing below it runs
 *     — no second audit row, no second coupon release. One transaction per
 *     booking, so the status change, the coupon release and the audit row
 *     commit together or not at all.
 *
 *     **MEASURED, and the reason that condition is load-bearing rather than
 *     belt-and-braces** (Task 11, mutation M3): mysql2 connects with
 *     `CLIENT_FOUND_ROWS`, so `affectedRows` counts rows MATCHED, not rows
 *     changed. Deleting the status condition and re-running the sweep
 *     therefore does NOT no-op on "the row already says expired" — the
 *     UPDATE matches, reports 1, and the sweep writes a second audit row
 *     and counts the expiry again. So the gate is worth exactly as much as
 *     the conditions it re-checks: every condition is repeated inside the
 *     UPDATE deliberately, and `expirable()` exists so the two copies
 *     cannot drift.
 *
 *  2. `releaseRedemption()` is idempotent by construction on its own DELETE's
 *     affected-row count, so `used_count` cannot be decremented twice for
 *     one hold even if something above it ever ran twice.
 *
 * ## One bad row must not stop the sweep
 *
 * Per-booking transactions keep COMMITTED work, but they do not give the
 * LOOP progress: before fix round 1 a single throw rejected the whole
 * `expireHolds` promise, the cron logged it, and the next minute started
 * again with the same oldest candidate (the read is ordered by lapse time).
 * A row persistently blocked by a long transaction would therefore burn
 * `innodb_lock_wait_timeout` and then abort every NEWER lapsed hold, every
 * minute, re-creating for all of them the exact bug this task exists to fix
 * — while looking healthy, because the cron kept running and kept logging.
 *
 * So each booking is attempted inside its own `try`: a failure is logged,
 * counted in `failed`, and the loop moves to the next row. `expireHolds`
 * itself now rejects only if one of the two reads it opens with fails — the
 * skipped-money count, then the candidate read — and those are the failures
 * that mean "there is nothing to make progress on", so there is nothing to
 * report but the error.
 *
 * ## Never a deletion
 *
 * Expiry is a STATUS CHANGE. Nothing here deletes a booking or a payment,
 * and nothing here marks anything paid — there is no path to. `audit_log`
 * gets one row per expiry, `actor_type` `system` (a cron is not a person and
 * not a gateway).
 */
import { and, asc, eq, gt, isNotNull, lte, sql } from 'drizzle-orm';
import { manilaCivilDate } from '@rg/shared';
import { getDb } from '../db/client';
import type { Database, Transaction } from '../db/client';
import { bookings } from '../db/schema';
import { writeAudit } from '../services/audit';
import { releaseRedemption } from '../services/coupons';

/** What one sweep did. */
export interface ExpireHoldsResult {
  /** Bookings this sweep moved to `expired`. */
  expired: number;
  /**
   * Lapsed holds left alone because they carry money but NOT the review
   * flag — the state `amount_paid_centavos = 0` exists to catch.
   *
   * Counted and logged rather than silently skipped (fix round 1): nothing
   * in the system produces this row today, so if one ever appears it is
   * either a new payment path that forgot to raise the review flag or data
   * edited by hand, and in both cases a guest's money is sitting on a
   * booking nobody is looking at. A guard that fires invisibly is a guard
   * nobody knows fired.
   *
   * Review-flagged holds are deliberately NOT counted here: they are the
   * expected, documented case and are already visible in the review queue.
   */
  skippedWithMoney: number;
  /**
   * Bookings whose own transaction threw. Logged, skipped, and retried on
   * the next tick — see "One bad row must not stop the sweep".
   */
  failed: number;
}

/**
 * The most bookings one tick will expire.
 *
 * The candidate read used to be unbounded, so the first sweep after an
 * outage was one giant batch (fix round 1). A cap turns a backlog into
 * successive ticks instead: 200 a minute is 12,000 an hour, far beyond any
 * plausible backlog for a day-tour operator, while keeping one tick's work —
 * and one tick's row locks — bounded.
 *
 * Exported so the test that proves the batching can assert against this
 * number rather than a copy of it.
 */
export const HOLD_SWEEP_BATCH_LIMIT = 200;

/** The booking facts one expiry needs. Read before the transaction opens. */
interface Candidate {
  id: number;
  ref: string;
  couponId: number | null;
  tourId: number;
  tourDate: Date;
  holdExpiresAt: Date | null;
}

/**
 * The five conditions that make a booking expirable, as of `now`.
 *
 * Used TWICE on purpose: once to find candidates (an indexed scan on
 * `bookings_hold_expiry_idx`, which is `(status, hold_expires_at)`), and
 * again inside the conditional UPDATE, which is the authoritative check —
 * the candidate list is only a pre-filter and may be stale by the time the
 * row lock is granted.
 *
 * `lte`, not `lt`: a hold is valid UNTIL `hold_expires_at`, and the two
 * other readers of that column agree — `lateMoneyReason()` treats
 * `hold_expires_at <= now` as lapsed, and `startPayment`'s payable check
 * requires `hold_expires_at > now`. Using `<` here would leave a one-second
 * window in which the gateway path calls a hold dead and the sweep calls it
 * live.
 */
function expirable(now: Date) {
  return and(
    eq(bookings.status, 'pending_payment'),
    // Strictly redundant next to `lte` (SQL's `<=` never matches NULL), and
    // kept because the schema gives the null its own meaning: "nothing left
    // to expire". Saying so in the query is cheaper than a reader deducing it.
    isNotNull(bookings.holdExpiresAt),
    lte(bookings.holdExpiresAt, now),
    // The rule that carries real money — see the module note.
    eq(bookings.paymentReviewRequired, false),
    // Defence in depth: never expire a booking with money against it.
    eq(bookings.amountPaidCentavos, 0),
  );
}

/**
 * Lapsed holds carrying money that the review flag is NOT covering.
 *
 * The flag is the rule; `amount_paid_centavos = 0` is the spare guard. This
 * counts what the spare guard caught, so it can be logged and asserted
 * instead of being an invisible difference in a WHERE clause.
 *
 * One indexed count on the same `(status, hold_expires_at)` range the
 * candidate read uses, so it costs one extra statement per tick.
 */
async function countLapsedHoldsCarryingMoney(db: Database, now: Date): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`COUNT(*)` })
    .from(bookings)
    .where(
      and(
        eq(bookings.status, 'pending_payment'),
        isNotNull(bookings.holdExpiresAt),
        lte(bookings.holdExpiresAt, now),
        eq(bookings.paymentReviewRequired, false),
        gt(bookings.amountPaidCentavos, 0),
      ),
    );
  if (!row) throw new Error('COUNT(*) returned no row');
  return Number(row.n);
}

/**
 * Expires ONE booking, or decides not to, in its own transaction.
 *
 * Returns whether it expired the booking, which is read off the UPDATE's
 * affected-row count rather than from the candidate read: between the two,
 * a webhook may have credited money, an admin may have cancelled, or
 * another sweep may have got there first.
 *
 * One transaction per booking, deliberately. A single transaction over the
 * whole batch would hold every booking row lock until the last one
 * committed — and one bad row would roll back the whole sweep, which is the
 * opposite of what a job that has to make progress every minute wants.
 */
async function expireOne(db: Database, booking: Candidate, now: Date): Promise<boolean> {
  return db.transaction(async (tx: Transaction) => {
    /*
     * THE gate, and the transaction's first statement. An `UPDATE … WHERE`
     * is answered from the latest committed row, so this re-decides under
     * the booking's exclusive row lock instead of trusting the candidate
     * read. Nothing below runs unless this matched exactly this row.
     *
     * MATCHED, not changed: mysql2 connects with `CLIENT_FOUND_ROWS`, so
     * `affectedRows` is the number of rows the WHERE found (see the module
     * note's measurement). That is why `expirable(now)` is repeated here
     * rather than relying on the row's new value differing from its old one.
     */
    const [result] = await tx
      .update(bookings)
      .set({ status: 'expired' })
      .where(and(eq(bookings.id, booking.id), expirable(now)));
    if (result.affectedRows === 0) return false;

    /*
     * Owner decision Q7/Q8: the hold reserved the coupon's use, so expiry
     * gives it back — otherwise ten abandoned checkouts spend a code
     * limited to ten uses. The coupon row is taken LAST, after the booking
     * row above, which is the global lock order (fleet → tour → coupon).
     *
     * `tx`, never `getDb()`: a second pooled connection taken while this
     * transaction holds one is how ten concurrent callers come to hold all
     * ten connections and each wait for an eleventh, on mysql2's unbounded,
     * untimed queue. `releaseRedemption` is idempotent on its own DELETE's
     * affected-row count, so `used_count` can never be decremented twice
     * for one hold.
     */
    if (booking.couponId !== null) {
      await releaseRedemption(tx, booking.couponId, booking.id);
    }

    await writeAudit(tx, {
      // A cron job is `system`: never `provider` (that means a gateway) and
      // never `user`. `actor_id` is null because a cron is not a row.
      actorType: 'system',
      actorId: null,
      action: 'booking.expired',
      entity: 'bookings',
      entityId: booking.id,
      /*
       * Enough for an admin to understand what happened, and identifiers
       * only — no name, email or phone (audit rows are read by every admin
       * and exported in reports).
       *
       * `couponId` says which coupon's use went back; it does NOT claim a
       * released count, because `releaseRedemption()` returns void and
       * counting the redemption row first would be a second read for a
       * number the function's own idempotency already guarantees.
       */
      data: {
        ref: booking.ref,
        previousStatus: 'pending_payment',
        reason: 'hold_expired',
        tourId: booking.tourId,
        // `manilaCivilDate`, the same conversion `bookingStatus` applies to
        // this column — never a raw `toISOString()`, which would name the
        // day before for any instant stored west of midnight in Manila.
        tourDate: manilaCivilDate(booking.tourDate),
        holdExpiresAt: booking.holdExpiresAt?.toISOString() ?? null,
        sweptAt: now.toISOString(),
        couponId: booking.couponId,
      },
    });

    return true;
  });
}

/**
 * Moves every lapsed, unpaid hold to `expired`, freeing its capacity and its
 * coupon use, and writes one `system` audit row per expiry.
 *
 * `now` is the only clock: nothing here calls `new Date()` for a decision,
 * so a test drives the sweep in milliseconds and the cron passes the real
 * instant. Resolves with how many bookings this sweep actually changed, so
 * two overlapping ticks each report only their own work.
 *
 * The candidate read runs on the pool, OUTSIDE any transaction, on purpose:
 * it is a pre-filter, every decision is re-made under the row lock in
 * `expireOne()`, and a long-lived snapshot over the whole table would hold
 * a connection for the length of the batch.
 */
export async function expireHolds(now: Date): Promise<ExpireHoldsResult> {
  const db = getDb();

  const skippedWithMoney = await countLapsedHoldsCarryingMoney(db, now);

  const candidates: Candidate[] = await db
    .select({
      id: bookings.id,
      ref: bookings.ref,
      couponId: bookings.couponId,
      tourId: bookings.tourId,
      tourDate: bookings.tourDate,
      holdExpiresAt: bookings.holdExpiresAt,
    })
    .from(bookings)
    .where(expirable(now))
    // Oldest lapse first, so a backlog is worked through in the order the
    // holds died rather than in whatever order the index happens to return.
    .orderBy(asc(bookings.holdExpiresAt), asc(bookings.id))
    .limit(HOLD_SWEEP_BATCH_LIMIT);

  let expired = 0;
  let failed = 0;
  for (const candidate of candidates) {
    /*
     * The loop's progress guarantee. One row that cannot be expired — a
     * lock-wait timeout against a long-running transaction, a deadlock, a
     * dropped connection mid-statement — must not take the rest of the
     * batch with it, because the rest of the batch is every NEWER lapsed
     * hold and they would all keep their capacity until the row healed.
     */
    try {
      if (await expireOne(db, candidate, now)) expired += 1;
    } catch (error) {
      failed += 1;
      console.error(
        `[jobs] expire-holds: booking ${candidate.ref} (id ${candidate.id}) could not be expired`,
        error,
      );
    }
  }

  if (skippedWithMoney > 0) {
    console.warn(
      `[jobs] expire-holds: ${skippedWithMoney} lapsed hold(s) carry money but are NOT ` +
        'flagged for review — a payment path raised money without raising the flag, ' +
        'or a row was edited by hand. Nobody is reviewing that money.',
    );
  }

  return { expired, skippedWithMoney, failed };
}
