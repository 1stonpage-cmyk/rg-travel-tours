/**
 * `admin.vehicleTypes.*` — the admin-managed vehicle-type catalog (owner
 * decision 2026-11-08: flexible places/routes/vehicle types — see
 * `docs/superpowers/plans/2026-11-08-flexible-routes.md` §1.1/§2). Before this
 * decision, "van"/"suv" was a hard-coded two-member enum (`VEHICLE_TYPES`);
 * now it is a runtime-managed list vans, bookings and transfer route prices
 * all reference by id.
 *
 * Every procedure is `adminProcedure('toursPricing')` — the SAME owner-only
 * area `admin.transferRoutes.*` and `admin.tours.*` already use, reused
 * rather than adding a thirteenth `ROLE_MATRIX` row (the design note's own
 * instruction): a vehicle type backs the per-route price a guest is charged
 * for a van, exactly as a tour's per-person tier does, so it belongs behind
 * the narrowest row in the matrix.
 *
 * There is deliberately no delete mutation. A vehicle type is retired
 * through `setActive(false)` (CLAUDE.md, "Soft deletes") — and it could
 * never be hard-deleted once referenced anyway: `vans.vehicle_type_id`,
 * `bookings.vehicle_type_id` and `transfer_route_vehicle_prices
 * .vehicle_type_id` are all RESTRICT foreign keys onto this table.
 *
 * One transaction per mutation, opened here, with `writeAudit` inside it —
 * an audit row that survives a rollback would claim a change that never
 * happened.
 */
import { TRPCError } from '@trpc/server';
import {
  vehicleTypeActiveInputSchema,
  vehicleTypeCreateInputSchema,
  vehicleTypeUpdateInputSchema,
  type VehicleTypeAdminRow,
} from '@rg/shared';
import { asc, eq } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { isDuplicateKeyError } from '../../db/duplicate-key';
import { vehicleTypes } from '../../db/schema';
import { writeAudit } from '../../services/audit';
import { adminProcedure, router } from '../../trpc';

/** `vehicle_types.slug` is UNIQUE; both `create` and `update` can race it. */
const DUPLICATE_SLUG_MESSAGE = 'A vehicle type with that slug already exists.';

/** The refusal for an `id` no vehicle type answers to. */
const UNKNOWN_VEHICLE_TYPE_MESSAGE = 'No vehicle type with that id.';

type VehicleTypeSelect = typeof vehicleTypes.$inferSelect;
type VehicleTypeInsert = typeof vehicleTypes.$inferInsert;

function toRow(row: VehicleTypeSelect): VehicleTypeAdminRow {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    defaultSeats: row.defaultSeats,
    defaultLuggage: row.defaultLuggage,
    isActive: row.isActive,
    sortOrder: row.sortOrder,
  };
}

export const adminVehicleTypesRouter = router({
  /** Every vehicle type, inactive ones included — the admin screen is the only place a retired one is visible. */
  list: adminProcedure('toursPricing').query(async (): Promise<VehicleTypeAdminRow[]> => {
    const rows = await getDb()
      .select()
      .from(vehicleTypes)
      .orderBy(asc(vehicleTypes.sortOrder), asc(vehicleTypes.name));
    return rows.map(toRow);
  }),

  create: adminProcedure('toursPricing')
    .input(vehicleTypeCreateInputSchema)
    .mutation(async ({ input, ctx }) => {
      try {
        return await getDb().transaction(async (tx) => {
          const [result] = await tx.insert(vehicleTypes).values({
            name: input.name,
            slug: input.slug,
            defaultSeats: input.defaultSeats,
            defaultLuggage: input.defaultLuggage,
            sortOrder: input.sortOrder ?? 0,
          });
          const id = result.insertId;
          await writeAudit(tx, {
            actorType: 'user',
            actorId: ctx.adminSession.subjectId,
            action: 'vehicle_type_created',
            entity: 'vehicle_type',
            entityId: id,
            data: { name: input.name, slug: input.slug },
          });
          return { id };
        });
      } catch (error) {
        if (isDuplicateKeyError(error)) {
          throw new TRPCError({ code: 'CONFLICT', message: DUPLICATE_SLUG_MESSAGE });
        }
        throw error;
      }
    }),

  /**
   * A patch over a stored vehicle type. Only the keys the caller sent are
   * written — the same "state only what changed" shape `admin.vans.update`
   * uses — because nothing about this row needs a read-modify-write of a
   * child table the way a route's price card does.
   */
  update: adminProcedure('toursPricing')
    .input(vehicleTypeUpdateInputSchema)
    .mutation(async ({ input, ctx }) => {
      try {
        await getDb().transaction(async (tx) => {
          const setValues: Partial<VehicleTypeInsert> = {};
          if (input.patch.name !== undefined) setValues.name = input.patch.name;
          if (input.patch.slug !== undefined) setValues.slug = input.patch.slug;
          if (input.patch.defaultSeats !== undefined) {
            setValues.defaultSeats = input.patch.defaultSeats;
          }
          if (input.patch.defaultLuggage !== undefined) {
            setValues.defaultLuggage = input.patch.defaultLuggage;
          }
          if (input.patch.sortOrder !== undefined) setValues.sortOrder = input.patch.sortOrder;

          const [result] = await tx
            .update(vehicleTypes)
            .set(setValues)
            .where(eq(vehicleTypes.id, input.id));
          if (result.affectedRows === 0) {
            throw new TRPCError({ code: 'NOT_FOUND', message: UNKNOWN_VEHICLE_TYPE_MESSAGE });
          }
          await writeAudit(tx, {
            actorType: 'user',
            actorId: ctx.adminSession.subjectId,
            action: 'vehicle_type_updated',
            entity: 'vehicle_type',
            entityId: input.id,
            data: input.patch,
          });
        });
        return { ok: true as const };
      } catch (error) {
        if (isDuplicateKeyError(error)) {
          throw new TRPCError({ code: 'CONFLICT', message: DUPLICATE_SLUG_MESSAGE });
        }
        throw error;
      }
    }),

  /**
   * The soft delete, and the only writer of `vehicle_types.is_active`.
   * Deactivating stops the type being offered on `transferRoutes.list` and
   * being a valid choice for a new van (`vanInputSchema.vehicleTypeId`
   * itself does not check `isActive` — that is a router/service concern, not
   * a Zod one) — it changes nothing already written: an existing van keeps
   * its type, and an existing booking keeps its frozen snapshot.
   */
  setActive: adminProcedure('toursPricing')
    .input(vehicleTypeActiveInputSchema)
    .mutation(async ({ input, ctx }) => {
      await getDb().transaction(async (tx) => {
        const [result] = await tx
          .update(vehicleTypes)
          .set({ isActive: input.isActive })
          .where(eq(vehicleTypes.id, input.id));
        if (result.affectedRows === 0) {
          throw new TRPCError({ code: 'NOT_FOUND', message: UNKNOWN_VEHICLE_TYPE_MESSAGE });
        }
        await writeAudit(tx, {
          actorType: 'user',
          actorId: ctx.adminSession.subjectId,
          action: 'vehicle_type_active_changed',
          entity: 'vehicle_type',
          entityId: input.id,
          data: { isActive: input.isActive },
        });
      });
      return { ok: true as const };
    }),
});
