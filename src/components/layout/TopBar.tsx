import { useState } from 'react';
import { Menu, Plus, Search } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext';
import { hasPageAccess } from '../../lib/pagePermissions';
import NotificationsPanel from '../team/NotificationsPanel';

interface TopBarProps {
  onMenuClick: () => void;
  onSearchClick: () => void;
  title: string;
  accent?: string;
}

const NEW_MENU_ITEMS = [
  { label: 'Quote/Booking', path: '/quotes/new', pageKey: 'quotes' },
  { label: 'Order', path: '/orders/new', pageKey: 'orders' },
  { label: 'Delivery', path: '/deliveries/new', pageKey: 'deliveries' },
  { label: 'Job', path: '/jobs/new', pageKey: 'jobs' },
  { label: 'Field App Invoice', path: '/invoices/field-app/new', pageKey: 'field-invoices' },
  { label: 'PO', path: '/purchase-orders/new', pageKey: 'purchase-orders' },
  { label: 'Quick Receive', path: '/receiving?tab=quick', pageKey: 'receiving' },
];

export default function TopBar({ onMenuClick, onSearchClick, title, accent }: TopBarProps) {
  const { profile, deniedPages } = useAuth();
  const navigate = useNavigate();
  const [newMenuOpen, setNewMenuOpen] = useState(false);
  const role = profile?.role ?? null;
  const isOfficeRole = role === 'admin' || role === 'sales_rep';
  const allowedNewMenuItems = isOfficeRole
    ? NEW_MENU_ITEMS.filter((item) => hasPageAccess(role, deniedPages, item.pageKey))
    : [];

  const closeWhenFocusLeaves = (event: React.FocusEvent<HTMLDivElement>) => {
    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
      setNewMenuOpen(false);
    }
  };

  return (
    <header className="sticky top-0 z-30 bg-cream/80 backdrop-blur-md border-b border-gray-200/50">
      <div className="flex h-14 items-center justify-between px-2.5 md:h-16 md:px-4 lg:px-6">
        <div className="flex min-w-0 flex-1 items-center gap-1.5 md:gap-3">
          <button
            onClick={onMenuClick}
            aria-label="Open navigation menu"
            className="md:hidden min-h-11 min-w-11 p-2 rounded-lg text-secondary hover:bg-white hover:shadow-sm transition-all"
          >
            <Menu className="w-5 h-5" />
          </button>
          <h1 className="min-w-0 truncate text-lg font-semibold font-heading text-nav-dark md:overflow-visible md:whitespace-normal md:text-xl">
            {title}
            {accent && <span className="split-heading-accent"> {accent}</span>}
          </h1>
        </div>

        <div className="flex shrink-0 items-center gap-1 md:gap-2">
          <button
            onClick={onSearchClick}
            aria-label="Search (Ctrl+K)"
            className="flex min-h-11 min-w-11 items-center justify-center gap-2 rounded-lg border border-gray-200/70 bg-white/60 px-2 py-2 text-secondary transition-all hover:bg-white hover:shadow-sm md:min-h-0 md:min-w-0 md:px-3"
          >
            <Search className="w-4 h-4" />
            <span className="hidden md:inline text-sm">Search…</span>
            <kbd className="hidden md:inline text-[11px] border border-gray-200 rounded px-1.5 py-0.5">⌘K</kbd>
          </button>
          {allowedNewMenuItems.length > 0 && (
            <div className="relative hidden md:block" onBlur={closeWhenFocusLeaves}>
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
                  {allowedNewMenuItems.map((item) => (
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
          <div className="[&>div>button]:min-h-11 [&>div>button]:min-w-11 md:[&>div>button]:min-h-0 md:[&>div>button]:min-w-0">
            <NotificationsPanel />
          </div>
        </div>
      </div>
    </header>
  );
}
