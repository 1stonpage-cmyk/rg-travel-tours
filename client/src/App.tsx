import { Route, Routes } from 'react-router-dom';
import PublicLayout from '@/components/layout/PublicLayout';
import CheckoutPage from '@/pages/public/CheckoutPage';
import HomePage from '@/pages/public/HomePage';
import PrivacyPage from '@/pages/public/PrivacyPage';
import TermsPage from '@/pages/public/TermsPage';
import ToursStubPage from '@/pages/public/ToursStubPage';

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
        <Route path="privacy" element={<PrivacyPage />} />
        <Route path="terms" element={<TermsPage />} />
      </Route>
    </Routes>
  );
}
