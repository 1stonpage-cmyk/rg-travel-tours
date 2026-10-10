import { Route, Routes } from 'react-router-dom';
import PublicLayout from '@/components/layout/PublicLayout';
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
        <Route path="privacy" element={<PrivacyPage />} />
        <Route path="terms" element={<TermsPage />} />
      </Route>
    </Routes>
  );
}
