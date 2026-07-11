import { supabase, assertRpcResult } from './db';

/** Full map rows returned by the shared all-fields GeoJSON RPC. */
export interface FieldsGeojsonRow {
  id: string;
  customer_id: string;
  customer_name: string | null;
  field_name: string;
  county: string | null;
  crop_type: string | null;
  total_acres: number | null;
  is_active: boolean;
  centroid_geojson: string | null;
  boundary_geojson: string | null;
}

export const FIELDS_GEOJSON_CACHE_TTL_MS = 5 * 60 * 1000;

let fieldsGeojsonCache: { data: FieldsGeojsonRow[]; fetchedAt: number } | null = null;

/**
 * Field boundaries change rarely during a session. Share one short-lived cache so map consumers
 * do not each load the full GeoJSON set independently.
 */
export async function getCachedFieldsGeojson(now = Date.now()): Promise<FieldsGeojsonRow[]> {
  if (fieldsGeojsonCache && now - fieldsGeojsonCache.fetchedAt < FIELDS_GEOJSON_CACHE_TTL_MS) {
    return fieldsGeojsonCache.data;
  }

  const { data, error } = await supabase.rpc('get_fields_with_geojson');
  if (error) throw error;
  const rows = assertRpcResult<FieldsGeojsonRow[]>(data, 'get_fields_with_geojson');
  fieldsGeojsonCache = { data: rows, fetchedAt: now };
  return rows;
}

/** Test-only reset for the module-level cache. */
export function resetFieldsGeojsonCacheForTests(): void {
  fieldsGeojsonCache = null;
}
