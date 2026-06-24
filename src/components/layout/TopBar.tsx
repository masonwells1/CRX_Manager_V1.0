import { Menu, Search } from 'lucide-react';
import NotificationsPanel from '../team/NotificationsPanel';

interface TopBarProps {
  onMenuClick: () => void;
  onSearchClick: () => void;
  title: string;
  accent?: string;
}

export default function TopBar({ onMenuClick, onSearchClick, title, accent }: TopBarProps) {
  return (
    <header className="sticky top-0 z-30 bg-cream/80 backdrop-blur-md border-b border-gray-200/50">
      <div className="flex items-center justify-between h-16 px-4 lg:px-6">
        <div className="flex items-center gap-3">
          <button
            onClick={onMenuClick}
            aria-label="Open navigation menu"
            className="lg:hidden p-2 rounded-lg text-secondary hover:bg-white hover:shadow-sm transition-all"
          >
            <Menu className="w-5 h-5" />
          </button>
          <h1 className="text-xl font-semibold font-heading text-nav-dark">
            {title}
            {accent && <span className="split-heading-accent"> {accent}</span>}
          </h1>
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={onSearchClick}
            aria-label="Search (Ctrl+K)"
            className="flex items-center gap-2 px-3 py-2 rounded-lg text-secondary border border-gray-200/70 bg-white/60 hover:bg-white hover:shadow-sm transition-all"
          >
            <Search className="w-4 h-4" />
            <span className="hidden md:inline text-sm">Search…</span>
            <kbd className="hidden md:inline text-[11px] border border-gray-200 rounded px-1.5 py-0.5">⌘K</kbd>
          </button>
          <NotificationsPanel />
        </div>
      </div>
    </header>
  );
}
