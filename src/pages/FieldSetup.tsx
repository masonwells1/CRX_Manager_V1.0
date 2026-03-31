import { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { ArrowLeft, Save, Trash2, MapPin, Search, ChevronDown, ChevronUp, AlertTriangle } from 'lucide-react';
import Card, { CardHeader } from '../components/ui/Card';
import Button from '../components/ui/Button';
import Input from '../components/ui/Input';
import Badge from '../components/ui/Badge';
import UnsavedChangesModal from '../components/ui/UnsavedChangesModal';
import CRXMap from '../components/map/CRXMap';
import DrawLayer, { type DrawnPolygon } from '../components/map/DrawLayer';
import AddressSearch from '../components/map/AddressSearch';
import { useToast } from '../components/ui/Toast';
import { useAuth } from '../contexts/AuthContext';
import { useUnsavedChanges } from '../hooks/useUnsavedChanges';
import { supabase, assertRpcResult } from '../lib/db';
import { useIdempotencyKey } from '../hooks/useIdempotencyKey';
import { Sentry } from '../lib/sentry';
import { computeBounds } from '../hooks/useFitBounds';
import { parseDollarsToCents } from '../lib/parseCents';
import turfCentroid from '@turf/centroid';
import type { Feature, Polygon } from 'geojson';
import type { Field, Customer } from '../types';

interface BillingSplit {
  customer_id: string;
  customer_name: string;
  split_pct: number;
  is_primary: boolean;
  notes: string;
  price_override_cents: number | null;
  pricing_note: string;
}

export default function FieldSetup() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { toast } = useToast();
  const { profile } = useAuth();
  const saveFieldIdem = useIdempotencyKey('save_field', profile?.id || '');
  const saveFieldGeoIdem = useIdempotencyKey('save_field_geometry', profile?.id || '');
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
  const [boundaryGeoJSON, setBoundaryGeoJSON] = useState<Feature<Polygon> | null>(null);
  const [drawnPolygons, setDrawnPolygons] = useState<DrawnPolygon[]>([]);
  const [mapCenter, setMapCenter] = useState<[number, number] | undefined>(undefined);
  const [mapZoom, setMapZoom] = useState<number | undefined>(undefined);

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

  // Duplicate detection
  const [duplicateWarning, setDuplicateWarning] = useState('');

  // Track dirty state
  const [isDirty, setIsDirty] = useState(false);
  const initialLoadDone = useRef(false);
  const blocker = useUnsavedChanges(isDirty);

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
      setField(data);
      const cust = data.customer as { farm_name: string } | null;
      setOwnerName(cust?.farm_name || '');

      // Fetch GeoJSON for map display
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
            const parsed = JSON.parse(geo.boundary_geojson);
            setBoundaryGeoJSON({ type: 'Feature', properties: {}, geometry: parsed });
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

      // Load multi-polygon data if available
      const { data: polyData, error: polyError } = await supabase.rpc('get_field_polygons', { p_field_id: id });
      if (!polyError && polyData) {
        const polyRows = assertRpcResult<Array<{ id: string; polygon_geojson: object; label: string | null; acres: number | null; sort_order: number }>>(polyData, 'get_field_polygons');
        if (polyRows.length > 0) {
          const loaded: DrawnPolygon[] = polyRows.map((p, i) => ({
            drawId: p.id,
            polygon: { type: 'Feature' as const, properties: {}, geometry: p.polygon_geojson as GeoJSON.Polygon },
            acres: p.acres ?? 0,
            label: p.label || `Polygon ${i + 1}`,
          }));
          setDrawnPolygons(loaded);
        }
      }

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
          defaults.map((d: { customer_id: string; customer?: { farm_name: string }; split_pct: number; is_primary: boolean; notes?: string; price_override_cents?: number | null; pricing_note?: string }) => ({
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

  const update = (key: string, value: unknown) => setField((f) => ({ ...f, [key]: value }));

  const splitTotal = billingSplits.reduce((sum, s) => sum + s.split_pct, 0);

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

    setSaving(true);
    try {
      const fieldPayload = {
        customer_id: field.customer_id,
        field_name: field.field_name,
        legal_description: field.legal_description || null,
        county: field.county || null,
        state: field.state || 'IL',
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
        p_field_id: isNew ? null : id,
        p_field_payload: fieldPayload,
        p_billing_defaults: billingPayload,
        p_performed_by: profile!.id,
        p_idempotency_key: idemKey,
      });

      if (error) {
        toast('error', error.message);
      } else {
        saveFieldIdem.resetKey();
        assertRpcResult(data, 'save_field');
        const savedFieldId = isNew ? data : id;

        // Save polygons (multi-polygon mode) or single boundary (legacy mode)
        if (drawnPolygons.length > 0 && savedFieldId) {
          const polygonPayload = drawnPolygons.map((p, i) => ({
            polygon_geojson: p.polygon.geometry,
            label: p.label,
            acres: p.acres,
            sort_order: i,
          }));
          const geoIdemKey = saveFieldGeoIdem.getKey();
          const { error: geoError } = await supabase.rpc('save_field_polygons', {
            p_field_id: savedFieldId,
            p_polygons: polygonPayload,
            p_performed_by: profile!.id,
            p_idempotency_key: geoIdemKey,
          });
          if (geoError) {
            Sentry.captureException(geoError, { tags: { source: 'critical_action', action: 'save_field_polygons' } });
            toast('error', 'Field saved but polygons could not be saved.');
          } else {
            saveFieldGeoIdem.resetKey();
          }
        } else if (boundaryGeoJSON && savedFieldId) {
          // Legacy single-polygon fallback
          const centroidResult = turfCentroid(boundaryGeoJSON);
          const centroidGeoJSON = JSON.stringify(centroidResult.geometry);
          const boundaryGeoJSONStr = JSON.stringify(boundaryGeoJSON.geometry);

          const geoIdemKey = saveFieldGeoIdem.getKey();
          const { error: geoError } = await supabase.rpc('save_field_geometry', {
            p_field_id: savedFieldId,
            p_centroid_geojson: centroidGeoJSON,
            p_boundary_geojson: boundaryGeoJSONStr,
            p_idempotency_key: geoIdemKey,
          });
          if (geoError) {
            Sentry.captureException(geoError, { tags: { source: 'critical_action', action: 'save_field_geometry' } });
            toast('error', 'Field saved but boundary could not be saved. Please try re-drawing.');
          } else {
            saveFieldGeoIdem.resetKey();
          }
        }

        setIsDirty(false);
        if (isNew) {
          toast('success', 'Field created');
          navigate(`/fields/${data}`, { replace: true });
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

  // Handle boundary changes from DrawLayer
  const handleBoundaryChange = useCallback((boundary: Feature<Polygon>, acres: number, center: [number, number]) => {
    setBoundaryGeoJSON(boundary);
    if (!field.total_acres) {
      update('total_acres', acres);
    }
    setMapCenter(center);
  }, [field.total_acres]);

  const handleBoundaryDelete = useCallback(() => {
    setBoundaryGeoJSON(null);
  }, []);

  // Address search handler — fly map to selected location
  const handleAddressSelect = useCallback((lng: number, lat: number) => {
    setMapCenter([lng, lat]);
    setMapZoom(16);
  }, []);

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
        <button onClick={() => navigate('/fields')} className="p-2 rounded-lg hover:bg-white hover:shadow-sm transition-all text-secondary">
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
              <Input
                label="Total Acres"
                type="number"
                value={field.total_acres ?? ''}
                onChange={(e) => update('total_acres', e.target.value ? parseFloat(e.target.value) : null)}
              />
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
            <CardHeader title="Field" accent="Location" />
            <p className="text-xs text-secondary mb-3">
              {boundaryGeoJSON
                ? 'Click the polygon to edit, or use the trash icon to remove it.'
                : 'Use the polygon tool (top-left of map) to draw this field\'s boundary.'}
            </p>
            <CRXMap
              center={mapCenter}
              zoom={mapZoom}
              bounds={initialBounds}
              showLocateMe
              showLayerToggle
              className="h-[400px] w-full"
            >
              <AddressSearch onSelect={handleAddressSelect} />
              <DrawLayer
                initialPolygons={drawnPolygons.length > 0 ? drawnPolygons : undefined}
                onPolygonsChange={(polys) => {
                  setDrawnPolygons(polys);
                  const totalAcres = polys.reduce((sum, p) => sum + p.acres, 0);
                  update('total_acres', Math.round(totalAcres * 100) / 100);
                  if (polys.length > 0) {
                    const center = turfCentroid(polys[0].polygon);
                    setMapCenter([center.geometry.coordinates[0], center.geometry.coordinates[1]]);
                  }
                }}
                initialGeoJSON={drawnPolygons.length === 0 ? boundaryGeoJSON : undefined}
                onBoundaryChange={drawnPolygons.length === 0 ? handleBoundaryChange : undefined}
                onBoundaryDelete={drawnPolygons.length === 0 ? handleBoundaryDelete : undefined}
              />
            </CRXMap>
            {/* Polygon list panel */}
            {drawnPolygons.length > 0 && (
              <div className="mt-3 space-y-2">
                <p className="text-xs font-medium text-secondary">Drawn Polygons</p>
                {drawnPolygons.map((poly, idx) => (
                  <div key={poly.drawId} className="flex items-center gap-3 p-2 border border-gray-100 rounded-lg">
                    <div className="w-3 h-3 rounded-full bg-crx-green flex-shrink-0" />
                    <input
                      type="text"
                      value={poly.label}
                      onChange={(e) => {
                        const updated = [...drawnPolygons];
                        updated[idx] = { ...updated[idx], label: e.target.value };
                        setDrawnPolygons(updated);
                      }}
                      className="flex-1 text-sm px-2 py-1 border border-gray-200 rounded focus:outline-none focus:ring-1 focus:ring-crx-green/30"
                      placeholder={`Polygon ${idx + 1}`}
                    />
                    <span className="text-xs text-secondary whitespace-nowrap">{poly.acres.toFixed(2)} ac</span>
                    <button
                      onClick={() => setDrawnPolygons((prev) => prev.filter((_, i) => i !== idx))}
                      className="text-gray-400 hover:text-red-500 p-1"
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
            {drawnPolygons.length === 0 && boundaryGeoJSON && (
              <p className="text-xs text-secondary mt-2">
                Boundary drawn — acreage auto-calculated from polygon area.
              </p>
            )}
          </Card>
        </div>
      </div>

      <UnsavedChangesModal
        open={blocker.state === 'blocked'}
        onStay={() => blocker.reset?.()}
        onLeave={() => blocker.proceed?.()}
      />
    </div>
  );
}
