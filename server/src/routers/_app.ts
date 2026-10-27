import { TIMEZONE } from '@rg/shared';
import { checkoutRouter } from './public/checkout';
import { destinationsRouter } from './public/destinations';
import { driverAuthRouter } from './public/driver-auth';
import { driverTripsRouter } from './public/driver';
import { inquiriesRouter } from './public/inquiries';
import { newsletterRouter } from './public/newsletter';
import { packagesRouter } from './public/packages';
import { adminBookingsRouter } from './admin/bookings';
import { adminDashboardRouter } from './admin/dashboard';
import { adminDeparturesRouter } from './admin/departures';
import { adminCalendarRouter } from './admin/calendar';
import { adminCouponsRouter } from './admin/coupons';
import { adminDispatchRouter } from './admin/dispatch';
import { adminDriversRouter } from './admin/drivers';
import { adminNewsletterRouter } from './admin/newsletter';
import { adminInquiriesRouter, adminPackagesRouter } from './admin/packages';
import { adminRefundsRouter } from './admin/refunds';
import { adminReportsRouter } from './admin/reports';
import { adminReviewsRouter } from './admin/reviews';
import { adminSettingsRouter } from './admin/settings';
import { adminStaffUsersRouter } from './admin/staff-users';
import { adminToursRouter } from './admin/tours';
import { adminVansRouter } from './admin/vans';
import { staffAuthRouter } from './admin/auth';
import { portalRouter } from './public/portal';
import { reviewsRouter } from './public/reviews';
import { settingsRouter } from './public/settings';
import { toursRouter } from './public/tours';
import { mergeRouters, publicProcedure, router } from '../trpc';

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
   * The driver portal (Week 6, Task 1). ONE namespace, so the login's
   * tRPC path is `driver.login` — the exact string
   * `DRIVER_LOGIN_PROCEDURES` has reserved since Week 4 and the per-IP
   * limiter in `app.ts` is scoped to. Any other name leaves that limiter
   * counting nothing while still looking mounted, and
   * `driver-lockout.test.ts` fails the build for it on purpose.
   *
   * Task 1 mounted the two PUBLIC procedures. Task 2 added the first
   * driver-GATED one (`driver.trips`) and, with it, the `driver` branch
   * `procedure-role-metadata.test.ts` needed in order to enumerate it —
   * so every driver procedure from here on is held to an anonymous, a
   * staff and a customer refusal by that guard.
   *
   * Merged rather than nested: the public pair and the gated procedures
   * sit side by side under `driver.*`, which is what keeps `driver.login`
   * the exact string the limiter is scoped to. `mergeRouters` is tRPC's
   * own and preserves each procedure's access metadata.
   */
  driver: mergeRouters(driverAuthRouter, driverTripsRouter),

  /*
   * The admin surface (Week 4, Task 7). Everything under this namespace is
   * built with `adminProcedure(area)` and nothing else may be — the guard
   * in `procedure-role-metadata.test.ts` fails the build on a procedure
   * whose path contains `admin` and whose role metadata is missing, which
   * is why the sign-in lives at `staffAuth` instead of in here.
   */
  admin: router({
    /** Staff accounts (owner only; owner decisions 2026-10-23). */
    staffUsers: adminStaffUsersRouter,
    bookings: adminBookingsRouter,
    dashboard: adminDashboardRouter,
    /*
     * Its own namespace rather than a third procedure under `dashboard`
     * (Week 6, Task 12): the alerts are counts computed in one
     * transaction, this is a per-booking read polled every fifteen
     * seconds, and the two have no reason to share a file. Same
     * `'dashboard'` area, which is what §9 gates them both on.
     */
    departures: adminDeparturesRouter,
    calendar: adminCalendarRouter,
    dispatch: adminDispatchRouter,
    /*
     * Cancel and refund (Week 6, Task 13; §13's 6F). Its own namespace
     * because §9 gates it on `cancelRefund` — owner and finance, never a
     * dispatcher — which is a different row from the `bookingsView` the
     * booking screens use and from the `verifyPayments` the queue uses.
     * Nesting it under `bookings` would have put three different
     * permissions in one file.
     */
    refunds: adminRefundsRouter,
    vans: adminVansRouter,
    drivers: adminDriversRouter,
    /*
     * Tours, price tiers, images, itinerary stops and add-ons (Week 7,
     * Task 6). Its own namespace because §9 gates it on `toursPricing` —
     * OWNER ONLY, the narrowest row in the matrix, because these mutations
     * write the per-person price a guest is charged.
     */
    tours: adminToursRouter,
    /*
     * Coupons and the redemption log (Week 7, Task 8). The SAME
     * `toursPricing` area as `tours` above — owner only — because a discount
     * is a price decision: a coupon that takes 20% off every booking changes
     * what a guest pays exactly as a tier edit does. Its own namespace
     * because the tables, the inputs and the redemption log have nothing to
     * do with a tour's children.
     */
    coupons: adminCouponsRouter,
    /*
     * Multi-day packages and the enquiries about them (Week 7, Task 13).
     * Both namespaces are §9's `packagesInquiries` row — owner and
     * dispatcher, never finance — added by owner decision 2026-10-23 (Q3,
     * option c): an enquiry is operational work, and a dispatcher already
     * reads guest names and phone numbers on a booking.
     *
     * Two keys rather than one, even though they share a file and a gate: a
     * package is a catalog row an owner edits and an enquiry is a guest's
     * question an office answers, and nesting one under the other would
     * imply a general contact enquiry belongs to a package. It does not —
     * `inquiries.package_id` is nullable.
     */
    packages: adminPackagesRouter,
    inquiries: adminInquiriesRouter,
    /*
     * The newsletter list as a file (Week 7, Task 13). A THIRD key for what
     * is one screen, because §9 gates this one on `usersSettings` — OWNER
     * ONLY — while `packages` and `inquiries` above are owner and
     * dispatcher. Same owner decision, different row: answering one guest's
     * enquiry is operational, and taking every subscriber's address away in
     * one file is a bulk disclosure of personal data (RA 10173).
     */
    newsletter: adminNewsletterRouter,
    /*
     * The seventeen `settings` rows (Week 7, Task 9). §9 gates it on
     * `usersSettings` — OWNER ONLY, the same narrowness as `toursPricing`
     * and for overlapping reasons: `trust.depositPercent` is how much of a
     * guest's total is taken at checkout, `payment_qr` is the account it is
     * transferred to, and `content_unverified` decides whether this site is
     * in a search index at all.
     */
    settings: adminSettingsRouter,
    /*
     * Review moderation, replies and the queue (Week 7, Task 10). §9 gates it
     * on `reviewsModeration` — owner and dispatcher, never finance — which is
     * the same row the dashboard and bookings use for dispatch work and a
     * different one from the money areas. This router is the ONLY writer of
     * `reviews.status` after a submission, which is what makes "a guest
     * cannot publish straight to the site" structural.
     */
    reviews: adminReviewsRouter,
    /*
     * The money reports and their CSV exports (Week 7, Task 12). §9 gates it
     * on `reports` — owner and FINANCE, never a dispatcher — which is the
     * same pair as `verifyPayments` and `cancelRefund` and a different row
     * from the `dashboard` all three roles share. Its own namespace because
     * it reads money across every booking and payment rather than working on
     * one of them, and because nothing in it writes: there is no mutation
     * here and no audit row, which is what a report is.
     */
    reports: adminReportsRouter,
  }),
});

export type AppRouter = typeof appRouter;
