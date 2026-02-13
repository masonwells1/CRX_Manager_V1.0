import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Plus, FileText, Check, Send, Ban } from 'lucide-react';
import Card from '../components/ui/Card';
import Button from '../components/ui/Button';
import Badge from '../components/ui/Badge';
import DataTable, { type Column } from '../components/ui/DataTable';
import { useToast } from '../components/ui/Toast';
import { useAuth } from '../contexts/AuthContext';
import { supabase } from '../lib/db';
import { exportToCSV } from '../lib/csvExport';
import type { Invoice, InvoiceStatus } from '../types';

type InvoiceRow = Invoice & { customer_name: string; salesman_name: string | null };

const STATUS_OPTIONS: { value: InvoiceStatus | ''; label: string }[] = [
  { value: '', label: 'All Statuses' },
  { value: 'draft', label: 'Draft' },
  { value: 'unposted', label: 'Unposted' },
  { value: 'posted', label: 'Posted' },
  { value: 'voided', label: 'Voided' },
  { value: 'cancelled', label: 'Cancelled' },
];

const TYPE_OPTIONS: { value: string; label: string }[] = [
  { value: '', label: 'All Types' },
  { value: 'chemical_sale', label: 'Chemical Sale' },
  { value: 'field_application', label: 'Field Application' },
  { value: 'misc_charge', label: 'Misc Charge' },
];

const statusBadge = (status: InvoiceStatus) => {
  const map: Record<InvoiceStatus, { variant: 'default' | 'warning' | 'success' | 'error' | 'info'; label: string }> = {
    draft: { variant: 'default', label: 'Draft' },
    unposted: { variant: 'warning', label: 'Unposted' },
    posted: { variant: 'success', label: 'Posted' },
    voided: { variant: 'error', label: 'Voided' },
    cancelled: { variant: 'default', label: 'Cancelled' },
  };
  const s = map[status] || { variant: 'default' as const, label: status };
  return <Badge variant={s.variant}>{s.label}</Badge>;
};

const typeBadge = (t: string) => {
  const map: Record<string, string> = {
    chemical_sale: 'Chemical',
    field_application: 'Application',
    misc_charge: 'Misc',
  };
  return <Badge variant="info">{map[t] || t}</Badge>;
};

const fmt = (cents: number) =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(cents / 100);

export default function Invoices() {
  const navigate = useNavigate();
  const { profile } = useAuth();
  const { toast } = useToast();
  const [invoices, setInvoices] = useState<InvoiceRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState('');
  const [typeFilter, setTypeFilter] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [posting, setPosting] = useState(false);

  useEffect(() => {
    fetchInvoices();
  }, []);

  const fetchInvoices = async () => {
    setLoading(true);
    const { data, error } = await supabase
      .from('invoices')
      .select('*, customer:customers!invoices_customer_id_fkey(farm_name), salesman:profiles!invoices_salesman_id_fkey(full_name)')
      .is('deleted_at', null)
      .order('created_at', { ascending: false })
      .limit(500);

    if (error) {
      console.error('Failed to load invoices:', error.message);
      toast('error', 'Failed to load invoices');
      setLoading(false);
      return;
    }

    const rows = ((data || []) as any[]).map((inv) => ({
      ...inv,
      customer_name: inv.customer?.farm_name || 'Unknown',
      salesman_name: inv.salesman?.full_name || null,
    }));
    setInvoices(rows);
    setLoading(false);
  };

  const filtered = invoices.filter((inv) => {
    if (statusFilter && inv.status !== statusFilter) return false;
    if (typeFilter && inv.invoice_type !== typeFilter) return false;
    return true;
  });

  // Summary stats
  const unpostedCount = invoices.filter((i) => i.status === 'draft' || i.status === 'unposted').length;
  const postedTotal = invoices
    .filter((i) => i.status === 'posted')
    .reduce((s, i) => s + i.total_amount_cents, 0);
  const outstandingBalance = invoices
    .filter((i) => i.status === 'posted' && i.balance_cents > 0)
    .reduce((s, i) => s + i.balance_cents, 0);

  // Batch post
  const handleBatchPost = async () => {
    const ids = Array.from(selected);
    if (ids.length === 0) {
      toast('error', 'Select invoices to post');
      return;
    }
    // Validate all are draft/unposted
    const invalid = ids.filter((id) => {
      const inv = invoices.find((i) => i.id === id);
      return inv && !['draft', 'unposted'].includes(inv.status);
    });
    if (invalid.length > 0) {
      toast('error', `${invalid.length} selected invoice(s) cannot be posted (already posted/voided)`);
      return;
    }

    setPosting(true);
    const { data, error } = await supabase.rpc('batch_post_invoices', {
      p_invoice_ids: ids,
    });
    if (error) {
      console.error('Batch post failed:', error.message);
      toast('error', error.message || 'Failed to post invoices');
    } else {
      toast('success', `Posted ${data} invoice(s)`);
      setSelected(new Set());
      fetchInvoices();
    }
    setPosting(false);
  };

  const toggleSelect = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleAll = () => {
    const postable = filtered.filter((i) => ['draft', 'unposted'].includes(i.status));
    if (selected.size === postable.length) {
      setSelected(new Set());
    } else {
      setSelected(new Set(postable.map((i) => i.id)));
    }
  };

  const columns: Column<InvoiceRow>[] = [
    {
      key: 'id' as any,
      header: '',
      className: 'w-10',
      render: (row) =>
        ['draft', 'unposted'].includes(row.status) ? (
          <input
            type="checkbox"
            checked={selected.has(row.id)}
            onChange={(e) => {
              e.stopPropagation();
              toggleSelect(row.id);
            }}
            onClick={(e) => e.stopPropagation()}
            className="w-4 h-4 rounded border-gray-300 text-crx-green focus:ring-crx-green"
          />
        ) : null,
    },
    {
      key: 'invoice_number',
      header: 'Invoice #',
      sortable: true,
      render: (row) => (
        <div className="flex items-center gap-2">
          <FileText className="w-4 h-4 text-crx-green flex-shrink-0" />
          <span className="font-medium text-nav-dark">{row.invoice_number}</span>
        </div>
      ),
    },
    {
      key: 'customer_name' as any,
      header: 'Customer',
      sortable: true,
      render: (row) => (
        <button
          onClick={(e) => {
            e.stopPropagation();
            navigate(`/customers/${row.customer_id}`);
          }}
          className="text-crx-green hover:underline"
        >
          {row.customer_name}
        </button>
      ),
    },
    {
      key: 'invoice_type',
      header: 'Type',
      sortable: true,
      render: (row) => typeBadge(row.invoice_type),
    },
    {
      key: 'invoice_date',
      header: 'Date',
      sortable: true,
      render: (row) => new Date(row.invoice_date).toLocaleDateString(),
    },
    {
      key: 'total_amount_cents',
      header: 'Total',
      sortable: true,
      render: (row) => <span className="font-medium">{fmt(row.total_amount_cents)}</span>,
    },
    {
      key: 'balance_cents',
      header: 'Balance',
      sortable: true,
      render: (row) => (
        <span className={row.balance_cents > 0 ? 'text-red-600 font-semibold' : 'text-crx-green'}>
          {fmt(row.balance_cents)}
        </span>
      ),
    },
    {
      key: 'status',
      header: 'Status',
      sortable: true,
      render: (row) => statusBadge(row.status),
    },
    {
      key: 'salesman_name' as any,
      header: 'Salesman',
      render: (row) => row.salesman_name || '-',
    },
  ];

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold font-heading text-nav-dark">Invoices</h1>
        <div className="flex gap-2">
          {selected.size > 0 && profile?.role === 'admin' && (
            <Button
              variant="secondary"
              icon={<Send className="w-4 h-4" />}
              onClick={handleBatchPost}
              loading={posting}
            >
              Post {selected.size} Selected
            </Button>
          )}
          <Button
            variant="secondary"
            size="sm"
            onClick={() =>
              exportToCSV(
                filtered as unknown as Record<string, unknown>[],
                [
                  { key: 'invoice_number', header: 'Invoice #' },
                  { key: 'customer_name', header: 'Customer' },
                  { key: 'invoice_type', header: 'Type' },
                  { key: 'invoice_date', header: 'Date' },
                  { key: 'total_amount_cents', header: 'Total (cents)' },
                  { key: 'balance_cents', header: 'Balance (cents)' },
                  { key: 'status', header: 'Status' },
                ],
                'invoices'
              )
            }
          >
            Export CSV
          </Button>
          <Button icon={<Plus className="w-4 h-4" />} onClick={() => navigate('/invoices/new')}>
            New Invoice
          </Button>
        </div>
      </div>

      {/* Summary Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <Card>
          <div className="flex items-center gap-3 mb-2">
            <div className="w-10 h-10 rounded-lg bg-amber-50 flex items-center justify-center">
              <FileText className="w-5 h-5 text-amber-600" />
            </div>
            <span className="text-sm text-secondary">Unposted</span>
          </div>
          <p className="text-2xl font-semibold font-heading text-amber-600">{unpostedCount}</p>
          <p className="text-xs text-secondary mt-1">invoices awaiting review</p>
        </Card>
        <Card>
          <div className="flex items-center gap-3 mb-2">
            <div className="w-10 h-10 rounded-lg bg-crx-green-light flex items-center justify-center">
              <Check className="w-5 h-5 text-crx-green" />
            </div>
            <span className="text-sm text-secondary">Posted Total</span>
          </div>
          <p className="text-2xl font-semibold font-heading text-crx-green">{fmt(postedTotal)}</p>
          <p className="text-xs text-secondary mt-1">
            {invoices.filter((i) => i.status === 'posted').length} posted invoices
          </p>
        </Card>
        <Card>
          <div className="flex items-center gap-3 mb-2">
            <div className="w-10 h-10 rounded-lg bg-red-50 flex items-center justify-center">
              <Ban className="w-5 h-5 text-red-600" />
            </div>
            <span className="text-sm text-secondary">Outstanding</span>
          </div>
          <p className="text-2xl font-semibold font-heading text-red-600">{fmt(outstandingBalance)}</p>
          <p className="text-xs text-secondary mt-1">unpaid balance on posted invoices</p>
        </Card>
      </div>

      {/* Data Table */}
      <Card padding={false}>
        <div className="p-5">
          <DataTable<InvoiceRow>
            data={filtered}
            columns={columns}
            searchable
            searchPlaceholder="Search invoices..."
            searchKeys={['invoice_number', 'customer_name', 'salesman_name']}
            onRowClick={(row) => navigate(`/invoices/${row.id}`)}
            emptyTitle="No invoices yet"
            emptyDescription="Create your first invoice to start billing"
            emptyAction={
              <Button icon={<Plus className="w-4 h-4" />} onClick={() => navigate('/invoices/new')}>
                New Invoice
              </Button>
            }
            loading={loading}
            filters={
              <div className="flex gap-2 items-center">
                <select
                  value={statusFilter}
                  onChange={(e) => setStatusFilter(e.target.value)}
                  aria-label="Filter by status"
                  className="px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green"
                >
                  {STATUS_OPTIONS.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </select>
                <select
                  value={typeFilter}
                  onChange={(e) => setTypeFilter(e.target.value)}
                  aria-label="Filter by type"
                  className="px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green"
                >
                  {TYPE_OPTIONS.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </select>
                {filtered.some((i) => ['draft', 'unposted'].includes(i.status)) && (
                  <button
                    onClick={toggleAll}
                    className="text-xs text-crx-green hover:underline ml-2"
                  >
                    {selected.size > 0 ? 'Deselect All' : 'Select All Postable'}
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
