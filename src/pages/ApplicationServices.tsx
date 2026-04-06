import { useEffect, useState, useMemo, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { Plus, Wrench, Download, FileText, Trash2 } from 'lucide-react';
import Card from '../components/ui/Card';
import Button from '../components/ui/Button';
import Badge, { type BadgeVariant } from '../components/ui/Badge';
import DataTable, { type Column } from '../components/ui/DataTable';
import BulkActionBar from '../components/ui/BulkActionBar';
import BulkDeleteConfirmModal from '../components/ui/BulkDeleteConfirmModal';
import SplitHeading from '../components/ui/SplitHeading';
import { useRowSelection, createCheckboxColumn } from '../hooks/useRowSelection';
import { useToast } from '../components/ui/Toast';
import { useAuth } from '../contexts/AuthContext';
import { supabase, sanitizeError, checkMutationResult } from '../lib/db';
import { Sentry } from '../lib/sentry';
import { exportToCSV } from '../lib/csvExport';
import { downloadReportPdf } from '../lib/reportPdf';
import type { ApplicationService } from '../types';

// Money: all pricing stored as bigint cents, displayed / 100
const formatCentsPerAcre = (cents: number) =>
  `$${(cents / 100).toFixed(2)}/ac`;

export default function ApplicationServices() {
  const navigate = useNavigate();
  const { toast } = useToast();
  const { role } = useAuth();
  const [services, setServices] = useState<ApplicationService[]>([]);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState<'active' | 'inactive' | ''>('');
  const [deleteModalOpen, setDeleteModalOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [exporting, setExporting] = useState(false);

  const canBulkAction = role === 'admin';

  const fetchServices = useCallback(async () => {
    setLoading(true);
    const { data, error } = await supabase
      .from('application_services')
      .select('*, vehicle:vehicles(vehicle_name)')
      .order('sort_order');

    if (error) {
      Sentry.captureException(error, { tags: { source: 'fetch', action: 'load_application_services' } });
      toast('error', 'Failed to load application services');
      setLoading(false);
      return;
    }
    setServices((data || []) as ApplicationService[]);
    setLoading(false);
  }, [toast]);

  useEffect(() => {
    fetchServices();
  }, [fetchServices]);

  const filtered = services.filter((s) => {
    if (statusFilter === 'active' && !s.is_active) return false;
    if (statusFilter === 'inactive' && s.is_active) return false;
    return true;
  });

  const { selected, toggleSelect, toggleAll, clearSelection, selectedCount, selectedRows, allSelected } =
    useRowSelection({ data: filtered, getId: (s) => s.id });

  const checkboxCol = useMemo(
    () => createCheckboxColumn<ApplicationService>(selected, toggleSelect, (s) => s.id),
    [selected, toggleSelect],
  );

  const handleExportCSV = () => {
    exportToCSV(selectedRows as unknown as Record<string, unknown>[], [
      { key: 'name', header: 'Service Name' },
      { key: 'default_rate_per_acre_cents', header: 'Rate (cents)' },
      { key: 'cost_per_acre_cents', header: 'Cost (cents)' },
      { key: 'is_active', header: 'Active' },
    ], 'application_services');
    toast('success', `Exported ${selectedRows.length} service(s) to CSV`);
  };

  const handleExportPDF = async () => {
    setExporting(true);
    try {
      await downloadReportPdf({
        title: 'Application Services',
        subtitle: `${selectedRows.length} service(s) selected`,
        columns: [
          { header: 'Service', key: 'name' },
          { header: 'Rate/Acre', key: 'default_rate_per_acre_cents', align: 'right', format: (v) => v ? formatCentsPerAcre(Number(v)) : '-' },
          { header: 'Cost/Acre', key: 'cost_per_acre_cents', align: 'right', format: (v) => v ? formatCentsPerAcre(Number(v)) : '-' },
          { header: 'Active', key: 'is_active', format: (v) => v ? 'Yes' : 'No' },
        ],
        data: selectedRows as unknown as Record<string, unknown>[],
        orientation: 'landscape',
      });
      toast('success', `Downloaded PDF with ${selectedRows.length} service(s)`);
    } catch (err: unknown) {
      toast('error', sanitizeError(err));
    }
    setExporting(false);
  };

  const handleBulkDelete = async () => {
    setDeleting(true);
    try {
      const ids = selectedRows.map((s) => s.id);
      const result = await supabase.from('application_services').delete().in('id', ids).select();
      checkMutationResult(result, 'Delete application services');
      toast('success', `Deleted ${ids.length} service(s)`);
      clearSelection();
      fetchServices();
    } catch (err: unknown) {
      toast('error', sanitizeError(err));
    }
    setDeleting(false);
    setDeleteModalOpen(false);
  };

  const bulkActions = [
    { key: 'csv', label: 'Export CSV', icon: <Download className="w-4 h-4" />, onClick: handleExportCSV },
    { key: 'pdf', label: 'Download PDF', icon: <FileText className="w-4 h-4" />, onClick: handleExportPDF, loading: exporting },
    { key: 'delete', label: 'Delete', icon: <Trash2 className="w-4 h-4" />, onClick: () => setDeleteModalOpen(true), variant: 'danger' as const },
  ];

  const dataColumns: Column<ApplicationService>[] = [
    {
      key: 'name',
      header: 'Service',
      sortable: true,
      render: (r) => (
        <button
          onClick={() => navigate(`/application-services/${r.id}`)}
          className="flex items-center gap-2 font-medium text-nav-dark hover:text-crx-green transition-colors"
        >
          <Wrench className="w-4 h-4 text-gray-500" />
          {r.name}
        </button>
      ),
    },
    {
      key: 'vehicle' as keyof ApplicationService,
      header: 'Vehicle',
      sortable: false,
      render: (r) => r.vehicle?.vehicle_name || <span className="text-secondary">-</span>,
    },
    {
      key: 'default_rate_per_acre_cents',
      header: 'Rate/Acre',
      sortable: true,
      render: (r) => (
        <span className="font-mono text-sm">{formatCentsPerAcre(r.default_rate_per_acre_cents)}</span>
      ),
    },
    {
      key: 'cost_per_acre_cents',
      header: 'Cost/Acre',
      sortable: true,
      render: (r) => (
        <span className="font-mono text-sm text-secondary">{formatCentsPerAcre(r.cost_per_acre_cents)}</span>
      ),
    },
    {
      key: 'is_active',
      header: 'Status',
      sortable: true,
      render: (r) => (
        <Badge variant={r.is_active ? 'success' : ('default' as BadgeVariant)}>
          {r.is_active ? 'Active' : 'Inactive'}
        </Badge>
      ),
    },
  ];

  const columns = canBulkAction ? [checkboxCol, ...dataColumns] : dataColumns;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div className="flex-1 flex items-center gap-3">
          <SplitHeading title="Application" accent="Services" />
          {canBulkAction && (
            <BulkActionBar selectedCount={selectedCount} actions={bulkActions} onDeselectAll={clearSelection} />
          )}
        </div>
        {role === 'admin' && (
          <Button
            icon={<Plus className="w-4 h-4" />}
            onClick={() => navigate('/application-services/new')}
          >
            New Service
          </Button>
        )}
      </div>

      {/* Filters */}
      <div className="flex gap-3">
        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value as 'active' | 'inactive' | '')}
          aria-label="Filter by status"
          className="px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green"
        >
          <option value="">All Statuses</option>
          <option value="active">Active</option>
          <option value="inactive">Inactive</option>
        </select>
        {canBulkAction && filtered.length > 0 && (
          <button
            onClick={toggleAll}
            className="px-3 py-2 text-xs font-medium text-secondary hover:text-nav-dark transition-colors"
          >
            {allSelected ? 'Deselect All' : 'Select All'}
          </button>
        )}
      </div>

      <Card padding={false}>
        <div className="p-5">
          <DataTable<ApplicationService>
            data={filtered}
            columns={columns}
            searchable
            searchPlaceholder="Search services..."
            searchKeys={['name']}
            emptyTitle="No application services"
            emptyDescription="Add your first application service to get started."
            loading={loading}
          />
        </div>
      </Card>

      <BulkDeleteConfirmModal
        open={deleteModalOpen}
        onClose={() => setDeleteModalOpen(false)}
        count={selectedCount}
        entityName="application service"
        onConfirm={handleBulkDelete}
        loading={deleting}
      />
    </div>
  );
}
