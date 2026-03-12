import { useEffect, useState, useMemo , useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { Plus, Upload, Download, FileText, ToggleLeft } from 'lucide-react';
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
import type { Customer } from '../types';

export default function Customers() {
  const navigate = useNavigate();
  const { toast } = useToast();
  const { profile } = useAuth();
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [loading, setLoading] = useState(true);
  const [tierFilter, setTierFilter] = useState('');
  const [importModalOpen, setImportModalOpen] = useState(false);
  const [deactivateModalOpen, setDeactivateModalOpen] = useState(false);
  const [deactivating, setDeactivating] = useState(false);
  const [exporting, setExporting] = useState(false);

  const fetchCustomers = useCallback(async () => {
    const { data, error } = await supabase
      .from('customers')
      .select('*')
      .order('farm_name')
      .limit(500);
    if (error) {
      console.error('Failed to load customers:', error.message);
      toast('error', 'Failed to load customers. Please try again.');
      setLoading(false);
      return;
    }
    setCustomers((data || []) as Customer[]);
    setLoading(false);
  }, [toast]);

  useEffect(() => {
    fetchCustomers();
  }, [fetchCustomers]);

  const filtered = customers.filter((c) => {
    if (tierFilter && c.assigned_tier !== parseInt(tierFilter)) return false;
    return true;
  });

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
        .in('status', ['posted'])
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
