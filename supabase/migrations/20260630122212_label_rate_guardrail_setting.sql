-- 20260630122212_label_rate_guardrail_setting.sql
-- Beyond-parity §5 (SAFETY) — Label-Rate Guardrails policy setting.
--
-- ⚠️ POLICY-SAFETY (owner-gated — read before touching):
--   * WARN BY DEFAULT — this seeds the app_settings policy 'label_rate_guardrail_mode'
--     with 'warn'. In 'warn' mode an over-label rate is FLAGGED in the chemical-entry UI
--     but the tank mix STILL SAVES — the guardrail NEVER prevents a save. Mason has NOT
--     authorized a hard block; 'block' is an OPT-IN an admin enables later, and even in
--     'block' mode an admin override with a LOGGED reason (activity_feed) lets the save
--     proceed — never a hard wall with no escape.
--   * NO SCHEMA / FUNCTION CHANGE — this is a single idempotent settings seed. Nothing
--     server-side enforces a block; the guardrail is a client-side WARNING built on the
--     §1 label columns (products.max_label_rate / max_label_rate_unit / rei_hours /
--     phi_days) which already exist. The save RPCs are unchanged.
--   * IDEMPOTENT — ON CONFLICT DO NOTHING so a re-run or an admin-edited value is never
--     clobbered back to 'warn'.
--   * Admin-only to change (app_settings RLS: settings_update WITH CHECK is_admin()).

INSERT INTO app_settings (setting_key, setting_value, description)
VALUES (
  'label_rate_guardrail_mode',
  'warn',
  'Beyond-parity §5. Controls the tank-mix label-rate guardrail. ''warn'' (default): an '
  || 'over-label per-acre rate is flagged in the chemical-entry UI but the mix still '
  || 'saves — never blocks. ''block'': an over-label rate requires an admin override with '
  || 'a logged reason before saving (still never a hard wall). REI/PHI windows and a '
  || 'PHI-vs-harvest warning are shown in both modes. Admin-only (app_settings RLS).'
)
ON CONFLICT (setting_key) DO NOTHING;
