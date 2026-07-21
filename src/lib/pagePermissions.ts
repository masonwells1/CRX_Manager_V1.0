import type { UserRole } from '../types';

export interface PagePermission {
  key: string;
  path: string;
  label: string;
  category: string;
  roles: UserRole[];
}

/**
 * Canonical list of all permissionable pages. Every protected route in
 * App.tsx MUST have an entry here, otherwise the deny-list
 * (`profile.denied_pages`) silently does nothing for that route.
 * `pagePermissions.test.ts` enforces this — adding a Route without an entry
 * fails CI.
 */
export const PAGE_PERMISSIONS: PagePermission[] = [
  // Sell & Deliver
  { key: 'quotes', path: '/quotes', label: 'Quotes & Bookings', category: 'Sell & Deliver', roles: ['admin', 'sales_rep'] },
  { key: 'orders', path: '/orders', label: 'Orders', category: 'Sell & Deliver', roles: ['admin', 'sales_rep'] },
  { key: 'deliveries', path: '/deliveries', label: 'Deliveries', category: 'Sell & Deliver', roles: ['admin', 'sales_rep', 'driver'] },
  { key: 'my-route', path: '/my-route', label: 'My Route', category: 'Sell & Deliver', roles: ['admin', 'sales_rep', 'driver'] },
  { key: 'delivery-remainders', path: '/delivery-remainders', label: 'Remainders', category: 'Sell & Deliver', roles: ['admin', 'sales_rep'] },
  { key: 'invoices', path: '/invoices', label: 'Invoices — Chemical', category: 'Sell & Deliver', roles: ['admin', 'sales_rep'] },
  { key: 'returns', path: '/returns', label: 'Returns', category: 'Sell & Deliver', roles: ['admin', 'sales_rep'] },
  { key: 'to-ship', path: '/to-ship', label: 'To-Ship (Load-Out Board)', category: 'Sell & Deliver', roles: ['admin', 'sales_rep'] },

  // Spray Fields
  { key: 'jobs', path: '/jobs', label: 'Job Schedule', category: 'Spray Fields', roles: ['admin', 'sales_rep', 'applicator'] },
  { key: 'dispatch', path: '/dispatch', label: 'Dispatch Board', category: 'Spray Fields', roles: ['admin', 'sales_rep', 'applicator'] },
  { key: 'field-invoices', path: '/field-invoices', label: 'Field Invoices', category: 'Spray Fields', roles: ['admin', 'sales_rep'] },
  { key: 'application-records', path: '/application-records', label: 'Record Book (Applications)', category: 'Spray Fields', roles: ['admin', 'sales_rep', 'applicator'] },
  { key: 'program-tracker', path: '/program-tracker', label: 'Program Tracker', category: 'Spray Fields', roles: ['admin', 'sales_rep'] },
  { key: 'recipes', path: '/recipes', label: 'Blend Recipes', category: 'Spray Fields', roles: ['admin', 'sales_rep'] },
  { key: 'field', path: '/field', label: 'Field View (phone preview)', category: 'Spray Fields', roles: ['admin', 'sales_rep', 'applicator'] },

  // Customers & Fields
  { key: 'customers', path: '/customers', label: 'Customers', category: 'Customers & Fields', roles: ['admin', 'sales_rep'] },
  { key: 'call-lists', path: '/call-lists', label: 'Call Lists', category: 'Customers & Fields', roles: ['admin', 'sales_rep'] },
  { key: 'fields', path: '/fields', label: 'Fields & Maps', category: 'Customers & Fields', roles: ['admin', 'sales_rep'] },
  { key: 'crop-programs', path: '/crop-programs', label: 'Crop Programs', category: 'Customers & Fields', roles: ['admin', 'sales_rep'] },

  // Inventory & Buying
  { key: 'inventory', path: '/inventory', label: 'Inventory', category: 'Inventory & Buying', roles: ['admin', 'sales_rep'] },
  { key: 'products', path: '/products', label: 'Products', category: 'Inventory & Buying', roles: ['admin', 'sales_rep'] },
  { key: 'supplier-pricing', path: '/supplier-pricing', label: 'Supplier Pricing', category: 'Inventory & Buying', roles: ['admin'] },
  { key: 'brand-vs-generic', path: '/brand-vs-generic', label: 'Brand vs Generic', category: 'Inventory & Buying', roles: ['admin', 'sales_rep'] },
  { key: 'purchase-orders', path: '/purchase-orders', label: 'Purchase Orders', category: 'Inventory & Buying', roles: ['admin', 'sales_rep'] },
  { key: 'receiving', path: '/receiving', label: 'Receiving', category: 'Inventory & Buying', roles: ['admin', 'sales_rep'] },
  { key: 'cycle-counts', path: '/cycle-counts', label: 'Cycle Counts', category: 'Inventory & Buying', roles: ['admin'] },

  // Money
  { key: 'payments', path: '/payments', label: 'Record Payments', category: 'Money', roles: ['admin', 'sales_rep'] },
  { key: 'accounts-receivable', path: '/accounts-receivable', label: 'A/R Workspace', category: 'Money', roles: ['admin'] },
  { key: 'ar-aging', path: '/ar-aging', label: 'A/R Aging', category: 'Money', roles: ['admin'] },
  { key: 'prepay', path: '/prepay', label: 'Prepay', category: 'Money', roles: ['admin'] },
  { key: 'customer-transactions', path: '/customer-transactions', label: 'Customer Transactions', category: 'Money', roles: ['admin'] },
  { key: 'accounts-payable', path: '/accounts-payable', label: 'A/P & Vendor Bills', category: 'Money', roles: ['admin'] },
  { key: 'commission-payments', path: '/commission-payments', label: 'Commissions', category: 'Money', roles: ['admin'] },
  { key: 'rebates', path: '/rebates', label: 'Rebates', category: 'Money', roles: ['admin'] },
  { key: 'month-end', path: '/month-end', label: 'Month-End Close', category: 'Money', roles: ['admin'] },
  { key: 'integrity', path: '/integrity', label: 'Data Integrity', category: 'Money', roles: ['admin'] },
  { key: 'payment-history', path: '/payment-history', label: 'Payment History', category: 'Money', roles: ['admin'] },

  // Compliance & Records
  { key: 'compliance', path: '/compliance', label: 'Licenses & RUP Register', category: 'Compliance & Records', roles: ['admin', 'sales_rep'] },
  { key: 'lot-trace', path: '/lot-trace', label: 'Lot Trace (recall lookup)', category: 'Compliance & Records', roles: ['admin', 'sales_rep'] },
  { key: 'watchdog', path: '/watchdog', label: 'Watchdog Flags', category: 'Compliance & Records', roles: ['admin', 'sales_rep'] },
  { key: 'offline-work-review', path: '/offline-work-review', label: 'Offline Work Review', category: 'Compliance & Records', roles: ['admin', 'sales_rep'] },
  { key: 'label-review', path: '/label-review', label: 'Label Review', category: 'Compliance & Records', roles: ['admin'] },
  { key: 'label-data-quality', path: '/label-data-quality', label: 'Label Data Quality', category: 'Compliance & Records', roles: ['admin'] },
  { key: 'blend-tickets', path: '/blend-tickets', label: 'Blend Tickets (OCR)', category: 'Compliance & Records', roles: ['admin', 'sales_rep'] },

  // Insights
  { key: 'dashboard', path: '/dashboard', label: 'Overview (KPI Dashboard)', category: 'Insights', roles: ['admin', 'sales_rep'] },
  { key: 'office-cockpit', path: '/office-cockpit', label: 'Today', category: 'Insights', roles: ['admin', 'sales_rep'] },
  { key: 'reports', path: '/reports', label: 'Reports Library', category: 'Insights', roles: ['admin', 'sales_rep'] },
  { key: 'sales-reports', path: '/sales-reports', label: 'Sales Reports', category: 'Insights', roles: ['admin', 'sales_rep'] },
  { key: 'financial-dashboard', path: '/financial-dashboard', label: 'Financial Dashboard', category: 'Insights', roles: ['admin'] },

  // Setup & Admin
  { key: 'vehicles', path: '/vehicles', label: 'Vehicles', category: 'Setup & Admin', roles: ['admin'] },
  { key: 'application-services', path: '/application-services', label: 'Application Services (fees)', category: 'Setup & Admin', roles: ['admin'] },
  { key: 'vendors', path: '/vendors', label: 'Vendors', category: 'Setup & Admin', roles: ['admin'] },
  { key: 'getting-started', path: '/getting-started', label: 'Getting Started (help)', category: 'Setup & Admin', roles: ['admin', 'sales_rep', 'driver', 'applicator'] },
];

/**
 * Page-key first-segments that intentionally have no PAGE_PERMISSIONS entry.
 * These are auth/utility routes that exist for every authenticated user
 * (or have their own role gating). ProtectedRoute treats null `pageKey` as
 * a routing bug UNLESS the segment is in this set.
 *
 * `pagePermissions.test.ts` validates the App.tsx → PAGE_PERMISSIONS coverage
 * against the same exempt list.
 */
export const EXEMPT_ROUTE_SEGMENTS: ReadonlySet<string> = new Set([
  'login',
  'forgot-password',
  'reset-password',
  'settings',
  'team-board',
  'notifications',
]);

/**
 * Extract the page key from a route pathname.
 * e.g., '/quotes/new' → 'quotes', '/customers/abc-123' → 'customers'
 * Returns null for non-permissionable paths (team-board, settings, etc.)
 */
export function getPageKeyFromPath(pathname: string): string | null {
  const segments = pathname.replace(/^\//, '').split('/');
  const firstSegment = segments[0] || '';

  // The field-application invoice editor is mounted under /invoices/field-app/*
  // for route-reuse, but it belongs to the SEPARATE Field Invoices area.
  if (firstSegment === 'invoices' && segments[1] === 'field-app') {
    return 'field-invoices';
  }

  // Legacy standalone routes redirect into consolidated tabbed pages and
  // therefore share each destination's single permission/deny-list key.
  const legacyPageKey: Record<string, string> = {
    'receiving-hub': 'receiving',
    prepayments: 'prepay',
    'prepay-workspace': 'prepay',
    'integrity-report': 'integrity',
    'integrity-cleanup': 'integrity',
  };
  if (legacyPageKey[firstSegment]) return legacyPageKey[firstSegment];

  const found = PAGE_PERMISSIONS.find((p) => p.key === firstSegment);
  return found ? found.key : null;
}

/**
 * Returns true when a path's first segment is intentionally exempt from
 * PAGE_PERMISSIONS coverage (e.g. /settings, /login, /team-board).
 * The root path ('/' or '') is also exempt — it is the role landing redirect.
 */
export function isExemptRoute(pathname: string): boolean {
  const firstSegment = pathname.replace(/^\//, '').split('/')[0] || '';
  if (firstSegment === '') return true;
  return EXEMPT_ROUTE_SEGMENTS.has(firstSegment);
}

/**
 * Check if a user has access to a specific page.
 * 1. Admins always have access
 * 2. Role must be in the page's allowed roles
 * 3. Page must not be in the user's denied_pages list
 */
export function hasPageAccess(
  role: UserRole | null,
  deniedPages: string[],
  pageKey: string
): boolean {
  if (!role) return false;
  if (role === 'admin') return true;

  const page = PAGE_PERMISSIONS.find((p) => p.key === pageKey);
  if (!page) return false;

  if (!page.roles.includes(role)) return false;
  // Preserve profile restrictions saved under route keys that existed before
  // these standalone pages were consolidated.
  if (pageKey === 'receiving' && deniedPages.includes('receiving-hub')) return false;
  if (pageKey === 'prepay' && deniedPages.some((key) => key === 'prepayments' || key === 'prepay-workspace')) return false;
  if (pageKey === 'integrity' && deniedPages.some((key) => key === 'integrity-report' || key === 'integrity-cleanup')) return false;
  if (deniedPages.includes(pageKey)) return false;
  return true;
}

/** Get all pages accessible by a given role (before deny-list filtering). */
export function getPagesForRole(role: UserRole): PagePermission[] {
  if (role === 'admin') return PAGE_PERMISSIONS;
  return PAGE_PERMISSIONS.filter((p) => p.roles.includes(role));
}

/** Get unique categories from a list of pages, preserving order. */
export function getCategories(pages: PagePermission[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const p of pages) {
    if (!seen.has(p.category)) {
      seen.add(p.category);
      result.push(p.category);
    }
  }
  return result;
}
