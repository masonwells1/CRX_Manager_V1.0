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

  // Map geometry (best-effort; the list view never depends on it).
  const [mapFields, setMapFields] = useState<Field[]>([]);
  const mapRef = useRef<MapRef | null>(null);

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
    if (cards.length === 0) { setMapFields([]); return; }
    let cancelled = false;
    (async () => {
      try {
        const jobIds = cards.map((c) => c.job_id);
        // Read the dispatched job_fields (RLS: job_fields_select_location_dispatchee) to
        // resolve field_ids, then the fields' geometry. Both are best-effort for the map.
        const jfRes = await supabase
          .from('job_fields')
          .select('field_id')
          .in('job_id', jobIds);
        if (jfRes.error) throw jfRes.error;
        const fieldIds = Array.from(
          new Set(((jfRes.data || []) as { field_id: string | null }[]).map((r) => r.field_id).filter(Boolean) as string[])
        );
        if (fieldIds.length === 0) { if (!cancelled) setMapFields([]); return; }
        const fRes = await supabase
          .from('fields')
          .select('id, field_name, boundary_geojson, centroid_lat, centroid_lng, total_acres, crop_type, customer_id, customer:customers(farm_name)')
          .in('id', fieldIds);
        if (fRes.error) throw fRes.error;
        if (!cancelled) setMapFields((fRes.data || []) as unknown as Field[]);
      } catch (err) {
        // Map geometry is non-critical — log and degrade to an empty map.
        Sentry.captureException(err, { tags: { source: 'fetch', action: 'field_view_map_fields' } });
        if (!cancelled) setMapFields([]);
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
  const visibleMapFields = useMemo(() => {
    const fieldIds = new Set(
      visibleCards.flatMap((c) => c.locations.map((l) => l.field_id).filter(Boolean) as string[])
    );
    // The map fields were fetched separately; intersect with the visible cards' fields.
    // When the dispatch rows don't carry field_id (today's RPC), fall back to showing
    // every loaded map field (still scoped to the caller's dispatched jobs above).
    if (fieldIds.size === 0) return mapFields;
    return mapFields.filter((f) => fieldIds.has(f.id));
  }, [visibleCards, mapFields]);

  // --- Lazy-load a card's read-only detail on first expand --------------------------
  const loadDetail = useCallback(async (card: FieldViewJobCard) => {
    if (details[card.job_id]) return; // cached
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
      const fieldsRes = await supabase
        .from('job_fields')
        .select('id, crop, acres_to_treat, sort_order, field:fields(field_name)')
        .eq('job_id', card.job_id)
        .order('sort_order', { ascending: true, nullsFirst: false });
      if (fieldsRes.error) throw fieldsRes.error;

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
        fields: ((fieldsRes.data || []) as Array<{ id: string; crop: string | null; acres_to_treat: number | null; field?: { field_name?: string } }>).map((jf) => ({
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
      setDetails((prev) => ({ ...prev, [card.job_id]: detail }));
    } catch (err) {
      Sentry.captureException(err, { tags: { source: 'fetch', action: 'field_view_card_detail' } });
      toast('error', 'Failed to load job details');
    }
    setDetailLoading(null);
  }, [details, toast]);

  const toggleExpand = useCallback((card: FieldViewJobCard) => {
    setExpandedId((prev) => {
      const next = prev === card.job_id ? null : card.job_id;
      if (next) void loadDetail(card);
      return next;
    });
  }, [loadDetail]);

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
                  const card = visibleCards.find((c) => c.locations.some((l) => l.field_id === fieldId));
                  if (card) { setView('list'); setExpandedId(card.job_id); void loadDetail(card); }
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
            const detail = details[card.job_id];
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
                  <div className="flex flex-col items-end gap-1 flex-shrink-0">
                    <span className="text-lg font-bold text-white tabular-nums">
                      {formatAppliedOfTotal(card.job_applied_acres, card.job_total_acres)}
                    </span>
                    {expanded ? <ChevronUp className="w-5 h-5 text-slate-400" /> : <ChevronDown className="w-5 h-5 text-slate-400" />}
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

                        {/* 5. Chemicals / Charges */}
                        <Section icon={<FlaskConical className="w-4 h-4 text-crx-green" />} title="Chemicals / Charges">
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
