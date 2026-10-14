/**
 * `admin.drivers.*` — the drivers CRUD surface, leaves and PIN reset (Week 5
 * plan, Task 6; BUILD_SPEC §9 "Drivers" / §5B).
 *
 * Every procedure is `adminProcedure('vansDrivers')` — §9's "Vans, drivers"
 * row: owner and dispatcher, never finance (Q5). There is deliberately no
 * delete mutation for a DRIVER: a driver is soft-deleted through `is_active`
 * (CLAUDE.md, "Never hard-delete"). `removeLeave` is a real delete because a
 * leave row is a schedule entry, not an audited financial or booking record.
 *
 * **`resetPin` is the one procedure here that touches a credential**, and it
 * is also the admin unlock from the Q9 lockout policy (owner instruction,
 * 2026-10-14): in the same transaction as minting the new hash it clears all
 * five lockout columns — `failed_attempts`, `locked_until`, `lockout_count`,
 * `lockout_window_started_at`, `requires_admin_unlock` — because
 * `requires_admin_unlock` is the terminal flag `evaluatePinAttempt()`
 * (`services/driver-lockout.ts`) checks before anything else, and nothing
 * but an admin action ever clears it. The PIN is generated server-side with
 * `crypto.randomInt`, returned exactly once in the mutation's response, and
 * never appears in `list`, in the audit row, or in any log line.
 *
 * `create` also mints a PIN, because `drivers.pin_hash` is `NOT NULL` — a new
 * driver has to start with *something* hashed, and the owner's instruction
 * applies here too: generated server-side, returned once, never logged.
 *
 * `list` selects an explicit column list that OMITS `pin_hash`. A bare
 * `select()` on `drivers` would ship the hash to the browser.
 */
import { randomInt } from 'node:crypto';
import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import {
  CAPACITY_HOLDING_STATUSES,
  driverInputSchema,
  driverLeaveInputSchema,
  manilaCivilDate,
  type DriverInput,
  type DriverRow,
} from '@rg/shared';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { isDuplicateKeyError } from '../../db/duplicate-key';
import { bookings, driverLeaves, drivers } from '../../db/schema';
import { hashPassword } from '../../services/password';
import { writeAudit } from '../../services/audit';
import { adminProcedure, router } from '../../trpc';

/** The driver row shape as Drizzle's explicit `list` projection selects it. */
type DriverSelect = {
  id: number;
  name: string;
  code: string;
  phone: string;
  licenseNo: string | null;
  licenseExpiry: Date | null;
  languages: unknown;
  emergencyContact: string | null;
  status: string;
  isActive: boolean;
};
/** The driver row shape Drizzle's `.values()` / `.set()` want. */
type DriverInsert = typeof drivers.$inferInsert;

/** A wire civil-date string to the UTC-midnight `Date` the `date()` column wants. */
function toDbDate(value: string | null): Date | null {
  return value === null ? null : new Date(`${value}T00:00:00Z`);
}

/** The DB's `Date` (or null) back to the `YYYY-MM-DD` string every caller else uses. */
function toCivilDate(value: Date | null): string | null {
  return value === null ? null : manilaCivilDate(value);
}

function toDriverRow(row: DriverSelect): DriverRow {
  return {
    id: row.id,
    name: row.name,
    code: row.code,
    phone: row.phone,
    licenseNo: row.licenseNo,
    licenseExpiry: toCivilDate(row.licenseExpiry),
    languages: (row.languages as string[] | null) ?? null,
    emergencyContact: row.emergencyContact,
    status: row.status,
    isActive: row.isActive,
  };
}

/** A full `driverInputSchema` parse, as the column values `create`'s INSERT wants. */
function toInsertValues(input: DriverInput): Omit<DriverInsert, 'pinHash'> {
  return {
    name: input.name,
    code: input.code,
    phone: input.phone,
    licenseNo: input.licenseNo,
    licenseExpiry: toDbDate(input.licenseExpiry),
    languages: input.languages,
    emergencyContact: input.emergencyContact,
  };
}

/**
 * A `driverInputSchema.partial()` parse, as the column values `update`'s SET
 * wants — only the keys the caller actually sent, so an omitted field in the
 * patch leaves the column untouched rather than overwriting it with
 * `undefined`.
 */
function toUpdateValues(patch: Partial<DriverInput>): Partial<DriverInsert> {
  const out: Partial<DriverInsert> = {};
  if (patch.name !== undefined) out.name = patch.name;
  if (patch.code !== undefined) out.code = patch.code;
  if (patch.phone !== undefined) out.phone = patch.phone;
  if (patch.licenseNo !== undefined) out.licenseNo = patch.licenseNo;
  if (patch.licenseExpiry !== undefined) out.licenseExpiry = toDbDate(patch.licenseExpiry);
  if (patch.languages !== undefined) out.languages = patch.languages;
  if (patch.emergencyContact !== undefined) out.emergencyContact = patch.emergencyContact;
  return out;
}

/** The duplicate-code message both `create` and `update` throw, worded for a human. */
const DUPLICATE_CODE_MESSAGE = 'A driver with that code already exists.';

/**
 * Generates the six-digit PIN. **`crypto.randomInt`, never `Math.random()`**
 * (owner instruction, 2026-10-14) — `Math.random()` is not a CSPRNG, and a
 * client-chosen PIN is the door this closes from the other side: the server
 * is the only party that ever produces one.
 */
function generatePin(): string {
  return randomInt(0, 1_000_000).toString().padStart(6, '0');
}

/**
 * `column <= :end AND column2 >= :start` for one driver's existing leaves —
 * raw `sql`, not `eq()`/`lte()`/`gte()`: `driver_leaves.start_date` /
 * `.end_date` are Drizzle `date()` columns, which type as `Date`, and
 * comparing them against the civil-date STRING this router works in is the
 * same hazard `onDate()` (`services/dispatch/availability.ts:104`) and `on()`
 * (`services/capacity.ts:222`) already avoid for `bookings.tour_date`. Kept
 * local rather than shared, for the same reason those two are not shared
 * with each other.
 */
function leaveOverlaps(startDate: string, endDate: string) {
  return sql`${driverLeaves.startDate} <= ${endDate} AND ${driverLeaves.endDate} >= ${startDate}`;
}

/** `bookings.tour_date BETWEEN :start AND :end`, as a civil-date string comparison. */
function tourDateBetween(startDate: string, endDate: string) {
  return sql`${bookings.tourDate} BETWEEN ${startDate} AND ${endDate}`;
}

const driverPatchSchema = driverInputSchema
  .partial()
  .refine((patch) => Object.keys(patch).length > 0, {
    message: 'Provide at least one field to update.',
  });

const updateInput = z
  .object({ id: z.number().int().positive(), patch: driverPatchSchema })
  .strict();
const idInput = z.object({ id: z.number().int().positive() }).strict();

export const adminDriversRouter = router({
  list: adminProcedure('vansDrivers').query(async () => {
    const rows = await getDb()
      .select({
        id: drivers.id,
        name: drivers.name,
        code: drivers.code,
        phone: drivers.phone,
        licenseNo: drivers.licenseNo,
        licenseExpiry: drivers.licenseExpiry,
        languages: drivers.languages,
        emergencyContact: drivers.emergencyContact,
        status: drivers.status,
        isActive: drivers.isActive,
      })
      .from(drivers)
      .orderBy(asc(drivers.name));
    return rows.map(toDriverRow);
  }),

  create: adminProcedure('vansDrivers')
    .input(driverInputSchema)
    .mutation(async ({ input, ctx }) => {
      const pin = generatePin();
      const pinHash = await hashPassword(pin);
      try {
        const id = await getDb().transaction(async (tx) => {
          const [result] = await tx.insert(drivers).values({ ...toInsertValues(input), pinHash });
          await writeAudit(tx, {
            actorType: 'user',
            actorId: ctx.session.subjectId,
            action: 'driver_created',
            entity: 'driver',
            entityId: result.insertId,
            data: { code: input.code },
          });
          return result.insertId;
        });
        return { id, pin };
      } catch (error) {
        if (isDuplicateKeyError(error)) {
          throw new TRPCError({ code: 'CONFLICT', message: DUPLICATE_CODE_MESSAGE });
        }
        throw error;
      }
    }),

  update: adminProcedure('vansDrivers')
    .input(updateInput)
    .mutation(async ({ input, ctx }) => {
      try {
        await getDb().transaction(async (tx) => {
          const setValues = toUpdateValues(input.patch);
          const [result] = await tx.update(drivers).set(setValues).where(eq(drivers.id, input.id));
          if (result.affectedRows === 0) {
            throw new TRPCError({ code: 'NOT_FOUND', message: 'No driver with that id.' });
          }
          await writeAudit(tx, {
            actorType: 'user',
            actorId: ctx.session.subjectId,
            action: 'driver_updated',
            entity: 'driver',
            entityId: input.id,
            data: input.patch,
          });
        });
        return { ok: true as const };
      } catch (error) {
        if (isDuplicateKeyError(error)) {
          throw new TRPCError({ code: 'CONFLICT', message: DUPLICATE_CODE_MESSAGE });
        }
        throw error;
      }
    }),

  /**
   * The DB CHECK (`driver_leaves_date_order`) constrains one row; two leaves
   * for the same driver that overlap each other, and a leave that collides
   * with a trip the driver is already assigned to, are a service-layer
   * concern (schema.ts's own comment on `driverLeaves`) — this is that
   * service. Both checks run as reads inside the same transaction as the
   * insert, so a concurrent add cannot slip a conflicting row in between the
   * check and the write... within the limits of REPEATABLE READ; there is no
   * extra locking here because a double-booked leave is a dispatcher
   * mistake to catch and fix, not a money-moving race to serialise.
   */
  addLeave: adminProcedure('vansDrivers')
    .input(driverLeaveInputSchema)
    .mutation(async ({ input, ctx }) => {
      return await getDb().transaction(async (tx) => {
        const [overlapping] = await tx
          .select({ id: driverLeaves.id })
          .from(driverLeaves)
          .where(
            and(
              eq(driverLeaves.driverId, input.driverId),
              leaveOverlaps(input.startDate, input.endDate),
            ),
          )
          .limit(1);
        if (overlapping) {
          throw new TRPCError({
            code: 'CONFLICT',
            message: 'That overlaps a leave this driver already has.',
          });
        }

        const [assignedTrip] = await tx
          .select({ id: bookings.id })
          .from(bookings)
          .where(
            and(
              eq(bookings.driverId, input.driverId),
              inArray(bookings.status, [...CAPACITY_HOLDING_STATUSES]),
              tourDateBetween(input.startDate, input.endDate),
            ),
          )
          .limit(1);
        if (assignedTrip) {
          throw new TRPCError({
            code: 'CONFLICT',
            message: 'The driver is already assigned to a trip in that date range.',
          });
        }

        const [result] = await tx.insert(driverLeaves).values({
          driverId: input.driverId,
          startDate: toDbDate(input.startDate) as Date,
          endDate: toDbDate(input.endDate) as Date,
          reason: input.reason,
        });
        await writeAudit(tx, {
          actorType: 'user',
          actorId: ctx.session.subjectId,
          action: 'driver_leave_added',
          entity: 'driver',
          entityId: input.driverId,
          data: { leaveId: result.insertId, startDate: input.startDate, endDate: input.endDate },
        });
        return { id: result.insertId };
      });
    }),

  removeLeave: adminProcedure('vansDrivers')
    .input(idInput)
    .mutation(async ({ input, ctx }) => {
      await getDb().transaction(async (tx) => {
        const [existing] = await tx
          .select({ driverId: driverLeaves.driverId })
          .from(driverLeaves)
          .where(eq(driverLeaves.id, input.id))
          .limit(1);
        if (!existing) {
          throw new TRPCError({ code: 'NOT_FOUND', message: 'No leave with that id.' });
        }
        await tx.delete(driverLeaves).where(eq(driverLeaves.id, input.id));
        await writeAudit(tx, {
          actorType: 'user',
          actorId: ctx.session.subjectId,
          action: 'driver_leave_removed',
          entity: 'driver',
          entityId: existing.driverId,
          data: { leaveId: input.id },
        });
      });
      return { ok: true as const };
    }),

  /**
   * The admin unlock from the Q9 lockout policy (owner instruction,
   * 2026-10-14). A PIN reset clears, in the SAME transaction as the new
   * hash, all five lockout columns — not a subset. `requires_admin_unlock`
   * is the terminal flag `evaluatePinAttempt()` checks before anything else
   * and that nothing but this action ever clears; leaving it set would hand
   * the dispatcher a driver who still cannot sign in.
   *
   * The audit row names the actor, the driver and the timestamp
   * (`writeAudit` stamps `created_at`) — `data: { clearedLockout: true }`,
   * and the PIN never appears in it, in `list`, or in any log.
   */
  resetPin: adminProcedure('vansDrivers')
    .input(idInput)
    .mutation(async ({ input, ctx }) => {
      const pin = generatePin();
      const pinHash = await hashPassword(pin);
      await getDb().transaction(async (tx) => {
        const [result] = await tx
          .update(drivers)
          .set({
            pinHash,
            failedAttempts: 0,
            lockedUntil: null,
            lockoutCount: 0,
            lockoutWindowStartedAt: null,
            requiresAdminUnlock: false,
          })
          .where(eq(drivers.id, input.id));
        if (result.affectedRows === 0) {
          throw new TRPCError({ code: 'NOT_FOUND', message: 'No driver with that id.' });
        }
        await writeAudit(tx, {
          actorType: 'user',
          actorId: ctx.session.subjectId,
          action: 'driver_pin_reset',
          entity: 'driver',
          entityId: input.id,
          data: { clearedLockout: true },
        });
      });
      return { pin };
    }),
});
