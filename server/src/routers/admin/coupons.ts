/**
 * `admin.coupons.*` — the coupon editing surface and the redemption log
 * (Week 7 plan, Task 8; BUILD_SPEC §9 "Coupons").
 *
 * Every procedure is `adminProcedure('toursPricing')` — §9's "Tours, pricing"
 * row, which is **owner only**, the same area `admin.tours.*` uses. A
 * dispatcher and a finance user are both refused by the gate, not by a
 * resolver finding nothing to do: these mutations set the discount a guest is
 * actually given, which is the narrowest permission in the matrix for a
 * reason.
 *
 * There is deliberately **no delete mutation**, and nothing here deletes a row
 * of any kind. A coupon is retired through `setActive(false)` (CLAUDE.md,
 * "Soft deletes"), which stops `validateCoupon()` accepting it at checkout and
 * changes nothing else: the `coupon_redemptions` rows stand, `used_count`
 * stands, and every booking that already took the discount keeps it. A coupon
 * that was hard-deleted would take its redemption rows' `coupon_id` with it —
 * and those rows are the record that a guest's discount was real.
 *
 * **Three columns on `coupons` are unreachable from this file, each for its own
 * reason:**
 *
 *  - `usedCount` — written only by `recordRedemption()` /
 *    `releaseRedemption()` in `services/coupons.ts`, inside the transaction
 *    that creates or releases a booking. Neither `create` nor `update` names
 *    it in its `.set()`, and `couponCreateInput` / `couponUpdateInput` are
 *    `.strict()`, so it cannot even be posted (see `shared/src/coupons-admin.ts`).
 *  - `isActive` — owned by `setActive` below and by nothing else, exactly as
 *    `tours.is_active` is owned by `admin.tours.setActive`.
 *  - `createdAt` / `updatedAt` — Drizzle's own `$defaultFn` / `$onUpdateFn`.
 *
 * **`update` writes BOTH discount columns every time**, one of them null. A
 * save may change a coupon from percent to fixed, and a `.set()` that only
 * wrote the column the new type uses would leave the old one populated — which
 * is precisely the state `coupons_discount_shape` refuses. The input's
 * discriminated union guarantees the pair is already well-formed; writing both
 * is what carries that guarantee into the row.
 *
 * One transaction per mutation, opened here, with the audit write inside it —
 * an audit row that survives a rollback claims a discount change that never
 * happened.
 */
import { TRPCError } from '@trpc/server';
import {
  couponActiveInput,
  couponCreateInput,
  couponRedemptionsInput,
  couponUpdateInput,
  manilaCivilDate,
  type CouponAdminRow,
  type CouponRedemptionRow,
} from '@rg/shared';
import { asc, desc, eq, sql } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { isDuplicateKeyError } from '../../db/duplicate-key';
import { bookings, couponRedemptions, coupons } from '../../db/schema';
import { writeAudit } from '../../services/audit';
import { normalizeCouponCode } from '../../services/coupons';
import { adminProcedure, router } from '../../trpc';

/** The one message for a code another coupon already holds. */
const DUPLICATE_CODE_MESSAGE = 'A coupon with that code already exists.';

/** The one message for an id that is not a coupon. */
const NOT_FOUND_MESSAGE = 'No coupon with that id.';

/**
 * Turns a duplicate-code driver error into the refusal a screen can show.
 *
 * `coupons.code` is UNIQUE, so the race is real rather than theoretical: two
 * owners saving the same code at once both pass a read-then-write check and
 * one of them gets `ER_DUP_ENTRY`. Catching the constraint rather than
 * checking first is what makes this correct under concurrency — and
 * translating it is what stops mysql2's own sentence reaching a browser
 * (BUG-021's shape; `isDuplicateKeyError` walks Drizzle's `.cause` chain,
 * because `error.code` one level up is `undefined`).
 */
function rethrowAsCodeConflict(error: unknown): never {
  if (isDuplicateKeyError(error)) {
    throw new TRPCError({ code: 'CONFLICT', message: DUPLICATE_CODE_MESSAGE });
  }
  throw error;
}

/**
 * The editable columns of a coupon, from a validated input.
 *
 * Shared by `create` and `update` so the two cannot drift about which columns
 * a save states — and so both write both discount columns (see this file's
 * header). The code is normalised through the SAME function `validateCoupon()`
 * uses on read, which is what makes the duplicate check and the eventual
 * checkout lookup agree about what "the same code" means.
 */
function couponColumns(input: {
  code: string;
  discountType: 'percent' | 'fixed';
  percentBp: number | null;
  amountCentavos: number | null;
  minSpendCentavos: number | null;
  startsAt: string | null;
  endsAt: string | null;
  usageLimit: number | null;
}) {
  return {
    code: normalizeCouponCode(input.code),
    discountType: input.discountType,
    percentBp: input.percentBp,
    amountCentavos: input.amountCentavos,
    minSpendCentavos: input.minSpendCentavos,
    // The input's ISO strings are UTC instants (`z.string().datetime()`
    // refuses an offset), so this is a parse, never a zone conversion.
    startsAt: input.startsAt === null ? null : new Date(input.startsAt),
    endsAt: input.endsAt === null ? null : new Date(input.endsAt),
    usageLimit: input.usageLimit,
  };
}

/**
 * The audit payload for a save: the code, the discount and the limits.
 *
 * All of it — a coupon has no prose, and every field here is either an
 * identifier or a number that decides how much money a guest is not charged.
 * Nothing sensitive can reach it: there is no hash, no token and no personal
 * datum anywhere on this table.
 */
function auditDataFor(columns: ReturnType<typeof couponColumns>) {
  return {
    code: columns.code,
    discountType: columns.discountType,
    percentBp: columns.percentBp,
    amountCentavos: columns.amountCentavos,
    minSpendCentavos: columns.minSpendCentavos,
    startsAt: columns.startsAt === null ? null : columns.startsAt.toISOString(),
    endsAt: columns.endsAt === null ? null : columns.endsAt.toISOString(),
    usageLimit: columns.usageLimit,
  };
}

export const adminCouponsRouter = router({
  /**
   * Every coupon, **inactive ones included** — the admin list is the only
   * place a retired coupon is visible, and therefore the only place it can be
   * switched back on.
   *
   * One query, not one per coupon: the coupons `LEFT JOIN`ed to their
   * redemptions with `COUNT()` aggregated per coupon. A `LEFT JOIN` so a
   * coupon nobody has used is still listed, with `redemptionCount: 0`.
   *
   * `usedCount` (the cached counter the cap is checked against) and
   * `redemptionCount` (the rows that are the record) are both returned, so a
   * drift between them is visible on the screen rather than only in a query
   * somebody thinks to run.
   */
  list: adminProcedure('toursPricing').query(async (): Promise<CouponAdminRow[]> => {
    const rows = await getDb()
      .select({
        id: coupons.id,
        code: coupons.code,
        discountType: coupons.discountType,
        percentBp: coupons.percentBp,
        amountCentavos: coupons.amountCentavos,
        minSpendCentavos: coupons.minSpendCentavos,
        startsAt: coupons.startsAt,
        endsAt: coupons.endsAt,
        usageLimit: coupons.usageLimit,
        usedCount: coupons.usedCount,
        isActive: coupons.isActive,
        redemptionCount: sql<string>`count(${couponRedemptions.id})`,
      })
      .from(coupons)
      .leftJoin(couponRedemptions, eq(couponRedemptions.couponId, coupons.id))
      // Every selected non-aggregate column is grouped (ONLY_FULL_GROUP_BY).
      .groupBy(
        coupons.id,
        coupons.code,
        coupons.discountType,
        coupons.percentBp,
        coupons.amountCentavos,
        coupons.minSpendCentavos,
        coupons.startsAt,
        coupons.endsAt,
        coupons.usageLimit,
        coupons.usedCount,
        coupons.isActive,
      )
      .orderBy(asc(coupons.code));

    return rows.map((row) => ({
      id: row.id,
      code: row.code,
      discountType: row.discountType,
      percentBp: row.percentBp,
      amountCentavos: row.amountCentavos,
      minSpendCentavos: row.minSpendCentavos,
      // UTC instants out as UTC instants: the SCREEN converts to Manila.
      startsAt: row.startsAt === null ? null : row.startsAt.toISOString(),
      endsAt: row.endsAt === null ? null : row.endsAt.toISOString(),
      usageLimit: row.usageLimit,
      usedCount: row.usedCount,
      // MySQL returns COUNT() as a string through mysql2.
      redemptionCount: Number(row.redemptionCount),
      isActive: row.isActive,
    }));
  }),

  create: adminProcedure('toursPricing')
    .input(couponCreateInput)
    .mutation(async ({ input, ctx }) => {
      const columns = couponColumns(input);
      try {
        const id = await getDb().transaction(async (tx) => {
          const [result] = await tx.insert(coupons).values(columns);
          await writeAudit(tx, {
            actorType: 'user',
            actorId: ctx.adminSession.subjectId,
            action: 'coupon.created',
            entity: 'coupon',
            entityId: result.insertId,
            data: auditDataFor(columns),
          });
          return result.insertId;
        });
        return { id };
      } catch (error) {
        rethrowAsCodeConflict(error);
      }
    }),

  /**
   * A full replacement of the editable columns, never a patch — see
   * `shared/src/coupons-admin.ts` for why an omitted `endsAt` has no safe
   * meaning.
   *
   * It touches neither `used_count` nor `is_active`: a coupon that has been
   * redeemed twice and then repriced has still been redeemed twice, and an
   * edit is not a way to switch a retired coupon back on.
   */
  update: adminProcedure('toursPricing')
    .input(couponUpdateInput)
    .mutation(async ({ input, ctx }) => {
      const columns = couponColumns(input);
      try {
        await getDb().transaction(async (tx) => {
          const [result] = await tx.update(coupons).set(columns).where(eq(coupons.id, input.id));
          /*
           * `affectedRows === 0` is an exact "no such coupon" here, and that
           * is a measured fact about THIS pool rather than an assumption:
           * mysql2 sets `CLIENT_FOUND_ROWS` in its default client flags and
           * `db/client.ts` turns it off nowhere, so `affectedRows` is the
           * MATCHED count — a save that rewrites a coupon with the values it
           * already holds still reports 1. (See the measurement in
           * `db/client.ts`'s header; this codebase has believed the opposite
           * twice, which is why it is restated rather than assumed.)
           */
          if (result.affectedRows === 0) {
            throw new TRPCError({ code: 'NOT_FOUND', message: NOT_FOUND_MESSAGE });
          }
          await writeAudit(tx, {
            actorType: 'user',
            actorId: ctx.adminSession.subjectId,
            action: 'coupon.updated',
            entity: 'coupon',
            entityId: input.id,
            data: auditDataFor(columns),
          });
        });
        return { ok: true as const };
      } catch (error) {
        rethrowAsCodeConflict(error);
      }
    }),

  /**
   * The soft delete, and the only writer of `coupons.is_active`.
   *
   * Deactivating makes `validateCoupon()` refuse the code with
   * `CouponInactiveError` — a guest typing it at checkout is told it is not
   * active — and changes nothing else. It deliberately does NOT touch the
   * bookings that already used it, their `discount_centavos`, the
   * `coupon_redemptions` rows or `used_count`: the van really did carry those
   * guests at that price, and unwinding it here would be the worse record.
   *
   * Two dotted audit actions rather than one `coupon.active_set` with a flag
   * in the payload — "who switched this coupon off" is the question an owner
   * asks, and it should not need a payload to answer. The same shape
   * `admin.tours.setActive` and `admin.drivers.setActive` use.
   */
  setActive: adminProcedure('toursPricing')
    .input(couponActiveInput)
    .mutation(async ({ input, ctx }) => {
      await getDb().transaction(async (tx) => {
        const [row] = await tx
          .select({ code: coupons.code })
          .from(coupons)
          .where(eq(coupons.id, input.id));
        if (!row) {
          throw new TRPCError({ code: 'NOT_FOUND', message: NOT_FOUND_MESSAGE });
        }

        await tx.update(coupons).set({ isActive: input.isActive }).where(eq(coupons.id, input.id));

        await writeAudit(tx, {
          actorType: 'user',
          actorId: ctx.adminSession.subjectId,
          action: input.isActive ? 'coupon.reactivated' : 'coupon.deactivated',
          entity: 'coupon',
          entityId: input.id,
          data: { code: row.code, isActive: input.isActive },
        });
      });
      return { ok: true as const };
    }),

  /**
   * The redemption log: every booking that has used this coupon, newest use
   * first.
   *
   * `coupon_redemptions` is the RECORD behind `used_count`'s cached number
   * (the table's own doc comment), and this is the screen that reads it. The
   * join to `bookings` is an `innerJoin` because `coupon_redemptions.booking_id`
   * is `NOT NULL` with a RESTRICT foreign key — a redemption without a booking
   * cannot exist, so a `LEFT JOIN` would only invite a nullable column nobody
   * can produce.
   *
   * `discountCentavos` comes from the BOOKING, not from the coupon: a
   * percentage coupon takes a different amount off every subtotal, and the
   * figure worth logging is the one the guest was actually charged.
   *
   * It answers `NOT_FOUND` for a coupon that does not exist rather than an
   * empty array, so "this coupon has never been used" and "there is no such
   * coupon" do not read identically on the screen. No personal data is
   * returned — the ref, the date, the status and the discount, never the
   * guest's name, email or phone (RA 10173: the log answers "was this coupon
   * used and for how much", not "who used it").
   */
  redemptions: adminProcedure('toursPricing')
    .input(couponRedemptionsInput)
    .query(async ({ input }): Promise<CouponRedemptionRow[]> => {
      const db = getDb();
      const [coupon] = await db
        .select({ id: coupons.id })
        .from(coupons)
        .where(eq(coupons.id, input.couponId));
      if (!coupon) {
        throw new TRPCError({ code: 'NOT_FOUND', message: NOT_FOUND_MESSAGE });
      }

      const rows = await db
        .select({
          id: couponRedemptions.id,
          bookingId: bookings.id,
          bookingRef: bookings.ref,
          tourDate: bookings.tourDate,
          bookingStatus: bookings.status,
          discountCentavos: bookings.discountCentavos,
          redeemedAt: couponRedemptions.createdAt,
        })
        .from(couponRedemptions)
        .innerJoin(bookings, eq(bookings.id, couponRedemptions.bookingId))
        .where(eq(couponRedemptions.couponId, input.couponId))
        // `id` after `created_at`: two redemptions inside one transaction share
        // an instant, and a log needs a total order.
        .orderBy(desc(couponRedemptions.createdAt), desc(couponRedemptions.id));

      return rows.map((row) => ({
        id: row.id,
        bookingId: row.bookingId,
        bookingRef: row.bookingRef,
        // The Manila civil date, never a UTC timestamp sliced into a date.
        tourDate: manilaCivilDate(row.tourDate),
        bookingStatus: row.bookingStatus,
        discountCentavos: row.discountCentavos,
        redeemedAt: row.redeemedAt.toISOString(),
      }));
    }),
});
