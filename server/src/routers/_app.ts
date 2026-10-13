import { TIMEZONE } from '@rg/shared';
import { checkoutRouter } from './public/checkout';
import { destinationsRouter } from './public/destinations';
import { inquiriesRouter } from './public/inquiries';
import { newsletterRouter } from './public/newsletter';
import { packagesRouter } from './public/packages';
import { portalRouter } from './public/portal';
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

  // Checkout (Week 3, Task 6). `quote` and `availability` are reads;
  // `createHold` is the router's only mutation and is rate-limited in
  // app.ts (Ruling 5) — no other mutation may be added under this
  // namespace without also updating that limiter and its guard test.
  checkout: checkoutRouter,

  /*
   * Customer portal (Week 4, Task 2). Login is `ref + email` (§7) and the
   * session it mints is scoped to ONE booking. Its rate limit is SHARED
   * with `checkout.bookingLookup` — the same credential pair against the
   * same booking is one attack surface, so it is one budget of five failed
   * attempts, not two. See `BOOKING_LOOKUP_PROCEDURES`.
   */
  portal: portalRouter,
});

export type AppRouter = typeof appRouter;
