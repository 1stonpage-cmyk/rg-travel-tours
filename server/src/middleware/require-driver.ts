/**
 * `requireDriver` — the driver-portal gate (Week 6 plan, Task 1).
 *
 * The third of the three gates, after `requireRole` (staff) and
 * `requireCustomer` (guest), and written to the same rule: **it refuses
 * every session that is not the one kind it is for.** A gate that merely
 * required *some* session would let a signed-in guest — or a signed-in
 * dispatcher — reach a driver's manifest, which carries other guests'
 * names and phone numbers (RA 10173, CLAUDE.md: "DO NOT let one role reach
 * another role's endpoints").
 *
 * ## Staff are refused here too, deliberately
 *
 * It is tempting to let an owner session through so a dispatcher can "see
 * what the driver sees". Two reasons not to: a driver procedure takes its
 * driver id from the SESSION and has no input field for another, so a staff
 * session has no driver to be; and the admin surface already answers the
 * same questions role-gated and audited. Admin convenience through a
 * driver's door would make "whose trip is this" unanswerable.
 *
 * `ctx` is `unknown` rather than the typed context, for the same reason the
 * other two gates take it that way: the gate re-validates what it is given
 * instead of believing a type annotation a later refactor could make untrue.
 */
import { TRPCError } from '@trpc/server';

/** What the context carries, as far as this gate is concerned. */
interface DriverContext {
  session?: { subjectType?: unknown; subjectId?: unknown } | null;
}

export interface DriverSession {
  readonly subjectType: 'driver';
  /** `drivers.id`. The session IS the driver. */
  readonly driverId: number;
}

/**
 * Narrows a context to a driver session, or throws `UNAUTHORIZED`.
 *
 * `UNAUTHORIZED` and never `FORBIDDEN`, even for a staff session: there is
 * no driver identity here to refuse. The message says what to do rather
 * than what went wrong — a driver on a phone at 5am does not need to know
 * whose cookie they are carrying.
 */
export function requireDriver(ctx: unknown): DriverSession {
  const session = (ctx as DriverContext | null | undefined)?.session;

  if (!session || session.subjectType !== 'driver') {
    throw new TRPCError({ code: 'UNAUTHORIZED', message: 'Sign in with your code and PIN.' });
  }
  /*
   * Re-checked rather than asserted. `subject_id` is `NOT NULL` in the
   * schema and `readSession` only ever returns a number, so this cannot
   * fire today — and it fails closed if either stops being true, which is
   * cheaper than discovering a `NaN` reached a `WHERE driver_id = ?`.
   */
  if (typeof session.subjectId !== 'number' || !Number.isInteger(session.subjectId)) {
    throw new TRPCError({ code: 'UNAUTHORIZED', message: 'Sign in with your code and PIN.' });
  }

  return { subjectType: 'driver', driverId: session.subjectId };
}
