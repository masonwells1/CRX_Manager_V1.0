import { useLocation } from 'react-router-dom';

const pageMeta: Record<string, { title: string; accent: string }> = {
  '/': { title: 'Dashboard', accent: 'Overview' },
  '/products': { title: 'Product', accent: 'Master' },
  '/customers': { title: 'Customer', accent: 'Database' },
  '/quotes': { title: 'Quote', accent: 'Builder' },
  '/orders': { title: 'Order', accent: 'Management' },
  '/inventory': { title: 'Inventory', accent: 'Management' },
  '/deliveries': { title: 'Delivery', accent: 'Management' },
  '/purchase-orders': { title: 'Supplier', accent: 'Purchase Orders' },
  '/brand-vs-generic': { title: 'Brand vs', accent: 'Generic' },
  '/reports': { title: 'Reports', accent: 'Dashboard' },
  '/team-board': { title: 'Team', accent: 'Board' },
  '/notifications': { title: 'Notifications', accent: '' },
  '/settings': { title: 'App', accent: 'Settings' },
};

export function usePageMeta() {
  const location = useLocation();
  const basePath = '/' + (location.pathname.split('/')[1] || '');
  return pageMeta[basePath] || { title: 'Crop RX', accent: 'Solutions' };
}
