import { QueryClient } from '@tanstack/react-query';

/**
 * Defaults tuned for slow-moving marketing content (settings, destinations,
 * tours, packages, reviews): a 60s staleTime avoids refetching on every
 * mount, a single retry avoids hammering a flaky network, and
 * refetchOnWindowFocus is off so switching tabs never restarts a skeleton
 * the guest already saw resolve.
 */
export function makeQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 60_000,
        retry: 1,
        refetchOnWindowFocus: false,
      },
    },
  });
}
