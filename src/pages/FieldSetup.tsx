import { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { ArrowLeft, Save, Trash2, MapPin, Search, ChevronDown, ChevronUp, AlertTriangle, Eye, EyeOff, MapPinned, MousePointerSquareDashed, Plus, X } from 'lucide-react';
import Card, { CardHeader } from '../components/ui/Card';
import Button from '../components/ui/Button';
import Input from '../components/ui/Input';
import Badge from '../components/ui/Badge';
import UnsavedChangesModal from '../components/ui/UnsavedChangesModal';
import ConfirmModal from '../components/ui/ConfirmModal';
import CRXMap from '../components/map/CRXMap';
import DrawLayer, { type DrawnPolygon } from '../components/map/DrawLayer';
import AddressSearch from '../components/map/AddressSearch';
import FieldBoundaryLayer from '../components/map/FieldBoundaryLayer';
import FieldObstacleLayer from '../components/map/FieldObstacleLayer';
import { Layer, Source } from 'react-map-gl/mapbox';
import { useToast } from '../components/ui/Toast';
import { useAuth } from '../contexts/AuthContext';
import { useUnsavedChanges } from '../hooks/useUnsavedChanges';
import { supabase, assertRpcResult, checkMutationResult, rpcAuthErrorMessage } from '../lib/db';
import { getCachedFieldsGeojson, type FieldsGeojsonRow } from '../lib/fieldsGeojsonCache';
import { lookupPlss, type PlssLookupResult } from '../lib/plssLookup';
import { CsbLookupError, findCsbFeatureAt, type CsbFeature } from '../lib/csbLookup';
import { CsbAdoptError, csbFeatureToDrawnParts } from '../lib/csbAdopt';
import { canRemoveSingleBoundary } from '../lib/fieldBoundaryState';
import { useIdempotencyKey } from '../hooks/useIdempotencyKey';
import { Sentry } from '../lib/sentry';
import { computeBounds } from '../hooks/useFitBounds';
import { parseDollarsToCents } from '../lib/parseCents';
import {
  buildBoundaryGeometry,
  billableAcres,
  isAcreDivergent,
  acreDivergencePct,
  isAcreInBand,
  ACRE_BAND_MIN,
  ACRE_BAND_MAX,
} from '../lib/fieldGeometry';
import turfCentroid from '@turf/centroid';
import turfArea from '@turf/area';
import { JOB_FIELD_PICKER_MAP_LIMIT, mapFieldsForJobPicker } from '../components/jobs/jobFieldPicker';
import {
  canEnterObstacleMode,
  FIELD_OBSTACLE_KINDS,
  FIELD_OBSTACLE_KIND_LABELS,
} from '../lib/fieldObstacles';
import type { Feature, MultiPolygon, Polygon } from 'geojson';
import type { Field, Customer, FieldObstacle, FieldObstacleKind } from '../types';

interface BillingSplit {
  customer_id: string;
  customer_name: string;
  split_pct: number;
  is_primary: boolean;
  notes: string;
  price_override_cents: number | null;
  pricing_note: string;
}

const FIELD_CONTEXT_OVERLAY_STORAGE_KEY = 'crx.fieldSetup.showOtherFieldBoundaries';
const BOUNDS_CHANGE_EPSILON = 0.000001;
const MAPBOX_TOKEN_AVAILABLE = Boolean(import.meta.env.VITE_MAPBOX_TOKEN as string | undefined);

interface OverlappingField {
  field_id?: unknown;
  field_name?: unknown;
  overlap_pct?: unknown;
}

function isOverlappingField(value: unknown): value is OverlappingField {
  return typeof value === 'object' && value !== null;
}

function isBoundaryGeometry(value: unknown): value is Polygon | MultiPolygon {
  if (!value || typeof value !== 'object') return false;
  const geometry = value as { type?: unknown; coordinates?: unknown };
  return (geometry.type === 'Polygon' || geometry.type === 'MultiPolygon') && Array.isArray(geometry.coordinates);
}

function boundaryPartsFromGeometry(geometry: Polygon | MultiPolygon, fieldId: string): DrawnPolygon[] {
  const polygons = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates;
  return polygons.map((coordinates, index) => {
    const polygon: Feature<Polygon> = {
      type: 'Feature',
      id: `legacy-${fieldId}-${index}`,
      properties: {},
      geometry: { type: 'Polygon', coordinates },
    };
    return {
      drawId: `legacy-${fieldId}-${index}`,
      polygon,
      acres: Math.round((turfArea(polygon) / 4046.8564224) * 100) / 100,
      label: `Part ${index + 1}`,
    };
  });
}

export default function FieldSetup() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { toast } = useToast();
  const { profile } = useAuth();
  const saveFieldIdem = useIdempotencyKey('save_field', profile?.id || '');
  const saveFieldBoundaryIdem = useIdempotencyKey('set_field_boundary', profile?.id || '');
  const saveFieldOverrideIdem = useIdempotencyKey('set_field_override_acres', profile?.id || '');
  const isNew = id === 'new';

  const [field, setField] = useState<Partial<Field>>({
    field_name: '',
    customer_id: '',
    legal_description: '',
    county: '',
    state: 'IL',
    total_acres: undefined,
    fsa_farm_number: '',
    fsa_tract_number: '',
    fsa_field_number: '',
    crop_type: '',
    soil_type: '',
    irrigation: false,
    notes: '',
    is_active: true,
  });

  const [billingSplits, setBillingSplits] = useState<BillingSplit[]>([]);
  const [loading, setLoading] = useState(!isNew);
  const [saving, setSaving] = useState(false);

  // Map / geo state
  const [boundaryGeoJSON, setBoundaryGeoJSON] = useState<Feature<Polygon | MultiPolygon> | null>(null);
  const [drawnPolygons, setDrawnPolygons] = useState<DrawnPolygon[]>([]);
  const [geometryDirty, setGeometryDirty] = useState(false);                 // boundary drawn/changed this session?
  const loadedOverrideRef = useRef<number | null>(null);                     // override_acres at load (to detect changes)
  const loadedHadBoundaryRef = useRef(false);                                // did the loaded field have a saved boundary?
  const [mapCenter, setMapCenter] = useState<[number, number] | undefined>(undefined);
  const [mapZoom, setMapZoom] = useState<number | undefined>(undefined);
  const [overlayMapCenter, setOverlayMapCenter] = useState<[number, number]>([-89, 40]);
  const [otherFields, setOtherFields] = useState<FieldsGeojsonRow[]>([]);
  const [showOtherFieldBoundaries, setShowOtherFieldBoundaries] = useState(() => {
    try {
      return window.localStorage.getItem(FIELD_CONTEXT_OVERLAY_STORAGE_KEY) !== 'false';
    } catch {
      return true;
    }
  });
  const [partPendingDelete, setPartPendingDelete] = useState<DrawnPolygon | null>(null);
  const [legalLookupLoading, setLegalLookupLoading] = useState(false);
  const [pendingLegalLookup, setPendingLegalLookup] = useState<PlssLookupResult | null>(null);
  const [obstacles, setObstacles] = useState<FieldObstacle[]>([]);
  const [addObstacleMode, setAddObstacleMode] = useState(false);
  const [adoptCsbMode, setAdoptCsbMode] = useState(false);
  const [csbLookupLoading, setCsbLookupLoading] = useState(false);
  const [pendingCsbFeature, setPendingCsbFeature] = useState<CsbFeature | null>(null);
  const [isBoundaryDrawing, setIsBoundaryDrawing] = useState(false);
  const [pendingObstaclePoint, setPendingObstaclePoint] = useState<[number, number] | null>(null);
  const [obstacleKind, setObstacleKind] = useState<FieldObstacleKind>('oil_well');
  const [obstacleLabel, setObstacleLabel] = useState('');
  const [savingObstacle, setSavingObstacle] = useState(false);
  const [deletingObstacle, setDeletingObstacle] = useState(false);
  const [obstaclePendingDelete, setObstaclePendingDelete] = useState<FieldObstacle | null>(null);
  const csbLookupRequestRef = useRef(0);

  // Customer search for the owner dropdown
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [customerSearch, setCustomerSearch] = useState('');
  const [showCustomerDropdown, setShowCustomerDropdown] = useState(false);
  const [ownerName, setOwnerName] = useState('');

  // Customer search for billing split additions
  const [splitCustomerSearch, setSplitCustomerSearch] = useState('');
  const [showSplitDropdown, setShowSplitDropdown] = useState(false);

  // Collapsible sections
  const [fsaOpen, setFsaOpen] = useState(false);
  const [billingOpen, setBillingOpen] = useState(false);

  // Auto-zoom to existing boundary
  const initialBounds = useMemo(() => {
    if (!boundaryGeoJSON) return null;
    return computeBounds([JSON.stringify(boundaryGeoJSON.geometry)]);
  }, [boundaryGeoJSON]);

  const legalLookupPoint = useMemo(() => {
    const geometry = drawnPolygons[0]?.polygon ?? boundaryGeoJSON;
    if (!geometry) return null;
    try {
      const coordinates = turfCentroid(geometry).geometry.coordinates;
      if (typeof coordinates[0] !== 'number' || typeof coordinates[1] !== 'number') return null;
      return { longitude: coordinates[0], latitude: coordinates[1] };
    } catch {
      return null;
    }
  }, [boundaryGeoJSON, drawnPolygons]);

  const overlayFields = useMemo(() => {
    const editedFieldId = field.id ?? (isNew ? null : id);
    return otherFields.filter((otherField) => otherField.id !== editedFieldId);
  }, [field.id, id, isNew, otherFields]);

  const nearbyOverlayFields = useMemo(
    () => mapFieldsForJobPicker(overlayFields, JOB_FIELD_PICKER_MAP_LIMIT, overlayMapCenter),
    [overlayFields, overlayMapCenter],
  );

  const canManageObstacles = profile?.role === 'admin' || profile?.role === 'sales_rep';
  const obstaclesForMap = useMemo(() => {
    if (!pendingObstaclePoint || !id || isNew) return obstacles;
    const pending: FieldObstacle = {
      id: 'pending-obstacle',
      field_id: id,
      kind: obstacleKind,
      label: obstacleLabel.trim() || 'New obstacle',
      point_geojson: { type: 'Point', coordinates: pendingObstaclePoint },
      created_by: profile?.id ?? null,
      created_at: '',
      updated_at: '',
    };
    return [...obstacles, pending];
  }, [id, isNew, obstacleKind, obstacleLabel, obstacles, pendingObstaclePoint, profile?.id]);

  // Mapbox also emits move-end for zooms whose center did not change. Preserve the existing
  // center tuple for those events so the field-drawing subtree keeps its stable inputs.
  const handleMapMoveEnd = useCallback((nextCenter: [number, number]) => {
    setOverlayMapCenter((currentCenter) => (
      currentCenter[0] === nextCenter[0] && currentCenter[1] === nextCenter[1]
        ? currentCenter
        : nextCenter
    ));
  }, []);

  // Duplicate detection
  const [duplicateWarning, setDuplicateWarning] = useState('');

  // Track dirty state
  const [isDirty, setIsDirty] = useState(false);
  const initialLoadDone = useRef(false);
  const blocker = useUnsavedChanges(isDirty);
  // Post-create navigation happens via this state so it fires on a render where
  // isDirty=false has committed — see the comment at the setter in handleSave.
  const [postSaveNavTarget, setPostSaveNavTarget] = useState<string | null>(null);
  useEffect(() => {
    if (postSaveNavTarget && !isDirty) {
      setPostSaveNavTarget(null); // clear before navigating — route reuse must not replay it
      navigate(postSaveNavTarget, { replace: true });
    }
  }, [postSaveNavTarget, isDirty, navigate]);

  useEffect(() => {
    if (!initialLoadDone.current) return;
    setIsDirty(true);
  }, [field, billingSplits]);

  const fetchCustomers = useCallback(async () => {
    const { data } = await supabase
      .from('customers')
      .select('id, farm_name')
      .eq('is_active', true)
      .order('farm_name')
      .limit(500);
    setCustomers((data || []) as Customer[]);
  }, []);

  const fetchField = useCallback(async () => {
    if (!id) return;
    const { data, error } = await supabase
      .from('fields')
      .select('*, customer:customers!fields_customer_id_fkey(farm_name)')
      .eq('id', id)
      .maybeSingle();

    if (error) {
      toast('error', 'Failed to load field');
      setLoading(false);
      return;
    }
    if (data) {
      const { customer: _customer, ...fieldRow } = data;
      setField(fieldRow as Partial<Field>);
      loadedOverrideRef.current = (fieldRow as Partial<Field>).override_acres ?? null;
      loadedHadBoundaryRef.current = (fieldRow as Partial<Field>).measured_acres != null; // A1 backfilled measured for every boundaried field

      const cust = data.customer as { farm_name: string } | null;
      setOwnerName(cust?.farm_name || '');

      // Fetch GeoJSON for map display
      let loadedBoundary: Feature<Polygon | MultiPolygon> | null = null;
      const { data: geoData, error: geoError } = await supabase.rpc('get_field_geojson', { p_field_id: id });
      if (geoError) {
        Sentry.captureException(geoError, { tags: { source: 'fetch', action: 'load_field_geometry' } });
        toast('warning', 'Could not load field boundary');
      }
      const geoRows = assertRpcResult<Array<{ boundary_geojson?: string; centroid_geojson?: string }>>(geoData, 'get_field_geojson');
      if (geoRows && geoRows.length > 0) {
        const geo = geoRows[0];
        if (geo.boundary_geojson) {
          try {
            const parsed: unknown = JSON.parse(geo.boundary_geojson);
            if (isBoundaryGeometry(parsed)) {
              loadedBoundary = { type: 'Feature', properties: {}, geometry: parsed };
              setBoundaryGeoJSON(loadedBoundary);
            }
            if (geo.centroid_geojson) {
              const centroid = JSON.parse(geo.centroid_geojson);
              if (centroid?.coordinates) {
                setMapCenter([centroid.coordinates[0], centroid.coordinates[1]]);
                setMapZoom(15);
              }
            }
          } catch { /* invalid geojson */ }
        } else if (geo.centroid_geojson) {
          try {
            const centroid = JSON.parse(geo.centroid_geojson);
            if (centroid?.coordinates) {
              setMapCenter([centroid.coordinates[0], centroid.coordinates[1]]);
              setMapZoom(14);
            }
          } catch { /* invalid geojson */ }
        }
      }

      // Load multi-polygon data if available. Older boundaries without field_polygons are
      // converted into the same DrawnPolygon state so adding a second part is additive too.
      const { data: polyData, error: polyError } = await supabase.rpc('get_field_polygons', { p_field_id: id });
      let loadedPolygons: DrawnPolygon[] = [];
      if (!polyError && polyData) {
        const polyRows = assertRpcResult<Array<{ id: string; polygon_geojson: object; label: string | null; acres: number | null; sort_order: number }>>(polyData, 'get_field_polygons');
        if (polyRows.length > 0) {
          loadedPolygons = polyRows.map((p, i) => ({
            drawId: p.id,
            // id MUST mirror drawId so DrawLayer/MapboxDraw maps a later edit/delete of this
            // saved polygon back to the right row (it matches by feature.id === drawId).
            polygon: { type: 'Feature' as const, id: p.id, properties: {}, geometry: p.polygon_geojson as GeoJSON.Polygon },
            acres: p.acres ?? 0,
            label: p.label || `Part ${i + 1}`,
          }));
        }
      }
      if (loadedPolygons.length === 0 && loadedBoundary) {
        loadedPolygons = boundaryPartsFromGeometry(loadedBoundary.geometry, id);
      }
      setDrawnPolygons(loadedPolygons);

      // Auto-expand sections with data
      if (data.fsa_farm_number || data.fsa_tract_number || data.fsa_field_number) {
        setFsaOpen(true);
      }

      // Fetch billing defaults
      const { data: defaults } = await supabase
        .from('field_billing_defaults')
        .select('*, customer:customers!field_billing_defaults_customer_id_fkey(farm_name)')
        .eq('field_id', id)
        .order('split_pct', { ascending: false });

      if (defaults && defaults.length > 0) {
        setBillingOpen(true);
        setBillingSplits(
          defaults.map((d: { customer_id: string; customer?: { farm_name: string | null } | null; split_pct: number; is_primary: boolean; notes?: string | null; price_override_cents?: number | null; pricing_note?: string | null }) => ({
            customer_id: d.customer_id,
            customer_name: d.customer?.farm_name || 'Unknown',
            split_pct: Number(d.split_pct),
            is_primary: d.is_primary,
            notes: d.notes || '',
            price_override_cents: d.price_override_cents ?? null,
            pricing_note: d.pricing_note || '',
          }))
        );
      }
    }
    setLoading(false);
    setTimeout(() => { initialLoadDone.current = true; }, 0);
  }, [id, toast]);

  useEffect(() => {
    fetchCustomers();
    if (!isNew && id) {
      fetchField();
    } else {
      setTimeout(() => { initialLoadDone.current = true; }, 0);
    }
  }, [id, isNew, fetchCustomers, fetchField]);

  useEffect(() => {
    if (isNew || !id) {
      setObstacles([]);
      return;
    }
    let active = true;
    const loadObstacles = async () => {
      const { data, error } = await supabase
        .from('field_obstacles')
        .select('*')
        .eq('field_id', id)
        .order('created_at');
      if (!active) return;
      if (error) {
        setObstacles([]);
        toast('error', 'Could not load field obstacles.');
        return;
      }
      setObstacles((data ?? []) as unknown as FieldObstacle[]);
    };
    void loadObstacles();
    return () => { active = false; };
  }, [id, isNew, toast]);

  useEffect(() => {
    try {
      window.localStorage.setItem(
        FIELD_CONTEXT_OVERLAY_STORAGE_KEY,
        showOtherFieldBoundaries ? 'true' : 'false',
      );
    } catch {
      // Local preference is optional; the map still works when storage is unavailable.
    }
  }, [showOtherFieldBoundaries]);

  useEffect(() => {
    if (!showOtherFieldBoundaries) return;
    let active = true;
    const loadOtherFields = async () => {
      try {
        const rows = await getCachedFieldsGeojson();
        if (active) setOtherFields(rows);
      } catch (error: unknown) {
        Sentry.captureException(error instanceof Error ? error : new Error(String(error)), {
          tags: { component: 'FieldSetup', action: 'load_other_field_boundaries' },
        });
        if (active) {
          setOtherFields([]);
          toast('error', 'Could not load other field boundaries.');
        }
      }
    };
    void loadOtherFields();
    return () => { active = false; };
  }, [showOtherFieldBoundaries, toast]);

  const update = (key: string, value: unknown) => setField((f) => ({ ...f, [key]: value }));

  const splitTotal = billingSplits.reduce((sum, s) => sum + s.split_pct, 0);

  // Two-acre model: the polygon area is a client preview of the server-measured acres;
  // the typed override is what actually bills (billable = override ?? measured ?? legacy total).
  const measuredPreview =
    drawnPolygons.length > 0
      ? Math.round(drawnPolygons.reduce((s, p) => s + p.acres, 0) * 100) / 100
      : (field.measured_acres ?? null);
  const billable = billableAcres(field.override_acres, measuredPreview, field.total_acres);

  // Duplicate field name check
  const checkDuplicate = useCallback(async (name: string, customerId: string) => {
    if (!name || !customerId) {
      setDuplicateWarning('');
      return;
    }
    const { data } = await supabase
      .from('fields')
      .select('id, field_name')
      .eq('customer_id', customerId)
      .ilike('field_name', name)
      .neq('id', id || '00000000-0000-0000-0000-000000000000')
      .limit(1);
    if (data && data.length > 0) {
      setDuplicateWarning(`A field named "${data[0].field_name}" already exists for this customer.`);
    } else {
      setDuplicateWarning('');
    }
  }, [id]);

  const addBillingSplit = (customerId: string, customerName: string) => {
    if (billingSplits.find((s) => s.customer_id === customerId)) {
      toast('error', 'This customer is already in the billing split');
      return;
    }
    setBillingSplits((prev) => [
      ...prev,
      { customer_id: customerId, customer_name: customerName, split_pct: 0, is_primary: prev.length === 0, notes: '', price_override_cents: null, pricing_note: '' },
    ]);
    setSplitCustomerSearch('');
    setShowSplitDropdown(false);
  };

  const removeBillingSplit = (idx: number) => {
    setBillingSplits((prev) => prev.filter((_, i) => i !== idx));
  };

  const updateSplit = (idx: number, key: keyof BillingSplit, value: unknown) => {
    setBillingSplits((prev) =>
      prev.map((s, i) => (i === idx ? { ...s, [key]: value } : s))
    );
  };

  const distributeEvenly = () => {
    if (billingSplits.length === 0) return;
    const each = Math.floor((10000 / billingSplits.length)) / 100;
    const remainder = 100 - each * billingSplits.length;
    setBillingSplits((prev) =>
      prev.map((s, i) => ({
        ...s,
        split_pct: i === 0 ? +(each + remainder).toFixed(2) : each,
      }))
    );
  };

  const handleSave = async () => {
    if (!field.field_name) {
      toast('error', 'Field name is required');
      return;
    }
    if (!field.customer_id) {
      toast('error', 'Owner (customer) is required');
      return;
    }

    if (billingSplits.length > 0 && Math.abs(splitTotal - 100) > 0.01) {
      toast('error', `Billing splits must total 100% (currently ${splitTotal.toFixed(2)}%)`);
      return;
    }

    // Same 0.1–5000 band the import + the measured-boundary path enforce — so a typed override
    // (e.g. "what the monitor showed", with no map drawn) goes through the same safety gate.
    if (field.override_acres != null && !isAcreInBand(field.override_acres)) {
      toast('error', `Billable acres must be between ${ACRE_BAND_MIN} and ${ACRE_BAND_MAX} (leave blank to bill the measured acres).`);
      return;
    }

    setSaving(true);
    try {
      const fieldPayload = {
        customer_id: field.customer_id,
        field_name: field.field_name,
        legal_description: field.legal_description || null,
        county: field.county || null,
        state: field.state || 'IL',
        // Send the loaded (server-authoritative) total_acres — never a client preview/estimate,
        // so we can never persist a value the acreage RPC would reject. The acreage RPCs own the
        // precise total_acres when geometry/override change. KNOWN FOLLOW-UP (for the live-UI
        // gate): after a successful boundary/override save, sync local total_acres/measured from
        // the RPC result so a same-page attribute-only re-save can't revert to this loaded value.
        total_acres: field.total_acres ?? null,
        fsa_farm_number: field.fsa_farm_number || null,
        fsa_tract_number: field.fsa_tract_number || null,
        fsa_field_number: field.fsa_field_number || null,
        crop_type: field.crop_type || null,
        soil_type: field.soil_type || null,
        irrigation: field.irrigation || false,
        notes: field.notes || null,
        is_active: field.is_active ?? true,
      };

      const billingPayload = billingSplits.map((s) => ({
        customer_id: s.customer_id,
        split_pct: s.split_pct,
        is_primary: s.is_primary,
        notes: s.notes || null,
        price_override_cents: s.price_override_cents || null,
        pricing_note: s.pricing_note || null,
      }));

      const idemKey = saveFieldIdem.getKey();
      const { data, error } = await supabase.rpc('save_field', {
        p_field_id: (isNew ? null : id) as string,
        p_field_payload: fieldPayload,
        p_billing_defaults: billingPayload,
        p_performed_by: profile!.id,
        p_idempotency_key: idemKey,
      });

      if (error) {
        toast('error', rpcAuthErrorMessage(error) ?? error.message);
      } else {
        saveFieldIdem.resetKey();
        assertRpcResult(data, 'save_field');
        const savedFieldId = isNew ? data : id;

        // The field record is saved; now persist its acreage. Track whether any acreage RPC
        // fails so we don't report a misleading success or clear the dirty flag.
        let persistError = false;

        // Persist the boundary via the server-authoritative acreage RPC (measures + 0.1–5000
        // band + field_polygons sync + audit). Only when the geometry was drawn/changed this
        // session, so an attribute-only edit doesn't re-measure or re-audit.
        if (geometryDirty && savedFieldId) {
          const geom = buildBoundaryGeometry(drawnPolygons.map((p) => p.polygon), boundaryGeoJSON);
          if (geom) {
            const boundaryIdemKey = saveFieldBoundaryIdem.getKey();
            try {
              const { data: bData, error: bErr } = await supabase.rpc('set_field_boundary', {
                p_field_id: savedFieldId,
                p_boundary_geojson: JSON.stringify(geom),
                p_performed_by: profile!.id,
                p_idempotency_key: boundaryIdemKey,
              });
              if (bErr) throw bErr;
              assertRpcResult(bData, 'set_field_boundary');
              saveFieldBoundaryIdem.resetKey();
              loadedHadBoundaryRef.current = true; // a newly persisted boundary cannot be removed in this editor
              setGeometryDirty(false);   // boundary persisted — don't re-measure on a later attribute-only save
            } catch (geoError) {
              Sentry.captureException(geoError instanceof Error ? geoError : new Error(String(geoError)), { tags: { source: 'critical_action', action: 'set_field_boundary' } });
              toast('error', 'Field saved but the boundary could not be measured. Please re-draw and save.');
              persistError = true;
            }
          } else if (loadedHadBoundaryRef.current) {
            // A previously-saved measured boundary was deleted down to nothing. v1 cannot clear
            // a measured boundary (the authority columns are RPC-only) — redraw to replace it.
            toast('error', 'A measured boundary cannot be removed here — draw a replacement boundary and save.');
            persistError = true;
          }
          // else: drew-then-deleted on a field that never had a saved boundary → nothing to persist (no-op).
        }

        // Persist the billable-acres override (set or clear) only when it changed — it
        // survives a redraw because set_field_boundary never touches override_acres.
        if (savedFieldId && (field.override_acres ?? null) !== loadedOverrideRef.current) {
          const ovIdemKey = saveFieldOverrideIdem.getKey();
          try {
            const { data: oData, error: oErr } = await supabase.rpc('set_field_override_acres', {
              p_field_id: savedFieldId,
              // NULL intentionally clears the override (reverts to measured acres) — the RPC
              // accepts NULL by design, but Supabase typegen can't express a nullable
              // required arg, so the generated type says `number`. Cast is safe.
              p_override_acres: (field.override_acres ?? null) as unknown as number,
              p_performed_by: profile!.id,
              p_idempotency_key: ovIdemKey,
            });
            if (oErr) throw oErr;
            assertRpcResult(oData, 'set_field_override_acres');
            saveFieldOverrideIdem.resetKey();
            loadedOverrideRef.current = field.override_acres ?? null;
          } catch (ovError) {
            Sentry.captureException(ovError instanceof Error ? ovError : new Error(String(ovError)), { tags: { source: 'critical_action', action: 'set_field_override_acres' } });
            toast('error', 'Field saved but the billable-acres override could not be applied. Please retry.');
            persistError = true;
          }
        }

        if (persistError) {
          // Keep the form dirty so the user retries. For a brand-new field still navigate to
          // the created record so a retry edits it instead of creating a duplicate.
          if (isNew && savedFieldId) navigate(`/fields/${savedFieldId}`, { replace: true });
          setSaving(false);
          return;
        }

        setIsDirty(false);
        if (isNew) {
          toast('success', 'Field created');
          // Deferred: navigating here directly races the unsaved-changes blocker —
          // it evaluates against the still-committed dirty=true render and shows a
          // false "Unsaved Changes" prompt after every successful create.
          setPostSaveNavTarget(`/fields/${data}`);
        } else {
          toast('success', 'Field updated');
        }
      }
    } catch (err: unknown) {
      Sentry.captureException(err instanceof Error ? err : new Error(String(err)), { extra: { context: 'save_field' } });
      toast('error', err instanceof Error ? err.message : 'Failed to save field');
    }
    setSaving(false);
  };

  const handlePolygonsChange = useCallback((polygons: DrawnPolygon[]) => {
    setDrawnPolygons(polygons);
    const combinedGeometry = buildBoundaryGeometry(polygons.map((polygon) => polygon.polygon), null);
    if (!combinedGeometry) {
      setBoundaryGeoJSON(null);
    } else {
      const combinedBoundary: Feature<Polygon | MultiPolygon> = {
        type: 'Feature',
        properties: {},
        geometry: combinedGeometry,
      };
      const nextBounds = computeBounds([JSON.stringify(combinedGeometry)]);
      setBoundaryGeoJSON((current) => {
        if (!current || !nextBounds) return combinedBoundary;
        const currentBounds = computeBounds([JSON.stringify(current.geometry)]);
        const boundsChanged = !currentBounds || currentBounds.some(
          (value, index) => Math.abs(value - nextBounds[index]) > BOUNDS_CHANGE_EPSILON,
        );
        return boundsChanged ? combinedBoundary : current;
      });
    }
    if (initialLoadDone.current) { setGeometryDirty(true); setIsDirty(true); }
    if (polygons.length > 0) {
      const center = turfCentroid(polygons[0].polygon);
      setMapCenter([center.geometry.coordinates[0], center.geometry.coordinates[1]]);
    }
  }, []);

  const checkCsbOverlap = useCallback((polygons: DrawnPolygon[]) => {
    if (!field.customer_id) return;
    const geometry = buildBoundaryGeometry(polygons.map((polygon) => polygon.polygon), null);
    if (!geometry) return;

    void (async () => {
      try {
        const { data, error } = await supabase.rpc('find_overlapping_fields', {
          p_boundary_geojson: JSON.stringify(geometry),
          p_customer_id: field.customer_id,
        });
        if (error) throw error;
        const rows = assertRpcResult<unknown>(data, 'find_overlapping_fields');
        const overlap = Array.isArray(rows)
          ? rows.find((row) => isOverlappingField(row)
            // The field being edited overlaps its own saved boundary ~100% —
            // warn only about OTHER fields.
            && (isNew || row.field_id !== id)
            && typeof row.field_name === 'string'
            && typeof row.overlap_pct === 'number'
            && row.overlap_pct >= 80)
          : undefined;
        if (overlap && typeof overlap.field_name === 'string') {
          toast('warning', `This boundary overlaps ${overlap.field_name} by 80% or more.`);
        }
      } catch (error: unknown) {
        Sentry.captureException(error instanceof Error ? error : new Error(String(error)), {
          tags: { component: 'FieldSetup', action: 'check_csb_boundary_overlap' },
        });
      }
    })();
  }, [field.customer_id, id, isNew, toast]);

  const applyLegalLookup = useCallback((lookup: PlssLookupResult) => {
    setField((current) => ({
      ...current,
      legal_description: lookup.legalDescription,
    }));
  }, []);

  const handleLegalLookup = useCallback(async () => {
    if (!legalLookupPoint) return;
    setLegalLookupLoading(true);
    try {
      const lookup = await lookupPlss(legalLookupPoint);
      const hasLegalDescription = Boolean(field.legal_description?.trim());
      if (hasLegalDescription) {
        setPendingLegalLookup(lookup);
      } else {
        applyLegalLookup(lookup);
        toast('success', 'Legal description filled from the field boundary');
      }
    } catch (error: unknown) {
      Sentry.captureException(error instanceof Error ? error : new Error(String(error)), {
        tags: { component: 'FieldSetup', action: 'legal_lookup' },
      });
      toast('error', 'Legal lookup unavailable');
    } finally {
      setLegalLookupLoading(false);
    }
  }, [applyLegalLookup, field.legal_description, legalLookupPoint, toast]);

  // Address search handler — fly map to selected location
  const handleAddressSelect = useCallback((lng: number, lat: number) => {
    setMapCenter([lng, lat]);
    setMapZoom(16);
  }, []);

  const resetObstacleDraft = useCallback(() => {
    setPendingObstaclePoint(null);
    setObstacleKind('oil_well');
    setObstacleLabel('');
  }, []);

  const clearCsbPreview = useCallback(() => {
    csbLookupRequestRef.current += 1;
    setPendingCsbFeature(null);
    setCsbLookupLoading(false);
  }, []);

  const finishCsbAdopt = useCallback(() => {
    clearCsbPreview();
    setAdoptCsbMode(false);
  }, [clearCsbPreview]);

  const handleCsbMapClick = useCallback(async (longitude: number, latitude: number) => {
    if (saving) return; // no new previews while a save is in flight
    const requestId = csbLookupRequestRef.current + 1;
    csbLookupRequestRef.current = requestId;
    setPendingCsbFeature(null);
    setCsbLookupLoading(true);
    try {
      const result = await findCsbFeatureAt({ lng: longitude, lat: latitude });
      if (csbLookupRequestRef.current !== requestId) return;
      if (result.kind === 'no-coverage') {
        toast('info', 'No USDA boundary data loaded for this area yet.');
      } else if (result.kind === 'no-field') {
        toast('info', 'No USDA field boundary at that spot.');
      } else {
        setPendingCsbFeature(result.feature);
      }
    } catch (error: unknown) {
      if (csbLookupRequestRef.current !== requestId) return;
      Sentry.captureException(error instanceof Error ? error : new Error(String(error)), {
        tags: { component: 'FieldSetup', action: 'lookup_csb_boundary' },
      });
      toast('error', error instanceof CsbLookupError ? 'USDA boundary lookup is unavailable.' : 'Could not look up the USDA boundary.');
    } finally {
      if (csbLookupRequestRef.current === requestId) setCsbLookupLoading(false);
    }
  }, [saving, toast]);

  // Invalidate any in-flight USDA lookup on unmount so a late response can't
  // toast onto whatever page the user navigated to.
  useEffect(() => () => {
    csbLookupRequestRef.current += 1;
  }, []);

  const handleCsbModeToggle = useCallback(() => {
    if (adoptCsbMode) {
      finishCsbAdopt();
      return;
    }
    if (isBoundaryDrawing) return;
    setAddObstacleMode(false);
    resetObstacleDraft();
    clearCsbPreview();
    setAdoptCsbMode(true);
  }, [adoptCsbMode, clearCsbPreview, finishCsbAdopt, isBoundaryDrawing, resetObstacleDraft]);

  const handleAddCsbBoundary = useCallback(() => {
    // Save snapshots the polygon list when it starts and clears the dirty flag
    // when it finishes — a part added mid-save would LOOK saved but never
    // persist. Block geometry adds while a save is in flight.
    if (!pendingCsbFeature || saving) return;
    try {
      const adopted = csbFeatureToDrawnParts(pendingCsbFeature, drawnPolygons.length);
      const nextPolygons = [...drawnPolygons, ...adopted.parts];
      handlePolygonsChange(nextPolygons);
      clearCsbPreview();
      const total = Math.round(nextPolygons.reduce((sum, polygon) => sum + polygon.acres, 0) * 10) / 10;
      toast('success', `USDA boundary added. ${total.toFixed(1)} ac total.`);
      checkCsbOverlap(nextPolygons);
    } catch (error: unknown) {
      Sentry.captureException(error instanceof Error ? error : new Error(String(error)), {
        tags: { component: 'FieldSetup', action: 'adopt_csb_boundary' },
      });
      toast('error', error instanceof CsbAdoptError ? error.message : 'Could not adopt the USDA boundary.');
    }
  }, [checkCsbOverlap, clearCsbPreview, drawnPolygons, handlePolygonsChange, pendingCsbFeature, saving, toast]);

  const handleMapClick = useCallback((longitude: number, latitude: number) => {
    if (adoptCsbMode) {
      void handleCsbMapClick(longitude, latitude);
      return;
    }
    if (!addObstacleMode || !canManageObstacles || isNew) return;
    setPendingObstaclePoint([longitude, latitude]);
  }, [adoptCsbMode, addObstacleMode, canManageObstacles, handleCsbMapClick, isNew]);

  const handleObstacleModeToggle = useCallback(() => {
    if (addObstacleMode) {
      setAddObstacleMode(false);
      resetObstacleDraft();
      return;
    }

    if (!canEnterObstacleMode(isBoundaryDrawing)) {
      toast('error', 'Finish or cancel the boundary before adding an obstacle.');
      return;
    }

    finishCsbAdopt();
    resetObstacleDraft();
    setAddObstacleMode(true);
  }, [addObstacleMode, finishCsbAdopt, isBoundaryDrawing, resetObstacleDraft, toast]);

  const handleAddObstacle = async () => {
    if (!id || isNew || !profile || !canManageObstacles || !pendingObstaclePoint) return;
    setSavingObstacle(true);
    try {
      const result = await supabase
        .from('field_obstacles')
        .insert({
          field_id: id,
          kind: obstacleKind,
          label: obstacleLabel.trim() || null,
          point_geojson: { type: 'Point', coordinates: pendingObstaclePoint },
          created_by: profile.id,
        })
        .select('*')
        .single();
      checkMutationResult(result, 'Add field obstacle');
      setObstacles((current) => [...current, result.data as unknown as FieldObstacle]);
      resetObstacleDraft();
      setAddObstacleMode(false);
      toast('success', 'Obstacle added');
    } catch (error: unknown) {
      Sentry.captureException(error instanceof Error ? error : new Error(String(error)), {
        tags: { component: 'FieldSetup', action: 'add_field_obstacle' },
      });
      toast('error', 'Could not add obstacle.');
    } finally {
      setSavingObstacle(false);
    }
  };

  const handleDeleteObstacle = async () => {
    if (!obstaclePendingDelete || !canManageObstacles) return;
    setDeletingObstacle(true);
    try {
      const result = await supabase
        .from('field_obstacles')
        .delete()
        .eq('id', obstaclePendingDelete.id)
        .select('id');
      checkMutationResult(result, 'Delete field obstacle');
      setObstacles((current) => current.filter((obstacle) => obstacle.id !== obstaclePendingDelete.id));
      setObstaclePendingDelete(null);
      toast('success', 'Obstacle deleted');
    } catch (error: unknown) {
      Sentry.captureException(error instanceof Error ? error : new Error(String(error)), {
        tags: { component: 'FieldSetup', action: 'delete_field_obstacle' },
      });
      toast('error', 'Could not delete obstacle.');
    } finally {
      setDeletingObstacle(false);
    }
  };

  const filteredCustomers = customers.filter((c) =>
    c.farm_name.toLowerCase().includes(customerSearch.toLowerCase())
  );

  const filteredSplitCustomers = customers.filter((c) =>
    c.farm_name.toLowerCase().includes(splitCustomerSearch.toLowerCase())
  );

  if (loading) {
    return <div className="animate-pulse"><div className="h-64 bg-gray-200 rounded" /></div>;
  }

  if (!isNew && !field.id) {
    return (
      <div className="flex flex-col items-center justify-center py-16 space-y-4">
        <p className="text-secondary text-lg">Field not found</p>
        <Button variant="secondary" onClick={() => navigate('/fields')}>Back to Fields</Button>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center gap-3">
        <button aria-label="Back to fields" onClick={() => navigate('/fields')} className="p-2 rounded-lg hover:bg-white hover:shadow-sm transition-all text-secondary">
          <ArrowLeft className="w-5 h-5" />
        </button>
        <MapPin className="w-5 h-5 text-crx-green" />
        <h2 className="text-lg font-semibold font-heading text-nav-dark">
          {isNew ? 'New Field' : field.field_name}
        </h2>
        {!isNew && (
          <Button variant="ghost" size="sm" onClick={() => navigate(`/fields/${id}/dashboard`)} className="ml-auto">
            View Dashboard
          </Button>
        )}
      </div>

      {/* Two-panel layout: form left, map right on desktop */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-4">
        {/* Left Panel — Form */}
        <div className="lg:col-span-7 space-y-4">
          {/* Field Identity */}
          <Card>
            <CardHeader title="Field" accent="Information" />
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <Input
                label="Field Name"
                required
                value={field.field_name || ''}
                onChange={(e) => update('field_name', e.target.value)}
                onBlur={() => checkDuplicate(field.field_name || '', field.customer_id || '')}
                placeholder="e.g. North 80"
              />

              {/* Owner (Customer) selector */}
              <div className="relative">
                <label className="block text-sm font-medium text-secondary mb-1">
                  Owner (Customer) <span className="text-red-500">*</span>
                </label>
                <div className="relative">
                  <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
                  <input
                    type="text"
                    value={showCustomerDropdown ? customerSearch : ownerName}
                    onChange={(e) => {
                      setCustomerSearch(e.target.value);
                      setShowCustomerDropdown(true);
                    }}
                    onFocus={() => {
                      setCustomerSearch('');
                      setShowCustomerDropdown(true);
                    }}
                    onBlur={() => setTimeout(() => setShowCustomerDropdown(false), 200)}
                    placeholder="Search customers..."
                    className="w-full pl-9 pr-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green"
                  />
                </div>
                {showCustomerDropdown && (
                  <div className="absolute z-20 w-full mt-1 bg-white border border-gray-200 rounded-lg shadow-lg max-h-48 overflow-y-auto">
                    {filteredCustomers.length === 0 ? (
                      <div className="px-4 py-3 text-sm text-secondary">No customers found</div>
                    ) : (
                      filteredCustomers.slice(0, 20).map((c) => (
                        <button
                          key={c.id}
                          type="button"
                          onMouseDown={(e) => e.preventDefault()}
                          onClick={() => {
                            update('customer_id', c.id);
                            setOwnerName(c.farm_name);
                            setShowCustomerDropdown(false);
                            checkDuplicate(field.field_name || '', c.id);
                          }}
                          className="w-full text-left px-4 py-2 text-sm hover:bg-crx-green-tint transition-colors"
                        >
                          {c.farm_name}
                        </button>
                      ))
                    )}
                  </div>
                )}
              </div>

              {/* Duplicate warning */}
              {duplicateWarning && (
                <div className="sm:col-span-2 flex items-center gap-2 px-3 py-2 bg-amber-50 border border-amber-200 rounded-lg text-sm text-amber-700">
                  <AlertTriangle className="w-4 h-4 shrink-0" />
                  {duplicateWarning}
                </div>
              )}

              <Input
                label="Legal Description"
                value={field.legal_description || ''}
                onChange={(e) => update('legal_description', e.target.value)}
                placeholder="e.g. NW 1/4 Sec 12 T34N R2E"
              />
              <Input
                label="County"
                value={field.county || ''}
                onChange={(e) => update('county', e.target.value)}
              />
              <Input
                label="State"
                value={field.state || ''}
                onChange={(e) => update('state', e.target.value)}
              />
              <div className="sm:col-span-2 flex flex-wrap items-center justify-between gap-2 rounded-lg bg-gray-50 px-3 py-2">
                <p className="text-xs text-secondary">Use the drawn field location to fill the legal description.</p>
                <span title={legalLookupPoint ? 'Look up the PLSS legal description from this field boundary' : 'Draw a field boundary before using legal lookup'}>
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    icon={<MapPinned className="h-4 w-4" />}
                    onClick={() => void handleLegalLookup()}
                    disabled={!legalLookupPoint}
                    loading={legalLookupLoading}
                  >
                    Legal lookup
                  </Button>
                </span>
              </div>
              <div>
                <Input
                  label="Acres to bill"
                  type="number"
                  min={0}
                  step={0.01}
                  value={field.override_acres ?? ''}
                  onChange={(e) => update('override_acres', e.target.value ? parseFloat(e.target.value) : null)}
                  placeholder={measuredPreview != null ? `Defaults to measured (${measuredPreview} ac)` : 'Acres to bill (e.g. what the monitor showed)'}
                />
                {billable != null ? (
                  <div className="mt-1.5 rounded-lg bg-crx-green-light border border-crx-green/20 px-3 py-2">
                    <p className="text-sm font-semibold text-crx-green">This field bills {billable} ac</p>
                    <p className="text-xs text-secondary">
                      {field.override_acres != null
                        ? 'from the acres you typed above'
                        : measuredPreview != null
                          ? 'from the map you drew'
                          : 'from the old total on file'}
                      {field.override_acres != null && measuredPreview != null ? ` (map measured ${measuredPreview} ac)` : ''}
                    </p>
                  </div>
                ) : (
                  <p className="text-xs text-secondary mt-1">
                    No map yet - type the acres your monitor or records show to bill without drawing or importing.
                  </p>
                )}
                {field.override_acres != null && !isAcreInBand(field.override_acres) && (
                  <p className="text-xs text-red-600 mt-1">
                    Billable acres must be between {ACRE_BAND_MIN} and {ACRE_BAND_MAX}.
                  </p>
                )}
                {billable != null && measuredPreview != null && isAcreDivergent(billable, measuredPreview) && (
                  <p className="text-xs text-amber-600 mt-1 flex items-start gap-1">
                    <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                    <span>
                      Billable is {Math.round(acreDivergencePct(billable, measuredPreview) ?? 0)}% {billable > measuredPreview ? 'above' : 'below'} the measured acres — double-check this field.
                    </span>
                  </p>
                )}
              </div>
            </div>
          </Card>

          {/* Crop & Soil */}
          <Card>
            <CardHeader title="Crop" accent="& Soil" />
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              <div>
                <label className="block text-sm font-medium text-secondary mb-1">Crop Type</label>
                <select
                  value={field.crop_type || ''}
                  onChange={(e) => update('crop_type', e.target.value || null)}
                  className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green"
                >
                  <option value="">Select crop...</option>
                  <option value="corn">Corn</option>
                  <option value="soybean">Soybean</option>
                  <option value="wheat">Wheat</option>
                  <option value="alfalfa">Alfalfa</option>
                  <option value="hay">Hay</option>
                  <option value="pasture">Pasture</option>
                  <option value="other">Other</option>
                </select>
              </div>
              <Input
                label="Soil Type"
                value={field.soil_type || ''}
                onChange={(e) => update('soil_type', e.target.value)}
                placeholder="e.g. Drummer silty clay loam"
              />
              <div>
                <label className="block text-sm font-medium text-secondary mb-1">Irrigation</label>
                <label className="flex items-center gap-2 mt-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={field.irrigation || false}
                    onChange={(e) => update('irrigation', e.target.checked)}
                    className="w-4 h-4 rounded border-gray-300 text-crx-green focus:ring-crx-green"
                  />
                  <span className="text-sm">Irrigated field</span>
                </label>
              </div>
            </div>
          </Card>

          {/* FSA Numbers — Collapsible */}
          <Card>
            <button
              type="button"
              onClick={() => setFsaOpen(!fsaOpen)}
              className="w-full flex items-center justify-between"
            >
              <CardHeader title="FSA" accent="Numbers" />
              {fsaOpen ? <ChevronUp className="w-4 h-4 text-secondary" /> : <ChevronDown className="w-4 h-4 text-secondary" />}
            </button>
            {fsaOpen && (
              <div className="mt-4">
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                  <Input
                    label="Farm Number"
                    value={field.fsa_farm_number || ''}
                    onChange={(e) => update('fsa_farm_number', e.target.value)}
                    placeholder="USDA FSA farm #"
                  />
                  <Input
                    label="Tract Number"
                    value={field.fsa_tract_number || ''}
                    onChange={(e) => update('fsa_tract_number', e.target.value)}
                    placeholder="USDA FSA tract #"
                  />
                  <Input
                    label="Field Number"
                    value={field.fsa_field_number || ''}
                    onChange={(e) => update('fsa_field_number', e.target.value)}
                    placeholder="USDA FSA field #"
                  />
                </div>
                <p className="text-xs text-secondary mt-2">
                  FSA (Farm Service Agency) numbers are used for government program tracking.
                </p>
              </div>
            )}
          </Card>

          {/* Billing Splits — Collapsible */}
          <Card>
            <button
              type="button"
              onClick={() => setBillingOpen(!billingOpen)}
              className="w-full flex items-center justify-between"
            >
              <CardHeader
                title="Default Billing"
                accent="Splits"
                action={
                  billingOpen && billingSplits.length > 1 ? (
                    <Button variant="ghost" size="sm" onClick={(e: React.MouseEvent) => { e.stopPropagation(); distributeEvenly(); }}>
                      Split Evenly
                    </Button>
                  ) : undefined
                }
              />
              {billingOpen ? <ChevronUp className="w-4 h-4 text-secondary" /> : <ChevronDown className="w-4 h-4 text-secondary" />}
            </button>
            {billingOpen && (
              <div className="mt-4">
                <p className="text-xs text-secondary mb-4">
                  Define how costs for this field are split between customers. Splits must total 100%.
                </p>

                {billingSplits.length > 0 && (
                  <div className="space-y-3 mb-4">
                    {billingSplits.map((split, idx) => (
                      <div key={split.customer_id} className="p-3 border border-gray-100 rounded-lg space-y-2">
                        <div className="flex items-center gap-3">
                          <div className="flex-1 min-w-0">
                            <span className="text-sm font-medium text-nav-dark">{split.customer_name}</span>
                            {split.is_primary && (
                              <Badge variant="success" className="ml-2">Primary</Badge>
                            )}
                          </div>
                          <div className="w-28">
                            <div className="relative">
                              <input
                                type="number"
                                value={split.split_pct}
                                onChange={(e) => updateSplit(idx, 'split_pct', parseFloat(e.target.value) || 0)}
                                min={0}
                                max={100}
                                step={0.01}
                                className="w-full px-3 py-1.5 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green pr-7"
                              />
                              <span className="absolute right-2 top-1/2 -translate-y-1/2 text-xs text-secondary">%</span>
                            </div>
                          </div>
                          {!split.is_primary && (
                            <button
                              onClick={() => {
                                setBillingSplits((prev) =>
                                  prev.map((s, i) => ({ ...s, is_primary: i === idx }))
                                );
                              }}
                              className="text-xs text-secondary hover:text-crx-green"
                              title="Set as primary"
                            >
                              Set Primary
                            </button>
                          )}
                          <button
                            onClick={() => removeBillingSplit(idx)}
                            className="text-gray-400 hover:text-red-500 p-1"
                          >
                            <Trash2 className="w-4 h-4" />
                          </button>
                        </div>
                        <div className="flex items-center gap-3 pl-1">
                          <div className="w-36">
                            <label className="block text-xs text-secondary mb-0.5">Price Override ($/ac)</label>
                            <div className="relative">
                              <span className="absolute left-2 top-1/2 -translate-y-1/2 text-xs text-secondary">$</span>
                              <input
                                type="number"
                                value={split.price_override_cents != null ? (split.price_override_cents / 100).toFixed(2) : ''}
                                onChange={(e) => {
                                  const val = e.target.value;
                                  updateSplit(idx, 'price_override_cents', val ? parseDollarsToCents(val) : null);
                                }}
                                min={0}
                                step={0.01}
                                placeholder="—"
                                className="w-full pl-5 pr-3 py-1.5 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green"
                              />
                            </div>
                          </div>
                          <div className="flex-1">
                            <label className="block text-xs text-secondary mb-0.5">Pricing Note</label>
                            <input
                              type="text"
                              value={split.pricing_note}
                              onChange={(e) => updateSplit(idx, 'pricing_note', e.target.value)}
                              placeholder="e.g. Prepaid rate, Landlord rate"
                              className="w-full px-3 py-1.5 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green"
                            />
                          </div>
                        </div>
                      </div>
                    ))}

                    <div className={`flex items-center justify-between px-3 py-2 rounded-lg text-sm font-medium ${
                      Math.abs(splitTotal - 100) < 0.01
                        ? 'bg-emerald-50 text-emerald-700'
                        : 'bg-amber-50 text-amber-700'
                    }`}>
                      <span>Total</span>
                      <span>{splitTotal.toFixed(2)}%</span>
                    </div>
                  </div>
                )}

                {/* Add customer to split */}
                <div className="relative">
                  <div className="relative">
                    <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
                    <input
                      type="text"
                      value={splitCustomerSearch}
                      onChange={(e) => {
                        setSplitCustomerSearch(e.target.value);
                        setShowSplitDropdown(true);
                      }}
                      onFocus={() => setShowSplitDropdown(true)}
                      onBlur={() => setTimeout(() => setShowSplitDropdown(false), 200)}
                      placeholder="Search customer to add to billing split..."
                      className="w-full pl-9 pr-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green"
                    />
                  </div>
                  {showSplitDropdown && splitCustomerSearch && (
                    <div className="absolute z-20 w-full mt-1 bg-white border border-gray-200 rounded-lg shadow-lg max-h-48 overflow-y-auto">
                      {filteredSplitCustomers.length === 0 ? (
                        <div className="px-4 py-3 text-sm text-secondary">No customers found</div>
                      ) : (
                        filteredSplitCustomers.slice(0, 15).map((c) => (
                          <button
                            key={c.id}
                            type="button"
                            onMouseDown={(e) => e.preventDefault()}
                            onClick={() => addBillingSplit(c.id, c.farm_name)}
                            className="w-full text-left px-4 py-2 text-sm hover:bg-crx-green-tint transition-colors flex items-center justify-between"
                          >
                            <span>{c.farm_name}</span>
                            {billingSplits.find((s) => s.customer_id === c.id) && (
                              <span className="text-xs text-secondary">Already added</span>
                            )}
                          </button>
                        ))
                      )}
                    </div>
                  )}
                </div>
              </div>
            )}
          </Card>

          {/* Notes */}
          <Card>
            <CardHeader title="Notes" accent="" />
            <textarea
              value={field.notes || ''}
              onChange={(e) => update('notes', e.target.value)}
              rows={3}
              className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green"
              placeholder="General notes about this field..."
            />
          </Card>

          {/* Active Status */}
          {!isNew && (
            <Card>
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm font-medium text-nav-dark">Field Status</p>
                  <p className="text-xs text-secondary">Inactive fields are hidden from default views</p>
                </div>
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={field.is_active ?? true}
                    onChange={(e) => update('is_active', e.target.checked)}
                    className="w-4 h-4 rounded border-gray-300 text-crx-green focus:ring-crx-green"
                  />
                  <span className="text-sm">{field.is_active ? 'Active' : 'Inactive'}</span>
                </label>
              </div>
            </Card>
          )}

          <div className="flex justify-end">
            <Button icon={<Save className="w-4 h-4" />} onClick={handleSave} loading={saving}>
              {isNew ? 'Create Field' : 'Save Changes'}
            </Button>
          </div>
        </div>

        {/* Right Panel — Map */}
        <div className="lg:col-span-5">
          <Card className="lg:sticky lg:top-4">
            <CardHeader
              title="Field"
              accent="Location"
              action={
                <div className="flex items-center gap-1">
                  {MAPBOX_TOKEN_AVAILABLE && (
                    <span title={isBoundaryDrawing ? 'Finish or cancel the boundary sketch before adopting a USDA boundary' : 'Click a USDA field boundary on the map to preview it'}>
                      <Button
                        type="button"
                        variant={adoptCsbMode ? 'ghost' : 'secondary'}
                        size="sm"
                        icon={adoptCsbMode ? <X className="h-4 w-4" /> : <MousePointerSquareDashed className="h-4 w-4" />}
                        onClick={handleCsbModeToggle}
                        disabled={isBoundaryDrawing}
                      >
                        {adoptCsbMode ? 'Cancel USDA' : 'Adopt USDA boundary'}
                      </Button>
                    </span>
                  )}
                  <button
                    type="button"
                    onClick={() => setShowOtherFieldBoundaries((show) => !show)}
                    title={showOtherFieldBoundaries ? 'Hide other fields on this map' : 'Show other fields on this map'}
                    aria-label={showOtherFieldBoundaries ? 'Hide other fields on this map' : 'Show other fields on this map'}
                    className="rounded-lg p-2 text-secondary transition-colors hover:bg-gray-100 hover:text-nav-dark"
                  >
                    {showOtherFieldBoundaries ? <Eye className="h-4 w-4" /> : <EyeOff className="h-4 w-4" />}
                  </button>
                </div>
              }
            />
            <p className="text-xs text-secondary mb-3">
              {drawnPolygons.length > 0
                ? 'Use Redraw boundary or Add another section below the map. Remove a section from its confirmed list.'
                : 'Use the polygon tool (top-left of map) to draw this field\'s boundary.'}
            </p>
            <CRXMap
              center={mapCenter}
              zoom={mapZoom}
              bounds={initialBounds}
              showLocateMe
              showLayerToggle
              onMapMoveEnd={handleMapMoveEnd}
              onMapClick={handleMapClick}
              className={`h-[400px] w-full ${addObstacleMode || adoptCsbMode ? 'cursor-crosshair' : ''}`}
            >
              {showOtherFieldBoundaries && (
                <FieldBoundaryLayer fields={nearbyOverlayFields} showLabels />
              )}
              {pendingCsbFeature && (
                <Source id="csb-preview" type="geojson" data={pendingCsbFeature}>
                  <Layer
                    id="csb-preview-fill"
                    type="fill"
                    paint={{ 'fill-color': '#f59e0b', 'fill-opacity': 0.22 }}
                  />
                  <Layer
                    id="csb-preview-outline"
                    type="line"
                    layout={{ 'line-cap': 'round', 'line-join': 'round' }}
                    paint={{ 'line-color': '#b45309', 'line-width': 3, 'line-dasharray': [2, 1.5] }}
                  />
                </Source>
              )}
              <AddressSearch onSelect={handleAddressSelect} />
              <DrawLayer
                initialPolygons={drawnPolygons}
                onPolygonsChange={handlePolygonsChange}
                allowRemoveSinglePart={canRemoveSingleBoundary(loadedHadBoundaryRef.current)}
                disabled={addObstacleMode || adoptCsbMode}
                onDrawingStateChange={setIsBoundaryDrawing}
              />
              <FieldObstacleLayer obstacles={obstaclesForMap} interactive={!addObstacleMode && !adoptCsbMode && !isBoundaryDrawing} />
            </CRXMap>
            {adoptCsbMode && (
              <div className="mt-3 rounded-lg border border-amber-200 bg-amber-50 p-3">
                <p className="text-sm text-amber-800">Click a field to preview its USDA boundary &mdash; USDA CSB 2016&ndash;2023 (beta)</p>
                {csbLookupLoading && <p className="mt-2 text-xs text-amber-700">Looking up USDA boundary&hellip;</p>}
                {pendingCsbFeature && !csbLookupLoading && (
                  <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
                    <p className="text-sm font-medium text-amber-900">
                      ~{pendingCsbFeature.properties.acres.toFixed(1)} ac &middot; {pendingCsbFeature.properties.crop || 'Unknown crop'}
                    </p>
                    <div className="flex gap-2">
                      <Button type="button" variant="ghost" size="sm" onClick={finishCsbAdopt}>Cancel</Button>
                      <Button type="button" size="sm" onClick={handleAddCsbBoundary} disabled={saving}>Add boundary</Button>
                    </div>
                  </div>
                )}
              </div>
            )}
            {addObstacleMode && (
              <div className="mt-3 rounded-lg border border-amber-200 bg-amber-50 p-3">
                {!pendingObstaclePoint ? (
                  <p className="text-sm text-amber-800">Click the map where the obstacle is located.</p>
                ) : (
                  <div className="space-y-3">
                    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                      <div>
                        <label htmlFor="field-obstacle-kind" className="mb-1 block text-xs font-medium text-secondary">
                          Obstacle type
                        </label>
                        <select
                          id="field-obstacle-kind"
                          value={obstacleKind}
                          onChange={(event) => setObstacleKind(event.target.value as FieldObstacleKind)}
                          className="w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm focus:border-crx-green focus:outline-none focus:ring-2 focus:ring-crx-green/20"
                        >
                          {FIELD_OBSTACLE_KINDS.map((kind) => (
                            <option key={kind} value={kind}>{FIELD_OBSTACLE_KIND_LABELS[kind]}</option>
                          ))}
                        </select>
                      </div>
                      <div>
                        <label htmlFor="field-obstacle-label" className="mb-1 block text-xs font-medium text-secondary">
                          Obstacle label (optional)
                        </label>
                        <input
                          id="field-obstacle-label"
                          type="text"
                          value={obstacleLabel}
                          onChange={(event) => setObstacleLabel(event.target.value)}
                          placeholder="e.g. North windmill"
                          className="w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm focus:border-crx-green focus:outline-none focus:ring-2 focus:ring-crx-green/20"
                        />
                      </div>
                    </div>
                    <div className="flex justify-end gap-2">
                      <Button type="button" variant="ghost" size="sm" onClick={resetObstacleDraft}>Choose another point</Button>
                      <Button type="button" size="sm" onClick={() => void handleAddObstacle()} loading={savingObstacle}>Save obstacle</Button>
                    </div>
                  </div>
                )}
              </div>
            )}
            {/* Polygon list panel */}
            {drawnPolygons.length > 1 && (
              <div className="mt-3 space-y-2">
                <p className="text-xs font-medium text-secondary">Field sections</p>
                {drawnPolygons.map((poly, idx) => (
                  <div key={poly.drawId} className="flex items-center gap-3 p-2 border border-gray-100 rounded-lg">
                    <div className="w-3 h-3 rounded-full bg-crx-green flex-shrink-0" />
                    <span className="flex-1 text-sm text-nav-dark truncate">
                      Part {idx + 1} of {drawnPolygons.length} &mdash; {poly.acres.toFixed(2)} ac
                    </span>
                    <button
                      type="button"
                      onClick={() => setPartPendingDelete(poly)}
                      title={`Delete part ${idx + 1}`}
                      aria-label={`Delete part ${idx + 1}`}
                      className="p-1 text-gray-400 hover:text-red-500"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                ))}
                <div className="flex justify-between text-xs px-2 pt-1 font-medium text-crx-green">
                  <span>Total</span>
                  <span>{drawnPolygons.reduce((s, p) => s + p.acres, 0).toFixed(2)} acres</span>
                </div>
              </div>
            )}
            <div className="mt-4 border-t border-gray-100 pt-4">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <h3 className="text-sm font-semibold text-nav-dark">Obstacles</h3>
                  <p className="text-xs text-secondary">Pins shown to the field crew and on printed close-up maps.</p>
                </div>
                {canManageObstacles && !isNew && (
                  <Button
                    type="button"
                    variant={addObstacleMode ? 'ghost' : 'secondary'}
                    size="sm"
                    icon={addObstacleMode ? <X className="h-4 w-4" /> : <Plus className="h-4 w-4" />}
                    onClick={handleObstacleModeToggle}
                  >
                    {addObstacleMode ? 'Cancel obstacle' : 'Add obstacle'}
                  </Button>
                )}
              </div>
              {isNew ? (
                <p className="mt-3 text-xs text-secondary">Save this field before adding obstacle pins.</p>
              ) : obstacles.length === 0 ? (
                <p className="mt-3 text-xs text-secondary">No obstacles marked for this field.</p>
              ) : (
                <ul className="mt-3 space-y-2">
                  {obstacles.map((obstacle) => {
                    const kindLabel = FIELD_OBSTACLE_KIND_LABELS[obstacle.kind];
                    const displayLabel = obstacle.label?.trim() || kindLabel;
                    return (
                      <li key={obstacle.id} className="flex items-center gap-2 rounded-lg border border-amber-100 bg-amber-50/60 px-3 py-2">
                        <span className="h-2.5 w-2.5 shrink-0 rounded-full bg-red-600 ring-2 ring-red-100" />
                        <span className="min-w-0 flex-1 truncate text-sm text-nav-dark">
                          {displayLabel}{displayLabel !== kindLabel ? <> &mdash; <span className="text-secondary">{kindLabel}</span></> : null}
                        </span>
                        {canManageObstacles && (
                          <button
                            type="button"
                            onClick={() => setObstaclePendingDelete(obstacle)}
                            title={`Delete ${displayLabel}`}
                            aria-label={`Delete obstacle ${displayLabel}`}
                            className="rounded p-1 text-gray-400 hover:bg-white hover:text-red-600"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </button>
                        )}
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          </Card>
        </div>
      </div>

      <UnsavedChangesModal
        open={blocker.state === 'blocked'}
        onStay={() => blocker.reset?.()}
        onLeave={() => blocker.proceed?.()}
      />

      <ConfirmModal
        open={partPendingDelete !== null}
        onClose={() => setPartPendingDelete(null)}
        onConfirm={() => {
          if (!partPendingDelete) return;
          handlePolygonsChange(drawnPolygons.filter((polygon) => polygon.drawId !== partPendingDelete.drawId));
          setPartPendingDelete(null);
        }}
        title="Delete field section?"
        message="This removes only this section from the field boundary. Save the field to apply the updated boundary."
        confirmLabel="Delete section"
        variant="danger"
      />

      <ConfirmModal
        open={pendingLegalLookup !== null}
        onClose={() => setPendingLegalLookup(null)}
        onConfirm={() => {
          if (pendingLegalLookup) applyLegalLookup(pendingLegalLookup);
          setPendingLegalLookup(null);
        }}
        title="Replace legal description?"
        message="Legal lookup found a new Section, Township, and Range. Replace the legal description you entered?"
        confirmLabel="Replace description"
        variant="warning"
      />

      <ConfirmModal
        open={obstaclePendingDelete !== null}
        onClose={() => setObstaclePendingDelete(null)}
        onConfirm={() => void handleDeleteObstacle()}
        title="Delete obstacle?"
        message="This removes the obstacle pin from field maps and future printed close-up pages."
        confirmLabel="Delete obstacle"
        variant="danger"
        loading={deletingObstacle}
      />
    </div>
  );
}
