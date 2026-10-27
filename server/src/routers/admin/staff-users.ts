/**
 * `admin.staffUsers` — the owner's staff-account management (owner decisions
 * 2026-10-23). Every procedure is `adminProcedure('staffAccounts')`, which
 * `ROLE_MATRIX` gives to the owner alone: finance and dispatcher cannot list
 * it, let alone change it. The Staff screen hiding its menu entry from them is
 * a convenience; THIS is the control.
 *
 * ## The rules that live here
 *
 *  - **The owner cannot lock themselves out or demote themselves.** Neither
 *    deactivating oneself nor changing one's own role is allowed, and nor is
 *    resetting one's own password here (the menu's "Change password" is the
 *    right door: it asks for the current one).
 *  - **There is always an active owner.** Any deactivation or role change that
 *    would leave zero active owners is refused. Checked from a count taken
 *    under a row lock, not from the caller's say-so, so two owners acting on
 *    each other at the same moment cannot both succeed.
 *  - **Switching a user off, or resetting their password, ends their sessions
 *    in the same transaction** (the driver deactivation pattern, Week 6.5 D4).
 *  - **The temporary password is hashed with the existing scrypt helper and
 *    never stored, logged or audited.** `must_change_password` is set so the
 *    holder must replace it before using anything else.
 *  - **No hard deletes.** `is_active` is the only way an account goes away.
 */
import { TRPCError } from '@trpc/server';
import { asc, eq, or } from 'drizzle-orm';
import {
  createStaffUserInputSchema,
  resetStaffPasswordInputSchema,
  setStaffUserActiveInputSchema,
  STAFF_EMAIL_TAKEN_MESSAGE,
  updateStaffUserInputSchema,
  type AdminRole,
} from '@rg/shared';
import { getDb, type Transaction } from '../../db/client';
import { isDuplicateKeyError } from '../../db/duplicate-key';
import { users } from '../../db/schema';
import { writeAudit } from '../../services/audit';
import { hashPassword } from '../../services/password';
import { revokeSessionsForSubject } from '../../services/sessions';
import { adminProcedure, router } from '../../trpc';

const notFound = () =>
  new TRPCError({ code: 'NOT_FOUND', message: 'No staff account with that id.' });

const lastOwner = () =>
  new TRPCError({
    code: 'CONFLICT',
    message: 'There must always be at least one active owner.',
  });

interface Locked {
  id: number;
  role: AdminRole;
  isActive: boolean;
}

/**
 * Locks every owner row and the target row in one statement (index order, so
 * two transactions cannot take them in opposite orders) and returns the
 * target plus how many OTHER active owners there are.
 *
 * The count is what the last-owner guard reads. Taking it under the lock is
 * the point: two owners deactivating each other concurrently each see the
 * other as the remaining owner unless the second has to wait for the first.
 */
async function lockTarget(
  tx: Transaction,
  targetId: number,
): Promise<{ target: Locked; otherActiveOwners: number }> {
  const rows = await tx
    .select({ id: users.id, role: users.role, isActive: users.isActive })
    .from(users)
    .where(or(eq(users.role, 'owner'), eq(users.id, targetId)))
    .orderBy(asc(users.id))
    .for('update');

  const target = rows.find((r) => r.id === targetId);
  if (!target) throw notFound();
  const otherActiveOwners = rows.filter(
    (r) => r.id !== targetId && r.role === 'owner' && r.isActive,
  ).length;
  return { target, otherActiveOwners };
}

export const adminStaffUsersRouter = router({
  /** Never selects `password_hash`: it is not on the row type this returns. */
  list: adminProcedure('staffAccounts').query(async () => {
    return getDb()
      .select({
        id: users.id,
        name: users.name,
        email: users.email,
        role: users.role,
        isActive: users.isActive,
        mustChangePassword: users.mustChangePassword,
        lastLoginAt: users.lastLoginAt,
        createdAt: users.createdAt,
      })
      .from(users)
      .orderBy(asc(users.name), asc(users.id));
  }),

  create: adminProcedure('staffAccounts')
    .input(createStaffUserInputSchema)
    .mutation(async ({ input, ctx }) => {
      // Hashed BEFORE the transaction: ~250ms of scrypt must not hold a lock.
      const passwordHash = await hashPassword(input.tempPassword);

      const id = await getDb().transaction(async (tx) => {
        let insertId: number;
        try {
          const [result] = await tx.insert(users).values({
            name: input.name,
            email: input.email,
            passwordHash,
            role: input.role,
            isActive: true,
            mustChangePassword: true,
          });
          insertId = result.insertId;
        } catch (error) {
          if (isDuplicateKeyError(error)) {
            throw new TRPCError({ code: 'CONFLICT', message: STAFF_EMAIL_TAKEN_MESSAGE });
          }
          throw error;
        }

        await writeAudit(tx, {
          actorType: 'user',
          actorId: ctx.session.subjectId,
          action: 'staff.created',
          entity: 'users',
          entityId: insertId,
          data: { role: input.role, email: input.email },
        });
        return insertId;
      });

      return { id };
    }),

  update: adminProcedure('staffAccounts')
    .input(updateStaffUserInputSchema)
    .mutation(async ({ input, ctx }) => {
      await getDb().transaction(async (tx) => {
        const { target, otherActiveOwners } = await lockTarget(tx, input.id);
        const roleChanged = target.role !== input.role;

        if (roleChanged && target.id === ctx.session.subjectId) {
          throw new TRPCError({
            code: 'FORBIDDEN',
            message: 'You cannot change your own role.',
          });
        }
        // Taking an active owner out of the owner role must leave one behind.
        if (roleChanged && target.role === 'owner' && target.isActive && otherActiveOwners < 1) {
          throw lastOwner();
        }

        await tx
          .update(users)
          .set({ name: input.name, role: input.role })
          .where(eq(users.id, input.id));

        await writeAudit(tx, {
          actorType: 'user',
          actorId: ctx.session.subjectId,
          action: roleChanged ? 'staff.role_changed' : 'staff.updated',
          entity: 'users',
          entityId: input.id,
          data: roleChanged ? { from: target.role, to: input.role } : { role: target.role },
        });
      });
      return { ok: true as const };
    }),

  setActive: adminProcedure('staffAccounts')
    .input(setStaffUserActiveInputSchema)
    .mutation(async ({ input, ctx }) => {
      if (!input.isActive && input.id === ctx.session.subjectId) {
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: 'You cannot deactivate your own account.',
        });
      }

      await getDb().transaction(async (tx) => {
        const { target, otherActiveOwners } = await lockTarget(tx, input.id);

        if (
          !input.isActive &&
          target.role === 'owner' &&
          target.isActive &&
          otherActiveOwners < 1
        ) {
          throw lastOwner();
        }

        /*
         * Already where it is being asked to go: write nothing, log nothing,
         * revoke nothing (7N item 6).
         *
         * The `UPDATE` and the audit row were both unconditional, so
         * `setActive(id, true)` on an active account wrote a
         * `staff.reactivated` row with `sessionsRevoked: 0` — a log entry
         * claiming a change that did not happen. CLAUDE.md audits "every
         * payment, refund, status change, and assignment"; a non-change is
         * not a status change, and a trail that records non-events is one a
         * reader stops believing on the day it matters.
         *
         * It returns `{ ok: true }` rather than refusing, because the state
         * the caller asked for is the state that holds — the two admins who
         * both clicked Reactivate have both got what they wanted, and one of
         * them seeing an error would be a lie in the other direction.
         *
         * Inside the transaction and AFTER `lockTarget`, deliberately: the
         * row lock is what stops a concurrent pair from both reading "it
         * differs" and both writing. It is also after both refusals above,
         * so a no-op is never a way around them.
         */
        if (target.isActive === input.isActive) return;

        await tx.update(users).set({ isActive: input.isActive }).where(eq(users.id, input.id));

        // Switching OFF is the only direction that revokes. Same transaction,
        // so a rolled-back deactivation never logs anyone out.
        const sessionsRevoked = input.isActive
          ? 0
          : await revokeSessionsForSubject(tx, 'user', input.id);

        await writeAudit(tx, {
          actorType: 'user',
          actorId: ctx.session.subjectId,
          action: input.isActive ? 'staff.reactivated' : 'staff.deactivated',
          entity: 'users',
          entityId: input.id,
          data: { role: target.role, sessionsRevoked },
        });
      });
      return { ok: true as const };
    }),

  resetPassword: adminProcedure('staffAccounts')
    .input(resetStaffPasswordInputSchema)
    .mutation(async ({ input, ctx }) => {
      if (input.id === ctx.session.subjectId) {
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: 'Use "Change password" in the menu to change your own password.',
        });
      }

      const passwordHash = await hashPassword(input.tempPassword);

      await getDb().transaction(async (tx) => {
        const { target } = await lockTarget(tx, input.id);

        await tx
          .update(users)
          .set({ passwordHash, mustChangePassword: true })
          .where(eq(users.id, input.id));

        // A reset exists because the old password may be in someone else's
        // hands; their sessions must not outlive it.
        const sessionsRevoked = await revokeSessionsForSubject(tx, 'user', input.id);

        await writeAudit(tx, {
          actorType: 'user',
          actorId: ctx.session.subjectId,
          action: 'staff.password_reset',
          entity: 'users',
          entityId: input.id,
          // Never the password, never the hash.
          data: { role: target.role, sessionsRevoked },
        });
      });
      return { ok: true as const };
    }),
});
