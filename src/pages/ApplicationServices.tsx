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
import { supabase, sanitizeError, checkMutationResult, assertRpcResult } from '../lib/db';
import { Sentry } from '../lib/sentry';
import { exportToCSV } from '../lib/csvExport';
import { downloadReportPdf } from '../lib/reportPdf';
import type { ApplicationServiceWithCost } from '../types';

// Every column of application_services EXCEPT cost_per_acre_cents. Migration
// 20260729015706 revoked that column from `authenticated`, so `select('*')` here
// would now fail outright. ApplicationServiceDetail.tsx holds a same-named
// constant listing a NARROWER subset (it has no use for the audit columns) —
// deliberately not shared, because the two pages read different things; the only
// rule both must keep is that cost_per_acre_cents never appears in either.
const SERVICE_COLUMNS = 'id, name, vehicle_id, default_rate_per_acre_cents, is_active, sort_order, created_by, created_at, updated_at';

// Money: all pricing stored as bigint cents, displayed / 100
const formatCentsPerAcre = (cents: number) =>
  `$${(cents / 100).toFixed(2)}/ac`;

export default function ApplicationServices() {
  const navigate = useNavigate();
  const { toast } = useToast();
  const { role } = useAuth();
  const [services, setServices] = useState<ApplicationServiceWithCost[]>([]);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState<'active' | 'inactive' | ''>('');
  const [deleteModalOpen, setDeleteModalOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [exporting, setExporting] = useState(false);

  const isAdmin = role === 'admin';
  const canBulkAction = isAdmin;

  const fetchServices = useCallback(async () => {
    setLoading(true);
    const { data, error } = await supabase
      .from('application_services')
      .select(`${SERVICE_COLUMNS}, vehicle:vehicles(vehicle_name)`)
      .order('sort_order');

    if (error) {
      Sentry.captureException(error, { tags: { source: 'fetch', action: 'load_application_services' } });
      toast('error', 'Failed to load application services');
      setLoading(false);
      return;
    }

    // cost_per_acre_cents is admin-only at the column-grant level (migration
    // 20260729015706) and never arrives on the table read. Merge it in from the
    // admin-gated RPC so the table, CSV and PDF keep showing it for admins.
    //
    // ADMINS ONLY. The RPC raises 42501 for every other role, so calling it
    // unconditionally would fire a guaranteed-denied request on every driver and
    // sales-rep page load, capture a Sentry exception and toast an error about a
    // column they were never meant to see. Non-admins get cost = UNKNOWN (null),
    // which the table below renders as '-'.
    //
    // A cost-fetch failure is reported but NOT fatal: the services list still
    // renders, with cost left UNKNOWN (null), not zero. Blanking the whole page
    // over the one admin-only column would be a worse outcome than showing the
    // page without it -- and it is what makes the deploy order safe, since this
    // build ships before the migration that creates the RPC exists. Falling back
    // to 0 instead would be worse than either: every row would read "$0.00/ac"
    // and the CSV and PDF exports below would carry that zero as though it were
    // real, handing an admin a margin report showing 100% margin on everything.
    //
    // The whole merge is inside try/catch because assertRpcResult THROWS on a
    // null payload. Uncaught, that throw would escape fetchServices, skip the
    // setLoading(false) below and leave the page spinning its skeleton forever.
    const costById = new Map<string, number>();
    if (isAdmin) {
      // No p_service_id -> the RPC's DEFAULT NULL, meaning "every service".
      const { data: costRows, error: costError } = await supabase
        .rpc('admin_get_application_service_costs', {});
      try {
        if (costError) throw costError;
        for (const row of assertRpcResult<{ service_id: string; cost_per_acre_cents: number }[]>(
          costRows, 'admin_get_application_service_costs',
        )) {
          costById.set(row.service_id, row.cost_per_acre_cents);
        }
      } catch (costErr: unknown) {
        Sentry.captureException(costErr, { tags: { source: 'fetch', action: 'load_application_service_costs' } });
        toast('error', 'Failed to load application service costs');
      }
    }

    setServices(((data || []) as unknown as ApplicationServiceWithCost[]).map((s) => ({
      ...s,
      cost_per_acre_cents: costById.get(s.id) ?? null,
    })));
    setLoading(false);
  }, [toast, isAdmin]);

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
    () => createCheckboxColumn<ApplicationServiceWithCost>(selected, toggleSelect, (s) => s.id),
    [selected, toggleSelect],
  );

  const handleExportCSV = () => {
    exportToCSV(selectedRows as unknown as Record<string, unknown>[], [
      { key: 'name', header: 'Service Name' },
      { key: 'default_rate_per_acre_cents', header: 'Rate (cents)' },
      // A null cost (the RPC failed) exports as an EMPTY cell, not 0 --
      // formatCSVCell maps null to "". Empty is what we want: a spreadsheet
      // won't sum it or average it into a margin, whereas a 0 silently would.
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
          // Tested against null/undefined rather than truthiness: a real cost of
          // 0 is a fact worth printing, and an unread cost must never print as
          // a figure. `v ? … : '-'` would collapse both into '-'.
          { header: 'Cost/Acre', key: 'cost_per_acre_cents', align: 'right', format: (v) => v === null || v === undefined ? '-' : formatCentsPerAcre(Number(v)) },
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
      // .select() with no argument is select=* — which, after migration 20260729015706
      // revoked cost_per_acre_cents from `authenticated`, makes the RETURNING clause
      // demand a column this role no longer has and fails the whole delete. Name the
      // one column checkMutationResult actually needs.
      const result = await supabase.from('application_services').delete().in('id', ids).select('id');
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

  const dataColumns: Column<ApplicationServiceWithCost>[] = [
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
      key: 'vehicle' as keyof ApplicationServiceWithCost,
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
        <span className="font-mono text-sm text-secondary">
          {r.cost_per_acre_cents === null ? '-' : formatCentsPerAcre(r.cost_per_acre_cents)}
        </span>
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

  // Non-admins never receive cost_per_acre_cents -- the column grant is revoked and
  // the RPC above is not called for them -- so the column would be a wall of '-'.
  // Drop it rather than advertise a figure they cannot see.
  const visibleColumns = isAdmin
    ? dataColumns
    : dataColumns.filter((c) => c.key !== 'cost_per_acre_cents');
  const columns = canBulkAction ? [checkboxCol, ...visibleColumns] : visibleColumns;

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
          <DataTable<ApplicationServiceWithCost>
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
