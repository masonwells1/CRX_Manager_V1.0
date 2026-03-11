/**
 * VendorBills.tsx — List of all vendor bills
 *
 * Filterable by status (unpaid/partially_paid/paid/overdue).
 * Search by vendor name, bill number, PO number. Admin-only.
 */
import { useEffect, useState, useMemo, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { Plus, AlertTriangle, Clock, CheckCircle2, FileText } from 'lucide-react';
import Card from '../components/ui/Card';
import Button from '../components/ui/Button';
import Badge, { type BadgeVariant } from '../components/ui/Badge';
import DataTable, { type Column } from '../components/ui/DataTable';
import { useToast } from '../components/ui/Toast';
import { supabase } from '../lib/db';
import type { VendorBill } from '../types';

const statusVariant: Record<string, BadgeVariant> = {
  unpaid: 'warning',
  partially_paid: 'info',
  paid: 'success',
  voided: 'default',
};

export default function VendorBills() {
  const navigate = useNavigate();
  const { toast } = useToast();
  const [bills, setBills] = useState<VendorBill[]>([]);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState('');

  const today = new Date().toISOString().split('T')[0];

  const fetchBills = useCallback(async () => {
    setLoading(true);
    const { data, error } = await supabase
      .from('vendor_bills')
      .select('*, vendor:vendors(name), purchase_order:purchase_orders(po_number)')
      .is('deleted_at', null)
      .order('due_date', { ascending: true });

    if (error) {
      console.error('Failed to load vendor bills:', error.message);
      toast('error', 'Failed to load vendor bills');
      setLoading(false);
      return;
    }

    const mapped = ((data || []) as Array<Record<string, unknown>>).map((b) => ({
      ...b,
      vendor_name: (b.vendor as { name?: string } | null)?.name || 'Unknown',
      po_number: (b.purchase_order as { po_number?: string } | null)?.po_number || null,
    })) as unknown as (VendorBill & { vendor_name: string; po_number: string | null })[];

    setBills(mapped);
    setLoading(false);
  }, [toast]);

  useEffect(() => {
    fetchBills();
  }, [fetchBills]);

  const fmt = (cents: number) =>
    new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(cents / 100);

  const counts = useMemo(() => {
    const unpaid = bills.filter((b) => b.status === 'unpaid').length;
    const partial = bills.filter((b) => b.status === 'partially_paid').length;
    const paid = bills.filter((b) => b.status === 'paid').length;
    const overdue = bills.filter((b) => b.status !== 'paid' && b.status !== 'voided' && b.due_date < today).length;
    return { unpaid, partial, paid, overdue };
  }, [bills, today]);

  type BillRow = VendorBill & { vendor_name: string; po_number: string | null };

  const filtered = bills.filter((b) => {
    if (statusFilter === 'overdue') return b.status !== 'paid' && b.status !== 'voided' && b.due_date < today;
    if (statusFilter && b.status !== statusFilter) return false;
    return true;
  }) as BillRow[];

  const isOverdue = (b: VendorBill) => b.status !== 'paid' && b.status !== 'voided' && b.due_date < today;

  const columns: Column<BillRow>[] = [
    {
      key: 'bill_number',
      header: 'Bill #',
      sortable: true,
      render: (r) => <span className="font-medium text-nav-dark">{r.bill_number}</span>,
    },
    {
      key: 'vendor_name' as keyof BillRow,
      header: 'Vendor',
      sortable: true,
      render: (r) => r.vendor_name,
    },
    {
      key: 'po_number' as keyof BillRow,
      header: 'PO #',
      render: (r) => r.po_number || '-',
    },
    {
      key: 'bill_date',
      header: 'Bill Date',
      sortable: true,
      render: (r) => new Date(r.bill_date).toLocaleDateString(),
    },
    {
      key: 'due_date',
      header: 'Due Date',
      sortable: true,
      render: (r) => (
        <span className={isOverdue(r) ? 'text-red-600 font-semibold' : ''}>
          {new Date(r.due_date + 'T00:00:00').toLocaleDateString()}
          {isOverdue(r) && ' ⚠'}
        </span>
      ),
    },
    {
      key: 'total_cents',
      header: 'Total',
      sortable: true,
      render: (r) => <span className="font-mono text-sm">{fmt(r.total_cents)}</span>,
    },
    {
      key: 'balance_cents',
      header: 'Balance',
      sortable: true,
      render: (r) => (
        <span className={`font-mono text-sm font-semibold ${r.balance_cents > 0 ? 'text-red-600' : 'text-crx-green'}`}>
          {fmt(r.balance_cents)}
        </span>
      ),
    },
    {
      key: 'status',
      header: 'Status',
      sortable: true,
      render: (r) => (
        <Badge variant={isOverdue(r) ? 'error' : (statusVariant[r.status] || 'default')}>
          {isOverdue(r) ? 'overdue' : r.status.replace(/_/g, ' ')}
        </Badge>
      ),
    },
    {
      key: 'payment_terms',
      header: 'Terms',
      render: (r) => <span className="text-secondary text-xs">{r.payment_terms || '-'}</span>,
    },
  ];

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-2">
        <h2 className="text-xl font-semibold font-heading text-nav-dark">Vendor Bills</h2>
        <Button icon={<Plus className="w-4 h-4" />} onClick={() => navigate('/accounts-payable/bills/new')}>
          New Bill
        </Button>
      </div>

      {/* Summary Cards */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
        <button onClick={() => setStatusFilter(statusFilter === 'unpaid' ? '' : 'unpaid')} className="text-left">
          <Card>
            <div className="flex items-center gap-3 mb-2">
              <div className="w-10 h-10 rounded-lg bg-yellow-50 flex items-center justify-center">
                <FileText className="w-5 h-5 text-yellow-600" />
              </div>
              <span className="text-sm text-secondary">Unpaid</span>
            </div>
            <p className="text-2xl font-semibold font-heading text-yellow-600">{counts.unpaid}</p>
          </Card>
        </button>
        <button onClick={() => setStatusFilter(statusFilter === 'partially_paid' ? '' : 'partially_paid')} className="text-left">
          <Card>
            <div className="flex items-center gap-3 mb-2">
              <div className="w-10 h-10 rounded-lg bg-blue-50 flex items-center justify-center">
                <Clock className="w-5 h-5 text-blue-600" />
              </div>
              <span className="text-sm text-secondary">Partially Paid</span>
            </div>
            <p className="text-2xl font-semibold font-heading text-blue-600">{counts.partial}</p>
          </Card>
        </button>
        <button onClick={() => setStatusFilter(statusFilter === 'overdue' ? '' : 'overdue')} className="text-left">
          <Card>
            <div className="flex items-center gap-3 mb-2">
              <div className="w-10 h-10 rounded-lg bg-red-50 flex items-center justify-center">
                <AlertTriangle className="w-5 h-5 text-red-600" />
              </div>
              <span className="text-sm text-secondary">Overdue</span>
            </div>
            <p className="text-2xl font-semibold font-heading text-red-600">{counts.overdue}</p>
          </Card>
        </button>
        <button onClick={() => setStatusFilter(statusFilter === 'paid' ? '' : 'paid')} className="text-left">
          <Card>
            <div className="flex items-center gap-3 mb-2">
              <div className="w-10 h-10 rounded-lg bg-crx-green-light flex items-center justify-center">
                <CheckCircle2 className="w-5 h-5 text-crx-green" />
              </div>
              <span className="text-sm text-secondary">Paid</span>
            </div>
            <p className="text-2xl font-semibold font-heading text-crx-green">{counts.paid}</p>
          </Card>
        </button>
      </div>

      {/* Data Table */}
      <Card padding={false}>
        <div className="p-5">
          <DataTable<BillRow>
            data={filtered}
            columns={columns}
            searchable
            searchPlaceholder="Search bills..."
            searchKeys={['bill_number', 'vendor_name', 'po_number']}
            onRowClick={(row) => navigate(`/accounts-payable/bills/${row.id}`)}
            emptyTitle="No vendor bills"
            emptyDescription="Create a bill to track what you owe vendors."
            emptyAction={
              <Button icon={<Plus className="w-4 h-4" />} onClick={() => navigate('/accounts-payable/bills/new')}>
                New Bill
              </Button>
            }
            loading={loading}
            filters={
              <div className="flex gap-2 items-center flex-wrap">
                <select
                  value={statusFilter}
                  onChange={(e) => setStatusFilter(e.target.value)}
                  aria-label="Filter by bill status"
                  className="px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green"
                >
                  <option value="">All Statuses</option>
                  <option value="unpaid">Unpaid</option>
                  <option value="partially_paid">Partially Paid</option>
                  <option value="paid">Paid</option>
                  <option value="overdue">Overdue</option>
                  <option value="voided">Voided</option>
                </select>
                {statusFilter && (
                  <button onClick={() => setStatusFilter('')} className="text-xs text-crx-green hover:underline">
                    Clear
                  </button>
                )}
              </div>
            }
          />
        </div>
      </Card>
    </div>
  );
}
