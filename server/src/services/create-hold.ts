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
 *     `quoteDigest()`, compare it to `input.quoteId`.
 *  5. The hold caps (Ruling 5): at most two active unpaid holds per email
 *     AND per phone, counted **here, under the locks** — counted outside
 *     them, two concurrent submits both read "one active hold" and both win.
 *  6. The coupon: validate the rules, then take its row `FOR UPDATE` —
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
  HOLD_MINUTES,
  manilaParts,
  priceSnapshotSchema,
  type CreateHoldInput,
  type PriceSnapshot,
} from '@rg/shared';
import { SETTING_SCHEMAS } from '../content/settings-schema';
import { getDb, type Transaction } from '../db/client';
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

// ---------------------------------------------------------------------------
// The 1213 retry
// ---------------------------------------------------------------------------

/** Attempts at the WHOLE transaction before a deadlock is reported as one. */
const MAX_DEADLOCK_ATTEMPTS = 3;

/** See `booking-ref.ts`'s twin: Drizzle moves the mysql2 error onto `.cause`. */
const MAX_CAUSE_DEPTH = 5;

/**
 * True for MySQL's `ER_LOCK_DEADLOCK` (1213) anywhere in the first
 * {@link MAX_CAUSE_DEPTH} links of `err`'s cause chain.
 *
 * Both the numeric `errno` and the string `code` are accepted: mysql2 sets
 * both, and matching on either means a driver that stops decorating one of
 * them does not silently turn the retry off.
 *
 * It must stay NARROW. A lock-wait timeout (1205) is deliberately NOT
 * retried: it means some other transaction is holding a lock for a long
 * time, and re-running a 50-second wait helps nobody.
 */
function isDeadlockError(err: unknown): boolean {
  let current: unknown = err;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH && current != null; depth += 1) {
    if (typeof current !== 'object') break;
    const candidate = current as { errno?: unknown; code?: unknown; cause?: unknown };
    if (candidate.errno === 1213 || candidate.code === 'ER_LOCK_DEADLOCK') return true;
    current = candidate.cause;
  }
  return false;
}

/**
 * Runs `attempt` again from the beginning if InnoDB killed it as a deadlock
 * victim. `attempt` must be the WHOLE transaction — a deadlocked transaction
 * is already rolled back, so there is nothing to resume.
 */
async function withDeadlockRetry<T>(attempt: () => Promise<T>): Promise<T> {
  for (let tries = 1; ; tries += 1) {
    try {
      return await attempt();
    } catch (error) {
      if (tries >= MAX_DEADLOCK_ATTEMPTS || !isDeadlockError(error)) throw error;
    }
  }
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

/** `YYYY-MM-DD` for `now` in Asia/Manila. */
function manilaCivilDate(now: Date): string {
  const { year, month, day } = manilaParts(now);
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
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
 * `getDb()` — the pool — which would be a second connection taken while this
 * one holds three row locks, and a price read outside the locks that
 * protect it. The queries below are the same queries; the handle is not.
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

  const [trustRow] = await tx
    .select({ value: settings.value })
    .from(settings)
    .where(eq(settings.key, 'trust'))
    .limit(1);
  if (!trustRow) throw new Error('Missing setting: "trust"');
  const trust = SETTING_SCHEMAS.trust.safeParse(trustRow.value);
  // Names the key, never the stored value — as `readSettingBlock` does.
  if (!trust.success) throw new Error('Invalid setting: "trust"');

  return {
    tiers,
    addons,
    coupon: couponCode ? await loadCoupon(tx, couponCode) : null,
    depositPercent: trust.data.depositPercent,
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
 * **Residual, and deliberately not fixed here:** the locks only serialise
 * holds for the same tour and DATE. Two submits by the same guest for
 * different dates contend for nothing, so a determined guest can still land
 * a third hold by racing two different dates. Closing that needs a
 * guest-level lock row, which would add a fourth lock to a lock order this
 * task was given as fixed — so it is reported rather than invented.
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
 * lock — the authoritative check `validateCoupon()`'s own is only an early,
 * friendly preview of (it reads through the pool, unlocked, so two guests
 * can both see "one use left").
 *
 * **THIRD and LAST in the lock order: fleet → tour → coupon.** Taking it any
 * earlier would let two guests holding different tours with the same coupon
 * each hold one lock the other needs.
 *
 * `used_count` is read with the same `FOR UPDATE` that takes the lock, so
 * there is no window between locking the row and reading it.
 */
async function reserveCouponUnderLock(tx: Transaction, couponId: number): Promise<void> {
  const [rows] = (await tx.execute(
    sql`SELECT code, usage_limit, used_count FROM coupons WHERE id = ${couponId} FOR UPDATE`,
  )) as unknown as [
    Array<{ code: string; usage_limit: number | null; used_count: number }>,
    unknown,
  ];
  const row = rows[0];
  // Fail closed: the row was there a moment ago, so its disappearance is a
  // concurrent delete, not a reason to book an unpriced discount.
  if (!row) throw new CouponUsageLimitReachedError(String(couponId), 0);

  const usageLimit = row.usage_limit === null ? null : Number(row.usage_limit);
  if (usageLimit !== null && Number(row.used_count) >= usageLimit) {
    throw new CouponUsageLimitReachedError(row.code, usageLimit);
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
 * @throws HoldLimitReachedError this guest already holds two unpaid slots
 * @throws Error                 any coupon rule, from `validateCoupon()`
 */
export async function createHold(
  input: CreateHoldInput,
  now: Date = new Date(),
): Promise<HeldBooking> {
  // Ruling 17 — OUTSIDE the transaction. See step 0 in the module note.
  const tourId = await resolveActiveTourId(input.tourSlug);

  return withDeadlockRetry(() =>
    getDb().transaction(async (tx) => {
      // 1. The locks, FIRST — before any consistent read. This is the
      //    precondition `services/capacity.ts` documents and its hazard
      //    guard test pins.
      await takeSlotLocks(tx, tourId, input.date);

      // 2. Capacity.
      const verdict = await assessCapacity(tx, tourId, input.date, input.pax);
      if (!verdict.ok) throw new CapacityRefusedError(verdict.reason);

      // 3. §5 step 1's two date guards (Ruling 15).
      assertDateNotPast(input.date, now);
      await assertDateNotBlocked(tx, tourId, input.date);

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

      // 5. The hold caps, under the locks.
      await assertUnderHoldCaps(tx, input.lead.email, input.lead.phone);

      // 6. The coupon: rules first, then its row locked LAST and the usage
      //    cap re-checked under that lock.
      if (input.couponCode) {
        await validateCoupon(input.couponCode, quote.subtotalCentavos, now);
        // `inputs.coupon` is what the money above was actually computed
        // from, and it is the same row `validateCoupon` just approved.
        if (!inputs.coupon) throw new PriceChangedError();
        await reserveCouponUnderLock(tx, inputs.coupon.id);
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
