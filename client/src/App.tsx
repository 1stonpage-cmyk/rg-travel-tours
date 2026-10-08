import { Route, Routes } from 'react-router-dom';

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<p className="p-8">Home page lands in task 2B.</p>} />
    </Routes>
  );
}
