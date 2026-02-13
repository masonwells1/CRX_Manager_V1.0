import { NavLink, useLocation } from 'react-router-dom';
import {
  LayoutDashboard,
  Package,
  Users,
  FileText,
  ClipboardList,
  Warehouse,
  Truck,
  ShoppingCart,
  Scale,
  BarChart3,
  MessageSquare,
  Bell,
  Settings,
  LogOut,
  X,
  Image,
  DollarSign,
  Sprout,
  MapPin,
  Receipt,
  Beaker,
  ClipboardCheck,
  RotateCcw,
} from 'lucide-react';
import { useAuth } from '../../contexts/AuthContext';
import type { UserRole } from '../../types';
import logoWhite from '../../assets/logo_3-01_(3).png';

interface NavItem {
  path: string;
  label: string;
  icon: React.ReactNode;
  roles?: UserRole[];
}

const navItems: NavItem[] = [
  { path: '/', label: 'Dashboard', icon: <LayoutDashboard className="w-5 h-5" /> },
  { path: '/products', label: 'Products', icon: <Package className="w-5 h-5" /> },
  { path: '/customers', label: 'Customers', icon: <Users className="w-5 h-5" /> },
  { path: '/fields', label: 'Fields', icon: <MapPin className="w-5 h-5" /> },
  { path: '/quotes', label: 'Quotes', icon: <FileText className="w-5 h-5" />, roles: ['admin', 'sales_rep'] },
  { path: '/orders', label: 'Orders', icon: <ClipboardList className="w-5 h-5" />, roles: ['admin', 'sales_rep'] },
  { path: '/invoices', label: 'Invoices', icon: <Receipt className="w-5 h-5" />, roles: ['admin', 'sales_rep'] },
  { path: '/inventory', label: 'Inventory', icon: <Warehouse className="w-5 h-5" /> },
  { path: '/cycle-counts', label: 'Cycle Counts', icon: <ClipboardCheck className="w-5 h-5" />, roles: ['admin'] },
  { path: '/deliveries', label: 'Deliveries', icon: <Truck className="w-5 h-5" /> },
  { path: '/blend-tickets', label: 'Blend Tickets', icon: <Image className="w-5 h-5" /> },
  { path: '/recipes', label: 'Blend Recipes', icon: <Beaker className="w-5 h-5" />, roles: ['admin', 'sales_rep'] },
  { path: '/returns', label: 'Returns', icon: <RotateCcw className="w-5 h-5" />, roles: ['admin', 'sales_rep'] },
  { path: '/purchase-orders', label: 'Supplier POs', icon: <ShoppingCart className="w-5 h-5" />, roles: ['admin'] },
  { path: '/brand-vs-generic', label: 'Brand vs Generic', icon: <Scale className="w-5 h-5" />, roles: ['admin', 'sales_rep'] },
  { path: '/reports', label: 'Reports', icon: <BarChart3 className="w-5 h-5" />, roles: ['admin', 'sales_rep'] },
  { path: '/crop-programs', label: 'Crop Programs', icon: <Sprout className="w-5 h-5" />, roles: ['admin', 'sales_rep'] },
  { path: '/payments', label: 'Payments', icon: <DollarSign className="w-5 h-5" />, roles: ['admin'] },
  { path: '/team-board', label: 'Team Board', icon: <MessageSquare className="w-5 h-5" /> },
  { path: '/notifications', label: 'Notifications', icon: <Bell className="w-5 h-5" /> },
  { path: '/settings', label: 'Settings', icon: <Settings className="w-5 h-5" />, roles: ['admin'] },
];

interface SidebarProps {
  mobileOpen: boolean;
  onClose: () => void;
}

export default function Sidebar({ mobileOpen, onClose }: SidebarProps) {
  const { profile, signOut } = useAuth();
  const location = useLocation();

  const filteredItems = navItems.filter(
    (item) => !item.roles || (profile && item.roles.includes(profile.role))
  );

  const isActive = (path: string) => {
    if (path === '/') return location.pathname === '/';
    return location.pathname.startsWith(path);
  };

  const linkContent = (item: NavItem) => (
    <div className="relative flex items-center gap-3 px-4 py-2.5">
      {isActive(item.path) && (
        <div className="absolute left-0 top-1 bottom-1 w-[3px] bg-crx-green rounded-r" />
      )}
      <span className={isActive(item.path) ? 'text-crx-green' : 'text-gray-400'}>{item.icon}</span>
      <span className="text-sm font-medium">{item.label}</span>
    </div>
  );

  return (
    <>
      {mobileOpen && (
        <div className="fixed inset-0 bg-black/40 z-40 lg:hidden" onClick={onClose} aria-hidden="true" />
      )}

      <aside
        role="navigation"
        aria-label="Main navigation"
        className={`
          fixed top-0 left-0 h-full w-64 bg-nav-dark z-50
          flex flex-col
          transition-transform duration-200 ease-in-out
          lg:translate-x-0 lg:static lg:z-auto
          ${mobileOpen ? 'translate-x-0' : '-translate-x-full'}
        `}
      >
        <div className="flex items-center justify-between px-5 py-5 border-b border-white/10">
          <img src={logoWhite} alt="Crop RX Solutions" className="h-10 w-auto" />
          <button onClick={onClose} aria-label="Close navigation menu" className="lg:hidden text-gray-400 hover:text-white p-1">
            <X className="w-5 h-5" />
          </button>
        </div>

        <nav className="flex-1 py-3 overflow-y-auto">
          <div className="space-y-0.5">
            {filteredItems.map((item) => (
              <NavLink
                key={item.path}
                to={item.path}
                onClick={onClose}
                className={({ isActive: active }) =>
                  `block transition-colors ${
                    active ? 'text-white bg-white/5' : 'text-gray-400 hover:text-white hover:bg-white/5'
                  }`
                }
              >
                {linkContent(item)}
              </NavLink>
            ))}
          </div>
        </nav>

        <div className="border-t border-white/10 p-4" data-testid="user-menu">
          <div className="flex items-center gap-3 mb-3">
            <div className="w-8 h-8 rounded-full bg-crx-green/20 flex items-center justify-center">
              <span className="text-xs font-semibold text-crx-green">
                {profile?.full_name?.split(' ').map((n) => n[0]).join('') || '?'}
              </span>
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm text-white truncate">{profile?.full_name || 'User'}</p>
              <p className="text-xs text-gray-500 capitalize">{profile?.role?.replace('_', ' ')}</p>
            </div>
          </div>
          <button
            onClick={signOut}
            className="flex items-center gap-2 w-full px-3 py-2 text-sm text-gray-400
              hover:text-white hover:bg-white/5 rounded-lg transition-colors"
          >
            <LogOut className="w-4 h-4" />
            Sign Out
          </button>
        </div>
      </aside>
    </>
  );
}
