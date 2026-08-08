import { useState, useEffect, useCallback } from 'react';
import { Outlet, useLocation, useNavigationType } from 'react-router-dom';
import Sidebar from './Sidebar';
import MobileBottomNav from './MobileBottomNav';
import TopBar from './TopBar';
import WorkspaceTabs from './WorkspaceTabs';
import OfflineBanner from '../ui/OfflineBanner';
import CommandPalette from '../ui/CommandPalette';
import { recordPageVisit } from '../../lib/recentPages';
import { usePageMeta } from '../../hooks/usePageMeta';

export default function AppLayout() {
  const [mobileOpen, setMobileOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const { title, accent } = usePageMeta();
  const location = useLocation();
  // REPLACE = a <Navigate replace> redirect alias committed this pathname,
  // not a user click — lets the visit counter skip the duplicate.
  const navigationType = useNavigationType();
  const openMobileNav = useCallback(() => setMobileOpen(true), []);
  const closeMobileNav = useCallback(() => setMobileOpen(false), []);

  // Record page visits for command palette recent items (full title)
  useEffect(() => {
    if (title) {
      recordPageVisit(location.pathname, title + (accent ? ' ' + accent : ''), {
        isRedirect: navigationType === 'REPLACE',
      });
    }
    // navigationType is read at record time, not a reason to re-record
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.pathname, title, accent]);

  // Global Ctrl+K / Cmd+K shortcut
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
        e.preventDefault();
        setPaletteOpen((prev) => !prev);
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, []);

  return (
    <div className="min-h-screen bg-cream flex">
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:absolute focus:z-[60] focus:top-2 focus:left-2 focus:px-4 focus:py-2 focus:bg-crx-green focus:text-white focus:rounded-lg focus:text-sm focus:font-medium"
      >
        Skip to main content
      </a>
      <Sidebar mobileOpen={mobileOpen} onClose={closeMobileNav} />
      <div className="flex-1 flex flex-col min-w-0">
        <TopBar
          onMenuClick={openMobileNav}
          onSearchClick={() => setPaletteOpen(true)}
          title={title}
          accent={accent}
        />
        <OfflineBanner />
        <WorkspaceTabs />
        <main id="main-content" className="flex-1 p-4 pb-[calc(4.5rem+env(safe-area-inset-bottom))] md:p-4 lg:p-6">
          <Outlet />
        </main>
      </div>
      <MobileBottomNav onMoreClick={openMobileNav} moreOpen={mobileOpen} />
      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} />
    </div>
  );
}
