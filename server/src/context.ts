/**
 * The tRPC context factory (Week 4 plan, Task 1) — the one place a request
 * becomes an identity. Split into three surface-scoped fields for BUG-119
 * (Week 7): see the note below, "Three sessions, not one".
 *
 * **What was here before: nothing.** `app.ts` mounted
 * `createExpressMiddleware({ router: appRouter })` with no `createContext`,
 * so `ctx` was `{}` for every call in the tree. `requireRole` reads
 * `ctx.adminSession` and refuses when it is absent, so every `adminProcedure`
 * has been refusing every request since it was written. That failed CLOSED
 * — nothing was exposed, nothing broke — but it means **no admin procedure
 * has ever executed with a real session.** Task 5's role tests are the
 * first thing that will actually drive one; until then, treat every
 * `adminProcedure` as unexercised rather than as working.
 *
 * ## Resolving a session is a READ, and it is the only thing here
 *
 * This factory does not authorise anything. It answers "who is this
 * request?" and nothing else; the deciding is `requireRole`'s (and
 * `requireDriver`'s, `requireCustomer`'s), which re-validate rather than
 * trusting the shape they are handed. Two layers, and the split is
 * deliberate: a context that both resolved and authorised would make every
 * procedure's access rules depend on a file nobody reads when they add a
 * procedure.
 *
 * ## Three sessions, not one (BUG-119)
 *
 * Until this fix there was one `rg_session` cookie and one `ctx.session`
 * field, and a portal session and a staff session "arrived in the same
 * cookie" — only `subject_type` told them apart, and only one could be live
 * in a browser at a time. Signing a guest into "My Booking" overwrote a live
 * staff session in the same browser, and vice versa. Not a privilege
 * escalation (the evicted session's row still carried its own subject type,
 * so the evicted user was signed out, not impersonated) but a real bug: two
 * surfaces could never be signed in at once.
 *
 * Three cookies, one per `SessionSubject`, fix that — a browser can now hold
 * all three at once. Which means this factory can no longer resolve "the
 * session for this request" as a single value: it resolves THREE,
 * independently, from three different cookies, each kept only if it both
 * exists and resolves to the subject type that cookie is for.
 *
 *  - `ctx.adminSession`    — from `rg_admin_session`, kept only if
 *                            `subjectType === 'user'`.
 *  - `ctx.driverSession`   — from `rg_driver_session`, kept only if
 *                            `subjectType === 'driver'`.
 *  - `ctx.customerSession` — from `rg_customer_session`, kept only if
 *                            `subjectType === 'customer'`.
 *
 * Each cookie is only looked up when it is actually present — most requests
 * carry at most one or two of the three, and there is no reason to query
 * `sessions` for a cookie nobody sent.
 *
 * **Each field already guarantees its own subject type by construction —
 * and `requireRole` / `requireDriver` / `requireCustomer` re-check it
 * anyway.** It would be tempting to read the guarantee above as "the gates
 * only need to check that their one field is present", and that was this
 * task's first draft. It was deliberately reverted: the guarantee holds for
 * every context this factory produces, but a gate is exported and callable
 * from anywhere (a test fixture, a script, a future refactor that builds a
 * context some other way), and `requireRole`'s own `subjectType` re-check is
 * the only thing standing between a fabricated
 * `{ adminSession: { subjectType: 'driver', subjectId: 3, role: 'owner' } }`
 * and an admitted admin call — proven by temporarily removing it (Task B5),
 * which newly admitted exactly that shape. Each gate's own doc comment
 * explains this re-check as defence in depth; this note exists so NEITHER
 * comment is read in isolation as licence to delete the other's check.
 * **Do not remove the `subjectType` check from any of the three gates on
 * the strength of this paragraph.**
 */
import type { CreateExpressContextOptions } from '@trpc/server/adapters/express';
import { SESSION_COOKIE_BY_SUBJECT } from './middleware/session-cookie';
import { readSession, type ResolvedSession, type SessionSubject } from './services/sessions';

type CookieJar = Record<string, string | undefined> | undefined;

/**
 * Resolves one surface's cookie to its session, or `null` — never throws.
 * Kept only when the token is present AND it resolves to a live session of
 * EXACTLY the subject type this surface's cookie is for: a stolen or
 * mis-set cookie that happened to resolve to a different subject type must
 * not be handed to that surface's gate as if it were legitimate.
 */
async function resolveSurfaceSession(
  cookies: CookieJar,
  subjectType: SessionSubject,
  now: Date,
): Promise<ResolvedSession | null> {
  const token = cookies?.[SESSION_COOKIE_BY_SUBJECT[subjectType]];
  if (!token) return null;
  const session = await readSession(token, now);
  if (!session || session.subjectType !== subjectType) return null;
  return session;
}

/**
 * Reads the three cookies, resolves whichever are present, exposes
 * `req`/`res` so a resolver can set or clear a cookie on login and logout.
 *
 * `new Date()` is called here rather than taken as a parameter, and this is
 * the deliberate exception to the rule the rest of the codebase follows:
 * this is the request boundary, where the real clock belongs. Everything
 * downstream that makes a time-based DECISION — `readSession`, `createHold`,
 * `expireHolds` — takes `now` explicitly so it stays testable. The same
 * `now` is used for all three lookups, so they agree on one instant.
 *
 * A malformed, absent or wrong-subject cookie resolves its field to `null`.
 * There is no error path: an anonymous request is the normal case on a
 * public site, not a failure.
 */
export async function createContext({ req, res }: CreateExpressContextOptions) {
  const cookies = req.cookies as CookieJar;
  const now = new Date();

  const [adminSession, driverSession, customerSession] = await Promise.all([
    resolveSurfaceSession(cookies, 'user', now),
    resolveSurfaceSession(cookies, 'driver', now),
    resolveSurfaceSession(cookies, 'customer', now),
  ]);

  return { req, res, adminSession, driverSession, customerSession };
}

export type Context = Awaited<ReturnType<typeof createContext>>;
