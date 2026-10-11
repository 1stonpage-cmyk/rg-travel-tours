/**
 * Coupon discounts, shared by client and server.
 *
 * Money is integer CENTAVOS everywhere (CLAUDE.md), and a percentage is
 * integer BASIS POINTS — there is no float in this module and none anywhere
 * near a discount calculation.
 */
import { z } from 'zod';

/** Which of a coupon's two discount columns is in use. */
export const DISCOUNT_TYPES = ['percent', 'fixed'] as const;
export type DiscountType = (typeof DISCOUNT_TYPES)[number];
export const discountTypeSchema = z.enum(DISCOUNT_TYPES);

/**
 * A coupon's discount, as a discriminated union — so TypeScript makes the
 * invalid combinations unrepresentable in code, the same way the
 * `coupons_discount_shape` CHECK constraint makes them unrepresentable in
 * the database (owner decision 2026-10-11, Q6).
 *
 * The four shapes this rejects are exactly the four the CHECK rejects:
 * percent with centavos set, fixed with basis points set, both set, neither
 * set. Zod catches them at the API boundary; the CHECK catches them when a
 * seed script, a migration or a hand-written UPDATE skips the API entirely.
 *
 * `percentBp` is BASIS POINTS: 1000 = 10%, 250 = 2.5%, 10000 = 100%. Whole
 * percent ints cannot express the 2.5% a marketing campaign asks for without
 * another schema change, and a float has no business anywhere near money.
 *
 * `amountCentavos` must be positive: a zero discount is not a coupon, it is a
 * coupon that silently does nothing — which is the failure mode this whole
 * three-column design exists to prevent.
 */
export const couponDiscountSchema = z.discriminatedUnion('discountType', [
  z.object({
    discountType: z.literal('percent'),
    percentBp: z.number().int().min(1).max(10000),
    amountCentavos: z.null(),
  }),
  z.object({
    discountType: z.literal('fixed'),
    percentBp: z.null(),
    amountCentavos: z.number().int().positive(),
  }),
]);
export type CouponDiscount = z.infer<typeof couponDiscountSchema>;
