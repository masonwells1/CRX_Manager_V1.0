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

/**
 * Billable/entered acres are "divergent" from the measured map acres when they
 * differ by this percentage or more — in EITHER direction (over or under). It is a
 * review flag, never a hard block: a field can legitimately bill on a different
 * number than the map, but a gap this large is worth a human look — a fat-fingered
 * entry, a stale boundary, or (the owner's case) an applicator who sprayed part of
 * one field under the wrong field's name.
 */
export const ACRE_DIVERGENCE_THRESHOLD_PCT = 10;

/**
 * Absolute percentage gap between a billable/entered acreage and the measured map
 * acreage, relative to measured. Returns null when there is nothing to compare
 * (no entered value, no measured value, or measured is 0). Always non-negative —
 * the caller decides how to phrase an over- vs under-statement.
 */
export function acreDivergencePct(
  entered: number | null | undefined,
  measured: number | null | undefined,
): number | null {
  if (entered == null || measured == null || measured === 0) return null;
  return (Math.abs(entered - measured) / measured) * 100;
}

/**
 * True when the entered acreage diverges from the measured map acreage by at least
 * the review threshold, in either direction. False when there is nothing to compare.
 */
export function isAcreDivergent(
  entered: number | null | undefined,
  measured: number | null | undefined,
): boolean {
  const pct = acreDivergencePct(entered, measured);
  return pct != null && pct >= ACRE_DIVERGENCE_THRESHOLD_PCT;
}
