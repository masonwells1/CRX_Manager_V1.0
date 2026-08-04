import { useEffect, useState, useMemo , useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { Plus, Upload, Download, FileText, ToggleLeft, AlertTriangle, UserX } from 'lucide-react';
import Card from '../components/ui/Card';
import Button from '../components/ui/Button';
import DataTable, { type Column } from '../components/ui/DataTable';
import Badge from '../components/ui/Badge';
import BulkActionBar from '../components/ui/BulkActionBar';
import BulkDeleteConfirmModal from '../components/ui/BulkDeleteConfirmModal';
import BulkCustomerImport from '../components/customers/BulkCustomerImport';
import { useToast } from '../components/ui/Toast';
import { useAuth } from '../contexts/AuthContext';
import { supabase, checkMutationResult } from '../lib/db';
import { useRowSelection, createCheckboxColumn } from '../hooks/useRowSelection';
import { exportToCSV, fmtDateCSV } from '../lib/csvExport';
import { downloadReportPdf, type ReportPdfColumn } from '../lib/reportPdf';
import { sanitizeError } from '../lib/errorSanitizer';
import { Sentry } from '../lib/sentry';
import { SkeletonTable } from '../components/ui/Skeleton';
import type { Customer } from '../types';

const CUSTOMER_FETCH_LIMIT = 1000;
/** Sentinel for the "no rep assigned" option — a real rep id is never this. */
const UNASSIGNED_REP = '__unassigned__';

export default function Customers() {
  const navigate = useNavigate();
  const { toast } = useToast();
  const { profile } = useAuth();
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [loading, setLoading] = useState(true);
  const [tierFilter, setTierFilter] = useState('');
  // Deactivated customers stay in the table forever; default the list to the
  // active book so it stays a worklist rather than an ever-growing archive.
  const [statusFilter, setStatusFilter] = useState<'active' | 'inactive' | 'all'>('active');
  const [repFilter, setRepFilter] = useState('');
  const [repNames, setRepNames] = useState<Record<string, string>>({});
  const [truncated, setTruncated] = useState(false);
  const [importModalOpen, setImportModalOpen] = useState(false);
  const [deactivateModalOpen, setDeactivateModalOpen] = useState(false);
  const [deactivating, setDeactivating] = useState(false);
  const [exporting, setExporting] = useState(false);

  const fetchCustomers = useCallback(async () => {
    const { data, error, count } = await supabase
      .from('customers')
      .select('*', { count: 'exact' })
      .order('farm_name')
      .limit(CUSTOMER_FETCH_LIMIT);
    if (error) {
      Sentry.captureException(error, { tags: { source: 'fetch', action: 'load_customers' } });
      toast('error', 'Failed to load customers. Please try again.');
      setLoading(false);
      return;
    }
    const rows = (data || []) as Customer[];
    // A silent cap reads as "this is everyone" — say so instead of hiding it. The
    // total count is what decides that: a full page means only that the page is
    // full, which is equally true of a book sitting exactly on the limit and
    // showing every customer. Fall back to the page-length test when the count is
    // unavailable — over-warning is the safe direction, silently dropping
    // customers is not.
    setTruncated(
      count === null || count === undefined
        ? rows.length >= CUSTOMER_FETCH_LIMIT
        : count > CUSTOMER_FETCH_LIMIT,
    );
    setCustomers(rows);
    setLoading(false);
  }, [toast]);

  useEffect(() => {
    fetchCustomers();
  }, [fetchCustomers]);

  // Assigned-rep names for the column + filter. A failure here only costs the
  // rep label (the id-based filter still works), so it never blocks the list.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const { data, error } = await supabase
        .from('profile_public_view')
        .select('id, full_name')
        .eq('is_active', true)
        .order('full_name');
      if (cancelled || error || !data) return;
      setRepNames(Object.fromEntries(
        data.flatMap((p: { id: string | null; full_name: string | null }) => (p.id ? [[p.id, p.full_name || 'Unnamed user']] : [])),
      ));
    })();
    return () => { cancelled = true; };
  }, []);

  const filtered = customers.filter((c) => {
    if (tierFilter && c.assigned_tier !== parseInt(tierFilter)) return false;
    if (statusFilter === 'active' && !c.is_active) return false;
    if (statusFilter === 'inactive' && c.is_active) return false;
    if (repFilter === UNASSIGNED_REP && c.assigned_sales_rep) return false;
    if (repFilter && repFilter !== UNASSIGNED_REP && c.assigned_sales_rep !== repFilter) return false;
    return true;
  });

  // Only reps that actually hold accounts in the loaded book — an empty option
  // that always filters to zero rows is worse than no option.
  const repOptions = Array.from(new Set(customers.map((c) => c.assigned_sales_rep).filter(Boolean) as string[]))
    .map((repId) => ({ id: repId, name: repNames[repId] || 'Unknown rep' }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const unassignedCount = customers.filter((c) => c.is_active && !c.assigned_sales_rep).length;

  const canBulkAction = profile?.role === 'admin' || profile?.role === 'sales_rep';

  const { selected, toggleSelect, toggleAll, clearSelection, selectedCount, selectedRows, allSelected } =
    useRowSelection({
      data: filtered,
      getId: (c) => c.id,
      isSelectable: (c) => c.is_active,
    });

  const checkboxCol = useMemo(
    () => createCheckboxColumn<Customer>(selected, toggleSelect, (c) => c.id, (c) => c.is_active),
    [selected, toggleSelect]
  );

  const dataColumns: Column<Customer>[] = [
    {
      key: 'farm_name',
      header: 'Farm Name',
      sortable: true,
      render: (row) => <span className="font-medium text-nav-dark">{row.farm_name}</span>,
    },
    { key: 'contact_name', header: 'Contact', sortable: true },
    { key: 'phone', header: 'Phone' },
    {
      key: 'email',
      header: 'Email',
      render: (row) => row.email || <span className="text-xs text-gray-400">—</span>,
    },
    {
      key: 'assigned_sales_rep',
      header: 'Sales Rep',
      sortable: true,
      render: (row) => (row.assigned_sales_rep
        ? <span>{repNames[row.assigned_sales_rep] || 'Unknown rep'}</span>
        : <span className="text-xs text-amber-600">Unassigned</span>),
    },
    {
      key: 'assigned_tier',
      header: 'Tier',
      sortable: true,
      render: (row) => (
        <Badge variant={row.assigned_tier === 1 ? 'success' : row.assigned_tier === 2 ? 'info' : 'warning'}>
          Tier {row.assigned_tier}
        </Badge>
      ),
    },
    {
      key: 'total_acres',
      header: 'Total Acres',
      sortable: true,
      render: (row) => row.total_acres?.toLocaleString() || '-',
    },
    {
      key: 'is_active',
      header: 'Status',
      render: (row) => (
        <Badge variant={row.is_active ? 'success' : 'default'}>
          {row.is_active ? 'Active' : 'Inactive'}
        </Badge>
      ),
    },
  ];

  const columns = canBulkAction ? [checkboxCol, ...dataColumns] : dataColumns;

  // ─── Bulk action handlers ───────────────────────────────────
  const handleExportCSV = () => {
    exportToCSV(selectedRows as unknown as Record<string, unknown>[], [
      { key: 'farm_name', header: 'Farm Name' },
      { key: 'contact_name', header: 'Contact Name' },
      { key: 'phone', header: 'Phone' },
      { key: 'email', header: 'Email' },
      { key: 'assigned_tier', header: 'Tier' },
      { key: 'total_acres', header: 'Total Acres' },
      { key: 'is_active', header: 'Active', format: (v) => (v ? 'Yes' : 'No') },
      { key: 'created_at', header: 'Created', format: (v) => fmtDateCSV(v as string) },
    ], 'customers');
    toast('success', `Exported ${selectedRows.length} customer(s) to CSV`);
  };

  const handleExportPDF = async () => {
    setExporting(true);
    try {
      const pdfCols: ReportPdfColumn[] = [
        { header: 'Farm Name', key: 'farm_name' },
        { header: 'Contact', key: 'contact_name' },
        { header: 'Phone', key: 'phone' },
        { header: 'Tier', key: 'assigned_tier' },
        { header: 'Total Acres', key: 'total_acres', align: 'right', format: (v) => v != null ? Number(v).toLocaleString() : '-' },
        { header: 'Status', key: 'is_active', format: (v) => (v ? 'Active' : 'Inactive') },
      ];
      await downloadReportPdf({
        title: 'Customer List',
        subtitle: `${selectedRows.length} customer(s) selected`,
        columns: pdfCols,
        data: selectedRows as unknown as Record<string, unknown>[],
      });
      toast('success', `Downloaded PDF with ${selectedRows.length} customer(s)`);
    } catch (err) {
      toast('error', sanitizeError(err));
    }
    setExporting(false);
  };

  const handleDeactivate = async () => {
    setDeactivating(true);
    try {
      const ids = selectedRows.map((c) => c.id);

      // H21: Block deactivation if any selected customer has open (posted) invoices
      const { data: openInvoices } = await supabase
        .from('invoices')
        .select('id, customer_id')
        .in('customer_id', ids)
        .in('status', ['posted', 'overdue'])
        .is('deleted_at', null)
        .limit(1);
      if (openInvoices && openInvoices.length > 0) {
        toast('error', 'Cannot deactivate: one or more selected customers have open invoices. Resolve all invoices first.');
        setDeactivating(false);
        setDeactivateModalOpen(false);
        return;
      }

      const result = await supabase
        .from('customers')
        .update({ is_active: false })
        .in('id', ids)
        .select();
      checkMutationResult(result, 'Deactivate customers');
      toast('success', `Deactivated ${ids.length} customer(s)`);
      clearSelection();
      fetchCustomers();
    } catch (err) {
      toast('error', sanitizeError(err));
    }
    setDeactivating(false);
    setDeactivateModalOpen(false);
  };

  const bulkActions = [
    { key: 'csv', label: 'Export CSV', icon: <Download className="w-4 h-4" />, onClick: handleExportCSV },
    { key: 'pdf', label: 'Download PDF', icon: <FileText className="w-4 h-4" />, onClick: handleExportPDF, loading: exporting },
    { key: 'deactivate', label: 'Deactivate', icon: <ToggleLeft className="w-4 h-4" />, onClick: () => setDeactivateModalOpen(true), variant: 'danger' as const },
  ];

  if (loading) {
    return (
      <div className="p-6">
        <SkeletonTable rows={8} />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex-1">
          {canBulkAction && (
            <BulkActionBar
              selectedCount={selectedCount}
              actions={bulkActions}
              onDeselectAll={clearSelection}
            />
          )}
        </div>
        <div className="flex gap-2">
          <Button
            variant="secondary"
            icon={<Upload className="w-4 h-4" />}
            onClick={() => setImportModalOpen(true)}
          >
            Bulk Import
          </Button>
          <Button icon={<Plus className="w-4 h-4" />} onClick={() => navigate('/customers/new')}>
            Add Customer
          </Button>
        </div>
      </div>

      <BulkCustomerImport
        open={importModalOpen}
        onClose={() => setImportModalOpen(false)}
        onSuccess={fetchCustomers}
      />

      {truncated && (
        <div className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>
            Showing the first {CUSTOMER_FETCH_LIMIT.toLocaleString()} customers by farm name — this list is truncated.
            Search and filters below only apply to the customers already loaded.
          </span>
        </div>
      )}

      {unassignedCount > 0 && repFilter !== UNASSIGNED_REP && (
        <div className="flex items-start gap-2 rounded-lg border border-gray-200 bg-white px-4 py-3 text-sm text-secondary">
          <UserX className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
          <span>
            {unassignedCount} active customer{unassignedCount === 1 ? ' has' : 's have'} no assigned sales rep.{' '}
            <button
              type="button"
              onClick={() => { setRepFilter(UNASSIGNED_REP); setStatusFilter('active'); }}
              className="font-medium text-crx-green hover:underline"
            >
              Show them
            </button>
          </span>
        </div>
      )}

      <BulkDeleteConfirmModal
        open={deactivateModalOpen}
        onClose={() => setDeactivateModalOpen(false)}
        count={selectedCount}
        entityName="customer"
        actionWord="deactivate"
        onConfirm={handleDeactivate}
        loading={deactivating}
      />

      <Card padding={false}>
        <div className="p-5">
          <DataTable<Customer>
            data={filtered}
            columns={columns}
            searchable
            searchPlaceholder="Search customers..."
            searchKeys={['farm_name', 'contact_name', 'phone', 'email']}
            onRowClick={(row) => navigate(`/customers/${row.id}`)}
            emptyTitle="No customers yet"
            emptyDescription="Add your first customer to start quoting"
            emptyAction={
              <Button icon={<Plus className="w-4 h-4" />} onClick={() => navigate('/customers/new')}>
                Add Customer
              </Button>
            }
            loading={loading}
            filters={
              <>
                <select
                  value={statusFilter}
                  onChange={(e) => setStatusFilter(e.target.value as 'active' | 'inactive' | 'all')}
                  aria-label="Filter by status"
                  className="px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green"
                >
                  <option value="active">Active only</option>
                  <option value="inactive">Inactive only</option>
                  <option value="all">All statuses</option>
                </select>
                <select
                  value={repFilter}
                  onChange={(e) => setRepFilter(e.target.value)}
                  aria-label="Filter by sales rep"
                  className="px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green"
                >
                  <option value="">All reps</option>
                  <option value={UNASSIGNED_REP}>Unassigned</option>
                  {repOptions.map((rep) => (
                    <option key={rep.id} value={rep.id}>{rep.name}</option>
                  ))}
                </select>
                <select
                  value={tierFilter}
                  onChange={(e) => setTierFilter(e.target.value)}
                  aria-label="Filter by tier"
                  className="px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green"
                >
                  <option value="">All Tiers</option>
                  <option value="1">Tier 1</option>
                  <option value="2">Tier 2</option>
                  <option value="3">Tier 3</option>
                </select>
                {canBulkAction && filtered.length > 0 && (
                  <button
                    onClick={toggleAll}
                    className="px-3 py-2 text-xs font-medium text-secondary hover:text-nav-dark transition-colors"
                  >
                    {allSelected ? 'Deselect All' : 'Select All'}
                  </button>
                )}
              </>
            }
          />
        </div>
      </Card>
    </div>
  );
}
