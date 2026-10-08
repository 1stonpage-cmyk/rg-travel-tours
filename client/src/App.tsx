import { Route, Routes } from 'react-router-dom';
import PublicLayout from '@/components/layout/PublicLayout';
import ToursStubPage from '@/pages/public/ToursStubPage';

export default function App() {
  return (
    <Routes>
      <Route element={<PublicLayout />}>
        <Route index element={<p className="p-8">Home sections land in task 2B.</p>} />
        <Route path="tours" element={<ToursStubPage />} />
      </Route>
    </Routes>
  );
}
