/**
 * Booking vocabulary, shared by client and server.
 *
 * Money is integer CENTAVOS everywhere (CLAUDE.md): every amount in this
 * module is an `int` named `*Centavos`, and there is no float anywhere near
 * a price. Percentages that are not money — the deposit percent — are whole
 * integers, and a coupon's percentage is basis points (see ./coupon).
 *
 * Nothing here computes a price. `depositCentavos()` in ./money owns the
 * deposit arithmetic, and the server owns every total: the browser never
 * sends one.
 */
import { z } from 'zod';
import { couponDiscountSchema } from './coupon';

/**
 * BUILD_SPEC §5 "Booking statuses", in the spec's own order.
 *
 * The order is part of the contract, not decoration: it is the lifecycle
 * order a tracker renders in, and the five capacity-holding statuses are the
 * first five precisely because capacity is held until a booking leaves the
 * live part of that lifecycle.
 *
 * `cancelled` and `expired` are separate terminal states — "an admin
 * cancelled this" and "the 15-minute hold ran out" are different events, and
 * refunds only ever attach to the first. Refunds themselves are tracked on
 * `payments`, never as a booking status.
 */
export const BOOKING_STATUSES = [
  'pending_payment',
  'pending_verification',
  'confirmed',
  'assigned',
  'in_progress',
  'completed',
  'cancelled',
  'expired',
] as const;
export type BookingStatus = (typeof BOOKING_STATUSES)[number];
export const bookingStatusSchema = z.enum(BOOKING_STATUSES);

/**
 * The statuses BUILD_SPEC §5's table marks **"Holds capacity: Yes"**, and
 * nothing else.
 *
 * Derived from that table and nowhere else. The §5 capacity check counts
 * bookings in these statuses against `groups_per_day`, and against van and
 * driver availability.
 *
 * **The two directions of error are not symmetrical.** Adding a status here
 * oversells nothing but refuses valid bookings — annoying, visible, and
 * reported within the hour. REMOVING one oversells the fleet: the system
 * cheerfully sells a trip it cannot run, and that is discovered by a family
 * standing on a kerb in Cebu at 6am with no van. Hence the explicit test
 * (`server/src/__tests__/schema-bookings.test.ts`), which pins the set in
 * both directions rather than only checking membership.
 *
 * `satisfies readonly BookingStatus[]` is deliberate: a typo'd status here
 * would otherwise be a perfectly valid string that silently matches no
 * booking row, i.e. a capacity check that quietly stops counting a whole
 * status. This way it fails `pnpm typecheck`.
 */
export const CAPACITY_HOLDING_STATUSES = [
  'pending_payment',
  'pending_verification',
  'confirmed',
  'assigned',
  'in_progress',
] as const satisfies readonly BookingStatus[];
export type CapacityHoldingStatus = (typeof CAPACITY_HOLDING_STATUSES)[number];

/** §6: the guest pays the whole price now, or the deposit now and the balance on tour day. */
export const PAY_MODES = ['full', 'deposit'] as const;
export type PayMode = (typeof PAY_MODES)[number];
export const payModeSchema = z.enum(PAY_MODES);

/**
 * `RG-` plus six unambiguous characters: `RG-7KQ4M9`.
 *
 * The character class omits `0/O`, `1/I/L` and `U` so a ref survives being
 * read aloud over a bad phone line. It must stay in lockstep with
 * `REF_ALPHABET` in `server/src/services/booking-ref.ts` (plan Task 9) —
 * widen one without the other and the generator mints refs this schema
 * rejects.
 *
 * Refs are random and non-sequential because §7 logs a guest into the portal
 * with ref + email: a guessable ref is half a credential.
 */
export const bookingRefSchema = z
  .string()
  .regex(/^RG-[ABCDEFGHJKMNPQRSTVWXYZ23456789]{6}$/, 'Not a valid booking reference');

/** One add-on line as frozen into a booking's price snapshot. */
const snapshotAddonSchema = z.object({
  addonId: z.number().int().positive(),
  /** The add-on's name AT BOOKING TIME. It may be renamed later. */
  name: z.string().min(1),
  priceCentavos: z.number().int().nonnegative(),
  /** True when the price multiplies by `pax`; false when it is per booking. */
  perPerson: z.boolean(),
  qty: z.number().int().positive(),
});

/** The coupon as frozen into a booking's price snapshot, or `null` for none. */
const snapshotCouponSchema = z.object({
  id: z.number().int().positive(),
  code: z.string().min(1),
  /** Reuses the live discount union, so the frozen shape cannot drift from it. */
  discount: couponDiscountSchema,
});

/**
 * The frozen copy of everything a booking's price **and its refund rights**
 * depend on (BUILD_SPEC §5; owner decision 2026-10-11, Q5). Stored in
 * `bookings.price_snapshot`, written once at booking time, never updated.
 *
 * **Refund and cancellation logic reads this, never the live tour.** That is
 * the entire point. An admin who edits a tour's price, or shortens its
 * cancellation window from 48 hours to 12, must not retroactively change
 * what a guest who already booked agreed to. §5 guarantees that for the
 * price; freezing `freeCancelHours` extends the same guarantee to the
 * refund.
 *
 * So two fields here are load-bearing beyond pricing:
 *
 *   - `freeCancelHours` — the tour's `free_cancel_hours` as it stood when
 *     the guest booked. Without it, cancellation has to ask the live tour,
 *     and a tour edit silently rewrites a guest's rights.
 *   - `depositPercent` — the deposit percent in force at booking time, so
 *     the balance owed on tour day is computable from the booking alone
 *     even after the setting changes.
 *
 * The `*_centavos` columns on `bookings` are a queryable SUMMARY of the
 * totals in here, not a second source of truth.
 *
 * Nothing writes this yet (plan Task 8 creates the column only). It is a
 * schema rather than a doc comment so that a later writer cannot quietly
 * drop a field: an object missing `freeCancelHours` or `depositPercent`
 * fails to parse and fails to typecheck.
 */
export const priceSnapshotSchema = z.object({
  /** The price tier actually used, and its per-person price at booking time. */
  tier: z.object({
    tierId: z.number().int().positive(),
    minPax: z.number().int().positive(),
    maxPax: z.number().int().positive(),
    pricePerPersonCentavos: z.number().int().nonnegative(),
  }),
  /** Every add-on taken, each with its own price and per-person flag. */
  addons: z.array(snapshotAddonSchema),
  /** The coupon applied, or null. */
  coupon: snapshotCouponSchema.nullable(),
  /** Whole percent, e.g. 30 for a 30% deposit. Never a float. */
  depositPercent: z.number().int().min(0).max(100),
  /** The tour's `free_cancel_hours` at booking time. Refund logic reads THIS. */
  freeCancelHours: z.number().int().nonnegative().nullable(),
  /** The computed totals, mirroring the booking's own summary columns. */
  subtotalCentavos: z.number().int().nonnegative(),
  discountCentavos: z.number().int().nonnegative(),
  totalCentavos: z.number().int().nonnegative(),
});
export type PriceSnapshot = z.infer<typeof priceSnapshotSchema>;
