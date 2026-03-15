import { Link } from 'react-router-dom';
import { Truck, ShoppingCart, Users, Briefcase, Package, FileText } from 'lucide-react';
import type { LinkedEntityType } from '../../types';

interface EntityBadgeProps {
  entityType: LinkedEntityType;
  entityId: string;
  label?: string;
}

const entityConfig: Record<LinkedEntityType, {
  route: (id: string) => string;
  icon: typeof Truck;
  bg: string;
  text: string;
  displayName: string;
}> = {
  delivery: {
    route: (id) => `/deliveries/${id}`,
    icon: Truck,
    bg: 'bg-blue-100',
    text: 'text-blue-700',
    displayName: 'Delivery',
  },
  order: {
    route: (id) => `/orders/${id}`,
    icon: ShoppingCart,
    bg: 'bg-green-100',
    text: 'text-green-700',
    displayName: 'Order',
  },
  customer: {
    route: (id) => `/customers/${id}`,
    icon: Users,
    bg: 'bg-purple-100',
    text: 'text-purple-700',
    displayName: 'Customer',
  },
  job: {
    route: (id) => `/jobs/${id}`,
    icon: Briefcase,
    bg: 'bg-amber-100',
    text: 'text-amber-700',
    displayName: 'Job',
  },
  purchase_order: {
    route: (id) => `/purchase-orders/${id}`,
    icon: Package,
    bg: 'bg-teal-100',
    text: 'text-teal-700',
    displayName: 'Purchase Order',
  },
  quote: {
    route: (id) => `/quotes/${id}`,
    icon: FileText,
    bg: 'bg-indigo-100',
    text: 'text-indigo-700',
    displayName: 'Quote',
  },
};

export default function EntityBadge({ entityType, entityId, label }: EntityBadgeProps) {
  const config = entityConfig[entityType];
  const Icon = config.icon;

  return (
    <Link
      to={config.route(entityId)}
      onClick={(e) => e.stopPropagation()}
      className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium ${config.bg} ${config.text} hover:opacity-80 transition-opacity`}
    >
      <Icon className="w-3 h-3 shrink-0" />
      <span className="truncate max-w-[10rem]">{label || config.displayName}</span>
    </Link>
  );
}
