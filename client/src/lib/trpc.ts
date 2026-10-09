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

export function TrpcProviders({ children }: { children: ReactNode }) {
  const [queryClient] = useState(() => makeQueryClient());
  const [trpcClient] = useState(() =>
    trpc.createClient({
      links: [httpBatchLink({ url: '/trpc' })],
    }),
  );

  return createElement(trpc.Provider, {
    client: trpcClient,
    queryClient,
    children: createElement(QueryClientProvider, { client: queryClient, children }),
  });
}
