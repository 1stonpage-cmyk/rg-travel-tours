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
import { initTRPC } from '@trpc/server';
import { ZodError, z } from 'zod';
import type { AdminRole } from '@rg/shared';
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
 * A discriminated union, not two optional fields: there is no third state and
 * no "unset". `publicProcedure` stamps the first variant, `adminProcedure()`
 * stamps the second, and because `t` is never exported those are the only two
 * ways a procedure on this server can come into existence. That is what makes
 * the metadata a FACT about the procedure rather than a label someone
 * remembered to apply — and what lets `procedure-role-metadata.test.ts`
 * enumerate `appRouter` and refuse anything carrying neither.
 *
 * `roles` is denormalised into the meta on purpose. The gate already spreads
 * `ROLE_MATRIX[area]`, so this copy is redundant at runtime — but it means the
 * enumeration guard can compare what a procedure CLAIMS against §9's matrix
 * without re-deriving it, and a procedure whose two halves disagree fails.
 */
export type ProcedureAccess =
  | { readonly access: 'public' }
  | {
      readonly access: 'admin';
      readonly area: AdminArea;
      readonly roles: readonly AdminRole[];
    };

const t = initTRPC.meta<ProcedureAccess>().create({
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
     */
    ({ ctx, next }) => next({ ctx: { session: requireRole(...ROLE_MATRIX[area])(ctx) } }),
  );
}

export type { AdminArea, StaffSession };
