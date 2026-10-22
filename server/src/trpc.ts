/**
 * The tRPC instance every router and procedure is built from — and, since
 * BUG-102, the one place that decides what an error is allowed to tell a
 * client.
 *
 * `initTRPC.create()` with no options uses tRPC's DEFAULT error shape, which
 * attaches `data.stack` to every error from every procedure whenever
 * `NODE_ENV !== 'production'`. A live probe against the dev server returned
 * absolute filesystem paths (`C:\dev\rg-travel-tours\node_modules\...\
 * resolveResponse.ts:241:17`) to an anonymous caller — the same class of leak
 * task 4.3b closed for malformed URLs (middleware/malformed-url.ts), reached
 * through a different door.
 *
 * Two layers, because one of them is not enough:
 *
 *  1. The returned `data` is built from an ALLOW-LIST of keys, not by
 *     spreading `shape`. `stack` is not dropped so much as never selected,
 *     so a future tRPC version that adds another diagnostic field does not
 *     silently start shipping it. (Same discipline as the probe payload in
 *     db/content-status.ts, for the same reason.)
 *  2. `message` is scrubbed of anything path-shaped. The message is NOT a
 *     safe-by-construction string: an unexpected internal error reports the
 *     underlying error's own message, and plenty of those carry a path
 *     (`ENOENT: ... open '/var/www/...'`, a module-resolution failure, a
 *     driver error). Keeping the message is deliberate — the client needs the
 *     code and the Zod issues — so it is cleaned rather than discarded.
 *
 * Applied in EVERY environment, not only production: the dev server is
 * reachable on the LAN (`pnpm dev:lan`) and "it only leaks in development"
 * has never been a boundary anyone can hold.
 *
 * What still reaches the client, on purpose:
 *   - `code` / `data.code`     — BAD_REQUEST, INTERNAL_SERVER_ERROR, …
 *   - `data.httpStatus`        — lib/mutation-errors.ts reads 429 off this
 *   - `data.path`              — the tRPC PROCEDURE path (`newsletter.subscribe`),
 *                                not a filesystem path
 *   - `message`                — scrubbed
 *   - `data.zodError`          — flattened field errors, so a form can say
 *                                which field failed (see below)
 *
 * Server-side diagnosis is untouched: nothing here suppresses logging, and
 * `TRPCError.cause` (the real error, kept for the server) was never part of
 * the response shape to begin with.
 */
import { initTRPC, TRPCError } from '@trpc/server';
import type { Context } from './context';
import { ZodError, z } from 'zod';
import { PASSWORD_CHANGE_REQUIRED, type AdminRole } from '@rg/shared';
import { requireCustomer } from './middleware/require-customer';
import { requireDriver } from './middleware/require-driver';
import {
  ROLE_MATRIX,
  requireRole,
  type AdminArea,
  type StaffSession,
} from './middleware/require-role';

/**
 * Shapes a filesystem location takes in an error message. Each entry exists
 * because it is a real observed or realistic leak, not for completeness:
 *
 *  - `file://…`  — Node's own stack frames and ESM loader errors.
 *  - `C:\…`      — every absolute path on this Windows dev machine.
 *  - `…/node_modules/…` — a dependency's internals, on any platform.
 *  - `…/x.ts:12:3`      — a source reference with a line:column, which is
 *                         what makes a scrubbed message still read as a stack.
 *  - `/var/…`, `/home/…`, … — the deploy target is Linux; these are where an
 *                         absolute path there actually lives.
 *
 * Replaced with a fixed token so a scrubbed message is still readable (and so
 * a test can tell "scrubbed" from "there was never a path here").
 */
const PATH_LIKE: readonly RegExp[] = [
  /\bfile:\/\/\S+/gi,
  /\b[A-Za-z]:[\\/][^\s"')]*/g,
  /\S*\/node_modules\/\S*/g,
  /\S*\/[\w.-]+\.[cm]?[jt]sx?:\d+:\d+/g,
  /\S*\/(?:usr|var|home|opt|srv|etc|root|tmp)\/\S*/g,
];

/** The fixed stand-in for anything that looked like a filesystem location. */
export const REDACTED_PATH = '[path redacted]';

/** Removes every filesystem-shaped substring from a client-bound string. */
export function scrubPaths(message: string): string {
  return PATH_LIKE.reduce((text, pattern) => text.replace(pattern, REDACTED_PATH), message);
}

/**
 * What every procedure must declare about who may call it (task A4).
 *
 * A discriminated union, not optional fields: there is no "unset".
 * `publicProcedure` stamps the first variant, `customerProcedure` the
 * second, `adminProcedure()` the third, and because `t` is never exported
 * those are the only three ways a procedure on this server can come into
 * existence. That is what makes the metadata a FACT about the procedure
 * rather than a label someone remembered to apply — and what lets
 * `procedure-role-metadata.test.ts` enumerate `appRouter` and refuse
 * anything carrying none of them.
 *
 * `customer` arrived in Week 4 Task 8 with the guest portal: the manual-QR
 * screen shows an amount due and an account number, and a booking reference
 * alone must not reveal either (owner decision 2026-10-14, Q5). It is a
 * third ACCESS KIND rather than a role, because a guest has no role — their
 * session names one booking and that is the whole of their authority.
 *
 * `driver` arrived in Week 6 Task 1 with the driver portal, and is a FOURTH
 * access kind for the same reason: a driver has no admin role either, and
 * their session names one `drivers.id` which is the whole of their
 * authority. See `driverProcedure` below.
 *
 * `roles` is denormalised into the meta on purpose. The gate already spreads
 * `ROLE_MATRIX[area]`, so this copy is redundant at runtime — but it means the
 * enumeration guard can compare what a procedure CLAIMS against §9's matrix
 * without re-deriving it, and a procedure whose two halves disagree fails.
 */
export type ProcedureAccess =
  | { readonly access: 'public' }
  | { readonly access: 'customer' }
  | { readonly access: 'driver' }
  | {
      readonly access: 'admin';
      readonly area: AdminArea;
      readonly roles: readonly AdminRole[];
      /**
       * True only on the procedures a staff member who still has to replace a
       * temporary password may call. `adminProcedure` refuses everyone in that
       * state; `adminProcedureAllowingPasswordChange` is the one exemption,
       * and the guard test pins exactly which procedures use it.
       */
      readonly allowsPasswordChange?: true;
    };

/*
 * `.context<Context>()` is Week 4, Task 1's other half: `context.ts` builds
 * the context at runtime, and this is what makes it visible to a resolver's
 * TYPES. Without it `ctx` is `{}`, so `ctx.res` is a type error and no
 * resolver can set a cookie — which is how typecheck caught the gap rather
 * than it being discovered when `portal.login` silently had no `res`.
 *
 * It is also what gives `ctx.session` a type for `requireRole` to narrow.
 * The runtime gate still re-validates the role rather than trusting it:
 * a type is an assumption, and this one arrives from a cookie.
 */
const t = initTRPC
  .context<Context>()
  .meta<ProcedureAccess>()
  .create({
    errorFormatter({ shape, error }) {
      /*
       * Input validation failures arrive as a BAD_REQUEST whose `cause` is the
       * ZodError. Flattened field errors are published explicitly rather than
       * left only inside the stringified `message` tRPC puts there by default,
       * so a form has something to read per field without parsing prose. The
       * strings come from Zod's own issue messages (client-supplied input is
       * never echoed into them), and they are scrubbed anyway — a custom
       * `.refine` message is project copy, and project copy can change.
       */
      const zodError = error.cause instanceof ZodError ? flatten(error.cause) : undefined;

      return {
        message: scrubPaths(shape.message),
        code: shape.code,
        data: {
          code: shape.data.code,
          httpStatus: shape.data.httpStatus,
          path: shape.data.path,
          ...(zodError ? { zodError } : {}),
        },
      };
    },
  });

function flatten(error: ZodError): {
  formErrors: string[];
  fieldErrors: Record<string, string[]>;
} {
  const flat = z.flattenError(error);
  return {
    formErrors: flat.formErrors.map(scrubPaths),
    fieldErrors: Object.fromEntries(
      Object.entries(flat.fieldErrors as Record<string, string[] | undefined>).map(
        ([field, messages]) => [field, (messages ?? []).map(scrubPaths)],
      ),
    ),
  };
}

export const router = t.router;

/**
 * Composes two routers into ONE namespace (Week 6, Task 2).
 *
 * Needed because `driver.login` is public and `driver.trips` is
 * driver-gated, while both must sit directly under `driver.*`: the login's
 * tRPC path is a contract with the per-IP limiter in `app.ts`
 * (`DRIVER_LOGIN_PROCEDURES`), and the gated procedures cannot be nested a
 * level deeper without that namespace meaning two different things.
 *
 * It is `t.mergeRouters`, not a spread of `_def`: the merge is tRPC's own,
 * so every procedure keeps the metadata its builder stamped on it and
 * `procedure-role-metadata.test.ts` still reads a complete, accurate map.
 * Nothing about the gates changes — a merged router is the same procedures
 * under one record.
 */
export const mergeRouters = t.mergeRouters;

/**
 * An unauthenticated procedure, open to the internet.
 *
 * Carries `{ access: 'public' }` so that "this is public" is something the
 * procedure SAYS, in the codebase, next to the code — rather than something a
 * test file remembers about it in a list somewhere else.
 *
 * Its context stays `object`: no `session` field exists on it, so a resolver
 * built here that reaches for `ctx.session` is a TYPE ERROR, not a runtime
 * surprise. Any admin handler needs the actor (an audit row, a
 * `verified_by`), which is exactly the thing this builder cannot give it.
 */
export const publicProcedure = t.procedure.meta({ access: 'public' });

/**
 * A procedure only a signed-in GUEST may call (Week 4, Task 8).
 *
 * The portal's counterpart to `adminProcedure`, and it exists for the same
 * reason: so the gate cannot be forgotten. `requireCustomer` replaces
 * `ctx.session` with a narrowed `CustomerSession` whose `subjectId` IS the
 * booking id, so a resolver downstream reaches exactly one booking and has
 * no input field through which to ask for another. That is what makes "a
 * portal session reaches one booking" structural rather than a rule every
 * future resolver has to remember (CLAUDE.md, RA 10173).
 *
 * No area and no roles: a guest has neither. The one thing the metadata
 * needs to say is that this is not public, and the enumeration guard holds
 * it to the same anonymous-caller proof the admin procedures get.
 */
export const customerProcedure = t.procedure
  .meta({ access: 'customer' })
  .use(({ ctx, next }) => next({ ctx: { session: requireCustomer(ctx) } }));

/**
 * A procedure only a signed-in DRIVER may call (Week 6, Task 1 — §8).
 *
 * Built from `customerProcedure` above, which is the shape it copies. The
 * gate is `requireDriver`, and it refuses **a staff session and a customer
 * session as firmly as it refuses no session at all** — not merely "some
 * session exists". That distinction is the whole control: a driver's day
 * sheet carries other guests' names and phone numbers, and a signed-in
 * guest reaching it would be an RA 10173 disclosure with a 200 status code.
 *
 * The validated driver arrives as `ctx.driver = { driverId }` rather than
 * replacing `ctx.session`, so a resolver downstream says what it means:
 * `ctx.driver.driverId` is the only driver it can ever reach, and there is
 * no input field through which to ask for another. A resolver that reached
 * for `ctx.driver` without this builder is `error TS2339`.
 *
 * No area and no roles: a driver has neither, exactly as a guest does not.
 * The one thing the metadata needs to say is that this is not public.
 *
 * **`procedure-role-metadata.test.ts` does not yet know this access kind**
 * — its local `accessOf()` recognises `public`, `customer` and `admin` only
 * — so the first driver-gated procedure MOUNTED on `appRouter` (Week 6,
 * Task 2) must come with a reviewed `driver` branch and an
 * anonymous/cross-session refusal assertion added to that guard. Task 1
 * mounts only the public `driver.login` / `driver.logout`, so the guard is
 * honest as it stands; it is not a file to edit casually, and the gate is
 * proven here by `driver-auth.test.ts` against a test-local router of the
 * same shape the guard's own `weekFiveShaped` fixture uses.
 */
export const driverProcedure = t.procedure
  .meta({ access: 'driver' })
  .use(({ ctx, next }) => next({ ctx: { driver: requireDriver(ctx) } }));

/**
 * The ONLY way to build an admin procedure (task A4).
 *
 * CLAUDE.md: "Role middleware on every admin procedure" and "Hiding a button
 * is not access control." Task 17 built the gate; this is what makes calling
 * it impossible to forget. `area` is a REQUIRED positional argument of type
 * `AdminArea`, so:
 *
 *   - `adminProcedure()` with no area is `error TS2554: Expected 1 arguments,
 *     but got 0` — the gate cannot be omitted, only mis-chosen.
 *   - `adminProcedure('tours')` (a typo, or an area §9 does not have) is
 *     `error TS2345` — the area cannot be invented.
 *   - the resolver receives `ctx.session` typed as `StaffSession`, already
 *     validated by the gate, which is the only place on this server such a
 *     value exists. An ungated copy of the same handler cannot type-check.
 *
 * What types cannot reach — somebody building a procedure that IS
 * administrative out of `publicProcedure` and never touching `ctx` — is the
 * backstop's job, not this one's. See `procedure-role-metadata.test.ts`.
 *
 * The validated session this installs is also where a service-layer actor
 * comes from. `verifyCashPayment()` (A5b) takes a
 * `verifier: { type, id, role }` and re-checks the role itself; its Week 5
 * procedure is `adminProcedure('verifyPayments')` and passes
 * `{ type: 'user', id: ctx.session.subjectId, role: ctx.session.role }` —
 * from this gate, never from the request payload. The service keeps its own
 * check (it is also callable from a job or a script, where there is no tRPC
 * context); this builder is what guarantees the HTTP door cannot supply a
 * role the caller merely claimed.
 *
 * The area names itself and the roles come from `ROLE_MATRIX`, never from the
 * caller: task 17's rule that §9's table is transcribed exactly once. There is
 * deliberately NO overload taking a role list, because a per-procedure role
 * list is a second copy of the matrix and the first thing to drift from it.
 */
export function adminProcedure(area: AdminArea) {
  return t.procedure.meta({ access: 'admin', area, roles: ROLE_MATRIX[area] }).use(
    /*
     * `ctx` is widened to `unknown` by the gate itself, which re-validates the
     * role rather than believing a type annotation. What comes back is the
     * narrowed session, and it REPLACES whatever `session` the incoming
     * context carried — a procedure downstream can never read an unvalidated
     * one.
     *
     * The must-change check lives HERE, in the one builder every admin
     * procedure comes from, so a procedure written next year is gated without
     * its author doing anything. It runs after the role check: a caller who is
     * not permitted at all is told that, not that they owe a new password.
     */
    ({ ctx, next }) => {
      const session = requireRole(...ROLE_MATRIX[area])(ctx);
      if (session.mustChangePassword === true) throw passwordChangeRequired();
      return next({ ctx: { session } });
    },
  );
}

/**
 * The ONLY other way to build an admin procedure: the same role gate, minus
 * the must-change refusal. For `staffAuth.me` (the client asks it whether a
 * change is owed) and `staffAuth.changePassword` (the way out of the state).
 * `logout` is public and needs neither. Anything else added here lets a
 * temporary password do real work, so `staff-must-change.test.ts` pins the
 * exact list.
 */
export function adminProcedureAllowingPasswordChange(area: AdminArea) {
  return t.procedure
    .meta({ access: 'admin', area, roles: ROLE_MATRIX[area], allowsPasswordChange: true })
    .use(({ ctx, next }) => next({ ctx: { session: requireRole(...ROLE_MATRIX[area])(ctx) } }));
}

/** `message` IS the reason string, as the driver login's refusals are. */
function passwordChangeRequired(): TRPCError {
  return new TRPCError({ code: 'FORBIDDEN', message: PASSWORD_CHANGE_REQUIRED });
}

export type { AdminArea, StaffSession };
