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
 * **`resetPin` is the one procedure here that touches a credential.** In the
 * same transaction as minting the new hash it clears all five lockout columns
 * — `failed_attempts`, `locked_until`, `lockout_count`,
 * `lockout_window_started_at`, `requires_admin_unlock` — so a dispatcher who
 * resets a PIN does not hand back a driver who still cannot sign in (owner
 * instruction, 2026-10-14). The PIN is generated server-side with
 * `crypto.randomInt`, returned exactly once in the mutation's response, and
 * never appears in `list`, in the audit row, or in any log line.
 *
 * **`unlock` (owner decision 2026-10-23, Q1) is the lockout half on its own**,
 * and the reason `resetPin` is no longer described here as "the admin unlock":
 * it clears `failed_attempts` / `locked_until` and never touches `pin_hash`,
 * so the office can get a driver into the van at 5am without reading a new PIN
 * down a phone line. Since the same decision retired the terminal
 * `requires_admin_unlock` state, a lockout also now lifts itself by the clock
 * (15 → 30 → 60 minutes, capped) — `unlock` is the shortcut, not the only way
 * back.
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
  driverActiveInputSchema,
  driverInputSchema,
  driverLeaveInputSchema,
  civilDateFromDate,
  type DriverInput,
  DRIVER_RATING_MIN_RATINGS,
  type DriverLeaveRow,
  type DriverRating,
  type DriverRow,
} from '@rg/shared';
import { and, asc, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { isDuplicateKeyError } from '../../db/duplicate-key';
import { bookings, driverLeaves, drivers, reviews } from '../../db/schema';
import { hashPassword } from '../../services/password';
import { writeAudit } from '../../services/audit';
import { revokeSessionsForSubject } from '../../services/sessions';
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
  lockedUntil: Date | null;
};
/** The driver row shape Drizzle's `.values()` / `.set()` want. */
type DriverInsert = typeof drivers.$inferInsert;

/** A wire civil-date string to the UTC-midnight `Date` the `date()` column wants. */
function toDbDate(value: string | null): Date | null {
  return value === null ? null : new Date(`${value}T00:00:00Z`);
}

/**
 * `now` is a PARAMETER, not a clock read in here (owner decision 2026-10-24,
 * point 1): `isLockedOut` is a time-dependent answer, and this codebase reads
 * the instant once at the request boundary so every row in one response is
 * judged against the same moment — and so a boundary is testable without
 * faking timers.
 *
 * `lockedUntil` is consumed here and never copied into the returned row: the
 * raw instant does not go on the wire (see `DriverRow.isLockedOut`).
 *
 * **`isActive` is part of the derivation** (review finding, 2026-10-24), not
 * only of the clock comparison: the dashboard's `driverLocked` alert asks
 * `and(eq(drivers.isActive, true), gt(drivers.lockedUntil, now))` and `unlock`
 * refuses an inactive driver, so a flag computed from the clock alone would
 * offer an Unlock button on the one row where the card is silent and the
 * mutation answers NOT_FOUND. The three surfaces ask one question.
 */
function toDriverRow(
  row: DriverSelect,
  now: Date,
  leaves: DriverLeaveRow[] = [],
  rating: DriverRating | null = null,
): DriverRow {
  return {
    id: row.id,
    name: row.name,
    code: row.code,
    phone: row.phone,
    licenseNo: row.licenseNo,
    licenseExpiry: civilDateFromDate(row.licenseExpiry),
    languages: (row.languages as string[] | null) ?? null,
    emergencyContact: row.emergencyContact,
    status: row.status,
    isActive: row.isActive,
    isLockedOut:
      row.lockedUntil !== null && row.lockedUntil.getTime() > now.getTime() && row.isActive,
    rating,
    leaves,
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
    /*
     * One clock read for the whole response: `isLockedOut` below is derived
     * against this instant for every row, rather than once per row.
     */
    const now = new Date();
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
        /*
         * Read so `toDriverRow` can DERIVE `isLockedOut` — the column itself
         * is not in the response. `pin_hash` is still absent from this
         * projection, and still the reason the projection is explicit.
         */
        lockedUntil: drivers.lockedUntil,
      })
      .from(drivers)
      .orderBy(asc(drivers.name));

    /*
     * Leaves in ONE further query, grouped in memory — not a per-driver
     * query in a loop (N+1 on a page that lists the whole roster) and not a
     * LEFT JOIN onto the driver rows (which would multiply each driver by
     * its leave count and make the caller de-duplicate).
     *
     * Soonest first, so the screen's list reads as a schedule. Past leaves
     * are included deliberately: a dispatcher resolving an overlap refusal
     * needs to see the row that caused it, whenever it was.
     */
    const leaveRows = await getDb()
      .select({
        id: driverLeaves.id,
        driverId: driverLeaves.driverId,
        startDate: driverLeaves.startDate,
        endDate: driverLeaves.endDate,
        reason: driverLeaves.reason,
      })
      .from(driverLeaves)
      .orderBy(asc(driverLeaves.startDate), asc(driverLeaves.id));

    const byDriver = new Map<number, DriverLeaveRow[]>();
    for (const row of leaveRows) {
      const list = byDriver.get(row.driverId) ?? [];
      list.push({
        id: row.id,
        // `date()` columns come back as Date objects; the wire carries civil
        // date strings, like every other date in this API.
        startDate: civilDateFromDate(row.startDate) ?? '',
        endDate: civilDateFromDate(row.endDate) ?? '',
        reason: row.reason,
      });
      byDriver.set(row.driverId, list);
    }

    /*
     * The derived guide rating (owner-decided 2026-10-15): averaged from
     * `reviews.guide` on PUBLISHED, NON-SAMPLE reviews of bookings this
     * driver actually drove.
     *
     * One grouped query for the whole roster, like the leaves above — not a
     * per-driver query in a loop.
     *
     * `is_sample = 0` matters as much as `status = 'published'`: seeded
     * reviews are flagged as samples and `CLAUDE.md` keeps them out of every
     * rating, the same rule the public `realAggregate()` follows. A rating
     * built from fixtures is a fabricated number wearing a decimal point.
     *
     * `guide IS NOT NULL` because the sub-score is optional — a guest who
     * rated the trip but not the guide has said nothing about the driver.
     */
    const ratingRows = await getDb()
      .select({
        driverId: bookings.driverId,
        total: sql<number>`SUM(${reviews.guide})`,
        count: sql<number>`COUNT(${reviews.guide})`,
      })
      .from(reviews)
      .innerJoin(bookings, eq(bookings.id, reviews.bookingId))
      .where(
        and(
          eq(reviews.status, 'published'),
          eq(reviews.isSample, false),
          isNotNull(reviews.guide),
          isNotNull(bookings.driverId),
        ),
      )
      .groupBy(bookings.driverId);

    const ratingByDriver = new Map<number, DriverRating>();
    for (const row of ratingRows) {
      const count = Number(row.count);
      // BELOW the threshold is `null`, not a number with a caveat: a single
      // five from a guest's good mood is not a rating, and anything on
      // screen reads as a measurement.
      if (row.driverId === null || count < DRIVER_RATING_MIN_RATINGS) continue;
      ratingByDriver.set(row.driverId, {
        average: Math.round((Number(row.total) / count) * 10) / 10,
        count,
      });
    }

    return rows.map((row) =>
      toDriverRow(row, now, byDriver.get(row.id) ?? [], ratingByDriver.get(row.id) ?? null),
    );
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
   * Switches a driver on or off (Week 6.5, D4) — the act that did not exist:
   * `driverInputSchema` excludes `is_active` and nothing else wrote it.
   *
   * **Deactivating deletes every session that driver holds, in THIS
   * transaction** (owner decision 2026-10-16, D4). `requireDriver` reads the
   * session and never re-reads `is_active`, so without this a driver switched
   * off mid-shift kept up to twelve hours of access. Revoking at the write
   * costs nothing on the portal's hottest path and closes the window at the
   * one moment the state changes. The revocation is inside the transaction so
   * that a failed write cannot sign a driver out of a job they still hold.
   *
   * **Reactivating revokes nothing.** There is nothing to take back, and the
   * old sessions were already deleted when the driver was switched off — a
   * reactivated driver signs in afresh.
   *
   * It deliberately does NOT touch `bookings.driver_id`: that id is the
   * record of who was assigned, and an audit trail that forgets is not one.
   * A deactivated driver's future trips instead surface through the
   * `unassigned_soon` dashboard alert, which asks about the driver's state
   * (`services/dispatch/alerts.ts`).
   *
   * Two audit actions, dotted (`driver.deactivated` / `driver.reactivated`),
   * rather than one `driver.active_set`: "who turned this driver off" is the
   * question an admin asks, and it should not need a payload to answer.
   */
  setActive: adminProcedure('vansDrivers')
    .input(driverActiveInputSchema)
    .mutation(async ({ input, ctx }) => {
      await getDb().transaction(async (tx) => {
        const [result] = await tx
          .update(drivers)
          .set({ isActive: input.isActive })
          .where(eq(drivers.id, input.id));
        if (result.affectedRows === 0) {
          throw new TRPCError({ code: 'NOT_FOUND', message: 'No driver with that id.' });
        }
        const [row] = await tx
          .select({ code: drivers.code })
          .from(drivers)
          .where(eq(drivers.id, input.id));

        // Switching OFF is the only direction that revokes.
        const sessionsRevoked = input.isActive
          ? 0
          : await revokeSessionsForSubject(tx, 'driver', input.id);

        await writeAudit(tx, {
          actorType: 'user',
          actorId: ctx.session.subjectId,
          action: input.isActive ? 'driver.reactivated' : 'driver.deactivated',
          entity: 'driver',
          entityId: input.id,
          data: { code: row?.code ?? null, isActive: input.isActive, sessionsRevoked },
        });
      });
      return { ok: true as const };
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
   * **Lifts a live lockout and nothing else** (owner decision 2026-10-23, Q1,
   * option C+E). The office's answer to a driver standing at a van at 5am who
   * has burned five wrong PINs, or whose code a prankster burned for them.
   *
   * ## Why this exists beside `resetPin`
   *
   * `resetPin` was the ONLY cure for a lockout until today, and it costs the
   * driver their PIN: a dispatcher reads a new six-digit number down a phone
   * line at dawn, the driver writes it on their hand, and the PIN they had
   * memorised is gone. That is a heavy price for "wait fifteen minutes is too
   * long this once". So the two acts are now separate — this one clears the
   * lockout and **never touches `pin_hash`**, and `resetPin` still does both
   * for the case it was written for (a PIN nobody can remember).
   *
   * ## What it clears, and what it deliberately leaves
   *
   * `failed_attempts` and `locked_until` only. `lockout_count` and
   * `lockout_window_started_at` are left exactly as they are, so the driver's
   * NEXT lockout today still serves its place in the backoff schedule. An
   * admin intervening is not the same event as a correct PIN: the count is a
   * fact about the day, not about who ended the lockout, and clearing it would
   * hand an attacker a free reset for every helpful dispatcher.
   *
   * It does not touch `requires_admin_unlock` either. That column is retired
   * (2026-10-23) and read by nothing; `resetPin` still zeroes it, and the
   * login path writes `false` on every attempt.
   *
   * ## It refuses when there is nothing to unlock
   *
   * A driver with `locked_until` null, or already in the past, is not locked —
   * so this answers `BAD_REQUEST` rather than succeeding quietly. A silent
   * success would tell a dispatcher "unlocked" about a driver whose real
   * problem is something else entirely (a forgotten PIN, a deactivated
   * account), and would put a `driver.unlocked` row in the log for an unlock
   * that did not happen.
   *
   * And an INACTIVE driver is refused as an unknown id is (owner decision
   * 2026-10-24, point 3) — see the `where` clause for both halves of why.
   *
   * ## Who calls it
   *
   * The Unlock button on `/admin/drivers`, shown only while that row's
   * server-computed `isLockedOut` is true (Task 5b). Until then this mutation
   * was reachable by API only, which is what made the dashboard alert's copy
   * a promise with nothing behind it.
   *
   * `adminProcedure('vansDrivers')` — owner and dispatcher, the same §9 area
   * `resetPin` uses, never finance. The audit row names the actor and the
   * driver; `data` carries the lockout it lifted and the count it left
   * standing, and **never a PIN or anything derived from one** — this mutation
   * does not so much as read `pin_hash`.
   */
  unlock: adminProcedure('vansDrivers')
    .input(idInput)
    .mutation(async ({ input, ctx }) => {
      /*
       * `now` is read once, here at the request boundary, like every other
       * time-based decision in this codebase — and never inside the
       * transaction, so "was this driver locked" is answered against one
       * instant rather than one per statement.
       */
      const now = new Date();
      return await getDb().transaction(async (tx) => {
        const [row] = await tx
          .select({
            code: drivers.code,
            lockedUntil: drivers.lockedUntil,
            lockoutCount: drivers.lockoutCount,
          })
          .from(drivers)
          /*
           * `is_active` is part of the WHERE, not a check afterwards (owner
           * decision 2026-10-24, point 3) — the same question the dashboard's
           * `driverLocked` alert asks, so the alert, the button and this
           * mutation cannot disagree about who can be unlocked. A driver off
           * the roster cannot sign in at all, so there is nothing an unlock
           * would give them; they come back by being reactivated.
           *
           * The refusal is then the EXISTING `NOT_FOUND` below, word for word
           * the answer an id that was never issued gets. Nothing on this
           * screen needs to distinguish "no such driver" from "exists but is
           * off the roster", and a distinguishable refusal would make a
           * numeric id an oracle for which drivers exist — the same reasoning
           * `driverProcedure`'s booking lookup already follows.
           */
          .where(and(eq(drivers.id, input.id), eq(drivers.isActive, true)))
          // The row lock: two dispatchers clicking at once must not both
          // write, and must not both audit an unlock.
          .for('update')
          .limit(1);
        if (!row) {
          throw new TRPCError({ code: 'NOT_FOUND', message: 'No driver with that id.' });
        }
        if (row.lockedUntil === null || row.lockedUntil.getTime() <= now.getTime()) {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: 'That driver is not locked out, so there is nothing to unlock.',
          });
        }

        await tx
          .update(drivers)
          .set({ failedAttempts: 0, lockedUntil: null })
          .where(eq(drivers.id, input.id));

        await writeAudit(tx, {
          actorType: 'user',
          actorId: ctx.session.subjectId,
          action: 'driver.unlocked',
          entity: 'driver',
          entityId: input.id,
          data: {
            code: row.code,
            // The lockout that was lifted, and the count that was NOT.
            lockedUntil: row.lockedUntil.toISOString(),
            lockoutCount: row.lockoutCount,
            pinReset: false,
          },
        });

        return { ok: true as const };
      });
    }),

  /**
   * A new PIN, **and** the lockout cleared with it (owner instruction,
   * 2026-10-14; narrowed 2026-10-23).
   *
   * It is no longer the only way out of a lockout — `unlock` above lifts one
   * without costing the driver their PIN, and since 2026-10-23 a lockout also
   * lifts itself by the clock. `resetPin` remains the act for a PIN nobody can
   * remember, and it still clears all five lockout columns in the SAME
   * transaction as the new hash, not a subset: a reset that left
   * `locked_until` standing would hand the dispatcher a driver who still
   * cannot sign in, which is exactly the failure this behaviour was added for.
   *
   * `requires_admin_unlock` is among the five it zeroes. The column is retired
   * (2026-10-23) and nothing reads it; zeroing it here is tidiness, not a
   * cure.
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
