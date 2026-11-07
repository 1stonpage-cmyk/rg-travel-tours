/**
 * `admin.transferPlaces.*` — the admin-managed pickup/drop-off place catalog
 * (owner decision 2026-11-08: flexible places/routes/vehicle types — see
 * `docs/superpowers/plans/2026-11-08-flexible-routes.md` §1.2). Places are
 * what a `transfer_routes` row now runs BETWEEN (`fromPlaceId`/`toPlaceId`),
 * replacing the old "a route is anchored on an existing destination" design.
 *
 * Every procedure is `adminProcedure('toursPricing')` — the SAME owner-only
 * area `admin.transferRoutes.*` and `admin.vehicleTypes.*` use. No new
 * `ROLE_MATRIX` area.
 *
 * **`nameKey` is this router's job to write, never the database's.**
 * `name_key = name.trim().toLowerCase()` is what actually enforces "unique,
 * case-insensitively, after trimming" (owner decision 1) — the same lesson
 * BUG-107/BUG-108 already taught this codebase about `coupons.code` and
 * `bookings.ref`: normalise explicitly, never lean on a column's default
 * collation. A duplicate surfaces as `ER_DUP_ENTRY` on `name_key` and is
 * translated below, the same way `upsertTransferRoute()` translates its own.
 *
 * `destinationId` is validated against `destinations` before any write —
 * `transfer_places.destination_id` is a real (nullable) foreign key, so an
 * unknown id would otherwise surface as a driver error the screen can say
 * nothing about.
 *
 * There is deliberately no delete mutation: a place is retired through
 * `setActive` (CLAUDE.md, "Soft deletes"), and `transfer_routes
 * .from_place_id`/`.to_place_id` are RESTRICT foreign keys that would refuse
 * a hard delete the moment any route references it.
 *
 * One transaction per mutation, opened here, with `writeAudit` inside it.
 */
import { TRPCError } from '@trpc/server';
import {
  transferPlaceActiveInputSchema,
  transferPlaceCreateInputSchema,
  transferPlaceUpdateInputSchema,
  type TransferPlaceAdminListRow,
} from '@rg/shared';
import { asc, eq } from 'drizzle-orm';
import type { Transaction } from '../../db/client';
import { getDb } from '../../db/client';
import { isDuplicateKeyError } from '../../db/duplicate-key';
import { destinations, transferPlaces } from '../../db/schema';
import { writeAudit } from '../../services/audit';
import { adminProcedure, router } from '../../trpc';

/** The refusal for an `id` no transfer place answers to. */
const UNKNOWN_TRANSFER_PLACE_MESSAGE = 'No transfer place with that id.';

/** The refusal for a `destinationId` no destination answers to. */
const UNKNOWN_DESTINATION_MESSAGE = 'No destination with that id.';

/** `name_key`'s UNIQUE, translated for a human — names the place, not mysql2's own sentence. */
function duplicatePlaceMessage(name: string): string {
  return `A transfer place named "${name.trim()}" already exists.`;
}

/** The one normalisation `transfer_places.name_key` is built from. See this file's header. */
function nameKeyFor(name: string): string {
  return name.trim().toLowerCase();
}

/**
 * `destinationId` is nullable and optional cross-link only — `null` is
 * always a legitimate value and is never checked against anything.
 */
async function assertDestinationExists(tx: Transaction, destinationId: number | null) {
  if (destinationId === null) return;
  const [row] = await tx
    .select({ id: destinations.id })
    .from(destinations)
    .where(eq(destinations.id, destinationId))
    .limit(1);
  if (!row) {
    throw new TRPCError({ code: 'BAD_REQUEST', message: UNKNOWN_DESTINATION_MESSAGE });
  }
}

type TransferPlaceSelect = typeof transferPlaces.$inferSelect;
type TransferPlaceInsert = typeof transferPlaces.$inferInsert;

function toRow(row: TransferPlaceSelect): TransferPlaceAdminListRow {
  return {
    id: row.id,
    name: row.name,
    isAirport: row.isAirport,
    isActive: row.isActive,
    sortOrder: row.sortOrder,
    destinationId: row.destinationId,
  };
}

export const adminTransferPlacesRouter = router({
  /** Every place, inactive ones included. */
  list: adminProcedure('toursPricing').query(async (): Promise<TransferPlaceAdminListRow[]> => {
    const rows = await getDb()
      .select()
      .from(transferPlaces)
      .orderBy(asc(transferPlaces.sortOrder), asc(transferPlaces.name));
    return rows.map(toRow);
  }),

  create: adminProcedure('toursPricing')
    .input(transferPlaceCreateInputSchema)
    .mutation(async ({ input, ctx }) => {
      try {
        return await getDb().transaction(async (tx) => {
          await assertDestinationExists(tx, input.destinationId);
          const [result] = await tx.insert(transferPlaces).values({
            name: input.name,
            nameKey: nameKeyFor(input.name),
            isAirport: input.isAirport,
            sortOrder: input.sortOrder ?? 0,
            destinationId: input.destinationId,
          });
          const id = result.insertId;
          await writeAudit(tx, {
            actorType: 'user',
            actorId: ctx.adminSession.subjectId,
            action: 'transfer_place_created',
            entity: 'transfer_place',
            entityId: id,
            data: { name: input.name, isAirport: input.isAirport },
          });
          return { id };
        });
      } catch (error) {
        if (isDuplicateKeyError(error)) {
          throw new TRPCError({ code: 'CONFLICT', message: duplicatePlaceMessage(input.name) });
        }
        throw error;
      }
    }),

  update: adminProcedure('toursPricing')
    .input(transferPlaceUpdateInputSchema)
    .mutation(async ({ input, ctx }) => {
      try {
        await getDb().transaction(async (tx) => {
          if (input.patch.destinationId !== undefined) {
            await assertDestinationExists(tx, input.patch.destinationId);
          }

          const setValues: Partial<TransferPlaceInsert> = {};
          if (input.patch.name !== undefined) {
            setValues.name = input.patch.name;
            setValues.nameKey = nameKeyFor(input.patch.name);
          }
          if (input.patch.isAirport !== undefined) setValues.isAirport = input.patch.isAirport;
          if (input.patch.sortOrder !== undefined) setValues.sortOrder = input.patch.sortOrder;
          if (input.patch.destinationId !== undefined) {
            setValues.destinationId = input.patch.destinationId;
          }

          const [result] = await tx
            .update(transferPlaces)
            .set(setValues)
            .where(eq(transferPlaces.id, input.id));
          if (result.affectedRows === 0) {
            throw new TRPCError({ code: 'NOT_FOUND', message: UNKNOWN_TRANSFER_PLACE_MESSAGE });
          }
          await writeAudit(tx, {
            actorType: 'user',
            actorId: ctx.adminSession.subjectId,
            action: 'transfer_place_updated',
            entity: 'transfer_place',
            entityId: input.id,
            data: input.patch,
          });
        });
        return { ok: true as const };
      } catch (error) {
        if (isDuplicateKeyError(error)) {
          throw new TRPCError({
            code: 'CONFLICT',
            message: duplicatePlaceMessage(input.patch.name ?? ''),
          });
        }
        throw error;
      }
    }),

  /**
   * The soft delete. Deactivating stops the place's routes being sellable
   * (both ends must be active — the retargeted "0D" rule) and changes
   * nothing already written: a booking already held carries its own
   * `price_snapshot`, and a route's own `isActive` is untouched.
   */
  setActive: adminProcedure('toursPricing')
    .input(transferPlaceActiveInputSchema)
    .mutation(async ({ input, ctx }) => {
      await getDb().transaction(async (tx) => {
        const [result] = await tx
          .update(transferPlaces)
          .set({ isActive: input.isActive })
          .where(eq(transferPlaces.id, input.id));
        if (result.affectedRows === 0) {
          throw new TRPCError({ code: 'NOT_FOUND', message: UNKNOWN_TRANSFER_PLACE_MESSAGE });
        }
        await writeAudit(tx, {
          actorType: 'user',
          actorId: ctx.adminSession.subjectId,
          action: 'transfer_place_active_changed',
          entity: 'transfer_place',
          entityId: input.id,
          data: { isActive: input.isActive },
        });
      });
      return { ok: true as const };
    }),
});
