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
 * The locks this takes, in order: the booking row (the UPDATE), then the
 * coupon's redemption row and the coupon row (`releaseRedemption`). The
 * global order is `fleet_date_slots` → `tour_date_slots` → **coupon row
 * last**, and the coupon is last here too.
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
 * ## Never a deletion
 *
 * Expiry is a STATUS CHANGE. Nothing here deletes a booking or a payment,
 * and nothing here marks anything paid — there is no path to. `audit_log`
 * gets one row per expiry, `actor_type` `system` (a cron is not a person and
 * not a gateway).
 */
import { and, asc, eq, isNotNull, lte } from 'drizzle-orm';
import { manilaCivilDate } from '@rg/shared';
import { getDb } from '../db/client';
import type { Database, Transaction } from '../db/client';
import { bookings } from '../db/schema';
import { writeAudit } from '../services/audit';
import { releaseRedemption } from '../services/coupons';

/** What one sweep did. `expired` counts rows this sweep actually changed. */
export interface ExpireHoldsResult {
  expired: number;
}

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
    .orderBy(asc(bookings.holdExpiresAt), asc(bookings.id));

  let expired = 0;
  for (const candidate of candidates) {
    if (await expireOne(db, candidate, now)) expired += 1;
  }
  return { expired };
}
