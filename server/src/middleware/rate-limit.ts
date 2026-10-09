import { rateLimit } from 'express-rate-limit';
import type { RequestHandler } from 'express';

/**
 * Wraps `express-rate-limit` so it only counts/limits requests that target
 * one of `procedures` — every other tRPC procedure (and any non-tRPC
 * request under the mount path) passes through untouched.
 *
 * ## The path shape, verified against the real client and the real mount
 *
 * `client/src/lib/trpc.ts` uses `httpBatchLink`. A real batched call
 * (`Promise.all` of two calls of the *same* HTTP method — two mutations,
 * or two queries) lands as one request whose path is the two procedure
 * names joined by a comma, e.g. `/inquiries.create,newsletter.subscribe`.
 * A query and a mutation never share a batch — they're different HTTP
 * methods (GET vs POST) — so each goes out as its own request. All of
 * this was confirmed with a real `httpBatchLink` client against a live
 * Express+tRPC server, not assumed; see task-1.7-report.md.
 *
 * The other thing that had to be checked for real: when this middleware
 * is mounted the way `app.ts` mounts it —
 * `app.use('/trpc', createProcedureRateLimit(...))` — Express strips the
 * `/trpc` mount prefix from `req.path` *inside* the middleware (this is
 * standard Express path-mounting behaviour, true for a plain middleware
 * function exactly as it is for a Router). So in production `req.path` is
 * `/inquiries.create`, not `/trpc/inquiries.create`.
 *
 * That matters because the brief's own unit tests mount this middleware
 * at the app root (`app.use(createProcedureRateLimit(...))`, no path
 * argument) and send requests to `/trpc/inquiries.create` directly — so
 * in *those* tests `req.path` still has the `/trpc/` prefix. A predicate
 * that only strips a leading `/trpc/` (and nothing else) passes the given
 * unit tests while being silently broken in production: a single,
 * unbatched call to `/inquiries.create` would keep its leading `/` after
 * stripping nothing, `'/inquiries.create' !== 'inquiries.create'`, and the
 * limiter would never fire. Verified this failure mode with a throwaway
 * probe against the real mount shape before writing the fix below — see
 * the report for the exact output.
 *
 * The fix: strip a leading `/`, and *then* an optional `trpc/` right
 * after it. That normalizes both shapes (`/trpc/inquiries.create` and
 * `/inquiries.create`) to the same `inquiries.create`, so matching works
 * whether this middleware ends up mounted with the prefix still on the
 * path or already stripped.
 */
export function createProcedureRateLimit(
  procedures: string[],
  opts: { windowMs: number; max: number },
): RequestHandler {
  return rateLimit({
    windowMs: opts.windowMs,
    limit: opts.max,
    standardHeaders: true,
    legacyHeaders: false,
    skip: (req) =>
      !req.path
        .replace(/^\/(trpc\/)?/, '')
        .split(',')
        .some((p) => procedures.includes(p)),
  });
}
