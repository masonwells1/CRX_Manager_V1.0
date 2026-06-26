/**
 * DispatchBoard.tsx — Dark field/tablet "Dispatch & Applicator View"
 * (field-app parity #35).
 *
 * A purpose-built, DARK, high-contrast, touch-friendly dispatch screen — distinct
 * from the light office Jobs list. A left rail groups navigation into:
 *   - JOBS:     View Map · View List   (drive the map/list toggle)
 *   - DISPATCH: Dispatch Jobs · View Dispatched List
 * Job rows show: Job Nbr + customer, applied-of-total acres ('X of Y ac'), a
 * PENDING/ACTIVE status badge, and 'Assigned To: <name>' when dispatched.
 * An OPTIONS menu offers: Filter Jobs By Recipe (#39 stub), More Search Options,
 * Switch View, Add New Job, Reload List.
 *
 * One shared filter object (`filters`) drives BOTH views, so switching map<->list
 * keeps the same active filter set (criterion #6).
 *
 * Scope (this is the FIRST of 7 dispatch sections — structure + hooks only):
 *   - 'Filter Jobs By Recipe' = #39  → menu entry wired to a simple recipe stub.
 *   - 'View Dispatched List'  = #37  → nav entry routes to an in-page placeholder.
 *   - Per-location dispatch wizard = #36 → 'Assigned To' is rendered from the
 *     EXISTING job-level applicator assignment; 'Dispatch Jobs' reuses the
 *     existing inline assign control (the wizard is #36's job).
 */
import { useEffect, useState, useCallback, useMemo, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Map as MapIcon,
  List as ListIcon,
  Send,
  ClipboardList,
  MoreVertical,
  FlaskConical,
  SlidersHorizontal,
  Plus,
  RefreshCw,
  Users,
  Search,
  X,
  Truck,
} from 'lucide-react';
import type { MapRef } from 'react-map-gl/mapbox';
import CRXMap from '../components/map/CRXMap';
import FieldBoundaryLayer from '../components/map/FieldBoundaryLayer';
import ConfirmModal from '../components/ui/ConfirmModal';
import ErrorBoundary from '../components/ErrorBoundary';
import DispatchWizard from '../components/dispatch/DispatchWizard';
import { usePageMeta } from '../hooks/usePageMeta';
import { useIdempotencyKey } from '../hooks/useIdempotencyKey';
import { useToast } from '../components/ui/Toast';
import { useAuth } from '../contexts/AuthContext';
import { supabase, assertRpcResult, hasRpcCode, RpcErrorCodes } from '../lib/db';
import { Sentry } from '../lib/sentry';
import {
  formatAppliedOfTotal,
  jobStatusToDispatchBadge,
  selectDispatchView,
  hasActiveDispatchFilter,
  emptyDispatchFilters,
  type DispatchFilters,
  type DispatchView,
} from '../lib/dispatchDisplay';
import { aggregateAssignedTo, type DispatchLocation } from '../lib/dispatchWizard';
import type { Job, Profile, Field } from '../types';

type NavSection = 'map' | 'list' | 'dispatch' | 'dispatched';

/**
 * Page through active ('dispatched') job_location_dispatches rows and return the
 * DISTINCT job_ids — optionally scoped to one applicator, and/or to a set of job
 * ids. The Supabase Data API caps a single response (~1000 rows), so an un-ranged
 * read would silently miss later rows once the table grows — breaking the applicator
 * filter / exclusion set (#36 P2). We page via .range() until a short page signals
 * the end. Returns null on error (caller logs). When scoped by jobIds and that list
 * is empty, returns [] without querying.
 */
const DISPATCH_PAGE = 1000;
async function fetchDispatchedJobIds(
  opts: { applicatorId?: string; jobIds?: string[] }
): Promise<string[] | null> {
  if (opts.jobIds && opts.jobIds.length === 0) return [];
  const ids = new Set<string>();
  for (let from = 0; ; from += DISPATCH_PAGE) {
    let query = supabase
      .from('job_location_dispatches')
      .select('job_id')
      .eq('dispatch_status', 'dispatched');
    if (opts.applicatorId) query = query.eq('applicator_id', opts.applicatorId);
    if (opts.jobIds) query = query.in('job_id', opts.jobIds);
    const { data, error } = await query.range(from, from + DISPATCH_PAGE - 1);
    if (error) return null;
    const rows = (data || []) as Array<{ job_id: string }>;
    for (const r of rows) ids.add(r.job_id);
    if (rows.length < DISPATCH_PAGE) break;
  }
  return Array.from(ids);
}

interface DispatchJob extends Job {
  customer_name?: string;
  /** Aggregated 'Assigned To' label — distinct per-location assignees (a job
   *  split between two applicators shows BOTH), falling back to the whole-job
   *  applicator when there are no per-location dispatches (#36 criteria 5/6). */
  assigned_to_label?: string | null;
  /** Applicator ids dispatched to this job at the LOCATION level — so the
   *  Applicator filter matches a per-location-only assignee (#36 P2). */
  dispatched_applicator_ids?: string[];
  field_names?: string | null;
  field_ids?: string[];
  /** Dispatchable field locations (job_fields rows) for the wizard. */
  locations?: DispatchLocation[];
}

export default function DispatchBoard() {
  usePageMeta();
  const navigate = useNavigate();
  const { profile } = useAuth();
  const { toast } = useToast();

  const [loading, setLoading] = useState(true);
  const [jobs, setJobs] = useState<DispatchJob[]>([]);
  const [applicators, setApplicators] = useState<Pick<Profile, 'id' | 'full_name' | 'role'>[]>([]);
  const [crews, setCrews] = useState<{ id: string; name: string }[]>([]);
  const [recipes, setRecipes] = useState<{ id: string; name: string }[]>([]);
  const [allFields, setAllFields] = useState<Field[]>([]);
  const [wizardOpen, setWizardOpen] = useState(false);

  // The active nav section. 'map' / 'list' are the two Jobs views and also the
  // map/list toggle target; 'dispatch' is the assign flow; 'dispatched' is the
  // #37 placeholder.
  const [section, setSection] = useState<NavSection>('list');

  // The SINGLE shared filter object — feeds whichever view renders (criterion #6).
  const [filters, setFilters] = useState<DispatchFilters>(emptyDispatchFilters);
  const [optionsOpen, setOptionsOpen] = useState(false);
  const [moreSearchOpen, setMoreSearchOpen] = useState(false);
  const [recipeMenuOpen, setRecipeMenuOpen] = useState(false);
  const [selectedJobId, setSelectedJobId] = useState<string | null>(null);
  const optionsRef = useRef<HTMLDivElement>(null);
  // Held so we can resize the map after it becomes visible (it mounts hidden).
  const mapRef = useRef<MapRef | null>(null);

  // License-override confirm (B5 license gates) — admin only.
  const [licenseOverridePrompt, setLicenseOverridePrompt] = useState<{ jobId: string; applicatorId: string } | null>(null);
  const assignIdem = useIdempotencyKey('assign_job_applicator', profile?.id || '');

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      // The LIST view (job#, X-of-Y acres, status, Assigned-To) is the core of the
      // dispatch board and must NEVER depend on map-only geometry columns. So the
      // jobs query embeds only the lightweight field_name (for the row's location
      // line); the heavy boundary/centroid geometry is fetched SEPARATELY below and
      // is best-effort (a missing map column degrades the map, not the whole page).
      // The structured filters (status / applicator / date range) are pushed into
      // the QUERY so the 500-row cap applies to the already-filtered set — otherwise
      // filtering for an older date/assignee could falsely show "No jobs" when the
      // matches sit beyond the newest-500 slice (Codex P2). Recipe (#39) and the
      // free-text search stay client-side in selectDispatchView. Ordered job_date
      // DESC + limit 500 so the MOST RECENT matching jobs are kept (Codex P1).
      // Mirrors the office Jobs list. Applicator name is resolved from the
      // applicators view below (never a profiles embed — RLS nulls it for non-admins).
      // Applicator filter must match the DISPLAYED assignee, which can now come from
      // a per-location dispatch, not only jobs.applicator_id. Crucially it must match
      // the SAME semantics as the row label (aggregateAssignedTo): once a job has ANY
      // per-location dispatch, the legacy jobs.applicator_id is HIDDEN. So the server
      // filter (which runs BEFORE the 500-row cap) matches:
      //   (a) jobs dispatched to this applicator at the location level, OR
      //   (b) jobs whose job-level applicator is this one AND that have NO per-location
      //       dispatch at all (so a stale job-level assignment on a now-split job does
      //       NOT consume cap slots and hide real per-location matches — Codex #36 P2,
      //       re-review-8 P2). This keeps the capped query consistent with the label.
      let locDispatchJobIds: string[] = [];
      let anyDispatchedJobIds: string[] = [];
      if (filters.applicatorId) {
        // Paginated reads (#36 P2): page past the API row cap so the filter / exclusion
        // set stay complete once the dispatch table grows.
        const [locIds, anyIds] = await Promise.all([
          fetchDispatchedJobIds({ applicatorId: filters.applicatorId }),
          fetchDispatchedJobIds({}),
        ]);
        if (locIds === null) {
          Sentry.captureException(new Error('dispatch_filter_job_ids read failed'), { tags: { source: 'fetch', action: 'dispatch_filter_job_ids' } });
        } else {
          locDispatchJobIds = locIds;
        }
        if (anyIds === null) {
          Sentry.captureException(new Error('dispatch_any_job_ids read failed'), { tags: { source: 'fetch', action: 'dispatch_any_job_ids' } });
        } else {
          anyDispatchedJobIds = anyIds;
        }
      }

      let jobsQuery = supabase
        .from('jobs')
        .select(`
          *,
          customer:customers(farm_name),
          job_fields(id, field_id, acres_to_treat, sort_order, field:fields(id, field_name))
        `)
        .is('deleted_at', null);
      if (filters.status !== 'all') jobsQuery = jobsQuery.eq('status', filters.status);
      if (filters.applicatorId) {
        // (b) job-level branch: applicator_id = X, excluding jobs that have ANY
        //     per-location dispatch (those show per-location assignees, not the
        //     legacy job-level one). NOT-IN an empty list is a no-op, so guard it.
        const jobLevelBranch = anyDispatchedJobIds.length > 0
          ? `and(applicator_id.eq.${filters.applicatorId},id.not.in.(${anyDispatchedJobIds.join(',')}))`
          : `applicator_id.eq.${filters.applicatorId}`;
        jobsQuery = locDispatchJobIds.length > 0
          ? jobsQuery.or(`id.in.(${locDispatchJobIds.join(',')}),${jobLevelBranch}`)
          // no per-location dispatch to this applicator → just the (b) branch.
          : jobsQuery.or(jobLevelBranch);
      }
      if (filters.startDate) jobsQuery = jobsQuery.gte('job_date', filters.startDate);
      if (filters.endDate) jobsQuery = jobsQuery.lte('job_date', filters.endDate);
      jobsQuery = jobsQuery.order('job_date', { ascending: false, nullsFirst: false }).limit(500);

      const [jobsRes, applicatorsRes, recipesRes, crewsRes] = await Promise.all([
        jobsQuery,
        supabase
          .from('profile_public_view')
          .select('id, full_name, role')
          .in('role', ['applicator', 'driver', 'admin'])
          .eq('is_active', true)
          .order('full_name'),
        // Only LIVE recipes in the picker — match BlendRecipes.tsx (soft-deleted
        // recipes are excluded via deleted_at) so #39's recipe filter never lists a
        // stale/removed recipe to applicators (Codex P3).
        supabase
          .from('blend_recipes')
          .select('id, name')
          .is('deleted_at', null)
          .order('name'),
        // Active crews for the dispatch wizard's crew option (#21 / #36).
        supabase
          .from('ground_crews')
          .select('id, name')
          .eq('is_active', true)
          .order('name'),
      ]);

      if (jobsRes.error) throw jobsRes.error;

      // Applicator name map from the parallel applicators fetch (no extra round-trip).
      // Crews keyed too so a per-location crew dispatch resolves to a display name.
      const applicatorNameMap: Record<string, string> = {};
      ((applicatorsRes.data || []) as Array<{ id: string; full_name: string }>).forEach((a) => {
        applicatorNameMap[a.id] = a.full_name;
      });
      const crewNameMap: Record<string, string> = {};
      ((crewsRes.data || []) as Array<{ id: string; name: string }>).forEach((c) => {
        crewNameMap[c.id] = c.name;
      });

      // Per-location dispatch rows for the visible jobs (#36). Scoped to the job
      // ids we loaded so the row's 'Assigned To' can AGGREGATE every distinct
      // per-location assignee (a job split between two applicators shows BOTH).
      const jobIds = (jobsRes.data || []).map((j: Record<string, unknown>) => j.id as string);
      const dispatchesByJob: Record<string, string[]> = {};
      // Per-job set of applicator ids dispatched at the location level — feeds the
      // client-side Applicator filter so a job whose only Bob-link is a per-location
      // dispatch still matches a "Bob" filter (Codex #36 P2).
      const dispatchApplicatorIdsByJob: Record<string, string[]> = {};
      if (jobIds.length > 0) {
        // Paginate (#36 P2): up to 500 jobs each with multiple locations can exceed
        // the API row cap, so page via .range() until a short page ends the scan;
        // an error aborts the aggregation (best-effort — the row still renders, just
        // without per-location assignees).
        for (let from = 0; ; from += DISPATCH_PAGE) {
          const dispatchRes = await supabase
            .from('job_location_dispatches')
            .select('job_id, applicator_id, crew_id')
            .in('job_id', jobIds)
            .eq('dispatch_status', 'dispatched')
            .range(from, from + DISPATCH_PAGE - 1);
          if (dispatchRes.error) {
            Sentry.captureException(dispatchRes.error, { tags: { source: 'fetch', action: 'dispatch_location_rows' } });
            break;
          }
          const rows = (dispatchRes.data || []) as Array<{ job_id: string; applicator_id: string | null; crew_id: string | null }>;
          for (const d of rows) {
            if (d.applicator_id) (dispatchApplicatorIdsByJob[d.job_id] ||= []).push(d.applicator_id);
            const name = d.applicator_id
              ? applicatorNameMap[d.applicator_id]
              : d.crew_id
                ? crewNameMap[d.crew_id]
                : null;
            if (!name) continue;
            (dispatchesByJob[d.job_id] ||= []).push(name);
          }
          if (rows.length < DISPATCH_PAGE) break;
        }
      }

      const mapped: DispatchJob[] = (jobsRes.data || []).map((j: Record<string, unknown>) => {
        const jobLevelName = j.applicator_id ? applicatorNameMap[j.applicator_id as string] || null : null;
        const jobFields = (j.job_fields as Array<{ id?: string; field_id?: string; acres_to_treat?: number | null; field?: { field_name?: string } }>) || [];
        const customerName = (j.customer as { farm_name?: string })?.farm_name || 'Unknown';
        return {
          ...j,
          customer_name: customerName,
          assigned_to_label: aggregateAssignedTo(dispatchesByJob[j.id as string] || [], jobLevelName),
          dispatched_applicator_ids: dispatchApplicatorIdsByJob[j.id as string] || [],
          field_names: jobFields.map((jf) => jf.field?.field_name).filter(Boolean).join(', ') || null,
          field_ids: jobFields.map((jf) => jf.field_id).filter(Boolean) as string[],
          locations: jobFields
            .filter((jf) => jf.id)
            .map((jf) => ({
              jobFieldId: jf.id as string,
              jobId: j.id as string,
              jobNumber: (j.job_number as string) || '—',
              customerName,
              fieldName: jf.field?.field_name || 'Field',
              acres: jf.acres_to_treat ?? null,
            })),
        };
      }) as DispatchJob[];

      setJobs(mapped);
      setApplicators((applicatorsRes.data || []) as Pick<Profile, 'id' | 'full_name' | 'role'>[]);
      setCrews((crewsRes.data || []) as { id: string; name: string }[]);
      setRecipes((recipesRes.data || []) as { id: string; name: string }[]);

      // Best-effort map geometry: the boundary/centroid columns power the MAP view
      // only. If they're unavailable (e.g. a DB without the geometry columns) the
      // map simply shows no boundaries — the list view is unaffected.
      const fieldsRes = await supabase
        .from('fields')
        .select('id, field_name, boundary_geojson, centroid_lat, centroid_lng, total_acres, crop_type, customer_id, customer:customers(farm_name)')
        .eq('is_active', true);
      if (fieldsRes.error) {
        Sentry.captureException(fieldsRes.error, { tags: { source: 'fetch', action: 'dispatch_map_fields' } });
        setAllFields([]);
      } else {
        setAllFields((fieldsRes.data || []) as unknown as Field[]);
      }
    } catch (err) {
      Sentry.captureException(err);
      toast('error', 'Failed to load dispatch data');
    }
    setLoading(false);
    // Refetch when a SERVER-pushed filter changes (status/applicator/date). Recipe
    // and free-text search are client-side only, so they don't trigger a refetch.
  }, [toast, filters.status, filters.applicatorId, filters.startDate, filters.endDate]);

  useEffect(() => { fetchData(); }, [fetchData]);

  // Close the OPTIONS menu on an outside click / Escape (touch-friendly).
  useEffect(() => {
    if (!optionsOpen && !recipeMenuOpen) return;
    function onDown(e: MouseEvent) {
      if (optionsRef.current && !optionsRef.current.contains(e.target as Node)) {
        setOptionsOpen(false);
        setRecipeMenuOpen(false);
      }
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') { setOptionsOpen(false); setRecipeMenuOpen(false); }
    }
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [optionsOpen, recipeMenuOpen]);

  // The active view for the map/list toggle. 'dispatch'/'dispatched' sections
  // reuse the LIST rendering but with their own framing.
  const activeView: DispatchView = section === 'map' ? 'map' : 'list';

  // Only admins/sales_reps can dispatch — the dispatch_job_locations RPC is
  // admin/sales-only, so an applicator who reaches /dispatch must NOT be shown the
  // wizard launcher (they'd hit INSUFFICIENT_ROLE after selecting locations). #36 P2.
  const canDispatch = profile?.role === 'admin' || profile?.role === 'sales_rep';

  // The map is kept mounted but hidden (display:none) so the shared filter survives
  // toggles. Mapbox initializes against a zero-size parent while hidden, so when the
  // user switches TO the map we tell it to re-measure — otherwise the first open can
  // render blank/mis-sized until a window resize (Codex P2). rAF lets the container's
  // real size settle after the `hidden` class is removed before we resize.
  useEffect(() => {
    if (activeView !== 'map' || !mapRef.current) return;
    const id = requestAnimationFrame(() => mapRef.current?.resize());
    return () => cancelAnimationFrame(id);
  }, [activeView]);

  // ONE filtered set, fed to whichever view renders (criterion #6).
  const visibleJobs = useMemo(
    () => selectDispatchView(jobs, filters, activeView),
    [jobs, filters, activeView]
  );

  // Fields for the jobs currently visible on the map.
  const jobFields = useMemo(() => {
    const fieldIds = new Set(visibleJobs.flatMap((j) => j.field_ids || []));
    return allFields.filter((f) => fieldIds.has(f.id));
  }, [visibleJobs, allFields]);

  const applicatorOnly = useMemo(
    () => applicators.filter((a) => a.role === 'applicator'),
    [applicators]
  );

  // Dispatchable locations for the wizard: every field LOCATION on a job that is
  // scheduled or in_progress (the RPC enforces this too; we pre-filter so the
  // wizard never offers a location it would reject). Respects the active filter
  // set so the wizard scopes to the same jobs the dispatcher is looking at.
  const dispatchableLocations = useMemo<DispatchLocation[]>(
    () =>
      visibleJobs
        .filter((j) => j.status === 'scheduled' || j.status === 'in_progress')
        .flatMap((j) => j.locations || []),
    [visibleJobs]
  );

  const patchFilter = useCallback(<K extends keyof DispatchFilters>(key: K, value: DispatchFilters[K]) => {
    setFilters((prev) => ({ ...prev, [key]: value }));
  }, []);

  async function handleAssign(jobId: string, applicatorId: string, licenseOverride = false) {
    assignIdem.resetKey();
    try {
      const { data, error } = await supabase.rpc('assign_job_applicator', {
        p_job_id: jobId,
        p_applicator_id: applicatorId || undefined,
        p_license_override: licenseOverride,
        p_performed_by: profile?.id ?? undefined,
        p_idempotency_key: assignIdem.getKey(),
      });
      if (error) throw error;
      assertRpcResult(data, 'assign_job_applicator');
      assignIdem.resetKey();
      toast('success', licenseOverride ? 'Applicator assigned (license override)' : 'Applicator assigned');
      fetchData();
    } catch (err) {
      if (hasRpcCode(err, RpcErrorCodes.LICENSE_EXPIRED)) {
        if (profile?.role === 'admin') {
          setLicenseOverridePrompt({ jobId, applicatorId });
        } else {
          toast('error', "This applicator's license has expired — an admin can override if needed.");
        }
        return;
      }
      Sentry.captureException(err, { tags: { source: 'action', action: 'assign_applicator' } });
      toast('error', 'Failed to assign applicator. Please try again.');
    }
  }

  const filtersActive = hasActiveDispatchFilter(filters);
  const activeRecipeName = filters.recipeId
    ? recipes.find((r) => r.id === filters.recipeId)?.name ?? null
    : null;

  // --- Left rail nav config ---
  const navGroups: { label: string; items: { id: NavSection; label: string; icon: JSX.Element }[] }[] = [
    {
      label: 'Jobs',
      items: [
        { id: 'map', label: 'View Map', icon: <MapIcon className="w-5 h-5" /> },
        { id: 'list', label: 'View List', icon: <ListIcon className="w-5 h-5" /> },
      ],
    },
    {
      label: 'Dispatch',
      items: [
        { id: 'dispatch', label: 'Dispatch Jobs', icon: <Send className="w-5 h-5" /> },
        { id: 'dispatched', label: 'View Dispatched List', icon: <ClipboardList className="w-5 h-5" /> },
      ],
    },
  ];

  return (
    <div className="-m-4 sm:-m-6 lg:-m-8 min-h-[calc(100vh-4rem)] bg-slate-950 text-slate-100">
      <div className="flex flex-col lg:flex-row min-h-[calc(100vh-4rem)]">
        {/* LEFT RAIL — nav groups (criterion #2) */}
        <nav className="lg:w-60 flex-shrink-0 bg-slate-900 border-b lg:border-b-0 lg:border-r border-slate-800 p-3 lg:p-4">
          <div className="flex items-center gap-2 px-2 pb-3 mb-2 border-b border-slate-800">
            <Truck className="w-6 h-6 text-crx-green" />
            <span className="text-base font-semibold tracking-wide">Dispatch</span>
          </div>
          <div className="flex flex-row lg:flex-col gap-4 lg:gap-5">
            {navGroups.map((group) => (
              <div key={group.label} className="flex-1 lg:flex-none">
                <p className="px-2 mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-slate-500">{group.label}</p>
                <div className="space-y-1">
                  {group.items.map((item) => {
                    const active = section === item.id;
                    return (
                      <button
                        key={item.id}
                        onClick={() => setSection(item.id)}
                        aria-current={active ? 'page' : undefined}
                        className={`w-full flex items-center gap-3 px-3 py-3 rounded-lg text-left text-sm font-medium transition-colors min-h-[44px] ${
                          active
                            ? 'bg-crx-green/20 text-crx-green ring-1 ring-crx-green/40'
                            : 'text-slate-300 hover:bg-slate-800 hover:text-white'
                        }`}
                      >
                        <span className={active ? 'text-crx-green' : 'text-slate-400'}>{item.icon}</span>
                        <span>{item.label}</span>
                      </button>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        </nav>

        {/* MAIN PANEL */}
        <div className="flex-1 min-w-0 flex flex-col">
          {/* Toolbar: section title + search + OPTIONS menu */}
          <div className="flex items-center gap-3 px-4 py-3 border-b border-slate-800 bg-slate-900/60">
            <h1 className="text-lg font-semibold flex items-center gap-2 flex-shrink-0">
              {section === 'map' && <><MapIcon className="w-5 h-5 text-crx-green" /> Job Map</>}
              {section === 'list' && <><ListIcon className="w-5 h-5 text-crx-green" /> Job List</>}
              {section === 'dispatch' && <><Send className="w-5 h-5 text-crx-green" /> Dispatch Jobs</>}
              {section === 'dispatched' && <><ClipboardList className="w-5 h-5 text-crx-green" /> Dispatched List</>}
            </h1>

            {/* Quick search (part of the shared filter) */}
            <div className="relative flex-1 max-w-sm hidden sm:block">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-500" />
              <input
                type="text"
                value={filters.search}
                onChange={(e) => patchFilter('search', e.target.value)}
                placeholder="Search job # or customer…"
                className="w-full pl-9 pr-3 py-2.5 rounded-lg bg-slate-800 border border-slate-700 text-sm text-slate-100 placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-crx-green/40 focus:border-crx-green"
              />
            </div>

            <div className="ml-auto flex items-center gap-2">
              {filtersActive && (
                <button
                  onClick={() => setFilters(emptyDispatchFilters)}
                  className="hidden sm:inline-flex items-center gap-1 px-3 py-2 text-xs font-medium text-slate-300 hover:text-white rounded-lg hover:bg-slate-800"
                >
                  <X className="w-3.5 h-3.5" /> Clear filters
                </button>
              )}

              {/* OPTIONS menu (criterion #5) */}
              <div className="relative" ref={optionsRef}>
                <button
                  onClick={() => { setOptionsOpen((v) => !v); setRecipeMenuOpen(false); }}
                  aria-haspopup="menu"
                  aria-expanded={optionsOpen}
                  className="inline-flex items-center gap-1.5 px-3 py-2.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-sm font-medium text-slate-100 min-h-[44px]"
                >
                  <MoreVertical className="w-4 h-4" /> Options
                </button>
                {optionsOpen && (
                  <div role="menu" className="absolute right-0 mt-2 w-64 rounded-xl bg-slate-800 border border-slate-700 shadow-2xl py-1.5 z-50">
                    {/* Filter Jobs By Recipe — section #39 stub (entry + simple recipe picker) */}
                    <button
                      role="menuitem"
                      onClick={() => setRecipeMenuOpen((v) => !v)}
                      className="w-full flex items-center gap-3 px-4 py-3 text-sm text-slate-200 hover:bg-slate-700 min-h-[44px]"
                    >
                      <FlaskConical className="w-4 h-4 text-slate-400" />
                      <span className="flex-1 text-left">Filter Jobs By Recipe</span>
                      {activeRecipeName && <span className="text-xs text-crx-green truncate max-w-[80px]">{activeRecipeName}</span>}
                    </button>
                    {recipeMenuOpen && (
                      <div className="max-h-56 overflow-y-auto border-y border-slate-700 bg-slate-900 py-1">
                        <button
                          onClick={() => { patchFilter('recipeId', ''); setRecipeMenuOpen(false); setOptionsOpen(false); }}
                          className={`w-full text-left px-6 py-2.5 text-sm hover:bg-slate-700 ${!filters.recipeId ? 'text-crx-green' : 'text-slate-300'}`}
                        >
                          All recipes
                        </button>
                        {recipes.length === 0 && (
                          <p className="px-6 py-2 text-xs text-slate-500">No recipes yet</p>
                        )}
                        {recipes.map((r) => (
                          <button
                            key={r.id}
                            onClick={() => { patchFilter('recipeId', r.id); setRecipeMenuOpen(false); setOptionsOpen(false); }}
                            className={`w-full text-left px-6 py-2.5 text-sm hover:bg-slate-700 ${filters.recipeId === r.id ? 'text-crx-green' : 'text-slate-300'}`}
                          >
                            {r.name}
                          </button>
                        ))}
                      </div>
                    )}
                    <button
                      role="menuitem"
                      onClick={() => { setMoreSearchOpen(true); setOptionsOpen(false); }}
                      className="w-full flex items-center gap-3 px-4 py-3 text-sm text-slate-200 hover:bg-slate-700 min-h-[44px]"
                    >
                      <SlidersHorizontal className="w-4 h-4 text-slate-400" /> More Search Options
                    </button>
                    <button
                      role="menuitem"
                      onClick={() => { setSection((v) => (v === 'map' ? 'list' : 'map')); setOptionsOpen(false); }}
                      className="w-full flex items-center gap-3 px-4 py-3 text-sm text-slate-200 hover:bg-slate-700 min-h-[44px]"
                    >
                      {activeView === 'map' ? <ListIcon className="w-4 h-4 text-slate-400" /> : <MapIcon className="w-4 h-4 text-slate-400" />}
                      Switch View ({activeView === 'map' ? 'to List' : 'to Map'})
                    </button>
                    <button
                      role="menuitem"
                      onClick={() => navigate('/jobs/new')}
                      className="w-full flex items-center gap-3 px-4 py-3 text-sm text-slate-200 hover:bg-slate-700 min-h-[44px]"
                    >
                      <Plus className="w-4 h-4 text-slate-400" /> Add New Job
                    </button>
                    <button
                      role="menuitem"
                      onClick={() => { fetchData(); setOptionsOpen(false); }}
                      className="w-full flex items-center gap-3 px-4 py-3 text-sm text-slate-200 hover:bg-slate-700 min-h-[44px]"
                    >
                      <RefreshCw className="w-4 h-4 text-slate-400" /> Reload List
                    </button>
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* Active-filter chips */}
          {filtersActive && (
            <div className="flex flex-wrap items-center gap-2 px-4 py-2 bg-slate-900/40 border-b border-slate-800 text-xs">
              <span className="text-slate-500">Filters:</span>
              {filters.status !== 'all' && <FilterChip label={`Status: ${filters.status}`} onClear={() => patchFilter('status', 'all')} />}
              {filters.applicatorId && <FilterChip label={`Applicator: ${applicatorOnly.find((a) => a.id === filters.applicatorId)?.full_name ?? '—'}`} onClear={() => patchFilter('applicatorId', '')} />}
              {activeRecipeName && <FilterChip label={`Recipe: ${activeRecipeName}`} onClear={() => patchFilter('recipeId', '')} />}
              {filters.search.trim() && <FilterChip label={`Search: ${filters.search}`} onClear={() => patchFilter('search', '')} />}
              {(filters.startDate || filters.endDate) && <FilterChip label={`Date: ${filters.startDate || '…'} → ${filters.endDate || '…'}`} onClear={() => setFilters((p) => ({ ...p, startDate: '', endDate: '' }))} />}
            </div>
          )}

          {/* CONTENT */}
          <div className="flex-1 overflow-hidden">
            {loading ? (
              <div className="p-6 space-y-3">
                {[1, 2, 3, 4].map((i) => (
                  <div key={i} className="h-24 rounded-xl bg-slate-800/60 animate-pulse" />
                ))}
              </div>
            ) : section === 'dispatched' ? (
              <DispatchedListPlaceholder />
            ) : (
              <>
                {/* MAP VIEW — kept MOUNTED and toggled with CSS (`hidden`) rather than
                    conditionally unmounted. The map engine (Mapbox) is expensive to
                    tear down/rebuild and its unmount can disturb the React tree; by
                    never unmounting it, switching map<->list preserves the shared
                    filter/section state (criterion #6). The map is also wrapped in its
                    OWN error boundary so a map failure (e.g. a missing Mapbox token)
                    is contained to the map panel and never tears down the page. */}
                <div className={`h-[calc(100vh-12rem)] m-3 rounded-xl overflow-hidden border border-slate-800 ${activeView === 'map' ? '' : 'hidden'}`}>
                  <ErrorBoundary inline>
                    <CRXMap
                      className="h-full min-h-[400px]"
                      showLayerToggle
                      interactive
                      onMapLoad={(map) => { mapRef.current = map; }}
                    >
                      <FieldBoundaryLayer
                        fields={jobFields as (Field & { customer_name?: string })[]}
                        showLabels
                        onFieldClick={(fieldId) => {
                          const job = visibleJobs.find((j) => j.field_ids?.includes(fieldId));
                          if (job) setSelectedJobId(job.id);
                        }}
                      />
                    </CRXMap>
                  </ErrorBoundary>
                </div>

                {/* LIST VIEW (also used by the Dispatch Jobs section) */}
                <div className={`p-3 sm:p-4 space-y-3 overflow-y-auto h-[calc(100vh-12rem)] ${activeView === 'list' ? '' : 'hidden'}`}>
                  {/* Mobile search */}
                  <div className="relative sm:hidden">
                    <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-500" />
                    <input
                      type="text"
                      value={filters.search}
                      onChange={(e) => patchFilter('search', e.target.value)}
                      placeholder="Search job # or customer…"
                      className="w-full pl-9 pr-3 py-3 rounded-lg bg-slate-800 border border-slate-700 text-sm text-slate-100 placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-crx-green/40"
                    />
                  </div>

                  {/* Dispatch Jobs: a single prominent launcher for the 3-step wizard,
                      which selects field locations across the visible jobs (#36).
                      Only shown to dispatchers (admin/sales_rep) — the RPC is gated to
                      them, so an applicator must not be offered the wizard (#36 P2). */}
                  {section === 'dispatch' && canDispatch && (
                    <div className="flex items-center justify-between gap-3 rounded-xl border border-crx-green/30 bg-crx-green/10 px-4 py-3">
                      <p className="text-sm text-slate-200">
                        Dispatch individual field locations to applicators or crews.
                        <span className="text-slate-400"> {dispatchableLocations.length} dispatchable location{dispatchableLocations.length === 1 ? '' : 's'}.</span>
                      </p>
                      <button
                        onClick={() => setWizardOpen(true)}
                        disabled={dispatchableLocations.length === 0}
                        className="inline-flex items-center gap-2 px-4 py-2.5 rounded-lg bg-crx-green text-sm font-semibold text-white hover:bg-crx-green/90 disabled:opacity-40 disabled:cursor-not-allowed min-h-[44px] flex-shrink-0"
                      >
                        <Send className="w-4 h-4" /> Start Dispatch
                      </button>
                    </div>
                  )}
                  {section === 'dispatch' && !canDispatch && (
                    <div className="rounded-xl border border-slate-800 bg-slate-900/50 px-4 py-3 text-sm text-slate-400">
                      Dispatching is handled by an admin or sales rep. You can view your assigned jobs in the list below.
                    </div>
                  )}

                  {visibleJobs.length === 0 ? (
                    <div className="rounded-xl border border-slate-800 bg-slate-900/50 p-10 text-center">
                      <p className="text-slate-400">No jobs match the current filters.</p>
                    </div>
                  ) : (
                    visibleJobs.map((job) => {
                      const badge = jobStatusToDispatchBadge(job.status);
                      const selected = selectedJobId === job.id;
                      const showAssign = section === 'dispatch' && canDispatch;
                      return (
                        <div
                          key={job.id}
                          role="button"
                          tabIndex={0}
                          onClick={() => setSelectedJobId(selected ? null : job.id)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter' || e.key === ' ') {
                              e.preventDefault();
                              setSelectedJobId(selected ? null : job.id);
                            }
                          }}
                          className={`rounded-xl border bg-slate-900 p-4 transition-colors cursor-pointer ${
                            selected ? 'border-crx-green ring-1 ring-crx-green/40' : 'border-slate-800 hover:border-slate-600'
                          }`}
                        >
                          <div className="flex items-start justify-between gap-3">
                            <div className="min-w-0">
                              <div className="flex items-center gap-2 flex-wrap">
                                <button
                                  onClick={(e) => { e.stopPropagation(); navigate(`/jobs/${job.id}`); }}
                                  className="text-base font-semibold text-crx-green hover:underline"
                                >
                                  {job.job_number}
                                </button>
                                <span className={`px-2 py-0.5 rounded-full text-[11px] font-bold tracking-wide ${badge.className}`}>
                                  {badge.label}
                                </span>
                              </div>
                              <p className="mt-1 text-sm text-slate-200 font-medium truncate">{job.customer_name}</p>
                              {job.field_names && <p className="text-xs text-slate-500 truncate">{job.field_names}</p>}
                            </div>
                            <div className="text-right flex-shrink-0">
                              <p className="text-lg font-bold text-white tabular-nums">
                                {formatAppliedOfTotal(job.applied_acres, job.total_acres)}
                              </p>
                            </div>
                          </div>

                          {/* Assigned-To label (criteria #4/#5/#6) — aggregates the
                              per-location assignees so a job split between two applicators
                              shows BOTH names; falls back to the whole-job applicator. */}
                          {job.assigned_to_label && (
                            <div className="mt-3 flex items-center gap-2 text-sm">
                              <Users className="w-4 h-4 text-crx-green" />
                              <span className="text-slate-400">Assigned To:</span>
                              <span className="font-semibold text-slate-100">{job.assigned_to_label}</span>
                            </div>
                          )}

                          {/* Dispatch Jobs section: launch the per-location 3-step wizard
                              (#36). The wizard handles selecting locations across jobs and
                              assigning each to an applicator/crew. */}
                          {showAssign && (job.status === 'scheduled' || job.status === 'in_progress') && (
                            <div className="mt-3 flex items-center gap-2" role="presentation" onClick={(e) => e.stopPropagation()}>
                              <button
                                onClick={() => setWizardOpen(true)}
                                className="inline-flex items-center gap-2 px-3 py-2.5 rounded-lg bg-crx-green/15 border border-crx-green/40 text-sm font-medium text-crx-green hover:bg-crx-green/25 min-h-[44px]"
                              >
                                <Send className="w-4 h-4" /> Dispatch Locations
                              </button>
                            </div>
                          )}
                        </div>
                      );
                    })
                  )}
                </div>
              </>
            )}
          </div>
        </div>
      </div>

      {/* MORE SEARCH OPTIONS drawer */}
      {moreSearchOpen && (
        <div className="fixed inset-0 z-50 flex justify-end" role="dialog" aria-modal="true" aria-label="More search options">
          <button type="button" aria-label="Close more search options" className="absolute inset-0 bg-black/60" onClick={() => setMoreSearchOpen(false)} />
          <div className="relative w-full max-w-sm h-full bg-slate-900 border-l border-slate-800 p-5 overflow-y-auto">
            <div className="flex items-center justify-between mb-5">
              <h2 className="text-base font-semibold flex items-center gap-2"><SlidersHorizontal className="w-5 h-5 text-crx-green" /> More Search Options</h2>
              <button onClick={() => setMoreSearchOpen(false)} className="p-2 rounded-lg hover:bg-slate-800 text-slate-400"><X className="w-5 h-5" /></button>
            </div>
            <div className="space-y-4">
              <label className="block">
                <span className="text-xs font-medium uppercase tracking-wider text-slate-500">Status</span>
                <select
                  value={filters.status}
                  onChange={(e) => patchFilter('status', e.target.value as DispatchFilters['status'])}
                  className="mt-1.5 w-full rounded-lg bg-slate-800 border border-slate-700 px-3 py-3 text-sm text-slate-100 min-h-[44px]"
                >
                  <option value="all">All Statuses</option>
                  <option value="scheduled">Pending (Scheduled)</option>
                  <option value="in_progress">Active (In Progress)</option>
                  <option value="completed">Completed</option>
                  <option value="invoiced">Invoiced</option>
                  <option value="cancelled">Cancelled</option>
                </select>
              </label>
              <label className="block">
                <span className="text-xs font-medium uppercase tracking-wider text-slate-500">Applicator</span>
                <select
                  value={filters.applicatorId}
                  onChange={(e) => patchFilter('applicatorId', e.target.value)}
                  className="mt-1.5 w-full rounded-lg bg-slate-800 border border-slate-700 px-3 py-3 text-sm text-slate-100 min-h-[44px]"
                >
                  <option value="">All Applicators</option>
                  {applicatorOnly.map((a) => (
                    <option key={a.id} value={a.id}>{a.full_name}</option>
                  ))}
                </select>
              </label>
              <div className="grid grid-cols-2 gap-3">
                <label className="block">
                  <span className="text-xs font-medium uppercase tracking-wider text-slate-500">From</span>
                  <input type="date" value={filters.startDate} onChange={(e) => patchFilter('startDate', e.target.value)} className="mt-1.5 w-full rounded-lg bg-slate-800 border border-slate-700 px-3 py-3 text-sm text-slate-100 min-h-[44px]" />
                </label>
                <label className="block">
                  <span className="text-xs font-medium uppercase tracking-wider text-slate-500">To</span>
                  <input type="date" value={filters.endDate} onChange={(e) => patchFilter('endDate', e.target.value)} className="mt-1.5 w-full rounded-lg bg-slate-800 border border-slate-700 px-3 py-3 text-sm text-slate-100 min-h-[44px]" />
                </label>
              </div>
              <div className="flex gap-3 pt-2">
                <button onClick={() => setFilters(emptyDispatchFilters)} className="flex-1 px-4 py-3 rounded-lg border border-slate-700 text-sm text-slate-200 hover:bg-slate-800 min-h-[44px]">Clear All</button>
                <button onClick={() => setMoreSearchOpen(false)} className="flex-1 px-4 py-3 rounded-lg bg-crx-green text-sm font-semibold text-white hover:bg-crx-green/90 min-h-[44px]">Done</button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* License-override confirm (admin only) */}
      <ConfirmModal
        open={licenseOverridePrompt !== null}
        onClose={() => setLicenseOverridePrompt(null)}
        onConfirm={() => {
          if (licenseOverridePrompt) {
            const { jobId, applicatorId } = licenseOverridePrompt;
            setLicenseOverridePrompt(null);
            handleAssign(jobId, applicatorId, true);
          }
        }}
        title="Applicator License Expired"
        message="This applicator's license has expired. Assign them to this job anyway? The override is recorded in the activity log."
        confirmLabel="Assign Anyway"
        variant="warning"
      />

      {/* Per-location dispatch wizard (#36) — 3 steps: Select / Assign / Finish. */}
      <DispatchWizard
        open={wizardOpen}
        onClose={() => setWizardOpen(false)}
        locations={dispatchableLocations}
        applicators={applicatorOnly.map((a) => ({ id: a.id, full_name: a.full_name }))}
        crews={crews}
        performedBy={profile?.id || ''}
        isAdmin={profile?.role === 'admin'}
        onDispatched={fetchData}
      />
    </div>
  );
}

/** Small dark-mode filter chip with a clear (x) action. */
function FilterChip({ label, onClear }: { label: string; onClear: () => void }) {
  return (
    <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-slate-800 border border-slate-700 text-slate-200">
      {label}
      <button onClick={onClear} className="text-slate-500 hover:text-white" aria-label={`Clear ${label}`}>
        <X className="w-3 h-3" />
      </button>
    </span>
  );
}

/**
 * 'View Dispatched List' placeholder. The full dispatched-list view (per-location
 * dispatch records, crew assignment, status) is section #37. This is a deliberate
 * stub that names the future feature so the nav entry is real today.
 */
function DispatchedListPlaceholder() {
  return (
    <div className="p-6 flex items-center justify-center h-[calc(100vh-12rem)]">
      <div className="max-w-md text-center rounded-2xl border border-dashed border-slate-700 bg-slate-900/50 p-10">
        <ClipboardList className="w-10 h-10 text-slate-600 mx-auto mb-4" />
        <h2 className="text-base font-semibold text-slate-200">Dispatched List</h2>
        <p className="mt-2 text-sm text-slate-500">
          The per-location dispatched-jobs list lands in a later build (dispatch section #37).
          For now, assign applicators from <span className="text-slate-300">Dispatch Jobs</span>;
          assigned jobs show their <span className="text-slate-300">Assigned To</span> name in the list.
        </p>
      </div>
    </div>
  );
}
