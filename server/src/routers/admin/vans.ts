/**
 * `admin.vans.*` — the fleet CRUD surface (Week 5 plan, Task 4; BUILD_SPEC
 * §9 "Vans" / §5A).
 *
 * Every procedure is `adminProcedure('vansDrivers')` — §9's "Vans, drivers"
 * row: owner and dispatcher, never finance. There is deliberately no
 * delete mutation: a van is soft-deleted through `is_active` (CLAUDE.md,
 * "Never hard-delete"), and the procedure-enumeration test in
 * `admin-vans.test.ts` exists to keep a fifth procedure from quietly
 * reopening that door.
 *
 * `create` and `update` run inside a transaction with `writeAudit`, so an
 * audit row never survives a rolled-back write and a write never lands
 * without one. `setStatus` is split out from `update` on purpose — it is
 * the one administrative field §9 calls out by name, and giving it its own
 * procedure keeps `vanInputSchema.strict()` closed to it (a client cannot
 * smuggle a status change through the CRUD door).
 *
 * The four date columns (`last_service`, `next_service`, `orcr_expiry`,
 * `franchise_expiry`) are Drizzle `date()` columns, which type as `Date` —
 * not the `YYYY-MM-DD` string every civil date in this project's own logic
 * uses. The conversion happens at this boundary, both ways: a wire string
 * becomes a UTC midnight `Date` going in, and a `Date` becomes a Manila
 * civil-date string coming out (`manilaCivilDate`, the same helper
 * `admin.bookings` already uses for `tour_date`).
 */
import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { civilDateFromDate, vanInputSchema, type VanInput, type VanRow } from '@rg/shared';
import { asc, eq } from 'drizzle-orm';
import { getDb, type Transaction } from '../../db/client';
import { isDuplicateKeyError } from '../../db/duplicate-key';
import { VAN_STATUSES, vans, vehicleTypes } from '../../db/schema';
import { writeAudit } from '../../services/audit';
import { adminProcedure, router } from '../../trpc';

/** The van row shape as Drizzle selects it, before the wire conversion below. */
type VanSelect = typeof vans.$inferSelect;
/** The van row shape Drizzle's `.values()` / `.set()` want. */
type VanInsert = typeof vans.$inferInsert;

/** A wire civil-date string to the UTC-midnight `Date` the `date()` column wants. */
function toDbDate(value: string | null): Date | null {
  return value === null ? null : new Date(`${value}T00:00:00Z`);
}

/**
 * `vehicleTypeName` is read from the `vehicle_types` join `list` performs
 * (owner decision 2026-11-08: vehicle types are an admin-managed list, not a
 * `van`/`suv` enum) — this function never queries for it itself, so every
 * caller must select it alongside the van's own columns.
 */
function toVanRow(row: VanSelect, vehicleTypeName: string): VanRow {
  return {
    id: row.id,
    plate: row.plate,
    model: row.model,
    capacity: row.capacity,
    luggageCapacity: row.luggageCapacity,
    vehicleTypeId: row.vehicleTypeId,
    vehicleTypeName,
    status: row.status,
    odometer: row.odometer,
    lastService: civilDateFromDate(row.lastService),
    nextService: civilDateFromDate(row.nextService),
    orcrExpiry: civilDateFromDate(row.orcrExpiry),
    franchiseNo: row.franchiseNo,
    franchiseExpiry: civilDateFromDate(row.franchiseExpiry),
    repairNotes: row.repairNotes,
    isActive: row.isActive,
  };
}

/** A full `vanInputSchema` parse, as the column values `create`'s INSERT wants. */
function toInsertValues(input: VanInput): VanInsert {
  return {
    plate: input.plate,
    model: input.model,
    capacity: input.capacity,
    luggageCapacity: input.luggageCapacity,
    vehicleTypeId: input.vehicleTypeId,
    odometer: input.odometer,
    lastService: toDbDate(input.lastService),
    nextService: toDbDate(input.nextService),
    orcrExpiry: toDbDate(input.orcrExpiry),
    franchiseNo: input.franchiseNo,
    franchiseExpiry: toDbDate(input.franchiseExpiry),
    repairNotes: input.repairNotes,
  };
}

/**
 * A `vanInputSchema.partial()` parse, as the column values `update`'s SET
 * wants — only the keys the caller actually sent, each individually, so an
 * omitted field in the patch leaves the column untouched rather than
 * overwriting it with `undefined`.
 */
function toUpdateValues(patch: Partial<VanInput>): Partial<VanInsert> {
  const out: Partial<VanInsert> = {};
  if (patch.plate !== undefined) out.plate = patch.plate;
  if (patch.model !== undefined) out.model = patch.model;
  if (patch.capacity !== undefined) out.capacity = patch.capacity;
  if (patch.luggageCapacity !== undefined) out.luggageCapacity = patch.luggageCapacity;
  if (patch.vehicleTypeId !== undefined) out.vehicleTypeId = patch.vehicleTypeId;
  if (patch.odometer !== undefined) out.odometer = patch.odometer;
  if (patch.lastService !== undefined) out.lastService = toDbDate(patch.lastService);
  if (patch.nextService !== undefined) out.nextService = toDbDate(patch.nextService);
  if (patch.orcrExpiry !== undefined) out.orcrExpiry = toDbDate(patch.orcrExpiry);
  if (patch.franchiseNo !== undefined) out.franchiseNo = patch.franchiseNo;
  if (patch.franchiseExpiry !== undefined) out.franchiseExpiry = toDbDate(patch.franchiseExpiry);
  if (patch.repairNotes !== undefined) out.repairNotes = patch.repairNotes;
  return out;
}

/** The duplicate-plate message both `create` and `update` throw, worded for a human. */
const DUPLICATE_PLATE_MESSAGE = 'A van with that plate number already exists.';

/** The refusal for a `vehicleTypeId` no `vehicle_types` row answers to. */
const UNKNOWN_VEHICLE_TYPE_MESSAGE = 'No vehicle type with that id.';

/**
 * Before 2026-11-08, an invalid vehicle type was a Zod `BAD_REQUEST`
 * (`z.enum(VEHICLE_TYPES)`) — the enum made every bad value a shape error at
 * the wire boundary. Now that `vehicleTypeId` is a bare FK, Zod only checks
 * "is this a positive integer," so an id that answers to no row would
 * otherwise reach `vans_vehicle_type_id_vehicle_types_id_fk` as a raw
 * `ER_NO_REFERENCED_ROW_2` — `isDuplicateKeyError` only matches
 * `ER_DUP_ENTRY`, so that error would rethrow as an `INTERNAL_SERVER_ERROR`
 * the admin screen could say nothing useful about. This restores the same
 * guest/admin-safe `BAD_REQUEST` the enum used to give, mirroring
 * `transfer-places.ts`'s `assertDestinationExists` pattern exactly.
 */
async function assertVehicleTypeExists(tx: Transaction, vehicleTypeId: number) {
  const [row] = await tx
    .select({ id: vehicleTypes.id })
    .from(vehicleTypes)
    .where(eq(vehicleTypes.id, vehicleTypeId))
    .limit(1);
  if (!row) {
    throw new TRPCError({ code: 'BAD_REQUEST', message: UNKNOWN_VEHICLE_TYPE_MESSAGE });
  }
}

/**
 * `vanInputSchema.partial()`, refined to require at least one key.
 *
 * Fix round 1: an empty `{}` patch used to skip both the `.update()` call
 * and the `affectedRows === 0` existence check that comes with it, while
 * still committing a `van_updated` audit row — a row that claims a change
 * happened (or even that the van exists) when neither is true. A request
 * that changes nothing is a client bug, and the right answer is a
 * validation error at the Zod boundary, not a silent no-op with a paper
 * trail. `.partial()` is called first so the refinement sees the already-
 * optional shape; `.strict()` on `vanInputSchema` carries through `.partial()`
 * (proven by `admin-vans.test.ts`'s "rejects an unknown field in update's
 * patch" test) and is unaffected by the `.refine()` wrapping it.
 */
const vanPatchSchema = vanInputSchema.partial().refine((patch) => Object.keys(patch).length > 0, {
  message: 'Provide at least one field to update.',
});

const updateInput = z.object({ id: z.number().int().positive(), patch: vanPatchSchema }).strict();

const setStatusInput = z
  .object({ id: z.number().int().positive(), status: z.enum(VAN_STATUSES) })
  .strict();

export const adminVansRouter = router({
  /**
   * Every van, each with its vehicle type's CURRENT name (owner decision
   * 2026-11-08) — joined rather than read per row, the same reasoning every
   * other admin list in this codebase gives for avoiding an N+1.
   */
  list: adminProcedure('vansDrivers').query(async () => {
    const rows = await getDb()
      .select({ van: vans, vehicleTypeName: vehicleTypes.name })
      .from(vans)
      .innerJoin(vehicleTypes, eq(vehicleTypes.id, vans.vehicleTypeId))
      .orderBy(asc(vans.plate));
    return rows.map((row) => toVanRow(row.van, row.vehicleTypeName));
  }),

  create: adminProcedure('vansDrivers')
    .input(vanInputSchema)
    .mutation(async ({ input, ctx }) => {
      try {
        return await getDb().transaction(async (tx) => {
          await assertVehicleTypeExists(tx, input.vehicleTypeId);
          const [result] = await tx.insert(vans).values(toInsertValues(input));
          const id = result.insertId;
          await writeAudit(tx, {
            actorType: 'user',
            actorId: ctx.adminSession.subjectId,
            action: 'van_created',
            entity: 'van',
            entityId: id,
            data: { plate: input.plate },
          });
          return { id };
        });
      } catch (error) {
        if (isDuplicateKeyError(error)) {
          throw new TRPCError({ code: 'CONFLICT', message: DUPLICATE_PLATE_MESSAGE });
        }
        throw error;
      }
    }),

  update: adminProcedure('vansDrivers')
    .input(updateInput)
    .mutation(async ({ input, ctx }) => {
      try {
        await getDb().transaction(async (tx) => {
          /*
           * No `if (Object.keys(setValues).length > 0)` guard here — Fix
           * round 1 removed it rather than keeping it as a "defensive"
           * belt. `vanPatchSchema`'s refine already guarantees `input.patch`
           * is non-empty, every key in it is one of the ten fields
           * `toUpdateValues` maps 1:1 (`.strict()` forbids any other key),
           * so `setValues` cannot be empty either — the guard was dead code
           * that happened to also be the ONLY path that could ever audit a
           * change without the existence check running first. Removing it
           * makes "check existence, then audit" unconditional instead of
           * correct-by-the-current-shape-of-the-schema.
           */
          if (input.patch.vehicleTypeId !== undefined) {
            await assertVehicleTypeExists(tx, input.patch.vehicleTypeId);
          }
          const setValues = toUpdateValues(input.patch);
          const [result] = await tx.update(vans).set(setValues).where(eq(vans.id, input.id));
          if (result.affectedRows === 0) {
            throw new TRPCError({ code: 'NOT_FOUND', message: 'No van with that id.' });
          }
          await writeAudit(tx, {
            actorType: 'user',
            actorId: ctx.adminSession.subjectId,
            action: 'van_updated',
            entity: 'van',
            entityId: input.id,
            data: input.patch,
          });
        });
        return { ok: true as const };
      } catch (error) {
        if (isDuplicateKeyError(error)) {
          throw new TRPCError({ code: 'CONFLICT', message: DUPLICATE_PLATE_MESSAGE });
        }
        throw error;
      }
    }),

  setStatus: adminProcedure('vansDrivers')
    .input(setStatusInput)
    .mutation(async ({ input, ctx }) => {
      await getDb().transaction(async (tx) => {
        const [result] = await tx
          .update(vans)
          .set({ status: input.status })
          .where(eq(vans.id, input.id));
        if (result.affectedRows === 0) {
          throw new TRPCError({ code: 'NOT_FOUND', message: 'No van with that id.' });
        }
        await writeAudit(tx, {
          actorType: 'user',
          actorId: ctx.adminSession.subjectId,
          action: 'van_status_changed',
          entity: 'van',
          entityId: input.id,
          data: { status: input.status },
        });
      });
      return { ok: true as const };
    }),
});
