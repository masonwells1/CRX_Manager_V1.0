import { useEffect, useState, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Plus,
  Upload,
  FileText,
  Clock,
  PackageCheck,
  CheckCircle2,
} from 'lucide-react';
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

  /* ─── Summary stats ─── */
  const counts = useMemo(() => {
    const draft = pos.filter((p) => p.status === 'draft').length;
    const submitted = pos.filter((p) => p.status === 'submitted').length;
    const partial = pos.filter((p) => p.status === 'partially_received').length;
    const full = pos.filter((p) => p.status === 'fully_received').length;
    return { draft, submitted, partial, full };
  }, [pos]);

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
      {/* Header + Actions */}
      <div className="flex items-center justify-between flex-wrap gap-2">
        <h1 className="text-xl font-semibold font-heading text-nav-dark">Purchase Orders</h1>
        {isAdmin && (
          <div className="flex gap-2">
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
      </div>

      {/* Summary Cards */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
        <button onClick={() => setStatusFilter(statusFilter === 'draft' ? '' : 'draft')} className="text-left">
          <Card>
            <div className="flex items-center gap-3 mb-2">
              <div className="w-10 h-10 rounded-lg bg-gray-100 flex items-center justify-center">
                <FileText className="w-5 h-5 text-gray-500" />
              </div>
              <span className="text-sm text-secondary">Draft</span>
            </div>
            <p className="text-2xl font-semibold font-heading text-gray-500">{counts.draft}</p>
          </Card>
        </button>
        <button onClick={() => setStatusFilter(statusFilter === 'submitted' ? '' : 'submitted')} className="text-left">
          <Card>
            <div className="flex items-center gap-3 mb-2">
              <div className="w-10 h-10 rounded-lg bg-blue-50 flex items-center justify-center">
                <Clock className="w-5 h-5 text-blue-600" />
              </div>
              <span className="text-sm text-secondary">Awaiting Receipt</span>
            </div>
            <p className="text-2xl font-semibold font-heading text-blue-600">{counts.submitted}</p>
          </Card>
        </button>
        <button onClick={() => setStatusFilter(statusFilter === 'partially_received' ? '' : 'partially_received')} className="text-left">
          <Card>
            <div className="flex items-center gap-3 mb-2">
              <div className="w-10 h-10 rounded-lg bg-amber-50 flex items-center justify-center">
                <PackageCheck className="w-5 h-5 text-amber-600" />
              </div>
              <span className="text-sm text-secondary">Partially Received</span>
            </div>
            <p className="text-2xl font-semibold font-heading text-amber-600">{counts.partial}</p>
          </Card>
        </button>
        <button onClick={() => setStatusFilter(statusFilter === 'fully_received' ? '' : 'fully_received')} className="text-left">
          <Card>
            <div className="flex items-center gap-3 mb-2">
              <div className="w-10 h-10 rounded-lg bg-crx-green-light flex items-center justify-center">
                <CheckCircle2 className="w-5 h-5 text-crx-green" />
              </div>
              <span className="text-sm text-secondary">Fully Received</span>
            </div>
            <p className="text-2xl font-semibold font-heading text-crx-green">{counts.full}</p>
          </Card>
        </button>
      </div>

      {/* Data Table */}
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
              <div className="flex gap-2 items-center flex-wrap">
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
                {statusFilter && (
                  <button
                    onClick={() => setStatusFilter('')}
                    className="text-xs text-crx-green hover:underline"
                  >
                    Clear
                  </button>
                )}
              </div>
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
