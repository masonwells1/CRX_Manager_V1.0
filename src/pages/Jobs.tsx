import { useEffect, useState, useMemo, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { Plus, Download, FileText, Trash2, ChevronDown, ChevronRight, Tag, Tags, Search, SlidersHorizontal, Users } from 'lucide-react';
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
import GroundCrewsManager from '../components/jobs/GroundCrewsManager';
import MultiSelectDropdown, { type MultiSelectOption } from '../components/jobs/MultiSelectDropdown';
import {
  type JobFilters,
  type JobFilterFacts,
  emptyJobFilters,
  isJobFiltersEmpty,
  activeJobFilterCount,
  jobMatchesClientFilters,
} from '../components/jobs/jobFilters';
import type { Job, JobStatus, JobTag, GroundCrew } from '../types';

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
  /** Field-app parity #6: joined facts the client-side filters read. */
  counties: string[];
  states: string[];
  chemicalNames: string[];
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
  // Field-app parity #6: the FULL filter set, AND-combined. Two copies:
  //   - `draft` is what the user edits in the bar.
  //   - `applied` is what actually drives the query + the visibleJobs memo.
  // SEARCH copies draft -> applied; CLEAR ALL resets both. Filters do NOT
  // auto-run (matches ChemMan's explicit SEARCH / CLEAR ALL FILTERS controls).
  const [draft, setDraft] = useState<JobFilters>(emptyJobFilters);
  const [applied, setApplied] = useState<JobFilters>(emptyJobFilters);
  const [showMore, setShowMore] = useState(false);
  // Reference lists for the multi-select pickers.
  const [customers, setCustomers] = useState<{ id: string; farm_name: string }[]>([]);
  const [applicators, setApplicators] = useState<{ id: string; full_name: string }[]>([]);
  const [vehicles, setVehicles] = useState<{ id: string; vehicle_name: string }[]>([]);
  const [appServices, setAppServices] = useState<{ id: string; name: string }[]>([]);
  const [crews, setCrews] = useState<GroundCrew[]>([]);
  // Field-app parity #4: tag catalog (drives the Job Tags multi-select filter).
  const [allTags, setAllTags] = useState<JobTag[]>([]);
  const [manageTagsOpen, setManageTagsOpen] = useState(false);
  const [bulkTagsOpen, setBulkTagsOpen] = useState(false);
  const [manageCrewsOpen, setManageCrewsOpen] = useState(false);
  const [deleteModalOpen, setDeleteModalOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [exporting, setExporting] = useState(false);
  // Per-row expander state, keyed "<jobId>:<field>" (customers | locations).
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  // Tiny setters that patch a single field on the draft filter object.
  const patchDraft = useCallback(<K extends keyof JobFilters>(key: K, value: JobFilters[K]) => {
    setDraft((prev) => ({ ...prev, [key]: value }));
  }, []);

  const toggleExpanded = useCallback((key: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  }, []);

  const canBulkAction = role === 'admin' || role === 'sales_rep';

  // Field-app parity #6: load every reference list the filter pickers need in
  // one shot (customers, applicators, vehicles, application-service "types").
  const fetchReferenceLists = useCallback(async () => {
    const [custRes, applRes, vehRes, svcRes] = await Promise.all([
      supabase.from('customers').select('id, farm_name').eq('is_active', true).order('farm_name'),
      // Applicator picker only uses id + full_name; safe via the public profile view.
      supabase.from('profile_public_view').select('id, full_name')
        .in('role', ['applicator', 'admin', 'sales_rep']).eq('is_active', true).order('full_name'),
      supabase.from('vehicles').select('id, vehicle_name').eq('status', 'active').order('vehicle_name'),
      supabase.from('application_services').select('id, name').eq('is_active', true).order('sort_order'),
    ]);
    setCustomers((custRes.data || []) as { id: string; farm_name: string }[]);
    setApplicators(((applRes.data || []) as { id: string | null; full_name: string | null }[])
      .filter((a) => a.id).map((a) => ({ id: a.id as string, full_name: a.full_name ?? '—' })));
    setVehicles((vehRes.data || []) as { id: string; vehicle_name: string }[]);
    setAppServices((svcRes.data || []) as { id: string; name: string }[]);
  }, []);

  // Field-app parity #6: ground crews drive the Ground Crew filter + manager.
  const fetchCrews = useCallback(async () => {
    const { data, error } = await supabase
      .from('ground_crews')
      .select('*')
      .eq('is_active', true)
      .order('name');
    if (error) {
      Sentry.captureException(error, { tags: { source: 'fetch', action: 'load_ground_crews' } });
      return;
    }
    setCrews((data || []) as GroundCrew[]);
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
    // Field-app parity #6: county/state pulled on the joined field so the
    // client-side County/State filters can read them.
    let query = supabase
      .from('jobs')
      .select(`
        *,
        customer:customers(farm_name, account_number),
        vehicle:vehicles(vehicle_name),
        job_fields(crop, field:fields(field_name, crop_type, county, state)),
        job_chemicals(rate_per_acre, rate_unit, product:products(product_name)),
        job_field_shares(customer_id, split_pct, is_primary, customer:customers(farm_name, account_number)),
        job_tag_assignments(tag:job_tags(id, name, color, created_by, created_at, updated_at))
      `)
      .is('deleted_at', null)
      .order('job_date', { ascending: false })
      .limit(500);

    // ---- SERVER-side filters (indexed scalar columns on jobs) ----
    if (applied.statuses.length > 0) query = query.in('status', applied.statuses);
    if (applied.startDate) query = query.gte('job_date', applied.startDate);
    if (applied.endDate) query = query.lte('job_date', applied.endDate);
    if (applied.jobNumber.trim()) query = query.ilike('job_number', `%${applied.jobNumber.trim()}%`);
    if (applied.applicatorIds.length > 0) query = query.in('applicator_id', applied.applicatorIds);
    if (applied.vehicleIds.length > 0) query = query.in('vehicle_id', applied.vehicleIds);
    if (applied.typeIds.length > 0) query = query.in('application_service_id', applied.typeIds);
    if (applied.groundCrewIds.length > 0) query = query.in('ground_crew_id', applied.groundCrewIds);
    // Customer filter is applied SERVER-side (before the 500-row limit) and matches
    // the primary jobs.customer_id OR any job carrying a per-field share for one of
    // the selected customers — so an older job billed to a share customer isn't
    // truncated away (Codex). Pull the share job_ids first, then OR them in.
    if (applied.customerIds.length > 0) {
      const { data: shareJobs } = await supabase
        .from('job_field_shares')
        .select('job_id')
        .in('customer_id', applied.customerIds);
      const shareJobIds = [...new Set(((shareJobs || []) as { job_id: string }[]).map((s) => s.job_id))];
      const custList = applied.customerIds.join(',');
      query = shareJobIds.length > 0
        ? query.or(`customer_id.in.(${custList}),id.in.(${shareJobIds.join(',')})`)
        : query.in('customer_id', applied.customerIds);
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
      job_fields?: Array<{ crop?: string | null; field?: { field_name?: string; crop_type?: string | null; county?: string | null; state?: string | null } }>;
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

      // Field-app parity #6: joined facts the client-side filters read.
      const counties = [...new Set(
        (j.job_fields || []).map((f) => f.field?.county).filter(Boolean) as string[]
      )];
      const states = [...new Set(
        (j.job_fields || []).map((f) => f.field?.state).filter(Boolean) as string[]
      )];
      const chemicalNames = [...new Set(chemicals.map((c) => c.product_name))];

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
        counties,
        states,
        chemicalNames,
      };
    });
    setJobs(rows);
    setLoading(false);
  }, [applied, toast]);

  useEffect(() => {
    fetchReferenceLists();
    fetchTags();
    fetchCrews();
  }, [fetchReferenceLists, fetchTags, fetchCrews]);

  // Refetch only when the APPLIED filters change (SEARCH / CLEAR ALL / preset).
  useEffect(() => {
    fetchJobs();
  }, [fetchJobs]);

  // SEARCH: commit the draft to the applied filters (triggers the query).
  const runSearch = useCallback(() => {
    setApplied(draft);
  }, [draft]);

  // CLEAR ALL: reset BOTH draft and applied back to empty (criterion #3).
  const clearAll = useCallback(() => {
    setDraft(emptyJobFilters);
    setApplied(emptyJobFilters);
    setShowMore(false);
  }, []);

  // Date presets write the draft AND apply immediately (a one-click shortcut).
  const applyPreset = (preset: string) => {
    const range = preset === 'all' ? { start: '', end: '' } : getPresetDates(preset);
    const next = { ...draft, startDate: range.start, endDate: range.end };
    setDraft(next);
    setApplied(next);
  };

  // Field-app parity #6: the CLIENT-side filters (job tags, crop, county, state,
  // chemical, field name) AND-combine over the joined data already pulled. They
  // run on top of the server filters (status/customer/date/applicator/vehicle/
  // type/crew/job#) so a job must clear EVERY active filter. The table, totals,
  // and selection all read this single filtered view so they never disagree
  // (criteria #2 + #5 + #6).
  const visibleJobs = useMemo(() => {
    return jobs.filter((j) => {
      const facts: JobFilterFacts = {
        tagIds: new Set(j.jobTags.map((t) => t.id)),
        crops: j.crops,
        counties: j.counties,
        states: j.states,
        chemicals: j.chemicalNames,
        fieldNames: j.locations,
      };
      return jobMatchesClientFilters(facts, applied);
    });
  }, [jobs, applied]);

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

  // Field-app parity #6: multi-select option lists for the filter pickers.
  const customerOptions: MultiSelectOption[] = useMemo(
    () => customers.map((c) => ({ value: c.id, label: c.farm_name })), [customers]);
  const applicatorOptions: MultiSelectOption[] = useMemo(
    () => applicators.map((a) => ({ value: a.id, label: a.full_name })), [applicators]);
  const vehicleOptions: MultiSelectOption[] = useMemo(
    () => vehicles.map((v) => ({ value: v.id, label: v.vehicle_name })), [vehicles]);
  const typeOptions: MultiSelectOption[] = useMemo(
    () => appServices.map((s) => ({ value: s.id, label: s.name })), [appServices]);
  const crewOptions: MultiSelectOption[] = useMemo(
    () => crews.map((c) => ({ value: c.id, label: c.name })), [crews]);
  const tagOptions: MultiSelectOption[] = useMemo(
    () => allTags.map((t) => ({ value: t.id, label: t.name, color: t.color })), [allTags]);
  const statusOptions: MultiSelectOption[] = useMemo(() => [
    { value: 'scheduled', label: 'Scheduled' },
    { value: 'in_progress', label: 'In Progress' },
    { value: 'completed', label: 'Completed' },
    { value: 'invoiced', label: 'Invoiced' },
    { value: 'cancelled', label: 'Cancelled' },
  ], []);

  const activeCount = activeJobFilterCount(applied);
  const draftDirty = JSON.stringify(draft) !== JSON.stringify(applied);

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
            <>
              <Button
                variant="secondary"
                icon={<Users className="w-4 h-4" />}
                onClick={() => setManageCrewsOpen(true)}
                showChevron={false}
              >
                Crews
              </Button>
              <Button
                variant="secondary"
                icon={<Tags className="w-4 h-4" />}
                onClick={() => setManageTagsOpen(true)}
                showChevron={false}
              >
                Manage Tags
              </Button>
            </>
          )}
          <Button
            icon={<Plus className="w-4 h-4" />}
            onClick={() => navigate('/jobs/new')}
          >
            New Job
          </Button>
        </div>
      </div>

      {/* Field-app parity #6: full filter set, AND-combined. Primary filters on
          the first row; secondary filters behind a MORE expander. An explicit
          SEARCH applies the draft; CLEAR ALL resets everything. */}
      <Card>
        <div className="space-y-3">
          {/* Primary row */}
          <div className="flex flex-wrap items-end gap-3">
            <div>
              <label className="block text-xs font-medium text-secondary mb-1">Job #</label>
              <input
                type="text"
                value={draft.jobNumber}
                onChange={(e) => patchDraft('jobNumber', e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && runSearch()}
                placeholder="Job number"
                aria-label="Filter by job number"
                className="w-32 px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green"
              />
            </div>
            <MultiSelectDropdown
              label="Customers"
              options={customerOptions}
              selected={draft.customerIds}
              onChange={(v) => patchDraft('customerIds', v)}
              placeholder="All Customers"
              emptyText="No customers"
            />
            <MultiSelectDropdown
              label="Applicators"
              options={applicatorOptions}
              selected={draft.applicatorIds}
              onChange={(v) => patchDraft('applicatorIds', v)}
              placeholder="All Applicators"
              emptyText="No applicators"
            />
            <div>
              <label className="block text-xs font-medium text-secondary mb-1">Start Date</label>
              <input
                type="date"
                value={draft.startDate}
                onChange={(e) => patchDraft('startDate', e.target.value)}
                aria-label="Schedule date from"
                className="px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-secondary mb-1">End Date</label>
              <input
                type="date"
                value={draft.endDate}
                onChange={(e) => patchDraft('endDate', e.target.value)}
                aria-label="Schedule date to"
                className="px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green"
              />
            </div>
            <MultiSelectDropdown
              label="Job Tags"
              options={tagOptions}
              selected={draft.tagIds}
              onChange={(v) => patchDraft('tagIds', v)}
              placeholder="All Tags"
              emptyText="No tags yet"
            />
            <div className="flex items-end gap-1.5">
              <Button icon={<Search className="w-4 h-4" />} onClick={runSearch} showChevron={false}>
                Search{draftDirty ? ' *' : ''}
              </Button>
              <button
                type="button"
                onClick={clearAll}
                disabled={activeCount === 0 && isJobFiltersEmpty(draft)}
                className="px-3 py-2 text-xs font-medium rounded-lg border border-gray-200 text-secondary hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              >
                Clear All
              </button>
              <button
                type="button"
                onClick={() => setShowMore((s) => !s)}
                className="flex items-center gap-1 px-3 py-2 text-xs font-medium rounded-lg border border-gray-200 hover:bg-crx-green-tint hover:border-crx-green hover:text-crx-green transition-colors"
              >
                <SlidersHorizontal className="w-3.5 h-3.5" />
                {showMore ? 'Less' : 'More'}
                {showMore ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
              </button>
            </div>
          </div>

          {/* Secondary row (MORE expander) */}
          {showMore && (
            <div className="flex flex-wrap items-end gap-3 border-t border-gray-100 pt-3">
              <MultiSelectDropdown
                label="Status"
                options={statusOptions}
                selected={draft.statuses}
                onChange={(v) => patchDraft('statuses', v)}
                placeholder="All Statuses"
              />
              <MultiSelectDropdown
                label="Type"
                options={typeOptions}
                selected={draft.typeIds}
                onChange={(v) => patchDraft('typeIds', v)}
                placeholder="All Types"
                emptyText="No application services"
              />
              <MultiSelectDropdown
                label="Vehicle"
                options={vehicleOptions}
                selected={draft.vehicleIds}
                onChange={(v) => patchDraft('vehicleIds', v)}
                placeholder="All Vehicles"
                emptyText="No vehicles"
              />
              <MultiSelectDropdown
                label="Ground Crew"
                options={crewOptions}
                selected={draft.groundCrewIds}
                onChange={(v) => patchDraft('groundCrewIds', v)}
                placeholder="All Crews"
                emptyText="No crews yet"
              />
              <div>
                <label className="block text-xs font-medium text-secondary mb-1">Crop</label>
                <input
                  type="text"
                  value={draft.crop}
                  onChange={(e) => patchDraft('crop', e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && runSearch()}
                  placeholder="Crop"
                  aria-label="Filter by crop"
                  className="w-28 px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-secondary mb-1">Chemical</label>
                <input
                  type="text"
                  value={draft.chemical}
                  onChange={(e) => patchDraft('chemical', e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && runSearch()}
                  placeholder="Product"
                  aria-label="Filter by chemical"
                  className="w-32 px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-secondary mb-1">Field Name</label>
                <input
                  type="text"
                  value={draft.fieldName}
                  onChange={(e) => patchDraft('fieldName', e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && runSearch()}
                  placeholder="Field"
                  aria-label="Filter by field name"
                  className="w-32 px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-secondary mb-1">County</label>
                <input
                  type="text"
                  value={draft.county}
                  onChange={(e) => patchDraft('county', e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && runSearch()}
                  placeholder="County"
                  aria-label="Filter by county"
                  className="w-28 px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-secondary mb-1">State</label>
                <input
                  type="text"
                  value={draft.state}
                  onChange={(e) => patchDraft('state', e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && runSearch()}
                  placeholder="State"
                  aria-label="Filter by state"
                  className="w-20 px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green"
                />
              </div>
            </div>
          )}

          {/* Quick date presets + active-filter summary */}
          <div className="flex flex-wrap items-center justify-between gap-2 border-t border-gray-100 pt-3">
            <div className="flex gap-1.5">
              {[
                { key: 'all', label: 'All' },
                { key: 'today', label: 'Today' },
                { key: 'this_week', label: 'This Week' },
                { key: 'this_season', label: 'This Season' },
              ].map((preset) => (
                <button
                  key={preset.key}
                  type="button"
                  onClick={() => applyPreset(preset.key)}
                  className="px-3 py-2 text-xs font-medium rounded-lg border border-gray-200 hover:bg-crx-green-tint hover:border-crx-green hover:text-crx-green transition-colors"
                >
                  {preset.label}
                </button>
              ))}
            </div>
            {activeCount > 0 && (
              <span className="inline-flex items-center gap-1 text-xs font-medium text-crx-green">
                <Tag className="w-3 h-3" />
                {activeCount} active filter{activeCount !== 1 ? 's' : ''}
              </span>
            )}
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

      {/* Field-app parity #6: ground crews manager (the Ground Crew filter's
          managed list). */}
      <GroundCrewsManager
        open={manageCrewsOpen}
        onClose={() => setManageCrewsOpen(false)}
        crews={crews}
        onChanged={() => { fetchCrews(); fetchJobs(); }}
      />
    </div>
  );
}
