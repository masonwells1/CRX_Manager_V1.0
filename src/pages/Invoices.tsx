import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Plus, FileText, Check, Send, Ban, Printer, Mail } from 'lucide-react';
import Card from '../components/ui/Card';
import Button from '../components/ui/Button';
import Badge from '../components/ui/Badge';
import DataTable, { type Column } from '../components/ui/DataTable';
import { useToast } from '../components/ui/Toast';
import { useAuth } from '../contexts/AuthContext';
import { supabase } from '../lib/db';
import { exportToCSV } from '../lib/csvExport';
import BatchVoidModal from '../components/invoices/BatchVoidModal';
import InvoicePrintDialog from '../components/invoices/InvoicePrintDialog';
import type { Invoice, InvoiceStatus, InvoicePrintOptions } from '../types';
import { generateBatchInvoicePdf, type InvoicePdfData } from '../lib/invoicePdf';

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
  const [voiding, setVoiding] = useState(false);
  const [printing, setPrinting] = useState(false);
  const [showVoidModal, setShowVoidModal] = useState(false);
  const [showBatchPrintDialog, setShowBatchPrintDialog] = useState(false);

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

  // Determine what's selected for action buttons
  const selectedInvoices = invoices.filter((i) => selected.has(i.id));
  const selectedPostable = selectedInvoices.filter((i) => ['draft', 'unposted'].includes(i.status));
  const selectedVoidable = selectedInvoices.filter((i) => i.status === 'posted');
  const selectableStatuses = ['draft', 'unposted', 'posted'];

  // Batch post
  const handleBatchPost = async () => {
    const ids = selectedPostable.map((i) => i.id);
    if (ids.length === 0) {
      toast('error', 'No postable invoices selected');
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

  // Batch void
  const handleBatchVoid = async (reason: string) => {
    const ids = selectedVoidable.map((i) => i.id);
    if (ids.length === 0) {
      toast('error', 'No posted invoices selected to void');
      return;
    }

    setVoiding(true);
    const { data, error } = await supabase.rpc('batch_void_invoices', {
      p_invoice_ids: ids,
      p_void_reason: reason,
      p_performed_by: profile?.id,
    });
    if (error) {
      console.error('Batch void failed:', error.message);
      toast('error', error.message || 'Failed to void invoices');
    } else {
      toast('success', `Voided ${data} invoice(s)`);
      setSelected(new Set());
      fetchInvoices();
    }
    setShowVoidModal(false);
    setVoiding(false);
  };

  // Batch print
  const handleBatchPrint = async (options: InvoicePrintOptions) => {
    setShowBatchPrintDialog(false);
    setPrinting(true);

    try {
      // Fetch full data for each selected invoice
      const pdfDataList: InvoicePdfData[] = [];

      for (const inv of selectedInvoices) {
        // Fetch customer details
        const { data: cust } = await supabase
          .from('customers')
          .select('billing_address, city, state, zip, account_number, payment_terms')
          .eq('id', inv.customer_id)
          .single();

        // Fetch items with product details
        const { data: items } = await supabase
          .from('invoice_items')
          .select('*, product:products(product_name, epa_registration, product_form)')
          .eq('invoice_id', inv.id)
          .order('sort_order');

        // Fetch shares
        const { data: shares } = await supabase
          .from('invoice_shares')
          .select('*, customer:customers!invoice_shares_customer_id_fkey(farm_name)')
          .eq('invoice_id', inv.id);

        const pdfData: InvoicePdfData = {
          invoice_number: inv.invoice_number,
          invoice_date: inv.invoice_date,
          due_date: inv.due_date || undefined,
          invoice_type: inv.invoice_type || 'chemical_sale',
          status: inv.status || 'draft',
          customer_name: inv.customer_name,
          customer_address: cust?.billing_address || undefined,
          customer_city: cust?.city || undefined,
          customer_state: cust?.state || undefined,
          customer_zip: cust?.zip || undefined,
          account_number: cust?.account_number || undefined,
          payment_terms: cust?.payment_terms || undefined,
          salesman_name: inv.salesman_name || undefined,
          purchase_order_ref: inv.purchase_order_ref || undefined,
          header_notes: inv.header_notes || undefined,
          footer_notes: inv.footer_notes || undefined,
          crop_type: inv.crop_type || undefined,
          field_names: inv.field_names || undefined,
          total_acres: inv.total_acres || undefined,
          applicator_name: inv.applicator_name || undefined,
          vehicle_name: inv.vehicle_name || undefined,
          application_date: inv.application_date || undefined,
          shares: (shares || []).length > 0 ? (shares as any[]).map(s => ({
            customer_name: s.customer?.farm_name || 'Unknown',
            split_percentage: s.split_percentage,
            acres: s.acres,
            amount_cents: s.amount_cents,
            price_per_acre_cents: s.price_per_acre_cents || null,
            pricing_note: s.pricing_note || null,
          })) : undefined,
          items: ((items || []) as any[]).map((it) => ({
            description: it.description,
            product_name: it.product?.product_name || it.description,
            quantity: Number(it.quantity),
            unit_size: it.unit_size || undefined,
            unit_price_cents: it.unit_price_cents,
            extended_cents: it.extended_cents,
            cost_cents: it.cost_cents,
            rate_per_acre: it.rate_per_acre ? Number(it.rate_per_acre) : null,
            rate_unit: it.rate_unit || null,
            total_applied: it.total_applied ? Number(it.total_applied) : null,
            total_applied_unit: it.total_applied_unit || null,
            total_applied_gl_lb: it.total_applied_gl_lb ? Number(it.total_applied_gl_lb) : null,
            gl_lb_unit: it.gl_lb_unit || null,
            epa_registration: it.epa_registration || it.product?.epa_registration || null,
            is_application_fee: it.is_application_fee || false,
            product_form: it.product_form || it.product?.product_form || null,
          })),
          total_amount_cents: inv.total_amount_cents || 0,
          total_cost_cents: inv.total_cost_cents || 0,
          paid_amount_cents: inv.paid_amount_cents || 0,
          prepay_applied_cents: inv.prepay_applied_cents || 0,
          balance_cents: inv.balance_cents || 0,
          options,
        };
        pdfDataList.push(pdfData);
      }

      if (pdfDataList.length === 0) {
        toast('error', 'No invoices to print');
        setPrinting(false);
        return;
      }

      await generateBatchInvoicePdf(pdfDataList);
      toast('success', `Printed ${pdfDataList.length} invoice(s) to PDF`);
    } catch (err: any) {
      console.error('Batch print failed:', err);
      toast('error', err.message || 'Failed to generate batch PDF');
    }
    setPrinting(false);
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
    const selectable = filtered.filter((i) => selectableStatuses.includes(i.status));
    if (selected.size === selectable.length && selectable.length > 0) {
      setSelected(new Set());
    } else {
      setSelected(new Set(selectable.map((i) => i.id)));
    }
  };

  const columns: Column<InvoiceRow>[] = [
    {
      key: 'id' as any,
      header: '',
      className: 'w-10',
      render: (row) =>
        selectableStatuses.includes(row.status) ? (
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

  // Determine if batch print dialog needs any shares info
  const anySelectedHasShares = selectedInvoices.some(
    (i) => i.invoice_type === 'field_application'
  );
  const anySelectedIsFieldApp = selectedInvoices.some(
    (i) => i.invoice_type === 'field_application'
  );

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold font-heading text-nav-dark">Invoices</h1>
        <div className="flex gap-2 flex-wrap justify-end">
          {selected.size > 0 && profile?.role === 'admin' && (
            <>
              {selectedPostable.length > 0 && (
                <Button
                  variant="secondary"
                  icon={<Send className="w-4 h-4" />}
                  onClick={handleBatchPost}
                  loading={posting}
                >
                  Post {selectedPostable.length} Selected
                </Button>
              )}
              {selectedVoidable.length > 0 && (
                <Button
                  variant="danger"
                  icon={<Ban className="w-4 h-4" />}
                  onClick={() => setShowVoidModal(true)}
                >
                  Void {selectedVoidable.length} Selected
                </Button>
              )}
              <Button
                variant="secondary"
                icon={<Printer className="w-4 h-4" />}
                onClick={() => setShowBatchPrintDialog(true)}
                loading={printing}
              >
                Print {selected.size} Selected
              </Button>
              <Button
                variant="secondary"
                icon={<Mail className="w-4 h-4" />}
                disabled
                title="Coming soon — requires email integration"
              >
                Email
              </Button>
            </>
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
                {filtered.some((i) => selectableStatuses.includes(i.status)) && (
                  <button
                    onClick={toggleAll}
                    className="text-xs text-crx-green hover:underline ml-2"
                  >
                    {selected.size > 0 ? 'Deselect All' : 'Select All'}
                  </button>
                )}
              </div>
            }
          />
        </div>
      </Card>

      {/* Batch Void Modal */}
      <BatchVoidModal
        open={showVoidModal}
        onClose={() => setShowVoidModal(false)}
        count={selectedVoidable.length}
        onConfirm={handleBatchVoid}
        loading={voiding}
      />

      {/* Batch Print Dialog */}
      <InvoicePrintDialog
        open={showBatchPrintDialog}
        onClose={() => setShowBatchPrintDialog(false)}
        invoiceType={anySelectedIsFieldApp ? 'field_application' : 'chemical_sale'}
        hasShares={anySelectedHasShares}
        onPrint={handleBatchPrint}
        loading={printing}
      />
    </div>
  );
}
