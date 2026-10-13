import { Route, Routes } from 'react-router-dom';
import { BOOKING_PAGE_ROUTE } from '@rg/shared';
import PublicLayout from '@/components/layout/PublicLayout';
import BookingStatusPage from '@/pages/public/BookingStatusPage';
import CheckoutPage from '@/pages/public/CheckoutPage';
import HomePage from '@/pages/public/HomePage';
import PrivacyPage from '@/pages/public/PrivacyPage';
import TermsPage from '@/pages/public/TermsPage';
import ToursStubPage from '@/pages/public/ToursStubPage';

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
        <Route path="tours" element={<ToursStubPage />} />
        {/*
         * BUILD_SPEC §4 names `/checkout/:holdId` — written before Week 3's
         * own owner ruling (Q3) made the quote id stateless. No hold exists
         * until this page's own submit creates one, so there is no holdId
         * to put in the URL yet; the tour selection goes there instead. See
         * CheckoutPage.tsx's module note.
         */}
        <Route path="checkout/:tourSlug" element={<CheckoutPage />} />
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
      </Route>
    </Routes>
  );
}
