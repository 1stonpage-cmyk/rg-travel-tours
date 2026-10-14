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
import { manilaCivilDate, vanInputSchema, type VanInput, type VanRow } from '@rg/shared';
import { asc, eq } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { isDuplicateKeyError } from '../../db/duplicate-key';
import { VAN_STATUSES, vans } from '../../db/schema';
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

/** The DB's `Date` (or null) back to the `YYYY-MM-DD` string every caller else uses. */
function toCivilDate(value: Date | null): string | null {
  return value === null ? null : manilaCivilDate(value);
}

function toVanRow(row: VanSelect): VanRow {
  return {
    id: row.id,
    plate: row.plate,
    model: row.model,
    capacity: row.capacity,
    status: row.status,
    odometer: row.odometer,
    lastService: toCivilDate(row.lastService),
    nextService: toCivilDate(row.nextService),
    orcrExpiry: toCivilDate(row.orcrExpiry),
    franchiseNo: row.franchiseNo,
    franchiseExpiry: toCivilDate(row.franchiseExpiry),
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
  list: adminProcedure('vansDrivers').query(async () => {
    const rows = await getDb().select().from(vans).orderBy(asc(vans.plate));
    return rows.map(toVanRow);
  }),

  create: adminProcedure('vansDrivers')
    .input(vanInputSchema)
    .mutation(async ({ input, ctx }) => {
      try {
        return await getDb().transaction(async (tx) => {
          const [result] = await tx.insert(vans).values(toInsertValues(input));
          const id = result.insertId;
          await writeAudit(tx, {
            actorType: 'user',
            actorId: ctx.session.subjectId,
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
          const setValues = toUpdateValues(input.patch);
          const [result] = await tx.update(vans).set(setValues).where(eq(vans.id, input.id));
          if (result.affectedRows === 0) {
            throw new TRPCError({ code: 'NOT_FOUND', message: 'No van with that id.' });
          }
          await writeAudit(tx, {
            actorType: 'user',
            actorId: ctx.session.subjectId,
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
          actorId: ctx.session.subjectId,
          action: 'van_status_changed',
          entity: 'van',
          entityId: input.id,
          data: { status: input.status },
        });
      });
      return { ok: true as const };
    }),
});
