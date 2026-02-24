import { useEffect, useState, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { Plus, Download, FileText, Trash2 } from 'lucide-react';
import Card from '../components/ui/Card';
import Button from '../components/ui/Button';
import Badge, { type BadgeVariant } from '../components/ui/Badge';
import DataTable, { type Column } from '../components/ui/DataTable';
import BulkActionBar from '../components/ui/BulkActionBar';
import BulkDeleteConfirmModal from '../components/ui/BulkDeleteConfirmModal';
import SplitHeading from '../components/ui/SplitHeading';
import { useToast } from '../components/ui/Toast';
import { useAuth } from '../contexts/AuthContext';
import { supabase } from '../lib/db';
import { useRowSelection, createCheckboxColumn } from '../hooks/useRowSelection';
import { exportToCSV, fmtCSV, fmtDateCSV } from '../lib/csvExport';
import { downloadReportPdf, type ReportPdfColumn } from '../lib/reportPdf';
import { sanitizeError } from '../lib/errorSanitizer';
import type { Job, JobStatus } from '../types';

type JobRow = Job & {
  customer_name: string;
  applicator_name: string;
  vehicle_name: string;
  field_count: number;
};

const statusVariant: Record<JobStatus, BadgeVariant> = {
  scheduled: 'info',
  in_progress: 'warning',
  completed: 'success',
  cancelled: 'default',
  invoiced: 'success',
};

function getPresetDates(preset: string): { start: string; end: string } {
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth();

  switch (preset) {
    case 'today':
      return { start: now.toISOString().split('T')[0], end: now.toISOString().split('T')[0] };
    case 'this_week': {
      const dayOfWeek = now.getDay();
      const startOfWeek = new Date(now);
      startOfWeek.setDate(now.getDate() - dayOfWeek);
      const endOfWeek = new Date(startOfWeek);
      endOfWeek.setDate(startOfWeek.getDate() + 6);
      return { start: startOfWeek.toISOString().split('T')[0], end: endOfWeek.toISOString().split('T')[0] };
    }
    case 'this_season':
      if (month >= 6) {
        return { start: `${year}-07-01`, end: `${year + 1}-06-30` };
      } else {
        return { start: `${year - 1}-07-01`, end: `${year}-06-30` };
      }
    default:
      return { start: '', end: '' };
  }
}

export default function Jobs() {
  const navigate = useNavigate();
  const { toast } = useToast();
  const { role } = useAuth();
  const [jobs, setJobs] = useState<JobRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState<JobStatus | ''>('');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [customerFilter, setCustomerFilter] = useState('');
  const [customers, setCustomers] = useState<{ id: string; farm_name: string }[]>([]);
  const [deleteModalOpen, setDeleteModalOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [exporting, setExporting] = useState(false);

  const canBulkAction = role === 'admin' || role === 'sales_rep';
  const DELETABLE: JobStatus[] = ['scheduled', 'in_progress', 'completed'];

  useEffect(() => {
    fetchCustomers();
  }, []);

  useEffect(() => {
    fetchJobs();
  }, [statusFilter, startDate, endDate, customerFilter]);

  const fetchCustomers = async () => {
    const { data } = await supabase
      .from('customers')
      .select('id, farm_name')
      .eq('is_active', true)
      .order('farm_name');
    setCustomers((data || []) as { id: string; farm_name: string }[]);
  };

  const fetchJobs = async () => {
    setLoading(true);
    let query = supabase
      .from('jobs')
      .select(`
        *,
        customer:customers(farm_name),
        applicator:profiles!jobs_applicator_id_fkey(full_name),
        vehicle:vehicles(vehicle_name),
        job_fields(id)
      `)
      .is('deleted_at', null)
      .order('job_date', { ascending: false })
      .limit(500);

    if (statusFilter) query = query.eq('status', statusFilter);
    if (startDate) query = query.gte('job_date', startDate);
    if (endDate) query = query.lte('job_date', endDate);
    if (customerFilter) query = query.eq('customer_id', customerFilter);

    const { data, error } = await query;

    if (error) {
      console.error('Failed to load jobs:', error.message);
      toast('error', 'Failed to load jobs');
      setLoading(false);
      return;
    }

    const rows = ((data || []) as Array<Record<string, unknown> & { customer?: { farm_name?: string }; applicator?: { full_name?: string }; vehicle?: { vehicle_name?: string }; job_fields?: unknown[] }>).map((j) => ({
      ...j,
      customer_name: j.customer?.farm_name || 'Unknown',
      applicator_name: j.applicator?.full_name || '-',
      vehicle_name: j.vehicle?.vehicle_name || '-',
      field_count: Array.isArray(j.job_fields) ? j.job_fields.length : 0,
    })) as unknown as JobRow[];
    setJobs(rows);
    setLoading(false);
  };

  const applyPreset = (preset: string) => {
    if (preset === 'all') {
      setStartDate('');
      setEndDate('');
    } else {
      const { start, end } = getPresetDates(preset);
      setStartDate(start);
      setEndDate(end);
    }
  };

  const { selected, toggleSelect, toggleAll, clearSelection, selectedCount, selectedRows, allSelected } =
    useRowSelection({
      data: jobs,
      getId: (j) => j.id,
      isSelectable: (j) => DELETABLE.includes(j.status),
    });

  const checkboxCol = useMemo(
    () => createCheckboxColumn<JobRow>(selected, toggleSelect, (j) => j.id, (j) => DELETABLE.includes(j.status)),
    [selected, toggleSelect]
  );

  const fmtCents = (cents: number) =>
    `$${(cents / 100).toLocaleString(undefined, { minimumFractionDigits: 2 })}`;

  const handleExportCSV = () => {
    exportToCSV(selectedRows as unknown as Record<string, unknown>[], [
      { key: 'job_number', header: 'Job #' },
      { key: 'job_date', header: 'Date', format: (v) => fmtDateCSV(v as string) },
      { key: 'status', header: 'Status' },
      { key: 'customer_name', header: 'Customer' },
      { key: 'applicator_name', header: 'Applicator' },
      { key: 'total_acres', header: 'Acres', format: (v) => fmtCSV(v as number) },
      { key: 'vehicle_name', header: 'Vehicle' },
      { key: 'total_price_cents', header: 'Price', format: (v) => v ? fmtCSV((v as number) / 100) : '' },
    ], 'jobs');
    toast('success', `Exported ${selectedRows.length} job(s) to CSV`);
  };

  const handleExportPDF = async () => {
    setExporting(true);
    try {
      const pdfCols: ReportPdfColumn[] = [
        { header: 'Job #', key: 'job_number' },
        { header: 'Date', key: 'job_date', format: (v) => v ? new Date(String(v)).toLocaleDateString() : '-' },
        { header: 'Status', key: 'status' },
        { header: 'Customer', key: 'customer_name' },
        { header: 'Applicator', key: 'applicator_name' },
        { header: 'Acres', key: 'total_acres', align: 'right', format: (v) => v ? Number(v).toLocaleString() : '-' },
        { header: 'Price', key: 'total_price_cents', align: 'right', format: (v) => v ? fmtCents(Number(v)) : '-' },
      ];
      await downloadReportPdf({
        title: 'Job Schedule',
        subtitle: `${selectedRows.length} job(s) selected`,
        columns: pdfCols,
        data: selectedRows as unknown as Record<string, unknown>[],
      });
      toast('success', `Downloaded PDF with ${selectedRows.length} job(s)`);
    } catch (err) {
      toast('error', sanitizeError(err));
    }
    setExporting(false);
  };

  const handleDelete = async () => {
    setDeleting(true);
    try {
      const ids = selectedRows.map((j) => j.id);
      const { error } = await supabase
        .from('jobs')
        .update({ deleted_at: new Date().toISOString() })
        .in('id', ids);
      if (error) {
        toast('error', sanitizeError(error));
      } else {
        toast('success', `Deleted ${ids.length} job(s)`);
        clearSelection();
        fetchJobs();
      }
    } catch (err) {
      toast('error', sanitizeError(err));
    }
    setDeleting(false);
    setDeleteModalOpen(false);
  };

  const bulkActions = [
    { key: 'csv', label: 'Export CSV', icon: <Download className="w-4 h-4" />, onClick: handleExportCSV },
    { key: 'pdf', label: 'Download PDF', icon: <FileText className="w-4 h-4" />, onClick: handleExportPDF, loading: exporting },
    { key: 'delete', label: 'Delete Jobs', icon: <Trash2 className="w-4 h-4" />, onClick: () => setDeleteModalOpen(true), variant: 'danger' as const },
  ];

  const dataColumns: Column<JobRow>[] = [
    {
      key: 'job_number',
      header: 'Job #',
      sortable: true,
      render: (r) => (
        <button
          onClick={() => navigate(`/jobs/${r.id}`)}
          className="font-medium text-nav-dark font-mono text-xs hover:text-crx-green transition-colors"
        >
          {r.job_number}
        </button>
      ),
    },
    {
      key: 'job_date',
      header: 'Date',
      sortable: true,
      render: (r) => new Date(r.job_date).toLocaleDateString(),
    },
    {
      key: 'status',
      header: 'Status',
      sortable: true,
      render: (r) => <Badge variant={statusVariant[r.status]}>{r.status.replace('_', ' ')}</Badge>,
    },
    {
      key: 'customer_name',
      header: 'Customer',
      sortable: true,
      render: (r) => <span className="font-medium">{r.customer_name}</span>,
    },
    {
      key: 'applicator_name',
      header: 'Applicator',
      sortable: true,
    },
    {
      key: 'field_count',
      header: 'Fields',
      sortable: true,
      render: (r) => (
        <Badge variant={r.field_count > 0 ? 'info' : 'default'}>
          {r.field_count} field{r.field_count !== 1 ? 's' : ''}
        </Badge>
      ),
    },
    {
      key: 'total_acres',
      header: 'Acres',
      sortable: true,
      render: (r) => r.total_acres?.toLocaleString() || '-',
    },
    {
      key: 'vehicle_name',
      header: 'Vehicle',
      sortable: true,
    },
    {
      key: 'total_price_cents',
      header: 'Price',
      sortable: true,
      render: (r) => r.total_price_cents ? `$${(r.total_price_cents / 100).toLocaleString(undefined, { minimumFractionDigits: 2 })}` : '-',
    },
  ];

  const columns = canBulkAction ? [checkboxCol, ...dataColumns] : dataColumns;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div className="flex-1 flex items-center gap-3">
          <SplitHeading title="Job" accent="Schedule" />
          {canBulkAction && (
            <BulkActionBar
              selectedCount={selectedCount}
              actions={bulkActions}
              onDeselectAll={clearSelection}
            />
          )}
        </div>
        <Button
          icon={<Plus className="w-4 h-4" />}
          onClick={() => navigate('/jobs/new')}
        >
          New Job
        </Button>
      </div>

      {/* Filters */}
      <Card>
        <div className="flex flex-wrap items-end gap-3">
          <div>
            <label className="block text-xs font-medium text-secondary mb-1">Start Date</label>
            <input
              type="date"
              value={startDate}
              onChange={(e) => setStartDate(e.target.value)}
              className="px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-secondary mb-1">End Date</label>
            <input
              type="date"
              value={endDate}
              onChange={(e) => setEndDate(e.target.value)}
              className="px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-secondary mb-1">Status</label>
            <select
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value as JobStatus | '')}
              aria-label="Filter by status"
              className="px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green"
            >
              <option value="">All Statuses</option>
              <option value="scheduled">Scheduled</option>
              <option value="in_progress">In Progress</option>
              <option value="completed">Completed</option>
              <option value="invoiced">Invoiced</option>
              <option value="cancelled">Cancelled</option>
            </select>
          </div>
          <div>
            <label className="block text-xs font-medium text-secondary mb-1">Customer</label>
            <select
              value={customerFilter}
              onChange={(e) => setCustomerFilter(e.target.value)}
              aria-label="Filter by customer"
              className="px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green"
            >
              <option value="">All Customers</option>
              {customers.map((c) => (
                <option key={c.id} value={c.id}>{c.farm_name}</option>
              ))}
            </select>
          </div>
          <div className="flex gap-1.5">
            {[
              { key: 'all', label: 'All' },
              { key: 'today', label: 'Today' },
              { key: 'this_week', label: 'This Week' },
              { key: 'this_season', label: 'This Season' },
            ].map((preset) => (
              <button
                key={preset.key}
                onClick={() => applyPreset(preset.key)}
                className="px-3 py-2 text-xs font-medium rounded-lg border border-gray-200 hover:bg-crx-green-tint hover:border-crx-green hover:text-crx-green transition-colors"
              >
                {preset.label}
              </button>
            ))}
          </div>
        </div>
      </Card>

      <Card padding={false}>
        <div className="p-5">
          <DataTable
            data={jobs as unknown as Record<string, unknown>[]}
            columns={columns as unknown as Column<Record<string, unknown>>[]}
            searchable
            searchPlaceholder="Search jobs..."
            searchKeys={['job_number', 'customer_name', 'applicator_name']}
            emptyTitle="No jobs found"
            emptyDescription="Create your first job to get started with scheduling."
            loading={loading}
            filters={
              canBulkAction && jobs.length > 0 ? (
                <button
                  onClick={toggleAll}
                  className="px-3 py-2 text-xs font-medium text-secondary hover:text-nav-dark transition-colors"
                >
                  {allSelected ? 'Deselect All' : 'Select All'}
                </button>
              ) : undefined
            }
          />
        </div>
      </Card>

      <BulkDeleteConfirmModal
        open={deleteModalOpen}
        onClose={() => setDeleteModalOpen(false)}
        count={selectedCount}
        entityName="job"
        onConfirm={handleDelete}
        loading={deleting}
      />
    </div>
  );
}
