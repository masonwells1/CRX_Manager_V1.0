/**
 * DeliveryRemainders — Shows all pending delivery remainder items across all customers.
 * Allows creating follow-up deliveries from grouped remainders.
 */
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { AlertTriangle, Truck, Package } from 'lucide-react';
import Card, { CardHeader } from '../components/ui/Card';
import Button from '../components/ui/Button';
import Badge from '../components/ui/Badge';
import DataTable, { type Column } from '../components/ui/DataTable';
import { useToast } from '../components/ui/Toast';
import { useAuth } from '../contexts/AuthContext';
import { supabase, assertRpcResult } from '../lib/db';
import { generateIdempotencyKey } from '../lib/idempotency';

interface RemainderRow {
  id: string;
  original_delivery_id: string;
  order_id: string | null;
  order_item_id: string | null;
  customer_id: string;
  product_id: string;
  quantity_remaining: number;
  unit_size: string | null;
  status: string;
  followup_delivery_id: string | null;
  notes: string | null;
  created_at: string;
  // Joined
  customer_name: string;
  product_name: string;
  original_delivery_number: string;
  order_number: string | null;
}

export default function DeliveryRemainders() {
  const navigate = useNavigate();
  const { toast } = useToast();
  const { profile } = useAuth();
  const [remainders, setRemainders] = useState<RemainderRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState('pending');
  const [customerFilter, setCustomerFilter] = useState('');
  const [creating, setCreating] = useState<string | null>(null);

  useEffect(() => {
    fetchRemainders();
  }, []);

  const fetchRemainders = async () => {
    const { data, error } = await supabase
      .from('delivery_remainders')
      .select(`
        *,
        customer:customers!delivery_remainders_customer_id_fkey(farm_name),
        product:products!delivery_remainders_product_id_fkey(product_name),
        original_delivery:deliveries!delivery_remainders_original_delivery_id_fkey(delivery_number),
        order:orders!delivery_remainders_order_id_fkey(order_number)
      `)
      .order('created_at', { ascending: false })
      .limit(500);

    if (error) {
      console.error('Failed to load remainders:', error.message);
      toast('error', 'Failed to load delivery remainders');
      setLoading(false);
      return;
    }

    const rows = ((data || []) as any[]).map((r) => ({
      ...r,
      customer_name: r.customer?.farm_name || 'Unknown',
      product_name: r.product?.product_name || 'Unknown',
      original_delivery_number: r.original_delivery?.delivery_number || '-',
      order_number: r.order?.order_number || null,
    }));

    setRemainders(rows);
    setLoading(false);
  };

  const filtered = remainders.filter((r) => {
    if (statusFilter && r.status !== statusFilter) return false;
    if (customerFilter && r.customer_id !== customerFilter) return false;
    return true;
  });

  // Group by customer for follow-up creation
  const uniqueCustomers = [...new Map(remainders.map((r) => [r.customer_id, r.customer_name])).entries()]
    .sort((a, b) => a[1].localeCompare(b[1]));

  // Summary stats
  const pendingCount = remainders.filter((r) => r.status === 'pending').length;
  const customerCount = new Set(remainders.filter((r) => r.status === 'pending').map((r) => r.customer_id)).size;

  const handleCreateFollowup = async (deliveryId: string) => {
    setCreating(deliveryId);
    try {
      const followupKey = generateIdempotencyKey('create_followup_delivery', profile?.id || '');
      const { data, error } = await supabase.rpc('create_followup_delivery', {
        p_original_delivery_id: deliveryId,
        p_performed_by: profile?.id,
        p_idempotency_key: followupKey,
      });
      if (error) throw error;
      const deliveryIdResult = assertRpcResult<string>(data, 'create_followup_delivery');
      toast('success', 'Follow-up delivery created');
      navigate(`/deliveries/${deliveryIdResult}`);
    } catch (err: any) {
      toast('error', err.message || 'Failed to create follow-up delivery');
    }
    setCreating(null);
  };

  const columns: Column<RemainderRow>[] = [
    {
      key: 'customer_name',
      header: 'Customer',
      sortable: true,
      render: (row) => (
        <button
          onClick={(e) => { e.stopPropagation(); navigate(`/customers/${row.customer_id}`); }}
          className="text-crx-green hover:underline font-medium"
        >
          {row.customer_name}
        </button>
      ),
    },
    {
      key: 'product_name',
      header: 'Product',
      sortable: true,
      render: (row) => (
        <div className="flex items-center gap-2">
          <Package className="w-4 h-4 text-secondary flex-shrink-0" />
          <span>{row.product_name}</span>
        </div>
      ),
    },
    {
      key: 'quantity_remaining',
      header: 'Qty Remaining',
      sortable: true,
      render: (row) => (
        <span className="text-amber-600 font-semibold">{row.quantity_remaining}</span>
      ),
    },
    {
      key: 'unit_size' as any,
      header: 'Unit',
      render: (row) => row.unit_size || '-',
    },
    {
      key: 'original_delivery_number' as any,
      header: 'Original Delivery',
      sortable: true,
      render: (row) => (
        <button
          onClick={(e) => { e.stopPropagation(); navigate(`/deliveries/${row.original_delivery_id}`); }}
          className="text-crx-green hover:underline text-sm"
        >
          {row.original_delivery_number}
        </button>
      ),
    },
    {
      key: 'order_number' as any,
      header: 'Order',
      render: (row) =>
        row.order_number && row.order_id ? (
          <button
            onClick={(e) => { e.stopPropagation(); navigate(`/orders/${row.order_id}`); }}
            className="text-crx-green hover:underline text-sm"
          >
            {row.order_number}
          </button>
        ) : '-',
    },
    {
      key: 'status',
      header: 'Status',
      sortable: true,
      render: (row) => {
        const map: Record<string, 'warning' | 'info' | 'success' | 'default'> = {
          pending: 'warning',
          scheduled: 'info',
          fulfilled: 'success',
          cancelled: 'default',
        };
        return <Badge variant={map[row.status] || 'default'}>{row.status}</Badge>;
      },
    },
    {
      key: 'created_at',
      header: 'Created',
      sortable: true,
      render: (row) => {
        const daysOld = Math.floor((Date.now() - new Date(row.created_at).getTime()) / (1000 * 60 * 60 * 24));
        return (
          <div className="flex items-center gap-1.5">
            <span>{new Date(row.created_at).toLocaleDateString()}</span>
            {row.status === 'pending' && daysOld >= 14 && (
              <Badge variant="error">14d+</Badge>
            )}
            {row.status === 'pending' && daysOld >= 7 && daysOld < 14 && (
              <Badge variant="warning">7d+</Badge>
            )}
          </div>
        );
      },
    },
    {
      key: 'id' as any,
      header: '',
      render: (row) =>
        row.status === 'pending' && !row.followup_delivery_id ? (
          <Button
            variant="ghost"
            size="sm"
            icon={<Truck className="w-3 h-3" />}
            onClick={(e) => { e.stopPropagation(); handleCreateFollowup(row.original_delivery_id); }}
            loading={creating === row.original_delivery_id}
          >
            Follow-up
          </Button>
        ) : row.followup_delivery_id ? (
          <button
            onClick={(e) => { e.stopPropagation(); navigate(`/deliveries/${row.followup_delivery_id}`); }}
            className="text-xs text-crx-green hover:underline"
          >
            View Follow-up
          </button>
        ) : null,
    },
  ];

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold font-heading text-nav-dark">Delivery Remainders</h1>

      {/* Summary */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <Card>
          <div className="flex items-center gap-3 mb-2">
            <div className="w-10 h-10 rounded-lg bg-amber-50 flex items-center justify-center">
              <AlertTriangle className="w-5 h-5 text-amber-600" />
            </div>
            <span className="text-sm text-secondary">Pending Items</span>
          </div>
          <p className="text-2xl font-semibold font-heading text-amber-600">{pendingCount}</p>
          <p className="text-xs text-secondary mt-1">items awaiting follow-up delivery</p>
        </Card>
        <Card>
          <div className="flex items-center gap-3 mb-2">
            <div className="w-10 h-10 rounded-lg bg-blue-50 flex items-center justify-center">
              <Truck className="w-5 h-5 text-blue-600" />
            </div>
            <span className="text-sm text-secondary">Customers Affected</span>
          </div>
          <p className="text-2xl font-semibold font-heading text-blue-600">{customerCount}</p>
          <p className="text-xs text-secondary mt-1">customers with pending remainders</p>
        </Card>
      </div>

      {/* Data Table */}
      <Card padding={false}>
        <div className="p-5">
          <DataTable<RemainderRow>
            data={filtered}
            columns={columns}
            searchable
            searchPlaceholder="Search remainders..."
            searchKeys={['customer_name', 'product_name', 'original_delivery_number']}
            emptyTitle="No remainders"
            emptyDescription="Partial deliveries will create remainder items automatically"
            loading={loading}
            filters={
              <div className="flex gap-2 items-center">
                <select
                  value={statusFilter}
                  onChange={(e) => setStatusFilter(e.target.value)}
                  aria-label="Filter by status"
                  className="px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green"
                >
                  <option value="">All Statuses</option>
                  <option value="pending">Pending</option>
                  <option value="scheduled">Scheduled</option>
                  <option value="fulfilled">Fulfilled</option>
                  <option value="cancelled">Cancelled</option>
                </select>
                <select
                  value={customerFilter}
                  onChange={(e) => setCustomerFilter(e.target.value)}
                  aria-label="Filter by customer"
                  className="px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green"
                >
                  <option value="">All Customers</option>
                  {uniqueCustomers.map(([id, name]) => (
                    <option key={id} value={id}>{name}</option>
                  ))}
                </select>
              </div>
            }
          />
        </div>
      </Card>
    </div>
  );
}
