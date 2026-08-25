/**
 * Canonical unit helpers (WaveB Units Phase 1).
 *
 * Single source of truth for turning the live `unit_conversions` rows into the
 * options a rate/inventory-unit dropdown should show, so every entry point offers
 * the SAME vocabulary and free-text unit typos (the oz-vs-gal / "32"-in-the-unit-box
 * money-bug class) can't be introduced. The `unit_conversions` rows themselves are
 * FROZEN KEYS — never rename them (save_quote joins LOWER(rate_unit)=LOWER(unit);
 * renaming silently rescales money). This module only READS them.
 *
 * The server (field_app_priced_quantity / normalize_rate_unit) stays authoritative
 * for saved money; these are UI-option helpers only.
 */
import type { UnitConversion } from '../types';

/**
 * Options for a rate/inventory-unit dropdown, filtered by the product's form.
 * A null/undefined form → all units (can't filter yet). 'both'-type units
 * (Ea, Unit) are always included.
 */
export function unitOptionsForForm(
  conversions: UnitConversion[],
  form: string | null | undefined,
): UnitConversion[] {
  if (!form) return conversions;
  return conversions.filter((uc) => uc.unit_type === form || uc.unit_type === 'both');
}

/**
 * Is `unit` present in the form-filtered option list? Used to GRANDFATHER an existing
 * value the current filter would otherwise hide — so re-saving a record can never
 * silently blank a unit the dropdown doesn't happen to offer. A blank/undefined unit
 * is treated as "known" (nothing to grandfather).
 */
export function isKnownUnit(
  conversions: UnitConversion[],
  form: string | null | undefined,
  unit: string | null | undefined,
): boolean {
  if (!unit) return true;
  return unitOptionsForForm(conversions, form).some((uc) => uc.unit === unit);
}

/** Where the caller's `unit_conversions` request currently stands. */
export type UnitLoadState = 'pending' | 'loaded' | 'failed';

/**
 * Why a save must be blocked because the unit list could not offer a unit, or null
 * to allow it. The unit fields are pickers, not free text: when the list is
 * unavailable the operator has no way to enter a unit at all, so a blank unit is the
 * request's doing and not a choice they made. A blank unit on a healthy list still
 * saves — that stayed legal when the fields were free text and it still is.
 *
 * An empty array is NOT the failure signal: it also means "still in flight" and
 * "the table really is empty". Naming the wrong one tells the operator to refresh
 * for a request that was about to succeed, so the caller passes its actual state.
 */
export function blockedUnitSaveMessage(
  state: UnitLoadState,
  conversions: UnitConversion[],
  hasBlankUnit: boolean,
): string | null {
  if (!hasBlankUnit) return null;
  if (state === 'pending') return 'Units are still loading. Try saving again in a moment.';
  if (state === 'failed') {
    return 'Units could not be loaded, so a unit is still blank. Refresh and retry before saving.';
  }
  if (conversions.length === 0) {
    return 'No units are set up yet, so a unit is still blank. Add unit conversions before saving.';
  }
  return null;
}
