import type { Feature, Polygon, MultiPolygon } from 'geojson';

/**
 * Build the geometry to hand to the `set_field_boundary` RPC. That RPC's input
 * contract is a GeoJSON GEOMETRY (Polygon or MultiPolygon) — NOT a Feature or a
 * FeatureCollection (`ST_GeomFromGeoJSON` only accepts a bare geometry). Drawn
 * fields combine into one MultiPolygon (multi-part preservation); a single drawn
 * boundary passes its Polygon geometry. Returns null when there is no geometry.
 */
export function buildBoundaryGeometry(
  polygons: Feature<Polygon>[],
  singleBoundary: Feature<Polygon> | null,
): Polygon | MultiPolygon | null {
  if (polygons.length > 0) {
    return {
      type: 'MultiPolygon',
      coordinates: polygons.map((p) => p.geometry.coordinates),
    };
  }
  if (singleBoundary) return singleBoundary.geometry;
  return null;
}

/**
 * Billable acres precedence — the exact COALESCE the server bills on:
 * override → measured → legacy total. Returns null only when all three are absent.
 * (A 0 override is a distinct value here; the UI/server reject 0 before it is stored.)
 */
export function billableAcres(
  override: number | null | undefined,
  measured: number | null | undefined,
  total: number | null | undefined,
): number | null {
  return override ?? measured ?? total ?? null;
}
