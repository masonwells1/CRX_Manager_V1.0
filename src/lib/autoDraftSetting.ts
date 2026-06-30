/**
 * Beyond-parity §4 — Auto-Invoice-on-job-completion setting helpers (pure, tested).
 *
 * ⚠️ MONEY-SAFETY: this only flips an automatic DRAFT on/off. The DRAFT is created by
 * the already-reviewed transfer_job_to_invoice() RPC and is NEVER auto-posted — posting
 * is always a human click. The shipped/empty value is OFF ('false'), so the office sees
 * no behavior change until an admin deliberately turns it on.
 *
 * The setting is stored in app_settings under the key
 * 'auto_draft_invoice_on_job_completion' as the literal string 'true' | 'false'
 * (matching how the DB function reads it: `setting_value = 'true'`). Anything else
 * (blank, missing, malformed) is treated as OFF — we never invent ON.
 */

export const AUTO_DRAFT_SETTING_KEY = 'auto_draft_invoice_on_job_completion';

/** The shipped, safe default: OFF. */
export const DEFAULT_AUTO_DRAFT_ENABLED = false;

/**
 * Parse the app_settings value into a boolean. ONLY the exact string 'true' means ON;
 * everything else (including null/undefined/blank/malformed) is OFF. This mirrors the
 * DB read `setting_value = 'true'` so the UI and the server can never disagree.
 */
export function parseAutoDraftEnabled(raw: string | null | undefined): boolean {
  return raw === 'true';
}

/** Serialize the boolean to the literal string stored in app_settings. */
export function serializeAutoDraftEnabled(enabled: boolean): string {
  return enabled ? 'true' : 'false';
}
