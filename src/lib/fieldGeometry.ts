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
 * The acreage band the server enforces on a MEASURED boundary (set_field_boundary's
 * 0.1–5000 `AREA_OUT_OF_BAND` check). The billable-override RPC only rejects `<= 0` /
 * `> 5000` — it has no 0.1 floor — so the UI applies this same band to a typed or
 * imported override BEFORE sending it, keeping a tiny (0 < x < 0.1) value from billing
 * below the safety floor and giving a clear message instead of a raw RPC error.
 */
export const ACRE_BAND_MIN = 0.1;
export const ACRE_BAND_MAX = 5000;

/** True when an acreage is within the [0.1, 5000] safety band (null/undefined → false). */
export function isAcreInBand(acres: number | null | undefined): boolean {
  return acres != null && acres >= ACRE_BAND_MIN && acres <= ACRE_BAND_MAX;
}

/**
 * Parse an acreage from an imported attribute (string from GeoJSON/KML, or a number
 * from a shapefile DBF) into a number safe to bill on. Strips thousands separators
 * (`"1,234.5"` → 1234.5 — `parseFloat` alone STOPS at the comma and returns 1, silently
 * mis-billing) and whitespace, then accepts the result ONLY if the ENTIRE cleaned string
 * is a finite number. Returns null for blank, non-numeric, or partially-numeric input
 * (e.g. `"40 ac"`), so junk never becomes a billable override — the field falls back to
 * the measured map acres instead.
 */
export function parseAcreInput(raw: string | number | null | undefined): number | null {
  if (raw == null) return null;
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
  const s = raw.trim();
  if (s === '') return null;
  let cleaned: string;
  if (s.includes(',')) {
    // Accept commas ONLY as well-formed US thousands grouping (1,234 · 1,234.5 · 12,345,678).
    // Anything else — "12,34", "1,2,3", a decimal comma "1234,5" — is ambiguous and would mis-bill
    // if we blindly stripped the comma, so reject it (→ field falls back to the measured acres).
    if (!/^[+-]?\d{1,3}(,\d{3})+(\.\d+)?$/.test(s)) return null;
    cleaned = s.replace(/,/g, '');
  } else {
    cleaned = s;
  }
  if (!/^[+-]?(\d+(\.\d+)?|\.\d+)$/.test(cleaned)) return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

/**
 * True when an import attribute NAME denotes ACRES, so its value is safe to drive the
 * billable override. EXCLUDES ambiguous geometry-area columns — `area`, `shape_area`,
 * `st_area` — which GIS exports record in the projection's square meters/feet, NOT acres
 * (a 1-acre field's `shape_area` ≈ 4047 would otherwise become a 4047-"acre" bill). The
 * test is name-based on purpose: a raw area value silently mapped as "Acres" must never
 * set money. Accepts acres / total_acres / gis_acres / calc_acres / acreage / `ac`.
 */
export function isAcreDenominatedColumn(name: string | null | undefined): boolean {
  if (!name) return false;
  const n = name.toLowerCase().trim();
  if (n.includes('acre')) return true;
  // `ac` as a standalone token — bare `ac`, or suffixed/prefixed like `TOTAL_AC` / `GIS AC` /
  // `FIELD-AC` (the 10-char DBF abbreviation ag shapefiles use) — but NOT `ac` buried inside
  // another word (tract, area, capacity, place).
  return /(^|[^a-z])ac($|[^a-z])/.test(n);
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

/**
 * Whether an entered acreage (e.g. an applicator's as-applied acres) diverges from the
 * reference acreage (the field's billable acres on file) by at least the review threshold,
 * and if so by how much and in which direction. Returns null when within threshold or when
 * there is nothing to compare (no entered value, or no reference acreage on file). `pct` is
 * the non-negative magnitude; `direction` is 'over' when entered exceeds the reference,
 * 'under' when it falls short. Powers the applicator-mix-up review flag on the billing page.
 */
export type AcreDivergence = { pct: number; direction: 'over' | 'under' };

export function acreDivergence(
  entered: number | null | undefined,
  reference: number | null | undefined,
): AcreDivergence | null {
  const pct = acreDivergencePct(entered, reference);
  if (pct == null || pct < ACRE_DIVERGENCE_THRESHOLD_PCT) return null;
  // acreDivergencePct already guaranteed both are non-null and reference !== 0.
  return { pct, direction: (entered as number) > (reference as number) ? 'over' : 'under' };
}
