-- 20260625160000_applicator_sheet_print_audit.sql
-- Field-app parity #9 (Applicator Field Sheet — Original / Custom / Enhanced).
--
-- The applicator field sheet is the paper the crew carries to the field. ChemMan
-- records WHO printed a job and WHEN (the job list "Printed" column). #1 already
-- added jobs.printed_at; this adds the missing companion jobs.last_printed_by so
-- the list can show "Last Printed By <name>" per the acceptance criterion.
--
-- The Custom applicator-sheet layout (company name/address/logo/footer + optional
-- column toggles) is a LAYOUT-ONLY config. It is stored in the EXISTING
-- app_settings key/value table (admin-only INSERT/UPDATE RLS — settings_insert /
-- settings_update gate on is_admin()), exactly like the #32 fuel_surcharge config.
-- NO new table is required, so there is no new RLS surface to police. The seeded
-- config is INERT/empty — when nothing is set, the Custom format falls back to the
-- standard CRX header without erroring (acceptance criterion).
--
-- ALL changes here are ADDITIVE and money-neutral. No existing column, table, RLS
-- policy, or RPC is removed or weakened. There is no money/billing content on this
-- sheet (it is a layout-only print config). Em-dashes below are real U+2014.

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. jobs.last_printed_by — the profile who generated the most recent printout.
--    Companion to the existing jobs.printed_at (added in #1). Nullable FK; set
--    by the app when an applicator sheet / WPS notice is generated, alongside the
--    existing printed_at stamp. SET NULL on profile delete so the audit column
--    never blocks a user deletion (matches jobs.consultant_id / updated_by).
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE jobs
  ADD COLUMN IF NOT EXISTS last_printed_by uuid REFERENCES profiles(id) ON DELETE SET NULL;

COMMENT ON COLUMN jobs.last_printed_by IS
  'Field-app parity #9: profile who generated the most recent printout (applicator '
  'field sheet / WPS notice). Companion to jobs.printed_at. Display-only audit '
  'column; resolve the name via profile_public_view.';

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. Seed the INERT Custom applicator-sheet layout config in app_settings.
--    LAYOUT ONLY — never any pricing/billing content. Empty by default so the
--    Custom format falls back to the standard CRX header until an admin sets it.
--    ON CONFLICT DO NOTHING so a re-run / an admin-edited value is never clobbered.
--    Admin-only writes are already enforced by the app_settings RLS policies.
--    JSON shape (all optional):
--      company_name, company_address, footer_text : strings (blank => CRX default)
--      logo_data_url : a data: URL for the header logo (blank => no logo)
--      columns : { crop, pest, rei, phi, total_applied, gl_lb } booleans —
--                which OPTIONAL columns appear on the Custom sheet.
-- ─────────────────────────────────────────────────────────────────────────────
INSERT INTO app_settings (setting_key, setting_value, description)
VALUES (
  'applicator_sheet_custom',
  '{"company_name": "", "company_address": "", "footer_text": "", "logo_data_url": "", "columns": {"crop": true, "pest": true, "rei": true, "phi": true, "total_applied": true, "gl_lb": true}}',
  'Field-app parity #9 Custom applicator field-sheet layout (LAYOUT ONLY — never '
  'pricing/billing). JSON: {company_name, company_address, footer_text, '
  'logo_data_url (data: URL), columns:{crop,pest,rei,phi,total_applied,gl_lb}}. '
  'Blank/absent => the standard CRX header + all optional columns shown. Admin-only '
  'via the existing app_settings RLS.'
)
ON CONFLICT (setting_key) DO NOTHING;
