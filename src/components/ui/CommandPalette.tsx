import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Search,
  Users,
  ClipboardList,
  Receipt,
  Truck,
  Package,
  FileText,
  Clock,
  ArrowRight,
  LayoutDashboard,
  Warehouse,
  Settings,
  BarChart3,
  MapPin,
  Sprout,
  Scale,
  Beaker,
  ShoppingCart,
  PackageCheck,
  RotateCcw,
  CalendarClock,
  DollarSign,
  CreditCard,
  Wallet,
  Banknote,
  CalendarCheck,
  BadgeDollarSign,
  ShieldCheck,
  PackageSearch,
  MessageSquare,
  BookOpen,
  Plane,
  Image,
  ClipboardCheck,
  ArrowLeftRight,
  ShieldAlert,
  LayoutGrid,
} from 'lucide-react';
import { supabase, assertRpcResult } from '../../lib/db';
import { getRecentItems } from '../../lib/recentPages';
import { PAGE_PERMISSIONS, hasPageAccess } from '../../lib/pagePermissions';
import { useAuth } from '../../contexts/AuthContext';
import type { GlobalSearchResult, SearchEntityType } from '../../types';

// ── Types ──────────────────────────────────────────────────────────

interface SearchResult {
  id: string;
  type: 'recent' | 'page' | SearchEntityType;
  label: string;
  subtitle?: string;
  path: string;
}

interface CommandPaletteProps {
  open: boolean;
  onClose: () => void;
}

// ── Constants ──────────────────────────────────────────────────────

const DEBOUNCE_MS = 300;

const ENTITY_ICONS: Record<SearchEntityType, React.ReactNode> = {
  customer: <Users className="w-4 h-4" />,
  order: <ClipboardList className="w-4 h-4" />,
  invoice: <Receipt className="w-4 h-4" />,
  delivery: <Truck className="w-4 h-4" />,
  product: <Package className="w-4 h-4" />,
};

const ENTITY_COLORS: Record<SearchEntityType, string> = {
  customer: 'bg-blue-100 text-blue-700',
  order: 'bg-amber-100 text-amber-700',
  invoice: 'bg-green-100 text-green-700',
  delivery: 'bg-purple-100 text-purple-700',
  product: 'bg-rose-100 text-rose-700',
};

const ENTITY_PATHS: Record<SearchEntityType, string> = {
  customer: '/customers/',
  order: '/orders/',
  invoice: '/invoices/',
  delivery: '/deliveries/',
  product: '/products/',
};

// Page icon mapping for common pages
const PAGE_ICON_MAP: Record<string, React.ReactNode> = {
  '/dashboard': <LayoutDashboard className="w-4 h-4" />,
  '/office-cockpit': <LayoutGrid className="w-4 h-4" />,
  '/to-ship': <PackageSearch className="w-4 h-4" />,
  '/quotes': <FileText className="w-4 h-4" />,
  '/orders': <ClipboardList className="w-4 h-4" />,
  '/invoices': <Receipt className="w-4 h-4" />,
  '/payments': <DollarSign className="w-4 h-4" />,
  '/customers': <Users className="w-4 h-4" />,
  '/fields': <MapPin className="w-4 h-4" />,
  '/crop-programs': <Sprout className="w-4 h-4" />,
  '/products': <Package className="w-4 h-4" />,
  '/brand-vs-generic': <Scale className="w-4 h-4" />,
  '/recipes': <Beaker className="w-4 h-4" />,
  '/inventory': <Warehouse className="w-4 h-4" />,
  '/cycle-counts': <ClipboardCheck className="w-4 h-4" />,
  '/purchase-orders': <ShoppingCart className="w-4 h-4" />,
  '/receiving': <PackageCheck className="w-4 h-4" />,
  '/returns': <RotateCcw className="w-4 h-4" />,
  '/jobs': <CalendarClock className="w-4 h-4" />,
  '/dispatch': <MapPin className="w-4 h-4" />,
  '/deliveries': <Truck className="w-4 h-4" />,
  '/delivery-remainders': <Package className="w-4 h-4" />,
  '/vehicles': <Plane className="w-4 h-4" />,
  '/blend-tickets': <Image className="w-4 h-4" />,
  '/application-records': <ClipboardCheck className="w-4 h-4" />,
  '/financial-dashboard': <LayoutDashboard className="w-4 h-4" />,
  '/ar-aging': <Clock className="w-4 h-4" />,
  '/accounts-payable': <Receipt className="w-4 h-4" />,
  '/prepayments': <Wallet className="w-4 h-4" />,
  '/prepay-workspace': <ArrowLeftRight className="w-4 h-4" />,
  '/commission-payments': <Banknote className="w-4 h-4" />,
  '/customer-transactions': <CreditCard className="w-4 h-4" />,
  '/month-end': <CalendarCheck className="w-4 h-4" />,
  '/rebates': <BadgeDollarSign className="w-4 h-4" />,
  '/reports': <BarChart3 className="w-4 h-4" />,
  '/sales-reports': <BarChart3 className="w-4 h-4" />,
  '/compliance': <ShieldCheck className="w-4 h-4" />,
  '/lot-trace': <PackageSearch className="w-4 h-4" />,
  '/watchdog': <ShieldAlert className="w-4 h-4" />,
  '/team-board': <MessageSquare className="w-4 h-4" />,
  '/settings': <Settings className="w-4 h-4" />,
  '/getting-started': <BookOpen className="w-4 h-4" />,
};

// Commands without a PAGE_PERMISSIONS entry: creation/deep links and global
// routes. Permission pages themselves are derived below from the canonical list.
const EXTRA_PAGES: { path: string; label: string; pageKey?: string; allRoles?: boolean; adminOnly?: boolean }[] = [
  { path: '/quotes/new', label: 'New Quote/Booking', pageKey: 'quotes' },
  { path: '/orders/new', label: 'New Order', pageKey: 'orders' },
  { path: '/purchase-orders/new', label: 'New Purchase Order', pageKey: 'purchase-orders' },
  { path: '/receiving/quick', label: 'Quick Receive', pageKey: 'receiving' },
  { path: '/deliveries/new', label: 'New Delivery', pageKey: 'deliveries' },
  { path: '/deliveries?quickDeliver=1', label: 'Sell & Deliver Now', pageKey: 'deliveries' },
  { path: '/sales-reports?tab=by_product', label: 'Sales by Product (Product Mix)', pageKey: 'sales-reports' },
  { path: '/sales-reports?tab=by_customer', label: 'Sales by Customer (Customer Profitability)', pageKey: 'sales-reports' },
  { path: '/sales-reports?tab=by_sales_rep', label: 'Sales by Sales Rep', pageKey: 'sales-reports' },
  { path: '/sales-reports?tab=by_month', label: 'Sales by Month', pageKey: 'sales-reports' },
  // Global routes without a PAGE_PERMISSIONS entry. Team Board + Notifications
  // are all-role; Settings is admin-only (mirrors its route gate) — these must
  // NOT be swept up in the office-role gate below (gauntlet confirm-round P3).
  { path: '/team-board', label: 'Team Board', allRoles: true },
  { path: '/notifications', label: 'Notifications', allRoles: true },
  { path: '/settings', label: 'Settings', adminOnly: true },
];

// ── Helpers ────────────────────────────────────────────────────────

function fuzzyMatch(query: string, text: string): boolean {
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  if (t.includes(q)) return true;
  // Simple fuzzy: all query chars appear in order
  let qi = 0;
  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] === q[qi]) qi++;
  }
  return qi === q.length;
}

function getPageIcon(path: string): React.ReactNode {
  // Strip any query string (deep-link report entries) before matching.
  const clean = path.split('?')[0];
  // Try exact match first, then try the base path
  if (PAGE_ICON_MAP[clean]) return PAGE_ICON_MAP[clean];
  const base = '/' + clean.split('/').filter(Boolean)[0];
  return PAGE_ICON_MAP[base] || <ArrowRight className="w-4 h-4" />;
}

// ── Component ──────────────────────────────────────────────────────

export default function CommandPalette({ open, onClose }: CommandPaletteProps) {
  const { role: authRole, deniedPages, loading: authLoading } = useAuth();
  const navigate = useNavigate();
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const [entityResults, setEntityResults] = useState<GlobalSearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>();
  // AppLayout is withheld while auth loads; the fallback keeps isolated component
  // renders using AuthContext's loading default equivalent to the prior admin tests.
  const role = authRole ?? (authLoading ? 'admin' : null);
  const availablePages = useMemo(() => {
    if (!role) return [];

    const permissionPages = PAGE_PERMISSIONS
      .filter((page) => page.roles.includes(role) && hasPageAccess(role, deniedPages, page.key))
      .map((page) => ({ path: page.path, label: page.label }));
    const isOfficeRole = role === 'admin' || role === 'sales_rep';
    const extraPages = EXTRA_PAGES
      .filter((page) => {
        if (page.allRoles) return true;
        if (page.adminOnly) return role === 'admin';
        // Office deep-links: office role + the linked page's deny-list gate.
        return isOfficeRole && (!page.pageKey || hasPageAccess(role, deniedPages, page.pageKey));
      })
      .map(({ path, label }) => ({ path, label }));

    return [...permissionPages, ...extraPages];
  }, [deniedPages, role]);

  // Reset state when opening
  useEffect(() => {
    if (open) {
      setQuery('');
      setActiveIndex(0);
      setEntityResults([]);
      setLoading(false);
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  // Lock body scroll
  useEffect(() => {
    if (open) {
      document.body.style.overflow = 'hidden';
    } else {
      document.body.style.overflow = '';
    }
    return () => { document.body.style.overflow = ''; };
  }, [open]);

  // Debounced entity search with stale-response guard
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    let cancelled = false;

    if (query.trim().length < 2) {
      setEntityResults([]);
      setLoading(false);
      return;
    }

    setLoading(true);
    debounceRef.current = setTimeout(async () => {
      try {
        const { data, error } = await supabase.rpc('global_search', {
          p_query: query.trim(),
          p_limit: 5,
        });
        if (cancelled) return; // query changed while in-flight
        if (error) throw error;
        const results = assertRpcResult<GlobalSearchResult[]>(data, 'global_search');
        setEntityResults(results);
      } catch {
        if (!cancelled) setEntityResults([]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }, DEBOUNCE_MS);

    return () => {
      cancelled = true;
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [query]);

  // Build combined results
  const results: SearchResult[] = useMemo(() => {
    const items: SearchResult[] = [];
    const trimmed = query.trim();

    if (!trimmed) {
      // Show recent pages when no query
      const recents = getRecentItems().slice(0, 10);
      for (const r of recents) {
        items.push({
          id: `recent-${r.path}`,
          type: 'recent',
          label: r.title,
          path: r.path,
        });
      }
      return items;
    }

    // Pages (client-side fuzzy match, instant)
    const matchingPages = availablePages.filter((p) => fuzzyMatch(trimmed, p.label));
    for (const p of matchingPages.slice(0, 5)) {
      items.push({
        id: `page-${p.path}`,
        type: 'page',
        label: p.label,
        subtitle: 'Page',
        path: p.path,
      });
    }

    // Entity results from RPC
    for (const r of entityResults) {
      items.push({
        id: `${r.entity_type}-${r.id}`,
        type: r.entity_type,
        label: r.primary_text,
        subtitle: r.secondary_text,
        path: ENTITY_PATHS[r.entity_type] + r.id,
      });
    }

    return items.slice(0, 25);
  }, [query, entityResults, availablePages]);

  // Reset active index when results change
  useEffect(() => {
    setActiveIndex(0);
  }, [results.length]);

  // Navigate to selected item
  const selectItem = useCallback(
    (item: SearchResult) => {
      onClose();
      navigate(item.path);
    },
    [navigate, onClose]
  );

  // Keyboard navigation
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      switch (e.key) {
        case 'ArrowDown':
          e.preventDefault();
          setActiveIndex((i) => Math.min(i + 1, results.length - 1));
          break;
        case 'ArrowUp':
          e.preventDefault();
          setActiveIndex((i) => Math.max(i - 1, 0));
          break;
        case 'Enter':
          e.preventDefault();
          if (results[activeIndex]) selectItem(results[activeIndex]);
          break;
        case 'Escape':
          e.preventDefault();
          onClose();
          break;
      }
    },
    [results, activeIndex, selectItem, onClose]
  );

  // Scroll active item into view
  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const active = list.querySelector('[data-active="true"]');
    if (active) {
      active.scrollIntoView?.({ block: 'nearest' });
    }
  }, [activeIndex]);

  if (!open) return null;

  const renderIcon = (item: SearchResult) => {
    if (item.type === 'recent' || item.type === 'page') {
      return getPageIcon(item.path);
    }
    return ENTITY_ICONS[item.type];
  };

  const renderBadge = (item: SearchResult) => {
    if (item.type === 'recent') {
      return (
        <span className="inline-flex items-center gap-1 px-1.5 py-0.5 text-[10px] font-medium rounded bg-gray-100 text-gray-500">
          <Clock className="w-3 h-3" />
          Recent
        </span>
      );
    }
    if (item.type === 'page') {
      return (
        <span className="inline-flex px-1.5 py-0.5 text-[10px] font-medium rounded bg-gray-100 text-gray-500">
          Page
        </span>
      );
    }
    const colors = ENTITY_COLORS[item.type];
    return (
      <span className={`inline-flex px-1.5 py-0.5 text-[10px] font-medium rounded capitalize ${colors}`}>
        {item.type}
      </span>
    );
  };

  return (
    <div className="fixed inset-0 z-[60] flex items-start justify-center pt-[15vh]" role="dialog" aria-modal="true" aria-label="Command palette">
      {/* Backdrop */}
      <div className="fixed inset-0 bg-black/40 backdrop-blur-sm" onClick={onClose} aria-hidden="true" />

      {/* Panel */}
      <div className="relative w-full max-w-lg mx-4 bg-white rounded-xl shadow-2xl border border-gray-200 overflow-hidden animate-in fade-in zoom-in-95">
        {/* Search input */}
        <div className="flex items-center gap-3 px-4 py-3 border-b border-gray-100">
          <Search className="w-5 h-5 text-gray-400 flex-shrink-0" />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Search pages, customers, orders, invoices..."
            className="flex-1 text-sm bg-transparent outline-none placeholder:text-gray-400"
            aria-label="Search"
          />
          <kbd className="hidden sm:inline-flex items-center gap-1 px-1.5 py-0.5 text-[10px] font-medium text-gray-400 bg-gray-100 rounded border border-gray-200">
            ESC
          </kbd>
        </div>

        {/* Results */}
        <div ref={listRef} className="max-h-[50vh] overflow-y-auto" role="listbox">
          {results.length === 0 && !loading && (
            <div className="px-4 py-8 text-center text-sm text-gray-400">
              {query.trim().length > 0 ? 'No results found' : 'Start typing to search...'}
            </div>
          )}

          {loading && results.length === 0 && (
            <div className="px-4 py-8 text-center text-sm text-gray-400">
              Searching...
            </div>
          )}

          {results.map((item, index) => (
            <button
              key={item.id}
              role="option"
              aria-selected={index === activeIndex}
              data-active={index === activeIndex}
              onClick={() => selectItem(item)}
              onMouseEnter={() => setActiveIndex(index)}
              className={`w-full flex items-center gap-3 px-4 py-2.5 text-left transition-colors ${
                index === activeIndex
                  ? 'bg-crx-green/10 text-nav-dark'
                  : 'text-gray-700 hover:bg-gray-50'
              }`}
            >
              <span className={`flex-shrink-0 ${index === activeIndex ? 'text-crx-green' : 'text-gray-400'}`}>
                {renderIcon(item)}
              </span>
              <span className="flex-1 min-w-0">
                <span className="text-sm font-medium truncate block">{item.label}</span>
                {item.subtitle && (
                  <span className="text-xs text-gray-400 truncate block">{item.subtitle}</span>
                )}
              </span>
              {renderBadge(item)}
              {index === activeIndex && (
                <ArrowRight className="w-4 h-4 text-crx-green flex-shrink-0" />
              )}
            </button>
          ))}
        </div>

        {/* Footer hint */}
        <div className="flex items-center gap-4 px-4 py-2 border-t border-gray-100 bg-gray-50/50 text-[10px] text-gray-400">
          <span className="flex items-center gap-1">
            <kbd className="px-1 py-0.5 bg-gray-100 rounded border border-gray-200 font-mono">↑↓</kbd>
            Navigate
          </span>
          <span className="flex items-center gap-1">
            <kbd className="px-1 py-0.5 bg-gray-100 rounded border border-gray-200 font-mono">↵</kbd>
            Open
          </span>
          <span className="flex items-center gap-1">
            <kbd className="px-1 py-0.5 bg-gray-100 rounded border border-gray-200 font-mono">esc</kbd>
            Close
          </span>
        </div>
      </div>
    </div>
  );
}
