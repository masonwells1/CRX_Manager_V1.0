import { useEffect, useState, useMemo, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { Plus, Download, FileText, Trash2, ChevronDown, ChevronRight, Tag, Tags, Search, SlidersHorizontal, Users, Layers, Pencil, Settings2, Truck, FlaskConical, ClipboardList, PackageOpen, Beaker } from 'lucide-react';
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
import { logActivity } from '../lib/activityLogger';
import { useRowSelection, createCheckboxColumn } from '../hooks/useRowSelection';
import { exportToCSV, fmtCSV, fmtDateCSV } from '../lib/csvExport';
import { downloadReportPdf, type ReportPdfColumn } from '../lib/reportPdf';
import { fetchLoaderWorksheetData } from '../lib/loaderWorksheetFetch';
import { generateLoaderWorksheetBatchPdf, generateLoaderWorksheetPdf } from '../lib/loaderWorksheetPdf';
import { fetchChemicalApplicationReportData } from '../lib/chemicalApplicationReportFetch';
import { generateChemicalApplicationReportPdf } from '../lib/chemicalApplicationReportPdf';
import { fetchChemicalSummaryData } from '../lib/chemicalSummaryReportFetch';
import { buildChemicalSummaryReportData, chemicalSummaryCsvRows } from '../lib/chemicalSummaryReportData';
import { generateChemicalSummaryReportPdf } from '../lib/chemicalSummaryReportPdf';
import { fetchProjectedUseData } from '../lib/projectedUseReportFetch';
import { buildProjectedUseReportData, projectedUseCsvRows } from '../lib/projectedUseReportData';
import { generateProjectedUseReportPdf } from '../lib/projectedUseReportPdf';
import { fetchMasterMixSummaryData } from '../lib/masterMixSummaryFetch';
import { buildMasterMixSummaryData } from '../lib/masterMixSummaryData';
import { generateMasterMixSummaryPdf } from '../lib/masterMixSummaryPdf';
import { sanitizeError } from '../lib/errorSanitizer';
import { Sentry } from '../lib/sentry';
import { getSeasonDates } from '../utils/season';
import { localToday, formatLocalDate, parseLocalDate } from '../lib/dateUtils';
import { SkeletonTable } from '../components/ui/Skeleton';
import JobTagChip from '../components/jobs/JobTagChip';
import JobTagsManager from '../components/jobs/JobTagsManager';
import JobTagsBulkModal from '../components/jobs/JobTagsBulkModal';
import GroundCrewsManager from '../components/jobs/GroundCrewsManager';
import JobBatchesManager from '../components/jobs/JobBatchesManager';
import JobBatchAssignModal from '../components/jobs/JobBatchAssignModal';
import JobMassEditModal from '../components/jobs/JobMassEditModal';
import ListSettingsModal from '../components/jobs/ListSettingsModal';
import {
  JOBS_LIST_KEY,
  defaultJobListSettings,
  mergeJobListSettings,
  orderedVisibleColumnIds,
  type JobListSettings,
} from '../components/jobs/jobListColumns';
import MultiSelectDropdown, { type MultiSelectOption } from '../components/jobs/MultiSelectDropdown';
import {
  type JobFilters,
  type JobFilterFacts,
  emptyJobFilters,
  isJobFiltersEmpty,
  activeJobFilterCount,
  jobMatchesClientFilters,
} from '../components/jobs/jobFilters';
import type { Job, JobStatus, JobTag, GroundCrew, JobBatch } from '../types';
import type { Json } from '../types/supabase';

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
  /** Primary customer's phone (List Settings "Customer Phone" column). */
  customer_phone: string | null;
  /** Field/location names on the job. */
  locations: string[];
  /** Distinct crops across the job's fields. */
  crops: string[];
  /** Chemicals with rate + unit. */
  chemicals: JobChemSummary[];
  created_by_name: string;
  updated_by_name: string;
  /** Field-app parity #9: resolved name of who last printed this job. */
  last_printed_by_name: string;
  /** Color-coded tags assigned to this job (field-app parity #4). */
  jobTags: JobTag[];
  /** Field-app parity #6: joined facts the client-side filters read. */
  counties: string[];
  states: string[];
  chemicalNames: string[];
  /** Field-app parity #3: the named batch this job belongs to (null = none). */
  batch_name: string | null;
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

// Which job statuses may be soft-DELETED. `invoiced` and `cancelled` are NOT
// deletable — an invoiced job is billed history and must never be removable from
// the list. The Delete bulk action re-filters the selection to this set at click
// time, so broadening REPORTABLE below can never make an invoiced job deletable.
const DELETABLE: JobStatus[] = ['scheduled', 'in_progress', 'completed'];

// Which job statuses may be SELECTED for a bulk report/export (Chemical Summary,
// Loader Worksheet, Chemical Application Report, CSV/PDF). This is DECOUPLED from
// DELETABLE: the office wants the finished/billed work in a usage summary, so
// `invoiced` is reportable even though it can't be deleted. `cancelled` is left
// OUT — a cancelled job has no real usage, so excluding it from the summary (and
// from the Excluded list) is correct.
const REPORTABLE: JobStatus[] = ['scheduled', 'in_progress', 'completed', 'invoiced'];

// Which job statuses may be MUTATED by a bulk edit (Mass Edit, Add to Batch, Edit
// Job Tags). Same set as DELETABLE: a billed (`invoiced`) or `cancelled` job is
// finished history and must not have its schedule/applicator/batch/tags rewritten.
// Because REPORTABLE broadened checkbox selection to include `invoiced` (so it can
// be summarized/exported), the mutating actions MUST re-filter the selection to
// this set — otherwise broadening selection would silently make billed jobs
// editable again (Codex). Read-only report/export actions intentionally keep the
// full REPORTABLE selection.
const EDITABLE: JobStatus[] = DELETABLE;

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
  const { role, profile } = useAuth();
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
  // Field-app parity #3: batch catalog (drives the Batch filter + assign modal).
  const [allBatches, setAllBatches] = useState<JobBatch[]>([]);
  // Field-app parity #4: tag catalog (drives the Job Tags multi-select filter).
  const [allTags, setAllTags] = useState<JobTag[]>([]);
  const [manageTagsOpen, setManageTagsOpen] = useState(false);
  const [bulkTagsOpen, setBulkTagsOpen] = useState(false);
  const [manageCrewsOpen, setManageCrewsOpen] = useState(false);
  const [manageBatchesOpen, setManageBatchesOpen] = useState(false);
  const [assignBatchOpen, setAssignBatchOpen] = useState(false);
  const [massEditOpen, setMassEditOpen] = useState(false);
  const [deleteModalOpen, setDeleteModalOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [exporting, setExporting] = useState(false);
  // Field-app parity #10: bulk Loader Worksheet PDF over the selected jobs.
  const [loaderExporting, setLoaderExporting] = useState(false);
  // Field-app parity #12: bulk Chemical Summary Report (cross-job per-product totals).
  const [summaryExporting, setSummaryExporting] = useState(false);
  const [projectedExporting, setProjectedExporting] = useState(false);
  // Field-app parity #14: bulk Master Mix Summary (combined tank mix + per-capacity loads).
  const [masterMixExporting, setMasterMixExporting] = useState(false);
  // #10: per-row Loader Worksheet print in progress (the job id being generated).
  const [rowLoaderId, setRowLoaderId] = useState<string | null>(null);
  // #11: per-row Chemical Application Report print in progress (job id being generated).
  const [rowChemReportId, setRowChemReportId] = useState<string | null>(null);
  // Per-row expander state, keyed "<jobId>:<field>" (customers | locations).
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  // Field-app parity #8: per-user List Settings (which columns show + whether
  // completed jobs appear). Loaded from user_list_settings (RLS-scoped to the
  // signed-in user); defaults until a saved row arrives. We only persist on an
  // explicit user change in the modal, so a fresh load never clobbers a saved
  // row with defaults.
  const [listSettings, setListSettings] = useState<JobListSettings>(defaultJobListSettings);
  const [listSettingsOpen, setListSettingsOpen] = useState(false);
  const [savingSettings, setSavingSettings] = useState(false);

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

  // Field-app parity #3: load the full batch catalog for the filter + managers.
  const fetchBatches = useCallback(async () => {
    const { data, error } = await supabase
      .from('job_batches')
      .select('*')
      .order('name');
    if (error) {
      Sentry.captureException(error, { tags: { source: 'fetch', action: 'load_job_batches' } });
      return;
    }
    setAllBatches((data || []) as JobBatch[]);
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

  // Field-app parity #8: load THIS user's saved job-list layout. RLS guarantees
  // the row (if any) belongs to the signed-in user, so a different user gets
  // their own row or — with none — the defaults via mergeJobListSettings.
  const fetchListSettings = useCallback(async () => {
    if (!profile?.id) return;
    const { data, error } = await supabase
      .from('user_list_settings')
      .select('settings')
      .eq('user_id', profile.id)
      .eq('list_key', JOBS_LIST_KEY)
      .maybeSingle();
    if (error) {
      // Non-fatal: fall back to defaults and let the user re-pick. Don't block
      // the page on a preferences read.
      Sentry.captureException(error, { tags: { source: 'fetch', action: 'load_list_settings' } });
    }
    setListSettings(mergeJobListSettings(data?.settings));
  }, [profile?.id]);

  // Persist a new layout for this user (upsert on the (user_id, list_key) key).
  // Applies immediately in the UI; the write is best-effort with a toast on
  // failure so the user knows it didn't stick.
  const persistListSettings = useCallback(async (next: JobListSettings) => {
    if (!profile?.id) return;
    setSavingSettings(true);
    const result = await supabase
      .from('user_list_settings')
      .upsert(
        {
          user_id: profile.id,
          list_key: JOBS_LIST_KEY,
          // JobListSettings is plain serializable data (string[] + boolean).
          settings: next as unknown as Json,
        },
        { onConflict: 'user_id,list_key' }
      )
      .select();
    if (result.error) {
      Sentry.captureException(result.error, { tags: { source: 'mutation', action: 'save_list_settings' } });
      toast('error', 'Could not save your list settings');
    }
    setSavingSettings(false);
  }, [profile?.id, toast]);

  // Apply + persist in one call from the modal.
  const updateListSettings = useCallback((next: JobListSettings) => {
    setListSettings(next);
    void persistListSettings(next);
  }, [persistListSettings]);

  const fetchJobs = useCallback(async () => {
    setLoading(true);
    // PR-07 follow-up: dropped applicator FK embed; resolve via profile_public_view.
    // Field-app parity #6: county/state pulled on the joined field so the
    // client-side County/State filters can read them.
    let query = supabase
      .from('jobs')
      .select(`
        *,
        customer:customers(farm_name, account_number, phone),
        vehicle:vehicles(vehicle_name),
        job_fields(crop, field:fields(field_name, crop_type, county, state)),
        job_chemicals(rate_per_acre, rate_unit, product:products(product_name)),
        job_field_shares(customer_id, split_pct, is_primary, customer:customers(farm_name, account_number)),
        job_tag_assignments(tag:job_tags(id, name, color, created_by, created_at, updated_at)),
        batch:job_batches(name)
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
    // Field-app parity #3: filter by named batch (server-side on jobs.batch_ref).
    if (applied.batchIds.length > 0) query = query.in('batch_ref', applied.batchIds);
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
      customer?: { farm_name?: string; account_number?: string | null; phone?: string | null };
      vehicle?: { vehicle_name?: string };
      job_fields?: Array<{ crop?: string | null; field?: { field_name?: string; crop_type?: string | null; county?: string | null; state?: string | null } }>;
      job_chemicals?: Array<{ rate_per_acre?: number | null; rate_unit?: string | null; product?: { product_name?: string } }>;
      job_field_shares?: Array<{ customer_id: string; split_pct: number; is_primary: boolean; customer?: { farm_name?: string; account_number?: string | null } }>;
      job_tag_assignments?: Array<{ tag?: JobTag | null }>;
      batch?: { name?: string } | null;
      applicator_id?: string | null;
      created_by?: string | null;
      updated_by?: string | null;
      last_printed_by?: string | null;
    };
    const raw = (data || []) as RawJob[];

    const profileIds = [...new Set(
      raw.flatMap((j) => [j.applicator_id, j.created_by, j.updated_by, j.last_printed_by]).filter(Boolean) as string[]
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
        customer_phone: j.customer?.phone ?? null,
        locations,
        crops,
        chemicals,
        created_by_name: j.created_by ? nameMap[j.created_by] || '-' : '-',
        updated_by_name: j.updated_by ? nameMap[j.updated_by] || '-' : '-',
        last_printed_by_name: j.last_printed_by ? nameMap[j.last_printed_by] || '-' : '-',
        jobTags,
        counties,
        states,
        chemicalNames,
        batch_name: j.batch?.name ?? null,
      };
    });
    setJobs(rows);
    setLoading(false);
  }, [applied, toast]);

  useEffect(() => {
    fetchReferenceLists();
    fetchTags();
    fetchCrews();
    fetchBatches();
  }, [fetchReferenceLists, fetchTags, fetchCrews, fetchBatches]);

  // Load the per-user list layout once we know who's signed in.
  useEffect(() => {
    fetchListSettings();
  }, [fetchListSettings]);

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
      // Field-app parity #8: "Show Completed Jobs" toggle. When OFF, hide
      // completed jobs from the list (and therefore from totals + selection,
      // which read this same view). An explicit status filter that DOES include
      // 'completed' wins — the user clearly asked for them.
      if (!listSettings.showCompleted && j.status === 'completed' && !applied.statuses.includes('completed')) {
        return false;
      }
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
  }, [jobs, applied, listSettings.showCompleted]);

  // jobId -> set of assigned tag ids, for the bulk modal's starting state.
  const assignmentsByJob = useMemo(() => {
    const map = new Map<string, Set<string>>();
    for (const j of jobs) {
      map.set(j.id, new Set(j.jobTags.map((t) => t.id)));
    }
    return map;
  }, [jobs]);

  // Field-app parity #3: jobId -> its current batch_ref (null = no batch), for
  // the assign modal's coverage hints + member counts in the batch manager.
  const batchByJob = useMemo(() => {
    const map = new Map<string, string | null>();
    for (const j of jobs) map.set(j.id, j.batch_ref ?? null);
    return map;
  }, [jobs]);

  const batchMemberCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const j of jobs) {
      if (j.batch_ref) counts[j.batch_ref] = (counts[j.batch_ref] ?? 0) + 1;
    }
    return counts;
  }, [jobs]);

  const { selected, toggleSelect, toggleAll, clearSelection, selectedCount, selectedRows, allSelected } =
    useRowSelection({
      data: visibleJobs,
      getId: (j) => j.id,
      // Selection is driven by REPORTABLE (incl. invoiced) so finished/billed jobs
      // can be summarized/exported. Deletability is enforced separately in handleDelete.
      isSelectable: (j) => REPORTABLE.includes(j.status),
    });

  const checkboxCol = useMemo(
    () => createCheckboxColumn<JobRow>(selected, toggleSelect, (j) => j.id, (j) => REPORTABLE.includes(j.status)),
    [selected, toggleSelect]
  );

  // The EDITABLE subset of the current selection. The mutating bulk actions (Mass
  // Edit / Add to Batch / Edit Job Tags) operate on THIS — never on a billed
  // (`invoiced`) or `cancelled` job that REPORTABLE made selectable for reporting.
  const editableSelectedRows = useMemo(
    () => selectedRows.filter((j) => EDITABLE.includes(j.status)),
    [selectedRows]
  );
  const editableSelectedIds = useMemo(
    () => editableSelectedRows.map((j) => j.id),
    [editableSelectedRows]
  );

  // Open a mutating bulk modal, but refuse it when NO selected job is editable, and
  // warn (once, at open) when some selected jobs will be skipped because they're
  // billed/finished. Mirrors the Delete gate so a bulk edit can never silently
  // rewrite an invoiced/cancelled job.
  const openMutatingAction = useCallback((open: () => void) => {
    const skipped = selectedRows.length - editableSelectedRows.length;
    if (editableSelectedRows.length === 0) {
      toast('error', 'No editable jobs selected — invoiced/cancelled jobs can’t be bulk-edited.');
      return;
    }
    if (skipped > 0) {
      toast('info', `${skipped} invoiced/cancelled job(s) will be skipped — bulk edit applies to ${editableSelectedRows.length} job(s).`);
    }
    open();
  }, [selectedRows.length, editableSelectedRows, toast]);

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
  const batchOptions: MultiSelectOption[] = useMemo(
    () => allBatches.map((b) => ({ value: b.id, label: b.name })), [allBatches]);
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

  // Field-app parity #10: generate one combined Loader Worksheet PDF (a page per
  // selected job). Re-fetches each job's full mix/fields (the list query is
  // summary-only) and computes the per-load split from the shared pure engine.
  const handleLoaderWorksheets = async () => {
    setLoaderExporting(true);
    try {
      const ids = selectedRows.map((j) => j.id);
      const data = await fetchLoaderWorksheetData(ids);
      if (data.length === 0) {
        toast('error', 'No loader-worksheet data for the selected jobs.');
        setLoaderExporting(false);
        return;
      }
      await generateLoaderWorksheetBatchPdf(data);
      // Stamp the print audit (ChemMan "Last Printed By"/printed_at) for every
      // selected job, matching the single-job print path. Best-effort: a failed
      // stamp must not undo the already-downloaded PDF. Refresh so the list's
      // Last Printed By column reflects the print.
      try {
        const stamp = await supabase
          .from('jobs')
          .update({ printed_at: new Date().toISOString(), last_printed_by: profile?.id ?? null })
          .in('id', ids)
          .select('id');
        checkMutationResult(stamp, 'Stamp loader-worksheet print');
        fetchJobs();
      } catch { /* non-blocking — the PDF already generated */ }
      toast('success', `Generated loader worksheets for ${data.length} job(s)`);
    } catch (err) {
      Sentry.captureException(err instanceof Error ? err : new Error(String(err)), { extra: { context: 'jobs_bulk_loader_worksheet' } });
      toast('error', sanitizeError(err));
    }
    setLoaderExporting(false);
  };

  // Field-app parity #10: print ONE job's Loader Worksheet straight from its list
  // row (no bulk selection needed — works for any viewer, incl. applicators). Uses
  // the same fetch + single-job generator as the rest of the loader feature, then
  // best-effort stamps the print audit and refreshes the row.
  const handleRowLoaderWorksheet = async (jobId: string) => {
    setRowLoaderId(jobId);
    try {
      const data = await fetchLoaderWorksheetData([jobId]);
      if (data.length === 0) {
        toast('error', 'No loader-worksheet data for that job.');
        setRowLoaderId(null);
        return;
      }
      await generateLoaderWorksheetPdf(data[0]);
      try {
        const stamp = await supabase
          .from('jobs')
          .update({ printed_at: new Date().toISOString(), last_printed_by: profile?.id ?? null })
          .eq('id', jobId)
          .select('id');
        checkMutationResult(stamp, 'Stamp loader-worksheet print');
        fetchJobs();
      } catch { /* non-blocking — the PDF already generated */ }
      toast('success', 'Loader worksheet generated');
    } catch (err) {
      Sentry.captureException(err instanceof Error ? err : new Error(String(err)), { extra: { context: 'jobs_row_loader_worksheet' } });
      toast('error', sanitizeError(err));
    }
    setRowLoaderId(null);
  };

  // Field-app parity #11: print ONE job's Chemical Application Report straight from
  // its list row (no bulk selection needed — works for any viewer). Re-fetches the
  // job's full mix/fields/product-label data via the SHARED applicator-sheet gatherer
  // (so the figures match the Applicator Sheet), generates the chemical-centric PDF,
  // then best-effort stamps the print audit and refreshes the row.
  const handleRowChemicalReport = async (jobId: string) => {
    setRowChemReportId(jobId);
    try {
      const data = await fetchChemicalApplicationReportData(jobId);
      if (!data) {
        toast('error', 'No chemical-report data for that job.');
        setRowChemReportId(null);
        return;
      }
      // Gate a blank report: the row icon shows on EVERY job, but a job with no
      // chemicals or no fields would produce an official-looking empty PDF (and stamp
      // printed_at). JobDetail only shows its print buttons when the job has both, so
      // mirror that here before generating/stamping (Codex P2).
      if (data.products.length === 0 || data.fields.length === 0) {
        toast('error', 'This job has no chemicals/fields to report — add them before printing.');
        setRowChemReportId(null);
        return;
      }
      await generateChemicalApplicationReportPdf(data);
      try {
        const stamp = await supabase
          .from('jobs')
          .update({ printed_at: new Date().toISOString(), last_printed_by: profile?.id ?? null })
          .eq('id', jobId)
          .select('id');
        checkMutationResult(stamp, 'Stamp chemical-report print');
        fetchJobs();
      } catch { /* non-blocking — the PDF already generated */ }
      // Audit the compliance-document print in the activity feed (mirrors the
      // JobDetail single-job path) so a row-action print isn't invisible (Codex P2).
      if (profile) logActivity({ event: 'chemical_application_report_printed', description: `Chemical Application Report generated for job ${data.job_number}`, performedBy: profile.id, entityType: 'job', entityId: jobId });
      toast('success', 'Chemical application report generated');
    } catch (err) {
      Sentry.captureException(err instanceof Error ? err : new Error(String(err)), { extra: { context: 'jobs_row_chemical_report' } });
      toast('error', sanitizeError(err));
    }
    setRowChemReportId(null);
  };

  // Field-app parity #12: Chemical Summary Report over the checkbox-SELECTED jobs.
  // Sums each chemical/product's total applied quantity across all selected jobs
  // (keyed by product + unit), re-derives the gal/lb-equivalent from the SUMMED
  // quantity, and renders a print-ready PDF + a CSV. NEVER silently undercounts: a
  // job that can't be fully fetched/resolved is surfaced as EXCLUDED on the report
  // and in a toast, so the grand total is never quietly wrong.
  const handleChemicalSummaryReport = async () => {
    // Criterion 5: no selection → prompt to select jobs, never an empty/erroring report.
    if (selectedRows.length === 0) {
      toast('error', 'Select one or more jobs first to run the Chemical Summary Report.');
      return;
    }
    setSummaryExporting(true);
    try {
      const ids = selectedRows.map((j) => j.id);
      const { jobs: fetched, excluded } = await fetchChemicalSummaryData(ids);
      // Every selected job failed to resolve / had no chemicals → don't produce an
      // official-looking empty PDF. Tell the user why (mirrors the per-job guards).
      if (fetched.length === 0) {
        toast('error', excluded.length > 0
          ? 'None of the selected jobs could be summarized (no chemicals or could not be resolved).'
          : 'No chemical data for the selected jobs.');
        setSummaryExporting(false);
        return;
      }
      const summary = buildChemicalSummaryReportData(fetched, excluded);
      await generateChemicalSummaryReportPdf(summary);
      // CSV export alongside the PDF (criterion 3 "ideally a CSV export too").
      // LOW fix: exportToCSV silently no-ops on an empty array, so when there are
      // NO product lines (e.g. every included job is zero-acre/quantity-less) it
      // would download nothing while the toast claimed a CSV was produced. Only
      // call it when there ARE rows, and tell the user honestly below whether a
      // CSV was actually written.
      const hasRows = summary.rows.length > 0;
      if (hasRows) {
        exportToCSV(chemicalSummaryCsvRows(summary), [
          { key: 'product_name', header: 'Product' },
          { key: 'unit', header: 'Unit' },
          { key: 'total_quantity', header: 'Total Applied' },
          { key: 'gl_lb_equiv', header: 'gal/lb Equivalent' },
          { key: 'job_count', header: 'Jobs' },
        ], 'chemical-summary');
      }

      // Stamp the print audit for the INCLUDED jobs only (the ones actually summed),
      // matching the #10/#11 bulk print paths. Best-effort: a failed stamp must not
      // undo the already-downloaded report.
      const includedIds = summary.included_jobs.map((j) => j.job_id);
      try {
        const stamp = await supabase
          .from('jobs')
          .update({ printed_at: new Date().toISOString(), last_printed_by: profile?.id ?? null })
          .in('id', includedIds)
          .select('id');
        checkMutationResult(stamp, 'Stamp chemical-summary print');
        fetchJobs();
      } catch { /* non-blocking — the report already generated */ }
      // includedIds is non-empty here (fetched.length > 0 was guarded above), so the
      // first included job anchors the audit entry (entityId is a single uuid).
      if (profile && includedIds[0]) logActivity({ event: 'chemical_summary_report_printed', description: `Chemical Summary Report generated across ${includedIds.length} job(s)`, performedBy: profile.id, entityType: 'job', entityId: includedIds[0] });

      // Honest reporting: distinguish (a) jobs excluded from the totals and (b) the
      // case where the included jobs had NO chemical lines to sum (so no CSV was
      // written). The PDF always downloads (it carries the included/excluded jobs),
      // but the toast must never claim a CSV that doesn't exist.
      const csvNote = hasRows ? ' (PDF + CSV)' : ' — no chemical lines found, PDF only (no CSV)';
      if (excluded.length > 0) {
        toast('error', `Summary generated for ${fetched.length} job(s)${csvNote}; ${excluded.length} excluded (see the report's Jobs Excluded list).`);
      } else if (!hasRows) {
        toast('info', `Summary generated for ${fetched.length} job(s) but no chemical lines were found — PDF only, no CSV written.`);
      } else {
        toast('success', `Chemical summary generated across ${fetched.length} job(s) (PDF + CSV)`);
      }
    } catch (err) {
      Sentry.captureException(err instanceof Error ? err : new Error(String(err)), { extra: { context: 'jobs_bulk_chemical_summary' } });
      toast('error', sanitizeError(err));
    }
    setSummaryExporting(false);
  };

  // Field-app parity #13: Projected Use Report over the checkbox-SELECTED jobs.
  // FORECASTS how much of each chemical is still to apply on the UPCOMING / in-flight
  // jobs, so the office can order product ahead. Projected = planned rate × NOT-YET-
  // APPLIED (remaining) acres, summed per product+unit, gal/lb re-derived from the
  // projected sum. Only scheduled/in_progress jobs WITH remaining acres are projected;
  // already-applied / completed / invoiced / cancelled / zero-remaining jobs are listed
  // as EXCLUDED (never folded in) so the number is a genuine forecast, not a record of
  // what's already sprayed. Read-only: this is a planning forecast, NOT a per-job
  // compliance document, so it does NOT stamp printed_at.
  const handleProjectedUseReport = async () => {
    // Criterion 1/5: no selection → prompt to select jobs, never an empty/erroring report.
    if (selectedRows.length === 0) {
      toast('error', 'Select one or more scheduled / in-progress jobs first to run the Projected Use Report.');
      return;
    }
    setProjectedExporting(true);
    try {
      const ids = selectedRows.map((j) => j.id);
      const { jobs: fetched, excluded } = await fetchProjectedUseData(ids);
      // No in-scope jobs (e.g. every selected job is already applied / completed) → don't
      // produce an official-looking empty forecast. Tell the user why.
      if (fetched.length === 0) {
        toast('error', excluded.length > 0
          ? 'None of the selected jobs can be projected — they are already applied/completed or have no remaining acres.'
          : 'No projectable chemical data for the selected jobs.');
        setProjectedExporting(false);
        return;
      }
      const projection = buildProjectedUseReportData(fetched, excluded);
      await generateProjectedUseReportPdf(projection);
      // CSV alongside the PDF (criterion 5). projectedUseCsvRows appends an EXCLUDED
      // marker block when any job was dropped, so a standalone CSV is never a silently-
      // partial forecast (Codex P2). Write the CSV when there is ANY content — projected
      // product lines OR excluded-job markers — and report honestly below. The unit /
      // gal-lb columns double as Job # / Reason for the excluded marker rows.
      const hasRows = projection.rows.length > 0;
      const csvRows = projectedUseCsvRows(projection);
      const wroteCsv = csvRows.length > 0;
      if (wroteCsv) {
        exportToCSV(csvRows, [
          { key: 'product_name', header: 'Product / Marker' },
          { key: 'unit', header: 'Unit / Job #' },
          { key: 'projected_quantity', header: 'Projected Use' },
          { key: 'gl_lb_equiv', header: 'gal/lb Equivalent / Reason' },
          { key: 'job_count', header: 'Jobs' },
        ], 'projected-use');
      }

      // Audit log only (NO printed_at stamp — this is a forecast, not a compliance print).
      const includedIds = projection.included_jobs.map((j) => j.job_id);
      if (profile && includedIds[0]) logActivity({ event: 'projected_use_report_printed', description: `Projected Use Report generated across ${includedIds.length} job(s)`, performedBy: profile.id, entityType: 'job', entityId: includedIds[0] });

      const csvNote = wroteCsv ? ' (PDF + CSV)' : ' — PDF only (no CSV)';
      if (excluded.length > 0) {
        // The CSV now carries the excluded jobs as marker rows, so it is never a silently
        // partial forecast — but still point the user at the report's Jobs Excluded list.
        toast('error', `Projection generated for ${fetched.length} job(s)${csvNote}; ${excluded.length} excluded (listed on the report and in the CSV).`);
      } else if (!hasRows) {
        toast('info', `Projection generated for ${fetched.length} job(s) but no projected lines were found — PDF only, no CSV written.`);
      } else {
        toast('success', `Projected use generated across ${fetched.length} job(s) (PDF + CSV)`);
      }
    } catch (err) {
      Sentry.captureException(err instanceof Error ? err : new Error(String(err)), { extra: { context: 'jobs_bulk_projected_use' } });
      toast('error', sanitizeError(err));
    }
    setProjectedExporting(false);
  };

  // Field-app parity #14: Master Mix Summary over the checkbox-SELECTED jobs. Shows the
  // COMBINED tank mix for the whole batch — the SUM of each product to mix across all
  // selected jobs (keyed by product + unit, gal/lb re-derived from the combined sum) —
  // PLUS the loads picture grouped by tank capacity + carrier rate (same-capacity jobs
  // share a combined load plan; different capacities are grouped separately, NEVER
  // averaged; jobs missing a capacity are noted, their mix still counted). Read-only batch
  // prep doc: it does NOT stamp printed_at (not a per-job compliance print). NEVER silently
  // undercounts: a job that can't be resolved is surfaced as EXCLUDED on the report + toast.
  const handleMasterMixSummary = async () => {
    // No selection → prompt to select jobs, never an empty/erroring report.
    if (selectedRows.length === 0) {
      toast('error', 'Select one or more jobs first to build the Master Mix Summary.');
      return;
    }
    setMasterMixExporting(true);
    try {
      const ids = selectedRows.map((j) => j.id);
      const { jobs: fetched, excluded } = await fetchMasterMixSummaryData(ids);
      // Every selected job failed to resolve / had no chemicals → don't produce an
      // official-looking empty mix sheet. Tell the user why (mirrors the per-job guards).
      if (fetched.length === 0) {
        toast('error', excluded.length > 0
          ? 'None of the selected jobs could be mixed (no chemicals or could not be resolved).'
          : 'No chemical data for the selected jobs.');
        setMasterMixExporting(false);
        return;
      }
      const mix = buildMasterMixSummaryData(fetched, excluded);
      await generateMasterMixSummaryPdf(mix);

      // Audit log only (NO printed_at stamp — this is a batch-prep doc, not a compliance print).
      const includedIds = mix.included_jobs.map((j) => j.job_id);
      if (profile && includedIds[0]) logActivity({ event: 'master_mix_summary_printed', description: `Master Mix Summary generated across ${includedIds.length} job(s)`, performedBy: profile.id, entityType: 'job', entityId: includedIds[0] });

      // Honest reporting: surface excluded jobs and the different-capacity grouping so the
      // loader knows the combined mix is complete but loads were split (not averaged).
      const capNote = mix.mixed_capacities ? ' (loads grouped by capacity)' : '';
      if (excluded.length > 0) {
        toast('error', `Master mix generated for ${fetched.length} job(s)${capNote}; ${excluded.length} excluded (see the report's Jobs Excluded list).`);
      } else if (mix.no_load_jobs.length > 0) {
        toast('info', `Master mix generated for ${fetched.length} job(s)${capNote}; ${mix.no_load_jobs.length} need a capacity/carrier rate for loads (mix still counted).`);
      } else {
        toast('success', `Master mix generated across ${fetched.length} job(s)${capNote}`);
      }
    } catch (err) {
      Sentry.captureException(err instanceof Error ? err : new Error(String(err)), { extra: { context: 'jobs_bulk_master_mix' } });
      toast('error', sanitizeError(err));
    }
    setMasterMixExporting(false);
  };

  const handleDelete = async () => {
    setDeleting(true);
    try {
      // REPORTABLE broadened selection to include invoiced jobs (so they can be
      // summarized/exported). Delete must stay gated to DELETABLE: re-filter the
      // selection here so an invoiced/finished job is NEVER soft-deleted, even if
      // it's checkbox-selected for a report. Skipped jobs are surfaced in the toast.
      const deletableRows = selectedRows.filter((j) => DELETABLE.includes(j.status));
      const ids = deletableRows.map((j) => j.id);
      const skipped = selectedRows.length - ids.length;
      if (ids.length === 0) {
        toast('error', `No deletable jobs selected — invoiced/finished jobs can't be deleted (${skipped} skipped).`);
        setDeleting(false);
        setDeleteModalOpen(false);
        return;
      }
      // Belt-and-suspenders: scope the soft-delete by status IN DELETABLE at the
      // QUERY level too (not just the in-memory `ids` filter above). If the
      // in-memory status were ever stale/wrong, the DB query still refuses to
      // stamp deleted_at on an invoiced/cancelled job. This mirrors the new
      // server-side _enforce_billed_job_immutability trigger (#12 DB guard).
      const result = await supabase
        .from('jobs')
        .update({ deleted_at: new Date().toISOString() })
        .in('id', ids)
        .in('status', DELETABLE)
        .select();
      checkMutationResult(result, 'Delete jobs');
      // If the DB matched fewer rows than we asked to delete, a selected job was
      // not in a deletable status (e.g. it was billed between fetch and delete) and
      // the query correctly skipped it. Surface that instead of claiming success.
      const deletedCount = result.data?.length ?? 0;
      const dbSkipped = ids.length - deletedCount;
      const totalSkipped = skipped + dbSkipped;
      toast(
        totalSkipped > 0 ? 'info' : 'success',
        totalSkipped > 0
          ? `Deleted ${deletedCount} job(s); ${totalSkipped} skipped — invoiced/finished jobs can't be deleted.`
          : `Deleted ${deletedCount} job(s)`,
      );
      clearSelection();
      fetchJobs();
    } catch (err) {
      toast('error', sanitizeError(err));
    }
    setDeleting(false);
    setDeleteModalOpen(false);
  };

  const bulkActions = [
    { key: 'mass-edit', label: 'Mass Edit', icon: <Pencil className="w-4 h-4" />, onClick: () => openMutatingAction(() => setMassEditOpen(true)) },
    { key: 'batch', label: 'Add to Batch', icon: <Layers className="w-4 h-4" />, onClick: () => openMutatingAction(() => setAssignBatchOpen(true)) },
    { key: 'tags', label: 'Edit Job Tags', icon: <Tag className="w-4 h-4" />, onClick: () => openMutatingAction(() => setBulkTagsOpen(true)) },
    { key: 'csv', label: 'Export CSV', icon: <Download className="w-4 h-4" />, onClick: handleExportCSV },
    { key: 'pdf', label: 'Download PDF', icon: <FileText className="w-4 h-4" />, onClick: handleExportPDF, loading: exporting },
    { key: 'loader', label: 'Loader Worksheet', icon: <Truck className="w-4 h-4" />, onClick: handleLoaderWorksheets, loading: loaderExporting },
    { key: 'chem-summary', label: 'Chemical Summary Report', icon: <ClipboardList className="w-4 h-4" />, onClick: handleChemicalSummaryReport, loading: summaryExporting },
    { key: 'projected-use', label: 'Projected Use Report', icon: <PackageOpen className="w-4 h-4" />, onClick: handleProjectedUseReport, loading: projectedExporting },
    { key: 'master-mix', label: 'Master Mix Summary', icon: <Beaker className="w-4 h-4" />, onClick: handleMasterMixSummary, loading: masterMixExporting },
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
      // Field-app parity #3: the named batch this job belongs to (a single
      // chip; "-" when un-batched). Multi-select assign sets it from the list.
      key: 'batch_name',
      header: 'Batch',
      sortable: true,
      render: (r) => (
        r.batch_name ? (
          <span className="inline-flex items-center gap-1 px-2 py-0.5 text-xs font-medium rounded bg-crx-green/10 text-crx-green">
            <Layers className="w-3 h-3" />
            {r.batch_name}
          </span>
        ) : (
          <span className="text-secondary">-</span>
        )
      ),
    },
    {
      key: 'job_number',
      header: 'Job #',
      sortable: true,
      render: (r) => (
        <div className="flex items-center gap-1.5">
          <button
            onClick={() => navigate(`/jobs/${r.id}`)}
            className="font-medium text-nav-dark font-mono text-xs hover:text-crx-green transition-colors"
          >
            {r.job_number}
          </button>
          {/* #10: per-row Loader Worksheet entry point — reachable directly from the
              job list for ANY viewer (incl. applicators with no bulk bar), not only
              via the bulk action. Generates the single-job loader PDF. */}
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); handleRowLoaderWorksheet(r.id); }}
            disabled={rowLoaderId === r.id}
            title="Print Loader Worksheet"
            aria-label={`Print loader worksheet for job ${r.job_number}`}
            className="text-secondary hover:text-crx-green disabled:opacity-40 transition-colors"
          >
            <Truck className="w-3.5 h-3.5" />
          </button>
          {/* #11: per-row Chemical Application Report entry point — the official
              per-job chemical record, reachable directly from the job list for ANY
              viewer (alongside the loader/applicator printouts). */}
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); handleRowChemicalReport(r.id); }}
            disabled={rowChemReportId === r.id}
            title="Print Chemical Application Report"
            aria-label={`Print chemical application report for job ${r.job_number}`}
            className="text-secondary hover:text-crx-green disabled:opacity-40 transition-colors"
          >
            <FlaskConical className="w-3.5 h-3.5" />
          </button>
        </div>
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
      key: 'customer_phone',
      header: 'Customer Phone',
      sortable: true,
      render: (r) => r.customer_phone || <span className="text-secondary">-</span>,
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
      // List Settings "Wind Direction" toggle (acceptance criterion #3). The
      // job list has no wind-direction source yet — that rides the as-applied
      // weather capture (Open-Meteo, section #19). The toggle/column exist now
      // for parity; the cell renders "-" until that data lands on the job.
      key: 'wind_direction',
      header: 'Wind Dir.',
      render: () => <span className="text-secondary">-</span>,
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
      // List Settings "Call Date" toggle — when the customer called in the job
      // (jobs.call_date, added in #1). OFF by default; "-" when unset.
      key: 'call_date',
      header: 'Call Date',
      sortable: true,
      render: (r) => r.call_date ? parseLocalDate(r.call_date).toLocaleDateString() : <span className="text-secondary">-</span>,
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
      key: 'vehicle_name',
      header: 'Vehicle',
      sortable: true,
      render: (r) => r.vehicle_name && r.vehicle_name !== '-' ? r.vehicle_name : <span className="text-secondary">-</span>,
    },
    {
      key: 'total_price_cents',
      header: 'Price',
      sortable: true,
      className: 'text-right tabular-nums',
      render: (r) => r.total_price_cents ? fmtCents(r.total_price_cents) : <span className="text-secondary">-</span>,
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
      header: 'Last Printed By',
      sortable: true,
      render: (r) => r.printed_at
        ? (
          <div className="flex flex-col gap-0.5">
            <Badge variant="success">Printed</Badge>
            <span className="text-xs text-secondary">
              {r.last_printed_by_name && r.last_printed_by_name !== '-' ? r.last_printed_by_name : 'Unknown'}
              {' · '}
              {new Date(r.printed_at).toLocaleDateString()}
            </span>
          </div>
        )
        : <Badge variant="default">Not printed</Badge>,
    },
  ];

  // Field-app parity #8: keep only the columns the user chose to show, IN
  // REGISTRY ORDER (orderedVisibleColumnIds), so toggling visibility never
  // reorders the table. The checkbox column is presentation-fixed and always
  // leads when bulk actions are allowed.
  const orderedVisibleIds = orderedVisibleColumnIds(listSettings);
  const columnByKey = new Map(dataColumns.map((c) => [c.key, c]));
  const visibleDataColumns = orderedVisibleIds
    .map((id) => columnByKey.get(id))
    .filter((c): c is Column<JobRow> => Boolean(c));
  const columns = canBulkAction ? [checkboxCol, ...visibleDataColumns] : visibleDataColumns;

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
                icon={<Layers className="w-4 h-4" />}
                onClick={() => setManageBatchesOpen(true)}
                showChevron={false}
              >
                Batches
              </Button>
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
            variant="secondary"
            icon={<Settings2 className="w-4 h-4" />}
            onClick={() => setListSettingsOpen(true)}
            showChevron={false}
          >
            List Settings
          </Button>
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
              <MultiSelectDropdown
                label="Batch"
                options={batchOptions}
                selected={draft.batchIds}
                onChange={(v) => patchDraft('batchIds', v)}
                placeholder="All Batches"
                emptyText="No batches yet"
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
        selectedJobIds={editableSelectedIds}
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

      {/* Field-app parity #3: job batches manager + bulk assign-to-batch. */}
      <JobBatchesManager
        open={manageBatchesOpen}
        onClose={() => setManageBatchesOpen(false)}
        batches={allBatches}
        memberCounts={batchMemberCounts}
        onChanged={() => { fetchBatches(); fetchJobs(); }}
      />
      <JobBatchAssignModal
        open={assignBatchOpen}
        onClose={() => setAssignBatchOpen(false)}
        selectedJobIds={editableSelectedIds}
        batches={allBatches}
        batchByJob={batchByJob}
        onManageBatches={() => { setAssignBatchOpen(false); setManageBatchesOpen(true); }}
        onApplied={() => { fetchBatches(); fetchJobs(); }}
      />

      {/* Field-app parity #7: Mass Edit (dates / status / applicator / batch) over
          the filtered+selected jobs. Loader-worksheet bulk fields are deferred to
          section #10 (see the insertion point inside JobMassEditModal). */}
      <JobMassEditModal
        open={massEditOpen}
        onClose={() => setMassEditOpen(false)}
        selectedJobs={editableSelectedRows.map((j) => ({ id: j.id, job_number: j.job_number, status: j.status }))}
        applicators={applicators}
        batches={allBatches.map((b) => ({ id: b.id, name: b.name }))}
        onApplied={() => { fetchBatches(); fetchJobs(); }}
      />

      {/* Field-app parity #8: per-user List Settings (column on/off + show
          completed). Changes apply immediately and persist to the signed-in
          user's own row (RLS-scoped). */}
      <ListSettingsModal
        open={listSettingsOpen}
        onClose={() => setListSettingsOpen(false)}
        settings={listSettings}
        onChange={updateListSettings}
        saving={savingSettings}
      />
    </div>
  );
}
