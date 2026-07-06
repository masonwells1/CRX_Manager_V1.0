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
  RotateCcw,
  UserMinus,
  Loader2,
  MapPin,
} from 'lucide-react';
import type { MapRef } from 'react-map-gl/mapbox';
import CRXMap from '../components/map/CRXMap';
import FieldBoundaryLayer from '../components/map/FieldBoundaryLayer';
import ErrorBoundary from '../components/ErrorBoundary';
import DispatchWizard from '../components/dispatch/DispatchWizard';
import { usePageMeta } from '../hooks/usePageMeta';
import { useToast } from '../components/ui/Toast';
import { useAuth } from '../contexts/AuthContext';
import { supabase, supabaseUntyped, assertRpcResult, hasRpcCode, RpcErrorCodes } from '../lib/db';
import ConfirmModal from '../components/ui/ConfirmModal';
import { generateIdempotencyKey } from '../lib/idempotency';
import type { Json } from '../types/supabase';
import { Sentry } from '../lib/sentry';
import {
  formatAppliedOfTotal,
  jobStatusToDispatchBadge,
  selectDispatchView,
  hasActiveDispatchFilter,
  emptyDispatchFilters,
  filterDispatchedRows,
  hasActiveDispatchedFilter,
  emptyDispatchedAssigneeFilter,
  type DispatchFilters,
  type DispatchView,
  type DispatchedListRow,
  type DispatchedAssigneeFilter,
} from '../lib/dispatchDisplay';
import { aggregateAssignedTo, type DispatchLocation } from '../lib/dispatchWizard';
import type { Job, Profile, Field, DispatchStockRow } from '../types';

type NavSection = 'map' | 'list' | 'dispatch' | 'dispatched';

// Page size for the per-job dispatch-row aggregation below (the Supabase Data API
// caps a single response at ~1000 rows, so we page via .range() until a short page
// signals the end). The applicator FILTER itself no longer reads this table from the
// client — it is resolved server-side by get_dispatch_board_jobs (review #36 MED).
const DISPATCH_PAGE = 1000;

// Layer 1 (inventory-aware dispatch): per-job product needs + a stock light computed
// vs today's free stock (available − prebooked − active holds). Read-only overlay — it
// warns, never blocks, and reserves nothing.
type JobStockStatus = 'ok' | 'low' | 'short' | 'unknown';
interface JobChemNeed {
  product_id: string;
  product_name: string;
  quantity: number;
  unit: string | null;
  inventory_unit: string | null;
  product_form: string | null;
  /** U4 (#53): grower-supplied — applied but demands nothing from OUR shed, so it
   *  must not trip the stock light (the stock RPC excludes it server-side too). */
  customer_supplied: boolean;
}
const STOCK_SEVERITY: Record<JobStockStatus, number> = { unknown: 0, ok: 1, low: 2, short: 3 };
const worseStock = (a: JobStockStatus, b: JobStockStatus): JobStockStatus =>
  STOCK_SEVERITY[b] > STOCK_SEVERITY[a] ? b : a;

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
  /** Layer 1: product needs for this job (job_chemicals). */
  chemicals?: JobChemNeed[];
  /** Layer 1: stock light vs today's free stock — schedulable jobs only. */
  stock_status?: JobStockStatus;
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
      // Applicator filter must match the DISPLAYED assignee, which can now come from a
      // per-location dispatch, not only jobs.applicator_id, and must match the SAME
      // semantics as the row label (aggregateAssignedTo): once a job has ANY per-location
      // dispatch, the legacy jobs.applicator_id is HIDDEN. The whole match is resolved
      // SERVER-SIDE by get_dispatch_board_jobs (review #36 MED fix): it returns, IN SQL,
      // the FULLY-SHAPED job rows that match this applicator —
      //   (a) jobs with a CURRENT per-location dispatch to this applicator (that the
      //       caller can see), UNION
      //   (b) jobs whose whole-job applicator is this one AND have NO per-location
      //       dispatch at all —
      // already intersected with the caller's job visibility, ordered job_date DESC and
      // capped at 500. CRUCIALLY this returns ROWS, not ids: it replaces BOTH the old
      // unbounded `id.not.in.(<every globally-dispatched job id>)` AND any follow-on
      // `id.in.(<matched ids>)` — neither a whole-table NOR a per-applicator id list ever
      // enters a request URL (a 500-uuid `id=in.(...)` is ~19.7KB and already fails the
      // gateway). The row carries `_dispatches` (the per-location rows the caller can
      // see) so the label aggregation needs no second round-trip either.
      let filteredJobsData: Record<string, unknown>[] | null = null;
      if (filters.applicatorId) {
        const { data: rpcRows, error: rpcErr } = await supabase.rpc('get_dispatch_board_jobs', {
          p_applicator_id: filters.applicatorId,
          p_status: filters.status !== 'all' ? filters.status : undefined,
          p_start_date: filters.startDate || undefined,
          p_end_date: filters.endDate || undefined,
        });
        // A real error OR a null result (Supabase returns null, not an error, when an RPC
        // is RLS-denied) means we cannot trust the filter. Surface the degradation rather
        // than silently falling back to a job-level-only match (which would hide a
        // location-only assignee and wrongly show a split job's stale applicator). Skip
        // the partial result and tell the user (review #36 LOW 2). An empty array (the
        // applicator legitimately has zero jobs) is fine and renders "No jobs".
        if (rpcErr || rpcRows === null) {
          Sentry.captureException(rpcErr ?? new Error('get_dispatch_board_jobs returned no data'), { tags: { source: 'fetch', action: 'dispatch_board_jobs' } });
          toast('error', 'Dispatch filter may be incomplete — please retry.');
          setJobs([]);
          setLoading(false);
          return;
        }
        filteredJobsData = assertRpcResult<Record<string, unknown>[]>(rpcRows, 'get_dispatch_board_jobs');
      }

      // The unfiltered (no applicator) path keeps the direct jobs query; the filtered
      // path uses the RPC rows above. Both share the SAME downstream shape.
      const jobsQuery = supabase
        .from('jobs')
        .select(`
          *,
          customer:customers(farm_name),
          job_fields(id, field_id, acres_to_treat, sort_order, field:fields(id, field_name))
        `)
        .is('deleted_at', null)
        .order('job_date', { ascending: false, nullsFirst: false })
        .limit(500);
      const scopedJobsQuery = (() => {
        let q = jobsQuery;
        if (filters.status !== 'all') q = q.eq('status', filters.status);
        if (filters.startDate) q = q.gte('job_date', filters.startDate);
        if (filters.endDate) q = q.lte('job_date', filters.endDate);
        return q;
      })();

      const [jobsRes, applicatorsRes, recipesRes, crewsRes] = await Promise.all([
        // When an applicator filter is active, the RPC already returned the rows; resolve
        // immediately so the rest of the load (names/crews/recipes) still runs in parallel.
        filteredJobsData !== null
          ? Promise.resolve({ data: filteredJobsData, error: null })
          : scopedJobsQuery,
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

      // Per-location dispatch rows for the visible jobs (#36), so the row's 'Assigned To'
      // can AGGREGATE every distinct per-location assignee (a job split between two
      // applicators shows BOTH).
      const dispatchesByJob: Record<string, string[]> = {};
      // Per-job set of applicator ids dispatched at the location level — feeds the
      // client-side Applicator filter so a job whose only Bob-link is a per-location
      // dispatch still matches a "Bob" filter (Codex #36 P2).
      const dispatchApplicatorIdsByJob: Record<string, string[]> = {};
      const ingestDispatchRow = (jobId: string, applicatorId: string | null, crewId: string | null) => {
        if (applicatorId) (dispatchApplicatorIdsByJob[jobId] ||= []).push(applicatorId);
        const name = applicatorId
          ? applicatorNameMap[applicatorId]
          : crewId
            ? crewNameMap[crewId]
            : null;
        if (!name) return;
        (dispatchesByJob[jobId] ||= []).push(name);
      };

      if (filteredJobsData !== null) {
        // FILTERED path: the RPC embedded `_dispatches` (the per-location rows the caller
        // can see) on each job, so we aggregate WITHOUT a second round-trip — and without
        // a `job_id=in.(<up to 500 ids>)` URL (review #36 MED).
        for (const j of filteredJobsData) {
          const ds = (j._dispatches as Array<{ applicator_id: string | null; crew_id: string | null }>) || [];
          for (const d of ds) ingestDispatchRow(j.id as string, d.applicator_id, d.crew_id);
        }
      } else {
        // UNFILTERED path: page the per-location dispatch rows for the visible jobs.
        const jobIds = (jobsRes.data || []).map((j: Record<string, unknown>) => j.id as string);
        if (jobIds.length > 0) {
          // Paginate (#36 P2): up to 500 jobs each with multiple locations can exceed the
          // API row cap, so page via .range() until a short page ends the scan; an error
          // aborts the aggregation (best-effort — the row still renders, just without
          // per-location assignees).
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
            for (const d of rows) ingestDispatchRow(d.job_id, d.applicator_id, d.crew_id);
            if (rows.length < DISPATCH_PAGE) break;
          }
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

      // Inventory-aware dispatch (Layer 1): attach each schedulable job's product needs
      // and a stock light vs today's free stock. Read-only overlay — no reservation.
      // OFFICE-ONLY: /dispatch is also applicator-accessible, and get_inventory_position
      // exposes product cost/vendor + full stock levels. Gate the whole overlay to
      // admin/sales_rep so applicators see the board unchanged (Codex P1).
      const isOffice = profile?.role === 'admin' || profile?.role === 'sales_rep';
      const activeJobIds = isOffice
        ? mapped
            .filter((j) => j.status === 'scheduled' || j.status === 'in_progress')
            .map((j) => j.id)
        : [];
      const chemByJob: Record<string, JobChemNeed[]> = {};
      // Layer 2 (B3): per-(job,product) stock-light inputs from the dedicated,
      // role-gated RPC. `free` EXCLUDES this job's own hold and `demand` is already
      // unit-converted server-side — replaces the client-side get_inventory_position
      // compute + fieldAppPricedQuantity.
      const dispatchStock: Record<string, Record<string, { demand: number; free: number; reorder: number; hasInv: boolean }>> = {};
      let stockLoaded = false;
      if (activeJobIds.length > 0) {
        // Product needs for the schedulable jobs. Chunk the job-id filter (a bare .in()
        // of up to ~500 UUIDs can exceed the request-URL limit) AND page each chunk for
        // the ~1000-row API cap.
        const JOB_ID_CHUNK = 150;
        for (let ci = 0; ci < activeJobIds.length; ci += JOB_ID_CHUNK) {
          const idChunk = activeJobIds.slice(ci, ci + JOB_ID_CHUNK);
          for (let from = 0; ; from += DISPATCH_PAGE) {
            const chemRes = await supabase
              .from('job_chemicals')
              .select('job_id, product_id, quantity, unit, customer_supplied, product:products(product_name, inventory_unit, product_form)')
              .in('job_id', idChunk)
              .range(from, from + DISPATCH_PAGE - 1);
            if (chemRes.error) {
              Sentry.captureException(chemRes.error, { tags: { source: 'fetch', action: 'dispatch_job_chemicals' } });
              break;
            }
            const rows = (chemRes.data || []) as unknown as Array<{ job_id: string; product_id: string; quantity: number | null; unit: string | null; customer_supplied?: boolean | null; product?: { product_name?: string; inventory_unit?: string | null; product_form?: string | null } | null }>;
            for (const c of rows) {
              (chemByJob[c.job_id] ||= []).push({
                product_id: c.product_id,
                product_name: c.product?.product_name || 'Product',
                quantity: Number(c.quantity) || 0,
                unit: c.unit,
                inventory_unit: c.product?.inventory_unit ?? null,
                product_form: c.product?.product_form ?? null,
                customer_supplied: c.customer_supplied ?? false,
              });
            }
            if (rows.length < DISPATCH_PAGE) break;
          }
        }
        // Stock-light inputs for exactly the schedulable jobs. Free per (job,product)
        // already excludes that job's OWN reservation server-side (still conservative
        // for every OTHER program's hold; never warns a job against itself).
        const { data: dsData, error: dsErr } = await supabaseUntyped.rpc('get_dispatch_stock_status', { p_job_ids: activeJobIds });
        if (dsErr) {
          Sentry.captureException(dsErr, { tags: { source: 'fetch', action: 'dispatch_stock_status' } });
        } else {
          const dsRows = assertRpcResult<DispatchStockRow[]>(dsData, 'get_dispatch_stock_status') || [];
          stockLoaded = true;
          for (const r of dsRows) {
            (dispatchStock[r.job_id] ||= {})[r.product_id] = {
              demand: Number(r.demand_qty) || 0,
              free: Number(r.free_excluding_own_hold) || 0,
              reorder: Number(r.reorder_point) || 0,
              hasInv: r.has_inventory === true,
            };
          }
        }
      }

      const enriched: DispatchJob[] = mapped.map((j) => {
        if (j.status !== 'scheduled' && j.status !== 'in_progress') {
          return { ...j, chemicals: [], stock_status: 'unknown' as JobStockStatus };
        }
        const chems = chemByJob[j.id] || [];
        // If the stock lookup failed (or the job has no products), show 'unknown'
        // rather than painting every job red on a transient RPC error — don't cry wolf.
        if (!stockLoaded || chems.length === 0) {
          return { ...j, chemicals: chems, stock_status: 'unknown' as JobStockStatus };
        }
        const stockForJob = dispatchStock[j.id] || {};
        let status: JobStockStatus = 'ok';
        for (const c of chems) {
          if (c.quantity <= 0) continue;
          // U4 (#53, Codex R2): grower-supplied product — the stock RPC returns no
          // row for it BY DESIGN; skip it here too or the missing row reads as short.
          if (c.customer_supplied) continue;
          // demand + free come from the RPC keyed by (job, product): demand is already
          // unit-converted and free already excludes THIS job's own hold. A missing row
          // or no inventory record for a needed product = a real shortfall signal.
          const s = stockForJob[c.product_id];
          if (!s || !s.hasInv) { status = worseStock(status, 'short'); continue; }
          if (s.demand > s.free) status = worseStock(status, 'short');
          else if (s.free - s.demand <= s.reorder) status = worseStock(status, 'low');
        }
        return { ...j, chemicals: chems, stock_status: status };
      });

      setJobs(enriched);
      setApplicators((applicatorsRes.data || []) as Pick<Profile, 'id' | 'full_name' | 'role'>[]);
      setCrews((crewsRes.data || []) as { id: string; name: string }[]);
      setRecipes((recipesRes.data || []) as { id: string; name: string }[]);

      // Best-effort map geometry. The fields table stores PostGIS geometry (boundary/
      // centroid), NOT geojson or lat/lng columns — a direct column select 42703's
      // ("column fields.boundary_geojson does not exist"). Pull display geojson from the
      // id-scoped RPC for ONLY the fields on the loaded jobs (not every field in the org).
      // If it fails the map simply shows no boundaries — the list view is unaffected.
      const mapFieldIds = Array.from(new Set(mapped.flatMap((j) => j.field_ids || [])));
      if (mapFieldIds.length === 0) {
        setAllFields([]);
      } else {
        const { data: fieldsData, error: fieldsErr } = await supabase.rpc('get_fields_geojson_by_ids', { p_field_ids: mapFieldIds });
        if (fieldsErr) {
          Sentry.captureException(fieldsErr, { tags: { source: 'fetch', action: 'dispatch_map_fields' } });
          setAllFields([]);
        } else {
          const rows = assertRpcResult<Array<Field & { is_active?: boolean }>>(fieldsData, 'get_fields_geojson_by_ids') || [];
          setAllFields(rows.filter((f) => f.is_active !== false) as unknown as Field[]);
        }
      }
    } catch (err) {
      Sentry.captureException(err);
      toast('error', 'Failed to load dispatch data');
    }
    setLoading(false);
    // Refetch when a SERVER-pushed filter changes (status/applicator/date). Recipe
    // and free-text search are client-side only, so they don't trigger a refetch.
  }, [toast, profile?.role, filters.status, filters.applicatorId, filters.startDate, filters.endDate]);

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

            {/* Quick search + Options drive the JOB filters (map/list/dispatch sections).
                The Dispatched List (#37) has its OWN assignee filter and does NOT consume
                these job filters, so showing them there is misleading (the chips would mark
                a filter active while the dispatched rows never change — Codex #37 final-3
                P2). Hide all job-filter controls on the dispatched section. */}
            {section !== 'dispatched' && (
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
            )}

            {section !== 'dispatched' && (
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
            )}
          </div>

          {/* Active-filter chips (job filters — not shown on the dispatched section) */}
          {section !== 'dispatched' && filtersActive && (
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
              <DispatchedList
                applicators={applicatorOnly}
                crews={crews}
                performedBy={profile?.id || ''}
                canDispatch={canDispatch}
                isAdmin={profile?.role === 'admin'}
                onChanged={fetchData}
              />
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

                          {/* Layer 1 — product needs + stock light vs today's free stock
                              (schedulable jobs only). Warns, never blocks; reserves nothing. */}
                          {(job.status === 'scheduled' || job.status === 'in_progress') && (job.chemicals?.length ?? 0) > 0 && (
                            <div className="mt-3 flex items-start gap-2 text-sm">
                              <span
                                className={`mt-1 inline-block w-2.5 h-2.5 rounded-full flex-shrink-0 ${
                                  job.stock_status === 'short' ? 'bg-red-500'
                                  : job.stock_status === 'low' ? 'bg-amber-400'
                                  : job.stock_status === 'ok' ? 'bg-crx-green'
                                  : 'bg-slate-600'
                                }`}
                                aria-label={
                                  job.stock_status === 'short' ? 'Short on product'
                                  : job.stock_status === 'low' ? 'Stock tight'
                                  : 'In stock'
                                }
                              />
                              <div className="min-w-0">
                                <p className="text-slate-300 text-xs truncate">
                                  {(job.chemicals ?? []).map((c) => c.product_name).join(', ')}
                                </p>
                                {job.stock_status === 'short' && (
                                  <p className="text-red-400 text-xs font-medium">Short on product — check inventory before dispatch.</p>
                                )}
                                {job.stock_status === 'low' && (
                                  <p className="text-amber-400 text-xs font-medium">Stock is tight for this job.</p>
                                )}
                              </div>
                            </div>
                          )}

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

interface DispatchedListProps {
  applicators: Pick<Profile, 'id' | 'full_name' | 'role'>[];
  crews: { id: string; name: string }[];
  performedBy: string;
  /** Only dispatchers (admin/sales_rep) get the reassign/undispatch controls. */
  canDispatch: boolean;
  /** Admins may override an expired-license reassign (mirrors the dispatch wizard). */
  isAdmin: boolean;
  /** Re-fetch the board after a change so the job-row 'Assigned To' label stays in sync. */
  onChanged: () => void;
}

/**
 * 'View Dispatched List' (#37) — a tracker of every CURRENTLY-dispatched location:
 * who it went to (assignee name), the job#/field identity, the status, and
 * applied-of-total acres for progress. A dispatcher can filter by assignee and, per
 * row, REASSIGN the location to a different applicator/crew (upsert via
 * dispatch_job_locations) or UNDISPATCH it (cancel via undispatch_job_locations).
 * After either action the list AND the parent board re-fetch so the job-row
 * 'Assigned To' label updates in lock-step (criteria #4/#5).
 *
 * The rows come from the get_dispatched_list RPC, which resolves assignee names
 * server-side and is RLS-gated — so NO client-side unbounded id-list (the board's
 * URL caps ~19KB; a 500-uuid id.in list already fails the gateway — #36 lesson).
 */
function DispatchedList({ applicators, crews, performedBy, canDispatch, isAdmin, onChanged }: DispatchedListProps) {
  const { toast } = useToast();
  // PER-ROW idempotency keys (NOT one component-scoped key shared across rows).
  // A single shared key let a generic-but-committed error on row A leave a stale
  // key that the NEXT action on a DIFFERENT row B reused → the server replayed
  // row A's cached result and the UI showed a FALSE success on row B (Codex #37
  // final-5 MED). The cache key scopes the idempotency key to the full ACTION
  // INTENT, so a stale key can only ever replay for the IDENTICAL intent (a true
  // retry), never a changed one:
  //   - reassign: (job_field_id : assignee-choice : license-override). Scoping by
  //     job_field_id ALONE was insufficient — if a committed-but-errored reassign of
  //     a row to applicator X left its key, then the dispatcher changed THE SAME ROW
  //     to a different assignee Y and saved, the server replayed the X result and the
  //     UI showed a false success while Y was never applied (Codex #37 final-6 MED).
  //     Including the chosen assignee + override means a changed intent mints a NEW
  //     key (the server runs it) while an unchanged retry reuses the SAME key (safe
  //     idempotent replay).
  //   - undispatch: (job_field_id) — undispatch has no payload beyond the row, so the
  //     row IS the whole intent.
  // Mirrors the established per-(actor:entity) ref-cache pattern (FieldInvoicesUnposted
  // postKeysRef / Rebates transitionKeysRef, which keys by `${claimId}:${newStatus}`).
  const reassignKeysRef = useRef<Map<string, string>>(new Map());
  const undispatchKeysRef = useRef<Map<string, string>>(new Map());
  // The scope of the write CURRENTLY in flight (or null). On a reload, fetchRows() clears
  // EVERY cached key EXCEPT this one — the only key that legitimately must survive a reload
  // is the outstanding write's, for its own post-commit-error retry; every other cached key
  // is from a prior resolved action and may be stale against the new dispatch generation
  // (Codex #37 final-7/8/9 P2). A ref (not state) keeps fetchRows' identity stable so
  // busy-ness changes don't re-fire its effect.
  const activeScopeRef = useRef<{ kind: 'reassign' | 'undispatch'; scope: string } | null>(null);

  /** Build the intent-scoped cache key for a reassign (row + chosen assignee + override). */
  const reassignScope = (jobFieldId: string, choice: string, licenseOverride: boolean) =>
    `${jobFieldId}|${choice}|${licenseOverride ? 'ovr' : 'noovr'}`;

  /** Get (or mint once) the reassign idempotency key for a specific row+intent. */
  const getReassignKey = useCallback((scope: string): string => {
    let key = reassignKeysRef.current.get(scope);
    if (!key) {
      key = generateIdempotencyKey('dispatch_job_locations', `${performedBy}:${scope}`);
      reassignKeysRef.current.set(scope, key);
    }
    return key;
  }, [performedBy]);

  /** Get (or mint once) the undispatch key for a specific row. */
  const getUndispatchKey = useCallback((jobFieldId: string): string => {
    let key = undispatchKeysRef.current.get(jobFieldId);
    if (!key) {
      key = generateIdempotencyKey('undispatch_job_locations', `${performedBy}:${jobFieldId}`);
      undispatchKeysRef.current.set(jobFieldId, key);
    }
    return key;
  }, [performedBy]);

  const [loading, setLoading] = useState(true);
  const [rows, setRows] = useState<DispatchedListRow[]>([]);
  const [filter, setFilter] = useState<DispatchedAssigneeFilter>(emptyDispatchedAssigneeFilter);
  // The row currently being reassigned (its job_field_id) + the chosen assignee.
  const [reassignFor, setReassignFor] = useState<DispatchedListRow | null>(null);
  const [reassignChoice, setReassignChoice] = useState('');
  // The row pending undispatch confirmation.
  const [undispatchFor, setUndispatchFor] = useState<DispatchedListRow | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  // License-override prompt for a reassign blocked by LICENSE_EXPIRED (admin only).
  const [licensePrompt, setLicensePrompt] = useState<DispatchedListRow | null>(null);

  const fetchRows = useCallback(async () => {
    // Discard cached idempotency keys whenever the list reloads — EXCEPT the one write
    // currently in flight (if any). Once the rows are re-read, a location's dispatch
    // "generation" (and the correct result of any action on it) may have changed —
    // undispatched-and-re-dispatched, reassigned by another dispatcher, etc. A key minted
    // against the OLD generation must never be replayed against the new one (it would
    // return the stale cached result and falsely report success — Codex #37 final-7,
    // covering reassign-back-to-an-old-assignee AND undispatch-across-re-dispatch). The
    // ONLY key that must survive a reload is the outstanding write's, for its own
    // post-commit-error retry (a mid-write Reload/filter-change must not drop it and cause
    // a double-execute — Codex #37 final-8); preserving that single active scope rather
    // than the whole cache closes the "preserved a DIFFERENT stale key" gap (final-9).
    const active = activeScopeRef.current;
    const keepReassign = active?.kind === 'reassign' ? reassignKeysRef.current.get(active.scope) : undefined;
    const keepUndispatch = active?.kind === 'undispatch' ? undispatchKeysRef.current.get(active.scope) : undefined;
    reassignKeysRef.current.clear();
    undispatchKeysRef.current.clear();
    if (active?.kind === 'reassign' && keepReassign) reassignKeysRef.current.set(active.scope, keepReassign);
    if (active?.kind === 'undispatch' && keepUndispatch) undispatchKeysRef.current.set(active.scope, keepUndispatch);
    setLoading(true);
    try {
      // Push the assignee filter to the SERVER (p_applicator_id / p_crew_id) AND page
      // the SETOF result — never rely on one unbounded unfiltered load. At scale (more
      // current dispatches than the PostgREST single-response cap) a single unfiltered
      // call would only return the first page, and a client-side assignee filter could
      // then wrongly show "no rows" for an assignee whose rows sit past that slice
      // (Codex #37 P2 — same class as #36's id-list cap). Paging via .range() until a
      // short page ends the scan keeps the whole filtered set in hand.
      const all: DispatchedListRow[] = [];
      for (let from = 0; ; from += DISPATCH_PAGE) {
        const { data, error } = await supabase
          .rpc('get_dispatched_list', {
            p_applicator_id: filter.applicatorId || undefined,
            p_crew_id: filter.crewId || undefined,
          })
          .range(from, from + DISPATCH_PAGE - 1);
        if (error) throw error;
        // A SETOF RPC returns [] when there are no (more) rows, not null; assertRpcResult
        // only throws on a null/RLS-denied result (caught below → error toast).
        const page = assertRpcResult<DispatchedListRow[]>(data, 'get_dispatched_list');
        const rowsPage = Array.isArray(page) ? page : [];
        all.push(...rowsPage);
        if (rowsPage.length < DISPATCH_PAGE) break;
      }
      setRows(all);
    } catch (err) {
      Sentry.captureException(err, { tags: { source: 'fetch', action: 'get_dispatched_list' } });
      toast('error', 'Failed to load the dispatched list');
      setRows([]);
    }
    setLoading(false);
  }, [toast, filter.applicatorId, filter.crewId]);

  useEffect(() => { fetchRows(); }, [fetchRows]);

  // The server already narrowed by assignee; this client filter is a belt-and-suspenders
  // pass so the rendered set always matches the active filter (and stays instant on a
  // stale-while-refetch).
  const visibleRows = useMemo(() => filterDispatchedRows(rows, filter), [rows, filter]);
  const filterActive = hasActiveDispatchedFilter(filter);
  // TRUE while ANY reassign/undispatch RPC is in flight. Idempotency keys are now
  // PER-ROW (keyed by job_field_id), so a cross-row replay can no longer produce a
  // false success (Codex #37 final-5 MED — the prior shared-key bug). We still
  // serialize all row actions while one is pending — it keeps the UI predictable
  // (one outstanding write at a time) and avoids overlapping refetch races; it is
  // no longer the thing preventing the cross-row replay.
  const actionPending = busyId !== null;

  // The filter <select> value mirrors whichever assignee is set (applicator XOR crew).
  const filterValue = filter.applicatorId
    ? `applicator:${filter.applicatorId}`
    : filter.crewId
      ? `crew:${filter.crewId}`
      : '';

  function onFilterChange(value: string) {
    if (!value) { setFilter(emptyDispatchedAssigneeFilter); return; }
    const [kind, id] = value.split(':');
    setFilter(kind === 'applicator' ? { applicatorId: id, crewId: '' } : { applicatorId: '', crewId: id });
  }

  async function doReassign(row: DispatchedListRow, choice: string, licenseOverride = false) {
    const [kind, id] = choice.split(':');
    if (!kind || !id) return;
    // Idempotency key scoped to the FULL intent (row + chosen assignee + override) so a
    // stale key from a committed-but-errored attempt can only replay the IDENTICAL intent,
    // never a changed assignee on the same row (Codex #37 final-6 MED).
    const scope = reassignScope(row.job_field_id, choice, licenseOverride);
    setBusyId(row.job_field_id);
    // Mark THIS scope in flight so a concurrent fetchRows() (Reload / filter change)
    // preserves only this key, not a stale one (Codex #37 final-8/9). Cleared when the RPC resolves.
    activeScopeRef.current = { kind: 'reassign', scope };
    try {
      const payload = [{
        job_field_id: row.job_field_id,
        applicator_id: kind === 'applicator' ? id : null,
        crew_id: kind === 'crew' ? id : null,
      }];
      const { data, error } = await supabase.rpc('dispatch_job_locations', {
        p_assignments: payload as unknown as Json,
        p_performed_by: performedBy,
        p_idempotency_key: getReassignKey(scope),
        p_license_override: licenseOverride,
      });
      activeScopeRef.current = null; // RPC resolved — no longer in flight
      if (error) throw error;
      assertRpcResult<{ dispatched: number }>(data, 'dispatch_job_locations');
      reassignKeysRef.current.delete(scope); // confirmed success → next reassign of this intent is a new action
      toast('success', `Reassigned ${row.field_name || 'location'}${licenseOverride ? ' (license override)' : ''}`);
      setReassignFor(null);
      setReassignChoice('');
      await fetchRows();
      onChanged(); // keep the job-row 'Assigned To' on the board in sync (criterion #4/#5)
    } catch (err) {
      activeScopeRef.current = null; // RPC rejected (network) — no longer in flight; key kept for retry
      if (hasRpcCode(err, RpcErrorCodes.LICENSE_EXPIRED)) {
        // The override retry is a DIFFERENT intent (licenseOverride flips true), so it
        // already maps to a DIFFERENT scope/key — no stale-key reuse. Drop this
        // (non-override) intent's key so it can't linger.
        reassignKeysRef.current.delete(scope);
        if (isAdmin) {
          setReassignFor(null);
          setLicensePrompt(row);
        } else {
          toast('error', "An applicator's license has expired — an admin can override if needed.");
        }
        setBusyId(null);
        return;
      }
      Sentry.captureException(err, { tags: { source: 'action', action: 'dispatch_job_locations_reassign' } });
      toast('error', 'Failed to reassign. Please try again.');
    }
    setBusyId(null);
  }

  async function doUndispatch(row: DispatchedListRow) {
    setBusyId(row.job_field_id);
    // In flight → a concurrent fetchRows() preserves only THIS key (Codex #37 final-8/9).
    activeScopeRef.current = { kind: 'undispatch', scope: row.job_field_id };
    try {
      const { data, error } = await supabase.rpc('undispatch_job_locations', {
        p_job_field_ids: [row.job_field_id],
        p_performed_by: performedBy,
        p_idempotency_key: getUndispatchKey(row.job_field_id),
      });
      activeScopeRef.current = null; // RPC resolved — no longer in flight
      if (error) throw error;
      const res = assertRpcResult<{ undispatched: number }>(data, 'undispatch_job_locations');
      undispatchKeysRef.current.delete(row.job_field_id); // confirmed success → clear this row's key
      // The RPC returns {undispatched:0} (not an error) when the row was already gone —
      // another dispatcher beat us to it, or the job left the dispatchable window. Don't
      // claim success in that case; tell the user nothing changed and refresh so the
      // stale row disappears (Codex #37 final-3 P3).
      if (res.undispatched > 0) {
        toast('success', `Undispatched ${row.field_name || 'location'}`);
      } else {
        toast('info', 'This location was already undispatched or its job is no longer active — list refreshed.');
      }
      setUndispatchFor(null);
      await fetchRows();
      onChanged(); // the job-row 'Assigned To' label drops this assignee (criterion #4)
    } catch (err) {
      activeScopeRef.current = null; // RPC rejected (network) — no longer in flight; key kept for retry
      Sentry.captureException(err, { tags: { source: 'action', action: 'undispatch_job_locations' } });
      toast('error', 'Failed to undispatch. Please try again.');
    }
    setBusyId(null);
  }

  if (loading) {
    return (
      <div className="p-6 space-y-3">
        {[1, 2, 3, 4].map((i) => (
          <div key={i} className="h-20 rounded-xl bg-slate-800/60 animate-pulse" />
        ))}
      </div>
    );
  }

  return (
    <div className="p-3 sm:p-4 space-y-3 overflow-y-auto h-[calc(100vh-12rem)]">
      {/* Assignee filter (criterion #3) */}
      <div className="flex flex-wrap items-center gap-3 rounded-xl border border-slate-800 bg-slate-900/60 px-4 py-3">
        <label className="flex items-center gap-2 text-sm text-slate-300">
          <Users className="w-4 h-4 text-crx-green" />
          <span>Assignee</span>
          <select
            value={filterValue}
            onChange={(e) => onFilterChange(e.target.value)}
            className="rounded-lg bg-slate-800 border border-slate-700 px-3 py-2.5 text-sm text-slate-100 min-h-[44px] min-w-[180px] focus:outline-none focus:ring-2 focus:ring-crx-green/40"
          >
            <option value="">All assignees</option>
            {applicators.length > 0 && (
              <optgroup label="Applicators">
                {applicators.map((a) => (
                  <option key={a.id} value={`applicator:${a.id}`}>{a.full_name}</option>
                ))}
              </optgroup>
            )}
            {crews.length > 0 && (
              <optgroup label="Crews">
                {crews.map((c) => (
                  <option key={c.id} value={`crew:${c.id}`}>{c.name}</option>
                ))}
              </optgroup>
            )}
          </select>
        </label>
        {filterActive && (
          <button
            onClick={() => setFilter(emptyDispatchedAssigneeFilter)}
            className="inline-flex items-center gap-1 px-3 py-2 text-xs font-medium text-slate-300 hover:text-white rounded-lg hover:bg-slate-800"
          >
            <X className="w-3.5 h-3.5" /> Clear
          </button>
        )}
        <span className="ml-auto text-xs text-slate-500">
          {visibleRows.length} dispatched location{visibleRows.length === 1 ? '' : 's'}
        </span>
        <button
          onClick={fetchRows}
          className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-xs font-medium text-slate-100"
        >
          <RefreshCw className="w-3.5 h-3.5" /> Reload
        </button>
      </div>

      {visibleRows.length === 0 ? (
        <div className="rounded-xl border border-slate-800 bg-slate-900/50 p-10 text-center">
          <ClipboardList className="w-9 h-9 text-slate-600 mx-auto mb-3" />
          <p className="text-slate-400">
            {filterActive ? 'No dispatched locations for this assignee.' : 'Nothing dispatched yet.'}
          </p>
          <p className="mt-1 text-xs text-slate-500">Hand out field locations from <span className="text-slate-300">Dispatch Jobs</span>.</p>
        </div>
      ) : (
        visibleRows.map((row) => {
          const badge = jobStatusToDispatchBadge(row.job_status);
          const isReassigning = reassignFor?.job_field_id === row.job_field_id;
          // `busy` = THIS row's RPC is running (drives the spinner on its button).
          // `busy` is also true when ANY action is pending, so every row's controls are
          // disabled while one RPC is outstanding — preventing the shared-idempotency-key
          // replay collision (Codex #37 final-4 P2).
          const busy = busyId === row.job_field_id || actionPending;
          // Only a job still in a DISPATCHABLE lifecycle state can be reassigned/undispatched:
          // dispatch_job_locations enforces scheduled/in_progress (a reassign on a
          // completed/cancelled/invoiced job would just fail JOB_NOT_DISPATCHABLE), and
          // undispatching a row on a now-finished job would strip a historical assignment.
          // So hide the controls unless the parent job is still scheduled/in_progress
          // (Codex #37 P2).
          const dispatchable = row.job_status === 'scheduled' || row.job_status === 'in_progress';
          // The row's CURRENT assignee as a picker value — used to no-op a Save that
          // didn't actually change the assignee (a same-assignee upsert would bump
          // dispatched_at + write a spurious activity row — Codex #37 P3).
          const currentAssigneeValue = row.applicator_id
            ? `applicator:${row.applicator_id}`
            : row.crew_id
              ? `crew:${row.crew_id}`
              : '';
          return (
            <div key={row.dispatch_id} className="rounded-xl border border-slate-800 bg-slate-900 p-4">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-base font-semibold text-crx-green">{row.job_number}</span>
                    <span className={`px-2 py-0.5 rounded-full text-[11px] font-bold tracking-wide ${badge.className}`}>
                      {badge.label}
                    </span>
                  </div>
                  <p className="mt-1 text-sm text-slate-200 font-medium truncate">{row.customer_name || 'Unknown'}</p>
                  <p className="flex items-center gap-1.5 text-xs text-slate-500 truncate">
                    <MapPin className="w-3.5 h-3.5" /> {row.field_name || 'Field'}
                  </p>
                </div>
                <div className="text-right flex-shrink-0">
                  {/* applied-of-total acres for job progress + this location's acres */}
                  <p className="text-lg font-bold text-white tabular-nums">
                    {formatAppliedOfTotal(row.job_applied_acres, row.job_total_acres)}
                  </p>
                  {row.location_acres != null && (
                    <p className="text-xs text-slate-500 tabular-nums">{row.location_acres} ac this location</p>
                  )}
                </div>
              </div>

              {/* Assignee */}
              <div className="mt-3 flex items-center gap-2 text-sm">
                <Users className="w-4 h-4 text-crx-green" />
                <span className="text-slate-400">Assigned To:</span>
                <span className="font-semibold text-slate-100">{row.assignee_name || 'Unknown'}</span>
                <span className="text-xs text-slate-500">({row.assignee_kind})</span>
              </div>

              {/* The job left the dispatchable window — reassign/undispatch no longer apply. */}
              {canDispatch && !dispatchable && (
                <p className="mt-3 text-xs text-slate-500">
                  This job is {row.job_status} — it can no longer be reassigned or undispatched.
                </p>
              )}

              {/* Reassign / Undispatch (dispatchers only, dispatchable jobs only) */}
              {canDispatch && dispatchable && (
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  {isReassigning ? (
                    <>
                      <select
                        value={reassignChoice}
                        onChange={(e) => setReassignChoice(e.target.value)}
                        disabled={busy}
                        className="text-sm rounded-lg bg-slate-800 border border-slate-700 px-3 py-2.5 text-slate-100 min-h-[44px] min-w-[180px] focus:outline-none focus:ring-2 focus:ring-crx-green/40 disabled:opacity-50"
                      >
                        <option value="">Choose new assignee…</option>
                        {applicators.length > 0 && (
                          <optgroup label="Applicators">
                            {applicators.map((a) => (
                              <option key={a.id} value={`applicator:${a.id}`}>{a.full_name}</option>
                            ))}
                          </optgroup>
                        )}
                        {crews.length > 0 && (
                          <optgroup label="Crews">
                            {crews.map((c) => (
                              <option key={c.id} value={`crew:${c.id}`}>{c.name}</option>
                            ))}
                          </optgroup>
                        )}
                      </select>
                      <button
                        onClick={() => doReassign(row, reassignChoice)}
                        disabled={busy || !reassignChoice || reassignChoice === currentAssigneeValue}
                        title={reassignChoice === currentAssigneeValue ? 'Pick a different assignee to reassign' : undefined}
                        className="inline-flex items-center gap-1.5 px-3 py-2.5 rounded-lg bg-crx-green text-sm font-semibold text-white hover:bg-crx-green/90 disabled:opacity-40 disabled:cursor-not-allowed min-h-[44px]"
                      >
                        {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <RotateCcw className="w-4 h-4" />} Save
                      </button>
                      <button
                        onClick={() => { setReassignFor(null); setReassignChoice(''); }}
                        disabled={busy}
                        className="inline-flex items-center gap-1.5 px-3 py-2.5 rounded-lg border border-slate-700 text-sm font-medium text-slate-200 hover:bg-slate-800 min-h-[44px] disabled:opacity-50"
                      >
                        Cancel
                      </button>
                    </>
                  ) : (
                    <>
                      <button
                        onClick={() => {
                          setReassignFor(row);
                          // Preselect the current assignee so a "change" is one click away.
                          setReassignChoice(row.applicator_id ? `applicator:${row.applicator_id}` : row.crew_id ? `crew:${row.crew_id}` : '');
                        }}
                        disabled={busy}
                        className="inline-flex items-center gap-1.5 px-3 py-2.5 rounded-lg bg-slate-800 border border-slate-700 text-sm font-medium text-slate-100 hover:bg-slate-700 min-h-[44px] disabled:opacity-50"
                      >
                        <RotateCcw className="w-4 h-4 text-crx-green" /> Reassign
                      </button>
                      <button
                        onClick={() => setUndispatchFor(row)}
                        disabled={busy}
                        className="inline-flex items-center gap-1.5 px-3 py-2.5 rounded-lg bg-slate-800 border border-slate-700 text-sm font-medium text-rose-300 hover:bg-rose-500/10 hover:border-rose-500/40 min-h-[44px] disabled:opacity-50"
                      >
                        <UserMinus className="w-4 h-4" /> Undispatch
                      </button>
                    </>
                  )}
                </div>
              )}
            </div>
          );
        })
      )}

      {/* Undispatch confirmation */}
      <ConfirmModal
        open={undispatchFor !== null}
        onClose={() => setUndispatchFor(null)}
        onConfirm={() => { if (undispatchFor) doUndispatch(undispatchFor); }}
        title="Undispatch this location?"
        message={
          undispatchFor
            ? `Remove "${undispatchFor.field_name || 'this location'}" (${undispatchFor.job_number}) from ${undispatchFor.assignee_name || 'its assignee'}. It leaves the dispatched list and the job's Assigned-To label updates. You can re-dispatch it later.`
            : ''
        }
        confirmLabel="Undispatch"
        variant="warning"
        loading={busyId !== null && undispatchFor?.job_field_id === busyId}
      />

      {/* License-expired override for a reassign (admin only) */}
      <ConfirmModal
        open={licensePrompt !== null}
        onClose={() => setLicensePrompt(null)}
        onConfirm={() => {
          const row = licensePrompt;
          const choice = reassignChoice;
          setLicensePrompt(null);
          if (row) doReassign(row, choice, true);
        }}
        title="Applicator License Expired"
        message="The chosen applicator has an expired license. Reassign anyway? The override is recorded."
        confirmLabel="Reassign Anyway"
        variant="warning"
      />
    </div>
  );
}
