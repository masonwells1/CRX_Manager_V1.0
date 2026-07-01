/**
 * FieldView.tsx — Phone/mobile applicator FIELD VIEW (field-app parity #38).
 *
 * The simple phone screen the person actually SPRAYING opens: a clean, touch-friendly
 * list of ONLY THEIR jobs (the locations dispatched to them), so they can see what to
 * do and where without digging through the office Jobs table. Mirrors ChemMan's
 * applicator-facing dispatch card — READ-ONLY: no pricing/job-setup edits here.
 *
 * Data (all RLS-equivalent, no profiles embed):
 *  - "My jobs"  → get_dispatched_list() with NO args. As an APPLICATOR caller the RPC
 *                 returns ONLY that applicator's current dispatched-location rows
 *                 (resolved server-side). Grouped into one card per job
 *                 (groupDispatchedByJob). Admin/sales callers see every dispatched job
 *                 (so they can preview the field screen).
 *  - Expand     → on first expand of a card we fetch the job's full read-only detail:
 *                 job_date (Scheduled Date), every job_field (Locations + Crops), and
 *                 every job_chemical joined to its product (Chemicals/Charges). All
 *                 readable by a LOCATION-ONLY dispatched applicator via the additive
 *                 *_location_dispatchee RLS policies (#36 + the #38 job_chemicals
 *                 policy). Charges are derived from job_chemicals.price_per_unit_cents.
 *  - Map        → reuses CRXMap + FieldBoundaryLayer to plot the dispatched job
 *                 locations. Wrapped in an ErrorBoundary; LOCAL has no Mapbox token /
 *                 boundary geometry so it renders no tiles locally (prod has both) —
 *                 the LIST view is the provable local path.
 *
 * The view is intentionally a DISTINCT, simpler screen from the office DispatchBoard:
 * no dispatch/assign controls, no office filters — just the applicator's own cards.
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
} from 'lucide-react';
import type { MapRef } from 'react-map-gl/mapbox';
import CRXMap from '../components/map/CRXMap';
import FieldBoundaryLayer from '../components/map/FieldBoundaryLayer';
import ErrorBoundary from '../components/ErrorBoundary';
import { usePageMeta } from '../hooks/usePageMeta';
import { useToast } from '../components/ui/Toast';
import { supabase, assertRpcResult } from '../lib/db';
import { Sentry } from '../lib/sentry';
import { formatCents } from '../lib/money';
import {
  formatAppliedOfTotal,
  jobStatusToDispatchBadge,
  groupDispatchedByJob,
  filterFieldViewCards,
  chemicalChargeCents,
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
  jobDate: string | null;
  /** Every location on the job — name + crop (Locations + Crops card sections). */
  fields: { id: string; field_name: string | null; crop: string | null; acres_to_treat: number | null }[];
  /** Every chemical on the job + its derived charge (Chemicals/Charges section). */
  chemicals: {
    id: string;
    product_name: string | null;
    quantity: number | null;
    unit: string | null;
    rate_per_acre: number | null;
    rate_unit: string | null;
    chargeCents: number;
  }[];
}

type ViewMode = 'list' | 'map';

export default function FieldView() {
  usePageMeta();
  const { toast } = useToast();

  const [loading, setLoading] = useState(true);
  const [cards, setCards] = useState<FieldViewJobCard[]>([]);
  const [search, setSearch] = useState('');
  const [view, setView] = useState<ViewMode>('list');
  const [expandedId, setExpandedId] = useState<string | null>(null);

  // Per-job expanded detail, fetched lazily on first expand and cached.
  const [details, setDetails] = useState<Record<string, CardDetail>>({});
  const [detailLoading, setDetailLoading] = useState<string | null>(null);
  // Cache keys whose detail fetch is currently IN FLIGHT. The cached-result check
  // alone can't dedupe concurrent loads (two callers both see an empty cache before
  // either request resolves), so a ref tracks in-flight keys and short-circuits a
  // second identical fetch — preventing duplicate requests / double error toasts on a
  // single open (Codex re-review P2). A ref (not state) so it's read/written
  // synchronously without its own re-render.
  const inFlightDetail = useRef<Set<string>>(new Set());

  // Map geometry (best-effort; the list view never depends on it).
  const [mapFields, setMapFields] = useState<Field[]>([]);
  const mapRef = useRef<MapRef | null>(null);

  // master field_id → job_id, built from the caller's dispatched job_fields. The
  // dispatch RPC doesn't carry the master field_id, so a map tap (which yields a
  // field_id) needs this to resolve back to the owning card's job_id. Kept in state
  // so onFieldClick / visibleMapFields re-derive when the dispatched set changes.
  const [fieldToJob, setFieldToJob] = useState<Map<string, string>>(() => new Map());

  // --- Load "my jobs" (the dispatched-location rows for the caller) -----------------
  const fetchCards = useCallback(async () => {
    setLoading(true);
    try {
      // get_dispatched_list() with NO args → the caller's own current dispatches
      // (server-scoped). Page the SETOF result so a large assignment set is never
      // truncated. assertRpcResult throws on a null/RLS-denied result.
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
      setCards(groupDispatchedByJob(all));
    } catch (err) {
      Sentry.captureException(err, { tags: { source: 'fetch', action: 'field_view_my_jobs' } });
      toast('error', 'Failed to load your jobs');
      setCards([]);
    }
    setLoading(false);
  }, [toast]);

  useEffect(() => { fetchCards(); }, [fetchCards]);

  // --- Map geometry for the visible job locations (best-effort) ---------------------
  // Fetched once after the cards load. A DB without the geometry columns (LOCAL) simply
  // yields no boundaries — the list view is unaffected. Scoped to the field_ids on the
  // caller's dispatched job_fields, so an applicator never pulls the whole fields table.
  useEffect(() => {
    if (cards.length === 0) { setMapFields([]); setFieldToJob(new Map()); return; }
    let cancelled = false;
    (async () => {
      try {
        // Scope to the caller's OWN dispatched locations, NOT every field on the job.
        // The location-dispatchee RLS is job-keyed (dispatched to ANY field on a job
        // grants read of ALL its job_fields), so an `.in('job_id', …)` query would pull
        // unassigned fields too — and then the map would plot them and a tap would open
        // the card, contradicting the "locations assigned to you" framing. card.locations[]
        // already lists the caller's dispatched job_field_ids; query by those instead.
        const myJobFieldIds = cards.flatMap((c) => c.locations.map((l) => l.job_field_id));
        if (myJobFieldIds.length === 0) { if (!cancelled) { setMapFields([]); setFieldToJob(new Map()); } return; }
        // Read only the caller's dispatched job_fields to resolve their master field_ids,
        // then the fields' geometry. We also pull job_id so a map tap (field_id) can
        // resolve back to the owning card. Both are best-effort for the map. Chunk the
        // id filter so a large dispatch set never overflows the request URL.
        const jfRows: { job_id: string; field_id: string | null }[] = [];
        for (const chunk of chunkIds(myJobFieldIds)) {
          const jfRes = await supabase
            .from('job_fields')
            .select('job_id, field_id')
            .in('id', chunk);
          if (jfRes.error) throw jfRes.error;
          jfRows.push(...((jfRes.data || []) as { job_id: string; field_id: string | null }[]));
        }
        // field_id → job_id (first match wins on the rare shared-field tie — acceptable).
        const f2j = new Map<string, string>();
        for (const r of jfRows) {
          if (r.field_id && !f2j.has(r.field_id)) f2j.set(r.field_id, r.job_id);
        }
        if (!cancelled) setFieldToJob(f2j);
        const fieldIds = Array.from(new Set(Array.from(f2j.keys())));
        if (fieldIds.length === 0) { if (!cancelled) setMapFields([]); return; }
        // The fields table stores PostGIS geometry, not geojson/lat-lng columns, so a
        // direct column select 42703's. Pull display geojson from the canonical RPC and
        // keep only the fields belonging to the visible jobs.
        const { data: geoData, error: geoErr } = await supabase.rpc('get_fields_with_geojson');
        if (geoErr) throw geoErr;
        const wanted = new Set(fieldIds);
        const fRows = (assertRpcResult<Array<Field & { id: string }>>(geoData, 'get_fields_with_geojson') || [])
          .filter((f) => wanted.has(f.id)) as unknown as Field[];
        if (!cancelled) setMapFields(fRows);
      } catch (err) {
        // Map geometry is non-critical — log and degrade to an empty map.
        Sentry.captureException(err, { tags: { source: 'fetch', action: 'field_view_map_fields' } });
        if (!cancelled) { setMapFields([]); setFieldToJob(new Map()); }
      }
    })();
    return () => { cancelled = true; };
  }, [cards]);

  // The map mounts hidden; re-measure when it becomes visible (Mapbox sizes against a
  // zero-size parent while display:none, else the first open renders blank/mis-sized).
  useEffect(() => {
    if (view !== 'map' || !mapRef.current) return;
    const id = requestAnimationFrame(() => mapRef.current?.resize());
    return () => cancelAnimationFrame(id);
  }, [view]);

  const visibleCards = useMemo(() => filterFieldViewCards(cards, search), [cards, search]);

  // Fields plotted on the map = the fields belonging to the currently-visible cards.
  // The dispatch rows don't carry the master field_id, so we scope via the
  // field_id → job_id map: keep a fetched map field only if its job is currently
  // visible. This makes an active search narrow the map to match the list (no leak
  // either way — every job is the caller's own). If the map hasn't loaded yet
  // (empty fieldToJob), there's nothing to plot.
  const visibleMapFields = useMemo(() => {
    const visibleJobIds = new Set(visibleCards.map((c) => c.job_id));
    return mapFields.filter((f) => {
      const jobId = fieldToJob.get(f.id);
      return jobId != null && visibleJobIds.has(jobId);
    });
  }, [visibleCards, mapFields, fieldToJob]);

  // --- Lazy-load a card's read-only detail on first expand --------------------------
  const loadDetail = useCallback(async (card: FieldViewJobCard) => {
    // Cache key includes the dispatched location set, not just job_id, so a reload
    // after a dispatcher changed the caller's locations refetches instead of replaying
    // a stale location/crop list (Codex re-review P2).
    const cacheKey = cardDetailCacheKey(card);
    if (details[cacheKey]) return; // cached
    if (inFlightDetail.current.has(cacheKey)) return; // already fetching this exact set
    inFlightDetail.current.add(cacheKey);
    setDetailLoading(card.job_id);
    try {
      // Scheduled Date (jobs.job_date) — readable via jobs_select_location_dispatchee.
      const jobRes = await supabase
        .from('jobs')
        .select('job_date')
        .eq('id', card.job_id)
        .maybeSingle();
      if (jobRes.error) throw jobRes.error;

      // Locations + Crops (job_fields.crop) — readable via job_fields_select_location_dispatchee.
      // SCOPE to the caller's OWN dispatched locations (the job-keyed RLS would let a
      // location-only dispatchee read EVERY field on the job, but the header says
      // "N locations assigned to you" — so the detail must match that count, not the
      // whole job). card.locations[] carries each dispatched job_field_id.
      // Chunk the id filter so a job with very many dispatched locations never
      // overflows the request URL; re-sort the merged rows by sort_order client-side.
      const myJobFieldIds = card.locations.map((l) => l.job_field_id);
      const jfRaw: Array<{ id: string; crop: string | null; acres_to_treat: number | null; sort_order: number | null; field?: { field_name?: string } }> = [];
      for (const chunk of chunkIds(myJobFieldIds)) {
        const fieldsRes = await supabase
          .from('job_fields')
          .select('id, crop, acres_to_treat, sort_order, field:fields(field_name)')
          .in('id', chunk)
          .order('sort_order', { ascending: true, nullsFirst: false });
        if (fieldsRes.error) throw fieldsRes.error;
        jfRaw.push(...((fieldsRes.data || []) as typeof jfRaw));
      }
      // A multi-chunk fetch loses the global sort_order ordering across chunks — re-sort.
      jfRaw.sort((a, b) => (a.sort_order ?? Number.MAX_SAFE_INTEGER) - (b.sort_order ?? Number.MAX_SAFE_INTEGER));

      // Chemicals/Charges (job_chemicals) — readable via job_chemicals_select_location_dispatchee
      // (the #38 additive policy). Charges derived from price_per_unit_cents.
      const chemRes = await supabase
        .from('job_chemicals')
        .select('id, quantity, unit, rate_per_acre, rate_unit, price_per_unit_cents, sort_order, product:products(product_name)')
        .eq('job_id', card.job_id)
        .order('sort_order', { ascending: true, nullsFirst: false });
      if (chemRes.error) throw chemRes.error;

      const detail: CardDetail = {
        jobDate: (jobRes.data as { job_date?: string } | null)?.job_date ?? null,
        fields: jfRaw.map((jf) => ({
          id: jf.id,
          field_name: jf.field?.field_name ?? null,
          crop: jf.crop,
          acres_to_treat: jf.acres_to_treat,
        })),
        chemicals: ((chemRes.data || []) as Array<{ id: string; quantity: number | null; unit: string | null; rate_per_acre: number | null; rate_unit: string | null; price_per_unit_cents: number | null; product?: { product_name?: string } }>).map((jc) => ({
          id: jc.id,
          product_name: jc.product?.product_name ?? null,
          quantity: jc.quantity,
          unit: jc.unit,
          rate_per_acre: jc.rate_per_acre,
          rate_unit: jc.rate_unit,
          chargeCents: chemicalChargeCents(jc.quantity, jc.price_per_unit_cents),
        })),
      };
      setDetails((prev) => ({ ...prev, [cacheKey]: detail }));
    } catch (err) {
      Sentry.captureException(err, { tags: { source: 'fetch', action: 'field_view_card_detail' } });
      toast('error', 'Failed to load job details');
    } finally {
      inFlightDetail.current.delete(cacheKey);
      setDetailLoading(null);
    }
  }, [details, toast]);

  // Just toggles which card is open; the effect below is the SINGLE place that
  // initiates the detail fetch (so a tap can't race the effect into a double-load).
  const toggleExpand = useCallback((card: FieldViewJobCard) => {
    setExpandedId((prev) => (prev === card.job_id ? null : card.job_id));
  }, []);

  // The ONE place a card's read-only detail is loaded. Runs whenever the expanded card
  // (or its dispatched-location set, via the cache key) changes and that detail isn't
  // cached yet. This covers both a normal open AND the case a tap-handler can't: a card
  // stays expanded across a reload while a dispatcher changed the caller's locations —
  // the cache key flips to an uncached one with no collapse→expand transition. loadDetail
  // is idempotent (cached + in-flight guards), so this never double-fetches (Codex re-review P2).
  useEffect(() => {
    if (!expandedId) return;
    const card = visibleCards.find((c) => c.job_id === expandedId);
    if (card && !details[cardDetailCacheKey(card)]) void loadDetail(card);
  }, [expandedId, visibleCards, details, loadDetail]);

  // Distinct crops across the job's locations (the Crops card section).
  const cropList = (detail: CardDetail): string[] =>
    Array.from(new Set(detail.fields.map((f) => (f.crop || '').trim()).filter(Boolean)));

  return (
    <div className="-m-4 lg:-m-6 min-h-[calc(100vh-4rem)] bg-slate-950 text-slate-100">
      {/* Header — title + view toggle. Touch-friendly; sized for a phone width. */}
      <div className="sticky top-0 z-20 bg-slate-900/95 backdrop-blur border-b border-slate-800">
        <div className="flex items-center gap-2 px-4 py-3">
          <Truck className="w-6 h-6 text-crx-green flex-shrink-0" />
          <h1 className="text-base font-semibold tracking-wide flex-shrink-0">My Field Jobs</h1>
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
                  // Tapping a field boundary resolves the master field_id → its job_id
                  // via the dispatched-job_fields map, then opens that card in the list.
                  // The expand effect loads the detail (single fetch path).
                  const jobId = resolveFieldToJob(fieldToJob, fieldId);
                  if (!jobId) return;
                  const card = visibleCards.find((c) => c.job_id === jobId);
                  if (card) { setView('list'); setExpandedId(card.job_id); }
                }}
              />
            </CRXMap>
          </ErrorBoundary>
        </div>
      ) : visibleCards.length === 0 ? (
        <div className="p-4">
          <div className="rounded-xl border border-slate-800 bg-slate-900/50 p-10 text-center">
            <ClipboardEmpty />
            <p className="mt-3 text-slate-300 font-medium">No jobs assigned to you right now.</p>
            <p className="mt-1 text-xs text-slate-500">
              When a dispatcher hands you a field location, it shows up here.
            </p>
          </div>
        </div>
      ) : (
        <div className="p-3 sm:p-4 space-y-3">
          {visibleCards.map((card) => {
            const badge = jobStatusToDispatchBadge(card.job_status);
            const expanded = expandedId === card.job_id;
            const detail = details[cardDetailCacheKey(card)];
            const isDetailLoading = detailLoading === card.job_id;
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
                    </div>
                    <p className="mt-1 text-sm text-slate-200 font-medium truncate">{card.customer_name || 'Unknown'}</p>
                    <p className="flex items-center gap-1.5 text-xs text-slate-500 truncate">
                      <MapPin className="w-3.5 h-3.5 flex-shrink-0" />
                      {card.locations.length} location{card.locations.length === 1 ? '' : 's'} assigned to you
                    </p>
                  </div>
                  <div className="flex flex-col items-end gap-0.5 flex-shrink-0">
                    <span className="text-lg font-bold text-white tabular-nums leading-tight">
                      {formatAppliedOfTotal(card.job_applied_acres, card.job_total_acres)}
                    </span>
                    {/* This progress is whole-JOB acres, not the caller's own — label it so
                        a location-only applicator doesn't read it as "your" acres. */}
                    <span className="text-[10px] uppercase tracking-wider text-slate-500">job total</span>
                    {expanded ? <ChevronUp className="w-5 h-5 text-slate-400 mt-0.5" /> : <ChevronDown className="w-5 h-5 text-slate-400 mt-0.5" />}
                  </div>
                </button>

                {/* Expanded READ-ONLY card — the five ChemMan fields (criterion #3). */}
                {expanded && (
                  <div className="border-t border-slate-800 px-4 py-4 space-y-4">
                    {isDetailLoading && !detail ? (
                      <div className="flex items-center gap-2 text-sm text-slate-400">
                        <Loader2 className="w-4 h-4 animate-spin" /> Loading job details…
                      </div>
                    ) : detail ? (
                      <>
                        {/* 1. Customers */}
                        <Section icon={<Users className="w-4 h-4 text-crx-green" />} title="Customer">
                          <p className="text-sm text-slate-100 font-medium">{card.customer_name || 'Unknown'}</p>
                        </Section>

                        {/* 2. Scheduled Date */}
                        <Section icon={<Calendar className="w-4 h-4 text-crx-green" />} title="Scheduled Date">
                          <p className="text-sm text-slate-100">{detail.jobDate || 'Not scheduled'}</p>
                        </Section>

                        {/* 3. Locations */}
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

                        {/* 4. Crops */}
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

                        {/* 5. Chemicals / Charges — JOB-LEVEL spray mix (job_chemicals has no
                            field dimension), so it's the whole job's plan, not the caller's
                            charges. Caption it honestly so "assigned to you" framing above
                            doesn't bleed onto these charges. */}
                        <Section icon={<FlaskConical className="w-4 h-4 text-crx-green" />} title="Chemicals / Charges">
                          <p className="text-[11px] text-slate-500 -mt-1 mb-1.5">Applies to the whole job.</p>
                          {detail.chemicals.length === 0 ? (
                            <p className="text-sm text-slate-500">No chemicals listed.</p>
                          ) : (
                            <ul className="divide-y divide-slate-800">
                              {detail.chemicals.map((c) => (
                                <li key={c.id} className="flex items-start justify-between gap-3 py-2 first:pt-0 last:pb-0">
                                  <div className="min-w-0">
                                    <p className="text-sm text-slate-100 truncate">{c.product_name || 'Product'}</p>
                                    <p className="text-xs text-slate-500">
                                      {c.rate_per_acre != null ? `${c.rate_per_acre}${c.rate_unit ? ' ' + c.rate_unit : ''}/ac` : '—'}
                                      {c.quantity != null ? ` · ${c.quantity}${c.unit ? ' ' + c.unit : ''}` : ''}
                                    </p>
                                  </div>
                                  <span className="text-sm text-slate-300 tabular-nums flex-shrink-0">
                                    {formatCents(c.chargeCents)}
                                  </span>
                                </li>
                              ))}
                            </ul>
                          )}
                        </Section>

                        <p className="text-[11px] text-slate-600 pt-1">
                          Read-only — pricing and job setup are managed in the office app.
                        </p>
                      </>
                    ) : (
                      <p className="text-sm text-slate-500">Tap again to retry loading details.</p>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/** A labeled section inside the expanded read-only card. */
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

/** Empty-state glyph (kept inline to avoid a stray import). */
function ClipboardEmpty() {
  return <MapPin className="w-9 h-9 text-slate-600 mx-auto" />;
}
