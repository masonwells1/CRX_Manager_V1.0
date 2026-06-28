import type { UserRole } from '../types';

export interface PagePermission {
  key: string;
  label: string;
  category: string;
  roles: UserRole[];
}

/**
 * Canonical list of all permissionable pages.
 * Dashboard, Team Board, Notifications, and Settings are excluded
 * (always accessible per existing role rules).
 *
 * Every protected route in App.tsx MUST have an entry here, otherwise the
 * deny-list (`profile.denied_pages`) silently does nothing for that route.
 * `pagePermissions.test.ts` enforces this — adding a Route without an entry
 * fails CI.
 */
export const PAGE_PERMISSIONS: PagePermission[] = [
  // Onboarding
  { key: 'getting-started', label: 'Getting Started', category: 'Onboarding', roles: ['admin', 'sales_rep', 'driver', 'applicator'] },

  // Sales
  { key: 'quotes', label: 'Quotes', category: 'Sales', roles: ['admin', 'sales_rep'] },
  { key: 'orders', label: 'Orders', category: 'Sales', roles: ['admin', 'sales_rep'] },
  { key: 'invoices', label: 'Invoices', category: 'Sales', roles: ['admin', 'sales_rep'] },
  { key: 'field-invoices', label: 'Field Invoices', category: 'Sales', roles: ['admin', 'sales_rep'] },
  { key: 'payments', label: 'Payments', category: 'Sales', roles: ['admin', 'sales_rep'] },

  // Customers
  { key: 'customers', label: 'Customers', category: 'Customers', roles: ['admin', 'sales_rep'] },
  { key: 'fields', label: 'Fields', category: 'Customers', roles: ['admin', 'sales_rep'] },
  { key: 'crop-programs', label: 'Crop Programs', category: 'Customers', roles: ['admin', 'sales_rep'] },

  // Products
  { key: 'products', label: 'Products', category: 'Products', roles: ['admin', 'sales_rep'] },
  { key: 'brand-vs-generic', label: 'Brand vs Generic', category: 'Products', roles: ['admin', 'sales_rep'] },
  { key: 'recipes', label: 'Blend Recipes', category: 'Products', roles: ['admin', 'sales_rep'] },

  // Operations
  { key: 'jobs', label: 'Job Schedule', category: 'Operations', roles: ['admin', 'sales_rep', 'applicator'] },
  { key: 'deliveries', label: 'Deliveries', category: 'Operations', roles: ['admin', 'sales_rep', 'driver'] },
  { key: 'my-route', label: 'My Route', category: 'Operations', roles: ['admin', 'sales_rep', 'driver'] },
  { key: 'delivery-remainders', label: 'Remainders', category: 'Operations', roles: ['admin', 'sales_rep'] },
  { key: 'to-ship', label: 'To-Ship', category: 'Operations', roles: ['admin', 'sales_rep'] },
  { key: 'vehicles', label: 'Vehicles', category: 'Operations', roles: ['admin'] },
  { key: 'blend-tickets', label: 'Blend Tickets', category: 'Operations', roles: ['admin', 'sales_rep'] },
  { key: 'application-records', label: 'App Records', category: 'Operations', roles: ['admin', 'sales_rep', 'applicator'] },
  { key: 'application-services', label: 'Application Services', category: 'Operations', roles: ['admin'] },
  { key: 'dispatch', label: 'Dispatch', category: 'Operations', roles: ['admin', 'sales_rep', 'applicator'] },
  { key: 'field', label: 'My Field Jobs', category: 'Operations', roles: ['admin', 'sales_rep', 'applicator'] },
  { key: 'program-tracker', label: 'Program Tracker', category: 'Operations', roles: ['admin', 'sales_rep'] },

  // Inventory
  { key: 'inventory', label: 'Inventory', category: 'Inventory', roles: ['admin', 'sales_rep'] },
  { key: 'cycle-counts', label: 'Cycle Counts', category: 'Inventory', roles: ['admin'] },
  { key: 'purchase-orders', label: 'Supplier POs', category: 'Inventory', roles: ['admin', 'sales_rep'] },
  { key: 'receiving', label: 'Receiving', category: 'Inventory', roles: ['admin', 'sales_rep'] },
  { key: 'receiving-hub', label: 'Receiving Hub', category: 'Inventory', roles: ['admin', 'sales_rep'] },
  { key: 'returns', label: 'Returns', category: 'Inventory', roles: ['admin', 'sales_rep'] },

  // Finance
  { key: 'accounts-receivable', label: 'Accounts Receivable', category: 'Finance', roles: ['admin'] },
  { key: 'ar-aging', label: 'AR Aging', category: 'Finance', roles: ['admin'] },
  { key: 'accounts-payable', label: 'Accounts Payable', category: 'Finance', roles: ['admin'] },
  { key: 'vendors', label: 'Vendors', category: 'Finance', roles: ['admin'] },
  { key: 'prepayments', label: 'Prepayments', category: 'Finance', roles: ['admin'] },
  { key: 'prepay-workspace', label: 'Prepay Workspace', category: 'Finance', roles: ['admin'] },
  { key: 'commission-payments', label: 'Commission Pay', category: 'Finance', roles: ['admin'] },
  { key: 'customer-transactions', label: 'Transactions', category: 'Finance', roles: ['admin'] },
  { key: 'month-end', label: 'Month-End', category: 'Finance', roles: ['admin'] },
  { key: 'integrity-report', label: 'Integrity Report', category: 'Finance', roles: ['admin'] },
  { key: 'integrity-cleanup', label: 'Integrity Cleanup', category: 'Finance', roles: ['admin'] },
  { key: 'rebates', label: 'Rebates', category: 'Finance', roles: ['admin'] },
  { key: 'payment-history', label: 'Payment History', category: 'Finance', roles: ['admin'] },
  { key: 'financial-dashboard', label: 'Financial Dashboard', category: 'Finance', roles: ['admin'] },

  // Reports
  { key: 'reports', label: 'Reports', category: 'Reports', roles: ['admin', 'sales_rep'] },
  { key: 'sales-reports', label: 'Sales Reports', category: 'Reports', roles: ['admin', 'sales_rep'] },
  { key: 'compliance', label: 'Compliance', category: 'Reports', roles: ['admin', 'sales_rep'] },
  { key: 'lot-trace', label: 'Lot Trace', category: 'Reports', roles: ['admin', 'sales_rep'] },
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
  'dashboard',
  'settings',
  'team-board',
  'notifications',
]);

/**
 * Extract the page key from a route pathname.
 * e.g., '/quotes/new' → 'quotes', '/customers/abc-123' → 'customers'
 * Returns null for non-permissionable paths (dashboard, team-board, etc.)
 */
export function getPageKeyFromPath(pathname: string): string | null {
  // Strip leading slash, take first segment
  const segments = pathname.replace(/^\//, '').split('/');
  const firstSegment = segments[0] || '';

  // The field-application invoice editor is mounted under /invoices/field-app/*
  // for route-reuse, but it belongs to the SEPARATE Field Invoices area. Gate it
  // by the 'field-invoices' permission, not Chemical Sales 'invoices', so a user
  // granted Field Invoices (but denied Invoices) can still open/edit/post a field
  // invoice — and vice-versa. (Segregation requirement; Codex Phase-1a R2.)
  if (firstSegment === 'invoices' && segments[1] === 'field-app') {
    return 'field-invoices';
  }

  // Check if it matches a known page key
  const found = PAGE_PERMISSIONS.find((p) => p.key === firstSegment);
  return found ? found.key : null;
}

/**
 * Returns true when a path's first segment is intentionally exempt from
 * PAGE_PERMISSIONS coverage (e.g. /settings, /login, /team-board).
 * The root path ('/' or '') is also exempt — it's the dashboard.
 */
export function isExemptRoute(pathname: string): boolean {
  const firstSegment = pathname.replace(/^\//, '').split('/')[0] || '';
  if (firstSegment === '') return true; // root → dashboard, no permission needed
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

  // Admins are never restricted
  if (role === 'admin') return true;

  // Find the page definition
  const page = PAGE_PERMISSIONS.find((p) => p.key === pageKey);
  if (!page) return false; // Unknown page key — deny by default (fail-closed)

  // Role must be allowed
  if (!page.roles.includes(role)) return false;

  // Check deny list
  if (deniedPages.includes(pageKey)) return false;

  return true;
}

/**
 * Get all pages accessible by a given role (before deny-list filtering).
 */
export function getPagesForRole(role: UserRole): PagePermission[] {
  if (role === 'admin') return PAGE_PERMISSIONS;
  return PAGE_PERMISSIONS.filter((p) => p.roles.includes(role));
}

/**
 * Get unique categories from a list of pages, preserving order.
 */
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
