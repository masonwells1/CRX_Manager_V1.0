import { NavLink, useLocation } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext';
import { hasPageAccess, getPageKeyFromPath } from '../../lib/pagePermissions';
import type { UserRole } from '../../types';

/**
 * WorkspaceTabs — a role-aware tab bar linking sibling pages that belong to
 * one workflow ("workspace"). Routes are unchanged; each tab is a plain link
 * to an existing page, so deep links, bookmarks, and Cmd/Ctrl+click all work.
 * The bar renders only when the current route belongs to a workspace and the
 * user can access at least two of its tabs.
 */

interface WorkspaceTab {
  path: string;
  label: string;
  roles?: UserRole[];
}

interface Workspace {
  id: string;
  label: string;
  tabs: WorkspaceTab[];
}

const WORKSPACES: Workspace[] = [
  {
    id: 'billing',
    label: 'Billing',
    tabs: [
      { path: '/invoices', label: 'Chemical Invoices', roles: ['admin', 'sales_rep'] },
      { path: '/field-invoices', label: 'Field Invoices', roles: ['admin', 'sales_rep'] },
      { path: '/payments', label: 'Record Payments', roles: ['admin', 'sales_rep'] },
      { path: '/accounts-receivable', label: 'A/R Workspace', roles: ['admin'] },
    ],
  },
  {
    id: 'products',
    label: 'Products',
    tabs: [
      { path: '/products', label: 'Products', roles: ['admin', 'sales_rep'] },
      { path: '/supplier-pricing', label: 'Supplier Pricing', roles: ['admin'] },
      { path: '/brand-vs-generic', label: 'Brand vs Generic', roles: ['admin', 'sales_rep'] },
    ],
  },
  {
    id: 'insights',
    label: 'Insights',
    tabs: [
      { path: '/dashboard', label: 'Overview', roles: ['admin', 'sales_rep'] },
      { path: '/reports', label: 'Reports Library', roles: ['admin', 'sales_rep'] },
      { path: '/sales-reports', label: 'Sales Reports', roles: ['admin', 'sales_rep'] },
      { path: '/field-profitability', label: 'Field Profitability', roles: ['admin', 'sales_rep'] },
      { path: '/financial-dashboard', label: 'Financial Dashboard', roles: ['admin'] },
    ],
  },
];

export default function WorkspaceTabs() {
  const { role, deniedPages } = useAuth();
  const location = useLocation();

  const basePath = '/' + (location.pathname.split('/')[1] || '');
  const workspace = WORKSPACES.find((w) => w.tabs.some((t) => t.path === basePath));
  if (!workspace) return null;

  const visibleTabs = workspace.tabs.filter((tab) => {
    if (tab.roles && (!role || !tab.roles.includes(role))) return false;
    const pageKey = getPageKeyFromPath(tab.path);
    if (pageKey && role) return hasPageAccess(role, deniedPages, pageKey);
    return true;
  });
  if (visibleTabs.length < 2) return null;

  return (
    <nav
      aria-label={`${workspace.label} workspace pages`}
      className="bg-cream border-b border-cream-dark"
    >
      <div className="flex gap-1.5 overflow-x-auto px-4 lg:px-6 py-2">
        {visibleTabs.map((tab) => (
          <NavLink
            key={tab.path}
            to={tab.path}
            className={({ isActive }) =>
              `flex items-center whitespace-nowrap rounded-full px-3.5 min-h-11 md:min-h-9 text-sm font-medium transition-colors touch-manipulation focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-crx-green ${
                isActive
                  ? 'bg-crx-green text-white'
                  : 'text-secondary hover:bg-cream-dark hover:text-gray-900'
              }`
            }
          >
            {tab.label}
          </NavLink>
        ))}
      </div>
    </nav>
  );
}
