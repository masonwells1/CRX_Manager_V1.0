import { useState } from 'react';
import { Outlet } from 'react-router-dom';
import Sidebar from './Sidebar';
import TopBar from './TopBar';
import { usePageMeta } from '../../hooks/usePageMeta';

export default function AppLayout() {
  const [mobileOpen, setMobileOpen] = useState(false);
  const { title, accent } = usePageMeta();

  return (
    <div className="min-h-screen bg-cream flex">
      <Sidebar mobileOpen={mobileOpen} onClose={() => setMobileOpen(false)} />
      <div className="flex-1 flex flex-col min-w-0">
        <TopBar
          onMenuClick={() => setMobileOpen(true)}
          title={title}
          accent={accent}
        />
        <main className="flex-1 p-4 lg:p-6">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
