/**
 * `createTransferBooking()` (transfers-launch plan, Task T10; Architecture §1,
 * §2/§2a, §3, §6) — the ONE transaction that turns a transfer request into a
 * held booking: the fleet-date lock, the minimum-notice rule, the five capacity
 * conditions with the candidate's own window included, the price recomputed
 * server-side, the coupon reserved, and the `bookings` + `booking_transfer_details`
 * pair written at `status = 'pending_payment'`.
 *
 * **It is deliberately the ONLY writer of a transfer booking.** The guest
 * self-serve path (`checkout.createHoldTransfer`, Task T11) calls it with
 * `priceSource: { kind: 'catalog' }` and the staff-conversion path
 * (`admin.transferQuotes.convert`, Task T19) with
 * `{ kind: 'staff', priceCentavos, staffUserId }`. Everything else — the lock,
 * the notice rule, the capacity verdict, the frozen window, the audit row — is
 * identical for both, so nothing downstream (dispatch, payments, check-ins,
 * reports) ever needs to know which path created a booking.
 *
 * **Nothing here can mark a booking paid, and there is no path to.** The status
 * it writes is `pending_payment`, full stop, and `amount_paid_centavos` is never
 * touched — only a verified PayMongo webhook or an admin approval moves either
 * (CLAUDE.md).
 *
 * **Nothing the browser sent can reach a stored amount.** The subtotal comes
 * from `vehiclePriceForRouteAndType()` read inside this transaction; the one
 * exception is `priceSource.priceCentavos` on the STAFF branch, which
 * Architecture §3 names as the single legitimate staff-entered price and which
 * is validated here as whole, non-negative centavos before it is used. There is
 * no `quoteId` digest and no comparison against one, by T9's own documented
 * reasoning: this function re-derives the price itself, so there is nothing left
 * for a digest to protect.
 *
 * ## The order of operations is the design, not an implementation detail
 *
 *  0. **Outside** the transaction: the input-shape invariants
 *     ({@link assertBookableShape}), which are pure arithmetic over the input
 *     and need neither a connection nor a lock. Chief among them is
 *     `route_id` XOR `custom_route_description` — the cross-table invariant
 *     `db/schema.ts`'s `bookings_product_type_shape` CHECK explicitly delegates
 *     to "the ONE writer, `createTransferBooking()`", because a single-table
 *     MySQL CHECK cannot express it. Refusing before the transaction opens is
 *     what makes "a refusal writes nothing" true by construction rather than by
 *     rollback.
 *  1. `takeFleetDateLock(tx, date)` — the transaction's FIRST statements. A
 *     transfer has no `tour_date_slots` row, so it takes the fleet half of the
 *     lock protocol alone; the ORDER (`fleet_date_slots` → `tour_date_slots` →
 *     the booking row) is unchanged, a transfer simply has nothing to take in
 *     the middle. See "THE PRECONDITION" in `services/capacity.ts` and in
 *     `./capacity.ts`: a plain read before the lock pins this transaction's
 *     REPEATABLE READ snapshot and the capacity counts below are then answered
 *     from a moment before the race's winner committed — the lock is granted
 *     and changes nothing.
 *  2. The `transfer_operations` settings read, then the minimum-notice rule
 *     (owner answer 2). This is the transaction's first non-locking read, and
 *     it is safe for the one reason that matters: it is AFTER the lock, exactly
 *     as `createHold()`'s own `assertDateBookable` is.
 *  3. The catalog read (price, free-cancellation window and the route duration
 *     the capacity window needs), then {@link assessTransferCapacity} — which
 *     owns the cross-midnight refusal as its own first condition, so nothing
 *     here re-checks it.
 *  4. The money: the quote, then the gateway's ₱100 floor (and with it the ₱0
 *     refusal), still BEFORE any write — a hold that can never be paid has
 *     already taken a slot.
 *  5. The hold caps, counted here, under the lock.
 *  6. The coupon's row taken `FOR UPDATE` and its usage cap re-checked under
 *     that lock — **LAST in the lock order, `fleet → coupon`.**
 *  7. The writes: the booking, its transfer details, the redemption, the audit
 *     row.
 *
 * The coupon's RULES (`validateCoupon`) are checked earlier than the tour does
 * them, in step 4, and that is arithmetic rather than a choice: a transfer's
 * total depends on the discount, so the figure the gateway floor is checked
 * against does not exist until the coupon has been resolved. The LOCK is still
 * last, which is the part the lock order is about.
 *
 * ## Deadlock retry
 *
 * The whole transaction runs inside `withDeadlockRetry` on MySQL 1213, for the
 * identical reason `createHold()` does: concurrent `INSERT … ON DUPLICATE KEY
 * UPDATE` on a not-yet-existing `fleet_date_slots` row can deadlock at three or
 * more concurrent bookings for one date. The retry restarts from `BEGIN` — a
 * deadlocked transaction has already been rolled back by InnoDB — so capacity
 * is re-read rather than trusted from the dead attempt.
 *
 * ## Every read in the transaction goes through `tx`
 *
 * Not only for the snapshot's sake but for the POOL's: `getDb()` inside this
 * transaction means a second connection checked out while this one is held, and
 * mysql2's connection queue is unbounded and untimed, so ten concurrent holds
 * doing that wedge the process. `vehiclePriceForRouteAndType` and
 * `validateCoupon` both default to the pool and are therefore ALWAYS passed
 * `tx` explicitly here.
 *
 * ## Why a refusal is a throw
 *
 * Every refusal is a typed error, and every one of them rolls the transaction
 * back — so a refused hold writes NOTHING: no booking, no details row, no audit
 * row, no consumed coupon use, and (because the refusals that can fire before
 * the lock fire before the transaction opens at all) not even a
 * `fleet_date_slots` anchor row in the input-shape cases.
 */
import { eq } from 'drizzle-orm';
import { alias } from 'drizzle-orm/mysql-core';
import {
  HOLD_MINUTES,
  PAYMONGO_MIN_CENTAVOS,
  manilaInstant,
  transferPriceSnapshotSchema,
  type PayMode,
  type TransferDirection,
  type TransferPriceSnapshot,
  type TransferPriceSource,
  type TransferProductType,
} from '@rg/shared';
import { readSettingBlockTx, readTransferOperationsSettingsTx } from '../../content/settings';
import { getDb, type Transaction } from '../../db/client';
import { withDeadlockRetry } from '../../db/deadlock';
import {
  bookingTransferDetails,
  transferPlaces,
  transferRoutes,
  vehicleTypes,
} from '../../db/schema';
import { writeAudit } from '../audit';
import { insertBookingWithRef } from '../booking-ref';
import { takeFleetDateLock } from '../capacity';
import { recordRedemption, validateCoupon, type ValidCoupon } from '../coupons';
import {
  GatewayMinimumNotMetError,
  HoldContentionError,
  assertUnderHoldCaps,
  reserveCouponUnderLock,
  type HeldBooking,
} from '../create-hold';
import { assessTransferCapacity, type TransferCapacityRefusalReason } from './capacity';
import { clockTimeToMinutes } from './overlap';
import { quoteTransfer, vehiclePriceForRouteAndType } from './pricing';

/**
 * Two aliases onto `transfer_places`, mirroring `pricing.ts`'s own (declared
 * separately here rather than imported, the same way that file's own header
 * explains — each module that needs both sides of a route declares its own
 * pair). Used only by {@link loadRouteShape} below, to answer the two
 * post-catalog-read checks `assertBookableShape` cannot: whether this route
 * may be travelled in reverse, and whether the PICKUP place (resolved by
 * `direction`) is an airport.
 */
const fromPlace = alias(transferPlaces, 'fromPlace');
const toPlace = alias(transferPlaces, 'toPlace');

// ---------------------------------------------------------------------------
// The input
// ---------------------------------------------------------------------------

/** Who the booking is for. Same three fields a tour hold carries. */
export interface TransferBookingLead {
  name: string;
  email: string;
  phone: string;
}

/**
 * Where the price comes from (Architecture §3) — **the one parameter this
 * function exists to be generic over.**
 *
 *  - `catalog` — the guest self-serve path (Task T11). The price is read from
 *    `transfer_route_vehicle_prices` inside this transaction and the caller
 *    supplies no amount at all.
 *  - `staff` — Task T19's conversion of a custom request. `priceCentavos` is a
 *    staff-entered figure, which is why it is validated here rather than
 *    trusted, and `staffUserId` exists ONLY so the `audit_log` row can say who
 *    quoted it. It is deliberately not a general parameter of this function:
 *    there is no actor to attribute a guest's own hold to.
 */
export type TransferBookingPriceSource =
  { kind: 'catalog' } | { kind: 'staff'; priceCentavos: number; staffUserId: number };

/**
 * One transfer booking request.
 *
 * **This is a server-side shape, not a wire schema.** The guest-facing Zod
 * input is Task T12's (`shared/src/transfers.ts`), and T11 is what will parse a
 * request into this; until then {@link assertBookableShape} is the only gate,
 * and it is written to fail closed rather than to be friendly.
 *
 * `pickup`/`pickupMapUrl`/`requests` are **deliberately reused, not duplicated**
 * (Architecture §1): a transfer's pickup ADDRESS rides on the same `bookings`
 * columns a tour's pickup point does, and `requests` carries free-text notes.
 * What a tour has no concept of — a drop-off, a pickup CLOCK TIME, a flight —
 * lives on `booking_transfer_details`.
 */
export interface CreateTransferBookingInput {
  /** The civil pickup date in Asia/Manila, `YYYY-MM-DD`. */
  date: string;
  /** A catalog route, or null for a custom staff-quoted trip. */
  routeId: number | null;
  /** Set only when `routeId` is null. Exactly one of the two. */
  customRouteDescription: string | null;
  vehicleTypeId: number;
  productType: TransferProductType;
  /**
   * The one-way duration a custom, routeless trip has no catalog row to
   * supply (Task T19; see `./overlap.ts`'s `computeTransferWindow` doc
   * comment, which names this task as the one that must close the gap
   * rather than default it). Required exactly when `routeId` is null AND
   * `productType` is `'transfer_one_way'` — refused otherwise by
   * {@link assertBookableShape}'s `custom_one_way_needs_duration` reason — a
   * day-use hire needs no duration at all (its window ends at
   * `dayUseEndTime`) and a catalog route already has one.
   */
  customRouteDurationMinutes: number | null;
  /**
   * Which way a reversible route is being travelled (owner decision
   * 2026-11-08). `'forward'` is `route.fromPlaceId → route.toPlaceId` as the
   * route is stored. Checked against the resolved route's own
   * `reverseEnabled` inside the transaction, in step 3a below — see that
   * step's doc comment for why this cannot be a pre-transaction shape check.
   */
  direction: TransferDirection;
  /** `"HH:mm"` civil label, Asia/Manila. */
  pickupTime: string;
  /** `"HH:mm"`, day-use only. Null for a one-way transfer. */
  dayUseEndTime: string | null;
  pax: number;
  luggageCount: number;
  /** The pickup ADDRESS — `bookings.pickup`, shared with tours. */
  pickup: string | null;
  pickupMapUrl: string | null;
  dropoffAddress: string;
  dropoffMapUrl: string | null;
  /** One-way only (an airport trip in practice — see {@link assertBookableShape}). */
  flightNumber: string | null;
  airline: string | null;
  requests: string | null;
  payMode: PayMode;
  couponCode?: string;
  lead: TransferBookingLead;
  priceSource: TransferBookingPriceSource;
}

// ---------------------------------------------------------------------------
// The refusals
// ---------------------------------------------------------------------------

/**
 * What is wrong with the request's own SHAPE — every invariant answerable from
 * the input alone, checked before the transaction opens.
 *
 * One error class with a reason rather than a dozen near-identical classes, the
 * same way `CapacityRefusedError` carries `assessCapacity`'s reason: these are
 * all one kind of failure (the caller handed over a request that cannot describe
 * a bookable trip), and T11/T19's Zod inputs are what will make each of them
 * unreachable with a sentence a guest can act on.
 *
 * **Two members are an exception to this class's own "checked before the
 * transaction opens" framing** (owner decision 2026-11-08; design note §2/§6
 * item 3) — `reverse_not_enabled_for_route` and
 * `flight_details_required_for_airport_route` both need the RESOLVED route
 * (its `reverseEnabled` flag, and whether the PICKUP place — resolved via
 * `direction`, owner decision 2026-11-09 — is an airport place), which does
 * not exist until step 3a's catalog read, inside the transaction.
 * `assertBookableShape` cannot check either one; they are thrown from
 * `createTransferBooking()` itself, right after that read — see the comment
 * there. They still roll the transaction back and still write nothing, same
 * as every other member of this type; only WHEN they are checked differs.
 */
export const TRANSFER_BOOKING_SHAPE_PROBLEMS = [
  /** Both a catalog route AND a custom description — which trip is this? */
  'route_and_custom_route_description',
  /** Neither. A booking that names no journey at all. */
  'neither_route_nor_custom_route_description',
  /** `priceSource: catalog` with no route to read a catalog price from. */
  'catalog_price_source_without_route',
  'pickup_time_unreadable',
  'day_use_end_time_missing',
  'day_use_end_time_unreadable',
  /** A day-use hire that ends when or before it starts occupies no vehicle. */
  'day_use_end_time_not_after_pickup',
  'day_use_end_time_on_one_way',
  'flight_details_on_day_use',
  'pax_not_positive',
  'luggage_count_negative',
  /** A staff-quoted price that is not whole, non-negative centavos. */
  'staff_price_not_whole_centavos',
  /**
   * A routeless (`routeId === null`) one-way trip with no
   * `customRouteDurationMinutes` — Task T19's own gap, named in
   * `./overlap.ts`'s `computeTransferWindow` doc comment: a one-way window
   * needs a duration from somewhere, a catalog route supplies one and a
   * custom trip must supply it explicitly. Checked here, from the input
   * alone, rather than left to surface as that function's `Error` throw.
   */
  'custom_one_way_needs_duration',
  /**
   * `direction: 'reverse'` against a route whose `reverseEnabled` is false.
   * Checked post-catalog-read — see the class doc comment above.
   */
  'reverse_not_enabled_for_route',
  /**
   * A one-way trip whose PICKUP place is an airport, with
   * `flightNumber`/`airline` not BOTH present. Checked post-catalog-read —
   * see the class doc comment above.
   *
   * **Narrowed 2026-11-09 (owner decision 3)** from the 2026-11-08 rule this
   * reason originally shipped with, which required the fields when EITHER
   * end of the route was an airport, regardless of direction. A
   * drop-off-only airport is now OPTIONAL, not required: the fields may
   * still be given (and are stored if so — nothing refuses them), just not
   * demanded. Which place counts as "pickup" depends on `direction`:
   * `'forward'` reads `fromPlace`, `'reverse'` reads `toPlace` — see the
   * ternary in `createTransferBooking()` where this is thrown.
   */
  'flight_details_required_for_airport_route',
] as const;
export type TransferBookingShapeProblem = (typeof TRANSFER_BOOKING_SHAPE_PROBLEMS)[number];

/** The request cannot describe a bookable transfer. Nothing was written. */
export class TransferBookingShapeError extends Error {
  readonly reason: TransferBookingShapeProblem;

  constructor(reason: TransferBookingShapeProblem, detail: string) {
    super(`Transfer booking request is not bookable (${reason}): ${detail}`);
    this.name = 'TransferBookingShapeError';
    this.reason = reason;
  }
}

/**
 * The fleet cannot take this transfer. Carries
 * {@link assessTransferCapacity}'s reason unchanged, because "we have no van
 * free around that time", "no driver has transfer capacity left that day" and
 * "that pickup is too late in the day" are three different sentences to a
 * guest — the same reasoning `CapacityRefusedError` is built on, which this
 * mirrors rather than extends (the two reason vocabularies are disjoint on
 * purpose).
 */
export class TransferCapacityRefusedError extends Error {
  readonly reason: TransferCapacityRefusalReason;

  constructor(reason: TransferCapacityRefusalReason) {
    super(`Transfer capacity refused: ${reason}`);
    this.name = 'TransferCapacityRefusedError';
    this.reason = reason;
  }
}

/**
 * Owner answer 2: `pickup instant - now >= transfer_operations.minNoticeHours`.
 *
 * The pickup instant comes from `manilaInstant(date, pickupTime)` — the one
 * civil-time-to-instant conversion in the whole transfer flow, reused from
 * `shared/src/time.ts` rather than built a second time. Because the gap is a
 * signed comparison, this ALSO subsumes the tour's separate "that date is
 * already past in Asia/Manila" guard: a pickup that has been and gone has a
 * negative gap and is refused by the same arithmetic, at any `minNoticeHours`
 * including zero.
 *
 * It carries the numbers so the guest-facing copy can say how much notice is
 * needed rather than only refusing.
 */
export class TransferNoticeTooShortError extends Error {
  readonly minNoticeHours: number;
  readonly hoursUntilPickup: number;
  readonly pickupAt: Date;

  constructor(minNoticeHours: number, pickupAt: Date, now: Date) {
    const hoursUntilPickup = (pickupAt.getTime() - now.getTime()) / 3_600_000;
    super(
      `A transfer needs ${minNoticeHours}h notice; this pickup is ` +
        `${hoursUntilPickup.toFixed(2)}h away (${pickupAt.toISOString()})`,
    );
    this.name = 'TransferNoticeTooShortError';
    this.minNoticeHours = minNoticeHours;
    this.hoursUntilPickup = hoursUntilPickup;
    this.pickupAt = pickupAt;
  }
}

/**
 * `vehiclePriceForRouteAndType()` answered `null`: no such route, a RETIRED
 * route, a route whose DESTINATION is retired, or a route with no price row for
 * the requested vehicle type.
 *
 * A guest-reachable refusal rather than a 500 — the same treatment
 * `CapacityRefusedError('tour_unavailable')` gets for a tour whose slug no
 * longer resolves, and reachable the same way: a stale tab, or a route the owner
 * withdrew between the quote and the hold.
 */
export class TransferRouteNotQuotableError extends Error {
  readonly routeId: number;
  readonly vehicleTypeId: number;
  readonly productType: TransferProductType;

  constructor(routeId: number, vehicleTypeId: number, productType: TransferProductType) {
    super(`Route ${routeId} cannot be quoted for vehicle type ${vehicleTypeId} ${productType}`);
    this.name = 'TransferRouteNotQuotableError';
    this.routeId = routeId;
    this.vehicleTypeId = vehicleTypeId;
    this.productType = productType;
  }
}

/**
 * `null` or whitespace-only. Used by the airport flight-details check below
 * so that `flightNumber: ''`/`airline: ''` — a guest's form posting an empty
 * string rather than omitting the field — refuses the same way an outright
 * `null` does, instead of satisfying a `=== null` check and reaching the
 * booking with no usable flight details at all.
 */
function blank(value: string | null): boolean {
  return value === null || value.trim() === '';
}

/** What {@link loadRouteShape} answers about a resolved catalog route. */
interface RouteShape {
  reverseEnabled: boolean;
  fromIsAirport: boolean;
  toIsAirport: boolean;
}

/**
 * Reads the two facts about a route that `vehiclePriceForRouteAndType()`
 * does not carry — whether it may be travelled in reverse, and whether
 * either place is an airport place (the caller resolves which one is PICKUP
 * from `direction`) — so `createTransferBooking()` can make its
 * two post-catalog-read checks (owner decision 2026-11-08; see
 * `TRANSFER_BOOKING_SHAPE_PROBLEMS`'s doc comment).
 *
 * Called only after `vehiclePriceForRouteAndType()` has already answered
 * non-null for this exact `routeId`, so this function does not re-check
 * `is_active` on the route or either place — that question is already
 * settled. It can still answer `null` if the row vanished between the two
 * reads inside the same transaction, which cannot happen under REPEATABLE
 * READ and is handled only because an `undefined` destructure is worse than
 * a named `null`.
 */
async function loadRouteShape(tx: Transaction, routeId: number): Promise<RouteShape | null> {
  const [row] = await tx
    .select({
      reverseEnabled: transferRoutes.reverseEnabled,
      fromIsAirport: fromPlace.isAirport,
      toIsAirport: toPlace.isAirport,
    })
    .from(transferRoutes)
    .innerJoin(fromPlace, eq(fromPlace.id, transferRoutes.fromPlaceId))
    .innerJoin(toPlace, eq(toPlace.id, transferRoutes.toPlaceId))
    .where(eq(transferRoutes.id, routeId))
    .limit(1);
  return row ?? null;
}

/**
 * The vehicle type's current name, for the unreachable-today custom-route
 * branch alone (`catalog` is null there, so `TransferVehiclePrice
 * .vehicleTypeName` is not available) — see `buildTransferSnapshot`'s
 * caller. Answers `null` only for an id that does not exist, which
 * `assertBookableShape`/Zod never let through; kept as a `null` rather than
 * a throw because a frozen snapshot with no name still parses (see
 * `transferPriceSnapshotSchema`'s `.optional()` on this field).
 */
async function loadVehicleTypeName(tx: Transaction, vehicleTypeId: number): Promise<string | null> {
  const [row] = await tx
    .select({ name: vehicleTypes.name })
    .from(vehicleTypes)
    .where(eq(vehicleTypes.id, vehicleTypeId))
    .limit(1);
  return row?.name ?? null;
}

/** Gives up in THIS module's vocabulary after the shared retry is exhausted. */
function holdContention(tries: number, error: unknown): never {
  throw new HoldContentionError(tries, error);
}

// ---------------------------------------------------------------------------
// Step 0 — the input-shape invariants, before anything opens a transaction
// ---------------------------------------------------------------------------

/** The two clock labels, already converted to minutes since midnight. */
interface ParsedTimes {
  pickupTimeMinutes: number;
  /** Null for a one-way transfer, by the same convention `./overlap.ts` uses. */
  dayUseEndTimeMinutes: number | null;
}

/**
 * Everything about the request that can be decided without a database, checked
 * BEFORE the transaction opens so a refusal provably writes nothing — not even
 * the `fleet_date_slots` anchor row `takeFleetDateLock` would create.
 *
 * **This is the function `db/schema.ts` delegates to.** Its
 * `bookings_product_type_shape` CHECK deliberately says nothing about `route_id`
 * on the transfer branch, because "`route_id` XOR `custom_route_description` for
 * every non-tour booking" is a CROSS-TABLE invariant a single-table MySQL CHECK
 * cannot express — the description lives on `booking_transfer_details`. That
 * comment names this writer and promises a dedicated test; both exist.
 *
 * The flight fields are refused on a day-use hire and allowed on a one-way
 * trip, which is the half of "airport one-way only" that is expressible today:
 * **nothing in the schema marks a route as an airport route**, so "is this an
 * airport trip" is not a question this code can ask. T12's guest form owns that
 * conditional.
 */
export function assertBookableShape(input: CreateTransferBookingInput): ParsedTimes {
  function refuse(reason: TransferBookingShapeProblem, detail: string): never {
    throw new TransferBookingShapeError(reason, detail);
  }

  // The XOR. Spelled as two separate refusals, because "you sent both" and
  // "you sent neither" are different mistakes with different fixes.
  if (input.routeId !== null && input.customRouteDescription !== null) {
    refuse(
      'route_and_custom_route_description',
      `route ${input.routeId} and a custom description were both given`,
    );
  }
  if (input.routeId === null && input.customRouteDescription === null) {
    refuse('neither_route_nor_custom_route_description', 'no route and no custom description');
  }
  if (input.priceSource.kind === 'catalog' && input.routeId === null) {
    refuse('catalog_price_source_without_route', 'a catalog price needs a catalog route');
  }
  /*
   * The routeless one-way gap `./overlap.ts` names: a catalog route carries
   * its own duration and a day-use hire needs none, so this is the ONE
   * combination with nowhere to read a duration from unless the caller
   * supplies one explicitly. Answerable from the input alone, so it is
   * checked here rather than left to surface as `computeTransferWindow`'s
   * `Error` throw deep inside the transaction.
   */
  if (input.routeId === null && input.productType === 'transfer_one_way') {
    const duration = input.customRouteDurationMinutes;
    if (!Number.isInteger(duration) || (duration ?? 0) < 1) {
      refuse('custom_one_way_needs_duration', `got ${duration}`);
    }
  }

  if (input.priceSource.kind === 'staff') {
    const { priceCentavos } = input.priceSource;
    if (!Number.isInteger(priceCentavos) || priceCentavos < 0) {
      refuse('staff_price_not_whole_centavos', `got ${priceCentavos}`);
    }
  }

  if (!Number.isInteger(input.pax) || input.pax < 1) {
    refuse('pax_not_positive', `got ${input.pax}`);
  }
  if (!Number.isInteger(input.luggageCount) || input.luggageCount < 0) {
    refuse('luggage_count_negative', `got ${input.luggageCount}`);
  }

  const pickupTimeMinutes = clockTimeToMinutes(input.pickupTime);
  if (pickupTimeMinutes === null) {
    refuse('pickup_time_unreadable', `got "${input.pickupTime}"`);
  }

  if (input.productType !== 'transfer_day_use') {
    if (input.dayUseEndTime !== null) {
      refuse('day_use_end_time_on_one_way', `got "${input.dayUseEndTime}"`);
    }
    return { pickupTimeMinutes, dayUseEndTimeMinutes: null };
  }

  const dayUseEndTime = input.dayUseEndTime;
  if (dayUseEndTime === null) {
    refuse('day_use_end_time_missing', 'a day-use hire must say when it ends');
  }
  const dayUseEndTimeMinutes = clockTimeToMinutes(dayUseEndTime);
  if (dayUseEndTimeMinutes === null) {
    refuse('day_use_end_time_unreadable', `got "${dayUseEndTime}"`);
  }
  /*
   * Strictly after, and this is not pedantry: a day-use window of `[x, x)` is
   * an EMPTY half-open interval, so `peakOverlap` counts it as occupying no
   * vehicle at all and the hire would be sold against nothing.
   * `computeTransferWindow` throws a `RangeError` for it; refusing here keeps a
   * guest's reversed time pickers out of a 500.
   */
  if (dayUseEndTimeMinutes <= pickupTimeMinutes) {
    refuse('day_use_end_time_not_after_pickup', `pickup ${input.pickupTime}, end ${dayUseEndTime}`);
  }
  if (input.flightNumber !== null || input.airline !== null) {
    refuse('flight_details_on_day_use', 'a day-use hire carries no flight');
  }

  return { pickupTimeMinutes, dayUseEndTimeMinutes };
}

// ---------------------------------------------------------------------------
// createTransferBooking
// ---------------------------------------------------------------------------

/**
 * Holds a transfer for a guest, or books one a staff member has quoted: one
 * transaction, `pending_payment`, and a hold whose LENGTH is the only thing the
 * two paths differ in (Architecture §6 step 4 — `HOLD_MINUTES` for the guest,
 * `transfer_operations.staffQuoteHoldHours` for a staff quote, because the guest
 * needs time to be notified and come back). It reuses the EXISTING
 * `hold_expires_at` column and the EXISTING `expire-holds` sweep: no new status,
 * no new job, nothing new at all but the duration.
 *
 * `now` is a parameter (defaulted) rather than a `new Date()` inside, the same
 * discipline `createHold()` and `validateCoupon()` use: the hold expiry and the
 * minimum-notice boundary are then exactly assertable, and the near-midnight
 * case is testable at all. Production callers leave it out.
 *
 * @throws TransferBookingShapeError      the request cannot describe a trip
 * @throws TransferNoticeTooShortError    too little notice (owner answer 2)
 * @throws TransferRouteNotQuotableError  no price for that route + vehicle
 * @throws TransferCapacityRefusedError   the fleet cannot take it
 * @throws GatewayMinimumNotMetError      the online charge is under ₱100
 * @throws HoldLimitReachedError          this guest already holds two slots
 * @throws HoldContentionError            lost every deadlock retry
 * @throws Error                          any coupon rule, from `validateCoupon()`
 */
export async function createTransferBooking(
  input: CreateTransferBookingInput,
  now: Date = new Date(),
): Promise<HeldBooking> {
  // 0. OUTSIDE the transaction — see step 0 in the module note.
  const times = assertBookableShape(input);

  return withDeadlockRetry(
    () =>
      getDb().transaction(async (tx) => {
        /*
         * 1. The lock, FIRST — before any consistent read. A transfer takes the
         *    fleet half alone (no `tour_date_slots` row), which is the same
         *    protocol in the same order with nothing in the middle.
         *    `takeFleetDateLock` asserts the date is civil and throws otherwise.
         */
        await takeFleetDateLock(tx, input.date);

        /*
         * 2. The operational settings, then the minimum-notice rule. Read
         *    through 0A's resilient reader, never the throwing
         *    `readSettingBlockTx(tx, 'transfer_operations')`: a missing or
         *    half-written settings row must not 500 a transfer hold, and the
         *    defaults it falls back to are the owner's own decision-log values.
         *
         *    This is the transaction's first non-locking read and therefore what
         *    pins its REPEATABLE READ snapshot. Safe for the only reason that
         *    matters: it is AFTER the lock, so the loser of a race is granted
         *    the fleet row only once the winner has committed, and its snapshot
         *    — pinned here — already contains the winner's booking.
         *
         *    `bufferMinutes` is read ONCE and used three times: in the capacity
         *    window below, and frozen onto the booking as
         *    `buffer_minutes_used`. The value this check was made under and the
         *    value stored on the row are therefore provably the same one.
         */
        const operations = await readTransferOperationsSettingsTx(tx);
        const pickupAt = manilaInstant(input.date, input.pickupTime);
        if (pickupAt.getTime() - now.getTime() < operations.minNoticeHours * 3_600_000) {
          throw new TransferNoticeTooShortError(operations.minNoticeHours, pickupAt, now);
        }

        /*
         * 3a. The catalog row — one read for the price, the free-cancellation
         *     window AND the route duration the capacity window needs, so the
         *     route is not queried twice. `tx` is passed EXPLICITLY (it is the
         *     last parameter of that function, and its default is the pool).
         *
         *     A custom staff-quoted trip has no catalog row at all, and no
         *     stored duration anywhere in the schema. That branch is unreachable
         *     today — nothing can create a `routeId === null` booking until Task
         *     T19 — and it is left as forward-compatible plumbing rather than
         *     finished here: for a one-way custom trip,
         *     `computeTransferWindow` (inside the capacity check below) THROWS,
         *     with a message that names the problem and names T19 as the task
         *     that must supply a real duration. That throw is deliberately NOT
         *     softened into a guessed duration, and deliberately NOT wrapped:
         *     the message T7 wrote for this case is the context, and a wrapper
         *     would hide it. A day-use custom trip needs no duration (its window
         *     ends at `dayUseEndTime`) and works.
         */
        const catalog =
          input.routeId === null
            ? null
            : await vehiclePriceForRouteAndType(
                input.routeId,
                input.vehicleTypeId,
                input.productType,
                tx,
              );
        if (input.routeId !== null && catalog === null) {
          throw new TransferRouteNotQuotableError(
            input.routeId,
            input.vehicleTypeId,
            input.productType,
          );
        }

        /*
         * 3a (continued). The two post-catalog-read checks that
         * `assertBookableShape` cannot make, because both need the RESOLVED
         * route — see `TRANSFER_BOOKING_SHAPE_PROBLEMS`'s own doc comment on
         * why these two members are an exception to "checked before the
         * transaction opens". `routeShape` is null exactly when `catalog` is
         * (no catalog route — the unreachable-today custom-route branch),
         * and both checks below are skipped in that case: there is no
         * resolved route to ask "reversible?" or "an airport?" of.
         */
        const routeShape = input.routeId === null ? null : await loadRouteShape(tx, input.routeId);

        if (routeShape !== null) {
          if (input.direction === 'reverse' && !routeShape.reverseEnabled) {
            throw new TransferBookingShapeError(
              'reverse_not_enabled_for_route',
              `route ${input.routeId} does not allow the reverse direction`,
            );
          }
          /*
           * Owner decision 3, 2026-11-09: required ⟺ the PICKUP place is an
           * airport — not "either end" (the 2026-11-08 rule this narrows).
           * Pickup is `fromPlace` on a 'forward' hold and `toPlace` on a
           * 'reverse' one; a drop-off-only airport is optional (fields may
           * still be given and are stored, just not demanded — see
           * `TRANSFER_BOOKING_SHAPE_PROBLEMS`'s doc comment on this reason).
           */
          const pickupIsAirport =
            input.direction === 'forward' ? routeShape.fromIsAirport : routeShape.toIsAirport;
          if (
            input.productType === 'transfer_one_way' &&
            pickupIsAirport &&
            (blank(input.flightNumber) || blank(input.airline))
          ) {
            throw new TransferBookingShapeError(
              'flight_details_required_for_airport_route',
              `route ${input.routeId} direction ${input.direction} has an airport pickup; flight number and airline are both required`,
            );
          }
        }

        /*
         * The vehicle type's NAME, frozen into the price snapshot (§1.8).
         * Resolved from the catalog read's own join when there is one
         * (cheapest — no second query); a dedicated lookup only for the
         * unreachable-today custom-route branch, which has no catalog row to
         * carry it.
         */
        const vehicleTypeName =
          catalog?.vehicleTypeName ?? (await loadVehicleTypeName(tx, input.vehicleTypeId));

        /*
         * The duration FROZEN onto this booking, and the one the capacity check
         * is made with — the same value, deliberately. NULL for a day-use hire
         * (which has no duration: its window ends at `dayUseEndTime`). For a
         * one-way trip it is the catalog route's own duration, or — for a
         * custom, routeless trip (Task T19) — the staff-supplied
         * `customRouteDurationMinutes`, already proven a positive integer by
         * `assertBookableShape`'s `custom_one_way_needs_duration` check above.
         * See `booking_transfer_details.route_duration_minutes_used`'s own note
         * on why freezing it matters: a live read let an admin SHORTEN a route
         * after a booking was taken and silently shrink that booking's reserved
         * window.
         */
        const routeDurationMinutesUsed =
          input.productType === 'transfer_day_use'
            ? null
            : (catalog?.routeDurationMinutes ?? input.customRouteDurationMinutes);

        /*
         * 3b. Capacity — all five of Architecture §2/§2a's conditions with this
         *     candidate's own window included. The cross-midnight refusal is
         *     condition (1) of that function, with no database read at all, so
         *     it is NOT re-checked here.
         */
        const verdict = await assessTransferCapacity(tx, {
          date: input.date,
          vehicleTypeId: input.vehicleTypeId,
          productType: input.productType,
          pickupTimeMinutes: times.pickupTimeMinutes,
          dayUseEndTimeMinutes: times.dayUseEndTimeMinutes,
          routeDurationMinutes: routeDurationMinutesUsed,
          bufferMinutes: operations.bufferMinutes,
        });
        if (!verdict.ok) throw new TransferCapacityRefusedError(verdict.reason);

        /*
         * 4. The money. The subtotal is the flat per-vehicle rate — from the
         *    catalog on the guest path, from the staff figure on T19's. Nothing
         *    multiplies it by `pax`: a van costs what a van costs.
         */
        const priceCentavos =
          input.priceSource.kind === 'staff'
            ? input.priceSource.priceCentavos
            : // Non-null by `assertBookableShape`'s
              // `catalog_price_source_without_route` refusal plus the
              // `TransferRouteNotQuotableError` above.
              catalog!.priceCentavos;

        /*
         * The coupon's RULES, through `tx` and never the pool (the
         * pool-starvation hazard in the module note). Checked here rather than
         * after the floor because the floor's own figure does not exist until
         * the discount is known; the coupon's row LOCK is still taken last.
         *
         * `ValidCoupon` is structurally `services/pricing.ts`'s `QuoteCoupon`,
         * so the validated row goes straight into the quote with no conversion
         * and there is no second "load the coupon for pricing" query to drift
         * from this one.
         */
        const coupon: ValidCoupon | null = input.couponCode
          ? await validateCoupon(input.couponCode, priceCentavos, now, tx)
          : null;

        const trust = await readSettingBlockTx(tx, 'trust');
        const quote = quoteTransfer({
          priceCentavos,
          coupon,
          depositPercent: trust.depositPercent,
        });

        /*
         * 4b. The gateway floor (BUG-110 / owner decision 2026-10-30), the SAME
         *     constant and the SAME error class the tour hold uses — no second
         *     threshold. The figure checked is what a gateway would actually be
         *     asked to charge for the mode chosen, and a total of nothing (a
         *     100%-off coupon) is refused by the same comparison: ₱0 is below
         *     ₱100, so a ₱0 booking is never confirmed with no payment step.
         *     Taken BEFORE any write, so a refusal leaves no booking, no slot
         *     and nothing for the expiry sweep.
         */
        const amountDueNowCentavos = quote.amountDueNowCentavos[input.payMode];
        if (amountDueNowCentavos < PAYMONGO_MIN_CENTAVOS) {
          throw new GatewayMinimumNotMetError(
            amountDueNowCentavos,
            input.payMode,
            quote.totalCentavos,
          );
        }

        /*
         * 5. The hold caps, under the lock. The EXISTING function, unchanged:
         *    a guest's tour holds and transfer holds share one pool of two, and
         *    nothing in the plan gives transfers a cap of their own.
         */
        await assertUnderHoldCaps(tx, input.lead.email, input.lead.phone);

        /*
         * 6. The coupon's row `FOR UPDATE` and its usage cap re-checked under
         *    that lock — LAST in the lock order, `fleet → coupon`, with no tour
         *    lock to sit between them. The earlier `validateCoupon` read is
         *    answered from this transaction's snapshot, so two guests can both
         *    see "one use left"; only this locking re-read is authoritative.
         */
        if (coupon) await reserveCouponUnderLock(tx, coupon);

        // 7. The writes.
        const holdMinutes =
          input.priceSource.kind === 'staff' ? operations.staffQuoteHoldHours * 60 : HOLD_MINUTES;
        const holdExpiresAt = new Date(now.getTime() + holdMinutes * 60_000);
        const priceSource: TransferPriceSource =
          input.priceSource.kind === 'staff' ? 'staff_quote' : 'catalog';
        const snapshot = buildTransferSnapshot(input, {
          priceSource,
          priceCentavos,
          coupon,
          depositPercent: trust.depositPercent,
          freeCancelHours: catalog?.freeCancelHours ?? null,
          vehicleTypeName,
          quote,
        });

        const { id: bookingId, ref } = await insertBookingWithRef(tx, {
          // NULL, and the `bookings_product_type_shape` CHECK requires it: a
          // transfer row carrying a `tour_id` would be counted by every tour
          // report and every tour capacity query at once.
          tourId: null,
          productType: input.productType,
          routeId: input.routeId,
          vehicleTypeId: input.vehicleTypeId,
          // UTC midnight of the civil date: the pool runs at `timezone: 'Z'`,
          // so this stores the day the guest picked, in Cebu, exactly.
          tourDate: new Date(`${input.date}T00:00:00Z`),
          pax: input.pax,
          leadName: input.lead.name,
          leadEmail: input.lead.email,
          leadPhone: input.lead.phone,
          pickup: input.pickup,
          pickupMapUrl: input.pickupMapUrl,
          requests: input.requests,
          status: 'pending_payment',
          payMode: input.payMode,
          priceSnapshot: snapshot,
          subtotalCentavos: quote.subtotalCentavos,
          discountCentavos: quote.discountCentavos,
          totalCentavos: quote.totalCentavos,
          couponId: coupon?.id ?? null,
          holdExpiresAt,
          createdAt: now,
          updatedAt: now,
        });

        await tx.insert(bookingTransferDetails).values({
          bookingId,
          pickupTime: input.pickupTime,
          dayUseEndTime: input.dayUseEndTime,
          dropoffAddress: input.dropoffAddress,
          dropoffMapUrl: input.dropoffMapUrl,
          luggageCount: input.luggageCount,
          flightNumber: input.flightNumber,
          airline: input.airline,
          customRouteDescription: input.customRouteDescription,
          // Both frozen from the exact values the checks above were made with.
          bufferMinutesUsed: operations.bufferMinutes,
          routeDurationMinutesUsed,
          // Which way this route-based transfer was travelled (owner decision
          // 2026-11-08) — already validated against the route's own
          // `reverseEnabled` above. Column default is `'forward'`, but this
          // writer always states it explicitly rather than relying on that.
          direction: input.direction,
          createdAt: now,
          updatedAt: now,
        });

        /*
         * An active hold reserves the coupon's USE, not just the capacity
         * (owner decision Q7/Q8), and the expiry sweep gives it back. The
         * duplicate-key error `recordRedemption` can raise is deliberately NOT
         * caught — it must propagate so this transaction rolls back rather than
         * double-counting a coupon.
         */
        if (coupon) await recordRedemption(tx, coupon.id, bookingId);

        await writeAudit(tx, {
          /*
           * A guest's own hold has no actor row to point at — the portal
           * identifies them by ref + email, and the booking this row points at
           * IS the identification. A staff quote DOES have one, and naming it
           * is the whole reason `staffUserId` is on the price source.
           */
          actorType: input.priceSource.kind === 'staff' ? 'user' : 'customer',
          actorId: input.priceSource.kind === 'staff' ? input.priceSource.staffUserId : null,
          /*
           * The same action a tour hold writes. It IS a hold — one status, one
           * expiry, one sweep — and a second verb would mean every surface
           * reading a booking's history had to know both. `productType` and
           * `priceSource` in the data below are what tell the three apart.
           */
          action: 'booking.held',
          entity: 'bookings',
          entityId: bookingId,
          // Identifiers and amounts only. No name, email or phone: audit rows
          // are read by every admin and exported in reports.
          data: {
            ref,
            productType: input.productType,
            routeId: input.routeId,
            customRouteDescription: input.customRouteDescription,
            vehicleTypeId: input.vehicleTypeId,
            direction: input.direction,
            tourDate: input.date,
            pickupTime: input.pickupTime,
            pax: input.pax,
            payMode: input.payMode,
            priceSource,
            totalCentavos: quote.totalCentavos,
            couponId: coupon?.id ?? null,
            holdExpiresAt: holdExpiresAt.toISOString(),
            ...(input.priceSource.kind === 'staff'
              ? { staffUserId: input.priceSource.staffUserId }
              : {}),
          },
        });

        return { ref, bookingId, holdExpiresAt };
      }),
    { onExhausted: holdContention },
  );
}

/**
 * The frozen copy of everything this booking's price AND refund rights depend
 * on, parsed through {@link transferPriceSnapshotSchema} before it is stored —
 * the same discipline `buildSnapshot()` applies to a tour: a snapshot that
 * cannot answer "may this guest cancel free?" must fail HERE, not months later
 * when someone tries to answer it.
 */
function buildTransferSnapshot(
  input: CreateTransferBookingInput,
  priced: {
    priceSource: TransferPriceSource;
    priceCentavos: number;
    coupon: ValidCoupon | null;
    depositPercent: number;
    freeCancelHours: number | null;
    /**
     * The vehicle type's name, frozen at booking time (owner decision
     * 2026-11-08). `null` only if the id somehow failed to resolve — see
     * `loadVehicleTypeName`'s own doc comment — in which case the snapshot
     * is written with no `vehicleTypeName` at all rather than a fabricated
     * one; `vehicleTypeId` alone still satisfies the schema's `.refine()`.
     */
    vehicleTypeName: string | null;
    quote: { subtotalCentavos: number; discountCentavos: number; totalCentavos: number };
  },
): TransferPriceSnapshot {
  return transferPriceSnapshotSchema.parse({
    productType: input.productType,
    // **No `vehicleType` (the legacy string literal) is ever written here**
    // (owner decision 2026-11-08; design note §1.8) — every new write uses
    // `vehicleTypeId`/`vehicleTypeName` instead. The legacy field stays in
    // the schema only so an OLD snapshot still parses.
    vehicleTypeId: input.vehicleTypeId,
    ...(priced.vehicleTypeName !== null ? { vehicleTypeName: priced.vehicleTypeName } : {}),
    routeId: input.routeId,
    customRouteDescription: input.customRouteDescription,
    priceSource: priced.priceSource,
    priceCentavos: priced.priceCentavos,
    coupon: priced.coupon
      ? {
          id: priced.coupon.id,
          code: priced.coupon.code,
          discount:
            priced.coupon.discountType === 'percent'
              ? {
                  discountType: 'percent',
                  percentBp: priced.coupon.percentBp,
                  amountCentavos: null,
                }
              : {
                  discountType: 'fixed',
                  percentBp: null,
                  amountCentavos: priced.coupon.amountCentavos,
                },
        }
      : null,
    depositPercent: priced.depositPercent,
    freeCancelHours: priced.freeCancelHours,
    subtotalCentavos: priced.quote.subtotalCentavos,
    discountCentavos: priced.quote.discountCentavos,
    totalCentavos: priced.quote.totalCentavos,
  } satisfies TransferPriceSnapshot);
}
