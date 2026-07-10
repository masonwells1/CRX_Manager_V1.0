import { useState } from 'react';
import { Menu, Plus, Search } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext';
import NotificationsPanel from '../team/NotificationsPanel';

interface TopBarProps {
  onMenuClick: () => void;
  onSearchClick: () => void;
  title: string;
  accent?: string;
}

const NEW_MENU_ITEMS = [
  { label: 'Quote/Booking', path: '/quotes/new' },
  { label: 'Order', path: '/orders/new' },
  { label: 'Delivery', path: '/deliveries/new' },
  { label: 'Job', path: '/jobs/new' },
  { label: 'Field App Invoice', path: '/invoices/field-app/new' },
  { label: 'PO', path: '/purchase-orders/new' },
  { label: 'Quick Receive', path: '/receiving/quick' },
];

export default function TopBar({ onMenuClick, onSearchClick, title, accent }: TopBarProps) {
  const { profile } = useAuth();
  const navigate = useNavigate();
  const [newMenuOpen, setNewMenuOpen] = useState(false);
  const isOfficeRole = profile?.role === 'admin' || profile?.role === 'sales_rep';

  const closeWhenFocusLeaves = (event: React.FocusEvent<HTMLDivElement>) => {
    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
      setNewMenuOpen(false);
    }
  };

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
          {isOfficeRole && (
            <div className="relative" onBlur={closeWhenFocusLeaves}>
              <button
                type="button"
                onClick={() => setNewMenuOpen((open) => !open)}
                onKeyDown={(event) => {
                  if (event.key === 'Escape') setNewMenuOpen(false);
                }}
                aria-expanded={newMenuOpen}
                aria-haspopup="menu"
                className="flex items-center gap-1.5 px-3 py-2 rounded-lg bg-crx-green text-white text-sm font-medium hover:bg-crx-green/90 focus:outline-none focus:ring-2 focus:ring-crx-green/30 transition-all"
              >
                <Plus className="w-4 h-4" />
                + New
              </button>
              {newMenuOpen && (
                <div
                  role="menu"
                  aria-label="Create new"
                  onKeyDown={(event) => {
                    if (event.key === 'Escape') setNewMenuOpen(false);
                  }}
                  className="absolute right-0 top-full mt-2 w-52 rounded-lg border border-gray-200 bg-white py-1 shadow-lg"
                >
                  {NEW_MENU_ITEMS.map((item) => (
                    <button
                      key={item.path}
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        setNewMenuOpen(false);
                        navigate(item.path);
                      }}
                      className="block w-full px-3 py-2 text-left text-sm text-nav-dark hover:bg-gray-50 focus:bg-gray-50 focus:outline-none"
                    >
                      {item.label}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
          <NotificationsPanel />
        </div>
      </div>
    </header>
  );
}
