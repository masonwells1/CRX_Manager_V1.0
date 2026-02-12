import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Plus, Upload } from 'lucide-react';
import Card from '../components/ui/Card';
import Button from '../components/ui/Button';
import DataTable, { type Column } from '../components/ui/DataTable';
import Badge, { statusToBadgeVariant } from '../components/ui/Badge';
import { useToast } from '../components/ui/Toast';
import { useAuth } from '../contexts/AuthContext';
import { supabase } from '../lib/db';
import BulkPOImport from '../components/purchase-orders/BulkPOImport';
import type { PurchaseOrder } from '../types';

export default function PurchaseOrders() {
  const { role } = useAuth();
  const navigate = useNavigate();
  const { toast } = useToast();
  const [pos, setPos] = useState<PurchaseOrder[]>([]);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState('');
  const [importOpen, setImportOpen] = useState(false);

  const isAdmin = role === 'admin';

  useEffect(() => {
    fetchPOs();
  }, []);

  const fetchPOs = async () => {
    const { data, error } = await supabase
      .from('purchase_orders')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(500);
    if (error) {
      console.error('Failed to load purchase orders:', error.message);
      toast('error', 'Failed to load purchase orders. Please try again.');
      setLoading(false);
      return;
    }
    setPos((data || []) as PurchaseOrder[]);
    setLoading(false);
  };

  const filtered = pos.filter((p) => {
    if (statusFilter && p.status !== statusFilter) return false;
    return true;
  });

  const fmt = (n: number) =>
    new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(n);

  const columns: Column<PurchaseOrder>[] = [
    {
      key: 'po_number',
      header: 'PO #',
      sortable: true,
      render: (row) => <span className="font-medium text-nav-dark">{row.po_number}</span>,
    },
    { key: 'vendor', header: 'Vendor', sortable: true },
    {
      key: 'status',
      header: 'Status',
      sortable: true,
      render: (row) => (
        <Badge variant={statusToBadgeVariant[row.status] || 'default'}>
          {row.status.replace(/_/g, ' ')}
        </Badge>
      ),
    },
    {
      key: 'total_cost',
      header: 'Total Cost',
      sortable: true,
      render: (row) => <span className="font-mono text-sm">{fmt(row.total_cost)}</span>,
    },
    {
      key: 'submitted_date',
      header: 'Submitted',
      sortable: true,
      render: (row) =>
        row.submitted_date ? new Date(row.submitted_date).toLocaleDateString() : '-',
    },
    {
      key: 'expected_delivery_date',
      header: 'Expected Delivery',
      sortable: true,
      render: (row) =>
        row.expected_delivery_date
          ? new Date(row.expected_delivery_date).toLocaleDateString()
          : '-',
    },
  ];

  return (
    <div className="space-y-4">
      {isAdmin && (
        <div className="flex justify-end gap-2">
          <Button
            variant="secondary"
            icon={<Upload className="w-4 h-4" />}
            showChevron={false}
            onClick={() => setImportOpen(true)}
          >
            Import from PDF
          </Button>
          <Button icon={<Plus className="w-4 h-4" />} onClick={() => navigate('/purchase-orders/new')}>
            New PO
          </Button>
        </div>
      )}

      <Card padding={false}>
        <div className="p-5">
          <DataTable<PurchaseOrder>
            data={filtered}
            columns={columns}
            searchable
            searchPlaceholder="Search purchase orders..."
            searchKeys={['po_number', 'vendor']}
            onRowClick={(row) => navigate(`/purchase-orders/${row.id}`)}
            emptyTitle="No purchase orders"
            emptyDescription="Create a PO to order products from vendors"
            emptyAction={
              isAdmin ? (
                <Button icon={<Plus className="w-4 h-4" />} onClick={() => navigate('/purchase-orders/new')}>
                  New PO
                </Button>
              ) : undefined
            }
            loading={loading}
            filters={
              <select
                value={statusFilter}
                onChange={(e) => setStatusFilter(e.target.value)}
                aria-label="Filter by PO status"
                className="px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green"
              >
                <option value="">All Statuses</option>
                <option value="draft">Draft</option>
                <option value="submitted">Submitted</option>
                <option value="partially_received">Partially Received</option>
                <option value="fully_received">Fully Received</option>
                <option value="cancelled">Cancelled</option>
              </select>
            }
          />
        </div>
      </Card>

      <BulkPOImport
        open={importOpen}
        onClose={() => setImportOpen(false)}
        onSuccess={() => { setImportOpen(false); fetchPOs(); }}
      />
    </div>
  );
}
