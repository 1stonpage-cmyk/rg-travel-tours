/**
 * `admin.dispatch.assign` (Week 5 "Dispatch" plan, Task 10; BUILD_SPEC §9
 * "Calendar" / "Assign van/driver"). The HTTP door onto
 * `assignVanAndDriver()` — the first mutation in this project's history
 * allowed to write `bookings.van_id` / `.driver_id`.
 *
 * `adminProcedure('assignVanDriver')` — §9 gives assignment to owner and
 * dispatcher only; finance is refused by the gate before this resolver ever
 * runs (`ROLE_MATRIX.assignVanDriver`, `middleware/require-role.ts`).
 *
 * This router does nothing except open the transaction, hand off to the
 * service, and translate its verdict into a `TRPCError` — the same split
 * `admin/bookings.ts`'s `approveReceipt`/`rejectReceipt` use for
 * `decideManualReceipt()`. The service decides everything; this file
 * decides nothing.
 */
import { TRPCError } from '@trpc/server';
import { assignInputSchema, suggestInputSchema } from '@rg/shared';
import { getDb } from '../../db/client';
import { withDeadlockRetry } from '../../db/deadlock';
import { type AssignRefusal, assignVanAndDriver } from '../../services/dispatch/assign';
import { suggestAssignment } from '../../services/dispatch/suggest';
import { adminProcedure, router } from '../../trpc';

/**
 * Every refusal reason becomes a `TRPCError` whose `message` IS the reason
 * string, verbatim — so a client (or a test) can match on it directly
 * rather than guessing prose. The `code` is chosen for what actually
 * happened: `NOT_FOUND` for a booking that is not there, `CONFLICT` for a
 * van/driver that was free when the dropdown was drawn and no longer is
 * (someone else's assignment resolved first), `BAD_REQUEST` for everything
 * the request itself got wrong.
 */
function asTrpcError(reason: AssignRefusal): TRPCError {
  switch (reason) {
    case 'booking_not_found':
      return new TRPCError({ code: 'NOT_FOUND', message: reason });
    case 'van_unavailable':
    case 'driver_unavailable':
      return new TRPCError({ code: 'CONFLICT', message: reason });
    case 'booking_not_assignable':
    case 'van_too_small':
    case 'reason_required':
      return new TRPCError({ code: 'BAD_REQUEST', message: reason });
    default: {
      // Exhaustiveness: a new AssignRefusal value with no case here fails
      // `pnpm typecheck` instead of silently falling through to a 500.
      const unreachable: never = reason;
      throw new Error(`Unhandled AssignRefusal: ${unreachable}`);
    }
  }
}

export const adminDispatchRouter = router({
  /**
   * Assigns a van and driver to one booking, or throws a `TRPCError`
   * carrying the refusal reason (see `asTrpcError` above).
   *
   * `reason` is optional at this boundary (Zod cannot see the booking's
   * status) — the service decides, inside the transaction, after reading
   * the status under the lock. See `services/dispatch/assign.ts`.
   */
  assign: adminProcedure('assignVanDriver')
    .input(assignInputSchema)
    .mutation(async ({ input, ctx }) => {
      /*
       * The WHOLE transaction runs inside the shared 1213 retry (Task 10
       * review, F5), the same way `createHold()` does.
       *
       * `capacity.ts` records the measured reason: when a date's
       * `fleet_date_slots` row does not exist yet, two concurrent
       * `INSERT … ON DUPLICATE KEY UPDATE`s of it can deadlock, and at three
       * or more concurrent requests for one date that becomes likely rather
       * than theoretical. InnoDB rolls one back, so this was never able to
       * double-dispatch a van — but without the retry the victim surfaced as
       * a raw `Failed query` 500, and a dispatcher on a busy morning would
       * see the fleet break for no stated reason.
       *
       * Retrying is the caller's business because a deadlocked transaction
       * is already rolled back: there is nothing to resume from inside it.
       * After three attempts it gives up as a CONFLICT — "two of you are
       * assigning the same day, try again" is a sentence a dispatcher can
       * act on, which a 500 is not.
       */
      const verdict = await withDeadlockRetry(
        () =>
          getDb().transaction((tx) =>
            assignVanAndDriver(tx, {
              bookingId: input.bookingId,
              vanId: input.vanId,
              driverId: input.driverId,
              reason: input.reason,
              // The LIVE session identity, never a value the request body
              // could claim — same discipline `approveReceipt` uses for
              // `verifier`.
              actorUserId: ctx.session.subjectId,
            }),
          ),
        {
          onExhausted: (tries, error) => {
            throw new TRPCError({
              code: 'CONFLICT',
              message: 'This date is busy with other assignments right now. Please try again.',
              cause: error instanceof Error ? error : new Error(`deadlocked ${tries} times`),
            });
          },
        },
      );

      if (!verdict.ok) throw asTrpcError(verdict.reason);
      return { ok: true as const };
    }),

  /**
   * `admin.dispatch.suggest` (Task 11; BUILD_SPEC §5 "Admin calendar
   * auto-suggests a van (smallest that fits) and an available driver").
   *
   * Same role gate as `assign` — `adminProcedure('assignVanDriver')`,
   * because the suggestion only exists to feed the same Assign button. No
   * `withDeadlockRetry` here: `suggestAssignment` takes no locks and writes
   * nothing, so there is nothing for InnoDB to pick as a deadlock victim.
   *
   * A query, not a mutation: it reads, it never changes anything.
   */
  suggest: adminProcedure('assignVanDriver')
    .input(suggestInputSchema)
    .query(async ({ input }) => {
      return await getDb().transaction((tx) => suggestAssignment(tx, input.bookingId));
    }),
});
