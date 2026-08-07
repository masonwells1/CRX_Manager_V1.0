import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import {
  ArrowLeftRight,
  BadgeDollarSign,
  Banknote,
  BarChart3,
  Beaker,
  BookOpen,
  Building2,
  CalendarCheck,
  CalendarClock,
  ChevronLeft,
  ChevronRight,
  ClipboardCheck,
  ClipboardList,
  CloudOff,
  CreditCard,
  DatabaseZap,
  DollarSign,
  FileText,
  FlaskConical,
  Image,
  LayoutGrid,
  LogOut,
  MapPin,
  MessageSquare,
  Navigation,
  Package,
  PackageCheck,
  PackageSearch,
  Plane,
  Receipt,
  RotateCcw,
  Settings,
  ShieldAlert,
  ShieldCheck,
  ShoppingCart,
  Sprout,
  Truck,
  Users,
  Warehouse,
  Wrench,
  X,
} from 'lucide-react';
import { useAuth } from '../../contexts/AuthContext';
import { hasPageAccess, getPageKeyFromPath } from '../../lib/pagePermissions';
import { getVisitCounts, getVisitCountKey } from '../../lib/recentPages';
import { supabase } from '../../lib/db';
import { SPLIT_BILLING_SETTING_KEY, parseSplitBillingEnabled } from '../../lib/splitBillingSetting';
import type { UserRole } from '../../types';
import logoWhite from '../../assets/logo_3-01_(3).png';

// --- Types ---

interface NavSubItem {
  path: string;
  label: string;
  icon: React.ReactNode;
  roles?: UserRole[];
  /** Extra base paths that keep this link highlighted (workspace tab siblings). */
  activePaths?: string[];
}

interface NavCategory {
  id: string;
  label: string;
  icon: React.ReactNode;
  items: NavSubItem[];
}

interface StandaloneLink {
  id: string;
  path: string;
  label: string;
  icon: React.ReactNode;
  roles?: UserRole[];
  /** Extra base paths that keep this link highlighted (workspace tab siblings). */
  activePaths?: string[];
}

type NavEntry =
  | { type: 'standalone'; link: StandaloneLink }
  | { type: 'category'; category: NavCategory };

// --- Navigation structure ---

const officeNavigation: NavEntry[] = [
  { type: 'standalone', link: { id: 'today', path: '/office-cockpit', label: 'Today', icon: <LayoutGrid className="w-5 h-5" />, roles: ['admin', 'sales_rep'] } },
  { type: 'standalone', link: { id: 'to-ship', path: '/to-ship', label: 'To-Ship (Load-Out Board)', icon: <PackageSearch className="w-5 h-5" />, roles: ['admin', 'sales_rep'] } },
  {
    type: 'category',
    category: {
      id: 'sell-deliver', label: 'Sell & Deliver', icon: <Truck className="w-5 h-5" />,
      items: [
        { path: '/quotes', label: 'Quotes & Bookings', icon: <FileText className="w-4 h-4" /> },
        { path: '/orders', label: 'Orders', icon: <ClipboardList className="w-4 h-4" /> },
        { path: '/deliveries', label: 'Deliveries', icon: <Truck className="w-4 h-4" /> },
        { path: '/my-route', label: 'My Route (field mode)', icon: <Navigation className="w-4 h-4" /> },
        { path: '/delivery-remainders', label: 'Remainders', icon: <Package className="w-4 h-4" /> },
        { path: '/invoices', label: 'Invoices — Chemical', icon: <Receipt className="w-4 h-4" /> },
        { path: '/returns', label: 'Returns', icon: <RotateCcw className="w-4 h-4" /> },
      ],
    },
  },
  {
    type: 'category',
    category: {
      id: 'spray-fields', label: 'Spray Fields', icon: <Sprout className="w-5 h-5" />,
      items: [
        { path: '/jobs', label: 'Job Schedule', icon: <CalendarClock className="w-4 h-4" /> },
        { path: '/dispatch', label: 'Dispatch Board', icon: <MapPin className="w-4 h-4" /> },
        { path: '/field-invoices', label: 'Field Invoices', icon: <Receipt className="w-4 h-4" /> },
        { path: '/application-records', label: 'Record Book (Applications)', icon: <ClipboardCheck className="w-4 h-4" /> },
        { path: '/program-tracker', label: 'Program Tracker', icon: <CalendarCheck className="w-4 h-4" /> },
        { path: '/recipes', label: 'Blend Recipes', icon: <Beaker className="w-4 h-4" /> },
        { path: '/field', label: 'Field View (phone preview)', icon: <MapPin className="w-4 h-4" /> },
      ],
    },
  },
  {
    type: 'category',
    category: {
      id: 'customers-fields', label: 'Customers & Fields', icon: <Users className="w-5 h-5" />,
      items: [
        { path: '/customers', label: 'Customers', icon: <Users className="w-4 h-4" /> },
        { path: '/call-lists', label: 'Call Lists', icon: <ClipboardList className="w-4 h-4" />, roles: ['admin', 'sales_rep'] },
        { path: '/fields', label: 'Fields & Maps', icon: <MapPin className="w-4 h-4" /> },
        { path: '/crop-programs', label: 'Crop Programs', icon: <Sprout className="w-4 h-4" /> },
      ],
    },
  },
  {
    type: 'category',
    category: {
      id: 'inventory-buying', label: 'Inventory & Buying', icon: <Warehouse className="w-5 h-5" />,
      items: [
        { path: '/inventory', label: 'Inventory', icon: <Warehouse className="w-4 h-4" /> },
        {
          path: '/products', label: 'Products & Pricing', icon: <Package className="w-4 h-4" />,
          // Supplier Pricing + Brand vs Generic live as tabs on the Products workspace
          activePaths: ['/products', '/supplier-pricing', '/brand-vs-generic'],
        },
        { path: '/purchase-orders', label: 'Purchase Orders', icon: <ShoppingCart className="w-4 h-4" /> },
        { path: '/receiving', label: 'Receiving', icon: <PackageCheck className="w-4 h-4" /> },
        { path: '/cycle-counts', label: 'Cycle Counts', icon: <ClipboardCheck className="w-4 h-4" />, roles: ['admin'] },
      ],
    },
  },
  {
    type: 'category',
    category: {
      id: 'money', label: 'Money', icon: <DollarSign className="w-5 h-5" />,
      items: [
        { path: '/payments', label: 'Record Payments', icon: <DollarSign className="w-4 h-4" /> },
        { path: '/accounts-receivable', label: 'A/R Workspace', icon: <CreditCard className="w-4 h-4" />, roles: ['admin'] },
        { path: '/prepay', label: 'Prepay', icon: <ArrowLeftRight className="w-4 h-4" />, roles: ['admin'] },
        { path: '/accounts-payable', label: 'A/P & Vendor Bills', icon: <Receipt className="w-4 h-4" />, roles: ['admin'] },
        { path: '/commission-payments', label: 'Commissions', icon: <Banknote className="w-4 h-4" />, roles: ['admin'] },
        { path: '/rebates', label: 'Rebates', icon: <BadgeDollarSign className="w-4 h-4" />, roles: ['admin'] },
        { path: '/month-end', label: 'Month-End Close', icon: <CalendarCheck className="w-4 h-4" />, roles: ['admin'] },
        { path: '/integrity', label: 'Data Integrity', icon: <ShieldAlert className="w-4 h-4" />, roles: ['admin'] },
      ],
    },
  },
  {
    type: 'category',
    category: {
      id: 'compliance-records', label: 'Compliance & Records', icon: <ShieldCheck className="w-5 h-5" />,
      items: [
        { path: '/compliance', label: 'Licenses & RUP Register', icon: <ShieldCheck className="w-4 h-4" /> },
        { path: '/lot-trace', label: 'Lot Trace (recall lookup)', icon: <PackageSearch className="w-4 h-4" /> },
        { path: '/watchdog', label: 'Watchdog Flags', icon: <ShieldAlert className="w-4 h-4" /> },
        { path: '/offline-work-review', label: 'Offline Work Review', icon: <CloudOff className="w-4 h-4" /> },
        { path: '/label-review', label: 'Label Review', icon: <FlaskConical className="w-4 h-4" />, roles: ['admin'] },
        { path: '/label-data-quality', label: 'Label Data Quality', icon: <DatabaseZap className="w-4 h-4" />, roles: ['admin'] },
        { path: '/blend-tickets', label: 'Blend Tickets (OCR)', icon: <Image className="w-4 h-4" /> },
      ],
    },
  },
  {
    // Insights is a single workspace page now — Reports, Sales Reports,
    // Field Profitability, and Financial Dashboard are tabs on /dashboard.
    type: 'standalone',
    link: {
      id: 'insights', path: '/dashboard', label: 'Insights', icon: <BarChart3 className="w-5 h-5" />,
      roles: ['admin', 'sales_rep'],
      activePaths: ['/dashboard', '/reports', '/sales-reports', '/field-profitability', '/financial-dashboard'],
    },
  },
  {
    type: 'category',
    category: {
      id: 'setup-admin', label: 'Setup & Admin', icon: <Settings className="w-5 h-5" />,
      items: [
        { path: '/vehicles', label: 'Vehicles', icon: <Plane className="w-4 h-4" />, roles: ['admin'] },
        { path: '/application-services', label: 'Application Services (fees)', icon: <Wrench className="w-4 h-4" />, roles: ['admin'] },
        { path: '/vendors', label: 'Vendors', icon: <Building2 className="w-4 h-4" />, roles: ['admin'] },
        { path: '/getting-started', label: 'Getting Started (help)', icon: <BookOpen className="w-4 h-4" /> },
        { path: '/settings', label: 'Settings', icon: <Settings className="w-4 h-4" />, roles: ['admin'] },
      ],
    },
  },
  { type: 'standalone', link: { id: 'team-board', path: '/team-board', label: 'Team Board', icon: <MessageSquare className="w-5 h-5" /> } },
];

const applicatorNavigation: NavEntry[] = [
  { type: 'standalone', link: { id: 'my-day', path: '/field', label: 'My Day', icon: <Sprout className="w-5 h-5" /> } },
  { type: 'standalone', link: { id: 'my-jobs', path: '/jobs', label: 'My Jobs', icon: <CalendarClock className="w-5 h-5" /> } },
  { type: 'standalone', link: { id: 'record-book', path: '/application-records', label: 'Record Book', icon: <ClipboardCheck className="w-5 h-5" /> } },
  { type: 'standalone', link: { id: 'team-board', path: '/team-board', label: 'Team Board', icon: <MessageSquare className="w-5 h-5" /> } },
  { type: 'standalone', link: { id: 'help', path: '/getting-started', label: 'Help', icon: <BookOpen className="w-5 h-5" /> } },
];

const driverNavigation: NavEntry[] = [
  { type: 'standalone', link: { id: 'my-route', path: '/my-route', label: 'My Route', icon: <Navigation className="w-5 h-5" /> } },
  { type: 'standalone', link: { id: 'deliveries', path: '/deliveries', label: 'Deliveries', icon: <Truck className="w-5 h-5" /> } },
  { type: 'standalone', link: { id: 'team-board', path: '/team-board', label: 'Team Board', icon: <MessageSquare className="w-5 h-5" /> } },
  { type: 'standalone', link: { id: 'help', path: '/getting-started', label: 'Help', icon: <BookOpen className="w-5 h-5" /> } },
];

function getNavigationForRole(role: UserRole | undefined): NavEntry[] {
  if (role === 'applicator') return applicatorNavigation;
  if (role === 'driver') return driverNavigation;
  return officeNavigation;
}

// Flag-gated per-line split-billing link. Injected into the "Spray Fields" category ONLY
// when per_line_split_billing_enabled is ON (the app is behaviour-neutral while OFF).
const SPLIT_BILLING_NAV_ITEM: NavSubItem = {
  path: '/split-billing/new',
  label: 'Split Billing (per line)',
  icon: <Receipt className="w-4 h-4" />,
  roles: ['admin', 'sales_rep'],
};

// --- Helpers ---

const STORAGE_KEY = 'crx-sidebar-expanded';

function hasRoleAccess(roles: UserRole[] | undefined, userRole: UserRole | undefined): boolean {
  if (!roles) return true;
  return !!userRole && roles.includes(userRole);
}

/**
 * Resolve where a nav entry should link, honoring the per-user deny list.
 * An entry fronting a workspace (activePaths) stays visible as long as ANY
 * sibling page is accessible, and links to the first accessible one — denying
 * the lead page must not hide siblings the user is still allowed to open.
 * Returns null when none are accessible (entry hidden).
 */
function resolveNavPath(
  roles: UserRole[] | undefined,
  userRole: UserRole | undefined,
  deniedPages: string[],
  path: string,
  activePaths?: string[]
): string | null {
  if (!hasRoleAccess(roles, userRole)) return null;
  const candidates = [path, ...(activePaths ?? []).filter((p) => p !== path)];
  for (const candidate of candidates) {
    const pageKey = getPageKeyFromPath(candidate);
    if (!pageKey || !userRole || hasPageAccess(userRole, deniedPages, pageKey)) {
      return candidate;
    }
  }
  return null;
}

function getVisibleItems(items: NavSubItem[], userRole: UserRole | undefined, deniedPages: string[]): NavSubItem[] {
  return items.flatMap((item) => {
    const target = resolveNavPath(item.roles, userRole, deniedPages, item.path, item.activePaths);
    if (!target) return [];
    return [target === item.path ? item : { ...item, path: target }];
  });
}

function pathMatches(path: string, pathname: string): boolean {
  if (path === '/') return pathname === '/';
  return pathname === path || pathname.startsWith(path + '/');
}

/** Check if any sub-item's route (or workspace sibling) is the current active route */
function categoryHasActiveRoute(items: NavSubItem[], pathname: string): boolean {
  return items.some((item) =>
    (item.activePaths ?? [item.path]).some((p) => pathMatches(p, pathname))
  );
}

// --- Component ---

interface SidebarProps {
  mobileOpen: boolean;
  onClose: () => void;
}

export default function Sidebar({ mobileOpen, onClose }: SidebarProps) {
  const { profile, deniedPages, signOut } = useAuth();
  const location = useLocation();
  const userRole = profile?.role;
  const mobileDrawerRef = useRef<HTMLElement>(null);

  // Flag-gated per-line split-billing nav link. OFF by default → link hidden, app unchanged.
  const [splitBillingEnabled, setSplitBillingEnabled] = useState(false);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const { data } = await supabase
          .from('app_settings')
          .select('setting_value')
          .eq('setting_key', SPLIT_BILLING_SETTING_KEY)
          .maybeSingle();
        if (!cancelled) {
          setSplitBillingEnabled(parseSplitBillingEnabled((data as { setting_value?: string } | null)?.setting_value ?? null));
        }
      } catch {
        if (!cancelled) setSplitBillingEnabled(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const navigation = useMemo<NavEntry[]>(() => {
    const base = getNavigationForRole(userRole);
    if (!splitBillingEnabled) return base;
    return base.map((entry) =>
      entry.type === 'category' && entry.category.id === 'spray-fields'
        ? { ...entry, category: { ...entry.category, items: [...entry.category.items, SPLIT_BILLING_NAV_ITEM] } }
        : entry,
    );
  }, [userRole, splitBillingEnabled]);

  // Top 5 most-visited category sub-pages (visit counts live in localStorage).
  // Surfaces buried pages as one-click links; hidden until real usage builds up.
  // Office roles only — applicator/driver navs are already flat and short.
  const frequentItems = useMemo<NavSubItem[]>(() => {
    if (userRole === 'applicator' || userRole === 'driver') return [];
    const counts = getVisitCounts();
    const candidates: NavSubItem[] = [];
    for (const entry of navigation) {
      if (entry.type === 'category') {
        candidates.push(...getVisibleItems(entry.category.items, userRole, deniedPages));
      }
    }
    return candidates
      .map((item) => {
        // A condensed entry fronts several workspace pages; visits to any of
        // them (path or activePaths siblings) count toward this one link.
        const keys = new Set([item.path, ...(item.activePaths ?? [])].map(getVisitCountKey));
        let count = 0;
        for (const key of keys) count += counts[key] || 0;
        return { item, count };
      })
      .filter((c) => c.count >= 3)
      .sort((a, b) => b.count - a.count)
      .slice(0, 5)
      .map((c) => c.item);
    // location.pathname keeps counts fresh as the user navigates this session
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [navigation, userRole, deniedPages, location.pathname]);

  // Expanded category id (null = collapsed sidebar, string = that category is open)
  const [openCategory, setOpenCategory] = useState<string | null>(() => {
    try {
      return localStorage.getItem(STORAGE_KEY) || null;
    } catch {
      return null;
    }
  });

  const isExpanded = openCategory !== null;

  // Persist to localStorage
  useEffect(() => {
    try {
      if (openCategory) {
        localStorage.setItem(STORAGE_KEY, openCategory);
      } else {
        localStorage.removeItem(STORAGE_KEY);
      }
    } catch {
      // ignore storage errors
    }
  }, [openCategory]);

  useEffect(() => {
    if (!mobileOpen) return;

    const drawer = mobileDrawerRef.current;
    if (!drawer) return;

    const focusableSelector = [
      'a[href]',
      'button:not([disabled])',
      'input:not([disabled])',
      'select:not([disabled])',
      'textarea:not([disabled])',
      '[tabindex]:not([tabindex="-1"])',
    ].join(',');
    const previousOverflow = document.body.style.overflow;
    const focusableElements = () => Array.from(drawer.querySelectorAll<HTMLElement>(focusableSelector));
    const firstFocusable = focusableElements()[0];

    document.body.style.overflow = 'hidden';
    firstFocusable?.focus();

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
        return;
      }

      if (event.key !== 'Tab') return;

      const focusable = focusableElements();
      if (focusable.length === 0) {
        event.preventDefault();
        drawer.focus();
        return;
      }

      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [mobileOpen, onClose]);

  useEffect(() => {
    const drawer = mobileDrawerRef.current as (HTMLElement & { inert?: boolean }) | null;
    if (drawer) drawer.inert = !mobileOpen;
  }, [mobileOpen]);

  const toggleCategory = useCallback((categoryId: string) => {
    setOpenCategory((prev) => (prev === categoryId ? null : categoryId));
  }, []);

  const collapse = useCallback(() => {
    setOpenCategory(null);
  }, []);

  const isRouteActive = (path: string, activePaths?: string[]) =>
    (activePaths ?? [path]).some((p) => pathMatches(p, location.pathname));

  // --- Mobile: always show full expanded sidebar (legacy behavior) ---
  // --- Desktop: collapsible icon sidebar ---

  // "Frequent" quick links — same visual language as standalone links,
  // separated from the main nav by a divider. Desktop shows it only when
  // the sidebar is expanded (icon-only rows would duplicate the categories).
  const renderFrequent = (isMobile: boolean) => {
    if (frequentItems.length === 0) return null;
    if (!isMobile && !isExpanded) return null;
    return (
      <div>
        <div className="px-4 pt-1 pb-1">
          <span className="text-[11px] font-semibold uppercase tracking-wider text-gray-500">Frequent</span>
        </div>
        {frequentItems.map((item) => {
          const active = isRouteActive(item.path, item.activePaths);
          return (
            <NavLink
              key={`frequent-${item.path}`}
              to={item.path}
              onClick={isMobile ? onClose : undefined}
              className={`block transition-colors ${active ? 'text-white bg-white/5' : 'text-gray-400 hover:text-white hover:bg-white/5'}`}
            >
              <div className="relative flex items-center gap-3 px-4 py-2">
                {active && <div className="absolute left-0 top-1 bottom-1 w-[3px] bg-crx-green rounded-r" />}
                <span className={active ? 'text-crx-green' : 'text-gray-400'}>{item.icon}</span>
                <span className="text-sm font-medium whitespace-nowrap">{item.label}</span>
              </div>
            </NavLink>
          );
        })}
        <div className="mx-4 my-2 border-t border-white/10" aria-hidden="true" />
      </div>
    );
  };

  const renderNavEntries = (isMobile: boolean) =>
    navigation.map((entry) => {
      if (entry.type === 'standalone') {
        const { link } = entry;
        const target = resolveNavPath(link.roles, userRole, deniedPages, link.path, link.activePaths);
        if (!target) return null;

        const active = isRouteActive(link.path, link.activePaths);

        if (isMobile) {
          return (
            <NavLink
              key={link.id}
              to={target}
              onClick={onClose}
              className={`block transition-colors ${active ? 'text-white bg-white/5' : 'text-gray-400 hover:text-white hover:bg-white/5'}`}
            >
              <div className="relative flex items-center gap-3 px-4 py-2.5">
                {active && <div className="absolute left-0 top-1 bottom-1 w-[3px] bg-crx-green rounded-r" />}
                <span className={active ? 'text-crx-green' : 'text-gray-400'}>{link.icon}</span>
                <span className="text-sm font-medium">{link.label}</span>
              </div>
            </NavLink>
          );
        }

        // Desktop collapsed/expanded standalone
        return (
          <NavLink
            key={link.id}
            to={target}
            className={`group relative block transition-colors ${active ? 'text-white bg-white/5' : 'text-gray-400 hover:text-white hover:bg-white/5'}`}
          >
            <div className={`relative flex items-center gap-3 py-2.5 ${isExpanded ? 'px-4' : 'px-0 justify-center'}`}>
              {active && <div className="absolute left-0 top-1 bottom-1 w-[3px] bg-crx-green rounded-r" />}
              <span className={active ? 'text-crx-green' : 'text-gray-400'}>{link.icon}</span>
              {isExpanded && <span className="text-sm font-medium whitespace-nowrap">{link.label}</span>}
            </div>
            {/* Tooltip when collapsed */}
            {!isExpanded && (
              <div className="absolute left-full top-1/2 -translate-y-1/2 ml-2 px-2 py-1 bg-gray-900 text-white text-xs rounded shadow-lg whitespace-nowrap opacity-0 pointer-events-none group-hover:opacity-100 transition-opacity z-[60]">
                {link.label}
              </div>
            )}
          </NavLink>
        );
      }

      // Category entry
      const { category } = entry;
      const visibleItems = getVisibleItems(category.items, userRole, deniedPages);
      if (visibleItems.length === 0) return null;

      const isOpen = openCategory === category.id;
      const hasActive = categoryHasActiveRoute(visibleItems, location.pathname);

      if (isMobile) {
        // Mobile: show category header + all items always expanded
        return (
          <div key={category.id}>
            <div className="px-4 pt-4 pb-1">
              <span className="text-[11px] font-semibold uppercase tracking-wider text-gray-500">{category.label}</span>
            </div>
            {visibleItems.map((item) => {
              const active = isRouteActive(item.path, item.activePaths);
              return (
                <NavLink
                  key={item.path}
                  to={item.path}
                  onClick={onClose}
                  className={`block transition-colors ${active ? 'text-white bg-white/5' : 'text-gray-400 hover:text-white hover:bg-white/5'}`}
                >
                  <div className="relative flex items-center gap-3 px-4 py-2.5 pl-6">
                    {active && <div className="absolute left-0 top-1 bottom-1 w-[3px] bg-crx-green rounded-r" />}
                    <span className={active ? 'text-crx-green' : 'text-gray-400'}>{item.icon}</span>
                    <span className="text-sm font-medium">{item.label}</span>
                  </div>
                </NavLink>
              );
            })}
          </div>
        );
      }

      // Desktop category
      return (
        <div key={category.id}>
          {/* Category icon button */}
          <button
            onClick={() => toggleCategory(category.id)}
            aria-expanded={isOpen}
            aria-label={`${isOpen ? 'Collapse' : 'Expand'} ${category.label} navigation`}
            className={`group relative w-full flex items-center gap-3 py-2.5 transition-colors ${
              isExpanded ? 'px-4' : 'px-0 justify-center'
            } ${hasActive ? 'text-white bg-white/5' : 'text-gray-400 hover:text-white hover:bg-white/5'}`}
          >
            {hasActive && <div className="absolute left-0 top-1 bottom-1 w-[3px] bg-crx-green rounded-r" />}
            <span className={hasActive ? 'text-crx-green' : 'text-gray-400'}>{category.icon}</span>
            {isExpanded && (
              <span className="text-sm font-medium whitespace-nowrap flex-1 text-left">{category.label}</span>
            )}
            {/* Tooltip when collapsed */}
            {!isExpanded && (
              <div className="absolute left-full top-1/2 -translate-y-1/2 ml-2 px-2 py-1 bg-gray-900 text-white text-xs rounded shadow-lg whitespace-nowrap opacity-0 pointer-events-none group-hover:opacity-100 transition-opacity z-[60]">
                {category.label}
              </div>
            )}
          </button>

          {/* Sub-items (only shown when this category is open) */}
          {isOpen && isExpanded && (
            <div className="pb-1">
              {visibleItems.map((item) => {
                const active = isRouteActive(item.path, item.activePaths);
                return (
                  <NavLink
                    key={item.path}
                    to={item.path}
                    className={`block transition-colors ${active ? 'text-white bg-white/5' : 'text-gray-400 hover:text-white hover:bg-white/5'}`}
                  >
                    <div className="relative flex items-center gap-3 px-4 py-2 pl-10">
                      {active && <div className="absolute left-0 top-1 bottom-1 w-[3px] bg-crx-green rounded-r" />}
                      <span className={active ? 'text-crx-green' : 'text-gray-400'}>{item.icon}</span>
                      <span className="text-sm font-medium whitespace-nowrap">{item.label}</span>
                    </div>
                  </NavLink>
                );
              })}
            </div>
          )}
        </div>
      );
    });

  return (
    <>
      {/* Mobile overlay */}
      {mobileOpen && (
        <button
          type="button"
          tabIndex={-1}
          aria-label="Dismiss navigation backdrop"
          className="fixed inset-0 z-40 bg-black/40 md:hidden"
          onClick={onClose}
        />
      )}

      {/* Mobile sidebar — full-width drawer, always expanded items */}
      <aside
        ref={mobileDrawerRef}
        id="mobile-navigation-drawer"
        role="dialog"
        aria-label="Navigation menu"
        aria-modal={mobileOpen}
        aria-hidden={!mobileOpen}
        tabIndex={-1}
        className={`
          fixed top-0 left-0 h-full w-64 bg-nav-dark z-50
          flex flex-col
          transition-transform duration-200 ease-in-out
          md:hidden
          ${mobileOpen ? 'translate-x-0' : 'pointer-events-none -translate-x-full'}
        `}
      >
        <div className="flex items-center justify-between px-5 py-5 border-b border-white/10">
          <img src={logoWhite} alt="Crop RX Solutions" className="h-10 w-auto" />
          <button onClick={onClose} aria-label="Close navigation menu" className="min-h-11 min-w-11 text-gray-400 hover:text-white p-1">
            <X className="w-5 h-5" />
          </button>
        </div>

        <nav aria-label="Main navigation" className="flex-1 py-3 overflow-y-auto">
          {renderFrequent(true)}
          <div className="space-y-0.5">{renderNavEntries(true)}</div>
        </nav>

        {/* User section — mobile */}
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

      {/* Desktop sidebar — collapsible icon sidebar */}
      <aside
        role="navigation"
        aria-label="Main navigation"
        className={`
          hidden md:flex flex-col flex-shrink-0
          h-screen sticky top-0
          bg-nav-dark
          transition-[width] duration-200 ease-in-out
          ${isExpanded ? 'w-64' : 'w-16'}
        `}
      >
        {/* Logo */}
        <div className={`flex items-center border-b border-white/10 ${isExpanded ? 'px-5 py-5 justify-start' : 'px-0 py-5 justify-center'}`}>
          {isExpanded ? (
            <img src={logoWhite} alt="Crop RX Solutions" className="h-10 w-auto" />
          ) : (
            <div className="w-8 h-8 rounded-lg bg-crx-green flex items-center justify-center">
              <span className="text-white text-xs font-bold leading-none">CRX</span>
            </div>
          )}
        </div>

        {/* Nav items */}
        <nav className="flex-1 py-3 overflow-y-auto overflow-x-hidden">
          {renderFrequent(false)}
          <div className="space-y-0.5">{renderNavEntries(false)}</div>
        </nav>

        {/* Collapse toggle */}
        <div className="border-t border-white/10">
          <button
            onClick={isExpanded ? collapse : () => {}}
            aria-label={isExpanded ? 'Collapse sidebar' : 'Sidebar is collapsed'}
            className={`w-full flex items-center gap-3 py-2.5 text-gray-400 hover:text-white hover:bg-white/5 transition-colors ${
              isExpanded ? 'px-4' : 'px-0 justify-center'
            }`}
            disabled={!isExpanded}
          >
            {isExpanded ? (
              <>
                <ChevronLeft className="w-4 h-4" />
                <span className="text-xs font-medium">Collapse</span>
              </>
            ) : (
              <ChevronRight className="w-4 h-4" />
            )}
          </button>
        </div>

        {/* User section — desktop */}
        <div className={`border-t border-white/10 ${isExpanded ? 'p-4' : 'p-2'}`} data-testid="user-menu">
          {isExpanded ? (
            <>
              <div className="flex items-center gap-3 mb-3">
                <div className="w-8 h-8 rounded-full bg-crx-green/20 flex items-center justify-center flex-shrink-0">
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
            </>
          ) : (
            <div className="flex flex-col items-center gap-2">
              <div className="group relative w-8 h-8 rounded-full bg-crx-green/20 flex items-center justify-center cursor-default">
                <span className="text-xs font-semibold text-crx-green">
                  {profile?.full_name?.split(' ').map((n) => n[0]).join('') || '?'}
                </span>
                <div className="absolute left-full top-1/2 -translate-y-1/2 ml-2 px-2 py-1 bg-gray-900 text-white text-xs rounded shadow-lg whitespace-nowrap opacity-0 pointer-events-none group-hover:opacity-100 transition-opacity z-[60]">
                  {profile?.full_name || 'User'}
                </div>
              </div>
              <button
                onClick={signOut}
                aria-label="Sign out"
                className="group relative flex items-center justify-center w-8 h-8 text-gray-400
                  hover:text-white hover:bg-white/5 rounded-lg transition-colors"
              >
                <LogOut className="w-4 h-4" />
                <div className="absolute left-full top-1/2 -translate-y-1/2 ml-2 px-2 py-1 bg-gray-900 text-white text-xs rounded shadow-lg whitespace-nowrap opacity-0 pointer-events-none group-hover:opacity-100 transition-opacity z-[60]">
                  Sign Out
                </div>
              </button>
            </div>
          )}
        </div>
      </aside>
    </>
  );
}
