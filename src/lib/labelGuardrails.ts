/**
 * labelGuardrails — Beyond-parity §5 Label-Rate Guardrails (pure, framework-free, tested).
 *
 * At tank-mix build/edit time we compare each chemical line's per-acre rate to the
 * product's MAX LABEL RATE (§1: products.max_label_rate / max_label_rate_unit), surface
 * the REI (re-entry interval) and PHI (pre-harvest interval) windows, and warn when a
 * field's harvest date falls inside the PHI window.
 *
 * SAFETY POLICY — DEFAULT IS *WARN*, NEVER BLOCK.
 *   Mason has NOT authorized a hard block. The guardrail mode lives in app_settings
 *   ('label_rate_guardrail_mode', see labelGuardrailSetting.ts) and defaults to 'warn'.
 *   In 'warn' mode an over-label rate is FLAGGED but the mix still saves — the guardrail
 *   never prevents a save. 'block' is opt-in by the owner later, and even then an admin
 *   override with a LOGGED reason must let the save proceed (see needsOverride below).
 *
 * UNIT SAFETY (load-bearing): we only compare numerically when the rate's unit and the
 * max-label unit MATCH after normalization (lowercase, trimmed, empty→null). We never
 * compare oz/acre vs pt/acre as if the numbers were the same scale. When units differ or
 * either is missing, the result is 'cannot_compare' — NO over-rate flag (graceful, no
 * false positive). When the product has no max on file at all, the result is
 * 'no_label_max' — a soft informational note, never a block, never an error.
 *
 * This module is React-free so every branch is unit-tested in isolation
 * (labelGuardrails.test.ts).
 */

// ── Unit normalization (shared with the SQL-side intent: LOWER(NULLIF(btrim(unit),''))) ──

/**
 * Normalize a rate/max unit for comparison: trim, lowercase, strip a trailing per-acre
 * suffix ('/acre', '/ac', '/a', ' per acre'), and collapse the common synonyms so
 * 'oz/acre' and 'OZ' compare equal but 'oz' and 'pt' never do. Empty/blank → null.
 *
 * We deliberately ONLY canonicalize the bare measure token (oz/pt/qt/gal/lb/ton/...);
 * an unknown token is kept as-is (lowercased) so two identical unknown strings still
 * match, but a mismatch is never coerced into a match.
 */
export function normalizeRateUnit(unit: string | null | undefined): string | null {
  const raw = (unit ?? '').trim().toLowerCase();
  if (raw === '') return null;
  // Drop ONLY a recognized per-acre denominator ('oz/acre' -> 'oz', 'pt/ac' -> 'pt',
  // 'gal per acre' -> 'gal'). A DIFFERENT denominator (e.g. 'L/ha', 'fl oz/100 gal') is
  // deliberately KEPT WHOLE so it never collapses to the same token as a per-acre rate —
  // it then won't match a per-acre max and compareToMaxRate returns 'cannot_compare'
  // instead of a false over/within flag. (Codex r3 P2.)
  let base = raw;
  const acreDenom = /\s*\/\s*(?:ac|acre|acres|a)\s*$/; // '/ac', '/acre', '/acres', '/a'
  if (acreDenom.test(base)) {
    base = base.replace(acreDenom, '').trim();
  } else if (/\s+per\s+acre$/.test(base)) {
    base = base.replace(/\s+per\s+acre$/, '').trim();
  } else if (base.includes('/')) {
    // A non-acre denominator present → keep the full string so it can't match a bare unit.
    return base;
  }
  if (base === '') return null;
  // Canonicalize common synonyms so equivalent spellings compare equal.
  const SYNONYMS: Record<string, string> = {
    oz: 'oz', ounce: 'oz', ounces: 'oz', 'fl oz': 'oz', floz: 'oz', 'fluid ounce': 'oz',
    pt: 'pt', pint: 'pt', pints: 'pt',
    qt: 'qt', quart: 'qt', quarts: 'qt',
    gal: 'gal', gallon: 'gal', gallons: 'gal', gl: 'gal',
    lb: 'lb', lbs: 'lb', pound: 'lb', pounds: 'lb',
    ton: 'ton', tons: 'ton',
    g: 'g', gram: 'g', grams: 'g',
    kg: 'kg', kilogram: 'kg', kilograms: 'kg',
    l: 'l', liter: 'l', liters: 'l', litre: 'l', litres: 'l',
    ml: 'ml',
  };
  // Own-property lookup ONLY. A plain object literal inherits 'constructor', '__proto__',
  // 'toString', 'valueOf', etc; SYNONYMS['constructor'] returns the Object CONSTRUCTOR, which is
  // non-nullish so '??' does not fire and this function silently breaks its string return
  // contract. A product rate_unit is free text (the CSV import writes it unvalidated), so those
  // names are reachable. hasOwnProperty.call keeps the contract for every input.
  return Object.prototype.hasOwnProperty.call(SYNONYMS, base) ? SYNONYMS[base] : base;
}

// ── Rate-vs-max comparison ───────────────────────────────────────────────────

export type RateComparisonStatus =
  /** rate is at or below the label max (units matched) — OK. */
  | 'within'
  /** rate exceeds the label max (units matched) — over-label, FLAG. */
  | 'over'
  /** the product has no max_label_rate on file — soft note, never a block. */
  | 'no_label_max'
  /** rate present but units differ / a unit is missing — can't compare, NO flag. */
  | 'cannot_compare'
  /** no rate entered yet on this line — nothing to compare. */
  | 'no_rate';

export interface RateComparison {
  status: RateComparisonStatus;
  /** The rate we compared (per-acre), echoed for display. */
  rate: number | null;
  /** The product's max label rate, echoed for display. */
  maxRate: number | null;
  /** The normalized unit both sides shared when status is within/over; else null. */
  comparedUnit: string | null;
}

/**
 * Compare a line's per-acre rate to a product's max label rate. Pure.
 *
 * Order of checks (each is a distinct, separately-tested branch):
 *  1. no rate entered            → 'no_rate'      (nothing to flag)
 *  2. no max on file (null/≤0)   → 'no_label_max' (soft note; NEVER a block/error)
 *  3. units missing or different → 'cannot_compare' (graceful — no false over-rate)
 *  4. rate > max (same unit)     → 'over'         (FLAG — over label)
 *  5. otherwise                  → 'within'       (OK)
 *
 * NaN/Infinity/negative inputs are treated defensively: a non-finite rate → 'no_rate',
 * a non-finite or non-positive max → 'no_label_max'. We never throw.
 */
export function compareToMaxRate(
  rate: number | null | undefined,
  rateUnit: string | null | undefined,
  maxRate: number | null | undefined,
  maxUnit: string | null | undefined,
): RateComparison {
  const r = typeof rate === 'number' && Number.isFinite(rate) ? rate : null;
  const m = typeof maxRate === 'number' && Number.isFinite(maxRate) ? maxRate : null;

  if (r == null || r <= 0) {
    return { status: 'no_rate', rate: r, maxRate: m, comparedUnit: null };
  }
  if (m == null || m <= 0) {
    // No usable max on file → informational only. Graceful degrade: never block, never error.
    return { status: 'no_label_max', rate: r, maxRate: null, comparedUnit: null };
  }

  const ru = normalizeRateUnit(rateUnit);
  const mu = normalizeRateUnit(maxUnit);
  // UNIT SAFETY: only a numeric comparison when both units are present AND equal.
  if (ru == null || mu == null || ru !== mu) {
    return { status: 'cannot_compare', rate: r, maxRate: m, comparedUnit: null };
  }

  return {
    status: r > m ? 'over' : 'within',
    rate: r,
    maxRate: m,
    comparedUnit: ru,
  };
}

// ── PHI-vs-harvest-date window ────────────────────────────────────────────────

export type PhiHarvestStatus =
  /** harvest date is inside the PHI window (application + phi_days > harvest) — WARN. */
  | 'inside_window'
  /** harvest date is clear of the PHI window — OK. */
  | 'clear'
  /** can't evaluate (no PHI on file, or no harvest date) — no warning. */
  | 'unknown';

export interface PhiHarvestResult {
  status: PhiHarvestStatus;
  phiDays: number | null;
  /** YYYY-MM-DD the field could first be harvested = applicationDate + phi_days. */
  earliestHarvest: string | null;
  /** The field's planned harvest date (echoed). */
  harvestDate: string | null;
}

/** Parse a YYYY-MM-DD (or ISO) date string to a UTC-midnight Date, or null. */
function parseDateOnly(s: string | null | undefined): Date | null {
  if (!s || typeof s !== 'string') return null;
  const m = s.trim().match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return null;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Format a UTC Date back to YYYY-MM-DD. */
function toDateOnly(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * Determine whether a field's planned harvest falls inside the product's PHI window.
 *
 * earliestHarvest = applicationDate + phi_days. If the field's harvestDate is BEFORE
 * earliestHarvest, the crop would be harvested too soon after application → 'inside_window'
 * (WARN). On/after earliestHarvest → 'clear'. Missing PHI or harvest date → 'unknown'
 * (no warning — graceful). Pure + tested.
 *
 * @param phiDays          product.phi_days (NULL = not on file)
 * @param harvestDate      field_crop_history.harvest_date (the planned harvest)
 * @param applicationDate  the job's scheduled/applied date (defaults to today if blank)
 */
export function phiHarvestWarning(
  phiDays: number | null | undefined,
  harvestDate: string | null | undefined,
  applicationDate: string | null | undefined,
): PhiHarvestResult {
  const phi = typeof phiDays === 'number' && Number.isFinite(phiDays) && phiDays > 0 ? Math.floor(phiDays) : null;
  const harvest = parseDateOnly(harvestDate);
  if (phi == null || harvest == null) {
    return { status: 'unknown', phiDays: phi, earliestHarvest: null, harvestDate: harvest ? toDateOnly(harvest) : null };
  }
  const appDate = parseDateOnly(applicationDate) ?? parseDateOnly(toDateOnly(new Date()));
  if (appDate == null) {
    return { status: 'unknown', phiDays: phi, earliestHarvest: null, harvestDate: toDateOnly(harvest) };
  }
  const earliest = new Date(appDate.getTime());
  earliest.setUTCDate(earliest.getUTCDate() + phi);
  return {
    status: harvest.getTime() < earliest.getTime() ? 'inside_window' : 'clear',
    phiDays: phi,
    earliestHarvest: toDateOnly(earliest),
    harvestDate: toDateOnly(harvest),
  };
}

// ── Display helpers (REI / PHI windows) ──────────────────────────────────────

/** "12 hr" / "—" for a re-entry interval. */
export function formatRei(reiHours: number | null | undefined): string {
  return typeof reiHours === 'number' && Number.isFinite(reiHours) && reiHours > 0 ? `${reiHours} hr` : '—';
}

/** "7 d" / "—" for a pre-harvest interval. */
export function formatPhi(phiDays: number | null | undefined): string {
  return typeof phiDays === 'number' && Number.isFinite(phiDays) && phiDays > 0 ? `${phiDays} d` : '—';
}

// ── Block-mode override gate ─────────────────────────────────────────────────

/**
 * In 'block' mode, does the current set of line comparisons require an admin override
 * to save? TRUE only when at least one line is over-label AND mode is 'block'. In 'warn'
 * mode this is ALWAYS false — the save is never gated. ('cannot_compare' / 'no_label_max'
 * never gate a save in any mode — graceful degrade.)
 */
export function needsOverride(
  mode: 'warn' | 'block',
  comparisons: Pick<RateComparison, 'status'>[],
): boolean {
  if (mode !== 'block') return false;
  return comparisons.some((c) => c.status === 'over');
}
