import { Menu } from 'lucide-react';
import NotificationsPanel from '../team/NotificationsPanel';

interface TopBarProps {
  onMenuClick: () => void;
  title: string;
  accent?: string;
}

export default function TopBar({ onMenuClick, title, accent }: TopBarProps) {
  return (
    <header className="sticky top-0 z-30 bg-cream/80 backdrop-blur-md border-b border-gray-200/50">
      <div className="flex items-center justify-between h-16 px-4 lg:px-6">
        <div className="flex items-center gap-3">
          <button
            onClick={onMenuClick}
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
          <NotificationsPanel />
        </div>
      </div>
    </header>
  );
}
