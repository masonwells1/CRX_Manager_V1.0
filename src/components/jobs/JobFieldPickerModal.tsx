import { useCallback, useEffect, useMemo, useState } from 'react';
import { Search } from 'lucide-react';
import Button from '../ui/Button';
import Modal from '../ui/Modal';
import SearchableSelect from '../ui/SearchableSelect';
import { useToast } from '../ui/Toast';
import { supabase, assertRpcResult } from '../../lib/db';
import { Sentry } from '../../lib/sentry';
import CRXMap from '../map/CRXMap';
import FieldBoundaryLayer from '../map/FieldBoundaryLayer';
import FieldMarkerLayer from '../map/FieldMarkerLayer';
import { computeBounds } from '../../hooks/useFitBounds';
import {
  JOB_FIELD_PICKER_MAP_LIMIT,
  filterJobPickerFields,
  mapFieldsForJobPicker,
  selectedJobPickerAcres,
  selectedJobPickerFields,
  pickerBillableAcres,
  toJobFieldPickerSelection,
  toggleJobPickerSelection,
  type JobFieldPickerField,
  type JobFieldPickerFilters,
  type JobFieldPickerSelection,
} from './jobFieldPicker';

interface JobFieldPickerModalProps {
  open: boolean;
  onClose: () => void;
  onAdd: (selections: JobFieldPickerSelection[]) => void;
  alreadyOnJobIds: ReadonlySet<string>;
  /** The job editor already has the authoritative two-acre values in memory. */
  billableAcresById: ReadonlyMap<string, number | null>;
}

const FIELD_GEOJSON_CACHE_TTL_MS = 5 * 60 * 1000;
let fieldGeojsonCache: { data: JobFieldPickerField[]; fetchedAt: number } | null = null;

function useDebouncedValue(value: string, delayMs: number): string {
  const [debounced, setDebounced] = useState(value);

  useEffect(() => {
    const timeout = window.setTimeout(() => setDebounced(value), delayMs);
    return () => window.clearTimeout(timeout);
  }, [delayMs, value]);

  return debounced;
}

function withKnownBillableAcres(
  field: JobFieldPickerField,
  billableAcresById: ReadonlyMap<string, number | null>,
): JobFieldPickerField {
  const knownBillableAcres = billableAcresById.get(field.id);
  return knownBillableAcres === undefined
    ? field
    : { ...field, billable_acres: knownBillableAcres };
}

export default function JobFieldPickerModal({
  open,
  onClose,
  onAdd,
  alreadyOnJobIds,
  billableAcresById,
}: JobFieldPickerModalProps) {
  const { toast } = useToast();
  const [fields, setFields] = useState<JobFieldPickerField[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [customerId, setCustomerId] = useState('');
  const [crop, setCrop] = useState('');
  const [fieldName, setFieldName] = useState('');
  const [county, setCounty] = useState('');
  const debouncedFieldName = useDebouncedValue(fieldName, 250);
  const debouncedCounty = useDebouncedValue(county, 250);

  const loadFields = useCallback(async () => {
    setLoading(true);
    setLoadError(false);
    try {
      const now = Date.now();
      let rows: JobFieldPickerField[];
      if (fieldGeojsonCache && now - fieldGeojsonCache.fetchedAt < FIELD_GEOJSON_CACHE_TTL_MS) {
        rows = fieldGeojsonCache.data;
      } else {
        const { data, error } = await supabase.rpc('get_fields_with_geojson');
        if (error) throw error;
        rows = assertRpcResult<JobFieldPickerField[]>(data, 'get_fields_with_geojson');
        // Fields rarely change mid-session; closing/reopening after five minutes refreshes this full GeoJSON list.
        fieldGeojsonCache = { data: rows, fetchedAt: now };
      }
      setFields(rows.map((field) => withKnownBillableAcres(field, billableAcresById)));
    } catch (error) {
      Sentry.captureException(error, { tags: { component: 'JobFieldPickerModal', action: 'load_fields' } });
      setFields([]);
      setLoadError(true);
      toast('error', 'Could not load fields for map selection. Please try again.');
    } finally {
      setLoading(false);
    }
  }, [billableAcresById, toast]);

  useEffect(() => {
    if (!open) return;
    setSelectedIds(new Set());
    setHoveredId(null);
    setCustomerId('');
    setCrop('');
    setFieldName('');
    setCounty('');
    void loadFields();
  }, [loadFields, open]);

  const customerOptions = useMemo(() => {
    const byId = new Map<string, string>();
    for (const field of fields) {
      if (!byId.has(field.customer_id)) byId.set(field.customer_id, field.customer_name || 'Unknown customer');
    }
    return Array.from(byId, ([value, label]) => ({ value, label }))
      .sort((left, right) => left.label.localeCompare(right.label));
  }, [fields]);

  // Mirrors Fields.tsx: crop choices come from current field data, not a stale hard-coded list.
  const cropOptions = useMemo(
    () => Array.from(new Set(fields.map((field) => field.crop_type).filter((value): value is string => Boolean(value))))
      .sort((left, right) => left.localeCompare(right)),
    [fields],
  );

  const filters = useMemo<JobFieldPickerFilters>(() => ({
    customerId,
    crop,
    fieldName: debouncedFieldName,
    county: debouncedCounty,
  }), [crop, customerId, debouncedCounty, debouncedFieldName]);

  const filteredFields = useMemo(() => filterJobPickerFields(fields, filters), [fields, filters]);
  const mapFields = useMemo(() => mapFieldsForJobPicker(filteredFields), [filteredFields]);
  const mapBounds = useMemo(
    () => computeBounds(mapFields.flatMap((field) => [field.boundary_geojson, field.centroid_geojson])),
    [mapFields],
  );
  const selectedFields = useMemo(() => selectedJobPickerFields(fields, selectedIds), [fields, selectedIds]);
  const selectedAcres = useMemo(() => selectedJobPickerAcres(fields, selectedIds), [fields, selectedIds]);
  const mapIsCapped = filteredFields.length > JOB_FIELD_PICKER_MAP_LIMIT;

  const toggleField = useCallback((fieldId: string) => {
    if (alreadyOnJobIds.has(fieldId)) {
      const fieldName = fields.find((field) => field.id === fieldId)?.field_name ?? 'This field';
      toast('info', `${fieldName} is already on this job`);
      return;
    }
    setSelectedIds((previous) => toggleJobPickerSelection(previous, fieldId, alreadyOnJobIds));
  }, [alreadyOnJobIds, fields, toast]);

  const clearFilters = () => {
    setCustomerId('');
    setCrop('');
    setFieldName('');
    setCounty('');
  };

  const handleAdd = () => onAdd(selectedFields.map(toJobFieldPickerSelection));

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Select Locations"
      accent="on map"
      size="fullscreen"
      footer={(
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-sm text-secondary">
            <span className="font-semibold text-nav-dark">{selectedIds.size}</span> field{selectedIds.size === 1 ? '' : 's'} selected
            {' · '}
            <span className="font-semibold text-nav-dark">{selectedAcres.toLocaleString(undefined, { maximumFractionDigits: 2 })}</span> total acres
          </p>
          <div className="flex items-center justify-end gap-2">
            <Button variant="secondary" onClick={onClose}>Cancel</Button>
            <Button onClick={handleAdd} disabled={selectedIds.size === 0}>
              Add {selectedIds.size > 0 ? selectedIds.size : ''} Location{selectedIds.size === 1 ? '' : 's'}
            </Button>
          </div>
        </div>
      )}
    >
      <div className="flex h-full min-h-0 flex-col gap-4">
        <div className="grid grid-cols-1 gap-3 rounded-lg border border-gray-200 bg-gray-50 p-3 md:grid-cols-2 xl:grid-cols-[minmax(13rem,1.2fr)_minmax(10rem,0.8fr)_minmax(11rem,1fr)_minmax(10rem,0.75fr)_auto]">
          <SearchableSelect
            label="Customer"
            options={customerOptions}
            value={customerId}
            onChange={setCustomerId}
            placeholder="All customers"
          />
          <label className="block text-sm font-medium text-nav-dark">
            Crop
            <select
              value={crop}
              onChange={(event) => setCrop(event.target.value)}
              className="mt-1 w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm focus:border-crx-green focus:outline-none focus:ring-2 focus:ring-crx-green/20"
            >
              <option value="">All crops</option>
              {cropOptions.map((option) => <option key={option} value={option}>{option}</option>)}
            </select>
          </label>
          <label className="block text-sm font-medium text-nav-dark">
            Field name
            <span className="relative mt-1 block">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
              <input
                value={fieldName}
                onChange={(event) => setFieldName(event.target.value)}
                placeholder="Search fields..."
                className="w-full rounded-lg border border-gray-200 bg-white py-2 pl-9 pr-3 text-sm focus:border-crx-green focus:outline-none focus:ring-2 focus:ring-crx-green/20"
              />
            </span>
          </label>
          <label className="block text-sm font-medium text-nav-dark">
            County
            <input
              value={county}
              onChange={(event) => setCounty(event.target.value)}
              placeholder="Any county"
              className="mt-1 w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm focus:border-crx-green focus:outline-none focus:ring-2 focus:ring-crx-green/20"
            />
          </label>
          <div className="flex items-end">
            <Button variant="secondary" onClick={clearFilters} className="w-full">Clear</Button>
          </div>
        </div>

        <div className="flex items-center justify-between gap-3 text-sm text-secondary">
          <p><span className="font-semibold text-nav-dark">{filteredFields.length}</span> fields match</p>
          {mapIsCapped && <p className="text-amber-700">Map shows the first {JOB_FIELD_PICKER_MAP_LIMIT}; narrow your search to map every match.</p>}
        </div>

        <div className="min-h-0 flex-1 overflow-hidden rounded-lg border border-gray-200 lg:flex">
          <section className="min-h-[18rem] border-b border-gray-200 lg:min-h-0 lg:w-3/5 lg:border-b-0 lg:border-r" aria-label="Field map">
            <CRXMap className="h-full min-h-[18rem] w-full" baseLayer="satellite" showLayerToggle showLocateMe bounds={mapBounds}>
              <FieldBoundaryLayer
                fields={mapFields}
                selectedIds={selectedIds}
                hoveredId={hoveredId}
                onFieldClick={toggleField}
                onFieldHover={setHoveredId}
                showLabels
              />
              <FieldMarkerLayer
                fields={mapFields}
                selectedIds={selectedIds}
                hoveredId={hoveredId}
                onFieldClick={toggleField}
                onFieldHover={setHoveredId}
                selectOnClick
                showLabels
              />
            </CRXMap>
          </section>

          <section className="min-h-0 flex-1 overflow-auto lg:w-2/5" aria-label="Matching fields">
            {loading ? (
              <div className="flex h-full min-h-48 items-center justify-center gap-2 text-sm text-secondary">
                <span className="h-5 w-5 animate-spin rounded-full border-2 border-crx-green border-t-transparent" />
                Loading fields...
              </div>
            ) : loadError ? (
              <div className="flex h-full min-h-48 flex-col items-center justify-center gap-3 px-4 text-center">
                <p className="text-sm text-secondary">Fields could not be loaded. The table remains empty until the read succeeds.</p>
                <Button variant="secondary" onClick={() => void loadFields()}>Try again</Button>
              </div>
            ) : (
              <table className="w-full min-w-[38rem] text-sm">
                <thead className="sticky top-0 z-10 bg-gray-50 text-left text-xs font-medium text-secondary">
                  <tr>
                    <th className="w-10 px-3 py-2">Select</th>
                    <th className="px-3 py-2">Field</th>
                    <th className="px-3 py-2">Customer(s)</th>
                    <th className="px-3 py-2">Crop</th>
                    <th className="px-3 py-2 text-right">Billable acres</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {filteredFields.map((field) => {
                    const onJob = alreadyOnJobIds.has(field.id);
                    const selected = onJob || selectedIds.has(field.id);
                    const fieldAcres = pickerBillableAcres(field);
                    return (
                      <tr
                        key={field.id}
                        onClick={() => toggleField(field.id)}
                        onMouseEnter={() => setHoveredId(field.id)}
                        onMouseLeave={() => setHoveredId((current) => current === field.id ? null : current)}
                        className={`cursor-pointer transition-colors ${selected ? 'bg-crx-green/10' : ''} ${hoveredId === field.id ? 'ring-1 ring-inset ring-crx-green/50' : 'hover:bg-gray-50'} ${onJob ? 'cursor-not-allowed opacity-75' : ''}`}
                      >
                        <td className="px-3 py-2" onClick={(event) => event.stopPropagation()}>
                          <input
                            type="checkbox"
                            aria-label={`Select ${field.field_name}`}
                            checked={selected}
                            disabled={onJob}
                            onChange={() => toggleField(field.id)}
                            className="rounded border-gray-300 text-crx-green focus:ring-crx-green"
                          />
                        </td>
                        <td className="px-3 py-2 font-medium text-nav-dark">
                          <div className="flex items-center gap-1.5">
                            <span>{field.field_name}</span>
                            {onJob && <span className="rounded-full bg-gray-200 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-secondary">On job</span>}
                          </div>
                        </td>
                        <td className="max-w-40 truncate px-3 py-2 text-secondary" title={field.customer_name ?? undefined}>{field.customer_name || 'Unknown customer'}</td>
                        <td className="px-3 py-2 text-secondary">{field.crop_type || <>&mdash;</>}</td>
                        <td className="px-3 py-2 text-right tabular-nums text-secondary">
                          {fieldAcres == null ? <>&mdash;</> : fieldAcres.toLocaleString(undefined, { maximumFractionDigits: 2 })}
                        </td>
                      </tr>
                    );
                  })}
                  {filteredFields.length === 0 && <tr><td colSpan={5} className="px-3 py-10 text-center text-secondary">No fields match these filters.</td></tr>}
                </tbody>
              </table>
            )}
          </section>
        </div>
      </div>
    </Modal>
  );
}
