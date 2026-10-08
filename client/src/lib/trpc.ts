import { createTRPCClient, httpBatchLink } from '@trpc/client';
import type { AppRouter } from '../../../server/src/routers/_app';

/**
 * Vanilla tRPC client. Requests go to the Vite dev-server proxy at /trpc, which
 * forwards to the Express server on port 3100 (see vite.config.ts).
 */
export const trpc = createTRPCClient<AppRouter>({
  links: [httpBatchLink({ url: '/trpc' })],
});
