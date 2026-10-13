import { TIMEZONE } from '@rg/shared';
import { checkoutRouter } from './public/checkout';
import { destinationsRouter } from './public/destinations';
import { inquiriesRouter } from './public/inquiries';
import { newsletterRouter } from './public/newsletter';
import { packagesRouter } from './public/packages';
import { adminBookingsRouter } from './admin/bookings';
import { staffAuthRouter } from './admin/auth';
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

  /*
   * Staff sign-in (Week 4, Task 5). NOT under `admin.*`: `login` and
   * `logout` are necessarily public, and `procedure-role-metadata.test.ts`
   * requires everything in an admin namespace to be `adminProcedure` — an
   * invariant worth keeping, so the namespace moved rather than the rule.
   *
   * `staffAuth.login` is rate-limited per IP in app.ts and per EMAIL in
   * `services/staff-auth.ts`; one limiter cannot see what the other
   * catches. `me` sits behind `adminProcedure`, which makes it the first
   * thing in this codebase to have ever run with a real staff session.
   */
  staffAuth: staffAuthRouter,

  /*
   * The admin surface (Week 4, Task 7). Everything under this namespace is
   * built with `adminProcedure(area)` and nothing else may be — the guard
   * in `procedure-role-metadata.test.ts` fails the build on a procedure
   * whose path contains `admin` and whose role metadata is missing, which
   * is why the sign-in lives at `staffAuth` instead of in here.
   */
  admin: router({
    bookings: adminBookingsRouter,
  }),
});

export type AppRouter = typeof appRouter;
