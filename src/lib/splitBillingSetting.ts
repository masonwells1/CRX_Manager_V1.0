/**
 * Per-line split billing — feature-flag helpers (pure, tested).
 *
 * ⚠️ FLAG-GATED / BEHAVIOR-NEUTRAL: this flag gates the entire per-line split-billing
 * UI (the per-line split editor and split-aware save path). The shipped/empty value is OFF ('false'),
 * so the office sees ZERO behavior change until an admin deliberately turns it on — and
 * turning it on is gated on Mason's baseline billing cycle + the live migration apply
 * (spec §6.1). Never invent ON.
 *
 * Stored in app_settings under the key 'feature_per_line_split_billing' as the literal
 * string 'true' | 'false' (matching how server reads would compare `setting_value = 'true'`).
 * Anything else (blank, missing, malformed) is treated as OFF. Mirrors the shape of
 * autoDraftSetting.ts.
 */

export const SPLIT_BILLING_SETTING_KEY = 'feature_per_line_split_billing';

/** The shipped, safe default: OFF. */
export const DEFAULT_SPLIT_BILLING_ENABLED = false;

/**
 * Parse the app_settings value into a boolean. ONLY the exact string 'true' means ON;
 * everything else (including null/undefined/blank/malformed) is OFF, so the UI and any
 * server-side read can never disagree.
 */
export function parseSplitBillingEnabled(raw: string | null | undefined): boolean {
  return raw === 'true';
}

/** Serialize the boolean to the literal string stored in app_settings. */
export function serializeSplitBillingEnabled(enabled: boolean): string {
  return enabled ? 'true' : 'false';
}
