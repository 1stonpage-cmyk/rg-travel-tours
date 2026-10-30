/**
 * `createHold()` (Week 3 checkout plan, Task 5) — the one transaction that
 * turns a guest's checkout form into a held booking: capacity checked, price
 * recomputed from the database, coupon reserved, booking inserted with
 * `status = 'pending_payment'` and a 15-minute hold, add-on lines written,
 * redemption recorded, audit row written. Everything before this task was a
 * part; this assembles them.
 *
 * **Nothing here can mark a booking paid, and there is no path to.** The
 * status it writes is `pending_payment`, full stop — only a verified
 * PayMongo webhook or an admin approval moves it on (CLAUDE.md).
 *
 * **Nothing the browser sent can reach a stored amount.** The totals come
 * from `priceQuote()` over rows read inside this transaction. `input.quoteId`
 * is compared against a digest recomputed here, and is a change DETECTOR
 * only (owner decision Q3): a mismatch is refused, never honoured, and never
 * used as a price.
 *
 * ## The order of operations is the design, not an implementation detail
 *
 *  0. **Outside** the transaction: resolve `tourSlug` → `tourId` (Ruling 17).
 *     The slug lookup is a plain `SELECT`, and under REPEATABLE READ the
 *     first non-locking read of a transaction pins its consistent-read
 *     snapshot — so doing it inside would pin the snapshot BEFORE the locks
 *     were granted and the capacity check below would be answered from a
 *     moment before the race's winner committed. A read in an earlier,
 *     separate transaction cannot pin this one's snapshot, so it is safe
 *     here and nowhere later.
 *  1. `takeSlotLocks()` — the transaction's FIRST statements, fleet then
 *     tour. See "THE PRECONDITION" in `services/capacity.ts`, whose hazard
 *     guard test proves that a plain read before the locks defeats them
 *     entirely.
 *  2. `assessCapacity()`.
 *  3. The two §5 step-1 guards nothing else owns (Ruling 15): the tour date
 *     is not already past **in Asia/Manila**, and is not in
 *     `tour_blocked_dates`.
 *  4. Recompute the quote from the database, recompute the digest with
 *     `quoteDigest()`, compare it to `input.quoteId` — then refuse an
 *     `amount_due_now` below the gateway's own minimum (BUG-110), still
 *     before any write.
 *  5. The hold caps (Ruling 5): at most two active unpaid holds per email
 *     AND per phone, counted **here, under the locks** — counted outside
 *     them, two concurrent submits both read "one active hold" and both win.
 *  6. The coupon: validate the rules **through `tx`** (Ruling 19 — see the
 *     call site; a second pooled connection taken while this transaction
 *     holds one can wedge the pool), then take its row `FOR UPDATE` —
 *     **LAST in the lock order, fleet → tour → coupon** — and re-check the
 *     usage cap under that lock. Taking the coupon lock any earlier lets two
 *     guests holding DIFFERENT tours with the SAME coupon deadlock.
 *  7. Insert the booking, its add-on lines, the redemption, the audit row.
 *
 * ## Deadlock retry
 *
 * The whole transaction runs inside a bounded retry on MySQL error 1213
 * (`ER_LOCK_DEADLOCK`): concurrent `INSERT … ON DUPLICATE KEY UPDATE` on a
 * not-yet-existing `fleet_date_slots` row can deadlock at three or more
 * concurrent bookings (measured in Task 4 — see the comment above that
 * statement in `services/capacity.ts`). The retry restarts the transaction
 * from `BEGIN`, never resumes mid-way: a deadlocked transaction has already
 * been rolled back by InnoDB, so every statement has to be re-issued, and
 * re-running from the top also re-reads capacity rather than trusting a
 * verdict from the dead attempt.
 *
 * ## Every read in the transaction goes through `tx`
 *
 * Not only for the snapshot's sake (`capacity.ts`'s precondition) but for
 * the POOL's: `getDb()` inside this transaction means a second connection
 * checked out while this one is held, and ten concurrent holds doing that
 * leave all ten connections held by transactions each waiting for an
 * eleventh, in a queue mysql2 leaves unbounded and untimed. Nothing
 * releases, nothing times out, and the process needs restarting. The only
 * pool read left is `resolveActiveTourId`, which runs BEFORE the transaction
 * opens and has released its connection by the time one is held.
 *
 * ## Why a refusal is a throw
 *
 * Every refusal here is a typed error, and every one of them rolls the
 * transaction back — so a refused hold writes NOTHING: no booking, no
 * add-on line, no audit row, no consumed coupon use. `assessCapacity()`
 * returns a verdict rather than throwing (its caller owns the guest-facing
 * copy); this is that caller, and it turns the verdict into
 * `CapacityRefusedError` so the rollback is automatic rather than something
 * the router has to remember.
 */
import { and, eq, inArray, or, sql } from 'drizzle-orm';
import {
  DATE_NOT_BOOKABLE,
  HOLD_MINUTES,
  PAYMONGO_MIN_CENTAVOS,
  bookableDateRange,
  isDateBookable,
  manilaCivilDate,
  priceSnapshotSchema,
  type BookableDateRange,
  type CreateHoldInput,
  type PayMode,
  type PriceSnapshot,
} from '@rg/shared';
import { SETTING_SCHEMAS } from '../content/settings-schema';
import { getDb, type Transaction } from '../db/client';
import { withDeadlockRetry } from '../db/deadlock';
import {
  bookingAddons,
  bookings,
  coupons,
  settings,
  tourAddons,
  tourBlockedDates,
  tourPriceTiers,
  tours,
} from '../db/schema';
import { writeAudit } from './audit';
import { insertBookingWithRef } from './booking-ref';
import { assessCapacity, takeSlotLocks, type CapacityRefusalReason } from './capacity';
import {
  CouponNotFoundError,
  CouponUsageLimitReachedError,
  normalizeCouponCode,
  recordRedemption,
  validateCoupon,
} from './coupons';
import {
  priceQuote,
  quoteDigest,
  type PriceQuoteResult,
  type QuoteAddon,
  type QuoteCoupon,
} from './pricing';

/** Ruling 5 / owner decision Q4: two active unpaid holds per email AND per phone. */
export const MAX_ACTIVE_HOLDS_PER_GUEST = 2;

/** What a successful hold hands back. The ref is the guest's half-credential. */
export interface HeldBooking {
  ref: string;
  bookingId: number;
  holdExpiresAt: Date;
}

/**
 * The fleet or the tour cannot take this booking. Carries
 * `assessCapacity()`'s reason unchanged, because "that day is fully booked"
 * and "we have no van big enough for twelve of you" are different sentences
 * to a guest.
 */
export class CapacityRefusedError extends Error {
  readonly reason: CapacityRefusalReason;

  constructor(reason: CapacityRefusalReason) {
    super(`Capacity refused: ${reason}`);
    this.name = 'CapacityRefusedError';
    this.reason = reason;
  }
}

/** The tour date is already past in Asia/Manila (§5 step 1). */
export class TourDatePastError extends Error {
  readonly date: string;
  readonly manilaToday: string;

  constructor(date: string, manilaToday: string) {
    super(`Tour date ${date} is before today (${manilaToday}) in Asia/Manila`);
    this.name = 'TourDatePastError';
    this.date = date;
    this.manilaToday = manilaToday;
  }
}

/** The tour is not running that day — `tour_blocked_dates` (§5 step 1). */
export class TourDateBlockedError extends Error {
  readonly date: string;

  constructor(date: string) {
    super(`The tour is not running on ${date}`);
    this.name = 'TourDateBlockedError';
    this.date = date;
  }
}

/**
 * The date is outside the bookable window — the `booking` settings block
 * (owner decision 2026-10-13, _proposed by developer, pending R&G_):
 * `minLeadDays`, `nextDayCutoffTime` and `maxAdvanceDays`.
 *
 * Distinct from `TourDatePastError` (which is the more specific "that day is
 * gone") and from every capacity reason: "we stopped taking bookings for
 * tomorrow at 18:00" is not "that day is fully booked", and a guest who is
 * told the wrong one of those will either give up or keep retrying. It
 * carries the window so the copy can say WHICH dates are open rather than
 * only refusing.
 */
export class TourDateNotBookableError extends Error {
  /** The router's refusal vocabulary — separate from the capacity reasons. */
  readonly reason = DATE_NOT_BOOKABLE;
  readonly date: string;
  readonly earliest: string;
  readonly latest: string;

  constructor(date: string, range: BookableDateRange) {
    super(`Tour date ${date} is outside the bookable window ${range.earliest}..${range.latest}`);
    this.name = 'TourDateNotBookableError';
    this.date = date;
    this.earliest = range.earliest;
    this.latest = range.latest;
  }
}

/**
 * Owner decision Q3's "the price changed" path. The quote id the client
 * echoed back no longer matches a digest recomputed from the database, so
 * the price the guest was shown is not the price on offer. Refused rather
 * than silently repriced: a guest must never be charged a number they were
 * not shown.
 */
export class PriceChangedError extends Error {
  constructor() {
    super('The price changed since this quote was issued');
    this.name = 'PriceChangedError';
  }
}

/**
 * BUG-110 / owner decision 2026-10-23 (Q10): the amount an online payment
 * would be for is below the gateway's own minimum, so no gateway would take
 * it. Refused HERE, before anything is written, rather than at the gateway
 * call — a hold that cannot be paid has already taken a slot, and the guest
 * meets a provider error page instead of a sentence they can act on.
 *
 * The charge is `amount_due_now` for the mode the guest chose: the whole
 * total for `full`, the deposit for `deposit`. Both are carried so a log or a
 * future report can say which one was short, and the router's guest-facing
 * copy (`gatewayMinimumMessage()` in `@rg/shared`) names neither — it offers
 * the ways round it instead.
 *
 * `totalCentavos` is carried for that copy and for nothing else: it is what
 * decides WHICH way round exists (fix round 1). A short deposit on a total
 * that clears the floor can be paid in full; a total under the floor cannot,
 * and a total of nothing cannot be paid at all. Keeping the number on the
 * error means the router chooses the sentence from the recomputed total rather
 * than re-deriving money of its own.
 */
export class GatewayMinimumNotMetError extends Error {
  readonly amountDueNowCentavos: number;
  readonly minimumCentavos = PAYMONGO_MIN_CENTAVOS;
  readonly payMode: PayMode;
  readonly totalCentavos: number;

  constructor(amountDueNowCentavos: number, payMode: PayMode, totalCentavos: number) {
    super(
      `The ${payMode} charge of ${amountDueNowCentavos} centavos is below the ` +
        `gateway minimum of ${PAYMONGO_MIN_CENTAVOS} centavos ` +
        `(booking total ${totalCentavos} centavos)`,
    );
    this.name = 'GatewayMinimumNotMetError';
    this.amountDueNowCentavos = amountDueNowCentavos;
    this.payMode = payMode;
    this.totalCentavos = totalCentavos;
  }
}

/**
 * Ruling 5: this guest already holds {@link MAX_ACTIVE_HOLDS_PER_GUEST}
 * unpaid slots. `scope` says which identifier hit the cap, because the two
 * are checked separately (AND, not OR).
 */
export class HoldLimitReachedError extends Error {
  readonly scope: 'email' | 'phone';
  readonly limit: number;

  constructor(scope: 'email' | 'phone') {
    super(`This ${scope} already holds ${MAX_ACTIVE_HOLDS_PER_GUEST} unpaid bookings`);
    this.name = 'HoldLimitReachedError';
    this.scope = scope;
    this.limit = MAX_ACTIVE_HOLDS_PER_GUEST;
  }
}

/**
 * The booking lost `MAX_DEADLOCK_ATTEMPTS` (`db/deadlock.ts`) deadlocks in a row — the
 * day is being hammered, and the honest answer to the guest is "try again",
 * not a 500.
 *
 * Typed, like every other refusal here, so the router (next task) has one
 * vocabulary instead of a `catch` that sniffs Drizzle's "Failed query" by
 * string. The killed transaction is kept as `cause`, so the log still names
 * the MySQL error.
 */
export class HoldContentionError extends Error {
  readonly attempts: number;

  constructor(attempts: number, cause: unknown) {
    super(`Could not hold this slot after ${attempts} attempts — the date is busy`, { cause });
    this.name = 'HoldContentionError';
    this.attempts = attempts;
  }
}

/**
 * `reserveCouponUnderLock`'s refusal, as distinct from `validateCoupon`'s.
 *
 * Both mean "this coupon is spent", and the router treats them alike — hence
 * the subclass rather than a separate error, so `instanceof
 * CouponUsageLimitReachedError` still catches both. The marker exists
 * because the difference is invisible from the message and the two are NOT
 * equivalent evidence: only this one proves the refusal came from the
 * authoritative re-read under `SELECT … FOR UPDATE`. The concurrency test
 * asserts this class, so a run where the two guests failed to overlap — and
 * the loser was refused by the early read instead — fails loudly rather than
 * passing vacuously.
 */
export class CouponExhaustedUnderLockError extends CouponUsageLimitReachedError {
  readonly underLock = true as const;

  constructor(code: string, usageLimit: number) {
    super(code, usageLimit);
    this.name = 'CouponExhaustedUnderLockError';
  }
}

// ---------------------------------------------------------------------------
// The 1213 retry
// ---------------------------------------------------------------------------

/*
 * `isDeadlockError` and `withDeadlockRetry` moved to `db/deadlock.ts` when
 * `services/dispatch/assign.ts` became their second caller (Task 10 review,
 * F5). Behaviour is unchanged — the two retry tests in
 * `create-hold.test.ts` pin it — and the typed give-up below stays here,
 * because `HoldContentionError` is this module's vocabulary and not the
 * retry's.
 */

/** Gives up in THIS module's vocabulary after the shared retry is exhausted. */
function holdContention(tries: number, error: unknown): never {
  throw new HoldContentionError(tries, error);
}

// ---------------------------------------------------------------------------
// The pieces, in the order the transaction runs them
// ---------------------------------------------------------------------------

/**
 * Ruling 17: the slug → id lookup, done BEFORE the transaction opens.
 *
 * It is also §5 step 1's "the tour is active" check. Fails closed: a slug
 * that names nothing, or a tour switched off, is `tour_unavailable` — the
 * same reason `assessCapacity` returns for it, so the router has one
 * vocabulary rather than two.
 */
async function resolveActiveTourId(slug: string): Promise<number> {
  const [tour] = await getDb()
    .select({ id: tours.id })
    .from(tours)
    .where(and(eq(tours.slug, slug), eq(tours.isActive, true)))
    .limit(1);
  if (!tour) throw new CapacityRefusedError('tour_unavailable');
  return tour.id;
}

/**
 * §5 step 1, first half. A tour date is a CIVIL date in Asia/Manila, so
 * "today" comes from the Manila calendar and the comparison is a string
 * compare between two `YYYY-MM-DD` values — never a `Date` subtraction.
 * At 00:30 in Cebu it is still yesterday in UTC, and a UTC "today" would
 * sell a seat on a trip that has already left.
 */
function assertDateNotPast(date: string, now: Date): void {
  const today = manilaCivilDate(now);
  if (date < today) throw new TourDatePastError(date, today);
}

/**
 * ONE settings block, read through the caller's transaction.
 *
 * Not `readSettingBlock()` from content/settings.ts: that one reads through
 * `getDb()`, i.e. a second pooled connection, which inside this transaction
 * is both a read outside the locks and — as `df8b38d` had to fix — a second
 * connection taken while the first is held. Every read in this module goes
 * through `tx`.
 *
 * Names the key and never the stored value, exactly as `readSettingBlock`
 * does: a settings value can contain anything an admin typed.
 */
async function readSettingBlockTx<K extends keyof typeof SETTING_SCHEMAS>(
  tx: Transaction,
  key: K,
): Promise<ReturnType<(typeof SETTING_SCHEMAS)[K]['parse']>> {
  const [row] = await tx
    .select({ value: settings.value })
    .from(settings)
    .where(eq(settings.key, key))
    .limit(1);
  if (!row) throw new Error(`Missing setting: "${key}"`);
  const parsed = SETTING_SCHEMAS[key].safeParse(row.value);
  if (!parsed.success) throw new Error(`Invalid setting: "${key}"`);
  return parsed.data as ReturnType<(typeof SETTING_SCHEMAS)[K]['parse']>;
}

/**
 * The bookable window (owner decision 2026-10-13, pending R&G). Read from
 * settings INSIDE the transaction and AFTER the locks — a settings read
 * before them would pin the REPEATABLE READ snapshot and silently defeat
 * every capacity count that follows (`services/capacity.ts`, THE
 * PRECONDITION).
 *
 * The window itself is computed by `bookableDateRange()` in @rg/shared — the
 * same function `checkout.availability` answers from, so the advisory answer
 * and this authoritative one cannot disagree. **This is the only enforcement
 * point**: `checkout.quote` does not check the window, so a guest can hold a
 * valid `quoteId` for a date that is refused here. A missing or malformed
 * `booking` block THROWS rather than defaulting to an open window: an
 * unreadable policy must refuse bookings, not wave them through.
 */
async function assertDateBookable(tx: Transaction, date: string, now: Date): Promise<void> {
  const range = bookableDateRange(await readSettingBlockTx(tx, 'booking'), now);
  if (!isDateBookable(date, range)) throw new TourDateNotBookableError(date, range);
}

/**
 * §5 step 1, second half. `tour_blocked_dates` is unique on
 * `(tour_id, date)`; this is its first consumer.
 *
 * The date is compared as a STRING through raw SQL, the same way
 * `capacity.ts` does: Drizzle maps a `date` column to a `Date`, and a `Date`
 * is exactly the midnight-shift hazard a civil date must avoid.
 */
async function assertDateNotBlocked(tx: Transaction, tourId: number, date: string): Promise<void> {
  const [blocked] = await tx
    .select({ id: tourBlockedDates.id })
    .from(tourBlockedDates)
    .where(and(eq(tourBlockedDates.tourId, tourId), sql`${tourBlockedDates.date} = ${date}`))
    .limit(1);
  if (blocked) throw new TourDateBlockedError(date);
}

/** What the recompute needs, all of it read through `tx`, under the locks. */
interface RecomputeInputs {
  tiers: Array<{
    id: number;
    minPax: number;
    maxPax: number;
    pricePerPersonCentavos: number;
  }>;
  addons: QuoteAddon[];
  coupon: QuoteCoupon | null;
  depositPercent: number;
  freeCancelHours: number | null;
}

/**
 * Everything `priceQuote()` needs, read **through the transaction handle**
 * and keyed by `tourId`.
 *
 * Deliberately not `pricing.ts`'s `loadQuoteInputs()`, for two reasons that
 * are both about this transaction: that function is keyed by SLUG (Ruling 17
 * resolved the slug before the transaction opened) and it reads through
 * `getDb()` — the pool — which would be several connections checked out
 * while this one holds three row locks (the pool-starvation hazard the note
 * at the top of this file spells out), and a price read outside the locks
 * that protect it. The queries below are the same queries; the handle is not.
 *
 * Only ACTIVE add-ons belonging to THIS tour count, and an id for another
 * tour or a retired add-on is ignored rather than rejected — the same
 * fail-soft `loadQuoteInputs` documents, and necessarily identical, because
 * any divergence shows up as a digest mismatch rather than as a wrong price.
 *
 * The deposit percent comes from the `trust` settings block, parsed through
 * the one shared schema (`SETTING_SCHEMAS`) so the validation is not
 * restated here.
 */
async function loadRecomputeInputs(
  tx: Transaction,
  tourId: number,
  addonIds: number[],
  couponCode: string | undefined,
): Promise<RecomputeInputs> {
  const [tour] = await tx
    .select({ freeCancelHours: tours.freeCancelHours })
    .from(tours)
    .where(eq(tours.id, tourId))
    .limit(1);
  if (!tour) throw new CapacityRefusedError('tour_unavailable');

  const tiers = await tx
    .select({
      id: tourPriceTiers.id,
      minPax: tourPriceTiers.minPax,
      maxPax: tourPriceTiers.maxPax,
      pricePerPersonCentavos: tourPriceTiers.pricePerPersonCentavos,
    })
    .from(tourPriceTiers)
    .where(eq(tourPriceTiers.tourId, tourId));

  const addons =
    addonIds.length === 0
      ? []
      : await tx
          .select({
            id: tourAddons.id,
            name: tourAddons.name,
            priceCentavos: tourAddons.priceCentavos,
            perPerson: tourAddons.perPerson,
          })
          .from(tourAddons)
          .where(
            and(
              eq(tourAddons.tourId, tourId),
              eq(tourAddons.isActive, true),
              inArray(tourAddons.id, addonIds),
            ),
          );

  const trust = await readSettingBlockTx(tx, 'trust');

  return {
    tiers,
    addons,
    coupon: couponCode ? await loadCoupon(tx, couponCode) : null,
    depositPercent: trust.depositPercent,
    freeCancelHours: tour.freeCancelHours,
  };
}

/**
 * The coupon as `priceQuote()` consumes it: by normalised code, active only.
 *
 * This is identity and discount, NOT the rules — the window, the usage cap
 * and the minimum spend are `validateCoupon()`'s, checked after the digest
 * comparison, in the mandated order. A code that names no active coupon
 * returns null here and `validateCoupon` is what refuses it, so a requested
 * code is never silently dropped from the price.
 */
async function loadCoupon(tx: Transaction, code: string): Promise<QuoteCoupon | null> {
  const [row] = await tx
    .select({
      id: coupons.id,
      code: coupons.code,
      discountType: coupons.discountType,
      percentBp: coupons.percentBp,
      amountCentavos: coupons.amountCentavos,
    })
    .from(coupons)
    .where(and(eq(coupons.code, normalizeCouponCode(code)), eq(coupons.isActive, true)))
    .limit(1);
  if (!row) return null;

  return row.discountType === 'percent'
    ? {
        id: row.id,
        code: row.code,
        discountType: 'percent',
        percentBp: row.percentBp!,
        amountCentavos: null,
      }
    : {
        id: row.id,
        code: row.code,
        discountType: 'fixed',
        percentBp: null,
        amountCentavos: row.amountCentavos!,
      };
}

/**
 * Ruling 5 / owner decision Q4: at most {@link MAX_ACTIVE_HOLDS_PER_GUEST}
 * active unpaid holds per email **AND** per phone — two separate caps, not
 * one on either identifier, or a guest takes four slots by pairing one email
 * with two phone numbers.
 *
 * "Active unpaid" is `status = 'pending_payment'`: the one status that both
 * holds capacity (it is in `CAPACITY_HOLDING_STATUSES`) and means no money
 * has been confirmed. `hold_expires_at` is deliberately NOT part of the
 * condition — a lapsed hold the expiry sweep has not reached yet is still
 * holding a van, so it still counts. That errs toward refusing a third hold
 * for up to a minute, which is the safe direction; the other way round sells
 * capacity twice.
 *
 * Counted through `tx`, after the locks, for the reason the whole module is
 * ordered: on a pooled connection, or before the locks, two concurrent
 * submits both read "one active hold" and both pass.
 *
 * **Residual — PARKED by Ruling 21, do not "fix" it in passing:** the locks
 * only serialise holds for the same tour and DATE. Two submits by the same guest for
 * different dates contend for nothing, so a determined guest can still land
 * a third hold by racing two different dates. Closing that needs a
 * guest-level lock row (or `GET_LOCK`), i.e. a fourth lock in a lock order
 * only the owner can change — and the damage is bounded to one extra
 * 15-minute hold that expires on its own, with the per-IP limiter covering
 * the scripted case. Surfaced to the owner; not built here.
 */
async function assertUnderHoldCaps(tx: Transaction, email: string, phone: string): Promise<void> {
  const [counts] = await tx
    .select({
      byEmail: sql<number>`SUM(${bookings.leadEmail} = ${email})`,
      byPhone: sql<number>`SUM(${bookings.leadPhone} = ${phone})`,
    })
    .from(bookings)
    .where(
      and(
        eq(bookings.status, 'pending_payment'),
        or(eq(bookings.leadEmail, email), eq(bookings.leadPhone, phone)),
      ),
    );

  // `SUM()` over no rows is NULL, and mysql2 returns it as a string when it
  // is not: both go through Number() with an explicit zero default.
  if (Number(counts?.byEmail ?? 0) >= MAX_ACTIVE_HOLDS_PER_GUEST) {
    throw new HoldLimitReachedError('email');
  }
  if (Number(counts?.byPhone ?? 0) >= MAX_ACTIVE_HOLDS_PER_GUEST) {
    throw new HoldLimitReachedError('phone');
  }
}

/**
 * Takes the coupon row `FOR UPDATE` and re-checks the usage cap under that
 * lock — the authoritative check that `validateCoupon()`'s own is only an
 * early, friendly preview of. That earlier read is answered from this
 * transaction's consistent-read snapshot, so two guests can both see "one
 * use left"; a locking read always sees the latest committed row.
 *
 * **THIRD and LAST in the lock order: fleet → tour → coupon.** Taking it any
 * earlier would let two guests holding different tours with the same coupon
 * each hold one lock the other needs.
 *
 * `used_count` is read with the same `FOR UPDATE` that takes the lock, so
 * there is no window between locking the row and reading it. The refusal is
 * {@link CouponExhaustedUnderLockError} — a subclass, so callers still see a
 * usage-limit refusal, and tests can tell the two checks apart.
 *
 * Takes the whole coupon rather than its id so a refusal can name the CODE
 * the guest typed: a message built from the internal id would read `Coupon
 * "37" has reached its usage limit`, which is both the wrong vocabulary for
 * a guest and an internal identifier in guest-facing copy.
 */
async function reserveCouponUnderLock(tx: Transaction, coupon: QuoteCoupon): Promise<void> {
  const [rows] = (await tx.execute(
    sql`SELECT usage_limit, used_count FROM coupons WHERE id = ${coupon.id} FOR UPDATE`,
  )) as unknown as [Array<{ usage_limit: number | null; used_count: number }>, unknown];
  const row = rows[0];
  /*
   * Fail closed. The row was there when the quote was recomputed moments
   * ago, so its disappearance is a concurrent delete — and an admin deleting
   * a coupon mid-checkout is "that code is gone", not "that code is spent".
   * Either way the hold is refused rather than booked with an unpriced
   * discount.
   */
  if (!row) throw new CouponNotFoundError(coupon.code);

  const usageLimit = row.usage_limit === null ? null : Number(row.usage_limit);
  if (usageLimit !== null && Number(row.used_count) >= usageLimit) {
    throw new CouponExhaustedUnderLockError(coupon.code, usageLimit);
  }
}

// ---------------------------------------------------------------------------
// createHold
// ---------------------------------------------------------------------------

/**
 * Holds a slot for a guest: one transaction, `pending_payment`, 15 minutes.
 *
 * `now` is a parameter (defaulted) rather than a `new Date()` inside, the
 * same discipline `validateCoupon()` uses: the hold's expiry and the Manila
 * past-date guard are then exactly assertable, and the near-midnight case is
 * testable at all. Production callers leave it out.
 *
 * @throws CapacityRefusedError  the tour or the fleet cannot take it
 * @throws TourDatePastError     the tour date is past in Asia/Manila
 * @throws TourDateBlockedError  the tour is not running that day
 * @throws PriceChangedError     the quote id no longer matches (Q3)
 * @throws GatewayMinimumNotMetError the online charge is under ₱100 (BUG-110)
 * @throws HoldLimitReachedError this guest already holds two unpaid slots
 * @throws Error                 any coupon rule, from `validateCoupon()`
 */
export async function createHold(
  input: CreateHoldInput,
  now: Date = new Date(),
): Promise<HeldBooking> {
  // Ruling 17 — OUTSIDE the transaction. See step 0 in the module note.
  const tourId = await resolveActiveTourId(input.tourSlug);

  return withDeadlockRetry(
    () =>
      getDb().transaction(async (tx) => {
        // 1. The locks, FIRST — before any consistent read. This is the
        //    precondition `services/capacity.ts` documents and its hazard
        //    guard test pins.
        await takeSlotLocks(tx, tourId, input.date);

        /*
         * 2. §5 step 1's date guards (Ruling 15) — BEFORE capacity, and the
         *    order inside them is most-specific-first, so a guest always gets
         *    the sharpest true sentence: "that date has passed", then "the tour
         *    is not running that day", then "we are not taking bookings for
         *    that date".
         *
         *    **Why the whole group goes before capacity.** Both are true for a
         *    guest who picks today on a tour that is also sold out, and only
         *    one of the two sentences is useful: told "fully booked", they
         *    abandon a tour that has seats on every other day; told "we're not
         *    taking bookings for that date, pick one between X and Y", they
         *    pick another day. `checkout.availability` answers in this same
         *    order for the same reason, and that agreement is the point —
         *    before this, the two surfaces gave different reasons for the same
         *    request.
         *
         *    This now contains the transaction's FIRST non-locking read (the
         *    `booking` settings block, and the blocked-dates lookup before it),
         *    which is what pins the REPEATABLE READ snapshot. That is still
         *    safe, and for the only reason that matters: it is after
         *    `takeSlotLocks()`. The loser of a race is granted the fleet row
         *    only once the winner has committed, so its snapshot — pinned here,
         *    after that grant — already contains the winner's booking, and the
         *    capacity counts below read it. See THE PRECONDITION in
         *    `services/capacity.ts`: the rule is "locks before any consistent
         *    read", never "capacity must read first".
         */
        assertDateNotPast(input.date, now);
        await assertDateNotBlocked(tx, tourId, input.date);
        await assertDateBookable(tx, input.date, now);

        // 3. Capacity.
        const verdict = await assessCapacity(tx, tourId, input.date, input.pax);
        if (!verdict.ok) throw new CapacityRefusedError(verdict.reason);

        // 4. The money — recomputed from the database, then the digest
        //    compared. The client's `quoteId` is a change detector and never
        //    an amount.
        const inputs = await loadRecomputeInputs(tx, tourId, input.addonIds, input.couponCode);
        const quote = priceQuote({ ...inputs, pax: input.pax });
        const digest = quoteDigest({
          tourId,
          date: input.date,
          pax: input.pax,
          addonIds: input.addonIds,
          couponCode: input.couponCode,
          totalCentavos: quote.totalCentavos,
        });
        if (digest !== input.quoteId) throw new PriceChangedError();

        /*
         * 4b. The gateway floor (BUG-110, owner decision 2026-10-23 Q10).
         *     The figure checked is the one a gateway would actually be asked
         *     to charge — `amount_due_now` for the mode the guest chose, off
         *     the recompute above and never off the request. It is taken here,
         *     with the rest of the money step and BEFORE any write, so a
         *     refusal leaves no booking, no slot and nothing for the expiry
         *     sweep: a hold that can never be paid is worse than no hold.
         *     `startPayment` repeats it defensively for the booking this
         *     check never saw.
         */
        const amountDueNowCentavos = quote.amountDueNowCentavos[input.payMode];
        if (amountDueNowCentavos < PAYMONGO_MIN_CENTAVOS) {
          throw new GatewayMinimumNotMetError(
            amountDueNowCentavos,
            input.payMode,
            quote.totalCentavos,
          );
        }

        // 5. The hold caps, under the locks.
        await assertUnderHoldCaps(tx, input.lead.email, input.lead.phone);

        // 6. The coupon: rules first, then its row locked LAST and the usage
        //    cap re-checked under that lock.
        if (input.couponCode) {
          /*
           * `tx`, NOT the pool (Ruling 19, fix round 1). This transaction is
           * already holding one of the pool's ten connections; a second
           * connection checked out here would, at ten concurrent
           * coupon-bearing holds, leave all ten held by transactions each
           * waiting for an eleventh — and mysql2's connection queue is
           * unbounded and untimed, so nothing releases and nothing times out.
           * A transaction queueing for a connection is also one still holding
           * the fleet, tour and coupon locks, which turns a competitor's wait
           * into the 1205 this module deliberately does not retry.
           */
          await validateCoupon(input.couponCode, quote.subtotalCentavos, now, tx);
          // `inputs.coupon` is what the money above was actually computed
          // from, and — both reads now going through `tx`, i.e. one snapshot —
          // it is the same row version `validateCoupon` just approved. The
          // guard stays as fail-closed defence, not as a live branch.
          if (!inputs.coupon) throw new PriceChangedError();
          await reserveCouponUnderLock(tx, inputs.coupon);
        }

        // 7. The writes.
        const holdExpiresAt = new Date(now.getTime() + HOLD_MINUTES * 60_000);
        const snapshot = buildSnapshot(inputs, quote, input.pax);

        const { id: bookingId, ref } = await insertBookingWithRef(tx, {
          tourId,
          // UTC midnight of the civil date: the pool runs at `timezone: 'Z'`,
          // so this stores the day the guest picked, in Cebu, exactly.
          tourDate: new Date(`${input.date}T00:00:00Z`),
          pax: input.pax,
          leadName: input.lead.name,
          leadEmail: input.lead.email,
          leadPhone: input.lead.phone,
          pickup: input.pickup ?? null,
          pickupMapUrl: input.pickupMapUrl ?? null,
          requests: input.requests ?? null,
          status: 'pending_payment',
          payMode: input.payMode,
          priceSnapshot: snapshot,
          subtotalCentavos: quote.subtotalCentavos,
          discountCentavos: quote.discountCentavos,
          totalCentavos: quote.totalCentavos,
          couponId: inputs.coupon?.id ?? null,
          holdExpiresAt,
          createdAt: now,
          updatedAt: now,
        });

        if (snapshot.addons.length > 0) {
          await tx.insert(bookingAddons).values(
            snapshot.addons.map((addon) => ({
              bookingId,
              addonId: addon.addonId,
              name: addon.name,
              priceCentavos: addon.priceCentavos,
              perPerson: addon.perPerson,
              qty: addon.qty,
            })),
          );
        }

        // Owner decision Q7/Q8: an active hold reserves the coupon's use, not
        // just the capacity. The duplicate-key error `recordRedemption` can
        // raise is deliberately NOT caught — it must propagate so this
        // transaction rolls back rather than double-counting a coupon. The
        // guest loses the hold; the coupon's count stays honest.
        if (inputs.coupon) await recordRedemption(tx, inputs.coupon.id, bookingId);

        await writeAudit(tx, {
          // A guest, not staff and not a cron: `customer`. `actor_id` is null
          // because a guest is not a row in any table — the portal identifies
          // them by ref + email, and the booking this row points at IS the
          // identification.
          actorType: 'customer',
          actorId: null,
          action: 'booking.held',
          entity: 'bookings',
          entityId: bookingId,
          // Identifiers and amounts only. No name, email or phone: audit rows
          // are read by every admin and exported in reports.
          data: {
            ref,
            tourId,
            tourDate: input.date,
            pax: input.pax,
            payMode: input.payMode,
            totalCentavos: quote.totalCentavos,
            couponId: inputs.coupon?.id ?? null,
            holdExpiresAt: holdExpiresAt.toISOString(),
          },
        });

        return { ref, bookingId, holdExpiresAt };
      }),
    { onExhausted: holdContention },
  );
}

/**
 * The frozen copy of everything the price AND the refund rights depend on
 * (owner decision Q5) — `priceSnapshotSchema`'s shape, populated, never
 * redesigned. Parsed through the schema before it is stored: a snapshot that
 * cannot answer "may this guest cancel free?" must fail here, not months
 * later when someone tries to answer it.
 *
 * `qty` is the head count for a per-person add-on and 1 for a per-booking
 * one, so `price_centavos * qty` is the line's own contribution to the
 * subtotal and an invoice line reconciles without re-deriving `pax`. The
 * checkout input carries add-on IDS and no quantities, so `qty` is
 * bookkeeping either way — this is the arithmetic-preserving choice.
 */
function buildSnapshot(
  inputs: RecomputeInputs,
  quote: PriceQuoteResult,
  pax: number,
): PriceSnapshot {
  return priceSnapshotSchema.parse({
    tier: {
      tierId: quote.tier.id,
      minPax: quote.tier.minPax,
      maxPax: quote.tier.maxPax,
      pricePerPersonCentavos: quote.tier.pricePerPersonCentavos,
    },
    addons: inputs.addons.map((addon) => ({
      addonId: addon.id,
      name: addon.name,
      priceCentavos: addon.priceCentavos,
      perPerson: addon.perPerson,
      qty: addon.perPerson ? pax : 1,
    })),
    coupon: inputs.coupon
      ? {
          id: inputs.coupon.id,
          code: inputs.coupon.code,
          discount:
            inputs.coupon.discountType === 'percent'
              ? {
                  discountType: 'percent',
                  percentBp: inputs.coupon.percentBp,
                  amountCentavos: null,
                }
              : {
                  discountType: 'fixed',
                  percentBp: null,
                  amountCentavos: inputs.coupon.amountCentavos,
                },
        }
      : null,
    depositPercent: inputs.depositPercent,
    freeCancelHours: inputs.freeCancelHours,
    subtotalCentavos: quote.subtotalCentavos,
    discountCentavos: quote.discountCentavos,
    totalCentavos: quote.totalCentavos,
  } satisfies PriceSnapshot);
}
