import { CalendarClock, LayoutGrid, MoreHorizontal, Receipt, Warehouse } from 'lucide-react';
import { Link, useLocation } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext';
import { hasPageAccess } from '../../lib/pagePermissions';

interface MobileBottomNavProps {
  onMoreClick: () => void;
  moreOpen: boolean;
}

const PRIMARY_NAV_ITEMS = [
  { label: 'Today', path: '/office-cockpit', pageKey: 'office-cockpit', icon: LayoutGrid },
  { label: 'Jobs', path: '/jobs', pageKey: 'jobs', icon: CalendarClock },
  { label: 'Inventory', path: '/inventory', pageKey: 'inventory', icon: Warehouse },
  { label: 'Field Invoices', path: '/field-invoices', pageKey: 'field-invoices', icon: Receipt },
] as const;

function isRouteActive(pathname: string, path: string, pageKey: string): boolean {
  if (pageKey === 'field-invoices' && pathname.startsWith('/invoices/field-app')) return true;
  return pathname === path || pathname.startsWith(`${path}/`);
}

export default function MobileBottomNav({ onMoreClick, moreOpen }: MobileBottomNavProps) {
  const { profile, deniedPages } = useAuth();
  const location = useLocation();
  const role = profile?.role ?? null;
  const visibleItems = PRIMARY_NAV_ITEMS.filter((item) => hasPageAccess(role, deniedPages, item.pageKey));

  return (
    <nav
      aria-label="Mobile primary navigation"
      className="fixed inset-x-0 bottom-0 z-30 flex border-t border-gray-200 bg-cream/95 pb-[env(safe-area-inset-bottom)] shadow-[0_-1px_4px_rgba(0,0,0,0.08)] backdrop-blur md:hidden"
    >
      {visibleItems.map(({ label, path, pageKey, icon: Icon }) => {
        const active = isRouteActive(location.pathname, path, pageKey);

        return (
          <Link
            key={path}
            to={path}
            aria-current={active ? 'page' : undefined}
            className={`flex min-h-11 flex-1 flex-col items-center justify-center gap-0.5 px-1 text-[10px] font-medium transition-colors ${
              active ? 'text-crx-green' : 'text-secondary hover:text-nav-dark'
            }`}
          >
            <Icon className="h-5 w-5" aria-hidden="true" />
            <span className="truncate">{label}</span>
          </Link>
        );
      })}
      <button
        type="button"
        onClick={onMoreClick}
        aria-label="Open navigation menu"
        aria-expanded={moreOpen}
        aria-controls="mobile-navigation-drawer"
        className={`flex min-h-11 flex-1 flex-col items-center justify-center gap-0.5 px-1 text-[10px] font-medium transition-colors ${
          moreOpen ? 'text-crx-green' : 'text-secondary hover:text-nav-dark'
        }`}
      >
        <MoreHorizontal className="h-5 w-5" aria-hidden="true" />
        <span>More</span>
      </button>
    </nav>
  );
}
