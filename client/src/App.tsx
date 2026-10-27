import { Route, Routes } from 'react-router-dom';
import { BOOKING_PAGE_ROUTE } from '@rg/shared';
import AdminLayout from '@/components/layout/AdminLayout';
import PublicLayout from '@/components/layout/PublicLayout';
import AdminBookingDetailPage from '@/pages/admin/AdminBookingDetailPage';
import AdminBookingsPage from '@/pages/admin/AdminBookingsPage';
import AdminDashboardPage from '@/pages/admin/AdminDashboardPage';
import AdminCalendarPage from '@/pages/admin/AdminCalendarPage';
import AdminCouponsPage from '@/pages/admin/AdminCouponsPage';
import AdminPackagesPage from '@/pages/admin/AdminPackagesPage';
import AdminReportsPage from '@/pages/admin/AdminReportsPage';
import AdminReviewsPage from '@/pages/admin/AdminReviewsPage';
import AdminDeparturesPage from '@/pages/admin/AdminDeparturesPage';
import AdminDriversPage from '@/pages/admin/AdminDriversPage';
import AdminStaffPage from '@/pages/admin/AdminStaffPage';
import AdminToursPage from '@/pages/admin/AdminToursPage';
import AdminChangePasswordPage from '@/pages/admin/AdminChangePasswordPage';
import AdminLoginPage from '@/pages/admin/AdminLoginPage';
import AdminPaymentsPage from '@/pages/admin/AdminPaymentsPage';
import AdminSettingsPage from '@/pages/admin/AdminSettingsPage';
import AdminVansPage from '@/pages/admin/AdminVansPage';
import DriverLayout from '@/components/layout/DriverLayout';
import DriverLoginPage from '@/pages/driver/DriverLoginPage';
import DriverTripPage from '@/pages/driver/DriverTripPage';
import DriverTripsPage from '@/pages/driver/DriverTripsPage';
import ManualQrPage from '@/pages/portal/ManualQrPage';
import PortalBookingPage from '@/pages/portal/PortalBookingPage';
import PortalLoginPage from '@/pages/portal/PortalLoginPage';
import BookingStatusPage from '@/pages/public/BookingStatusPage';
import CheckoutPage from '@/pages/public/CheckoutPage';
import HomePage from '@/pages/public/HomePage';
import CookiesPage from '@/pages/public/CookiesPage';
import PackageDetailPage from '@/pages/public/PackageDetailPage';
import PrivacyPage from '@/pages/public/PrivacyPage';
import RefundPolicyPage from '@/pages/public/RefundPolicyPage';
import TermsPage from '@/pages/public/TermsPage';
import TourDetailPage from '@/pages/public/TourDetailPage';
import ToursPage from '@/pages/public/ToursPage';

/**
 * `BOOKING_PAGE_ROUTE` (`@rg/shared`) is `'/booking/:ref'` — an absolute
 * path, because it doubles as the literal `checkout.startPayment` (Task 7)
 * builds its PayMongo success/cancel URLs from (Ruling 25). Every sibling
 * route below is written relative to this layout route's implicit `/`, so
 * the leading slash is stripped here rather than retyped as `'booking/:ref'`
 * — one definition, still derived rather than a second hand-typed literal.
 */
const bookingStatusPath = BOOKING_PAGE_ROUTE.replace(/^\//, '');

export default function App() {
  return (
    <Routes>
      <Route element={<PublicLayout />}>
        <Route index element={<HomePage />} />
        <Route path="tours" element={<ToursPage />} />
        {/*
         * The tour detail page (Week 7 plan, Task 2) — `/tours/:slug` now
         * renders, which is what lets `resolveTour` (seo/resolvers.ts) drop
         * its D5 `noindex` and the sitemap list these URLs. Placed BELOW
         * `tours`, ABOVE `checkout/:tourSlug`: react-router matches static
         * segments before a `:param` sibling regardless of declaration
         * order, so this ordering is for a human reader, not the router.
         */}
        <Route path="tours/:slug" element={<TourDetailPage />} />
        {/*
         * BUILD_SPEC §4 names `/checkout/:holdId` — written before Week 3's
         * own owner ruling (Q3) made the quote id stateless. No hold exists
         * until this page's own submit creates one, so there is no holdId
         * to put in the URL yet; the tour selection goes there instead. See
         * CheckoutPage.tsx's module note.
         */}
        <Route path="checkout/:tourSlug" element={<CheckoutPage />} />
        {/*
         * The package detail page (Week 7 plan, Task 3) — `/packages/:slug`
         * now renders, which is what lets `resolvePackage` (seo/resolvers.ts)
         * drop its own `noindex` line and the sitemap list these URLs too.
         */}
        <Route path="packages/:slug" element={<PackageDetailPage />} />
        {/*
         * Task 9, week 3 checkout plan — the payment-redirect / booking-
         * status page. Mounted at `bookingStatusPath` (derived from
         * `BOOKING_PAGE_ROUTE` above), never a retyped string, so this
         * route and the PayMongo success/cancel URLs `startPayment` builds
         * cannot drift apart.
         */}
        <Route path={bookingStatusPath} element={<BookingStatusPage />} />
        <Route path="privacy" element={<PrivacyPage />} />
        <Route path="terms" element={<TermsPage />} />
        <Route path="refund-policy" element={<RefundPolicyPage />} />
        <Route path="cookies" element={<CookiesPage />} />
      </Route>

      {/*
       * The staff sign-in, OUTSIDE `PublicLayout` on purpose: it carries no
       * header, no navigation and no WhatsApp button, because nobody
       * browses to it and a staff member at 6am wants two fields and a
       * button. It is also the only route under `/admin`, which the
       * `X-Robots-Tag` middleware already keeps out of every index.
       */}
      <Route path="admin/login" element={<AdminLoginPage />} />

      {/*
       * The dispatch shell (Week 5, Task 1) and everything under it.
       * Outside `PublicLayout` like the sign-in: `AdminLayout` renders its
       * own nav and `<main>`, and `/admin/*` is kept out of every index by
       * the `X-Robots-Tag` middleware. The SERVER gates every screen here
       * — every procedure behind them is an `adminProcedure`, so an
       * unauthenticated visitor sees the pages' own "sign in again" state
       * rather than any data.
       *
       * The index route is a one-line stand-in for Task 14's dashboard,
       * which does not exist yet. `/admin/vans` (Task 5), `/admin/drivers`
       * (Task 7) and `/admin/calendar` (Task 9) are routed below.
       */}
      <Route path="admin" element={<AdminLayout />}>
        <Route index element={<AdminDashboardPage />} />
        <Route path="bookings" element={<AdminBookingsPage />} />
        <Route path="bookings/:ref" element={<AdminBookingDetailPage />} />
        <Route path="payments" element={<AdminPaymentsPage />} />
        <Route path="calendar" element={<AdminCalendarPage />} />
        <Route path="departures" element={<AdminDeparturesPage />} />
        <Route path="vans" element={<AdminVansPage />} />
        <Route path="drivers" element={<AdminDriversPage />} />
        <Route path="tours" element={<AdminToursPage />} />
        <Route path="coupons" element={<AdminCouponsPage />} />
        <Route path="packages" element={<AdminPackagesPage />} />
        <Route path="reviews" element={<AdminReviewsPage />} />
        <Route path="reports" element={<AdminReportsPage />} />
        <Route path="staff" element={<AdminStaffPage />} />
        <Route path="settings" element={<AdminSettingsPage />} />
        <Route path="change-password" element={<AdminChangePasswordPage />} />
      </Route>

      {/*
       * The guest portal (Week 4, Tasks 8 and 9). OUTSIDE `PublicLayout`
       * like the staff sign-in: these screens render their own `<main>`,
       * and a guest who is mid-payment should not be invited back into the
       * catalogue by a nav bar.
       *
       * `/portal/pay` shows an amount due and an account number, so it is
       * behind the guest session (owner decision 2026-10-14, Q5) — the page
       * itself renders a sign-in prompt rather than details when there is
       * no session, so there is no flash of anything private.
       */}
      {/*
       * The driver portal (Week 6, Task 9). The sign-in sits OUTSIDE
       * `DriverLayout` for the same reason `admin/login` sits outside
       * `AdminLayout`: a screen that mints a session must not render
       * chrome that assumes one. `/driver` already gets an `X-Robots-Tag`
       * from the server middleware, so nothing here needs indexing work.
       *
       * The index is Task 10's trip list, which owns the Today / Upcoming /
       * History tabs because it owns the three buckets they switch between
       * — and `/driver/trip/:bookingId` is one trip's screen. Every
       * procedure behind both is a `driverProcedure`, so the SERVER is the
       * gate on all of this: an unauthenticated visitor reaching `/driver`
       * sees the shell and no data, never a shortcut in.
       */}
      <Route path="driver/login" element={<DriverLoginPage />} />
      <Route path="driver" element={<DriverLayout />}>
        <Route index element={<DriverTripsPage />} />
        <Route path="trip/:bookingId" element={<DriverTripPage />} />
      </Route>

      <Route path="portal/login" element={<PortalLoginPage />} />
      <Route path="portal/pay" element={<ManualQrPage />} />
      <Route path="portal/booking" element={<PortalBookingPage />} />
    </Routes>
  );
}
