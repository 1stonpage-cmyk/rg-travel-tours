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
import type { AdminRole } from '@rg/shared';
import { appRouter } from '../../routers/_app';
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
 * A context with no session at all on any of the three surfaces — the
 * anonymous caller, which is what every public procedure is meant to be
 * exercised as.
 *
 * **BUG-119:** `createContext` used to resolve one `session` field from one
 * shared cookie; it now resolves three independent, surface-scoped fields
 * (`adminSession`, `driverSession`, `customerSession`) from three separate
 * cookies. This helper takes the single `ResolvedSession` every existing
 * caller already passes and sorts it onto the ONE field matching its own
 * `subjectType`, leaving the other two `null` — exactly what the real
 * factory would produce for a browser carrying only that one surface's
 * cookie. `staffContext`, `customerContext` and `driverContext` below are
 * unchanged by this: they still build one `ResolvedSession` and hand it
 * here.
 *
 * `null` rather than omitting a field: `null` is what `createContext`
 * produces for a cookie that is absent, invalid or the wrong subject, and a
 * test that passed `undefined` would be exercising a state the real factory
 * never emits.
 */
export function testContext(
  session: ResolvedSession | null = null,
  cookies: Record<string, string> = {},
) {
  return {
    req: { cookies } as unknown as Request,
    res: captureResponse().res,
    adminSession: session?.subjectType === 'user' ? session : null,
    driverSession: session?.subjectType === 'driver' ? session : null,
    customerSession: session?.subjectType === 'customer' ? session : null,
  };
}

/** A context for a logged-in portal guest, scoped to one booking. */
export function customerContext(bookingId: number) {
  return testContext({ subjectType: 'customer', subjectId: bookingId });
}

/**
 * A context for a logged-in DRIVER, scoped to one `drivers.id` (Week 6,
 * Task 2).
 *
 * The shape `readSession` returns for a `subject_type = 'driver'` row — no
 * `role`, because a driver has none, and nothing else either: the session
 * IS the driver. `requireDriver` turns exactly this into
 * `ctx.driver.driverId`, which is the only filter a driver procedure may
 * use.
 *
 * Here rather than inline in a test file, and `driverCaller` with it,
 * because Task 1 built its callers inline and Task 2 would otherwise build
 * a second copy — two places to update the day the session shape changes,
 * which is how one of them quietly stops exercising the real context.
 */
export function driverContext(driverId: number) {
  return testContext({ subjectType: 'driver', subjectId: driverId });
}

/**
 * A caller on the REAL `appRouter` signed in as `driverId`.
 *
 * `appRouter`, never a test-local router of the same shape: Task 1 had to
 * prove `driverProcedure`'s gate against a fixture because no driver-gated
 * procedure was mounted yet, and a fixture cannot tell you whether the
 * thing you actually serve is gated. From Task 2 on there is a mounted
 * procedure, so tests go through the mount.
 */
export function driverCaller(driverId: number) {
  return appRouter.createCaller(driverContext(driverId) as never);
}

/**
 * A context for a logged-in staff member.
 *
 * The role is part of `ResolvedSession` because `readSession` resolves it
 * LIVE from the `users` row on every request — it is never stored in the
 * session — and `requireRole` then re-parses it rather than trusting it.
 * This helper is the shape the real factory produces, so a test that uses
 * it is exercising the same context an authenticated request would.
 *
 * `name` is optional and omitted by every existing call site: almost none of
 * them exercise `staffAuth.me`, which is the only resolver that reads it.
 * The handful that do (Task 16, 7M) pass it explicitly.
 */
export function staffContext(userId: number, role: AdminRole = 'owner', name?: string) {
  return testContext({ subjectType: 'user', subjectId: userId, role, name });
}
