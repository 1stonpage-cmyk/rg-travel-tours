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
        // GET requests (queries) have no JSON body — nothing to parse.
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
          return {
            error: {
              message,
              code: -32600,
              data: { code: 'INTERNAL_SERVER_ERROR', httpStatus: 500 },
            },
          };
        }
      }),
    );
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof globalThis.fetch;
}

/** Makes one named procedure reject, so error states can be exercised. */
export function mockTrpcError(procedure: string) {
  mockTrpc({
    [procedure]: () => {
      throw new Error('mock failure');
    },
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
