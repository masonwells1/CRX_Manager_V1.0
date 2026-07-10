import { useLocation } from 'react-router-dom';

const pageMeta: Record<string, { title: string; accent: string }> = {
  '/': { title: 'Operational', accent: 'Dashboard' },
  '/dashboard': { title: 'Operational', accent: 'Dashboard' },
  '/products': { title: 'Product', accent: 'Master' },
  '/customers': { title: 'Customer', accent: 'Database' },
  '/quotes': { title: 'Quote', accent: 'Builder' },
  '/orders': { title: 'Order', accent: 'Management' },
  '/inventory': { title: 'Inventory', accent: 'Management' },
  '/invoices': { title: 'Invoice', accent: 'Management' },
  '/deliveries': { title: 'Delivery', accent: 'Management' },
  '/jobs': { title: 'Job', accent: 'Management' },
  '/field': { title: 'My Field', accent: 'Jobs' },
  '/fields': { title: 'Field', accent: 'Management' },
  '/purchase-orders': { title: 'Supplier', accent: 'Purchase Orders' },
  '/receiving': { title: 'Receiving', accent: 'Log' },
  '/returns': { title: 'Returns', accent: '& RMA' },
  '/blend-tickets': { title: 'Blend', accent: 'Tickets' },
  '/recipes': { title: 'Blend', accent: 'Recipes' },
  '/cycle-counts': { title: 'Cycle', accent: 'Counts' },
  '/vehicles': { title: 'Vehicle', accent: 'Fleet' },
  '/compliance': { title: 'Compliance', accent: 'Dashboard' },
  '/ar-aging': { title: 'AR Aging', accent: '& Statements' },
  '/rebates': { title: 'Manufacturer', accent: 'Rebates' },
  '/application-records': { title: 'Application', accent: 'Records' },
  '/lot-trace': { title: 'Lot', accent: 'Trace' },
  '/label-review': { title: 'Label', accent: 'Review' },
  '/delivery-remainders': { title: 'Delivery', accent: 'Remainders' },
  '/brand-vs-generic': { title: 'Brand vs', accent: 'Generic' },
  '/reports': { title: 'Reports', accent: 'Dashboard' },
  '/crop-programs': { title: 'Crop', accent: 'Programs' },
  '/payments': { title: 'Payment', accent: 'Entry' },
  '/month-end': { title: 'Month-End', accent: 'Close' },
  '/commission-payments': { title: 'Commission', accent: 'Payments' },
  '/customer-transactions': { title: 'Transaction', accent: 'Review' },
  '/prepayments': { title: 'Prepayment', accent: 'Manager' },
  '/team-board': { title: 'Team', accent: 'Board' },
  '/notifications': { title: 'Notifications', accent: '' },
  '/settings': { title: 'App', accent: 'Settings' },
  '/accounts-payable': { title: 'Accounts', accent: 'Payable' },
  '/payment-history': { title: 'Payment', accent: 'History' },
  '/sales-reports': { title: 'Sales', accent: 'Reports' },
  '/financial-dashboard': { title: 'Financial', accent: 'Dashboard' },
  '/activity-feed': { title: 'Activity', accent: 'Feed' },
};

export function usePageMeta() {
  const location = useLocation();
  const basePath = '/' + (location.pathname.split('/')[1] || '');
  return pageMeta[basePath] || { title: 'Crop RX', accent: 'Solutions' };
}
