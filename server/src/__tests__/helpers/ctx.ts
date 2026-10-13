/**
 * A tRPC context for tests (Week 4, Task 1).
 *
 * **Why this exists now and did not before.** Until Task 1 the router had no
 * context type at all — `initTRPC.create()` with no `.context<…>()` — so
 * `appRouter.createCaller({})` typechecked everywhere and `ctx.session` was
 * `undefined` by construction. Wiring the real `Context` in made that `{}`
 * a type error in five existing suites, which is the type system reporting
 * a real gap rather than being awkward: those callers were passing a context
 * that could never carry a session, against procedures that are supposed to
 * read one.
 *
 * `req` and `res` are the smallest shapes the resolvers actually touch —
 * `req.cookies` for logout, `res.cookie` / `res.clearCookie` for login — so
 * a test gets a usable context without an HTTP round trip. Anything that
 * needs the real Express objects (the rate limiters, the mounted routes)
 * uses `supertest` against `createApp()` instead, and should: a limiter
 * tested through a fake `res` proves nothing about the mount.
 */
import type { Request, Response } from 'express';
import type { ResolvedSession } from '../../services/sessions';

export interface CapturedCookie {
  name: string;
  value: string;
  options: Record<string, unknown>;
}

/** A `res` whose cookie writes are observable, for login/logout assertions. */
export function captureResponse() {
  const set: CapturedCookie[] = [];
  const cleared: CapturedCookie[] = [];
  const res = {
    cookie: (name: string, value: string, options: Record<string, unknown> = {}) => {
      set.push({ name, value, options });
    },
    clearCookie: (name: string, options: Record<string, unknown> = {}) => {
      cleared.push({ name, value: '', options });
    },
  } as unknown as Response;
  return { res, set, cleared };
}

/**
 * A context with no session — the anonymous caller, which is what every
 * public procedure is meant to be exercised as.
 *
 * `session` defaults to `null` rather than being omitted: `null` is what
 * `createContext` produces for an anonymous request, and a test that passed
 * `undefined` would be exercising a state the real factory never emits.
 */
export function testContext(
  session: ResolvedSession | null = null,
  cookies: Record<string, string> = {},
) {
  return {
    req: { cookies } as unknown as Request,
    res: captureResponse().res,
    session,
  };
}

/** A context for a logged-in portal guest, scoped to one booking. */
export function customerContext(bookingId: number) {
  return testContext({ subjectType: 'customer', subjectId: bookingId });
}

/**
 * A context for a logged-in staff member. The role is NOT part of
 * `ResolvedSession` — `requireRole` reads it from the `users` row and
 * re-validates it — so this only carries the subject, which is the honest
 * shape of what a cookie can tell the server.
 */
export function staffContext(userId: number) {
  return testContext({ subjectType: 'user', subjectId: userId });
}
