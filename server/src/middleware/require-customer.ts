/**
 * `requireCustomer` — the guest-portal gate (Week 4 plan, Task 8).
 *
 * The portal's twin of `requireRole`. A customer session is minted by
 * `portal.login` from a booking reference AND the email on the booking, and
 * its `subject_id` **is** the `bookings.id` — so a procedure behind this
 * gate can reach exactly one booking and there is no field in the session
 * for a resolver to reinterpret.
 *
 * ## Why a gate at all, when the session already names the booking
 *
 * Because the alternative is a resolver that takes a booking reference as
 * input. §6's manual QR screen shows an amount due, an account number and a
 * QR image; the owner's instruction is explicit that **a booking reference
 * alone must reveal nothing** (owner decision 2026-10-14, Q5). A `ref`
 * input would make the page a lookup anyone could run, and refs appear in
 * confirmation emails, screenshots and browser history.
 *
 * So the gate hands the resolver a booking id and nothing else, and the
 * resolver cannot ask for a different one.
 *
 * ## Staff are refused here, deliberately
 *
 * A `user` session is not a customer session. Staff read a booking through
 * the admin surface, where the access is role-gated and audited; letting an
 * admin session satisfy the portal gate would make "which booking is this
 * session for" unanswerable, and that question is the whole mechanism.
 */
import { TRPCError } from '@trpc/server';

/**
 * What the context carries, as far as this gate is concerned.
 *
 * **BUG-119:** `ctx.customerSession` resolves from its own
 * `rg_customer_session` cookie (`context.ts`) and is `null` unless that
 * cookie resolved to a `subjectType === 'customer'` session — so in the
 * real request path a staff or driver cookie never reaches this gate as
 * "the wrong subject type" on this field; it simply never populates
 * `ctx.customerSession` at all. The `subjectType` check below is kept
 * anyway as defence in depth, the same reasoning the numeric-id re-check
 * right after it already gives.
 */
interface CustomerContext {
  customerSession?: { subjectType?: unknown; subjectId?: unknown } | null;
}

export interface CustomerSession {
  readonly subjectType: 'customer';
  /** `bookings.id`. The session IS the booking. */
  readonly subjectId: number;
}

/**
 * Narrows a context to a customer session, or throws `UNAUTHORIZED`.
 *
 * `ctx` is `unknown` rather than a typed context for the same reason
 * `requireRole` takes it that way: the gate re-validates what it is given
 * instead of believing a type annotation that a future refactor could make
 * untrue.
 *
 * `UNAUTHORIZED`, never `FORBIDDEN`: there is no guest identity here to
 * refuse, and a staff or driver session is not a guest identity either.
 */
export function requireCustomer(ctx: unknown): CustomerSession {
  const session = (ctx as CustomerContext | null | undefined)?.customerSession;

  if (!session || session.subjectType !== 'customer') {
    throw new TRPCError({ code: 'UNAUTHORIZED', message: 'Sign in to your booking to see this.' });
  }
  /*
   * The id is re-checked rather than asserted. `subject_id` is `NOT NULL` in
   * the schema and `readSession` only ever returns a number, so this cannot
   * fire today — and it fails closed if either ever stops being true, which
   * is cheaper than discovering that a `NaN` reached a `WHERE id = ?`.
   */
  if (typeof session.subjectId !== 'number' || !Number.isInteger(session.subjectId)) {
    throw new TRPCError({ code: 'UNAUTHORIZED', message: 'Sign in to your booking to see this.' });
  }

  return { subjectType: 'customer', subjectId: session.subjectId };
}
