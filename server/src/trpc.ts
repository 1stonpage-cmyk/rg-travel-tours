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

const t = initTRPC.create({
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
export const publicProcedure = t.procedure;
