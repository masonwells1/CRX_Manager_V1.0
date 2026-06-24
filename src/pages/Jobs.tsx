import { useEffect, useState, useMemo, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { Plus, Download, FileText, Trash2, ChevronDown, ChevronRight, Tag, Tags, X } from 'lucide-react';
import Card from '../components/ui/Card';
import Button from '../components/ui/Button';
import Badge, { type BadgeVariant } from '../components/ui/Badge';
import DataTable, { type Column } from '../components/ui/DataTable';
import BulkActionBar from '../components/ui/BulkActionBar';
import BulkDeleteConfirmModal from '../components/ui/BulkDeleteConfirmModal';
import SplitHeading from '../components/ui/SplitHeading';
import { useToast } from '../components/ui/Toast';
import { useAuth } from '../contexts/AuthContext';
import { supabase, checkMutationResult } from '../lib/db';
import { useRowSelection, createCheckboxColumn } from '../hooks/useRowSelection';
import { exportToCSV, fmtCSV, fmtDateCSV } from '../lib/csvExport';
import { downloadReportPdf, type ReportPdfColumn } from '../lib/reportPdf';
import { sanitizeError } from '../lib/errorSanitizer';
import { Sentry } from '../lib/sentry';
import { getSeasonDates } from '../utils/season';
import { localToday, formatLocalDate, parseLocalDate } from '../lib/dateUtils';
import { SkeletonTable } from '../components/ui/Skeleton';
import JobTagChip from '../components/jobs/JobTagChip';
import JobTagsManager from '../components/jobs/JobTagsManager';
import JobTagsBulkModal from '../components/jobs/JobTagsBulkModal';
import { jobMatchesTagFilter } from '../components/jobs/jobTagFilter';
import type { Job, JobStatus, JobTag } from '../types';

interface JobChemSummary {
  product_name: string;
  rate_per_acre: number | null;
  rate_unit: string | null;
}

interface JobCustomerSummary {
  customer_name: string;
  account_number: string | null;
}

type JobRow = Job & {
  customer_name: string;
  applicator_name: string;
  vehicle_name: string;
  field_count: number;
  /** All billed customers (primary + shared) with their account IDs. */
  customers: JobCustomerSummary[];
  /** Flattened "name (account)" text of all billed customers — drives search. */
  customers_search: string;
  /** Field/location names on the job. */
  locations: string[];
  /** Distinct crops across the job's fields. */
  crops: string[];
  /** Chemicals with rate + unit. */
  chemicals: JobChemSummary[];
  created_by_name: string;
  updated_by_name: string;
  /** Color-coded tags assigned to this job (field-app parity #4). */
  jobTags: JobTag[];
};

const statusVariant: Record<JobStatus, BadgeVariant> = {
  scheduled: 'info',
  in_progress: 'warning',
  completed: 'success',
  cancelled: 'default',
  invoiced: 'success',
};

// How many overflow chips before the "Click for full list" expander appears.
const OVERFLOW_LIMIT = 2;

// Crop season = October 1 to September 30
function getPresetDates(preset: string): { start: string; end: string } {
  const now = new Date();

  switch (preset) {
    case 'today':
      return { start: localToday(), end: localToday() };
    case 'this_week': {
      const dayOfWeek = now.getDay();
      const startOfWeek = new Date(now);
      startOfWeek.setDate(now.getDate() - dayOfWeek);
      const endOfWeek = new Date(startOfWeek);
      endOfWeek.setDate(startOfWeek.getDate() + 6);
      return { start: formatLocalDate(startOfWeek), end: formatLocalDate(endOfWeek) };
    }
    case 'this_season':
      return getSeasonDates(now);
    default:
      return { start: '', end: '' };
  }
}

const DELETABLE: JobStatus[] = ['scheduled', 'in_progress', 'completed'];

/** Expander chip list: shows up to OVERFLOW_LIMIT then "+N — Click for full list". */
function OverflowChips({ items, expanded, onToggle, jobId, field }: {
  items: string[];
  expanded: boolean;
  onToggle: (key: string) => void;
  jobId: string;
  field: string;
}) {
  if (items.length === 0) return <span className="text-secondary">-</span>;
  const visible = expanded ? items : items.slice(0, OVERFLOW_LIMIT);
  const hidden = items.length - visible.length;
  return (
    <div className="flex flex-wrap items-center gap-1">
      {visible.map((it, i) => (
        <span key={i} className="inline-block px-1.5 py-0.5 text-xs bg-gray-100 rounded">{it}</span>
      ))}
      {!expanded && hidden > 0 && (
        <button
          onClick={() => onToggle(`${jobId}:${field}`)}
          className="inline-flex items-center gap-0.5 px-1.5 py-0.5 text-xs font-medium text-crx-green hover:underline"
        >
          <ChevronRight className="w-3 h-3" />+{hidden} — Click for full list
        </button>
      )}
      {expanded && items.length > OVERFLOW_LIMIT && (
        <button
          onClick={() => onToggle(`${jobId}:${field}`)}
          className="inline-flex items-center gap-0.5 px-1.5 py-0.5 text-xs font-medium text-secondary hover:underline"
        >
          <ChevronDown className="w-3 h-3" />Show less
        </button>
      )}
    </div>
  );
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
  // Field-app parity #4: tag catalog + the Job Tags multi-select filter.
  const [allTags, setAllTags] = useState<JobTag[]>([]);
  const [tagFilter, setTagFilter] = useState<string[]>([]);
  const [manageTagsOpen, setManageTagsOpen] = useState(false);
  const [bulkTagsOpen, setBulkTagsOpen] = useState(false);
  const [deleteModalOpen, setDeleteModalOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [exporting, setExporting] = useState(false);
  // Per-row expander state, keyed "<jobId>:<field>" (customers | locations).
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const toggleExpanded = useCallback((key: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  }, []);

  const canBulkAction = role === 'admin' || role === 'sales_rep';

  const fetchCustomers = useCallback(async () => {
    const { data } = await supabase
      .from('customers')
      .select('id, farm_name')
      .eq('is_active', true)
      .order('farm_name');
    setCustomers((data || []) as { id: string; farm_name: string }[]);
  }, []);

  // Field-app parity #4: load the full tag catalog for the filter + managers.
  const fetchTags = useCallback(async () => {
    const { data, error } = await supabase
      .from('job_tags')
      .select('*')
      .order('name');
    if (error) {
      Sentry.captureException(error, { tags: { source: 'fetch', action: 'load_job_tags' } });
      return;
    }
    setAllTags((data || []) as JobTag[]);
  }, []);

  const fetchJobs = useCallback(async () => {
    setLoading(true);
    // PR-07 follow-up: dropped applicator FK embed; resolve via profile_public_view.
    let query = supabase
      .from('jobs')
      .select(`
        *,
        customer:customers(farm_name, account_number),
        vehicle:vehicles(vehicle_name),
        job_fields(crop, field:fields(field_name, crop_type)),
        job_chemicals(rate_per_acre, rate_unit, product:products(product_name)),
        job_field_shares(customer_id, split_pct, is_primary, customer:customers(farm_name, account_number)),
        job_tag_assignments(tag:job_tags(id, name, color, created_by, created_at, updated_at))
      `)
      .is('deleted_at', null)
      .order('job_date', { ascending: false })
      .limit(500);

    if (statusFilter) query = query.eq('status', statusFilter);
    if (startDate) query = query.gte('job_date', startDate);
    if (endDate) query = query.lte('job_date', endDate);
    // Customer filter is applied SERVER-side (before the 500-row limit) and matches
    // the primary jobs.customer_id OR any job carrying a per-field share for that
    // customer — so an older job billed to a share customer isn't truncated away
    // (Codex). Pull the share job_ids first, then OR them into the main query.
    if (customerFilter) {
      const { data: shareJobs } = await supabase
        .from('job_field_shares')
        .select('job_id')
        .eq('customer_id', customerFilter);
      const shareJobIds = [...new Set(((shareJobs || []) as { job_id: string }[]).map((s) => s.job_id))];
      query = shareJobIds.length > 0
        ? query.or(`customer_id.eq.${customerFilter},id.in.(${shareJobIds.join(',')})`)
        : query.eq('customer_id', customerFilter);
    }

    const { data, error } = await query;

    if (error) {
      Sentry.captureException(error, { tags: { source: 'fetch', action: 'load_jobs' } });
      toast('error', 'Failed to load jobs');
      setLoading(false);
      return;
    }

    // Resolve applicator + created/updated-by names via the public profile view.
    type RawJob = Record<string, unknown> & {
      customer?: { farm_name?: string; account_number?: string | null };
      vehicle?: { vehicle_name?: string };
      job_fields?: Array<{ crop?: string | null; field?: { field_name?: string; crop_type?: string | null } }>;
      job_chemicals?: Array<{ rate_per_acre?: number | null; rate_unit?: string | null; product?: { product_name?: string } }>;
      job_field_shares?: Array<{ customer_id: string; split_pct: number; is_primary: boolean; customer?: { farm_name?: string; account_number?: string | null } }>;
      job_tag_assignments?: Array<{ tag?: JobTag | null }>;
      applicator_id?: string | null;
      created_by?: string | null;
      updated_by?: string | null;
    };
    const raw = (data || []) as RawJob[];

    const profileIds = [...new Set(
      raw.flatMap((j) => [j.applicator_id, j.created_by, j.updated_by]).filter(Boolean) as string[]
    )];
    const nameMap: Record<string, string> = {};
    if (profileIds.length > 0) {
      const { data: profs } = await supabase
        .from('profile_public_view')
        .select('id, full_name')
        .in('id', profileIds);
      (profs || []).forEach((a: { id: string | null; full_name: string | null }) => { if (a.id) nameMap[a.id] = a.full_name ?? ''; });
    }

    const rows: JobRow[] = raw.map((j) => {
      // Billed customers: prefer the per-field shares (multi-customer); else the
      // single job customer. Dedup by name+account.
      const shareCustomers = (j.job_field_shares || [])
        .map((s) => s.customer)
        .filter(Boolean) as { farm_name?: string; account_number?: string | null }[];
      const custMap = new Map<string, JobCustomerSummary>();
      shareCustomers.forEach((c) => {
        const name = c.farm_name || 'Unknown';
        custMap.set(`${name}|${c.account_number ?? ''}`, { customer_name: name, account_number: c.account_number ?? null });
      });
      if (custMap.size === 0 && j.customer) {
        const name = j.customer.farm_name || 'Unknown';
        custMap.set(`${name}|${j.customer.account_number ?? ''}`, { customer_name: name, account_number: j.customer.account_number ?? null });
      }
      const jobCustomers = [...custMap.values()];
      // Flattened customer text so the table search matches a DISPLAYED share
      // customer, not only the primary jobs.customer_id (Codex).
      const customersSearch = jobCustomers
        .map((c) => c.account_number ? `${c.customer_name} ${c.account_number}` : c.customer_name)
        .join(' ');

      const locations = (j.job_fields || [])
        .map((f) => f.field?.field_name)
        .filter(Boolean) as string[];

      const crops = [...new Set(
        (j.job_fields || [])
          .map((f) => f.crop || f.field?.crop_type)
          .filter(Boolean) as string[]
      )];

      const chemicals: JobChemSummary[] = (j.job_chemicals || []).map((c) => ({
        product_name: c.product?.product_name || 'Product',
        rate_per_acre: c.rate_per_acre ?? null,
        rate_unit: c.rate_unit ?? null,
      }));

      const jobTags = (j.job_tag_assignments || [])
        .map((a) => a.tag)
        .filter(Boolean) as JobTag[];
      jobTags.sort((a, b) => a.name.localeCompare(b.name));

      return {
        ...(j as unknown as Job),
        customer_name: j.customer?.farm_name || 'Unknown',
        applicator_name: j.applicator_id ? nameMap[j.applicator_id] || '-' : '-',
        vehicle_name: j.vehicle?.vehicle_name || '-',
        field_count: Array.isArray(j.job_fields) ? j.job_fields.length : 0,
        customers: jobCustomers,
        customers_search: customersSearch,
        locations,
        crops,
        chemicals,
        created_by_name: j.created_by ? nameMap[j.created_by] || '-' : '-',
        updated_by_name: j.updated_by ? nameMap[j.updated_by] || '-' : '-',
        jobTags,
      };
    });
    setJobs(rows);
    setLoading(false);
  }, [statusFilter, startDate, endDate, customerFilter, toast]);

  useEffect(() => {
    fetchCustomers();
    fetchTags();
  }, [fetchCustomers, fetchTags]);

  useEffect(() => {
    fetchJobs();
  }, [statusFilter, startDate, endDate, customerFilter, fetchJobs]);

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

  // Field-app parity #4: the Job Tags filter is applied CLIENT-side (tags ride
  // along on the joined query) and AND-combines with the server filters above —
  // a job must already have survived status/customer/date, then carry at least
  // one selected tag. The table, totals, and selection all read this filtered
  // view so they never disagree (criterion #6).
  const visibleJobs = useMemo(
    () => jobs.filter((j) => jobMatchesTagFilter(j.jobTags.map((t) => t.id), tagFilter)),
    [jobs, tagFilter]
  );

  // jobId -> set of assigned tag ids, for the bulk modal's starting state.
  const assignmentsByJob = useMemo(() => {
    const map = new Map<string, Set<string>>();
    for (const j of jobs) {
      map.set(j.id, new Set(j.jobTags.map((t) => t.id)));
    }
    return map;
  }, [jobs]);

  const { selected, toggleSelect, toggleAll, clearSelection, selectedCount, selectedRows, allSelected } =
    useRowSelection({
      data: visibleJobs,
      getId: (j) => j.id,
      isSelectable: (j) => DELETABLE.includes(j.status),
    });

  const checkboxCol = useMemo(
    () => createCheckboxColumn<JobRow>(selected, toggleSelect, (j) => j.id, (j) => DELETABLE.includes(j.status)),
    [selected, toggleSelect]
  );

  const fmtCents = (cents: number) =>
    `$${(cents / 100).toLocaleString(undefined, { minimumFractionDigits: 2 })}`;

  // Bottom totals row: sum total + remaining acres across the CURRENTLY-LISTED
  // (filtered) jobs. DataTable filters its own search client-side, so we total
  // the fetched/filtered set the page is showing (criterion #2).
  const totals = useMemo(() => {
    return visibleJobs.reduce(
      (acc, j) => {
        acc.totalAcres += j.total_acres || 0;
        acc.remainingAcres += j.remaining_acres ?? (j.total_acres || 0);
        return acc;
      },
      { totalAcres: 0, remainingAcres: 0 }
    );
  }, [visibleJobs]);

  const handleExportCSV = () => {
    exportToCSV(selectedRows as unknown as Record<string, unknown>[], [
      { key: 'job_number', header: 'Job #' },
      { key: 'job_date', header: 'Date', format: (v) => fmtDateCSV(v as string) },
      { key: 'status', header: 'Status' },
      { key: 'customer_name', header: 'Customer' },
      { key: 'applicator_name', header: 'Applicator' },
      { key: 'total_acres', header: 'Total Acres', format: (v) => fmtCSV(v as number) },
      { key: 'remaining_acres', header: 'Remaining Acres', format: (v) => fmtCSV(v as number) },
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
        { header: 'Tot. ac', key: 'total_acres', align: 'right', format: (v) => v ? Number(v).toLocaleString() : '-' },
        { header: 'Rem. ac', key: 'remaining_acres', align: 'right', format: (v) => v != null ? Number(v).toLocaleString() : '-' },
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
      const result = await supabase
        .from('jobs')
        .update({ deleted_at: new Date().toISOString() })
        .in('id', ids)
        .select();
      checkMutationResult(result, 'Delete jobs');
      toast('success', `Deleted ${ids.length} job(s)`);
      clearSelection();
      fetchJobs();
    } catch (err) {
      toast('error', sanitizeError(err));
    }
    setDeleting(false);
    setDeleteModalOpen(false);
  };

  const bulkActions = [
    { key: 'tags', label: 'Edit Job Tags', icon: <Tag className="w-4 h-4" />, onClick: () => setBulkTagsOpen(true) },
    { key: 'csv', label: 'Export CSV', icon: <Download className="w-4 h-4" />, onClick: handleExportCSV },
    { key: 'pdf', label: 'Download PDF', icon: <FileText className="w-4 h-4" />, onClick: handleExportPDF, loading: exporting },
    { key: 'delete', label: 'Delete Jobs', icon: <Trash2 className="w-4 h-4" />, onClick: () => setDeleteModalOpen(true), variant: 'danger' as const },
  ];

  const dataColumns: Column<JobRow>[] = [
    {
      // Color-coded job tags (field-app parity #4). Each chip uses its tag's
      // chosen color; a job can carry multiple tags. Overflow past 3 collapses
      // to "+N" to keep the row compact.
      key: 'jobTags',
      header: 'Tags',
      render: (r) => (
        r.jobTags.length === 0 ? (
          <span className="text-secondary">-</span>
        ) : (
          <div className="flex flex-wrap gap-1 max-w-[14rem]">
            {r.jobTags.slice(0, 3).map((t) => (
              <JobTagChip key={t.id} tag={t} />
            ))}
            {r.jobTags.length > 3 && (
              <span className="text-xs text-secondary self-center">+{r.jobTags.length - 3}</span>
            )}
          </div>
        )
      ),
    },
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
      key: 'customer_name',
      header: 'Customers',
      sortable: true,
      render: (r) => (
        <OverflowChips
          items={r.customers.map((c) => c.account_number ? `${c.customer_name} (${c.account_number})` : c.customer_name)}
          expanded={expanded.has(`${r.id}:customers`)}
          onToggle={toggleExpanded}
          jobId={r.id}
          field="customers"
        />
      ),
    },
    {
      key: 'locations',
      header: 'Locations',
      render: (r) => (
        <OverflowChips
          items={r.locations}
          expanded={expanded.has(`${r.id}:locations`)}
          onToggle={toggleExpanded}
          jobId={r.id}
          field="locations"
        />
      ),
    },
    {
      key: 'applicator_name',
      header: 'Applicators',
      sortable: true,
    },
    {
      key: 'crops',
      header: 'Crops',
      render: (r) => r.crops.length > 0 ? r.crops.join(', ') : <span className="text-secondary">-</span>,
    },
    {
      key: 'chemicals',
      header: 'Chemicals',
      render: (r) => (
        r.chemicals.length === 0 ? <span className="text-secondary">-</span> : (
          <div className="space-y-0.5">
            {r.chemicals.slice(0, 3).map((c, i) => (
              <div key={i} className="text-xs whitespace-nowrap">
                {c.product_name}
                {c.rate_per_acre != null && (
                  <span className="text-secondary"> — {c.rate_per_acre}{c.rate_unit ? ` ${c.rate_unit}` : ''}</span>
                )}
              </div>
            ))}
            {r.chemicals.length > 3 && (
              <div className="text-xs text-secondary">+{r.chemicals.length - 3} more</div>
            )}
          </div>
        )
      ),
    },
    {
      key: 'total_acres',
      header: 'Tot. ac',
      sortable: true,
      className: 'text-right tabular-nums',
      render: (r) => r.total_acres?.toLocaleString() || '-',
    },
    {
      key: 'remaining_acres',
      header: 'Rem. ac',
      sortable: true,
      className: 'text-right tabular-nums',
      render: (r) => (r.remaining_acres ?? r.total_acres)?.toLocaleString() || '-',
    },
    {
      // "Scheduled" = job_date — the SAME date the Start/End filters and the
      // CSV/PDF export use, so the column, filter, and export never disagree
      // (Codex). schedule_date is a separate planning sub-field on the editor.
      key: 'job_date',
      header: 'Scheduled',
      sortable: true,
      render: (r) => r.job_date ? parseLocalDate(r.job_date).toLocaleDateString() : '-',
    },
    {
      key: 'status',
      header: 'Status',
      sortable: true,
      render: (r) => <Badge variant={statusVariant[r.status]}>{r.status.replace('_', ' ')}</Badge>,
    },
    {
      key: 'created_by_name',
      header: 'Created By',
      sortable: true,
      render: (r) => <span className="text-xs">{r.created_by_name}</span>,
    },
    {
      key: 'updated_by_name',
      header: 'Updated By',
      sortable: true,
      render: (r) => <span className="text-xs">{r.updated_by_name}</span>,
    },
    {
      key: 'printed_at',
      header: 'Printed',
      sortable: true,
      render: (r) => r.printed_at
        ? <Badge variant="success">Printed</Badge>
        : <Badge variant="default">Not printed</Badge>,
    },
  ];

  const columns = canBulkAction ? [checkboxCol, ...dataColumns] : dataColumns;

  if (loading) {
    return (
      <div className="p-6">
        <SkeletonTable rows={8} />
      </div>
    );
  }

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
        <div className="flex items-center gap-2">
          {canBulkAction && (
            <Button
              variant="secondary"
              icon={<Tags className="w-4 h-4" />}
              onClick={() => setManageTagsOpen(true)}
              showChevron={false}
            >
              Manage Tags
            </Button>
          )}
          <Button
            icon={<Plus className="w-4 h-4" />}
            onClick={() => navigate('/jobs/new')}
          >
            New Job
          </Button>
        </div>
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
          {/* Field-app parity #4: Job Tags multi-select. AND-combines with the
              filters above (a job must pass them all) and narrows to jobs
              carrying any selected tag. */}
          <div>
            <label className="block text-xs font-medium text-secondary mb-1">Job Tags</label>
            <details className="relative group">
              <summary className="flex items-center gap-2 px-3 py-2 text-sm border border-gray-200 rounded-lg cursor-pointer list-none hover:border-crx-green min-w-[10rem]">
                <Tag className="w-3.5 h-3.5 text-secondary" />
                <span className={tagFilter.length === 0 ? 'text-secondary' : 'text-nav-dark'}>
                  {tagFilter.length === 0 ? 'All Tags' : `${tagFilter.length} selected`}
                </span>
              </summary>
              <div className="absolute z-20 mt-1 w-56 max-h-64 overflow-y-auto bg-white border border-gray-200 rounded-lg shadow-lg p-2 space-y-0.5">
                {allTags.length === 0 ? (
                  <p className="text-xs text-secondary px-2 py-3 text-center">No tags yet</p>
                ) : (
                  <>
                    {tagFilter.length > 0 && (
                      <button
                        onClick={() => setTagFilter([])}
                        className="w-full flex items-center gap-1.5 px-2 py-1.5 text-xs font-medium text-secondary hover:bg-gray-50 rounded"
                      >
                        <X className="w-3 h-3" /> Clear tag filter
                      </button>
                    )}
                    {allTags.map((t) => {
                      const checked = tagFilter.includes(t.id);
                      return (
                        <label
                          key={t.id}
                          className="flex items-center gap-2 px-2 py-1.5 rounded hover:bg-gray-50 cursor-pointer"
                        >
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={() =>
                              setTagFilter((prev) =>
                                checked ? prev.filter((id) => id !== t.id) : [...prev, t.id]
                              )
                            }
                            className="rounded border-gray-300 text-crx-green focus:ring-crx-green/30"
                          />
                          <span className="w-2.5 h-2.5 rounded-full flex-shrink-0" style={{ backgroundColor: t.color }} aria-hidden="true" />
                          <span className="text-sm text-nav-dark">{t.name}</span>
                        </label>
                      );
                    })}
                  </>
                )}
              </div>
            </details>
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
            data={visibleJobs as unknown as Record<string, unknown>[]}
            columns={columns as unknown as Column<Record<string, unknown>>[]}
            searchable
            searchPlaceholder="Search jobs..."
            searchKeys={['job_number', 'customers_search', 'applicator_name']}
            emptyTitle="No jobs found"
            emptyDescription="Create your first job to get started with scheduling."
            loading={loading}
            filters={
              canBulkAction && visibleJobs.length > 0 ? (
                <button
                  onClick={toggleAll}
                  className="px-3 py-2 text-xs font-medium text-secondary hover:text-nav-dark transition-colors"
                >
                  {allSelected ? 'Deselect All' : 'Select All'}
                </button>
              ) : undefined
            }
          />
          {/* Bottom totals row — sums the currently-listed jobs (criterion #2). */}
          {visibleJobs.length > 0 && (
            <div className="mt-3 flex items-center justify-end gap-6 border-t pt-3 text-sm font-semibold text-nav-dark">
              <span>{visibleJobs.length} job{visibleJobs.length !== 1 ? 's' : ''}</span>
              <span>Tot. ac: <span className="tabular-nums">{totals.totalAcres.toLocaleString(undefined, { maximumFractionDigits: 1 })}</span></span>
              <span>Rem. ac: <span className="tabular-nums">{totals.remainingAcres.toLocaleString(undefined, { maximumFractionDigits: 1 })}</span></span>
            </div>
          )}
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

      {/* Field-app parity #4: tag catalog manager + bulk tag editor. */}
      <JobTagsManager
        open={manageTagsOpen}
        onClose={() => setManageTagsOpen(false)}
        tags={allTags}
        onChanged={() => { fetchTags(); fetchJobs(); }}
      />
      <JobTagsBulkModal
        open={bulkTagsOpen}
        onClose={() => setBulkTagsOpen(false)}
        selectedJobIds={selectedRows.map((j) => j.id)}
        tags={allTags}
        assignmentsByJob={assignmentsByJob}
        onManageTags={() => { setBulkTagsOpen(false); setManageTagsOpen(true); }}
        onApplied={() => fetchJobs()}
      />
    </div>
  );
}
