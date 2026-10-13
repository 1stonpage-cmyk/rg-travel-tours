/**
 * The tRPC context factory (Week 4 plan, Task 1) — the one place a request
 * becomes an identity.
 *
 * **What was here before: nothing.** `app.ts` mounted
 * `createExpressMiddleware({ router: appRouter })` with no `createContext`,
 * so `ctx` was `{}` for every call in the tree. `requireRole` reads
 * `ctx.session` and refuses when it is absent, so every `adminProcedure`
 * has been refusing every request since it was written. That failed CLOSED
 * — nothing was exposed, nothing broke — but it means **no admin procedure
 * has ever executed with a real session.** Task 5's role tests are the
 * first thing that will actually drive one; until then, treat every
 * `adminProcedure` as unexercised rather than as working.
 *
 * ## Resolving a session is a READ, and it is the only thing here
 *
 * This factory does not authorise anything. It answers "who is this
 * request?" and nothing else; the deciding is `requireRole`'s, which
 * re-validates the role against `ADMIN_ROLES` rather than trusting the
 * shape it is handed. Two layers, and the split is deliberate: a context
 * that both resolved and authorised would make every procedure's access
 * rules depend on a file nobody reads when they add a procedure.
 *
 * ## A customer session is NOT a staff session
 *
 * `sessions.subject_type` separates them, and `requireRole` admits only
 * `'user'`. A portal session therefore cannot reach an admin procedure even
 * though both arrive in the same cookie — which is the property Task 5's
 * tests pin explicitly, because "it should not be able to" is exactly the
 * kind of claim that is true until someone adds a shortcut.
 */
import type { CreateExpressContextOptions } from '@trpc/server/adapters/express';
import { SESSION_COOKIE } from './middleware/session-cookie';
import { readSession } from './services/sessions';

/**
 * Reads the cookie, resolves the session, exposes `req`/`res` so a resolver
 * can set or clear the cookie on login and logout.
 *
 * `new Date()` is called here rather than taken as a parameter, and this is
 * the deliberate exception to the rule the rest of the codebase follows:
 * this is the request boundary, where the real clock belongs. Everything
 * downstream that makes a time-based DECISION — `readSession`, `createHold`,
 * `expireHolds` — takes `now` explicitly so it stays testable.
 *
 * A malformed or absent cookie resolves to `session: null`. There is no
 * error path: an anonymous request is the normal case on a public site, not
 * a failure.
 */
export async function createContext({ req, res }: CreateExpressContextOptions) {
  const cookies = req.cookies as Record<string, string | undefined> | undefined;
  const token = cookies?.[SESSION_COOKIE];
  const session = token ? await readSession(token, new Date()) : null;

  return { req, res, session };
}

export type Context = Awaited<ReturnType<typeof createContext>>;
