/**
 * Admin coupon editing — the shapes `admin.coupons.*` accepts and returns
 * (Week 7 plan, Task 8; BUILD_SPEC §9 "Coupons").
 *
 * **This file describes money.** A coupon's discount is subtracted from a
 * guest's subtotal by `priceQuote()`, so every figure here is an integer:
 * `percentBp` in BASIS POINTS and `amountCentavos` / `minSpendCentavos` in
 * CENTAVOS (CLAUDE.md, "Money"). There is no float and no peso string at this
 * boundary.
 *
 * **It adds no validation logic of its own.** The discount's shape is
 * `couponDiscountSchema` from `./coupon`, which already mirrors the three
 * MySQL CHECK constraints on `coupons` (`coupons_discount_shape`,
 * `coupons_percent_bp_range`, `coupons_amount_positive`) — so the input and
 * the database agree *by construction* rather than by two people remembering
 * the same rule. The two inputs below are built by EXTENDING that union's own
 * two members (`couponDiscountSchema.options`), not by restating them: a
 * change to the discount's shape lands here automatically, and a mismatch
 * cannot be introduced by editing one copy.
 *
 * Why extending the members rather than `z.intersection(couponDiscountSchema,
 * z.object(...).strict())`: an intersection parses the SAME input through both
 * halves, so a `.strict()` object half would reject `discountType` itself as
 * an unrecognised key, and a non-strict half would silently STRIP an extra
 * `usedCount` instead of refusing it. The whole point of `.strict()` here is
 * the refusal (see below), so the union has to carry the common fields.
 *
 * **Both inputs are `.strict()`, and two columns are therefore structurally
 * unreachable from here:**
 *
 *  - `usedCount` — the cached redemption counter. Its only writers are
 *    `recordRedemption()` (a hold reserves a coupon's use) and
 *    `releaseRedemption()` (an expiry or a cancel gives it back), both in
 *    `server/src/services/coupons.ts`, both inside the transaction that
 *    creates or releases the booking. An admin field that could type a number
 *    into it would let someone hand out a sold-out coupon again without a
 *    single `coupon_redemptions` row to show for it — the counter and the
 *    record would disagree, and the record is the one that is true.
 *  - `isActive` — the soft-delete switch, owned by `admin.coupons.setActive`
 *    alone, exactly as `tours.is_active` is owned by `admin.tours.setActive`
 *    (CLAUDE.md, "Soft deletes"). One writer, one audit action, one question
 *    to answer when asking who switched a coupon off.
 *
 * `.strict()` means posting either one is a `BAD_REQUEST`, not a value quietly
 * dropped: an input that "drops" a field it was handed looks like it might
 * have honoured it.
 */
import { z } from 'zod';
import { couponDiscountSchema } from './coupon';
import { MAX_CENTAVOS } from './tours-admin';

/**
 * A coupon code as an admin types it.
 *
 * Letters, digits, hyphens and underscores — no spaces, no commas, nothing a
 * guest could mistype invisibly. Accepted in any case and NORMALISED on the
 * server (`normalizeCouponCode()`: trim, then uppercase), which is the same
 * transform `validateCoupon()` applies when a guest types one at checkout, so
 * the duplicate check and the eventual lookup agree.
 *
 * Bounded at 40 because `coupons.code` is `varchar(40)`: a longer value is a
 * column overflow — a 500 from the driver — rather than a refusal a screen can
 * show.
 */
export const couponCodeSchema = z
  .string()
  .trim()
  .min(3)
  .max(40)
  .regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/, 'Use letters, numbers, hyphens and underscores.');

/** `coupons.id`, and the id of a coupon being edited. */
const couponIdSchema = z.number().int().positive();

/**
 * A UTC instant, as an ISO-8601 string with a `Z`.
 *
 * `coupons.starts_at` / `.ends_at` are UTC (CLAUDE.md: store UTC, display and
 * compute business dates in Asia/Manila), and the conversion is the CLIENT's
 * job — a `datetime-local` input reads Manila wall clock, and
 * `client/src/lib/manila-datetime.ts` turns it into this before it is sent.
 * Doing it here would mean the server guessing which zone an unqualified
 * timestamp was typed in.
 *
 * `z.string().datetime()` refuses a numeric offset by default, which is what
 * is wanted: exactly one spelling of an instant reaches the column, so two
 * screens cannot disagree about whether `+08:00` was already applied.
 */
const utcInstantSchema = z.string().datetime();

/**
 * Everything editable on a coupon that is NOT its discount shape.
 *
 * All five are required on both inputs and all five are nullable, because
 * every one of them has a meaningful "no limit" state the screen must be able
 * to post: no minimum spend, no start date, no end date, no usage cap. An
 * OPTIONAL field would make an omitted `endsAt` ambiguous between "leave the
 * old one" and "clear it", and `update` is a full replacement.
 */
const couponEditableFields = {
  code: couponCodeSchema,
  /** Null means no minimum. Centavos, like every money column here. */
  minSpendCentavos: z.number().int().nonnegative().max(MAX_CENTAVOS).nullable(),
  /** Null means "already running". */
  startsAt: utcInstantSchema.nullable(),
  /** Null means "no end date". */
  endsAt: utcInstantSchema.nullable(),
  /**
   * Null means unlimited. At least 1 when it is set: a coupon capped at zero
   * uses is one that refuses everybody while looking live, which is what
   * `setActive(false)` is for.
   */
  usageLimit: z.number().int().positive().max(1_000_000).nullable(),
} as const;

const [percentDiscount, fixedDiscount] = couponDiscountSchema.options;

/** `admin.coupons.create` — the discount shape plus every editable field. */
export const couponCreateInput = z.discriminatedUnion('discountType', [
  percentDiscount.extend(couponEditableFields).strict(),
  fixedDiscount.extend(couponEditableFields).strict(),
]);
export type CouponCreateInput = z.infer<typeof couponCreateInput>;

/**
 * `admin.coupons.update` — the same fields plus the id, a FULL replacement.
 *
 * Not a patch, for the reason `couponEditableFields` is all-required: the
 * screen loads the coupon and posts the whole of it back, so clearing an end
 * date is `endsAt: null` rather than an absence someone has to interpret. The
 * discount's TYPE may change in a save (percent to fixed), and the resolver
 * writes both discount columns every time so the pair always satisfies
 * `coupons_discount_shape`.
 */
export const couponUpdateInput = z.discriminatedUnion('discountType', [
  percentDiscount.extend(couponEditableFields).extend({ id: couponIdSchema }).strict(),
  fixedDiscount.extend(couponEditableFields).extend({ id: couponIdSchema }).strict(),
]);
export type CouponUpdateInput = z.infer<typeof couponUpdateInput>;

/**
 * `admin.coupons.setActive`. The soft delete, modelled on `tourActiveInput`:
 * switching a coupon off stops it being accepted at checkout and deletes
 * nothing — not the coupon, not its `coupon_redemptions` rows, not its
 * `used_count`.
 */
export const couponActiveInput = z.object({ id: couponIdSchema, isActive: z.boolean() }).strict();
export type CouponActiveInput = z.infer<typeof couponActiveInput>;

/** `admin.coupons.redemptions` — which coupon's log to read. */
export const couponRedemptionsInput = z.object({ couponId: couponIdSchema }).strict();

/**
 * One row of `admin.coupons.list`.
 *
 * `usedCount` and `redemptionCount` are both here on purpose and they are NOT
 * duplicate data: `coupons.used_count` is a cached counter and the
 * `coupon_redemptions` rows are the record (the table's own doc comment says
 * so). Showing the two beside each other is what makes a drift between them
 * visible on the screen whose job is to explain a coupon's usage, instead of
 * only in a query somebody thinks to run.
 */
export interface CouponAdminRow {
  id: number;
  code: string;
  discountType: 'percent' | 'fixed';
  /** Basis points, set iff `discountType === 'percent'`. 1000 = 10%. */
  percentBp: number | null;
  /** Centavos, set iff `discountType === 'fixed'`. */
  amountCentavos: number | null;
  minSpendCentavos: number | null;
  /** UTC instants as ISO strings; the screen renders them in Asia/Manila. */
  startsAt: string | null;
  endsAt: string | null;
  usageLimit: number | null;
  /** The cached counter the usage cap is checked against. */
  usedCount: number;
  /** `COUNT(*)` of this coupon's `coupon_redemptions` rows — the record. */
  redemptionCount: number;
  isActive: boolean;
}

/**
 * One row of `admin.coupons.redemptions` — a coupon use, and the booking it
 * was used on.
 *
 * `discountCentavos` is what the coupon actually took off THAT booking, read
 * from the booking rather than recomputed from the coupon: a percentage
 * coupon takes a different amount off every subtotal, and the figure that
 * matters is the one the guest was charged.
 */
export interface CouponRedemptionRow {
  id: number;
  bookingId: number;
  /** The public, non-sequential ref an admin searches by (`RG-7KQ4M9`). */
  bookingRef: string;
  /** `YYYY-MM-DD`, the Manila calendar day of the tour. */
  tourDate: string;
  bookingStatus: string;
  discountCentavos: number;
  /** When the redemption was recorded, as a UTC ISO string. */
  redeemedAt: string;
}
