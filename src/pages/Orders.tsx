import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import Card from '../components/ui/Card';
import DataTable, { type Column } from '../components/ui/DataTable';
import Badge, { statusToBadgeVariant } from '../components/ui/Badge';
import { supabase } from '../lib/db';
import type { Order } from '../types';

interface OrderWithFulfillment extends Order {
  fulfillment_pct: number;
}

export default function Orders() {
  const navigate = useNavigate();
  const [orders, setOrders] = useState<OrderWithFulfillment[]>([]);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState('');

  useEffect(() => {
    fetchOrders();
  }, []);

  const fetchOrders = async () => {
    const { data: ordersData } = await supabase
      .from('orders')
      .select('*, customer:customers(farm_name)')
      .order('order_date', { ascending: false });

    const { data: itemsData } = await supabase
      .from('order_items')
      .select('order_id, total_units_needed, quantity_delivered');

    const itemsByOrder: Record<string, { needed: number; delivered: number }> = {};
    (itemsData || []).forEach((item) => {
      if (!itemsByOrder[item.order_id]) {
        itemsByOrder[item.order_id] = { needed: 0, delivered: 0 };
      }
      itemsByOrder[item.order_id].needed += item.total_units_needed || 0;
      itemsByOrder[item.order_id].delivered += item.quantity_delivered || 0;
    });

    const enriched = ((ordersData || []) as Order[]).map((o) => {
      const counts = itemsByOrder[o.id] || { needed: 0, delivered: 0 };
      const pct = counts.needed > 0 ? Math.round((counts.delivered / counts.needed) * 100) : 0;
      return { ...o, fulfillment_pct: pct };
    });

    setOrders(enriched);
    setLoading(false);
  };

  const filtered = orders.filter((o) => {
    if (statusFilter && o.status !== statusFilter) return false;
    return true;
  });

  const fmt = (n: number) =>
    new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(n);

  const columns: Column<OrderWithFulfillment>[] = [
    {
      key: 'order_number',
      header: 'Order #',
      sortable: true,
      render: (row) => <span className="font-medium text-nav-dark">{row.order_number}</span>,
    },
    {
      key: 'customer',
      header: 'Customer',
      render: (row) => (row.customer as unknown as { farm_name: string })?.farm_name || '-',
    },
    {
      key: 'status',
      header: 'Status',
      sortable: true,
      render: (row) => (
        <Badge variant={statusToBadgeVariant[row.status] || 'default'}>
          {row.status.replace('_', ' ')}
        </Badge>
      ),
    },
    {
      key: 'total_price',
      header: 'Total',
      sortable: true,
      render: (row) => <span className="font-mono text-sm">{fmt(row.total_price)}</span>,
    },
    {
      key: 'order_date',
      header: 'Order Date',
      sortable: true,
      render: (row) => new Date(row.order_date).toLocaleDateString(),
    },
    {
      key: 'fulfillment_pct',
      header: 'Fulfillment',
      sortable: true,
      render: (row) => (
        <div className="flex items-center gap-2">
          <div className="w-20 h-2 bg-gray-100 rounded-full overflow-hidden">
            <div
              className="h-full bg-crx-green rounded-full transition-all"
              style={{ width: `${row.fulfillment_pct}%` }}
            />
          </div>
          <span className="text-xs text-secondary">{row.fulfillment_pct}%</span>
        </div>
      ),
    },
  ];

  return (
    <div className="space-y-4">
      <Card padding={false}>
        <div className="p-5">
          <DataTable
            data={filtered as unknown as Record<string, unknown>[]}
            columns={columns as unknown as Column<Record<string, unknown>>[]}
            searchable
            searchPlaceholder="Search orders..."
            searchKeys={['order_number']}
            onRowClick={(row) => navigate(`/orders/${(row as unknown as OrderWithFulfillment).id}`)}
            emptyTitle="No orders yet"
            emptyDescription="Orders are created from accepted quotes"
            loading={loading}
            filters={
              <select
                value={statusFilter}
                onChange={(e) => setStatusFilter(e.target.value)}
                className="px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green"
              >
                <option value="">All Statuses</option>
                <option value="confirmed">Confirmed</option>
                <option value="partially_fulfilled">Partially Fulfilled</option>
                <option value="fulfilled">Fulfilled</option>
                <option value="cancelled">Cancelled</option>
              </select>
            }
          />
        </div>
      </Card>
    </div>
  );
}
