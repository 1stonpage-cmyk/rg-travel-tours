import { httpBatchLink } from '@trpc/client';
import { createTRPCReact } from '@trpc/react-query';
import { QueryClientProvider } from '@tanstack/react-query';
import { createElement, useState, type ReactNode } from 'react';
import type { AppRouter } from '../../../server/src/routers/_app';
import { makeQueryClient } from './query-client';

/**
 * React Query bindings for tRPC. Requests go to the Vite dev-server proxy
 * at /trpc, which forwards to the Express server on port 3100 (see
 * vite.config.ts).
 *
 * This file stays `.ts` (not `.tsx`), so the provider below is built with
 * `createElement` rather than JSX syntax.
 */
export const trpc = createTRPCReact<AppRouter>();

/**
 * The rate limiter in front of `inquiries.create` / `newsletter.subscribe`
 * (server/src/middleware/rate-limit.ts, server/src/app.ts) runs as plain
 * Express middleware ahead of tRPC's own handler. `express-rate-limit`'s
 * default 429 response is a plain-text body (`res.send('Too many
 * requests...')`), not a tRPC JSON-RPC envelope — but `httpBatchLink` calls
 * `res.json()` unconditionally on every response (see `@trpc/client`'s
 * `httpUtils.httpRequest`), so an unmodified plain-text 429 would surface
 * client-side as a raw JSON-parse `SyntaxError` with no usable status.
 * That is exactly the raw-error leak CLAUDE.md's "never render a raw
 * error" rule (and BUG-021, a real case where a MySQL error would have
 * echoed a visitor's own email address back to them) forbids.
 *
 * This wraps the real `fetch` so a non-OK response that isn't JSON gets
 * normalized into the same shape a tRPC error would have taken, carrying
 * the real HTTP status through `data.httpStatus` so calling code can check
 * `error.data?.httpStatus === 429` reliably — see `lib/mutation-errors.ts`.
 * A JSON error body (every error the tRPC router itself throws) is already
 * shaped correctly and passes through untouched.
 */
async function fetchWithNormalizedErrors(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  const res = await fetch(input, init);
  if (res.ok) return res;
  const contentType = res.headers.get('content-type') ?? '';
  if (contentType.includes('json')) return res;
  // Not an Error instance on purpose: @trpc/client's `TRPCClientError.from`
  // specifically recognises this `{ error: { code, message } }` shape
  // (`isTRPCErrorResponse`) and reads `.data` off it — an `Error` would not
  // carry that shape.
  throw {
    error: {
      message: 'Request failed.',
      code: -32603,
      data: { code: 'INTERNAL_SERVER_ERROR', httpStatus: res.status },
    },
  };
}

export function TrpcProviders({ children }: { children: ReactNode }) {
  const [queryClient] = useState(() => makeQueryClient());
  const [trpcClient] = useState(() =>
    trpc.createClient({
      links: [httpBatchLink({ url: '/trpc', fetch: fetchWithNormalizedErrors })],
    }),
  );

  return createElement(trpc.Provider, {
    client: trpcClient,
    queryClient,
    children: createElement(QueryClientProvider, { client: queryClient, children }),
  });
}
