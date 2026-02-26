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
 */
export const PAGE_PERMISSIONS: PagePermission[] = [
  // Sales
  { key: 'quotes', label: 'Quotes', category: 'Sales', roles: ['admin', 'sales_rep'] },
  { key: 'orders', label: 'Orders', category: 'Sales', roles: ['admin', 'sales_rep'] },
  { key: 'invoices', label: 'Invoices', category: 'Sales', roles: ['admin', 'sales_rep'] },
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
  { key: 'delivery-remainders', label: 'Remainders', category: 'Operations', roles: ['admin', 'sales_rep'] },
  { key: 'vehicles', label: 'Vehicles', category: 'Operations', roles: ['admin'] },
  { key: 'blend-tickets', label: 'Blend Tickets', category: 'Operations', roles: ['admin', 'sales_rep'] },
  { key: 'application-records', label: 'App Records', category: 'Operations', roles: ['admin', 'sales_rep', 'applicator'] },

  // Inventory
  { key: 'inventory', label: 'Inventory', category: 'Inventory', roles: ['admin', 'sales_rep'] },
  { key: 'cycle-counts', label: 'Cycle Counts', category: 'Inventory', roles: ['admin'] },
  { key: 'purchase-orders', label: 'Supplier POs', category: 'Inventory', roles: ['admin', 'sales_rep'] },
  { key: 'receiving', label: 'Receiving', category: 'Inventory', roles: ['admin', 'sales_rep'] },
  { key: 'returns', label: 'Returns', category: 'Inventory', roles: ['admin', 'sales_rep'] },

  // Finance
  { key: 'ar-aging', label: 'AR Aging', category: 'Finance', roles: ['admin'] },
  { key: 'prepayments', label: 'Prepayments', category: 'Finance', roles: ['admin'] },
  { key: 'commission-payments', label: 'Commission Pay', category: 'Finance', roles: ['admin'] },
  { key: 'customer-transactions', label: 'Transactions', category: 'Finance', roles: ['admin'] },
  { key: 'month-end', label: 'Month-End', category: 'Finance', roles: ['admin'] },
  { key: 'rebates', label: 'Rebates', category: 'Finance', roles: ['admin'] },

  // Reports
  { key: 'reports', label: 'Reports', category: 'Reports', roles: ['admin', 'sales_rep'] },
  { key: 'compliance', label: 'Compliance', category: 'Reports', roles: ['admin', 'sales_rep'] },
];

/**
 * Extract the page key from a route pathname.
 * e.g., '/quotes/new' → 'quotes', '/customers/abc-123' → 'customers'
 * Returns null for non-permissionable paths (dashboard, team-board, etc.)
 */
export function getPageKeyFromPath(pathname: string): string | null {
  // Strip leading slash, take first segment
  const segments = pathname.replace(/^\//, '').split('/');
  const firstSegment = segments[0] || '';

  // Check if it matches a known page key
  const found = PAGE_PERMISSIONS.find((p) => p.key === firstSegment);
  return found ? found.key : null;
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
