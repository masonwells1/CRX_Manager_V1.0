import { useState } from 'react';
import { Outlet } from 'react-router-dom';
import Sidebar from './Sidebar';
import TopBar from './TopBar';
import OfflineBanner from '../ui/OfflineBanner';
import { usePageMeta } from '../../hooks/usePageMeta';

export default function AppLayout() {
  const [mobileOpen, setMobileOpen] = useState(false);
  const { title, accent } = usePageMeta();

  return (
    <div className="min-h-screen bg-cream flex">
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:absolute focus:z-[60] focus:top-2 focus:left-2 focus:px-4 focus:py-2 focus:bg-crx-green focus:text-white focus:rounded-lg focus:text-sm focus:font-medium"
      >
        Skip to main content
      </a>
      <Sidebar mobileOpen={mobileOpen} onClose={() => setMobileOpen(false)} />
      <div className="flex-1 flex flex-col min-w-0">
        <TopBar
          onMenuClick={() => setMobileOpen(true)}
          title={title}
          accent={accent}
        />
        <OfflineBanner />
        <main id="main-content" className="flex-1 p-4 lg:p-6">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
