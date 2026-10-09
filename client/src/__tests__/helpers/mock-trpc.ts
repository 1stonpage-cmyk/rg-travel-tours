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
 */
type Handlers = Record<string, unknown | (() => unknown)>;

let handlers: Handlers = {};
let originalFetch: typeof globalThis.fetch | undefined;

export function mockTrpc(next: Handlers) {
  handlers = { ...handlers, ...next };
  if (originalFetch) return;
  originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(typeof input === 'string' ? input : input.toString(), 'http://localhost');
    const procedures = decodeURIComponent(url.pathname.replace(/^\/trpc\//, '')).split(',');
    const body = procedures.map((name) => {
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
        const data = typeof value === 'function' ? (value as () => unknown)() : value;
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
    });
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

export function resetTrpcMock() {
  handlers = {};
  if (originalFetch) {
    globalThis.fetch = originalFetch;
    originalFetch = undefined;
  }
}
