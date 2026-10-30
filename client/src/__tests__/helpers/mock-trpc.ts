/**
 * Answers tRPC HTTP calls in tests without a server.
 *
 * tRPC v11 batches by default: the path is a comma-separated list of
 * procedures and the body is a JSON array of results in the same order.
 * Honouring that here means components under test exercise the real client,
 * real batching and real error paths — only the socket is faked.
 *
 * The response envelope below was captured by calling the real, running
 * server directly (`server/src/trpc.ts` is `initTRPC.create()` with no
 * `transformer` configured), not assumed. A batched GET against
 * `/trpc/destinations.list,tours.list` returns:
 *
 *   [{"result":{"data":[...]}}, {"error":{"message":"...","code":-32600,...}}]
 *
 * i.e. `{ result: { data: <value> } }` — there is NO superjson `json`
 * wrapper around `data`. A transformer would add one; this server has none,
 * so this mock must not add one either.
 *
 * Handlers are keyed by procedure name ONLY — they are not input-aware.
 * The mock never looks at the request body or the `input` query param, so
 * it cannot distinguish `tours.bySlug` called with two different slugs
 * within the same test; the later `mockTrpc` call simply wins for that
 * name. Fine for every Phase 2 use (one call per procedure per test), but
 * worth knowing before reaching for it on a page that calls the same
 * procedure twice with different input.
 *
 * A handler may be a plain value, a sync function, or an async function —
 * each procedure's resolved/rejected value is `await`ed before use so a
 * `Promise`-returning (e.g. `async () => ...`) handler — the obvious way
 * to write a "deferred resolve" mock — is driven to completion, not
 * serialized mid-flight. Serializing a pending `Promise` directly would
 * silently produce `{}` (JSON.stringify sees no enumerable properties on a
 * Promise, settled or not), handing back wrong data with no error.
 *
 * A function handler may also read the one input tRPC actually sent it —
 * `(input) => ...` — so a mutation test can assert on what the component
 * submitted (e.g. that a package inquiry's `packageId` matches the
 * selected package), not just on what the mock chose to hand back. This is
 * still positional, not deeply input-aware: for a batched POST the body is
 * `{"0": <input0>, "1": <input1>, ...}` (httpBatchLink's `getBody`, no
 * transformer configured — see client/src/lib/trpc.ts), keyed by the
 * input's position in the comma-joined path, so the Nth procedure name
 * gets the Nth parsed body entry.
 */
type HandlerFn = (input?: unknown) => unknown;
type Handlers = Record<string, unknown | HandlerFn>;

/**
 * Sentinel value for `mockTrpcRateLimited` — a real non-JSON HTTP 429, not
 * a tRPC JSON-RPC error envelope. See the comment on that function.
 */
const RATE_LIMITED = Symbol('mock-trpc rate limited');

/**
 * tRPC's own code → HTTP status mapping, for the codes this project uses.
 *
 * Kept here so a simulated refusal lands with the status the real server
 * would send. The client's `fetchWithNormalizedErrors` branches on the HTTP
 * status before tRPC ever parses the body, so a 500 standing in for a 409
 * is not a cosmetic difference.
 */
const CODE_STATUS: Record<string, number> = {
  BAD_REQUEST: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  TIMEOUT: 408,
  CONFLICT: 409,
  PRECONDITION_FAILED: 412,
  PAYLOAD_TOO_LARGE: 413,
  UNPROCESSABLE_CONTENT: 422,
  TOO_MANY_REQUESTS: 429,
  CLIENT_CLOSED_REQUEST: 499,
  INTERNAL_SERVER_ERROR: 500,
};

/**
 * A refusal that carries its tRPC code, so the mock can emit the one the
 * caller asked for.
 *
 * Before this existed, `mockTrpcError`'s `_code` argument was accepted and
 * IGNORED — every simulated failure arrived as `INTERNAL_SERVER_ERROR` /
 * 500 whatever the call site said. Any component branching on
 * `error.data.code` was therefore untestable through this helper, and Task
 * 5 had to stub `globalThis.fetch` by hand to test a `CONFLICT`. The
 * argument now means what it says.
 */
class MockTrpcError extends Error {
  readonly trpcCode: string;
  /**
   * The flattened Zod errors `server/src/trpc.ts`'s `errorFormatter` puts in
   * `data.zodError` for an input-validation failure (task A4). Undefined for
   * every other refusal, exactly as the real server omits the key.
   */
  readonly zodError?: FlattenedZodError;
  constructor(message: string, trpcCode: string, zodError?: FlattenedZodError) {
    super(message);
    this.name = 'MockTrpcError';
    this.trpcCode = trpcCode;
    this.zodError = zodError;
  }
}

/** The shape of `data.zodError` — `z.flattenError()`'s own return value. */
export interface FlattenedZodError {
  formErrors: string[];
  fieldErrors: Record<string, string[]>;
}

let handlers: Handlers = {};
let originalFetch: typeof globalThis.fetch | undefined;

export function mockTrpc(next: Handlers) {
  handlers = { ...handlers, ...next };
  if (originalFetch) return;
  originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input.toString(), 'http://localhost');
    const procedures = decodeURIComponent(url.pathname.replace(/^\/trpc\//, '')).split(',');

    if (procedures.some((name) => handlers[name] === RATE_LIMITED)) {
      // Matches the real rate limiter (express-rate-limit's default
      // handler: `res.status(429).send('Too many requests...')`) byte for
      // byte: a plain-text body, not JSON — see lib/trpc.ts for why that
      // distinction matters to the client.
      return new Response('Too many requests, please try again later.', {
        status: 429,
        headers: { 'content-type': 'text/html; charset=utf-8' },
      });
    }

    let parsedInputs: unknown[] = [];
    if (typeof init?.body === 'string') {
      try {
        const parsed = JSON.parse(init.body) as Record<string, unknown>;
        parsedInputs = procedures.map((_name, index) => parsed[String(index)]);
      } catch {
        // A malformed body is not something this mock has to recover from.
      }
    } else {
      /*
       * A QUERY. `httpBatchLink` puts its inputs in the `input` query
       * param as `{"0": <input0>, ...}` — the same positional shape as a
       * batched POST body, keyed by the procedure's place in the
       * comma-joined path.
       *
       * Parsed here (Week 4 Task 11) so a test can assert on what a page
       * ASKED FOR, not only on what it was given back — which is the only
       * way to prove a filter reaches the server rather than being applied
       * in the browser over one page of rows.
       */
      const raw = url.searchParams.get('input');
      if (raw !== null) {
        try {
          const parsed = JSON.parse(raw) as Record<string, unknown>;
          parsedInputs = procedures.map((_name, index) => parsed[String(index)]);
        } catch {
          // Not JSON: leave the inputs undefined rather than guessing.
        }
      }
    }

    const body = await Promise.all(
      procedures.map(async (name, index) => {
        if (!(name in handlers)) {
          return {
            error: {
              message: `No mock for ${name}`,
              code: -32004,
              data: { code: 'NOT_FOUND', httpStatus: 404 },
            },
          };
        }
        const value = handlers[name];
        try {
          const data = await Promise.resolve(
            typeof value === 'function' ? (value as HandlerFn)(parsedInputs[index]) : value,
          );
          return { result: { data } };
        } catch (err) {
          const message = err instanceof Error ? err.message : 'mock failure';
          // A `MockTrpcError` names its own code; a plain `throw` in a
          // handler still means "something broke", which is a 500.
          const trpcCode = err instanceof MockTrpcError ? err.trpcCode : 'INTERNAL_SERVER_ERROR';
          const httpStatus = CODE_STATUS[trpcCode] ?? 500;
          const zodError = err instanceof MockTrpcError ? err.zodError : undefined;
          return {
            error: {
              message,
              code: -32600,
              // Spread-when-present, mirroring the real errorFormatter's
              // `...(zodError ? { zodError } : {})`: a non-validation refusal
              // must not carry the key at all, or `getFieldErrors` would read
              // an empty object as "this was a validation failure".
              data: { code: trpcCode, httpStatus, ...(zodError ? { zodError } : {}) },
            },
          };
        }
      }),
    );
    /*
     * The OUTER status, which `fetchWithNormalizedErrors` reads before tRPC
     * parses anything.
     *
     * One procedure that refused gets that refusal's status; a mixed batch
     * gets 207, which is what the real server sends and what this project
     * already learned about the hard way — a Week 3 bug turned on
     * `express-rate-limit` treating a 207 as a success.
     */
    const statuses = body
      .map((item) =>
        'error' in item && item.error ? ((item.error.data?.httpStatus as number) ?? 500) : 200,
      )
      .filter((status) => status !== 200);
    const status =
      statuses.length === 0 ? 200 : statuses.every((s2) => s2 === statuses[0]) ? statuses[0]! : 207;

    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof globalThis.fetch;
}

/** Makes one named procedure reject, so error states can be exercised. */
export function mockTrpcError(procedure: string, code?: string, message?: string) {
  /*
   * `message` was added in Week 4 Task 8: the portal sign-in shows the
   * SERVER's own sentence for a refused login (one generic message for a
   * wrong reference and a wrong email alike, per §7), so a test that asserts
   * the guest sees that sentence needs the mock to carry it. Omitted, it
   * stays `'mock failure'`.
   *
   * `code` now DOES something (fixed 2026-10-15, owner request). It used to
   * be accepted and ignored — every simulated failure arrived as
   * `INTERNAL_SERVER_ERROR` / 500 however the call site named it, with a
   * comment claiming that was deliberate because "the client code under
   * test reads the message rather than the code". That stopped being true
   * the moment a screen branched on `error.data.code`: Task 5's
   * duplicate-plate test had to hand-stub `globalThis.fetch` to simulate a
   * `CONFLICT`, which is a lot of machinery to work around a helper that
   * was quietly lying about its own signature.
   *
   * It still fakes the socket rather than minting a real `TRPCError` — the
   * difference is that the body it writes now carries the code and the
   * matching HTTP status, which is what the client actually reads.
   */
  mockTrpc({
    [procedure]: () => {
      throw trpcError(message, code);
    },
  });
}

/**
 * {@link mockTrpcError}'s refusal as a value, for the same reason
 * {@link trpcValidationError} exists: a handler that must refuse only SOME
 * inputs cannot use the whole-handler helpers.
 *
 * Carries NO `zodError`, exactly as the real server omits the key for a
 * refusal its router threw on the merits (an expired coupon, a sold-out
 * date) rather than one tRPC's input stage caught — which is the difference
 * `getFieldErrors` reads to decide whether a form may place messages by
 * field at all.
 */
export function trpcError(message?: string, code?: string): Error {
  return new MockTrpcError(message ?? 'mock failure', code ?? 'INTERNAL_SERVER_ERROR');
}

/**
 * Makes one named procedure refuse the way tRPC's INPUT STAGE refuses — a
 * `BAD_REQUEST` whose `data.zodError` carries flattened field errors and
 * whose `message` is the raw JSON issue list (task A4).
 *
 * Both halves matter and both were captured from the real server rather than
 * invented:
 *
 *  - `data.zodError` is what `server/src/trpc.ts`'s `flatten()` publishes,
 *    and the only thing a form should read.
 *  - `message` is tRPC's own default for a `ZodError`
 *    (`JSON.stringify(error.issues, null, 2)`), which is the raw blob guests
 *    were being shown. A test that mocks a tidy sentence here would pass
 *    against the very bug this task fixes, because the regression it must
 *    catch is "the form rendered `error.message`".
 *
 * The issue list is synthesised from the field errors, so a call site names
 * only what it cares about — the fields and their project-written sentences.
 */
export function mockTrpcValidationError(
  procedure: string,
  errors: { fieldErrors?: Record<string, string[]>; formErrors?: string[] },
) {
  mockTrpc({
    [procedure]: () => {
      throw trpcValidationError(errors);
    },
  });
}

/**
 * The same refusal as {@link mockTrpcValidationError}, as a value a handler
 * can `throw` CONDITIONALLY (task A4 fix round 1).
 *
 * `mockTrpcValidationError` replaces a procedure's handler outright, which is
 * enough for a mutation but not for a QUERY a page re-asks with different
 * input: `CheckoutPage` reacts to a refused coupon by dropping the code and
 * asking `checkout.quote` again WITHOUT it, so a handler that refuses
 * unconditionally blanks the page behind `QueryBoundary` and the coupon
 * field's error line — the thing under test — never renders. An input-aware
 * handler (`(input) => ...`, see this module's header) can refuse the first
 * call and answer the second, which is what the real server does.
 */
export function trpcValidationError(errors: {
  fieldErrors?: Record<string, string[]>;
  formErrors?: string[];
}): Error {
  const fieldErrors = errors.fieldErrors ?? {};
  const formErrors = errors.formErrors ?? [];
  const issues = [
    ...formErrors.map((message) => ({ code: 'custom', path: [] as string[], message })),
    ...Object.entries(fieldErrors).flatMap(([field, messages]) =>
      messages.map((message) => ({ code: 'invalid_format', path: [field], message })),
    ),
  ];
  return new MockTrpcError(JSON.stringify(issues, null, 2), 'BAD_REQUEST', {
    formErrors,
    fieldErrors,
  });
}

/**
 * Makes one named procedure respond the way the real rate limiter does: a
 * plain HTTP 429 with a plain-text body, not a tRPC-shaped JSON error.
 * Exercises `lib/trpc.ts`'s `fetchWithNormalizedErrors` end to end, rather
 * than assuming it works.
 */
export function mockTrpcRateLimited(procedure: string) {
  mockTrpc({ [procedure]: RATE_LIMITED });
}

export function resetTrpcMock() {
  handlers = {};
  if (originalFetch) {
    globalThis.fetch = originalFetch;
    originalFetch = undefined;
  }
}
