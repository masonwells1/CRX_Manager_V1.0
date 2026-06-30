// ChemMan Gap-Closeout #2 — diluent / carrier-water per acre helpers.
//
// Diluent is a QUANTITY (gallons per acre), NOT money. The invoice persists the
// RATE only (invoices.diluent_rate_gpa); the TOTAL is derived (rate x applied
// acres) for on-screen display and the printed PDF, because invoices.total_acres
// is NOT reliably written by save_field_app_invoice (verified 2026-06-30) so a
// generated total column would read NULL even when a rate is set.
//
// Pure functions only — no React/DB imports — so they are trivially unit-testable
// and shared by the editor page and the PDF builder.

/**
 * Parse a free-text diluent-rate input into a numeric gallons/acre value.
 * - blank / whitespace-only      -> null (the field is optional)
 * - non-numeric / NaN            -> null (treated as "not entered")
 * - negative                     -> null is NOT returned here; negativity is a UI
 *                                   validation concern. This parser returns the
 *                                   numeric value as-is (incl. negative) so the
 *                                   caller can decide to reject it. Use
 *                                   `isValidDiluentRate` for the accept/reject gate.
 */
export function parseDiluentRate(raw: string | null | undefined): number | null {
  if (raw == null) return null;
  const trimmed = String(raw).trim();
  if (trimmed === '') return null;
  const n = Number(trimmed);
  if (!Number.isFinite(n)) return null;
  return n;
}

/**
 * A diluent rate is valid for SAVE when it is null (cleared / not entered) or a
 * finite non-negative number. Negative rates are rejected in the UI (no DB CHECK
 * is added to the money table). Mirrors the RPC-layer guard.
 *
 * NOTE: this checks the PARSED value, so it treats a non-numeric input (which
 * `parseDiluentRate` maps to null) as "blank/valid". To reject a non-empty-but-
 * unparseable typo (e.g. "-", "e", "1.2.3") so it can't clear a saved rate, use
 * `isDiluentInputValid` on the raw input string instead.
 */
export function isValidDiluentRate(rate: number | null | undefined): boolean {
  if (rate == null) return true;
  return Number.isFinite(rate) && rate >= 0;
}

/**
 * Validate the RAW input string the user typed (the authoritative save gate).
 * - blank / whitespace-only  -> VALID (the field is optional; clears the rate)
 * - parses to a finite >= 0  -> VALID
 * - anything else            -> INVALID: a non-empty value that is non-numeric
 *   ("-", "e", "1.2.3", "abc") or negative. Without this, a number <input> that
 *   reports a non-empty-but-browser-invalid value would parse to null, read as
 *   "blank", and SILENTLY CLEAR a previously-saved rate on save (Codex P2). Here
 *   it is rejected so the user fixes the typo instead.
 */
export function isDiluentInputValid(raw: string | null | undefined): boolean {
  if (raw == null) return true;
  const trimmed = String(raw).trim();
  if (trimmed === '') return true; // blank is allowed (optional field)
  const n = Number(trimmed);
  return Number.isFinite(n) && n >= 0;
}

/**
 * Compute the total diluent gallons = rate (gal/acre) x applied acres.
 * Returns null when the rate is null/NaN/negative OR acres is null/NaN/negative —
 * an absent or invalid input must yield "no total" (never 0, never a spurious
 * product), so the printout omits the line gracefully and never shows a phantom 0.
 * A rate of exactly 0 with valid acres yields 0 (a legitimately recorded zero).
 */
export function computeTotalDiluentGallons(
  rate: number | null | undefined,
  acres: number | null | undefined,
): number | null {
  if (rate == null || !Number.isFinite(rate) || rate < 0) return null;
  if (acres == null || !Number.isFinite(acres) || acres < 0) return null;
  return rate * acres;
}

/**
 * Format a gallons value for display/PDF with up to `decimals` places, trimming
 * trailing zeros (so 75 prints "75" and 12.5 prints "12.5"). Returns '' for null.
 */
export function formatGallons(value: number | null | undefined, decimals = 2): string {
  if (value == null || !Number.isFinite(value)) return '';
  // Round to `decimals`, then drop trailing zeros / a trailing dot.
  const rounded = Number(value.toFixed(decimals));
  return String(rounded);
}
