import { Route, Routes } from 'react-router-dom';
import PublicLayout from '@/components/layout/PublicLayout';
import HomePage from '@/pages/public/HomePage';
import ToursStubPage from '@/pages/public/ToursStubPage';

export default function App() {
  return (
    <Routes>
      <Route element={<PublicLayout />}>
        <Route index element={<HomePage />} />
        <Route path="tours" element={<ToursStubPage />} />
      </Route>
    </Routes>
  );
}
