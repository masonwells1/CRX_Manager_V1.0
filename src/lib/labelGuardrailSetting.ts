/**
 * Beyond-parity §5 — Label-rate guardrail MODE setting helpers (pure, tested).
 *
 * ⚠️ SAFETY: the shipped/empty value is 'warn'. In 'warn' mode an over-label rate is
 * FLAGGED but the tank mix still saves — the guardrail NEVER prevents a save. 'block' is
 * an OPT-IN the owner enables later, and even in 'block' mode an admin override with a
 * LOGGED reason must let the save proceed. Anything other than the exact strings 'warn'
 * or 'block' (blank, missing, malformed) is treated as the safe default 'warn' — we never
 * invent 'block'.
 *
 * Stored in app_settings under 'label_rate_guardrail_mode' as the literal string
 * 'warn' | 'block'. The default row is seeded by the §5 migration; this helper mirrors the
 * read so UI and any future server check can never disagree.
 */

export const LABEL_RATE_GUARDRAIL_MODE_KEY = 'label_rate_guardrail_mode';

export type GuardrailMode = 'warn' | 'block';

/** The shipped, safe default: WARN (never blocks a save). */
export const DEFAULT_GUARDRAIL_MODE: GuardrailMode = 'warn';

/**
 * Parse the app_settings value into a guardrail mode. ONLY the exact string 'block' means
 * block; everything else (including null/undefined/blank/malformed/'warn') is 'warn'. We
 * never default to 'block'.
 */
export function parseGuardrailMode(raw: string | null | undefined): GuardrailMode {
  return raw === 'block' ? 'block' : 'warn';
}

/** Serialize the mode to the literal string stored in app_settings. */
export function serializeGuardrailMode(mode: GuardrailMode): string {
  return mode === 'block' ? 'block' : 'warn';
}
