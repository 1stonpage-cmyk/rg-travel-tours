/**
 * Plan Task 20 — the last middleware in the stack: anything thrown that
 * nothing else caught ends here.
 *
 * Without it, Express hands the error to `finalhandler`, which outside
 * `NODE_ENV=production` replies with an HTML page containing the stack trace
 * — absolute filesystem paths included — to whoever made the request. That
 * is the same leak BUG-102 closed for tRPC procedures and task 4.3b closed
 * for malformed URLs, reached through a third door. It is not hypothetical:
 * before this handler, `POST /trpc/health` with the body `{bad` answered
 * with `<pre>SyntaxError: ...<br> at parse
 * (C:\dev\rg-travel-tours\node_modules\...\body-parser\lib\types\json.js:91:21)`
 * — a real reachable path on the app the dev server runs.
 *
 * Applied in EVERY environment, not just production. "It only leaks in
 * development" stopped being a boundary the moment `pnpm dev:lan` existed.
 *
 * The real error is logged server-side with its stack. The client gets a
 * fixed string and nothing else — no message, because an arbitrary internal
 * error's message is not a safe-by-construction string (`ENOENT: ... open
 * '/var/www/...'` is a message).
 *
 * ## Cleanup A2 — a client error keeps its 4xx
 *
 * Answering EVERYTHING with 500 was right for a genuine server fault and
 * wrong for the one error path the real app actually reaches here:
 * `express.json()` throws on a malformed request body, and that is the
 * caller's mistake, not the server's. Before this handler existed it was a
 * 400 (with finalhandler's stack page, which is why the handler exists); the
 * handler kept the fix and lost the status.
 *
 * So a `status` / `statusCode` in the **4xx** range is honoured — and
 * nothing else is. A 5xx or an absent status stays 500, because an error
 * that never set a status is by definition one nobody classified, and
 * guessing a client error for it would tell a caller their request was bad
 * when the database was down.
 *
 * The body is still never the error's own message. It is the standard reason
 * phrase for the status — a fixed string per status, from Node's own table,
 * with no input from the error beyond the number itself.
 */
import { STATUS_CODES } from 'node:http';
import type { ErrorRequestHandler } from 'express';

/** The whole body. No message, no error detail, no status text echo. */
export const INTERNAL_ERROR_BODY = { error: 'Internal Server Error' } as const;

/**
 * The 4xx an error asked for, or `undefined` for everything else.
 *
 * Both spellings are read because both are in the wild: `http-errors` (what
 * body-parser throws) sets BOTH `status` and `statusCode`, Express's own
 * docs use `status`, and various libraries set only `statusCode`. Anything
 * that is not an integer in [400, 500) — a string `'400'`, a 5xx, `NaN`, a
 * missing property — is not honoured.
 */
function clientErrorStatus(err: unknown): number | undefined {
  if (typeof err !== 'object' || err === null) return undefined;
  const { status, statusCode } = err as { status?: unknown; statusCode?: unknown };
  const candidate = typeof status === 'number' ? status : statusCode;
  if (typeof candidate !== 'number' || !Number.isInteger(candidate)) return undefined;
  return candidate >= 400 && candidate <= 499 ? candidate : undefined;
}

/**
 * The fixed body for a client error: the status's own reason phrase, never
 * the error's message. `STATUS_CODES` is Node's constant table, so this is a
 * per-status literal — `{ error: 'Bad Request' }` for a 400, matching what
 * `rejectMalformedUrl` already answers. An unassigned 4xx (499, say) has no
 * phrase; it gets a generic one rather than echoing the number back as text.
 */
export function clientErrorBody(status: number): { error: string } {
  return { error: STATUS_CODES[status] ?? 'Client Error' };
}

/**
 * What goes in the log, and deliberately NOT the error object itself.
 *
 * `console.error(err)` runs `util.inspect`, which prints an Error's extra own
 * properties alongside the stack — and body-parser attaches the RAW REQUEST
 * BODY to its `SyntaxError` as `err.body`. On a login or checkout request
 * that body is a password or a guest's personal data, so logging the object
 * would write exactly what CLAUDE.md forbids into the server log. The stack
 * carries the name, the message and the frames, and nothing from the
 * request.
 *
 * A thrown non-Error has no stack to take, and inspecting it would reopen
 * the same hole (`throw { password }` is legal JavaScript), so it is
 * reported by type only. Rare, and the request line below still says which
 * route produced it.
 */
function logDetail(err: unknown): string {
  if (err instanceof Error) return err.stack ?? `${err.name}: ${err.message}`;
  return `non-Error thrown (${typeof err})`;
}

/**
 * Express's four-argument error middleware. MOUNT IT LAST — Express only
 * recognises a four-argument function as an error handler, and only reaches
 * it after the routes.
 */
export const errorHandler: ErrorRequestHandler = (err, req, res, next) => {
  // Headers already flushed: Express's default handler must take it from
  // here, because writing a second status would throw inside this handler
  // and lose the response that was already on its way.
  if (res.headersSent) {
    next(err);
    return;
  }

  // `req.path` only — never `req.url` (its query string can carry a token)
  // and never the body. Not percent-decoded by Express, so it cannot carry a
  // newline into the log line.
  console.error(`[error] ${req.method} ${req.path}`, logDetail(err));

  // Logged first, and logged identically either way: a 400 that keeps
  // happening is how a broken client gets noticed.
  const clientStatus = clientErrorStatus(err);
  if (clientStatus !== undefined) {
    res.status(clientStatus).json(clientErrorBody(clientStatus));
    return;
  }

  res.status(500).json(INTERNAL_ERROR_BODY);
};
