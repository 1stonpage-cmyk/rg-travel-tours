import { TIMEZONE } from '@rg/shared';
import { destinationsRouter } from './public/destinations';
import { inquiriesRouter } from './public/inquiries';
import { newsletterRouter } from './public/newsletter';
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

  // Public read queries (Task 1.6).
  settings: settingsRouter,
  destinations: destinationsRouter,
  tours: toursRouter,
  packages: packagesRouter,
  reviews: reviewsRouter,

  // Public mutations (Task 1.7) — rate-limited in app.ts.
  inquiries: inquiriesRouter,
  newsletter: newsletterRouter,
});

export type AppRouter = typeof appRouter;
