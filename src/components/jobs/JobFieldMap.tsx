// Field-app parity #16: per-job "Map" — plots THIS job's selected field locations
// (boundaries + centroid pins) on the shared CRXMap.
//
// Codex #16 P2: geometry is fetched server-side-scoped via get_job_fields_with_geojson,
// which returns ONLY the fields selected on THIS job and gates on the same visibility
// predicate as jobs_select. We do NOT pull the whole customer's fields to the browser.
// Fields with no geometry render a clear 'no boundary on file' state — never a broken map.
import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { MapPin, AlertCircle } from 'lucide-react';
import Card from '../ui/Card';
import CRXMap from '../map/CRXMap';
import FieldBoundaryLayer from '../map/FieldBoundaryLayer';
import FieldMarkerLayer from '../map/FieldMarkerLayer';
import { useFitBounds } from '../../hooks/useFitBounds';
import { supabase, assertRpcResult } from '../../lib/db';
import { Sentry } from '../../lib/sentry';
import type { Field } from '../../types';

// Exactly the columns get_job_fields_with_geojson returns.
interface JobMapFieldRow {
  id: string;
  customer_id: string;
  field_name: string;
  total_acres: number | null;
  measured_acres: number | null;
  override_acres: number | null;
  centroid_geojson: string | null;
  boundary_geojson: string | null;
  sort_order: number | null;
}

/** Map a scoped RPC row into the Field shape the map layers consume. */
function toField(r: JobMapFieldRow): Field {
  return {
    id: r.id,
    customer_id: r.customer_id,
    field_name: r.field_name,
    legal_description: null,
    county: null,
    state: null,
    total_acres: r.total_acres,
    // Two-acre model: keep these so FieldBoundaryLayer's billable-acre label is correct
    // (override ?? measured ?? total) instead of falling back to stale legacy total_acres.
    measured_acres: r.measured_acres,
    override_acres: r.override_acres,
    fsa_farm_number: null,
    fsa_tract_number: null,
    fsa_field_number: null,
    crop_type: null,
    soil_type: null,
    irrigation: false,
    notes: null,
    is_active: true,
    centroid_geojson: r.centroid_geojson,
    boundary_geojson: r.boundary_geojson,
    created_at: '',
    updated_at: '',
  };
}

interface JobFieldMapProps {
  /** The job whose selected fields are plotted. */
  jobId: string;
}

export default function JobFieldMap({ jobId }: JobFieldMapProps) {
  const navigate = useNavigate();
  const [jobFields, setJobFields] = useState<Field[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      if (!jobId) {
        setJobFields([]);
        setLoading(false);
        return;
      }
      setLoading(true);
      try {
        // Server-side scoped: returns ONLY this job's selected fields, gated by job
        // visibility (admin / sales_rep / the assigned applicator). No over-fetch.
        const { data, error } = await supabase.rpc('get_job_fields_with_geojson', {
          p_job_id: jobId,
        });
        if (error) throw error;
        const rows = assertRpcResult<JobMapFieldRow[]>(data, 'get_job_fields_with_geojson');
        if (!cancelled) setJobFields(rows.map(toField));
      } catch (err) {
        Sentry.captureException(err instanceof Error ? err : new Error(String(err)), {
          tags: { source: 'fetch', action: 'job_field_map' },
        });
        if (!cancelled) setJobFields([]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => {
      cancelled = true;
    };
  }, [jobId]);

  const fieldsWithGeometry = useMemo(
    () => jobFields.filter((f) => f.boundary_geojson || f.centroid_geojson),
    [jobFields]
  );
  const fieldsWithoutGeometry = useMemo(
    () => jobFields.filter((f) => !f.boundary_geojson && !f.centroid_geojson),
    [jobFields]
  );

  const geoStrings = useMemo(
    () => fieldsWithGeometry.flatMap((f) => [f.boundary_geojson, f.centroid_geojson]),
    [fieldsWithGeometry]
  );
  const bounds = useFitBounds(geoStrings);

  if (loading) {
    return (
      <Card>
        <p className="text-sm text-gray-500 py-10 text-center">Loading map…</p>
      </Card>
    );
  }

  if (jobFields.length === 0) {
    return (
      <Card>
        <div className="text-center py-12 text-gray-500">
          <MapPin className="w-10 h-10 mx-auto mb-2 text-gray-300" />
          <p className="text-sm">No field locations are selected on this job.</p>
          <p className="text-xs mt-1">Add fields on the Locations tab to see them on the map.</p>
        </div>
      </Card>
    );
  }

  return (
    <Card>
      <h2 className="text-lg font-semibold text-nav-dark flex items-center gap-2 mb-3">
        <MapPin className="w-5 h-5 text-crx-green" />
        Field Map ({jobFields.length} location{jobFields.length === 1 ? '' : 's'})
      </h2>

      {fieldsWithGeometry.length > 0 ? (
        <CRXMap
          className="h-[480px] w-full rounded-lg overflow-hidden"
          showLayerToggle
          showLocateMe
          bounds={bounds}
        >
          <FieldBoundaryLayer
            fields={fieldsWithGeometry}
            onFieldClick={(fieldId) => navigate(`/fields/${fieldId}/dashboard`)}
          />
          {/* Codex P3: pass onFieldClick so the marker popup's "View Dashboard" action
              actually navigates (it renders a dead button without a handler). */}
          <FieldMarkerLayer
            fields={fieldsWithGeometry}
            showAll
            onFieldClick={(fieldId) => navigate(`/fields/${fieldId}/dashboard`)}
          />
        </CRXMap>
      ) : (
        <div className="flex items-center gap-2 rounded-lg border border-amber-200 bg-amber-50 px-4 py-4 text-amber-800">
          <AlertCircle className="w-5 h-5 shrink-0" />
          <p className="text-sm">
            None of this job's fields have a mapped boundary or location on file. Import or draw a
            boundary for these fields to see them on the map.
          </p>
        </div>
      )}

      {fieldsWithoutGeometry.length > 0 && (
        <div className="mt-4">
          <p className="text-xs font-medium text-gray-500 mb-1">
            No boundary on file for {fieldsWithoutGeometry.length} field
            {fieldsWithoutGeometry.length === 1 ? '' : 's'}:
          </p>
          <ul className="flex flex-wrap gap-1.5">
            {fieldsWithoutGeometry.map((f) => (
              <li
                key={f.id}
                className="inline-flex items-center gap-1 rounded-full bg-gray-100 px-2.5 py-0.5 text-xs text-gray-600"
              >
                <MapPin className="w-3 h-3 text-gray-400" />
                {f.field_name}
              </li>
            ))}
          </ul>
        </div>
      )}
    </Card>
  );
}
