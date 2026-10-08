import { Outlet } from 'react-router-dom';
import FloatingWhatsApp from './FloatingWhatsApp';
import PlaceholderBadge from './PlaceholderBadge';
import SiteFooter from './SiteFooter';
import SiteHeader from './SiteHeader';

export default function PublicLayout() {
  return (
    <div className="flex min-h-dvh flex-col">
      <a
        href="#main"
        className="bg-brand-blue-700 focus:ring-brand-gold-400 sr-only rounded-md px-4 py-2 text-white focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-50 focus:ring-2"
      >
        Skip to main content
      </a>
      <PlaceholderBadge />
      <SiteHeader />
      <main id="main" className="flex-1">
        <Outlet />
      </main>
      <SiteFooter />
      <FloatingWhatsApp />
    </div>
  );
}
