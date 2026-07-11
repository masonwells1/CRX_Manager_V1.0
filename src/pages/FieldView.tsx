/**
 * FieldView.tsx — Phone/mobile applicator FIELD VIEW ("My Day"), U12 rebuild.
 *
 * The simple phone screen the person actually SPRAYING opens: a clean, touch-friendly
 * list of ONLY THEIR jobs (the locations dispatched to them), so they can see what to
 * do, run it (Start/Complete), and where — without digging through the office Jobs
 * table. Mirrors ChemMan's applicator-facing dispatch card.
 *
 * U12 (2026-07-06) turned this from a READ-ONLY preview into an actionable "My Day"
 * screen — business-workflow-review-2026-07 §3.4 findings #22/#24-33/#64/#79/#114,
 * each re-verified against the live code/DB before building (see the U12 handoff
 * report for the per-finding verdicts). What changed:
 *  - The card face now shows the job DATE and a Start/Complete action button —
 *    no more "open the office Jobs page to actually run the job."
 *  - Jobs are grouped Today-first, with a separate "Done" section for terminal
 *    (completed/cancelled/invoiced) jobs so finished work doesn't compete with
 *    today's remaining list but also isn't silently hidden (see
 *    dispatchDisplay.groupFieldViewCards for the exact design rationale).
 *  - Dollar amounts are GONE — an applicator sees rate/quantity, never price
 *    (owner decision; this was previously the one non-"read-only" leak on an
 *    otherwise read-only screen).
 *  - A REI/PHI line appears on a job's Chemicals section whenever ANY of its
 *    products has that label data on file (0/604 products do today — so this
 *    renders nothing yet, but is wired for when label data is entered).
 *  - Complete captures the same weather/notes fields as the office Complete Job
 *    modal, PLUS an editable per-location applied-acres entry (defaults to the
 *    planned acres_to_treat; only the caller's OWN dispatched locations, which
 *    is also the set RLS lets them read/edit).
 *  - Complete queues OFFLINE via the existing offlineSync 'complete_job' path
 *    (already supported there — untouched) exactly like FieldStop's delivery
 *    completion: requires the card's detail to have loaded ONLINE first (so a
 *    conflict-safe `updated_at` snapshot exists), then queues if the connection
 *    drops. Start is online-only (mirrors FieldStop's Arrive step) — starting a
 *    job is a fast single call, not worth the offline-conflict complexity.
 *  - Cards fetch failing now shows an honest "couldn't load" retry state,
 *    distinct from a genuine empty list.
 *
 * Data (all RLS-equivalent, no profiles embed):
 *  - "My jobs"  → get_dispatched_list() with NO args. As an APPLICATOR caller the RPC
 *                 returns ONLY that applicator's current dispatched-location rows
 *                 (resolved server-side), now including job_date (migration
 *                 20260706060000). Grouped into one card per job
 *                 (groupDispatchedByJob). Admin/sales callers see every dispatched job
 *                 (so they can preview the field screen) — Start/Complete work for
 *                 them too (the RPCs already authorize admin/sales_rep).
 *  - Expand     → on first expand of a card we fetch the job's full read-only detail:
 *                 job_date + updated_at (the latter needed as the offline-conflict
 *                 snapshot for a queued Complete), every job_field (Locations + Crops),
 *                 and every job_chemical joined to its product (Chemicals + REI/PHI).
 *                 All readable by a LOCATION-ONLY dispatched applicator via the
 *                 additive *_location_dispatchee RLS policies.
 *  - Map        → reuses CRXMap + FieldBoundaryLayer to plot the dispatched job
 *                 locations. Wrapped in an ErrorBoundary; LOCAL has no Mapbox token /
 *                 boundary geometry so it renders no tiles locally (prod has both) —
 *                 the LIST view is the provable local path.
 *
 * The view is intentionally a DISTINCT, simpler screen from the office DispatchBoard:
 * no dispatch/assign controls, no office filters, no Cancel/Transfer — just the
 * applicator's own cards and the two actions (Start/Complete) they're allowed to run.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  List as ListIcon,
  Map as MapIcon,
  Search,
  RefreshCw,
  Users,
  MapPin,
  Calendar,
  FlaskConical,
  Sprout,
  ChevronDown,
  ChevronUp,
  Loader2,
  Truck,
  PlayCircle,
  CheckCircle2,
  ShieldAlert,
  WifiOff,
  AlertCircle,
} from 'lucide-react';
import type { MapRef } from 'react-map-gl/mapbox';
import type { Json } from '../types/supabase';
import CRXMap from '../components/map/CRXMap';
import FieldBoundaryLayer from '../components/map/FieldBoundaryLayer';
import ErrorBoundary from '../components/ErrorBoundary';
import ConfirmModal from '../components/ui/ConfirmModal';
import { usePageMeta } from '../hooks/usePageMeta';
import { useToast } from '../components/ui/Toast';
import { useAuth } from '../contexts/AuthContext';
import { useOnlineStatus } from '../hooks/useOnlineStatus';
import { useIdempotencyKey } from '../hooks/useIdempotencyKey';
import { queueAction } from '../lib/offlineQueue';
import { supabase, assertRpcResult, sanitizeError } from '../lib/db';
import { Sentry } from '../lib/sentry';
import { localToday, parseLocalDate } from '../lib/dateUtils';
import {
  formatAppliedOfTotal,
  jobStatusToDispatchBadge,
  groupDispatchedByJob,
  filterFieldViewCards,
  groupFieldViewCards,
  maxLabelReiPhi,
  isTerminalJobStatus,
  resolveFieldToJob,
  chunkIds,
  cardDetailCacheKey,
  type DispatchedListRow,
  type FieldViewJobCard,
} from '../lib/dispatchDisplay';
import type { Field } from '../types';

// The Supabase Data API caps a single response at ~1000 rows; page get_dispatched_list
// via .range() until a short page ends the scan (same pattern as the DispatchBoard's
// Dispatched List — an applicator with many dispatched locations must not be truncated).
const PAGE = 1000;

/** Read-only detail for an expanded card (the five fields beyond the header). */
interface CardDetail {
  /** jobs.updated_at at the time this detail was fetched — the offline-conflict
   *  snapshot for a queued Complete (mirrors FieldStop's syncAfterArrive pattern:
   *  the value must be captured while ONLINE, before a Complete might be queued). */
  jobUpdatedAt: string | null;
  /** Every location on the job — name + crop (Locations + Crops card sections). */
  fields: { id: string; field_name: string | null; crop: string | null; acres_to_treat: number | null }[];
  /** Every chemical on the job (rate/quantity only — no pricing on this screen). */
  chemicals: {
    id: string;
    product_name: string | null;
    quantity: number | null;
    unit: string | null;
    rate_per_acre: number | null;
    rate_unit: string | null;
    rei_hours: number | null;
    phi_days: number | null;
  }[];
}

/** The compact "Complete Job" form — mirrors JobDetail's Complete Job modal fields. */
interface CompleteForm {
  wind_speed: string;
  wind_direction: string;
  temperature: string;
  humidity: string;
  actual_gallons_applied: string;
  notes: string;
  /** job_field_id -> applied-acres string input, seeded from location_acres. */
  fieldAcres: Record<string, string>;
}

function emptyCompleteForm(): CompleteForm {
  return {
    wind_speed: '', wind_direction: '', temperature: '', humidity: '',
    actual_gallons_applied: '', notes: '', fieldAcres: {},
  };
}

type ViewMode = 'list' | 'map';

export default function FieldView() {
  usePageMeta();
  const { toast } = useToast();
  const { profile } = useAuth();
  const isOnline = useOnlineStatus();
  const startIdem = useIdempotencyKey('start_job', profile?.id || '');
  const completeIdem = useIdempotencyKey('complete_job', profile?.id || '');
  const today = useMemo(() => localToday(), []);

  const [loading, setLoading] = useState(true);
  const [fetchError, setFetchError] = useState(false);
  const [cards, setCards] = useState<FieldViewJobCard[]>([]);
  const [search, setSearch] = useState('');
  const [view, setView] = useState<ViewMode>('list');
  const [expandedId, setExpandedId] = useState<string | null>(null);

  // Per-job expanded detail, fetched lazily on first expand and cached.
  const [details, setDetails] = useState<Record<string, CardDetail>>({});
  const [detailLoading, setDetailLoading] = useState<string | null>(null);
  const inFlightDetail = useRef<Set<string>>(new Set());

  // Start Job (online-only, mirrors FieldStop's Arrive step).
  const [startConfirmFor, setStartConfirmFor] = useState<FieldViewJobCard | null>(null);
  const [starting, setStarting] = useState(false);

  // Complete Job (queues offline — mirrors FieldStop's Complete step).
  const [completeFormOpenFor, setCompleteFormOpenFor] = useState<string | null>(null);
  const [completeForm, setCompleteForm] = useState<CompleteForm>(emptyCompleteForm());
  const [completeConfirmFor, setCompleteConfirmFor] = useState<FieldViewJobCard | null>(null);
  const [completing, setCompleting] = useState(false);

  // Map geometry (best-effort; the list view never depends on it).
  const [mapFields, setMapFields] = useState<Field[]>([]);
  const mapRef = useRef<MapRef | null>(null);
  const [fieldToJob, setFieldToJob] = useState<Map<string, string>>(() => new Map());

  // --- Load "my jobs" (the dispatched-location rows for the caller) -----------------
  const fetchCards = useCallback(async () => {
    setLoading(true);
    setFetchError(false);
    try {
      const all: DispatchedListRow[] = [];
      for (let from = 0; ; from += PAGE) {
        const { data, error } = await supabase
          .rpc('get_dispatched_list')
          .range(from, from + PAGE - 1);
        if (error) throw error;
        const page = assertRpcResult<DispatchedListRow[]>(data, 'get_dispatched_list');
        const rows = Array.isArray(page) ? page : [];
        all.push(...rows);
        if (rows.length < PAGE) break;
      }
      const grouped = groupDispatchedByJob(all);

      // U12 Codex R3 #1: an applicator assigned the LEGACY way (jobs.applicator_id
      // set, no job_location_dispatches rows) has work that get_dispatched_list
      // never returns — without this merge they'd land on an empty "No jobs"
      // screen despite having a full day. Fetch their open whole-job assignments
      // plus a 7-day tail of completed/invoiced jobs, then merge any job the dispatch
      // list didn't already cover as a whole-job card (locations: [] — the card face
      // reads "Whole job assigned to you" and the expanded detail falls back to a
      // by-job_id job_fields fetch).
      // Start/Complete already authorize the legacy jobs.applicator_id path
      // server-side. RLS: jobs_select/job_fields_select let the whole-job
      // applicator read their own jobs (JobDetail relies on this today). The
      // customers embed is RLS-gated for applicators (7-day job window) — a
      // blocked embed just renders 'Unknown', never errors.
      // Accepted difference (A1 compliance MED): this legacy tail anchors on
      // jobs.updated_at (any job edit bumps it, stretching how long the card
      // lingers in Done), while the RPC path anchors on the dispatch row's
      // updated_at (touched only at job-terminal). jobs has no
      // completion-specific timestamp to anchor on; a slightly-longer Done
      // linger for legacy jobs is harmless.
      if (profile?.id) {
        const sevenDaysAgoIso = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
        const legacyRes = await supabase
          .from('jobs')
          .select('id, job_number, job_date, status, total_acres, applied_acres, customer_id, customer:customers(farm_name)')
          .eq('applicator_id', profile.id)
          .is('deleted_at', null)
          .or(`status.in.(scheduled,in_progress),and(status.in.(completed,invoiced),updated_at.gte.${sevenDaysAgoIso})`);
        if (legacyRes.error) throw legacyRes.error;
        const covered = new Set(grouped.map((c) => c.job_id));
        const legacyRows = (legacyRes.data || []) as unknown as Array<{
          id: string; job_number: string; job_date: string | null; status: string;
          total_acres: number | null; applied_acres: number | null;
          customer_id: string; customer?: { farm_name?: string } | null;
        }>;
        for (const j of legacyRows) {
          if (covered.has(j.id)) continue;
          grouped.push({
            job_id: j.id,
            job_number: j.job_number,
            job_status: j.status,
            job_date: j.job_date,
            customer_name: j.customer?.farm_name ?? null,
            job_applied_acres: j.applied_acres,
            job_total_acres: j.total_acres,
            locations: [],
          });
        }
        // Keep the stable job_number ordering groupDispatchedByJob promises.
        grouped.sort((a, b) => a.job_number.localeCompare(b.job_number));
      }

      setCards(grouped);
    } catch (err) {
      Sentry.captureException(err, { tags: { source: 'fetch', action: 'field_view_my_jobs' } });
      // Honest error state: distinguish "couldn't load" from "genuinely no jobs" —
      // the empty-state copy below only shows when fetchError is false.
      setFetchError(true);
      toast('error', 'Failed to load your jobs');
      setCards([]);
    }
    setLoading(false);
  }, [toast, profile?.id]);

  useEffect(() => { fetchCards(); }, [fetchCards]);

  // --- Map geometry for the visible job locations (best-effort) ---------------------
  useEffect(() => {
    if (cards.length === 0) { setMapFields([]); setFieldToJob(new Map()); return; }
    let cancelled = false;
    (async () => {
      try {
        const myJobFieldIds = cards.flatMap((c) => c.locations.map((l) => l.job_field_id));
        if (myJobFieldIds.length === 0) { if (!cancelled) { setMapFields([]); setFieldToJob(new Map()); } return; }
        const jfRows: { job_id: string; field_id: string | null }[] = [];
        for (const chunk of chunkIds(myJobFieldIds)) {
          const jfRes = await supabase
            .from('job_fields')
            .select('job_id, field_id')
            .in('id', chunk);
          if (jfRes.error) throw jfRes.error;
          jfRows.push(...((jfRes.data || []) as { job_id: string; field_id: string | null }[]));
        }
        const f2j = new Map<string, string>();
        for (const r of jfRows) {
          if (r.field_id && !f2j.has(r.field_id)) f2j.set(r.field_id, r.job_id);
        }
        if (!cancelled) setFieldToJob(f2j);
        const fieldIds = Array.from(new Set(Array.from(f2j.keys())));
        if (fieldIds.length === 0) { if (!cancelled) setMapFields([]); return; }
        const { data: geoData, error: geoErr } = await supabase.rpc('get_fields_geojson_by_ids', { p_field_ids: fieldIds });
        if (geoErr) throw geoErr;
        const fRows = (assertRpcResult<Array<Field>>(geoData, 'get_fields_geojson_by_ids') || []) as unknown as Field[];
        if (!cancelled) setMapFields(fRows);
      } catch (err) {
        Sentry.captureException(err, { tags: { source: 'fetch', action: 'field_view_map_fields' } });
        if (!cancelled) { setMapFields([]); setFieldToJob(new Map()); }
      }
    })();
    return () => { cancelled = true; };
  }, [cards]);

  useEffect(() => {
    if (view !== 'map' || !mapRef.current) return;
    const id = requestAnimationFrame(() => mapRef.current?.resize());
    return () => cancelAnimationFrame(id);
  }, [view]);

  const visibleCards = useMemo(() => filterFieldViewCards(cards, search), [cards, search]);
  const { active: activeCards, done: doneCards } = useMemo(
    () => groupFieldViewCards(visibleCards, today),
    [visibleCards, today]
  );

  const visibleMapFields = useMemo(() => {
    const visibleJobIds = new Set(visibleCards.map((c) => c.job_id));
    return mapFields.filter((f) => {
      const jobId = fieldToJob.get(f.id);
      return jobId != null && visibleJobIds.has(jobId);
    });
  }, [visibleCards, mapFields, fieldToJob]);

  // --- Lazy-load a card's read-only detail on first expand --------------------------
  const loadDetail = useCallback(async (card: FieldViewJobCard) => {
    const cacheKey = cardDetailCacheKey(card);
    if (details[cacheKey]) return; // cached
    if (inFlightDetail.current.has(cacheKey)) return; // already fetching this exact set
    inFlightDetail.current.add(cacheKey);
    setDetailLoading(card.job_id);
    try {
      // updated_at is the offline-conflict snapshot for a queued Complete — must be
      // captured HERE (while online) so a later offline Complete has a value to send.
      const jobRes = await supabase
        .from('jobs')
        .select('job_date, updated_at')
        .eq('id', card.job_id)
        .maybeSingle();
      if (jobRes.error) throw jobRes.error;

      const myJobFieldIds = card.locations.map((l) => l.job_field_id);
      const jfRaw: Array<{ id: string; crop: string | null; acres_to_treat: number | null; sort_order: number | null; field?: { field_name?: string } }> = [];
      if (myJobFieldIds.length === 0) {
        // Legacy whole-job card (U12 Codex R3 #1): no per-location dispatch rows
        // to scope by, and the caller owns the WHOLE job — fetch its job_fields by
        // job_id instead. RLS: job_fields_select already grants the whole-job
        // applicator (jobs.applicator_id = caller) read of every field on the job.
        const fieldsRes = await supabase
          .from('job_fields')
          .select('id, crop, acres_to_treat, sort_order, field:fields(field_name)')
          .eq('job_id', card.job_id)
          .order('sort_order', { ascending: true, nullsFirst: false });
        if (fieldsRes.error) throw fieldsRes.error;
        jfRaw.push(...((fieldsRes.data || []) as typeof jfRaw));
      } else {
        for (const chunk of chunkIds(myJobFieldIds)) {
          const fieldsRes = await supabase
            .from('job_fields')
            .select('id, crop, acres_to_treat, sort_order, field:fields(field_name)')
            .in('id', chunk)
            .order('sort_order', { ascending: true, nullsFirst: false });
          if (fieldsRes.error) throw fieldsRes.error;
          jfRaw.push(...((fieldsRes.data || []) as typeof jfRaw));
        }
      }
      jfRaw.sort((a, b) => (a.sort_order ?? Number.MAX_SAFE_INTEGER) - (b.sort_order ?? Number.MAX_SAFE_INTEGER));

      // Chemicals (job_chemicals) — rate/quantity + REI/PHI only, NO pricing on this
      // screen (owner decision, U12). Readable via job_chemicals_select_location_dispatchee.
      const chemRes = await supabase
        .from('job_chemicals')
        .select('id, quantity, unit, rate_per_acre, rate_unit, sort_order, product:products(product_name, rei_hours, phi_days)')
        .eq('job_id', card.job_id)
        .order('sort_order', { ascending: true, nullsFirst: false });
      if (chemRes.error) throw chemRes.error;

      const detail: CardDetail = {
        jobUpdatedAt: (jobRes.data as { updated_at?: string } | null)?.updated_at ?? null,
        fields: jfRaw.map((jf) => ({
          id: jf.id,
          field_name: jf.field?.field_name ?? null,
          crop: jf.crop,
          acres_to_treat: jf.acres_to_treat,
        })),
        chemicals: ((chemRes.data || []) as Array<{ id: string; quantity: number | null; unit: string | null; rate_per_acre: number | null; rate_unit: string | null; product?: { product_name?: string; rei_hours?: number | null; phi_days?: number | null } }>).map((jc) => ({
          id: jc.id,
          product_name: jc.product?.product_name ?? null,
          quantity: jc.quantity,
          unit: jc.unit,
          rate_per_acre: jc.rate_per_acre,
          rate_unit: jc.rate_unit,
          rei_hours: jc.product?.rei_hours ?? null,
          phi_days: jc.product?.phi_days ?? null,
        })),
      };
      setDetails((prev) => ({ ...prev, [cacheKey]: detail }));

      // Seed the per-location applied-acres inputs from the card's own dispatched
      // locations (defaults to the planned acres_to_treat — untouched = no override).
      // MERGES new keys only (never overwrites an already-seeded/edited key) so
      // expanding a SECOND job doesn't clobber edits already made on a first one —
      // fieldAcres accumulates across every job expanded this session; submission
      // only ever reads the keys belonging to the job being completed.
      setCompleteForm((prev) => {
        let changed = false;
        const merged = { ...prev.fieldAcres };
        for (const loc of card.locations) {
          if (!(loc.job_field_id in merged)) {
            merged[loc.job_field_id] = loc.location_acres != null ? String(loc.location_acres) : '';
            changed = true;
          }
        }
        return changed ? { ...prev, fieldAcres: merged } : prev;
      });
    } catch (err) {
      Sentry.captureException(err, { tags: { source: 'fetch', action: 'field_view_card_detail' } });
      toast('error', 'Failed to load job details');
    } finally {
      inFlightDetail.current.delete(cacheKey);
      setDetailLoading(null);
    }
  }, [details, toast]);

  const toggleExpand = useCallback((card: FieldViewJobCard) => {
    setExpandedId((prev) => (prev === card.job_id ? null : card.job_id));
  }, []);

  useEffect(() => {
    if (!expandedId) return;
    const card = visibleCards.find((c) => c.job_id === expandedId);
    if (card && !details[cardDetailCacheKey(card)]) void loadDetail(card);
  }, [expandedId, visibleCards, details, loadDetail]);

  const cropList = (detail: CardDetail): string[] =>
    Array.from(new Set(detail.fields.map((f) => (f.crop || '').trim()).filter(Boolean)));

  // --- Start Job (online-only) -------------------------------------------------------
  const requestStart = (card: FieldViewJobCard) => {
    if (!isOnline) { toast('error', 'Connect to the internet to start this job'); return; }
    setStartConfirmFor(card);
  };

  const handleStart = async () => {
    const card = startConfirmFor;
    if (!card || !profile) return;
    setStarting(true);
    try {
      const { data, error } = await supabase.rpc('start_job', {
        p_job_id: card.job_id,
        p_performed_by: profile.id,
        p_idempotency_key: startIdem.getKey(),
      });
      if (error) throw error;
      assertRpcResult(data, 'start_job');
      startIdem.resetKey();
      toast('success', `Job ${card.job_number} started`);
      setStartConfirmFor(null);
      // U12 Codex R4 #1: start_job just bumped jobs.updated_at server-side, so a
      // detail cached BEFORE the start now carries a stale jobUpdatedAt snapshot.
      // If a Complete were queued offline with that pre-start value, offlineSync
      // compares server updated_at > snapshotAt and would treat the caller's OWN
      // start as a conflict — permanently skipping the completion on reconnect.
      // Drop every cached detail for this job (any dispatch-set cache key); the
      // expand effect re-fetches immediately while we're still online (Start is
      // online-only), caching a fresh post-start snapshot. If the connection
      // drops mid-refetch, the queued Complete carries NO snapshot (undefined),
      // which offlineSync treats as "no conflict check" — a blind replay beats a
      // guaranteed false conflict.
      setDetails((prev) => {
        const next = { ...prev };
        for (const key of Object.keys(next)) {
          if (key.startsWith(`${card.job_id}|`)) delete next[key];
        }
        return next;
      });
      await fetchCards();
    } catch (err) {
      Sentry.captureException(err, { tags: { source: 'critical_action', action: 'field_view_start_job' } });
      toast('error', sanitizeError(err));
    }
    setStarting(false);
  };

  // --- Complete Job (queues offline) --------------------------------------------------
  const openCompleteForm = (card: FieldViewJobCard) => {
    setExpandedId(card.job_id); // Complete lives in the expanded panel (needs detail loaded)
    // U12 Codex R4 #2: completeForm is ONE shared state — without a reset, values
    // typed for job A (wind/notes/gallons) silently submit for job B after
    // cancel→reopen. Reset on EVERY open and seed this card's own per-location
    // acres defaults (same source loadDetail seeds from; loadDetail's later
    // merge-only seeding fills identical values, so no clobber either way).
    // Deliberate side effect: Cancel→reopen of the SAME job also starts clean —
    // Cancel means discard.
    const seeded = emptyCompleteForm();
    for (const loc of card.locations) {
      seeded.fieldAcres[loc.job_field_id] = loc.location_acres != null ? String(loc.location_acres) : '';
    }
    setCompleteForm(seeded);
    setCompleteFormOpenFor(card.job_id);
  };

  const requestComplete = (card: FieldViewJobCard) => {
    setCompleteConfirmFor(card);
  };

  const handleComplete = async () => {
    const card = completeConfirmFor;
    if (!card || !profile) return;
    const detail = details[cardDetailCacheKey(card)];
    setCompleteConfirmFor(null); // close confirm immediately
    setCompleting(true);

    // field_id comes from get_dispatched_list (U12 Codex P1 — the RPC now returns
    // job_fields.field_id per row, threaded through DispatchedListRow → card
    // locations). complete_job's field_acres override is keyed by the master
    // fields.id, so a location with no linked master field (null) is skipped —
    // it can't be addressed by the override and falls back to planned acres.
    const fieldAcresPayload = card.locations
      .filter((l) => l.field_id)
      .map((l) => ({
        field_id: l.field_id,
        acres_applied: Number(completeForm.fieldAcres[l.job_field_id] ?? l.location_acres ?? 0),
      }))
      .filter((f) => Number.isFinite(f.acres_applied));

    const appliedInfo = {
      wind_speed: completeForm.wind_speed || null,
      wind_direction: completeForm.wind_direction || null,
      temperature: completeForm.temperature || null,
      humidity: completeForm.humidity || null,
      actual_gallons_applied: completeForm.actual_gallons_applied || null,
      notes: completeForm.notes || null,
      field_acres: fieldAcresPayload,
    };
    const rpcParams = {
      p_job_id: card.job_id,
      p_applied_info: appliedInfo as unknown as Json,
      p_performed_by: profile.id,
      p_idempotency_key: completeIdem.getKey(),
    };

    // OFFLINE — requires the card's detail to have been fetched ONLINE already (so
    // jobUpdatedAt exists as the conflict snapshot). Mirrors FieldStop's pattern.
    if (!isOnline) {
      try {
        await queueAction({
          operation: 'complete_job',
          params: rpcParams as Record<string, unknown>,
          createdAt: new Date().toISOString(),
          retryCount: 0,
          entityTable: 'jobs',
          entityId: card.job_id,
          snapshotAt: detail?.jobUpdatedAt ?? undefined,
        });
        completeIdem.resetKey();
        toast('success', `Job ${card.job_number} saved offline — will sync when you reconnect`);
        setCompleteFormOpenFor(null);
        setCompleteForm(emptyCompleteForm());
      } catch {
        toast('error', 'Failed to save offline. Please try again.');
      }
      setCompleting(false);
      return;
    }

    try {
      const { data, error } = await supabase.rpc('complete_job', rpcParams);
      if (error) throw error;
      const result = assertRpcResult<{ record_number?: string }>(data, 'complete_job');
      completeIdem.resetKey();
      toast('success', `Job ${card.job_number} completed${result.record_number ? ` — record ${result.record_number}` : ''}`);
      setCompleteFormOpenFor(null);
      setCompleteForm(emptyCompleteForm());
      await fetchCards();
    } catch (err) {
      Sentry.captureException(err, { tags: { source: 'critical_action', action: 'field_view_complete_job' } });
      // U12 Codex R5 #2: a dispatch-only applicator on a SPLIT job (other
      // locations dispatched to someone else) sees Complete, but complete_job
      // correctly rejects — completing would close the WHOLE job over the other
      // party's work. RLS hides other parties' dispatch rows from this client,
      // so ownership can't be pre-computed here; translate the RPC's raw
      // rejection into a friendly explanation instead.
      const msg = sanitizeError(err);
      toast('error', msg.includes('Not authorized to complete this job')
        ? 'This job is split with another applicator or crew — the office will complete and close it.'
        : msg);
    }
    setCompleting(false);
  };

  const canSubmitComplete = !completing;

  // --- Card renderer (shared by the Today-first list and the Done section) ---------
  function renderCard(card: FieldViewJobCard) {
    const badge = jobStatusToDispatchBadge(card.job_status);
    const expanded = expandedId === card.job_id;
    const detail = details[cardDetailCacheKey(card)];
    const isDetailLoading = detailLoading === card.job_id;
    const isTerminal = isTerminalJobStatus(card.job_status);
    const dateLabel = card.job_date
      // parseLocalDate, not new Date(): a bare YYYY-MM-DD parses as UTC midnight
      // and renders the PREVIOUS day in US timezones (U12 Codex P2).
      ? (card.job_date === today ? 'Today' : parseLocalDate(card.job_date).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }))
      : null;
    const reiPhi = detail ? maxLabelReiPhi(detail.chemicals) : { reiHours: null, phiDays: null };
    const showingCompleteForm = completeFormOpenFor === card.job_id;

    return (
      <div
        key={card.job_id}
        className={`rounded-xl border bg-slate-900 transition-colors ${
          expanded ? 'border-crx-green ring-1 ring-crx-green/40' : 'border-slate-800'
        }`}
      >
        {/* Card header — the always-visible summary row (tap to expand). */}
        <button
          onClick={() => toggleExpand(card)}
          aria-expanded={expanded}
          className="w-full flex items-start justify-between gap-3 p-4 text-left min-h-[44px]"
        >
          <div className="min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-base font-semibold text-crx-green">{card.job_number}</span>
              <span className={`px-2 py-0.5 rounded-full text-[11px] font-bold tracking-wide ${badge.className}`}>
                {badge.label}
              </span>
              {dateLabel && (
                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium bg-slate-800 text-slate-300 border border-slate-700">
                  <Calendar className="w-3 h-3" /> {dateLabel}
                </span>
              )}
            </div>
            <p className="mt-1 text-sm text-slate-200 font-medium truncate">{card.customer_name || 'Unknown'}</p>
            <p className="flex items-center gap-1.5 text-xs text-slate-500 truncate">
              <MapPin className="w-3.5 h-3.5 flex-shrink-0" />
              {/* A legacy whole-job assignment (jobs.applicator_id, no per-location
                  dispatch rows) has no locations array — "0 locations assigned to
                  you" would read as a bug, so name what it actually is. */}
              {card.locations.length === 0
                ? 'Whole job assigned to you'
                : `${card.locations.length} location${card.locations.length === 1 ? '' : 's'} assigned to you`}
            </p>
          </div>
          <div className="flex flex-col items-end gap-0.5 flex-shrink-0">
            <span className="text-lg font-bold text-white tabular-nums leading-tight">
              {formatAppliedOfTotal(card.job_applied_acres, card.job_total_acres)}
            </span>
            <span className="text-[10px] uppercase tracking-wider text-slate-500">job total</span>
            {expanded ? <ChevronUp className="w-5 h-5 text-slate-400 mt-0.5" /> : <ChevronDown className="w-5 h-5 text-slate-400 mt-0.5" />}
          </div>
        </button>

        {/* Quick actions — visible on the card face, no expand required for Start. */}
        {!isTerminal && (
          <div className="px-4 pb-4 -mt-1 flex gap-2">
            {card.job_status === 'scheduled' && (
              <button
                type="button"
                onClick={() => requestStart(card)}
                disabled={!isOnline}
                className="flex-1 inline-flex items-center justify-center gap-2 bg-crx-green text-white font-semibold rounded-lg py-2.5 text-sm active:scale-[0.99] disabled:opacity-50 disabled:active:scale-100"
              >
                <PlayCircle className="w-4 h-4" /> Start Job
              </button>
            )}
            {card.job_status === 'in_progress' && (
              <button
                type="button"
                onClick={() => openCompleteForm(card)}
                className="flex-1 inline-flex items-center justify-center gap-2 bg-crx-green text-white font-semibold rounded-lg py-2.5 text-sm active:scale-[0.99]"
              >
                <CheckCircle2 className="w-4 h-4" /> Complete Job
              </button>
            )}
          </div>
        )}
        {!isOnline && card.job_status === 'scheduled' && (
          <p className="px-4 pb-3 -mt-2 flex items-center gap-1.5 text-[11px] text-amber-400">
            <WifiOff className="w-3.5 h-3.5" /> Connect to the internet to start this job.
          </p>
        )}

        {/* Expanded card — the read-only detail sections + (when in_progress) the
            Complete Job form. */}
        {expanded && (
          <div className="border-t border-slate-800 px-4 py-4 space-y-4">
            {isDetailLoading && !detail ? (
              <div className="flex items-center gap-2 text-sm text-slate-400">
                <Loader2 className="w-4 h-4 animate-spin" /> Loading job details…
              </div>
            ) : detail ? (
              <>
                <Section icon={<Users className="w-4 h-4 text-crx-green" />} title="Customer">
                  <p className="text-sm text-slate-100 font-medium">{card.customer_name || 'Unknown'}</p>
                </Section>

                <Section icon={<MapPin className="w-4 h-4 text-crx-green" />} title="Locations">
                  {detail.fields.length === 0 ? (
                    <p className="text-sm text-slate-500">No locations.</p>
                  ) : (
                    <ul className="space-y-1">
                      {detail.fields.map((f) => (
                        <li key={f.id} className="flex items-center justify-between gap-3 text-sm">
                          <span className="text-slate-100 truncate">{f.field_name || 'Field'}</span>
                          {f.acres_to_treat != null && (
                            <span className="text-slate-500 tabular-nums flex-shrink-0">{f.acres_to_treat} ac</span>
                          )}
                        </li>
                      ))}
                    </ul>
                  )}
                </Section>

                <Section icon={<Sprout className="w-4 h-4 text-crx-green" />} title="Crops">
                  {cropList(detail).length === 0 ? (
                    <p className="text-sm text-slate-500">No crop recorded.</p>
                  ) : (
                    <div className="flex flex-wrap gap-1.5">
                      {cropList(detail).map((crop) => (
                        <span key={crop} className="px-2 py-0.5 rounded-full bg-slate-800 border border-slate-700 text-xs text-slate-200">
                          {crop}
                        </span>
                      ))}
                    </div>
                  )}
                </Section>

                {/* Chemicals — rate/quantity ONLY, no pricing (U12 owner decision). */}
                <Section icon={<FlaskConical className="w-4 h-4 text-crx-green" />} title="Chemicals">
                  <p className="text-[11px] text-slate-500 -mt-1 mb-1.5">Applies to the whole job.</p>
                  {detail.chemicals.length === 0 ? (
                    <p className="text-sm text-slate-500">No chemicals listed.</p>
                  ) : (
                    <ul className="divide-y divide-slate-800">
                      {detail.chemicals.map((c) => (
                        <li key={c.id} className="py-2 first:pt-0 last:pb-0">
                          <p className="text-sm text-slate-100 truncate">{c.product_name || 'Product'}</p>
                          <p className="text-xs text-slate-500">
                            {c.rate_per_acre != null ? `${c.rate_per_acre}${c.rate_unit ? ' ' + c.rate_unit : ''}/ac` : '—'}
                            {c.quantity != null ? ` · ${c.quantity}${c.unit ? ' ' + c.unit : ''}` : ''}
                          </p>
                        </li>
                      ))}
                    </ul>
                  )}
                </Section>

                {/* REI/PHI — only when at least one product has that label data on file. */}
                {(reiPhi.reiHours != null || reiPhi.phiDays != null) && (
                  <Section icon={<ShieldAlert className="w-4 h-4 text-amber-400" />} title="Re-Entry / Harvest">
                    <div className="flex flex-wrap gap-4 text-sm">
                      {reiPhi.reiHours != null && (
                        <div><span className="text-slate-500">REI</span> <span className="text-slate-100 font-medium">{reiPhi.reiHours}h</span></div>
                      )}
                      {reiPhi.phiDays != null && (
                        <div><span className="text-slate-500">PHI</span> <span className="text-slate-100 font-medium">{reiPhi.phiDays}d</span></div>
                      )}
                    </div>
                  </Section>
                )}

                {/* Complete Job form — only for an in_progress job the applicator opened. */}
                {showingCompleteForm && card.job_status === 'in_progress' && (
                  <Section icon={<CheckCircle2 className="w-4 h-4 text-crx-green" />} title="Complete Job">
                    {!isOnline && (
                      <p className="flex items-center gap-1.5 text-[11px] text-amber-400 mb-2">
                        <WifiOff className="w-3.5 h-3.5" /> You're offline &mdash; this will save now and sync when you reconnect.
                      </p>
                    )}
                    <div className="grid grid-cols-2 gap-2 mb-3">
                      <FieldInput label="Wind Speed (mph)" value={completeForm.wind_speed}
                        onChange={(v) => setCompleteForm((p) => ({ ...p, wind_speed: v }))} />
                      <FieldInput label="Wind Direction" value={completeForm.wind_direction}
                        onChange={(v) => setCompleteForm((p) => ({ ...p, wind_direction: v }))} placeholder="e.g. NW" />
                      <FieldInput label="Temperature (°F)" value={completeForm.temperature}
                        onChange={(v) => setCompleteForm((p) => ({ ...p, temperature: v }))} />
                      <FieldInput label="Humidity (%)" value={completeForm.humidity}
                        onChange={(v) => setCompleteForm((p) => ({ ...p, humidity: v }))} />
                      <FieldInput label="Actual Gallons" value={completeForm.actual_gallons_applied}
                        onChange={(v) => setCompleteForm((p) => ({ ...p, actual_gallons_applied: v }))} />
                    </div>
                    {card.locations.length > 0 && (
                      <div className="mb-3">
                        <p className="text-xs font-semibold uppercase tracking-wider text-slate-400 mb-1.5">Applied Acres (per location)</p>
                        <div className="space-y-1.5">
                          {card.locations.map((loc) => (
                            <div key={loc.job_field_id} className="flex items-center justify-between gap-3">
                              <span className="text-sm text-slate-300 truncate">{loc.field_name || 'Field'}</span>
                              <input
                                type="number" inputMode="decimal" step="any" min={0}
                                value={completeForm.fieldAcres[loc.job_field_id] ?? ''}
                                onChange={(e) => setCompleteForm((p) => ({ ...p, fieldAcres: { ...p.fieldAcres, [loc.job_field_id]: e.target.value } }))}
                                className="w-24 text-right tabular-nums bg-slate-800 border border-slate-700 rounded-lg px-2 py-1.5 text-sm text-slate-100"
                              />
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                    <div className="mb-3">
                      <label className="block text-xs font-medium text-slate-400 mb-1">Notes</label>
                      <textarea
                        value={completeForm.notes}
                        onChange={(e) => setCompleteForm((p) => ({ ...p, notes: e.target.value }))}
                        rows={2}
                        className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-100"
                      />
                    </div>
                    <div className="flex gap-2">
                      <button
                        type="button"
                        disabled={!canSubmitComplete}
                        onClick={() => requestComplete(card)}
                        className="flex-1 inline-flex items-center justify-center gap-2 bg-crx-green text-white font-semibold rounded-xl py-3 text-sm active:scale-[0.99] disabled:opacity-50"
                      >
                        <CheckCircle2 className="w-5 h-5" /> {completing ? 'Completing…' : 'Complete Job'}
                      </button>
                      <button
                        type="button"
                        onClick={() => setCompleteFormOpenFor(null)}
                        className="px-4 rounded-xl border border-slate-700 text-slate-300 text-sm font-medium active:scale-[0.99]"
                      >
                        Cancel
                      </button>
                    </div>
                  </Section>
                )}

                <p className="text-[11px] text-slate-600 pt-1">
                  {isTerminal
                    ? 'This job is finished — pricing and invoicing are handled in the office app.'
                    : 'Pricing and job setup are managed in the office app.'}
                </p>
              </>
            ) : (
              <p className="text-sm text-slate-500">Tap again to retry loading details.</p>
            )}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="-m-4 lg:-m-6 min-h-[calc(100vh-4rem)] bg-slate-950 text-slate-100">
      {/* Header — title + view toggle. Touch-friendly; sized for a phone width. */}
      <div className="sticky top-0 z-20 bg-slate-900/95 backdrop-blur border-b border-slate-800">
        <div className="flex items-center gap-2 px-4 py-3">
          <Truck className="w-6 h-6 text-crx-green flex-shrink-0" />
          <h1 className="text-base font-semibold tracking-wide flex-shrink-0">My Day</h1>
          <div className="ml-auto inline-flex rounded-lg bg-slate-800 p-0.5">
            <button
              onClick={() => setView('list')}
              aria-pressed={view === 'list'}
              className={`inline-flex items-center gap-1.5 px-3 py-2 rounded-md text-sm font-medium min-h-[40px] ${
                view === 'list' ? 'bg-crx-green text-white' : 'text-slate-300 hover:text-white'
              }`}
            >
              <ListIcon className="w-4 h-4" /> List
            </button>
            <button
              onClick={() => setView('map')}
              aria-pressed={view === 'map'}
              className={`inline-flex items-center gap-1.5 px-3 py-2 rounded-md text-sm font-medium min-h-[40px] ${
                view === 'map' ? 'bg-crx-green text-white' : 'text-slate-300 hover:text-white'
              }`}
            >
              <MapIcon className="w-4 h-4" /> Map
            </button>
          </div>
        </div>

        {/* Search + reload (list mode) */}
        {view === 'list' && (
          <div className="flex items-center gap-2 px-4 pb-3">
            <div className="relative flex-1">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-500" />
              <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search job # or customer…"
                className="w-full pl-9 pr-3 py-2.5 rounded-lg bg-slate-800 border border-slate-700 text-sm text-slate-100 placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-crx-green/40 focus:border-crx-green min-h-[44px]"
              />
            </div>
            <button
              onClick={fetchCards}
              aria-label="Reload my jobs"
              className="inline-flex items-center justify-center w-11 h-11 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-100 flex-shrink-0"
            >
              <RefreshCw className="w-4 h-4" />
            </button>
          </div>
        )}
      </div>

      {/* CONTENT */}
      {loading ? (
        <div className="p-4 space-y-3">
          {[1, 2, 3].map((i) => (
            <div key={i} className="h-24 rounded-xl bg-slate-800/60 animate-pulse" />
          ))}
        </div>
      ) : view === 'map' ? (
        <div className="h-[calc(100vh-9rem)] m-3 rounded-xl overflow-hidden border border-slate-800">
          <ErrorBoundary inline>
            <CRXMap
              className="h-full min-h-[360px]"
              showLayerToggle
              interactive
              onMapLoad={(map) => { mapRef.current = map; }}
            >
              <FieldBoundaryLayer
                fields={visibleMapFields as (Field & { customer_name?: string })[]}
                showLabels
                onFieldClick={(fieldId) => {
                  const jobId = resolveFieldToJob(fieldToJob, fieldId);
                  if (!jobId) return;
                  const card = visibleCards.find((c) => c.job_id === jobId);
                  if (card) { setView('list'); setExpandedId(card.job_id); }
                }}
              />
            </CRXMap>
          </ErrorBoundary>
        </div>
      ) : fetchError && visibleCards.length === 0 ? (
        <div className="p-4">
          <div className="rounded-xl border border-amber-900/60 bg-amber-950/30 p-10 text-center">
            <AlertCircle className="w-9 h-9 text-amber-500 mx-auto" />
            <p className="mt-3 text-amber-200 font-medium">Couldn't load your jobs</p>
            <p className="mt-1 text-xs text-amber-500/80">Check your connection and try again.</p>
            <button
              onClick={fetchCards}
              className="mt-4 inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-amber-900/40 hover:bg-amber-900/60 text-amber-200 text-sm font-medium"
            >
              <RefreshCw className="w-4 h-4" /> Retry
            </button>
          </div>
        </div>
      ) : visibleCards.length === 0 ? (
        <div className="p-4">
          <div className="rounded-xl border border-slate-800 bg-slate-900/50 p-10 text-center">
            <MapPin className="w-9 h-9 text-slate-600 mx-auto" />
            <p className="mt-3 text-slate-300 font-medium">No jobs assigned to you right now.</p>
            <p className="mt-1 text-xs text-slate-500">
              When a dispatcher hands you a field location, it shows up here.
            </p>
          </div>
        </div>
      ) : (
        <div className="p-3 sm:p-4 space-y-3">
          {activeCards.map(renderCard)}

          {doneCards.length > 0 && (
            <div className="pt-2">
              <p className="px-1 pb-2 text-xs font-semibold uppercase tracking-wider text-slate-500">
                Done ({doneCards.length})
              </p>
              <div className="space-y-3">
                {doneCards.map(renderCard)}
              </div>
            </div>
          )}
        </div>
      )}

      <ConfirmModal
        open={!!startConfirmFor}
        onClose={() => setStartConfirmFor(null)}
        onConfirm={handleStart}
        title="Start this job?"
        message={startConfirmFor ? `Job ${startConfirmFor.job_number} for ${startConfirmFor.customer_name || 'this customer'} will move to in-progress.` : ''}
        confirmLabel="Start Job"
        variant="info"
        loading={starting}
      />

      <ConfirmModal
        open={!!completeConfirmFor}
        onClose={() => setCompleteConfirmFor(null)}
        onConfirm={handleComplete}
        title="Complete this job?"
        message={
          isOnline
            ? 'Inventory will be deducted and an application record created.'
            : "You're offline — this will save now and sync (deduct inventory / create the record) when you reconnect."
        }
        confirmLabel="Complete"
        variant="info"
        loading={completing}
      />
    </div>
  );
}

/** A labeled section inside the expanded card. */
function Section({ icon, title, children }: { icon: JSX.Element; title: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="flex items-center gap-2 mb-1.5">
        {icon}
        <span className="text-xs font-semibold uppercase tracking-wider text-slate-400">{title}</span>
      </div>
      <div className="pl-6">{children}</div>
    </div>
  );
}

/** Compact labeled number input for the Complete Job form (dark theme). */
function FieldInput({
  label, value, onChange, placeholder,
}: { label: string; value: string; onChange: (v: string) => void; placeholder?: string }) {
  return (
    <label className="block">
      <span className="block text-[11px] text-slate-400 mb-1">{label}</span>
      <input
        type={placeholder ? 'text' : 'number'}
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        className="w-full bg-slate-800 border border-slate-700 rounded-lg px-2.5 py-1.5 text-sm text-slate-100"
      />
    </label>
  );
}
