import { TIMEZONE } from '@rg/shared';
import { publicProcedure, router } from '../trpc';

export const appRouter = router({
  /**
   * Liveness probe. Deliberately the only procedure for now — schema, auth, and
   * domain routers land in tasks 1B/1C onward.
   */
  health: publicProcedure.query(() => ({
    ok: true as const,
    service: 'rg-travel-tours' as const,
    timezone: TIMEZONE,
  })),
});

export type AppRouter = typeof appRouter;
