import { TIMEZONE } from '@rg/shared';
import { destinationsRouter } from './public/destinations';
import { packagesRouter } from './public/packages';
import { reviewsRouter } from './public/reviews';
import { settingsRouter } from './public/settings';
import { toursRouter } from './public/tours';
import { publicProcedure, router } from '../trpc';

export const appRouter = router({
  /**
   * Liveness probe.
   */
  health: publicProcedure.query(() => ({
    ok: true as const,
    service: 'rg-travel-tours' as const,
    timezone: TIMEZONE,
  })),

  // Public read queries (Task 1.6). Mutations (inquiries, newsletter) land in 1.7.
  settings: settingsRouter,
  destinations: destinationsRouter,
  tours: toursRouter,
  packages: packagesRouter,
  reviews: reviewsRouter,
});

export type AppRouter = typeof appRouter;
